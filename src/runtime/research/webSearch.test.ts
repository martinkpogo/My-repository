import test from "node:test";
import assert from "node:assert";
import {
  ACTIVE_SEARCH_PROVIDER,
  assessDimensionCoverage,
  executeSearch,
  extractDomain,
  formatDimensionEvidenceForContext,
  formatFailedSearchesWarning,
  formatUncoveredDimensionsWarning,
  gatherDimensionEvidence,
  isWebSearchConfigured,
} from "./webSearch";
import type { DimensionEvidence, SearchRequest } from "./webSearch";
import { AccessDeniedError, discoveryCronContext, workSessionContext, EXTERNAL_EGRESS_TARGET, evaluateAccess, type AccessContext } from "../../access";

/** Calls the egress rule directly, so the refusal is proven at the boundary and not only through executeSearch's read path. */
function evaluateAccessForTest(env: any, operation: "read" | "create" | "update", access: AccessContext): void {
  evaluateAccess(env, { operation, dataSourceId: EXTERNAL_EGRESS_TARGET }, access);
}

/**
 * The Kernel's own discovery loop, which is how the LGS cron searches.
 * An outbound read with no Unit Action behind it.
 */
const KERNEL_SEARCH: AccessContext = discoveryCronContext();

/** A Work item whose Action permits reading (`research_opportunity` is declared `read`), which is how a Work-owned search is authorized. */
const WORK_SEARCH: AccessContext = workSessionContext({
  workId: "work-websearch",
  chatId: 9999,
  unit: "Business Development",
  hat: "Business Development Manager",
  actionName: "research_opportunity",
  stage: "researching",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** Swaps global fetch for the duration of `fn`, always restoring the original. */
async function withMockFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const configuredEnv = { TAVILY_API_KEY: "key" } as any;

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test("isWebSearchConfigured is false when no API key is set, true when one is", () => {
  assert.strictEqual(isWebSearchConfigured({} as any), false);
  assert.strictEqual(isWebSearchConfigured({ TAVILY_API_KEY: "key" } as any), true);
});

test("provider selection is trusted runtime configuration: tavily is the only enabled provider", () => {
  assert.strictEqual(ACTIVE_SEARCH_PROVIDER, "tavily");
});

// --- Outcome: provider_unavailable ---

test("executeSearch reports provider_unavailable (never an empty success) when no API key is configured -- no fetch, no throw", async () => {
  let called = 0;
  const outcome = await withMockFetch(
    async () => {
      called++;
      return okJson({ results: [] });
    },
    () => executeSearch({} as any, { query: "some query" }, KERNEL_SEARCH),
  );
  assert.strictEqual(outcome.kind, "provider_unavailable");
  assert.strictEqual(called, 0, "an unconfigured provider must make no provider request");
});

test("gatherDimensionEvidence records provider_unavailable per dimension when search isn't configured -- never empty 'success'", async () => {
  const plan = [
    { protocol: "market_industry" as const, subQuestion: "What is the market size for X?" },
    { protocol: "competitive" as const, subQuestion: "Who are the named competitors in X?" },
  ];
  const evidence = await gatherDimensionEvidence({} as any, plan, KERNEL_SEARCH);
  assert.strictEqual(evidence.length, 2);
  assert.strictEqual(evidence[0].searchOutcome, "provider_unavailable");
  assert.strictEqual(evidence[1].searchOutcome, "provider_unavailable");
  assert.deepStrictEqual(evidence[0].results, []);
  assert.deepStrictEqual(evidence[1].results, []);
  assert.strictEqual(evidence[0].subQuestion, plan[0].subQuestion);
});

// --- Distinct denial (never a provider outcome) ---

test("executeSearch refuses to disclose a query when the context is a Work that records no Action -- a read of ENIG's own records is not authority to send one to a third party", async () => {
  let called = 0;
  await withMockFetch(
    async () => {
      called++;
      return okJson({ results: [] });
    },
    async () => {
      // workSessionReadContext carries no Action: correct for a read of ENIG's
      // own records, and explicitly NOT authority for an outbound disclosure.
      await assert.rejects(
        () => executeSearch(configuredEnv, { query: "a query" }, { kind: "work_session", workId: "work-x" }),
        (err: unknown) =>
          err instanceof AccessDeniedError && /outbound read|no Action|Unit Action/.test(String((err as Error).message)),
        "an action-less Work must not be able to disclose a query externally -- denial stays a distinct AccessDeniedError, never an ordinary outcome",
      );
      assert.strictEqual(called, 0, "the request must be refused BEFORE it leaves the runtime");
    },
  );
});

test("An outbound create is refused outright -- no registered Action authorizes changing remote state, under any context", () => {
  const env = { TAVILY_API_KEY: "key" } as any;
  // Even a Kernel-owned context and even an approval-gated Work Action are
  // refused: there is no Action anywhere that answers "change external state",
  // and admitting one on the strength of a read Action is exactly the
  // authority-laundering this boundary exists to prevent.
  assert.throws(() => evaluateAccessForTest(env, "create", KERNEL_SEARCH), /outbound create/);
  assert.throws(() => evaluateAccessForTest(env, "update", KERNEL_SEARCH), /outbound update/);
  assert.throws(() => evaluateAccessForTest(env, "create", WORK_SEARCH), /outbound create/);
});

test("A Unit Work whose Action permits reading may search -- a Work-owned search path, and the refusal above is specific to contexts that do not", async () => {
  let called = 0;
  const outcome = await withMockFetch(
    async () => {
      called++;
      return okJson({ results: [{ title: "T", url: "https://example.com", content: "c" }] });
    },
    () => executeSearch(configuredEnv, { query: "a query" }, WORK_SEARCH),
  );
  assert.strictEqual(called, 1, "a Work with a read-permitting Action must be able to search");
  assert.strictEqual(outcome.kind, "success_with_results");
  assert.strictEqual(outcome.kind === "success_with_results" ? outcome.results.length : 0, 1);
});

// --- Outcome: success_with_results (normalization contract) ---

test("success normalizes to the shared contract shape: provider attribution, retrieved_at, preserved URL, capped snippet, provider-supplied publication date only", async () => {
  const oversized = "x".repeat(5000);
  const outcome = await withMockFetch(
    async () =>
      okJson({
        results: [
          { title: "T", url: "https://example.com/report?x=1", content: oversized, published_date: "2026-01-01" },
          { title: "No date", url: "https://example.org/other", content: "c" },
        ],
      }),
    () => executeSearch(configuredEnv, { query: "some query" }, KERNEL_SEARCH),
  );
  assert.strictEqual(outcome.kind, "success_with_results");
  if (outcome.kind !== "success_with_results") return;
  const [first, second] = outcome.results;
  assert.strictEqual(first.provider, ACTIVE_SEARCH_PROVIDER, "every result is attributed to its provider");
  assert.ok(!Number.isNaN(Date.parse(first.retrieved_at)), "retrieved_at must be an ISO-8601 timestamp");
  assert.strictEqual(first.url, "https://example.com/report?x=1", "the source URL is preserved exactly as supplied");
  assert.strictEqual(first.published_at, "2026-01-01", "a provider-supplied publication date is carried through");
  assert.ok(first.snippet.length < oversized.length, "snippet must be bounded -- confirmed live root cause: Tavily's unbounded content field pushed synthesis prompts to ~18,000 tokens");
  assert.ok(first.snippet.endsWith("..."));
  assert.strictEqual(second.published_at, undefined, "a missing publication date stays missing -- never invented");
});

test("normalization drops entries that are not objects with an absolute http(s) URL -- no invalid urls reach callers", async () => {
  const outcome = await withMockFetch(
    async () =>
      okJson({
        results: [
          { title: "Valid", url: "https://example.com/ok", content: "c" },
          { title: "No URL" },
          { title: "Bad scheme", url: "javascript:alert(1)" },
          { title: "Relative", url: "/not/absolute" },
          "not an object",
          { title: "Also valid", url: "http://example.org/plain", content: "d" },
        ],
      }),
    () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH),
  );
  assert.strictEqual(outcome.kind, "success_with_results");
  if (outcome.kind !== "success_with_results") return;
  assert.deepStrictEqual(
    outcome.results.map((r) => r.url),
    ["https://example.com/ok", "http://example.org/plain"],
  );
});

test("normalization bounds the result count to the requested max_results", async () => {
  const outcome = await withMockFetch(
    async () =>
      okJson({
        results: [
          { title: "1", url: "https://example.com/1", content: "a" },
          { title: "2", url: "https://example.com/2", content: "b" },
          { title: "3", url: "https://example.com/3", content: "c" },
        ],
      }),
    () => executeSearch(configuredEnv, { query: "q", max_results: 1 }, KERNEL_SEARCH),
  );
  assert.strictEqual(outcome.kind, "success_with_results");
  if (outcome.kind !== "success_with_results") return;
  assert.strictEqual(outcome.results.length, 1);
});

// --- Outcome: success_no_results ---

test("executeSearch reports success_no_results for a successful search that returned no results", async () => {
  const outcome = await withMockFetch(async () => okJson({ results: [] }), () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(outcome.kind, "success_no_results");
});

test("a successful response whose entries are all invalid urls is success_no_results -- provider failure and empty results stay distinguishable", async () => {
  const outcome = await withMockFetch(async () => okJson({ results: [{ title: "No URL" }] }), () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(outcome.kind, "success_no_results");
});

// --- Outcome: provider_failure ---

test("a network error during the provider request is provider_failure -- never reported as no results", async () => {
  const outcome = await withMockFetch(
    async () => {
      throw new Error("network down");
    },
    () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH),
  );
  assert.strictEqual(outcome.kind, "provider_failure");
});

test("a non-2xx provider status is provider_failure", async () => {
  const outcome = await withMockFetch(async () => new Response("rate limited", { status: 429 }), () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(outcome.kind, "provider_failure");
});

test("malformed provider JSON is provider_failure", async () => {
  const outcome = await withMockFetch(async () => new Response("<html>not json</html>", { status: 200 }), () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(outcome.kind, "provider_failure");
});

test("a structurally malformed provider response (no results array) is provider_failure", async () => {
  const outcome = await withMockFetch(async () => okJson({ unexpected: true }), () => executeSearch(configuredEnv, { query: "q" }, KERNEL_SEARCH));
  assert.strictEqual(outcome.kind, "provider_failure");
});

// --- Outcome: invalid_input (validation before any request, before Access) ---

test("invalid input is rejected as invalid_input with no provider request and no Access evaluation -- never silently repaired", async () => {
  const cases: SearchRequest[] = [
    { query: "" },
    { query: "   " },
    { query: "q", topic: "finance" },
    { query: "q", date_range: { start: "2026-01-01", end: "2026-02-01" } },
    { query: "q", max_results: 0 },
    { query: "q", max_results: 21 },
    { query: "q", max_results: 1.5 },
    { query: "q", include_domains: [] },
    { query: "q", include_domains: [""] },
    { query: "q", exclude_domains: ["not a domain "] },
    { query: "q", provider: "google" } as unknown as SearchRequest,
  ];
  for (const request of cases) {
    let called = 0;
    // Denied context proves validation runs BEFORE Access too: an invalid
    // invocation fails contract validation, not as a denial.
    const outcome = await withMockFetch(
      async () => {
        called++;
        return okJson({ results: [] });
      },
      () => executeSearch(configuredEnv, request, { kind: "work_session", workId: "work-x" }),
    );
    assert.strictEqual(outcome.kind, "invalid_input", `expected invalid_input for ${JSON.stringify(request)}`);
    assert.strictEqual(called, 0, `no provider request may be made for ${JSON.stringify(request)}`);
  }
});

test("unsupported filters are rejected explicitly -- the Tavily adapter cannot honestly apply date_range, so it says so instead of dropping it", async () => {
  const outcome = await withMockFetch(async () => okJson({ results: [] }), () => executeSearch(configuredEnv, { query: "q", date_range: {} }, KERNEL_SEARCH));
  assert.strictEqual(outcome.kind, "invalid_input");
  assert.ok(outcome.kind === "invalid_input" && /not supported/.test(outcome.reason), "the reason must name the unsupported filter");
});

test("supported filters are translated into the Tavily request; defaults stay bounded", async () => {
  const bodies: any[] = [];
  await withMockFetch(
    async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return okJson({ results: [] });
    },
    async () => {
      await executeSearch(configuredEnv, { query: "  q  " }, KERNEL_SEARCH);
      await executeSearch(
        configuredEnv,
        { query: "news q", topic: "news", max_results: 5, include_domains: ["example.com"], exclude_domains: ["spam.org"] },
        KERNEL_SEARCH,
      );
    },
  );
  assert.strictEqual(bodies[0].max_results, 3, "default result bound preserved");
  assert.strictEqual(bodies[0].search_depth, "basic");
  assert.strictEqual(bodies[0].query, "q", "incidental whitespace is trimmed, not rejected");
  assert.strictEqual(bodies[1].topic, "news");
  assert.strictEqual(bodies[1].max_results, 5);
  assert.deepStrictEqual(bodies[1].include_domains, ["example.com"]);
  assert.deepStrictEqual(bodies[1].exclude_domains, ["spam.org"]);
  assert.ok(typeof bodies[0].api_key === "string" && bodies[0].api_key.length > 0, "credentials are attached only by the adapter");
});

// --- extractDomain ---

test("extractDomain strips the protocol and www prefix", () => {
  assert.strictEqual(extractDomain("https://www.example.com/report?x=1"), "example.com");
  assert.strictEqual(extractDomain("https://gso.gov.gh/stats"), "gso.gov.gh");
});

test("extractDomain falls back to the raw string for a malformed URL rather than throwing", () => {
  assert.strictEqual(extractDomain("not a url"), "not a url");
});

// --- Dimension evidence + coverage buckets ---

function withResults(protocol: DimensionEvidence["protocol"], subQuestion: string, count: number, searchOutcome: DimensionEvidence["searchOutcome"] = count > 0 ? "success_with_results" : "success_no_results"): DimensionEvidence {
  return {
    protocol,
    subQuestion,
    searchOutcome,
    results: Array.from({ length: count }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      snippet: `Snippet ${i}`,
      provider: ACTIVE_SEARCH_PROVIDER,
      retrieved_at: "2026-01-01T00:00:00.000Z",
      published_at: "2026-01-01",
    })),
  };
}

test("assessDimensionCoverage splits dimensions into covered, uncovered (searched, empty), and failed (search never succeeded)", () => {
  const dims: DimensionEvidence[] = [
    withResults("market_industry", "Q1", 2),
    withResults("competitive", "Q2", 0),
    withResults("customer_audience", "Q3", 0, "provider_failure"),
    withResults("environmental_regulatory", "Q4", 0, "provider_unavailable"),
  ];
  const { covered, uncovered, failed } = assessDimensionCoverage(dims);
  assert.strictEqual(covered.length, 1);
  assert.strictEqual(uncovered.length, 1);
  assert.strictEqual(failed.length, 2, "a failed search is never counted as an empty successful one");
  assert.strictEqual(covered[0].subQuestion, "Q1");
  assert.strictEqual(uncovered[0].subQuestion, "Q2");
  assert.deepStrictEqual(
    failed.map((d) => d.subQuestion),
    ["Q3", "Q4"],
  );
});

test("gatherDimensionEvidence records each dimension's own search outcome alongside its results", async () => {
  const outcome = await withMockFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return String(body.query).includes("empty") ? okJson({ results: [] }) : okJson({ results: [{ title: "T", url: "https://example.com/x", content: "c" }] });
    },
    () =>
      gatherDimensionEvidence(
        configuredEnv,
        [
          { protocol: "market_industry" as const, subQuestion: "Market size?" },
          { protocol: "competitive" as const, subQuestion: "empty results question" },
        ],
        KERNEL_SEARCH,
      ),
  );
  assert.strictEqual(outcome[0].searchOutcome, "success_with_results");
  assert.strictEqual(outcome[0].results.length, 1);
  assert.strictEqual(outcome[1].searchOutcome, "success_no_results");
  assert.deepStrictEqual(outcome[1].results, []);
});

