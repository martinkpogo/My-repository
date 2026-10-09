import type { Env } from "../../types";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { EXTERNAL_EGRESS_TARGET, evaluateAccess, type AccessContext } from "../../access";
import { RESEARCH_PROTOCOL_REGISTRY } from "./protocols";
import type { ResearchPlanDimension } from "./researchPlan";

// ---------------------------------------------------------------------------
// The shared search Tool contract (canonical specification: ENIG HQ / 6.
// Tools > Search, LOG-1068). This module is the single executable
// registration and handler for the `search` tool id: one provider-neutral
// request/outcome shape that every authorized consumer (research executor,
// Sales Lead Generation, and any later consumer) calls through the same
// Access-gated path. Provider policy comes from trusted runtime
// configuration below -- never from a caller, Hat, or Skill.
// ---------------------------------------------------------------------------

/** The provider ids the contract knows about. Only `tavily` is enabled (provider_policy: initial_provider: tavily). */
export type SearchProviderId = "tavily";

/**
 * Trusted runtime configuration: the one provider behind every search
 * invocation. A Hat, Skill, Work, or caller cannot select a provider or
 * supply credentials (provider_policy: caller_or_hat_selects_provider: false;
 * additional_providers_enabled: false). Adding a provider means changing
 * this approved configuration, not calling a second mechanism.
 */
export const ACTIVE_SEARCH_PROVIDER: SearchProviderId = "tavily";

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
  /** Which provider produced this result (currently always "tavily"). */
  provider: string;
  /** When this result was retrieved from the provider, ISO-8601. */
  retrieved_at: string;
  /** Publication date ONLY if the provider itself supplied one -- never inferred. */
  published_at?: string;
}

/**
 * The five distinguishable outcomes. A provider failure or unavailable
 * provider must never read as "no evidence exists" -- callers branch on
 * `kind` so an unsearched query cannot masquerade as an empty result.
 * (Access denial is deliberately NOT one of these: it is a governance
 * decision that throws AccessDeniedError before any provider request.)
 */
export type SearchOutcome =
  | { kind: "success_with_results"; results: SearchResult[] }
  | { kind: "success_no_results" }
  | { kind: "provider_unavailable"; reason: string }
  | { kind: "provider_failure"; reason: string }
  | { kind: "invalid_input"; reason: string };

/** What the active provider adapter can actually apply -- anything else is rejected, not ignored. */
interface SearchProviderCapabilities {
  topics: readonly string[];
  maxResults: { min: number; max: number };
  includeDomains: boolean;
  excludeDomains: boolean;
  dateRange: boolean;
}

/** Raw provider response shape (Tavily): only what normalization consumes. */
interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
}

interface SearchProviderAdapter {
  id: SearchProviderId;
  capabilities: SearchProviderCapabilities;
  /**
   * Translates one validated request into a provider call. Credentials
   * never leave this function. Throws on network error, non-2xx, or
   * malformed JSON -- the caller classifies every throw as
   * provider_failure (a failed search, never an empty one).
   */
  fetchResults(env: Env, request: SearchRequest, maxResults: number): Promise<TavilyResponse>;
}

const TAVILY_API_URL = "https://api.tavily.com/search";
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
// contract's max_results maximum, matched to Tavily's own API limit).
// Requests beyond it are invalid_input rather than silently truncated.
const MAX_RESULTS_PER_QUERY_LIMIT = 20;

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

/**
 * Tavily -- the only initially enabled provider (initial_provider: tavily).
 * Its capabilities are declared explicitly so validation can reject what
 * this adapter cannot honestly apply instead of pretending the filter was
 * passed through.
 */
const TAVILY_ADAPTER: SearchProviderAdapter = {
  id: "tavily",
  capabilities: {
    topics: ["general", "news"],
    maxResults: { min: 1, max: MAX_RESULTS_PER_QUERY_LIMIT },
    includeDomains: true,
    excludeDomains: true,
    dateRange: false,
  },
  async fetchResults(env, request, maxResults) {
    const res = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: request.query.trim(),
        max_results: maxResults,
        search_depth: "basic",
        ...(request.topic ? { topic: request.topic } : {}),
        ...(request.include_domains ? { include_domains: request.include_domains } : {}),
        ...(request.exclude_domains ? { exclude_domains: request.exclude_domains } : {}),
      }),
    });
    if (!res.ok) {
      // Status only -- logs must minimize sensitive content: no query text
      // and no response body echo here.
      console.error(`Tavily search failed: HTTP ${res.status}`);
      throw new Error(`search provider responded with HTTP ${res.status}`);
    }
    // Malformed JSON throws here and is classified as provider_failure by
    // the caller -- never as an empty successful search.
    return (await res.json()) as TavilyResponse;
  },
};

export function isWebSearchConfigured(env: Env): boolean {
  return Boolean(env.TAVILY_API_KEY);
}

/**
 * Contract validation, run before Access and before any provider request
 * (validate_input_before_external_request): an invalid invocation makes no
 * external request at all. Returns a human-readable reason, or null when
 * the request is valid for the active adapter.
 */
function validateSearchRequest(request: SearchRequest, adapter: SearchProviderAdapter): string | null {
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
function normalizeTavilyResults(raw: TavilyResponse["results"], retrievedAt: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of raw ?? []) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || !isAbsoluteHttpUrl(entry.url)) continue;
    results.push({
      title: typeof entry.title === "string" ? entry.title : "",
      url: entry.url,
      snippet: capSnippet(typeof entry.content === "string" ? entry.content : ""),
      provider: ACTIVE_SEARCH_PROVIDER,
      retrieved_at: retrievedAt,
      ...(typeof entry.published_date === "string" && entry.published_date.trim() ? { published_at: entry.published_date } : {}),
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
export async function executeSearch(env: Env, request: SearchRequest, access: AccessContext): Promise<SearchOutcome> {
  const invalidReason = validateSearchRequest(request, TAVILY_ADAPTER);
  if (invalidReason) return { kind: "invalid_input", reason: invalidReason };

  if (!env.TAVILY_API_KEY) {
    return { kind: "provider_unavailable", reason: "no search provider is configured (TAVILY_API_KEY is unset)" };
  }

  evaluateAccess(env, { operation: "read", dataSourceId: EXTERNAL_EGRESS_TARGET }, access);

  const maxResults = request.max_results ?? MAX_RESULTS_PER_QUERY;
  const retrievedAt = new Date().toISOString();

  let data: TavilyResponse;
  try {
    data = await TAVILY_ADAPTER.fetchResults(env, request, maxResults);
  } catch (err) {
    console.error("Search provider request failed", err instanceof Error ? err.message : err);
    return { kind: "provider_failure", reason: "the search provider request failed (network or provider execution error)" };
  }

  if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
    console.error("Search provider returned a malformed response");
    return { kind: "provider_failure", reason: "the search provider returned a malformed response" };
  }

  const results = normalizeTavilyResults(data.results, retrievedAt, maxResults);
  return results.length > 0 ? { kind: "success_with_results", results } : { kind: "success_no_results" };
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
  return Promise.all(
    plan.map(async (dimension) => {
      const query = redactIdentityTerms(dimension.subQuestion);
      const outcome = await executeSearch(env, { query }, access);
      return {
        ...dimension,
        searchOutcome: outcome.kind,
        results: outcome.kind === "success_with_results" ? outcome.results : [],
      };
    }),
  );
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
