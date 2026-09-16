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

test("isWebSearchConfigured is false when no API key is set, true when one is", () => {
  assert.strictEqual(isWebSearchConfigured({} as any), false);
  assert.strictEqual(isWebSearchConfigured({ TAVILY_API_KEY: "key" } as any), true);
});

test("searchWeb returns [] without throwing when no API key is configured -- graceful degradation to closed-book behavior", async () => {
  const results = await searchWeb({} as any, "some query");
  assert.deepStrictEqual(results, []);
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
    const results = await searchWeb({ TAVILY_API_KEY: "key" } as any, "some query");
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
  const evidence = await gatherDimensionEvidence({} as any, plan);
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
  assert.ok(formatted.includes("Market / Industry Intelligence"));
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
  assert.ok(warning.includes("Environmental / Regulatory Intelligence"));
  assert.ok(warning.toLowerCase().includes("limitation"));
});
