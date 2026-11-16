import type { Env } from "../../types";
import { EXTERNAL_EGRESS_TARGET, evaluateAccess, type AccessContext } from "../../access";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { hashContent } from "../../contentHash";
import { kvGet, kvPut } from "../../kvStore";
import { currentRun, withLiveOperation, type OperationOutcome } from "../liveStatus";
import {
  classifyHttpFailure,
  clearCooldown,
  cooldownUntil,
  readMonthlyUsage,
  recordProviderRequest,
  SearchProviderError,
  startCooldown,
} from "./searchProviders";

// ---------------------------------------------------------------------------
// The shared Web page read Tool (canonical specification: ENIG HQ / 6. Tools
// > Web page read, Martin 15 Nov 2026; BD-16 and the Research Runtime
// decision). It reads the text of ONE public web page for an authorized Work
// task. It is machinery: it decides nothing about research methodology.
//
// Readers, in order (trusted runtime configuration; never caller-selected):
//   1. direct fetch by the Worker -- free, always available;
//   2. Jina Reader -- only when listed in PAGE_READ_FALLBACK_READERS and
//      JINA_API_KEY is set; monthly budget below its one-time free grant;
//   3. Tavily Extract -- only when listed and TAVILY_API_KEY is set; counted
//      against Tavily's SAME monthly budget as search (one request = one
//      unit, a deliberate over-count: Tavily charges 1 credit per 5 pages).
//
// Security (SSRF -- not optional): only http(s) on the default ports; no
// localhost, private, link-local, carrier-grade NAT, metadata or IP-literal
// private hosts; redirects are followed manually (at most 5) and every hop is
// re-checked. Access is evaluated before EVERY external request. The URL is
// refused if it carries identity terms (it is never silently rewritten).
// Limitation recorded: a Worker cannot resolve DNS before fetching, so a
// public hostname that resolves to a private address is not detectable here;
// Cloudflare's egress reaches only the public internet.
// ---------------------------------------------------------------------------

export type PageReaderId = "direct_fetch" | "jina_reader" | "tavily_extract";

export const FALLBACK_READER_ORDER: readonly PageReaderId[] = ["jina_reader", "tavily_extract"];

/** Default bounded text length, and the runtime-defined maximum (canonical max_characters). */
export const DEFAULT_PAGE_TEXT_CHARS = 6000;
export const MAX_PAGE_TEXT_CHARS = 20000;

/** Martin's allowance (canonical spec): at most 12 pages per job and 100 per day. Switching readers can never bypass it. */
export const PAGE_READ_RUN_LIMIT = 12;
export const PAGE_READ_DAILY_LIMIT = 100;

/** Jina's free grant is one-time (10M tokens), so it is spread across the year, like Serper. Override with PAGE_READ_MONTHLY_BUDGET_JINA. */
export const DEFAULT_JINA_MONTHLY_BUDGET = 250;
/** Below this many characters a page is treated as script-rendered or empty, so the next reader is tried. */
const MIN_READABLE_CHARS = 200;
const MAX_REDIRECTS = 5;
export const PAGE_READ_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PageReadRequest {
  url: string;
  max_characters?: number;
}

export interface PageReadResult {
  url: string;
  final_url: string;
  title: string;
  text: string;
  provider: PageReaderId;
  retrieved_at: string;
  published_at?: string;
}

/**
 * The distinguishable outcomes (canonical spec). An Access denial is the
 * contract's `denied` outcome, delivered as a thrown AccessDeniedError and
 * never caught as a reader failure.
 */
export type PageReadOutcome =
  | { kind: "success"; result: PageReadResult }
  | { kind: "empty_page"; reason: string }
  | { kind: "blocked_by_site"; reason: string }
  | { kind: "provider_unavailable"; reason: string }
  | { kind: "provider_failure"; reason: string }
  | { kind: "invalid_input"; reason: string }
  | { kind: "internal_allowance_exhausted"; reason: string }
  | { kind: "interrupted"; reason: string; retry_at?: string };

