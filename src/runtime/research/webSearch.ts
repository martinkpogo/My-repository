import type { Env } from "../../types";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { EXTERNAL_EGRESS_TARGET, evaluateAccess, type AccessContext } from "../../access";
import { RESEARCH_PROTOCOL_REGISTRY } from "./protocols";
import { reportLiveStep, resolveLiveStep } from "../liveStatus";
import { takeWebLookup } from "../webLookupAllowance";
import { kvGet, kvPut } from "../../kvStore";
import { hashContent } from "../../contentHash";
import type { ResearchPlanDimension } from "./researchPlan";
import {
  PRIMARY_SEARCH_PROVIDER,
  SEARCH_PROVIDER_ADAPTERS,
  SearchProviderError,
  adapterSupports,
  clearCooldown,
  configuredProviderChain,
  cooldownUntil,
  isRecoverableFailure,
  monthlyBudget,
  readMonthlyUsage,
  recordProviderRequest,
  startCooldown,
  type RawSearchResult,
  type SearchProviderAdapter,
  type SearchProviderCapabilities,
  type SearchProviderId,
} from "./searchProviders";

export type { SearchProviderId } from "./searchProviders";

// ---------------------------------------------------------------------------
// The shared search Tool contract (canonical specification: ENIG HQ / 6.
// Tools > Search, LOG-1068; provider fallback and recovery approved in
// Build Decision Record BD-15, issue #338). This module is the single
// executable registration and handler for the `search` tool id: one
// provider-neutral request/outcome shape that every authorized consumer
// (research executor, Sales Lead Generation, and any later consumer) calls
// through the same Access-gated path. Provider policy comes from trusted
// runtime configuration (./searchProviders.ts) -- never from a caller, Hat,
// or Skill.
// ---------------------------------------------------------------------------

/**
 * Trusted runtime configuration: the primary provider (provider_policy.
 * primary_provider: tavily). Fallback providers are used only when
 * explicitly enabled for the deployment -- see ./searchProviders.ts. Kept
 * under this name because the contract and existing callers know it.
 */
export const ACTIVE_SEARCH_PROVIDER: SearchProviderId = PRIMARY_SEARCH_PROVIDER;

/** Optional input parameters of the search contract (canonical input schema). */
export interface SearchRequest {
  /** Required. Trimmed; must be non-empty after trimming (min_length: 1). */
  query: string;
  /** Provider topic scope -- only values the active adapter supports are accepted. */
  topic?: string;
  /**
   * Publication date range. The active Tavily adapter supports only
   * relative time buckets, not absolute date ranges, so any date_range is
   * rejected explicitly as invalid_input -- never silently dropped, which
   * would misrepresent the filter actually applied.
   */
  date_range?: { start?: string; end?: string };
  /** Desired result count: integer 1..MAX_RESULTS_PER_QUERY_LIMIT. */
  max_results?: number;
  /** Restrict results to these domains -- non-empty array of domain strings. */
  include_domains?: string[];
  /** Exclude these domains -- non-empty array of domain strings. */
  exclude_domains?: string[];
}

/** The normalized result shape (canonical normalized_result). */
export interface SearchResult {
  title: string;
  /** Absolute http(s) URL, preserved exactly as the provider supplied it. */
  url: string;
  snippet: string;
  /** Which provider actually produced this result (provider_attribution_required). */
  provider: string;
  /** When this result was retrieved from the provider, ISO-8601. */
  retrieved_at: string;
  /** Publication date ONLY if the provider itself supplied one -- never inferred. */
  published_at?: string;
}