test("gatherDimensionEvidence records provider_failure per dimension on a failed request -- the dimension is failed, not empty", async () => {
  const evidence = await withMockFetch(
    async () => {
      throw new Error("provider exploded");
    },
    () =>
      gatherDimensionEvidence(configuredEnv, [{ protocol: "competitive" as const, subQuestion: "Who are the competitors?" }], KERNEL_SEARCH),
  );
  assert.strictEqual(evidence[0].searchOutcome, "provider_failure");
  assert.deepStrictEqual(evidence[0].results, []);
  const { covered, uncovered, failed } = assessDimensionCoverage(evidence);
  assert.strictEqual(covered.length, 0);
  assert.strictEqual(uncovered.length, 0, "a provider failure must NOT land in the 'searched but empty' bucket");
  assert.strictEqual(failed.length, 1);
});

// --- Context formatting + limitation warnings ---

test("formatDimensionEvidenceForContext groups results by protocol and dimension, retaining domain and date", () => {
  const dims: DimensionEvidence[] = [withResults("market_industry", "What is the market size?", 1)];
  const formatted = formatDimensionEvidenceForContext(dims);
  assert.ok(formatted.includes("Market / Industry Research"));
  assert.ok(formatted.includes("What is the market size?"));
  assert.ok(formatted.includes("https://example.com/0"));
  assert.ok(formatted.includes("example.com"));
  assert.ok(formatted.includes("2026-01-01"));
});