// --- Input validation and the SSRF guard ----------------------------------

const PRIVATE_HOST = /^(localhost|localhost\.localdomain|metadata\.google\.internal|metadata)$/i;
const PRIVATE_SUFFIX = /\.(local|localhost|internal|intranet|lan|home|corp)$/i;

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

/** Why a URL may not be read, or null when it is an acceptable public http(s) URL. */
export function unsafeUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url must be an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https URLs may be read";
  if (url.username || url.password) return "URLs carrying credentials may not be read";
  if (url.port && url.port !== "80" && url.port !== "443") return "only the default http/https ports may be read";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "url has no host";
  if (PRIVATE_HOST.test(host) || PRIVATE_SUFFIX.test(host)) return "private or internal hosts may not be read";
  if (isPrivateIpv4(host)) return "private, loopback, link-local or reserved addresses may not be read";
  if (host.includes(":")) {
    // Any IPv6 literal is refused: loopback, link-local, unique-local and
    // IPv4-mapped forms cannot all be told apart reliably here, and public
    // pages are reached by name.
    return "IP-address hosts (IPv6) may not be read";
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return "numeric host forms may not be read";
  return null;
}

function validatePageReadRequest(request: PageReadRequest): string | null {
  if (!request || typeof request !== "object") return "page read request must be an object";
  for (const key of Object.keys(request)) {
    if (key !== "url" && key !== "max_characters") return `unsupported page read parameter "${key}"`;
  }
  if (typeof request.url !== "string" || !request.url.trim()) return "url must be a non-empty string";
  if (request.max_characters !== undefined) {
    if (!Number.isInteger(request.max_characters) || request.max_characters < 1 || request.max_characters > MAX_PAGE_TEXT_CHARS) {
      return `max_characters must be an integer between 1 and ${MAX_PAGE_TEXT_CHARS}`;
    }
  }
  const unsafe = unsafeUrlReason(request.url.trim());
  if (unsafe) return unsafe;
  if (redactIdentityTerms(request.url.trim()) !== request.url.trim()) return "the URL carries identity terms and may not be sent out";
  return null;
}

// --- Text extraction -------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Plain readable text from HTML: scripts, styles, navigation and markup removed. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// --- Readers ----------------------------------------------------------------

/** A reader failure class. `blocked` and `unreadable` (script-only, non-text) move to the next reader; `not_found` does not. */
type ReaderFailure = SearchProviderError["failure"] | "blocked" | "unreadable" | "not_found";