/**
 * The distinguishable outcomes (canonical outcomes; outcome_distinction_
 * required). A provider failure or unavailable provider must never read as
 * "no evidence exists" -- callers branch on `kind` so an unsearched query
 * cannot masquerade as an empty result. Access denial is deliberately NOT one
 * of these: it is the contract's distinct `denied` outcome, delivered as a
 * thrown AccessDeniedError before any provider request and never caught as a
 * provider failure.
 *
 *   - internal_allowance_exhausted: ENIG's own search allowance (per job or
 *     per day) is used up. Switching providers cannot bypass it.
 *   - interrupted: every eligible provider was rate-limited, temporarily
 *     unavailable or returned a malformed response. Nothing was found or
 *     ruled out; the operation may be resumed through its owning Work, no
 *     sooner than `retry_at` when one is known.
 */
export type SearchOutcome =
  | { kind: "success_with_results"; results: SearchResult[] }
  | { kind: "success_no_results" }
  | { kind: "provider_unavailable"; reason: string }
  | { kind: "provider_failure"; reason: string }
  | { kind: "invalid_input"; reason: string }
  | { kind: "internal_allowance_exhausted"; reason: string }
  | { kind: "interrupted"; reason: string; retry_at?: string };

// Confirmed live: even after capping each snippet's length (see
// MAX_SNIPPET_LENGTH below), a full 8 dimensions x 5 results each (40
// results) still pushed a single synthesis prompt to ~10,000+ requested
// tokens -- past Groq's fixed 8000 TPM cap and slow enough to add to
// several providers' 12s timeouts, since synthesis (unlike research-plan
// generation,
// split per protocol in a separate fix) is still one
// combined call across every selected protocol's evidence at once.
// Lowered from 5 -- still leaves multiple corroborating sources per
// dimension, just fewer of them, cutting total evidence volume (and so
// prompt size) by 40% across a full 8-dimension request.
const MAX_RESULTS_PER_QUERY = 3;

// The runtime-defined upper bound for one search invocation (the
// contract's max_results maximum, matched to Tavily's own API limit) lives
// with the adapters as MAX_RESULTS_PER_QUERY_LIMIT. Requests beyond it are
// invalid_input rather than silently truncated.

// Confirmed live: Tavily's "content" field is unbounded (some results ran
// well over a thousand characters), and with up to MAX_DIMENSIONS_PER_
// REQUEST (8) dimensions x MAX_RESULTS_PER_QUERY results each, the
// untruncated total pushed a single synthesis prompt to ~18,000 tokens --
// past every free-tier provider's context window or rate limit. A snippet
// is corroborating evidence, not the source itself (the title/url/domain
// stay intact for citation and for findUnverifiableSources's verification
// against the literal supplied text), so it's safe to bound.
const MAX_SNIPPET_LENGTH = 400;

function capSnippet(snippet: string): string {
  return snippet.length > MAX_SNIPPET_LENGTH ? `${snippet.slice(0, MAX_SNIPPET_LENGTH)}...` : snippet;
}

/** True when at least one provider (the primary, or an explicitly enabled fallback with its credential) is configured. */
export function isWebSearchConfigured(env: Env): boolean {
  return configuredProviderChain(env).length > 0;
}

/**
 * Contract validation, run before Access and before any provider request
 * (validate_input_before_external_request): an invalid invocation makes no
 * external request at all. Validated against the PRIMARY adapter's
 * capabilities, so the contract a caller sees does not change with which
 * providers a deployment enables; a fallback that cannot honestly apply a
 * valid request's filters is skipped, never used with a filter dropped.
 * Returns a human-readable reason, or null when the request is valid.
 */