test("formatDimensionEvidenceForContext excludes dimensions with zero results", () => {
  const dims: DimensionEvidence[] = [withResults("market_industry", "Covered", 1), withResults("competitive", "Uncovered", 0)];
  const formatted = formatDimensionEvidenceForContext(dims);
  assert.ok(formatted.includes("Covered"));
  assert.ok(!formatted.includes("Uncovered"));
});

test("formatDimensionEvidenceForContext returns an empty string when nothing has results", () => {
  assert.strictEqual(formatDimensionEvidenceForContext([withResults("market_industry", "Q", 0)]), "");
});

test("formatUncoveredDimensionsWarning is empty when everything was covered", () => {
  assert.strictEqual(formatUncoveredDimensionsWarning([]), "");
});

test("formatUncoveredDimensionsWarning names each uncovered dimension and instructs it must become a Limitation -- this is the 'missing evidence becomes a limitation' mechanism", () => {
  const uncovered: DimensionEvidence[] = [withResults("environmental_regulatory", "What regulations apply?", 0)];
  const warning = formatUncoveredDimensionsWarning(uncovered);
  assert.ok(warning.includes("What regulations apply?"));
  assert.ok(warning.includes("Environmental / Regulatory Research"));
  assert.ok(warning.toLowerCase().includes("limitation"));
});

