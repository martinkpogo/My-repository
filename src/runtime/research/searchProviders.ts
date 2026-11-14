import type { Env } from "../../types";
import { kvDelete, kvGet, kvPut } from "../../kvStore";

// ---------------------------------------------------------------------------
// Search provider adapters and their trusted runtime configuration
// (canonical specification: ENIG HQ / 6. Tools > Search, provider_policy and
// recovery; Build Decision Record BD-15, issue #338).
//
// The Search Tool (./webSearch.ts) stays the ONE logical search operation.
// This module owns only what is provider-specific: translating a validated
// request into a provider call, protecting credentials, mapping the provider
// response onto raw results, and classifying provider failures. It carries
// no business policy or authority (provider_adapter.business_policy_or_
// authority: none).
//
// Provider eligibility comes from trusted runtime configuration only:
//   - the primary provider is Tavily (provider_policy.primary_provider);
//   - a fallback is used only when it is EXPLICITLY ENABLED in
//     `SEARCH_FALLBACK_PROVIDERS` (require_explicit_enablement), has its
//     credential configured, and has a monthly budget;
//   - a Hat, Skill, Work or caller can never select a provider or supply a
//     credential (caller_or_hat_selects_provider: false).
//
// Martin's decisions (14 Nov 2026): fallbacks are Exa then Serper (Brave
// excluded); every provider is held to a monthly budget that stops BELOW its
// free allowance, so no provider is ever charged; a provider that hits a rate
// limit or outage cools down (its own retry-after, otherwise 1 min, 5 min,
// 15 min, 1 h) and is skipped until the cooldown ends.
// ---------------------------------------------------------------------------

export type SearchProviderId = "tavily" | "exa" | "serper";

export const PRIMARY_SEARCH_PROVIDER: SearchProviderId = "tavily";

/** The fallback providers an adapter exists for, in their approved order. Enablement is still explicit, per deployment. */
export const FALLBACK_SEARCH_PROVIDER_ORDER: readonly SearchProviderId[] = ["exa", "serper"];

/** The search parameters an adapter receives -- already validated against the contract. */
export interface ProviderSearchRequest {
  query: string;
  topic?: string;
  include_domains?: string[];
  exclude_domains?: string[];
}

/** What an adapter returns before the Search Tool normalizes and bounds it. */
export interface RawSearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  /** A publication date ONLY as the provider supplied it -- never inferred here. */
  published?: unknown;
}

/** What the adapter can honestly apply. A fallback that cannot apply a requested filter is skipped, never used with the filter silently dropped. */
export interface SearchProviderCapabilities {
  topics: readonly string[];
  maxResults: { min: number; max: number };
  includeDomains: boolean;
  excludeDomains: boolean;
  dateRange: boolean;
}

/**
 * The provider failure classes (recovery.fallback_on). Only the first three
 * are recoverable and may move the operation to the next eligible provider;
 * `rejected` (an HTTP 4xx other than a rate limit -- bad credentials, a
 * refused request) is a provider_failure that stops the operation.
 */
export type ProviderFailureClass = "rate_limited" | "outage" | "malformed" | "rejected";

export function isRecoverableFailure(failure: ProviderFailureClass): boolean {
  return failure === "rate_limited" || failure === "outage" || failure === "malformed";
}

export class SearchProviderError extends Error {
  constructor(
    readonly failure: ProviderFailureClass,
    message: string,
    /** The provider's own retry-after, when it supplied one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export interface SearchProviderAdapter {
  id: SearchProviderId;
  capabilities: SearchProviderCapabilities;
  /** The adapter's credential, read from trusted runtime configuration only. */
  credential(env: Env): string | undefined;
  /** One provider request. Throws SearchProviderError on every failure; never returns an empty list for a failed call. */
  fetchResults(env: Env, request: ProviderSearchRequest, maxResults: number): Promise<RawSearchResult[]>;
}

/** The runtime-defined upper bound for one search invocation (the contract's max_results maximum). */
export const MAX_RESULTS_PER_QUERY_LIMIT = 20;

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds, bounded to the longest cooldown step. */
export function parseRetryAfterMs(res: Response, now: number = Date.now()): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  let ms: number | undefined;
  if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
  else {
    const at = Date.parse(header);
    if (Number.isFinite(at)) ms = Math.max(0, at - now);
  }
  return ms === undefined ? undefined : Math.min(ms, COOLDOWN_STEPS_MS[COOLDOWN_STEPS_MS.length - 1]);
}

