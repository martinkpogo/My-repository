import test from "node:test";
import assert from "node:assert";
import { executeSearch } from "./webSearch";
import {
  COOLDOWN_STEPS_MS,
  classifyHttpFailure,
  configuredProviderChain,
  cooldownUntil,
  enabledFallbackProviders,
  monthlyBudget,
  parseRetryAfterMs,
  readMonthlyUsage,
  startCooldown,
} from "./searchProviders";
import { AccessDeniedError, discoveryCronContext } from "../../access";

// Provider fallback, budgets and cooldowns for the shared Search Tool
// (BD-15, issue #338; canonical Search specification, provider_policy and
// recovery). Each test names the contract rule it proves.

const KERNEL_SEARCH = discoveryCronContext();

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
}

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** Routes the mocked fetch by provider host and records which providers were asked. */
async function withProviders<T>(handlers: Partial<Record<"tavily" | "exa" | "serper", () => Response | Promise<Response>>>, fn: () => Promise<T>) {
  const called: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const provider = url.includes("tavily") ? "tavily" : url.includes("exa.ai") ? "exa" : url.includes("serper") ? "serper" : "other";
    called.push(provider);
    const handler = (handlers as Record<string, (() => Response | Promise<Response>) | undefined>)[provider];
    if (!handler) throw new Error(`unexpected request to ${provider}`);
    return handler();
  }) as typeof fetch;
  try {
    return { result: await fn(), called };
  } finally {
    globalThis.fetch = original;
  }
}

function fullEnv(overrides: Record<string, unknown> = {}) {
  return {
    TAVILY_API_KEY: "t",
    EXA_API_KEY: "e",
    SERPER_API_KEY: "s",
    SEARCH_FALLBACK_PROVIDERS: "exa,serper",
    SEARCH_MONTHLY_BUDGET_EXA: "100",
    STATE_KV: memoryKv(),
    ...overrides,
  } as any;
}

const TAVILY_OK = () => okJson({ results: [{ title: "T", url: "https://tavily.example/a", content: "tavily text", published_date: "2026-11-01" }] });
const EXA_OK = () => okJson({ results: [{ title: "E", url: "https://exa.example/a", highlights: ["first", "second"], publishedDate: "2026-10-01T00:00:00.000Z" }] });
const SERPER_OK = () => okJson({ organic: [{ title: "S", link: "https://serper.example/a", snippet: "serper text", date: "3 days ago" }] });

// --- Trusted configuration ---

test("fallbacks are used only when explicitly enabled: a fallback key alone enables nothing (require_explicit_enablement)", () => {
  assert.deepStrictEqual(enabledFallbackProviders({ EXA_API_KEY: "e" } as any), []);
  assert.deepStrictEqual(configuredProviderChain({ TAVILY_API_KEY: "t", EXA_API_KEY: "e" } as any).map((a) => a.id), ["tavily"]);
});

test("the enablement list is ordered by the approved order, ignores unknown names and the primary, and needs each key", () => {
  assert.deepStrictEqual(enabledFallbackProviders({ SEARCH_FALLBACK_PROVIDERS: "serper, brave, tavily, EXA" } as any), ["exa", "serper"]);
  assert.deepStrictEqual(
    configuredProviderChain({ TAVILY_API_KEY: "t", SERPER_API_KEY: "s", SEARCH_FALLBACK_PROVIDERS: "exa,serper" } as any).map((a) => a.id),
    ["tavily", "serper"],
    "Exa is enabled but has no key, so it is not in the chain",
  );
});

test("monthly budgets: Tavily and Serper have defaults below their free allowance; Exa has none until configured", () => {
  assert.strictEqual(monthlyBudget({} as any, "tavily"), 950);
  assert.strictEqual(monthlyBudget({} as any, "serper"), 200);
  assert.strictEqual(monthlyBudget({} as any, "exa"), null);
  assert.strictEqual(monthlyBudget({ SEARCH_MONTHLY_BUDGET_EXA: "300" } as any, "exa"), 300);
  assert.strictEqual(monthlyBudget({ SEARCH_MONTHLY_BUDGET_TAVILY: "nonsense" } as any, "tavily"), null, "an unusable configured budget fails closed");
});

// --- Fallback on each recoverable failure class ---