class PageReaderError extends Error {
  constructor(
    readonly failure: ReaderFailure,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function fromSearchError(err: SearchProviderError): PageReaderError {
  return new PageReaderError(err.failure, err.message, err.retryAfterMs);
}

interface RawPage {
  final_url: string;
  title: string;
  text: string;
}

async function directFetch(url: string): Promise<RawPage> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": "Mozilla/5.0 (compatible; research-reader)" } });
    } catch (err) {
      throw new PageReaderError("outage", `direct fetch could not reach the site (${err instanceof Error ? err.name : "network error"})`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new PageReaderError("malformed", "redirect without a location");
      const next = new URL(location, current).toString();
      const unsafe = unsafeUrlReason(next);
      if (unsafe) throw new PageReaderError("rejected", `redirect refused: ${unsafe}`);
      current = next;
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new PageReaderError("not_found", `the page does not exist (HTTP ${res.status})`);
    if (res.status === 401 || res.status === 403 || res.status === 451) throw new PageReaderError("blocked", `the site refused automated reading (HTTP ${res.status})`);
    if (res.status === 429) throw new PageReaderError("blocked", "the site rate-limited automated reading (HTTP 429)");
    if (!res.ok) throw new PageReaderError(res.status >= 500 || res.status === 408 ? "outage" : "rejected", `the site answered HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.includes("html") && !type.includes("text/plain") && !type.includes("xml")) {
      throw new PageReaderError("unreadable", `the page is not text (${type.split(";")[0]})`);
    }
    const body = await res.text();
    const page = type.includes("text/plain") ? { title: "", text: body.trim() } : htmlToText(body);
    if (page.text.length < MIN_READABLE_CHARS) throw new PageReaderError("unreadable", "the page has no readable text without running scripts");
    return { final_url: current, ...page };
  }
  throw new PageReaderError("malformed", `more than ${MAX_REDIRECTS} redirects`);
}

async function jinaRead(env: Env, url: string): Promise<RawPage> {
  let res: Response;
  try {
    res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: "application/json", Authorization: `Bearer ${env.JINA_API_KEY ?? ""}` } });
  } catch (err) {
    throw new PageReaderError("outage", `jina_reader could not be reached (${err instanceof Error ? err.name : "network error"})`);
  }
  if (!res.ok) {
    console.error(`Page reader jina_reader failed: HTTP ${res.status}`);
    if (res.status === 422 || res.status === 451) throw new PageReaderError("blocked", `jina_reader could not read the page (HTTP ${res.status})`);
    throw fromSearchError(classifyHttpFailure("jina_reader", res));
  }
  let data: { data?: { title?: unknown; url?: unknown; content?: unknown } };
  try {
    data = await res.json();
  } catch {
    throw new PageReaderError("malformed", "jina_reader returned a malformed response");
  }
  const content = typeof data?.data?.content === "string" ? data.data.content.trim() : null;
  if (content === null) throw new PageReaderError("malformed", "jina_reader returned a malformed response");
  if (content.length < MIN_READABLE_CHARS) throw new PageReaderError("unreadable", "jina_reader found no readable text");
  return { final_url: typeof data.data?.url === "string" ? data.data.url : url, title: typeof data.data?.title === "string" ? data.data.title : "", text: content };
}

async function tavilyExtract(env: Env, url: string): Promise<RawPage> {
  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: env.TAVILY_API_KEY, urls: [url] }) });
  } catch (err) {
    throw new PageReaderError("outage", `tavily_extract could not be reached (${err instanceof Error ? err.name : "network error"})`);
  }
  if (!res.ok) {
    console.error(`Page reader tavily_extract failed: HTTP ${res.status}`);
    throw fromSearchError(classifyHttpFailure("tavily", res));
  }
  let data: { results?: Array<{ url?: unknown; raw_content?: unknown }>; failed_results?: unknown[] };
  try {
    data = await res.json();
  } catch {
    throw new PageReaderError("malformed", "tavily_extract returned a malformed response");
  }
  if (!Array.isArray(data?.results)) throw new PageReaderError("malformed", "tavily_extract returned a malformed response");
  const hit = data.results[0];
  const text = typeof hit?.raw_content === "string" ? hit.raw_content.trim() : "";
  if (!hit || text.length < MIN_READABLE_CHARS) throw new PageReaderError("unreadable", "tavily_extract could not read the page");
  return { final_url: typeof hit.url === "string" ? hit.url : url, title: "", text };
}

interface Reader {
  id: PageReaderId;
  /** The monthly-budget counter this reader draws on, or null for the free direct fetch. */
  budgetKey: string | null;
  configured(env: Env): boolean;
  budget(env: Env): number | null;
  read(env: Env, url: string): Promise<RawPage>;
}

function configuredNumber(raw: unknown, fallback: number | null): number | null {
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return fallback;
}

const READERS: Readonly<Record<PageReaderId, Reader>> = {
  direct_fetch: { id: "direct_fetch", budgetKey: null, configured: () => true, budget: () => null, read: (_env, url) => directFetch(url) },
  jina_reader: {
    id: "jina_reader",
    budgetKey: "jina_reader",
    configured: (env) => Boolean(env.JINA_API_KEY),
    budget: (env) => configuredNumber(env.PAGE_READ_MONTHLY_BUDGET_JINA, DEFAULT_JINA_MONTHLY_BUDGET),
    read: jinaRead,
  },
  tavily_extract: {
    id: "tavily_extract",
    // Shares Tavily's one monthly budget with search.
    budgetKey: "tavily",
    configured: (env) => Boolean(env.TAVILY_API_KEY),
    budget: (env) => configuredNumber(env.SEARCH_MONTHLY_BUDGET_TAVILY, 950),
    read: tavilyExtract,
  },
};

/** The reader chain for this deployment: direct fetch, then each explicitly enabled, keyed fallback in the approved order. */
export function configuredReaderChain(env: Env): Reader[] {
  const listed = new Set(String(env.PAGE_READ_FALLBACK_READERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return [READERS.direct_fetch, ...FALLBACK_READER_ORDER.filter((id) => listed.has(id) && READERS[id].configured(env)).map((id) => READERS[id])];
}

// --- Allowance (ENIG's own, never bypassed by switching readers) -------------

const runReads = new WeakMap<object, number>();

function dailyKey(): string {
  return `web_page_read_count:${new Date().toISOString().slice(0, 10)}`;
}

/** Counts one logical page read against the job's and the day's allowance, once, before any reader is tried. */
export async function takePageRead(env: Env): Promise<{ ok: true } | { ok: false; reason: string }> {
  const run = currentRun();
  if (run && (runReads.get(run) ?? 0) >= PAGE_READ_RUN_LIMIT) return { ok: false, reason: `the page-read limit for this job (${PAGE_READ_RUN_LIMIT}) was reached` };
  let used = 0;
  try {
    used = Number(await kvGet(env, dailyKey())) || 0;
  } catch {
    used = 0;
  }
  if (used >= PAGE_READ_DAILY_LIMIT) return { ok: false, reason: `the daily page-read limit (${PAGE_READ_DAILY_LIMIT}) was reached` };
  await kvPut(env, dailyKey(), String(used + 1), { expirationTtl: 2 * 24 * 60 * 60 }).catch((err) => console.error("Page read: daily count not saved", err instanceof Error ? err.message : err));
  if (run) runReads.set(run, (runReads.get(run) ?? 0) + 1);
  return { ok: true };
}

// --- Cache (same rules as the search cache) --------------------------------

async function cacheKey(url: string, max: number): Promise<string> {
  return `web_page_read_cache:${await hashContent(JSON.stringify({ url, max }))}`;
}

async function readCache(env: Env, key: string): Promise<PageReadResult | null> {
  if (!env.STATE_KV) return null;
  try {
    const raw = await kvGet(env, key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PageReadResult;
    return typeof parsed?.text === "string" && typeof parsed.url === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(env: Env, key: string, result: PageReadResult): Promise<void> {
  if (!env.STATE_KV) return;
  await kvPut(env, key, JSON.stringify(result), { expirationTtl: PAGE_READ_CACHE_TTL_SECONDS }).catch((err) => console.error("Page read cache write failed", err instanceof Error ? err.message : err));
}

// --- The Tool entry point ------------------------------------------------------

export const PAGE_READ_STEP = "Reading a web page";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** How one page read ended, for the activity feed: a page with no usable text is partly done; ENIG's allowance refusing it is `denied`. */
export function pageReadOperationOutcome(outcome: PageReadOutcome): OperationOutcome {
  if (outcome.kind === "success") return "succeeded";
  if (outcome.kind === "empty_page") return "partially_completed";
  return outcome.kind === "internal_allowance_exhausted" ? "denied" : "failed";
}

export async function readWebPage(env: Env, request: PageReadRequest, access: AccessContext): Promise<PageReadOutcome> {
  const invalid = validatePageReadRequest(request);
  if (invalid) return { kind: "invalid_input", reason: invalid };
  // One operation (#369): ⏳ until the read returns, then the site's domain
  // and how it actually ended.
  const domain = domainOf(request.url);
  return withLiveOperation(
    PAGE_READ_STEP,
    () => runPageRead(env, { url: request.url.trim(), max: request.max_characters ?? DEFAULT_PAGE_TEXT_CHARS }, access),
    pageReadOperationOutcome,
    { finalLabel: (outcome) => (outcome.kind === "success" && /^[a-z0-9.-]+$/.test(domain) ? `${PAGE_READ_STEP} — ${domain}` : `${PAGE_READ_STEP} — not completed`) },
  );
}

async function runPageRead(env: Env, request: { url: string; max: number }, access: AccessContext): Promise<PageReadOutcome> {
  evaluateAccess(env, { operation: "read", dataSourceId: EXTERNAL_EGRESS_TARGET }, access);
  const key = await cacheKey(request.url, request.max);
  const cached = await readCache(env, key);
  if (cached) return { kind: "success", result: cached };

  const allowance = await takePageRead(env);
  if (!allowance.ok) return { kind: "internal_allowance_exhausted", reason: allowance.reason };

  const notes: string[] = [];
  let recoverable = false;
  let sawBlocked = false;
  let sawUnreadable = false;
  let earliestRetry: number | null = null;

  for (const reader of configuredReaderChain(env)) {
    if (reader.budgetKey) {
      const until = await cooldownUntil(env, reader.budgetKey);
      if (until !== null) {
        recoverable = true;
        earliestRetry = earliestRetry === null ? until : Math.min(earliestRetry, until);
        notes.push(`${reader.id}: cooling down`);
        continue;
      }
      const budget = reader.budget(env);
      if (budget === null || (await readMonthlyUsage(env, reader.budgetKey)) >= budget) {
        notes.push(`${reader.id}: monthly budget used or not configured`);
        continue;
      }
    }
    // Every external request is separately authorized (authorization_before_each_external_request).
    evaluateAccess(env, { operation: "read", dataSourceId: EXTERNAL_EGRESS_TARGET }, access);
    if (reader.budgetKey) await recordProviderRequest(env, reader.budgetKey);
    const retrievedAt = new Date().toISOString();
    try {
      const page = await reader.read(env, request.url);
      if (reader.budgetKey) await clearCooldown(env, reader.budgetKey);
      const result: PageReadResult = {
        url: request.url,
        final_url: page.final_url,
        title: page.title,
        text: bound(page.text, request.max),
        provider: reader.id,
        retrieved_at: retrievedAt,
      };
      await writeCache(env, key, result);
      return { kind: "success", result };
    } catch (err) {
      const failure = err instanceof PageReaderError ? err : new PageReaderError("outage", `${reader.id} failed`);
      console.error(`Page reader ${reader.id}: ${failure.message}`);
      if (failure.failure === "not_found") return { kind: "provider_failure", reason: failure.message };
      if (failure.failure === "rejected") return { kind: "provider_failure", reason: failure.message };
      if (failure.failure === "blocked") sawBlocked = true;
      else if (failure.failure === "unreadable") sawUnreadable = true;
      else {
        recoverable = true;
        if (reader.budgetKey && (failure.failure === "rate_limited" || failure.failure === "outage")) {
          const until = await startCooldown(env, reader.budgetKey, failure.retryAfterMs);
          earliestRetry = earliestRetry === null ? until : Math.min(earliestRetry, until);
        }
      }
      notes.push(`${reader.id}: ${failure.message}`);
    }
  }

  const detail = notes.join("; ");
  if (recoverable) {
    return { kind: "interrupted", reason: `no reader could complete the page read right now (${detail})`, ...(earliestRetry !== null ? { retry_at: new Date(earliestRetry).toISOString() } : {}) };
  }
  if (sawBlocked) return { kind: "blocked_by_site", reason: detail };
  if (sawUnreadable) return { kind: "empty_page", reason: detail };
  return { kind: "provider_unavailable", reason: detail || "no eligible reader can take the request" };
}