function validateSearchRequest(request: SearchRequest, adapter: { capabilities: SearchProviderCapabilities }): string | null {
  if (!request || typeof request !== "object") return "search request must be an object";

  // additional_properties: false -- unknown parameters are rejected, never
  // silently ignored.
  const allowedKeys = ["query", "topic", "date_range", "max_results", "include_domains", "exclude_domains"];
  for (const key of Object.keys(request)) {
    if (!allowedKeys.includes(key)) return `unsupported search parameter "${key}"`;
  }

  const { query, topic, date_range, max_results, include_domains, exclude_domains } = request;

  // trim_whitespace: true -- whitespace-only is invalid_input, incidental
  // whitespace is trimmed (not rejected) before submission.
  if (typeof query !== "string" || !query.trim()) return "query must be a non-empty string after trimming";

  if (topic !== undefined) {
    if (typeof topic !== "string" || !adapter.capabilities.topics.includes(topic)) {
      return `topic must be one of: ${adapter.capabilities.topics.join(", ")}`;
    }
  }

  if (date_range !== undefined) {
    if (!adapter.capabilities.dateRange) return "date_range filtering is not supported by the active search provider adapter";
    return "date_range must be a valid date range";
  }

  if (max_results !== undefined) {
    const { min, max } = adapter.capabilities.maxResults;
    if (!Number.isInteger(max_results) || (max_results as number) < min || (max_results as number) > max) {
      return `max_results must be an integer between ${min} and ${max}`;
    }
  }

  for (const [name, domains] of [
    ["include_domains", include_domains],
    ["exclude_domains", exclude_domains],
  ] as const) {
    if (domains !== undefined) {
      const supported = name === "include_domains" ? adapter.capabilities.includeDomains : adapter.capabilities.excludeDomains;
      if (!supported) return `${name} filtering is not supported by the active search provider adapter`;
      if (!Array.isArray(domains) || domains.length === 0) return `${name} must be a non-empty array of domain strings`;
      if (domains.some((d) => typeof d !== "string" || !d.trim() || /\s/.test(d))) return `${name} must contain only valid domain strings`;
    }
  }

  return null;
}

/** Only absolute http(s) URLs are valid result urls (canonical url constraint). */
function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Maps a successful provider response onto the normalized result shape:
 * bounds count and snippet length, drops entries that are not objects with
 * an absolute http(s) URL, attributes every result to its provider, stamps
 * retrieval time once, and carries publication dates through only when the
 * provider supplied them (never invented).
 */
function normalizeProviderResults(raw: RawSearchResult[], provider: SearchProviderId, retrievedAt: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of raw) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || !isAbsoluteHttpUrl(entry.url)) continue;
    results.push({
      title: typeof entry.title === "string" ? entry.title : "",
      url: entry.url,
      snippet: capSnippet(typeof entry.content === "string" ? entry.content : ""),
      provider,
      retrieved_at: retrievedAt,
      ...(typeof entry.published === "string" && entry.published.trim() ? { published_at: entry.published } : {}),
    });
  }
  return results;
}

/**
 * The shared search Tool entry point (canonical handler shape):
 *
 * 1. validate_input_before_external_request -- invalid input returns
 *    invalid_input with no provider request and no Access check.
 * 2. provider_unavailable when no trusted runtime configuration exists
 *    (an unconfigured provider is never an empty successful search).
 * 3. authorize_before_external_request -- Access evaluates the outbound
 *    disclosure BEFORE it leaves. A refusal THROWS AccessDeniedError and
 *    is deliberately not caught here: denial is a governance decision,
 *    distinct from every provider outcome (access_denial_must_not_be_
 *    caught_as_provider_failure). The `access` context must name the Work
 *    (or Kernel context) doing the searching so Access can resolve its
 *    recorded Action and check its declared consequence permits an
 *    outbound read (see EXTERNAL_EGRESS_TARGET).
 * 4. provider_failure for a thrown request, a non-2xx status, or a
 *    malformed response -- recorded as a failed search, never returned as
 *    success_no_results.
 * 5. success_with_results / success_no_results only for a successful
 *    provider response, with results normalized to the contract shape.
 */
export const SEARCH_STEP = "Searching the web";

/**
 * The live-status label for a finished search (Martin's decision 2026-11-13,
 * option A): the public site of its top result, domain only -- never the
 * query, the full link or any page text. Anything that is not a plain
 * hostname is not shown.
 */