/**
 * Classifies a non-2xx provider response. 429 is a rate limit everywhere;
 * Tavily also answers 432 / 433 when its plan or pay-as-you-go limit is
 * reached, which is the same recoverable condition. 408 and 5xx are a
 * temporary outage. Any other status is a refused request (`rejected`).
 * Status only -- the response body is never echoed into logs or reasons.
 */
export function classifyHttpFailure(provider: SearchProviderId, res: Response): SearchProviderError {
  const status = res.status;
  if (status === 429 || (provider === "tavily" && (status === 432 || status === 433))) {
    return new SearchProviderError("rate_limited", `${provider} rate-limited the request (HTTP ${status})`, parseRetryAfterMs(res));
  }
  if (status === 408 || status >= 500) return new SearchProviderError("outage", `${provider} was temporarily unavailable (HTTP ${status})`, parseRetryAfterMs(res));
  return new SearchProviderError("rejected", `${provider} refused the request (HTTP ${status})`);
}

/** Runs the provider fetch and JSON parse, turning every failure into a classified SearchProviderError. */
async function postJson(provider: SearchProviderId, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (err) {
    throw new SearchProviderError("outage", `${provider} could not be reached (${err instanceof Error ? err.name : "network error"})`);
  }
  if (!res.ok) {
    // Status only -- logs must minimize sensitive content: no query text and no response body.
    console.error(`Search provider ${provider} failed: HTTP ${res.status}`);
    throw classifyHttpFailure(provider, res);
  }
  try {
    return await res.json();
  } catch {
    throw new SearchProviderError("malformed", `${provider} returned a malformed response`);
  }
}

function arrayField(data: unknown, field: string, provider: SearchProviderId): unknown[] {
  const value = data && typeof data === "object" ? (data as Record<string, unknown>)[field] : undefined;
  if (!Array.isArray(value)) throw new SearchProviderError("malformed", `${provider} returned a malformed response`);
  return value;
}

const TAVILY_ADAPTER: SearchProviderAdapter = {
  id: "tavily",
  capabilities: {
    topics: ["general", "news"],
    maxResults: { min: 1, max: MAX_RESULTS_PER_QUERY_LIMIT },
    includeDomains: true,
    excludeDomains: true,
    dateRange: false,
  },
  credential: (env) => env.TAVILY_API_KEY,
  async fetchResults(env, request, maxResults) {
    const data = await postJson("tavily", "https://api.tavily.com/search", {}, {
      api_key: env.TAVILY_API_KEY,
      query: request.query,
      max_results: maxResults,
      search_depth: "basic",
      ...(request.topic ? { topic: request.topic } : {}),
      ...(request.include_domains ? { include_domains: request.include_domains } : {}),
      ...(request.exclude_domains ? { exclude_domains: request.exclude_domains } : {}),
    });
    return arrayField(data, "results", "tavily").map((r) => {
      const e = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return { title: e.title, url: e.url, content: e.content, published: e.published_date };
    });
  },
};

/**
 * Exa (https://exa.ai/docs/reference/search): POST /search with the
 * credential in `x-api-key`; highlights are the bounded page extracts used as
 * the snippet. `publishedDate` is Exa's own estimate from the page, carried
 * through only as Exa supplied it.
 */
const EXA_ADAPTER: SearchProviderAdapter = {
  id: "exa",
  capabilities: {
    topics: ["general", "news"],
    maxResults: { min: 1, max: MAX_RESULTS_PER_QUERY_LIMIT },
    includeDomains: true,
    excludeDomains: true,
    dateRange: false,
  },
  credential: (env) => env.EXA_API_KEY,
  async fetchResults(env, request, maxResults) {
    const data = await postJson("exa", "https://api.exa.ai/search", { "x-api-key": env.EXA_API_KEY ?? "" }, {
      query: request.query,
      type: "auto",
      numResults: maxResults,
      contents: { highlights: true },
      ...(request.topic === "news" ? { category: "news" } : {}),
      ...(request.include_domains ? { includeDomains: request.include_domains } : {}),
      ...(request.exclude_domains ? { excludeDomains: request.exclude_domains } : {}),
    });
    return arrayField(data, "results", "exa").map((r) => {
      const e = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const highlights = Array.isArray(e.highlights) ? e.highlights.filter((h): h is string => typeof h === "string").join(" ... ") : "";
      return { title: e.title, url: e.url, content: highlights || e.text, published: e.publishedDate };
    });
  },
};