test("formatFailedSearchesWarning is empty when no search failed", () => {
  assert.strictEqual(formatFailedSearchesWarning([]), "");
});

test("formatFailedSearchesWarning names failed dimensions, their outcome, and states provider failure is NOT evidence of absence", () => {
  const failed: DimensionEvidence[] = [
    withResults("market_industry", "What is the market size?", 0, "provider_failure"),
    withResults("competitive", "Who are the competitors?", 0, "provider_unavailable"),
  ];
  const warning = formatFailedSearchesWarning(failed);
  assert.ok(warning.includes("What is the market size?"));
  assert.ok(warning.includes("provider_failure"));
  assert.ok(warning.includes("provider_unavailable"));
  assert.ok(warning.includes("NOT evidence that no information exists"));
  assert.ok(warning.toLowerCase().includes("limitation"));
  assert.strictEqual(formatUncoveredDimensionsWarning(failed), "", "failed dimensions are never reported as 'no evidence found'");
});

// --- concurrency + identity boundary stay executor-owned ---

test("gatherDimensionEvidence runs independent dimension searches concurrently -- Promise.all semantics preserved, never serialized", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withMockFetch(
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return okJson({ results: [{ title: "T", url: "https://example.com/r", content: "c" }] });
    },
    async () => {
      const plan = [
        { protocol: "market_industry" as const, subQuestion: "Market structure?" },
        { protocol: "competitive" as const, subQuestion: "Named competitors?" },
        { protocol: "customer_audience" as const, subQuestion: "Customer pain points?" },
        { protocol: "environmental_regulatory" as const, subQuestion: "Applicable regulations?" },
      ];
      const evidence = await gatherDimensionEvidence(configuredEnv, plan, KERNEL_SEARCH);
      assert.strictEqual(evidence.length, 4);
      assert.ok(maxInFlight > 1, `independent searches must overlap (max in-flight was ${maxInFlight})`);
    },
  );
});

test("gatherDimensionEvidence redacts identity terms from every outbound query -- token/privacy boundary intact at the research runtime's search edge", async () => {
  const queries: string[] = [];
  await withMockFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      queries.push(String(body.query ?? ""));
      return okJson({ results: [] });
    },
    async () => {
      const plan = [{ protocol: "market_industry" as const, subQuestion: "What is ENIG's market position in Ghana, Martin?" }];
      await gatherDimensionEvidence(configuredEnv, plan, KERNEL_SEARCH);
    },
  );

  assert.strictEqual(queries.length, 1);
  assert.ok(!queries[0].includes("ENIG"), `identity must not leave the runtime: ${queries[0]}`);
  assert.ok(!queries[0].includes("Martin"), `identity must not leave the runtime: ${queries[0]}`);
  assert.ok(queries[0].includes("the business"), "the canonical redaction replacement must be applied");
});