for (const [label, failing] of [
  ["a rate limit (429)", () => new Response("slow down", { status: 429 })],
  ["an outage (503)", () => new Response("down", { status: 503 })],
  ["a malformed response", () => new Response("<html>", { status: 200 })],
  ["a network error", () => Promise.reject(new Error("socket hang up"))],
] as const) {
  test(`recoverable ${label} on Tavily falls back to Exa, and the result is attributed to Exa`, async () => {
    const env = fullEnv();
    const { result, called } = await withProviders({ tavily: failing, exa: EXA_OK }, () => executeSearch(env, { query: "positioning problems" }, KERNEL_SEARCH));
    assert.deepStrictEqual(called, ["tavily", "exa"]);
    assert.strictEqual(result.kind, "success_with_results");
    if (result.kind !== "success_with_results") return;
    assert.strictEqual(result.results[0].provider, "exa");
    assert.strictEqual(result.results[0].url, "https://exa.example/a");
    assert.strictEqual(result.results[0].snippet, "first ... second");
  });
}

test("a rate limit puts the provider into cooldown, so the next search goes straight to the fallback", async () => {
  const env = fullEnv();
  await withProviders({ tavily: () => new Response("", { status: 429 }), exa: EXA_OK }, () => executeSearch(env, { query: "q one" }, KERNEL_SEARCH));
  assert.ok((await cooldownUntil(env, "tavily")) !== null);
  const { called } = await withProviders({ exa: EXA_OK }, () => executeSearch(env, { query: "q two" }, KERNEL_SEARCH));
  assert.deepStrictEqual(called, ["exa"], "a cooling provider is skipped, not hammered");
});

test("Serper is reached when Tavily and Exa both fail recoverably; its relative dates are never converted", async () => {
  const env = fullEnv();
  const { result, called } = await withProviders(
    { tavily: () => new Response("", { status: 503 }), exa: () => new Response("", { status: 429 }), serper: SERPER_OK },
    () => executeSearch(env, { query: "q" }, KERNEL_SEARCH),
  );
  assert.deepStrictEqual(called, ["tavily", "exa", "serper"]);
  assert.strictEqual(result.kind, "success_with_results");
  if (result.kind !== "success_with_results") return;
  assert.strictEqual(result.results[0].provider, "serper");
  assert.strictEqual(result.results[0].url, "https://serper.example/a");
  assert.strictEqual(result.results[0].published_at, undefined, "\"3 days ago\" is not a date the provider supplied in contract form");
});

test("when every eligible provider fails recoverably, the search is interrupted with a retry time -- never an empty success", async () => {
  const env = fullEnv();
  const { result } = await withProviders(
    { tavily: () => new Response("", { status: 429 }), exa: () => new Response("", { status: 503 }), serper: () => new Response("", { status: 429 }) },
    () => executeSearch(env, { query: "q" }, KERNEL_SEARCH),
  );
  assert.strictEqual(result.kind, "interrupted");
  if (result.kind !== "interrupted") return;
  assert.ok(result.retry_at && Date.parse(result.retry_at) > Date.now(), "the earliest cooldown end is reported");
});

// --- What must never trigger fallback ---