export function finishedSearchLabel(outcome: SearchOutcome): string {
  if (outcome.kind === "success_with_results") {
    const domain = extractDomain(outcome.results[0]?.url ?? "").toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && domain.length <= 60 ? `${SEARCH_STEP} — ${domain}` : SEARCH_STEP;
  }
  if (outcome.kind === "success_no_results") return `${SEARCH_STEP} — nothing found`;
  if (outcome.kind === "interrupted") return `${SEARCH_STEP} — paused, providers busy`;
  return `${SEARCH_STEP} — not completed`;
}

export async function executeSearch(env: Env, request: SearchRequest, access: AccessContext): Promise<SearchOutcome> {
  const invalidReason = validateSearchRequest(request, SEARCH_PROVIDER_ADAPTERS[PRIMARY_SEARCH_PROVIDER]);
  if (invalidReason) return { kind: "invalid_input", reason: invalidReason };
  // Universal live status: never the query text. The step shows ⏳ until
  // the search returns, then names the site it found.
  reportLiveStep(SEARCH_STEP);
  const outcome = await runSearch(env, request, access);
  resolveLiveStep(SEARCH_STEP, finishedSearchLabel(outcome));
  return outcome;
}

async function runSearch(env: Env, request: SearchRequest, access: AccessContext): Promise<SearchOutcome> {
  const chain = configuredProviderChain(env);
  if (chain.length === 0) {
    return { kind: "provider_unavailable", reason: "no search provider is configured (TAVILY_API_KEY is unset and no fallback is enabled)" };
  }

  evaluateAccess(env, { operation: "read", dataSourceId: EXTERNAL_EGRESS_TARGET }, access);

  // Search cache (Martin's decision 2026-11-14, free-tier option C): the
  // same search within 7 days reuses its saved results instead of calling
  // Tavily again, and does not count against the job's or the day's limit.
  // Checked only after Access has allowed the search. Best-effort: a cache
  // failure is a miss, never a failed search.
  const cacheKey = await searchCacheKey(request);
  const cached = await readCachedSearch(env, cacheKey);
  if (cached) return cached;

  // Universal web research ceilings (src/runtime/webLookupAllowance.ts): a
  // search past the run's or the day's ceiling is not made, and says why.
  // Taken ONCE per logical search, before any provider is tried, so falling
  // back to another provider can never reset or evade ENIG's own allowance
  // (internal_allowance_must_not_be_bypassed_by_fallback), and exhaustion
  // never triggers fallback (do_not_fallback_on: internal_allowance_exhaustion).
  const allowance = await takeWebLookup(env);
  if (!allowance.ok) {
    return {
      kind: "internal_allowance_exhausted",
      reason: allowance.reason === "run_limit" ? "the web search limit for this job was reached" : "the daily web search limit was reached",
    };
  }

  return runProviderChain(env, request, access, chain);
}

/**
 * Runs ONE logical search across the configured provider chain, in order
 * (recovery: preserve_original_logical_operation). For each provider:
 * skipped when it cannot apply the request's filters, is cooling down, or
 * has used its monthly budget; otherwise Access is evaluated again (each
 * external request is separately authorized), the request is counted against
 * the provider's month, and it is made. A recoverable failure (rate limit,
 * outage, malformed response) moves to the next provider, starting a
 * cooldown for rate limits and outages; a refused request is a
 * provider_failure that stops the operation. When no provider could complete
 * it, the outcome is `interrupted` (recoverable later) or
 * `provider_unavailable` (every provider's budget is used) -- never an empty
 * success.
 */
