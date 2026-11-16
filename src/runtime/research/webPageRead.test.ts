import test from "node:test";
import assert from "node:assert";
import { htmlToText, readWebPage, unsafeUrlReason, PAGE_READ_DAILY_LIMIT } from "./webPageRead";
import { AccessDeniedError, discoveryCronContext } from "../../access";
import { readMonthlyUsage } from "./searchProviders";

// The Web page read Tool against its canonical specification (ENIG HQ / 6.
// Tools > Web page read, Martin 15 Nov 2026). Each test names the rule.

const CTX = discoveryCronContext();
const LONG = "Ghanaian SMEs describe positioning problems in their own words. ".repeat(10);
const HTML = `<html><head><title>SME positioning</title><script>var x=1;</script></head><body><nav>Menu</nav><p>${LONG}</p><footer>Footer</footer></body></html>`;

function memoryKv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
}

function env(extra: Record<string, unknown> = {}) {
  return { STATE_KV: memoryKv(), ...extra } as any;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function withFetch<T>(handler: Handler, fn: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    return handler(String(input), init);
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = original;
  }
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

// --- SSRF guard ---

test("SSRF: private, loopback, link-local, metadata and internal hosts are refused before any request", async () => {
  for (const url of [
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    "http://2130706433/",
    "ftp://example.org/file",
    "http://example.org:8080/",
    "http://user:pass@example.org/",
  ]) {
    assert.ok(unsafeUrlReason(url), `${url} must be refused`);
    const { result, urls } = await withFetch(() => html(HTML), () => readWebPage(env(), { url }, CTX));
    assert.strictEqual(result.kind, "invalid_input", url);
    assert.deepStrictEqual(urls, [], `${url}: no request may be made`);
  }
  assert.strictEqual(unsafeUrlReason("https://example.org/page"), null);
});

test("SSRF: a redirect to a private address is refused at that hop, and never followed", async () => {
  const { result, urls } = await withFetch(
    (url) => (url.startsWith("https://example.org") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }) : html(HTML)),
    () => readWebPage(env(), { url: "https://example.org/start" }, CTX),
  );
  assert.strictEqual(result.kind, "provider_failure");
  assert.deepStrictEqual(urls, ["https://example.org/start"]);
});

test("a public redirect is followed and the final URL kept alongside the requested one", async () => {
  const { result } = await withFetch(
    (url) => (url.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "/new" } }) : html(HTML)),
    () => readWebPage(env(), { url: "https://example.org/old" }, CTX),
  );
  assert.strictEqual(result.kind, "success");
  if (result.kind !== "success") return;
  assert.strictEqual(result.result.url, "https://example.org/old");
  assert.strictEqual(result.result.final_url, "https://example.org/new");
});

test("a URL carrying identity terms is refused, never silently rewritten", async () => {
  const { result, urls } = await withFetch(() => html(HTML), () => readWebPage(env(), { url: "https://example.org/?q=ENIG+consultancy" }, CTX));
  assert.strictEqual(result.kind, "invalid_input");
  assert.deepStrictEqual(urls, []);
});

test("invalid input: unknown parameters and out-of-range max_characters are rejected with no request", async () => {
  const a = await withFetch(() => html(HTML), () => readWebPage(env(), { url: "https://example.org/", extra: 1 } as any, CTX));
  const b = await withFetch(() => html(HTML), () => readWebPage(env(), { url: "https://example.org/", max_characters: 999999 }, CTX));
  assert.strictEqual(a.result.kind, "invalid_input");
  assert.strictEqual(b.result.kind, "invalid_input");
  assert.deepStrictEqual([...a.urls, ...b.urls], []);
});

// --- Access ---

test("an Access denial throws before any request (the distinct denied outcome)", async () => {
  const { urls } = await withFetch(() => html(HTML), async () => {
    await assert.rejects(() => readWebPage(env(), { url: "https://example.org/" }, { kind: "work_session", workId: "w-x" } as any), AccessDeniedError);
  });
  assert.deepStrictEqual(urls, []);
});

// --- Normalized result and text bounds ---

test("direct fetch returns bounded plain text without scripts or navigation, attributed to direct_fetch", async () => {
  const { result } = await withFetch(() => html(HTML), () => readWebPage(env(), { url: "https://example.org/a", max_characters: 300 }, CTX));
  assert.strictEqual(result.kind, "success");
  if (result.kind !== "success") return;
  assert.strictEqual(result.result.provider, "direct_fetch");
  assert.strictEqual(result.result.title, "SME positioning");
  assert.ok(!result.result.text.includes("var x"));
  assert.ok(!result.result.text.includes("Menu"));
  assert.ok(result.result.text.length <= 303);
  assert.ok(result.result.retrieved_at);
});

test("htmlToText decodes entities and keeps paragraph breaks", () => {
  const { text } = htmlToText("<p>A &amp; B</p><p>C&#39;s &lt;tag&gt;</p>");
  assert.strictEqual(text, "A & B\nC's <tag>");
});

// --- Fallback order ---