/**
 * Serper (Google results): POST /search, or /news for the news topic, with
 * the credential in `X-API-KEY`. It cannot restrict or exclude domains
 * without rewriting the query, so it declares neither filter and is skipped
 * for a request that uses one. Its dates are relative text ("3 days ago"),
 * which this adapter does not convert -- a date is never inferred.
 */
const SERPER_ADAPTER: SearchProviderAdapter = {
  id: "serper",
  capabilities: {
    topics: ["general", "news"],
    maxResults: { min: 1, max: MAX_RESULTS_PER_QUERY_LIMIT },
    includeDomains: false,
    excludeDomains: false,
    dateRange: false,
  },
  credential: (env) => env.SERPER_API_KEY,
  async fetchResults(env, request, maxResults) {
    const news = request.topic === "news";
    const data = await postJson("serper", news ? "https://google.serper.dev/news" : "https://google.serper.dev/search", { "X-API-KEY": env.SERPER_API_KEY ?? "" }, {
      q: request.query,
      num: maxResults,
    });
    return arrayField(data, news ? "news" : "organic", "serper").map((r) => {
      const e = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return { title: e.title, url: e.link, content: e.snippet };
    });
  },
};

export const SEARCH_PROVIDER_ADAPTERS: Readonly<Record<SearchProviderId, SearchProviderAdapter>> = {
  tavily: TAVILY_ADAPTER,
  exa: EXA_ADAPTER,
  serper: SERPER_ADAPTER,
};

/** Whether this adapter can apply every filter the request uses (it is skipped otherwise, never used with a filter dropped). */
export function adapterSupports(adapter: SearchProviderAdapter, request: ProviderSearchRequest): boolean {
  const c = adapter.capabilities;
  if (request.topic !== undefined && !c.topics.includes(request.topic)) return false;
  if (request.include_domains !== undefined && !c.includeDomains) return false;
  if (request.exclude_domains !== undefined && !c.excludeDomains) return false;
  return true;
}

// --- Monthly budgets (Martin, 14 Nov 2026) --------------------------------

/**
 * Default monthly request budgets, each below the provider's free allowance:
 *   - Tavily: 1,000 free credits a month; one basic search costs 1 credit.
 *   - Serper: 2,500 free searches ONCE (not monthly), so it is a reserve
 *     spread across the year rather than spent in a month.
 * Exa has no default: its free allowance is reported inconsistently, so it
 * is not eligible until `SEARCH_MONTHLY_BUDGET_EXA` is set from Martin's own
 * Exa dashboard. A configured value overrides a default.
 */
export const DEFAULT_MONTHLY_BUDGETS: Readonly<Partial<Record<SearchProviderId, number>>> = {
  tavily: 950,
  serper: 200,
};

const BUDGET_ENV: Readonly<Record<SearchProviderId, keyof Env>> = {
  tavily: "SEARCH_MONTHLY_BUDGET_TAVILY",
  exa: "SEARCH_MONTHLY_BUDGET_EXA",
  serper: "SEARCH_MONTHLY_BUDGET_SERPER",
};

/** The provider's monthly budget, or null when none is configured (the provider is then not eligible). */
export function monthlyBudget(env: Env, provider: SearchProviderId): number | null {
  const raw = env[BUDGET_ENV[provider]];
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return DEFAULT_MONTHLY_BUDGETS[provider] ?? null;
}

