import test from "node:test";
import assert from "node:assert";
import {
  assessDimensionCoverage,
  extractDomain,
  formatDimensionEvidenceForContext,
  formatUncoveredDimensionsWarning,
  gatherDimensionEvidence,
  isWebSearchConfigured,
  searchWeb,
} from "./webSearch";
import type { DimensionEvidence } from "./webSearch";
import { discoveryCronContext, workSessionContext, EXTERNAL_EGRESS_TARGET, evaluateAccess, type AccessContext } from "../../access";

/** Calls the egress rule directly, so the refusal is proven at the boundary and not only through searchWeb's read path. */
function evaluateAccessForTest(env: any, operation: "read" | "create" | "update", access: AccessContext): void {
  evaluateAccess(env, { operation, dataSourceId: EXTERNAL_EGRESS_TARGET }, access);
}

/**
 * The Kernel's own discovery loop, which is how the LGS cron searches.
 * An outbound read with no Unit Action behind it.
 */
const KERNEL_SEARCH: AccessContext = discoveryCronContext();

/** An R&I Work item running its own `research` Action, which is how the real research path searches. */
const WORK_SEARCH: AccessContext = workSessionContext({
  workId: "work-websearch",
  chatId: 9999,
  unit: "Research & Intelligence",
  hat: "Research & Intelligence Analyst",
  actionName: "research",
  stage: "researching",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test("isWebSearchConfigured is false when no API key is set, true when one is", () => {
  assert.strictEqual(isWebSearchConfigured({} as any), false);
  assert.strictEqual(isWebSearchConfigured({ TAVILY_API_KEY: "key" } as any), true);
});

test("searchWeb returns [] without throwing when no API key is configured -- graceful degradation to closed-book behavior", async () => {
  const results = await searchWeb({} as any, "some query", KERNEL_SEARCH);
  assert.deepStrictEqual(results, []);
});

test("searchWeb refuses to disclose a query when the context is a Work that records no Action -- a read of ENIG's own records is not authority to send one to a third party", async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    // workSessionReadContext carries no Action: correct for a read of ENIG's
    // own records, and explicitly NOT authority for an outbound disclosure.
    await assert.rejects(
      () => searchWeb({ TAVILY_API_KEY: "key" } as any, "a query", { kind: "work_session", workId: "work-x" }),
      /outbound read|no Action|Unit Action/,
      "an action-less Work must not be able to disclose a query externally",
    );
    assert.strictEqual(called, 0, "the request must be refused BEFORE it leaves the runtime");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("A Unit Work whose Action permits reading may search -- the real R&I research path, and the refusal above is specific to contexts that do not", async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.com", content: "c" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const results = await searchWeb({ TAVILY_API_KEY: "key" } as any, "a query", WORK_SEARCH);
    assert.strictEqual(called, 1, "a Work with a read-permitting Action must be able to search");
    assert.strictEqual(results.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchWeb caps an oversized result snippet -- confirmed live root cause: Tavily's unbounded content field, across up to 8 dimensions x 5 results, pushed a single synthesis prompt to ~18,000 tokens", async () => {
  const originalFetch = globalThis.fetch;
  const oversized = "x".repeat(5000);
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [{ title: "T", url: "https://example.com", content: oversized, published_date: "2026-01-01" }],
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const results = await searchWeb({ TAVILY_API_KEY: "key" } as any, "some query", KERNEL_SEARCH);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].snippet.length < oversized.length);
    assert.ok(results[0].snippet.endsWith("..."));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractDomain strips the protocol and www prefix", () => {
  assert.strictEqual(extractDomain("https://www.example.com/report?x=1"), "example.com");
  assert.strictEqual(extractDomain("https://gso.gov.gh/stats"), "gso.gov.gh");
});

test("extractDomain falls back to the raw string for a malformed URL rather than throwing", () => {
  assert.strictEqual(extractDomain("not a url"), "not a url");
});

test("gatherDimensionEvidence returns empty results per dimension when search isn't configured -- same graceful degradation as before, now per-dimension", async () => {
  const plan = [
    { protocol: "market_industry" as const, subQuestion: "What is the market size for X?" },
    { protocol: "competitive" as const, subQuestion: "Who are the named competitors in X?" },
  ];
  const evidence = await gatherDimensionEvidence({} as any, plan, KERNEL_SEARCH);
  assert.strictEqual(evidence.length, 2);
  assert.deepStrictEqual(evidence[0].results, []);
  assert.deepStrictEqual(evidence[1].results, []);
  assert.strictEqual(evidence[0].subQuestion, plan[0].subQuestion);
});

function withResults(protocol: DimensionEvidence["protocol"], subQuestion: string, count: number): DimensionEvidence {
  return {
    protocol,
    subQuestion,
    results: Array.from({ length: count }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      snippet: `Snippet ${i}`,
      publishedDate: "2026-01-01",
    })),
  };
}

test("assessDimensionCoverage splits dimensions into covered (has results) and uncovered (zero results)", () => {
  const dims: DimensionEvidence[] = [withResults("market_industry", "Q1", 2), withResults("competitive", "Q2", 0)];
  const { covered, uncovered } = assessDimensionCoverage(dims);
  assert.strictEqual(covered.length, 1);
  assert.strictEqual(uncovered.length, 1);
  assert.strictEqual(covered[0].subQuestion, "Q1");
  assert.strictEqual(uncovered[0].subQuestion, "Q2");
});

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

// --- Core Structure v2.4: concurrency + identity boundary stay Package-owned ---

test("gatherDimensionEvidence runs independent dimension searches concurrently -- Promise.all semantics preserved, never serialized", async () => {
  const originalFetch = globalThis.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.com/r", content: "c" }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const plan = [
      { protocol: "market_industry" as const, subQuestion: "Market structure?" },
      { protocol: "competitive" as const, subQuestion: "Named competitors?" },
      { protocol: "customer_audience" as const, subQuestion: "Customer pain points?" },
      { protocol: "environmental_regulatory" as const, subQuestion: "Applicable regulations?" },
    ];
    const evidence = await gatherDimensionEvidence({ TAVILY_API_KEY: "key" } as any, plan, KERNEL_SEARCH);
    assert.strictEqual(evidence.length, 4);
    assert.ok(maxInFlight > 1, `independent searches must overlap (max in-flight was ${maxInFlight})`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gatherDimensionEvidence redacts identity terms from every outbound query -- token/privacy boundary intact at the Package's search edge", async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    queries.push(String(body.query ?? ""));
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const plan = [{ protocol: "market_industry" as const, subQuestion: "What is ENIG's market position in Ghana, Martin?" }];
    await gatherDimensionEvidence({ TAVILY_API_KEY: "key" } as any, plan, KERNEL_SEARCH);

    assert.strictEqual(queries.length, 1);
    assert.ok(!queries[0].includes("ENIG"), `identity must not leave the runtime: ${queries[0]}`);
    assert.ok(!queries[0].includes("Martin"), `identity must not leave the runtime: ${queries[0]}`);
    assert.ok(queries[0].includes("the business"), "the canonical redaction replacement must be applied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