async function runProviderChain(env: Env, request: SearchRequest, access: AccessContext, chain: SearchProviderAdapter[]): Promise<SearchOutcome> {
  const maxResults = request.max_results ?? MAX_RESULTS_PER_QUERY;
  const providerRequest = {
    query: request.query.trim(),
    ...(request.topic !== undefined ? { topic: request.topic } : {}),
    ...(request.include_domains !== undefined ? { include_domains: request.include_domains } : {}),
    ...(request.exclude_domains !== undefined ? { exclude_domains: request.exclude_domains } : {}),
  };
  const notes: string[] = [];
  let recoverable = false;
  let earliestRetry: number | null = null;
  const noteRetry = (at: number) => {
    earliestRetry = earliestRetry === null ? at : Math.min(earliestRetry, at);
  };

  for (const adapter of chain) {
    if (!adapterSupports(adapter, providerRequest)) {
      notes.push(`${adapter.id}: cannot apply this request's filters`);
      continue;
    }
    const coolingUntil = await cooldownUntil(env, adapter.id);
    if (coolingUntil !== null) {
      recoverable = true;
      noteRetry(coolingUntil);
      notes.push(`${adapter.id}: cooling down`);
      continue;
    }
    const budget = monthlyBudget(env, adapter.id);
    if (budget === null) {
      notes.push(`${adapter.id}: no monthly budget configured`);
      continue;
    }
    if ((await readMonthlyUsage(env, adapter.id)) >= budget) {
      notes.push(`${adapter.id}: monthly budget used`);
      continue;
    }

    // Each external request is separately authorized, the fallback included
    // (authorize_before_each_external_request). A denial throws and is never
    // caught here.
    evaluateAccess(env, { operation: "read", dataSourceId: EXTERNAL_EGRESS_TARGET }, access);
    await recordProviderRequest(env, adapter.id);
    const retrievedAt = new Date().toISOString();
    let raw: RawSearchResult[];
    try {
      raw = await adapter.fetchResults(env, providerRequest, maxResults);
    } catch (err) {
      const failure = err instanceof SearchProviderError ? err : new SearchProviderError("outage", `${adapter.id} request failed`);
      console.error(`Search provider ${adapter.id}: ${failure.message}`);
      if (!isRecoverableFailure(failure.failure)) {
        return { kind: "provider_failure", reason: `the search provider request failed (${failure.message})` };
      }
      recoverable = true;
      if (failure.failure === "rate_limited" || failure.failure === "outage") {
        noteRetry(await startCooldown(env, adapter.id, failure.retryAfterMs));
      }
      notes.push(`${adapter.id}: ${failure.failure.replace("_", " ")}`);
      continue;
    }

    await clearCooldown(env, adapter.id);
    const results = normalizeProviderResults(raw, adapter.id, retrievedAt, maxResults);
    if (results.length === 0) return { kind: "success_no_results" };
    const outcome: SearchOutcome = { kind: "success_with_results", results };
    await writeCachedSearch(env, await searchCacheKey(request), outcome);
    return outcome;
  }

  const detail = notes.join("; ") || "no provider could take the request";
  if (recoverable) {
    return {
      kind: "interrupted",
      reason: `no search provider could complete the request right now (${detail})`,
      ...(earliestRetry !== null ? { retry_at: new Date(earliestRetry).toISOString() } : {}),
    };
  }
  return { kind: "provider_unavailable", reason: `no eligible search provider can take the request (${detail})` };
}

/** How long a saved search is reused (Martin's decision 2026-11-14, option C). */
export const SEARCH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SEARCH_CACHE_PREFIX = "web_search_cache:";

/**
 * The cache key: a SHA-256 of the whole normalized request, so the stored
 * key never carries the query text. Not in kvStore's fallback allowlist,
 * so it stays Cloudflare-only.
 */
export async function searchCacheKey(request: SearchRequest): Promise<string> {
  const normalized = {
    query: request.query.trim().toLowerCase().replace(/\s+/g, " "),
    topic: request.topic ?? null,
    max_results: request.max_results ?? MAX_RESULTS_PER_QUERY,
    include_domains: [...(request.include_domains ?? [])].sort(),
    exclude_domains: [...(request.exclude_domains ?? [])].sort(),
  };
  return SEARCH_CACHE_PREFIX + (await hashContent(JSON.stringify(normalized)));
}

