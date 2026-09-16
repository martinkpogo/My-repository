import test from "node:test";
import assert from "node:assert";
import { buildSearchQueries, formatWebResultsForContext, isWebSearchConfigured, MAX_QUERIES_PER_REQUEST, searchWeb } from "./webSearch";
import type { WebSearchResult } from "./webSearch";

test("buildSearchQueries builds one query per protocol that has a query focus", () => {
  const queries = buildSearchQueries(
    "Who are our main competitors and how do they position?",
    "This concerns the market for strategy-led consulting in Ghana.",
    ["market_industry", "competitive"],
  );
  assert.strictEqual(queries.length, 2);
  assert.ok(queries[0].includes("market size, demand, and growth trends"));
  assert.ok(queries[1].includes("competitors and market positioning"));
});

test("buildSearchQueries includes the actual question, not just the abstracted relevance framing -- fixes the generic-results regression seen live", () => {
  const queries = buildSearchQueries("Who are our main competitors and how do they position?", "Category framing only.", ["competitive"]);
  assert.ok(queries[0].includes("Who are our main competitors and how do they position?"));
});

test("buildSearchQueries excludes Evidence & Source Validation -- it has no query topic of its own", () => {
  const queries = buildSearchQueries("A question.", "Relevance statement.", ["evidence_validation"]);
  assert.strictEqual(queries.length, 0);
});

test("buildSearchQueries caps at MAX_QUERIES_PER_REQUEST even with more protocols selected", () => {
  const queries = buildSearchQueries("A question.", "Relevance.", ["business_company", "market_industry", "competitive", "customer_audience", "environmental_regulatory"]);
  assert.strictEqual(queries.length, MAX_QUERIES_PER_REQUEST);
});

test("buildSearchQueries redacts identity terms from both the question and the relevance statement -- defense in depth for external queries", () => {
  const queries = buildSearchQueries("What is ENIG's position vs competitors?", "Research ENIG's own market; Martin wants this.", ["market_industry"]);
  assert.ok(!queries[0].includes("ENIG"));
  assert.ok(!queries[0].includes("Martin"));
});

test("isWebSearchConfigured is false when no API key is set, true when one is", () => {
  assert.strictEqual(isWebSearchConfigured({} as any), false);
  assert.strictEqual(isWebSearchConfigured({ TAVILY_API_KEY: "key" } as any), true);
});

test("searchWeb returns [] without throwing when no API key is configured -- graceful degradation to closed-book behavior", async () => {
  const results = await searchWeb({} as any, "some query");
  assert.deepStrictEqual(results, []);
});

test("formatWebResultsForContext returns an empty string for no results", () => {
  assert.strictEqual(formatWebResultsForContext([]), "");
});

test("formatWebResultsForContext includes the exact URL for each result -- what findUnverifiableSources will match against", () => {
  const results: WebSearchResult[] = [
    { title: "Example Market Report", url: "https://example.com/report", snippet: "Growth of 8% YoY.", publishedDate: "2026-01-01" },
  ];
  const formatted = formatWebResultsForContext(results);
  assert.ok(formatted.includes("https://example.com/report"));
  assert.ok(formatted.includes("Example Market Report"));
  assert.ok(formatted.includes("Growth of 8% YoY."));
});