/** The fallbacks this deployment explicitly enabled, in the approved order. Unknown names and the primary are ignored. */
export function enabledFallbackProviders(env: Env): SearchProviderId[] {
  const listed = new Set(
    String(env.SEARCH_FALLBACK_PROVIDERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return FALLBACK_SEARCH_PROVIDER_ORDER.filter((id) => listed.has(id));
}

/** The ordered provider chain for this deployment: the primary, then each explicitly enabled fallback that has a credential. */
export function configuredProviderChain(env: Env): SearchProviderAdapter[] {
  const chain: SearchProviderAdapter[] = [];
  if (SEARCH_PROVIDER_ADAPTERS[PRIMARY_SEARCH_PROVIDER].credential(env)) chain.push(SEARCH_PROVIDER_ADAPTERS[PRIMARY_SEARCH_PROVIDER]);
  for (const id of enabledFallbackProviders(env)) {
    if (SEARCH_PROVIDER_ADAPTERS[id].credential(env)) chain.push(SEARCH_PROVIDER_ADAPTERS[id]);
  }
  return chain;
}

function usageKey(provider: SearchProviderId, now: Date): string {
  return `search_provider_usage:${provider}:${now.toISOString().slice(0, 7)}`;
}

/** This month's recorded requests for a provider. Unreadable storage reads as 0 (logged), the same rule as the daily allowance. */
export async function readMonthlyUsage(env: Env, provider: SearchProviderId, now: Date = new Date()): Promise<number> {
  try {
    const raw = await kvGet(env, usageKey(provider, now));
    return Number(raw) || 0;
  } catch (err) {
    console.error(`Search provider ${provider}: monthly usage unreadable`, err instanceof Error ? err.message : err);
    return 0;
  }
}

/** Counts one request against the provider's month BEFORE it is made, so an interrupted request is still counted. */
export async function recordProviderRequest(env: Env, provider: SearchProviderId, now: Date = new Date()): Promise<void> {
  const used = await readMonthlyUsage(env, provider, now);
  await kvPut(env, usageKey(provider, now), String(used + 1), { expirationTtl: 40 * 24 * 60 * 60 }).catch((err) =>
    console.error(`Search provider ${provider}: monthly usage not saved`, err instanceof Error ? err.message : err),
  );
}

// --- Cooldowns (Martin, 14 Nov 2026) --------------------------------------

/** Cooldown ladder when the provider gives no retry-after: 1 min, 5 min, 15 min, 1 h. Bounded: never longer than the last step. */
export const COOLDOWN_STEPS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

interface CooldownRecord {
  until: number;
  step: number;
}

function cooldownKey(provider: SearchProviderId): string {
  return `search_provider_cooldown:${provider}`;
}

async function readCooldownRecord(env: Env, provider: SearchProviderId): Promise<CooldownRecord | null> {
  try {
    const raw = await kvGet(env, cooldownKey(provider));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CooldownRecord>;
    return typeof parsed.until === "number" && typeof parsed.step === "number" ? { until: parsed.until, step: parsed.step } : null;
  } catch {
    return null;
  }
}

/** When the provider's cooldown ends, or null when it is not cooling down. */
export async function cooldownUntil(env: Env, provider: SearchProviderId, now: number = Date.now()): Promise<number | null> {
  const record = await readCooldownRecord(env, provider);
  return record && record.until > now ? record.until : null;
}

/** Starts (or escalates) a provider's cooldown after a rate limit or outage. Returns when it ends. */
export async function startCooldown(env: Env, provider: SearchProviderId, retryAfterMs: number | undefined, now: number = Date.now()): Promise<number> {
  const previous = await readCooldownRecord(env, provider);
  const step = previous ? Math.min(previous.step + 1, COOLDOWN_STEPS_MS.length - 1) : 0;
  const wait = retryAfterMs !== undefined ? Math.min(Math.max(retryAfterMs, 1000), COOLDOWN_STEPS_MS[COOLDOWN_STEPS_MS.length - 1]) : COOLDOWN_STEPS_MS[step];
  const until = now + wait;
  // Kept past `until` so the next failure escalates the ladder instead of restarting it.
  await kvPut(env, cooldownKey(provider), JSON.stringify({ until, step }), { expirationTtl: 2 * 60 * 60 }).catch((err) =>
    console.error(`Search provider ${provider}: cooldown not saved`, err instanceof Error ? err.message : err),
  );
  return until;
}

/** A successful request ends the provider's cooldown history. */
export async function clearCooldown(env: Env, provider: SearchProviderId): Promise<void> {
  await kvDelete(env, cooldownKey(provider)).catch(() => {});
}