/** Only a search that found results is saved, and only that shape is read back. Exported for research checkpoints, which reference saved results by this key. */
export async function readCachedSearch(env: Env, key: string): Promise<SearchOutcome | null> {
  if (!env.STATE_KV) return null;
  try {
    const raw = await kvGet(env, key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { results?: unknown };
    if (!Array.isArray(parsed.results) || parsed.results.length === 0) return null;
    return { kind: "success_with_results", results: parsed.results as SearchResult[] };
  } catch (err) {
    console.error("Search cache read failed", err instanceof Error ? err.message : err);
    return null;
  }
}

async function writeCachedSearch(env: Env, key: string, outcome: SearchOutcome): Promise<void> {
  if (!env.STATE_KV || outcome.kind !== "success_with_results") return;
  try {
    await kvPut(env, key, JSON.stringify({ results: outcome.results }), { expirationTtl: SEARCH_CACHE_TTL_SECONDS });
  } catch (err) {
    console.error("Search cache write failed", err instanceof Error ? err.message : err);
  }
}

/** Best-effort domain extraction for source-quality context -- falls back to the raw URL if parsing fails. */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** One research-plan dimension plus the search operation's own outcome for it. */
export interface DimensionEvidence extends ResearchPlanDimension {
  /**
   * Which search outcome produced this dimension's evidence. Carried
   * explicitly so "searched and found nothing" (success_no_results) can
   * never be conflated with "the search never succeeded"
   * (provider_unavailable / provider_failure / invalid_input) in
   * coverage assessment, progress messages, or the synthesis prompt.
   */
  searchOutcome: SearchOutcome["kind"];
  results: SearchResult[];
}

/**
 * Executes the research plan -- one search per dimension, not one per
 * protocol. This is the fix for the core diagnosed failure: a protocol
 * used to collapse to a single generic search phrase; now each of its
 * concrete sub-questions (from researchPlan.ts, grounded in the
 * protocol's own evidenceRequirements) gets its own query. Each query is
 * the dimension's sub-question itself, redacted through the identity gate
 * as defense in depth -- the sub-question was already generated from the
 * abstracted safe-context category, never Martin's raw identity-bearing
 * text, but this costs nothing to double-check. Each dimension records
 * its own search outcome; Access denial still throws (it is not a
 * per-dimension evidence outcome).
 */
export async function gatherDimensionEvidence(env: Env, plan: ResearchPlanDimension[], access: AccessContext): Promise<DimensionEvidence[]> {
  return Promise.all(plan.map(async (dimension) => (await searchDimension(env, dimension, access)).evidence));
}

/** The one search request a plan dimension makes -- deterministic, so a resumed job references the same saved results. */
export function dimensionSearchRequest(dimension: ResearchPlanDimension): SearchRequest {
  return { query: redactIdentityTerms(dimension.subQuestion) };
}

/**
 * Runs ONE plan dimension's search and returns its evidence plus what a
 * research checkpoint records about it: the reference to its saved results
 * in the Search Tool's cache (never the payload) and, when interrupted, the
 * earliest time a provider is expected back.
 */
export async function searchDimension(
  env: Env,
  dimension: ResearchPlanDimension,
  access: AccessContext,
): Promise<{ evidence: DimensionEvidence; evidenceRef?: string; retryAt?: string }> {
  const request = dimensionSearchRequest(dimension);
  const outcome = await executeSearch(env, request, access);
  const evidence: DimensionEvidence = {
    ...dimension,
    searchOutcome: outcome.kind,
    results: outcome.kind === "success_with_results" ? outcome.results : [],
  };
  return {
    evidence,
    ...(outcome.kind === "success_with_results" ? { evidenceRef: await searchCacheKey(request) } : {}),
    ...(outcome.kind === "interrupted" && outcome.retry_at ? { retryAt: outcome.retry_at } : {}),
  };
}

export interface DimensionCoverage {
  covered: DimensionEvidence[];
  /** The search SUCCEEDED and genuinely found nothing -- honest "no evidence found". */
  uncovered: DimensionEvidence[];
  /** The search itself did not complete (unavailable / failure / invalid input) -- absence of evidence is NOT established. */
  failed: DimensionEvidence[];
}

/**
 * Deterministic coverage check -- the minimum, mechanically verifiable
 * form of "adequate vs. insufficient evidence": a dimension with zero
 * search results has no evidence at all, full stop, regardless of what
 * the synthesis model might otherwise be tempted to say about it.
 * Distinguishing "adequate" from "technically present but off-topic"
 * evidence (e.g. a competitor-analysis how-to article for a market-size
 * question) is not mechanically checkable without another model call --
 * that's enforced at the prompt level instead (see the synthesis output
 * contract's explicit rule against exactly this).
 *
 * The `failed` bucket exists because a dimension whose search never
 * succeeded is NOT the same as one that searched and found nothing: only
 * the latter may be reported as "no evidence found".
 */
export function assessDimensionCoverage(dimensionEvidence: DimensionEvidence[]): DimensionCoverage {
  return {
    covered: dimensionEvidence.filter((d) => d.results.length > 0),
    uncovered: dimensionEvidence.filter((d) => d.results.length === 0 && d.searchOutcome === "success_no_results"),
    failed: dimensionEvidence.filter((d) => d.results.length === 0 && d.searchOutcome !== "success_no_results"),
  };
}

/**
 * Formats gathered evidence grouped by protocol/dimension, with domain
 * and date retained per result -- structured, not a flat blob, so the
 * synthesis model (and a human reading the Activity Log) can see which
 * evidence answers which specific sub-question.
 */
export function formatDimensionEvidenceForContext(dimensionEvidence: DimensionEvidence[]): string {
  const withResults = dimensionEvidence.filter((d) => d.results.length > 0);
  if (withResults.length === 0) return "";
  return withResults
    .map((d) => {
      const protocolName = RESEARCH_PROTOCOL_REGISTRY[d.protocol].name;
      const lines = d.results.map(
        (r) => `  - ${r.title} (${r.url}) [source: ${extractDomain(r.url)}]${r.published_at ? ` [${r.published_at}]` : ""}: ${r.snippet}`,
      );
      return `[${protocolName}] Research dimension: "${d.subQuestion}"\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * Surfaces dimensions where a successful search found zero evidence as an
 * explicit warning block injected into the synthesis prompt -- the
 * mechanism that turns "missing evidence" into a required Limitation
 * instead of a silent gap the model might paper over with inference.
 *
 * Defensively filters to genuinely-empty successful searches: this text
 * says "no search evidence was found", so it can never name a dimension
 * whose search itself failed (provider failure must not be represented as
 * absence of evidence, even if a caller passes a mixed list).
 */
export function formatUncoveredDimensionsWarning(uncovered: DimensionEvidence[]): string {
  const genuinelyUncovered = uncovered.filter((d) => d.results.length === 0 && d.searchOutcome === "success_no_results");
  if (genuinelyUncovered.length === 0) return "";
  return `No search evidence was found for the following research dimension(s) -- these MUST be reported as Limitations, never filled in with inference or generic claims:\n${genuinelyUncovered
    .map((d) => `- [${RESEARCH_PROTOCOL_REGISTRY[d.protocol].name}] ${d.subQuestion}`)
    .join("\n")}`;
}

/**
 * Surfaces dimensions whose search itself never succeeded as a SEPARATE
 * warning block: for these, "no evidence" was never established, so they
 * must be reported as search limitations -- explicitly not as proof that
 * no information exists (provider failure must not read as absence of
 * evidence).
 */
export function formatFailedSearchesWarning(failed: DimensionEvidence[]): string {
  if (failed.length === 0) return "";
  return `Web search was unavailable or FAILED for the following research dimension(s) -- no conclusion about these may be drawn either way. This is NOT evidence that no information exists, and it MUST be reported as a search limitation, never filled in with inference:\n${failed
    .map((d) => `- [${RESEARCH_PROTOCOL_REGISTRY[d.protocol].name}] ${d.subQuestion} (search outcome: ${d.searchOutcome})`)
    .join("\n")}`;
}