test("a script-only page falls back to Jina when enabled and keyed", async () => {
  const e = env({ JINA_API_KEY: "j", PAGE_READ_FALLBACK_READERS: "jina_reader,tavily_extract" });
  const { result, urls } = await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? new Response(JSON.stringify({ data: { title: "T", url: "https://spa.example/", content: LONG } })) : html("<html><body><div id=app></div></body></html>")),
    () => readWebPage(e, { url: "https://spa.example/" }, CTX),
  );
  assert.strictEqual(result.kind, "success");
  if (result.kind === "success") assert.strictEqual(result.result.provider, "jina_reader");
  assert.ok(urls[1].startsWith("https://r.jina.ai/"));
});

test("a site that blocks automated reading falls back; Tavily Extract is last and draws on Tavily's one budget", async () => {
  const e = env({ TAVILY_API_KEY: "t", PAGE_READ_FALLBACK_READERS: "tavily_extract" });
  const { result } = await withFetch(
    (url) => (url.includes("api.tavily.com/extract") ? new Response(JSON.stringify({ results: [{ url: "https://blocked.example/", raw_content: LONG }] })) : html("forbidden", 403)),
    () => readWebPage(e, { url: "https://blocked.example/" }, CTX),
  );
  assert.strictEqual(result.kind, "success");
  if (result.kind === "success") assert.strictEqual(result.result.provider, "tavily_extract");
  assert.strictEqual(await readMonthlyUsage(e, "tavily"), 1, "counted against Tavily's shared monthly budget");
});

test("fallback readers are used only when explicitly enabled: a key alone enables nothing", async () => {
  const e = env({ JINA_API_KEY: "j", TAVILY_API_KEY: "t" });
  const { result, urls } = await withFetch(() => html("forbidden", 403), () => readWebPage(e, { url: "https://blocked.example/" }, CTX));
  assert.strictEqual(result.kind, "blocked_by_site");
  assert.strictEqual(urls.length, 1);
});

test("a missing page (404) is provider_failure and does not fall back", async () => {
  const e = env({ JINA_API_KEY: "j", PAGE_READ_FALLBACK_READERS: "jina_reader" });
  const { result, urls } = await withFetch(() => html("nope", 404), () => readWebPage(e, { url: "https://example.org/missing" }, CTX));
  assert.strictEqual(result.kind, "provider_failure");
  assert.strictEqual(urls.length, 1);
});

test("an empty page from every reader is empty_page -- never a success", async () => {
  const { result } = await withFetch(() => html("<html><body></body></html>"), () => readWebPage(env(), { url: "https://example.org/" }, CTX));
  assert.strictEqual(result.kind, "empty_page");
});

test("a rate-limited fallback cools down and the read is interrupted with a retry time", async () => {
  const e = env({ JINA_API_KEY: "j", PAGE_READ_FALLBACK_READERS: "jina_reader" });
  const { result } = await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? new Response("", { status: 429, headers: { "retry-after": "30" } }) : html("<html><body></body></html>", 503)),
    () => readWebPage(e, { url: "https://example.org/" }, CTX),
  );
  assert.strictEqual(result.kind, "interrupted");
  if (result.kind === "interrupted") assert.ok(result.retry_at);
});

// --- Budgets, allowance and cache ---

test("a fallback reader whose monthly budget is used is skipped, and the request is never made", async () => {
  const e = env({ JINA_API_KEY: "j", PAGE_READ_FALLBACK_READERS: "jina_reader", PAGE_READ_MONTHLY_BUDGET_JINA: "1" });
  e.STATE_KV.store.set(`search_provider_usage:jina_reader:${new Date().toISOString().slice(0, 7)}`, "1");
  const { result, urls } = await withFetch(() => html("forbidden", 403), () => readWebPage(e, { url: "https://blocked.example/" }, CTX));
  assert.strictEqual(result.kind, "blocked_by_site");
  assert.ok(!urls.some((u) => u.includes("jina")));
});

test("ENIG's daily page-read allowance stops reads before any reader is tried, with fallbacks enabled", async () => {
  const e = env({ JINA_API_KEY: "j", PAGE_READ_FALLBACK_READERS: "jina_reader" });
  e.STATE_KV.store.set(`web_page_read_count:${new Date().toISOString().slice(0, 10)}`, String(PAGE_READ_DAILY_LIMIT));
  const { result, urls } = await withFetch(() => html(HTML), () => readWebPage(e, { url: "https://example.org/" }, CTX));
  assert.strictEqual(result.kind, "internal_allowance_exhausted");
  assert.deepStrictEqual(urls, []);
});

test("a page read within 7 days is served from cache: no request, no allowance used", async () => {
  const e = env();
  await withFetch(() => html(HTML), () => readWebPage(e, { url: "https://example.org/c" }, CTX));
  const day = `web_page_read_count:${new Date().toISOString().slice(0, 10)}`;
  const usedBefore = e.STATE_KV.store.get(day);
  const { result, urls } = await withFetch(() => html(HTML), () => readWebPage(e, { url: "https://example.org/c" }, CTX));
  assert.strictEqual(result.kind, "success");
  assert.deepStrictEqual(urls, []);
  assert.strictEqual(e.STATE_KV.store.get(day), usedBefore);
});