test("a refused request (401) on Tavily is provider_failure and does NOT fall back", async () => {
  const env = fullEnv();
  const { result, called } = await withProviders({ tavily: () => new Response("", { status: 401 }), exa: EXA_OK }, () => executeSearch(env, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(result.kind, "provider_failure");
  assert.deepStrictEqual(called, ["tavily"]);
});

test("invalid input makes no provider request at all, with fallbacks enabled (do_not_fallback_on: invalid_input)", async () => {
  const env = fullEnv();
  const { result, called } = await withProviders({ tavily: TAVILY_OK, exa: EXA_OK }, () => executeSearch(env, { query: "   " }, KERNEL_SEARCH));
  assert.strictEqual(result.kind, "invalid_input");
  assert.deepStrictEqual(called, []);
});

test("an Access denial throws before any provider request, with fallbacks enabled (do_not_fallback_on: access_denial)", async () => {
  const env = fullEnv();
  const called: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    called.push(String(input));
    return TAVILY_OK();
  }) as typeof fetch;
  try {
    await assert.rejects(() => executeSearch(env, { query: "q" }, { kind: "work_session", workId: "work-x" } as any), AccessDeniedError);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepStrictEqual(called, []);
});

// --- Budgets ---

test("a provider whose monthly budget is used is skipped; the next one serves the search", async () => {
  const env = fullEnv({ SEARCH_MONTHLY_BUDGET_TAVILY: "2" });
  const month = new Date().toISOString().slice(0, 7);
  env.STATE_KV.store.set(`search_provider_usage:tavily:${month}`, "2");
  const { result, called } = await withProviders({ exa: EXA_OK }, () => executeSearch(env, { query: "q" }, KERNEL_SEARCH));
  assert.deepStrictEqual(called, ["exa"]);
  assert.strictEqual(result.kind, "success_with_results");
});

test("when every provider's budget is used, the search is provider_unavailable -- no request, no charge", async () => {
  const env = fullEnv({ SEARCH_MONTHLY_BUDGET_TAVILY: "1", SEARCH_MONTHLY_BUDGET_EXA: "1", SEARCH_MONTHLY_BUDGET_SERPER: "1" });
  const month = new Date().toISOString().slice(0, 7);
  for (const p of ["tavily", "exa", "serper"]) env.STATE_KV.store.set(`search_provider_usage:${p}:${month}`, "1");
  const { result, called } = await withProviders({}, () => executeSearch(env, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(result.kind, "provider_unavailable");
  assert.deepStrictEqual(called, []);
});

test("every provider request is counted against that provider's month, the failed one included", async () => {
  const env = fullEnv();
  await withProviders({ tavily: () => new Response("", { status: 429 }), exa: EXA_OK }, () => executeSearch(env, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(await readMonthlyUsage(env, "tavily"), 1);
  assert.strictEqual(await readMonthlyUsage(env, "exa"), 1);
  assert.strictEqual(await readMonthlyUsage(env, "serper"), 0);
});

test("Exa enabled with a key but no configured budget is not eligible (fails closed)", async () => {
  const env = fullEnv({ SEARCH_MONTHLY_BUDGET_EXA: undefined });
  const { called } = await withProviders({ tavily: () => new Response("", { status: 429 }), serper: SERPER_OK }, () => executeSearch(env, { query: "q" }, KERNEL_SEARCH));
  assert.deepStrictEqual(called, ["tavily", "serper"]);
});

// --- Filters are never silently dropped ---

test("a fallback that cannot apply a requested filter is skipped, never used with the filter dropped", async () => {
  const env = fullEnv({ SEARCH_FALLBACK_PROVIDERS: "serper" });
  const { result, called } = await withProviders(
    { tavily: () => new Response("", { status: 503 }), serper: SERPER_OK },
    () => executeSearch(env, { query: "q", include_domains: ["example.org"] }, KERNEL_SEARCH),
  );
  assert.deepStrictEqual(called, ["tavily"], "Serper cannot restrict domains, so it is not asked");
  assert.strictEqual(result.kind, "interrupted");
});

// --- Cooldown ladder and failure classes ---

test("cooldown follows the provider's retry-after when given, otherwise the ladder, escalating 1 min, 5 min, 15 min, 1 h and stopping there", async () => {
  const env = { STATE_KV: memoryKv() } as any;
  const t0 = 1_000_000;
  assert.strictEqual((await startCooldown(env, "exa", 30_000, t0)) - t0, 30_000);
  const env2 = { STATE_KV: memoryKv() } as any;
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) waits.push((await startCooldown(env2, "tavily", undefined, t0)) - t0);
  assert.deepStrictEqual(waits, [...COOLDOWN_STEPS_MS, COOLDOWN_STEPS_MS[COOLDOWN_STEPS_MS.length - 1]]);
});

test("a retry-after longer than the last cooldown step is bounded to it (bounded: true, infinite_retry: false)", () => {
  const res = new Response("", { status: 429, headers: { "retry-after": "86400" } });
  assert.strictEqual(parseRetryAfterMs(res), COOLDOWN_STEPS_MS[COOLDOWN_STEPS_MS.length - 1]);
});

test("failure classes: 429 and Tavily's 432/433 are rate limits, 408/5xx outages, other statuses refusals", () => {
  assert.strictEqual(classifyHttpFailure("tavily", new Response("", { status: 432 })).failure, "rate_limited");
  assert.strictEqual(classifyHttpFailure("exa", new Response("", { status: 432 })).failure, "rejected");
  assert.strictEqual(classifyHttpFailure("serper", new Response("", { status: 429 })).failure, "rate_limited");
  assert.strictEqual(classifyHttpFailure("exa", new Response("", { status: 502 })).failure, "outage");
  assert.strictEqual(classifyHttpFailure("exa", new Response("", { status: 408 })).failure, "outage");
  assert.strictEqual(classifyHttpFailure("exa", new Response("", { status: 403 })).failure, "rejected");
});

test("Tavily alone (no fallback enabled) behaves as before: results are attributed to tavily", async () => {
  const env = { TAVILY_API_KEY: "t", STATE_KV: memoryKv() } as any;
  const { result, called } = await withProviders({ tavily: TAVILY_OK }, () => executeSearch(env, { query: "q" }, KERNEL_SEARCH));
  assert.deepStrictEqual(called, ["tavily"]);
  assert.strictEqual(result.kind, "success_with_results");
  if (result.kind !== "success_with_results") return;
  assert.strictEqual(result.results[0].provider, "tavily");
  assert.strictEqual(result.results[0].published_at, "2026-11-01");
});
