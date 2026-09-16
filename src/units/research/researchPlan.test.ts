import test from "node:test";
import assert from "node:assert";
import { MAX_DIMENSIONS_PER_PROTOCOL, MAX_DIMENSIONS_PER_REQUEST, buildResearchPlanPrompt, capResearchPlan } from "./researchPlan";
import type { ResearchPlanDimension } from "./researchPlan";

function dim(protocol: ResearchPlanDimension["protocol"], n: number): ResearchPlanDimension {
  return { protocol, subQuestion: `Sub-question ${n} for ${protocol}` };
}

test("capResearchPlan enforces the per-protocol cap", () => {
  const dimensions = Array.from({ length: MAX_DIMENSIONS_PER_PROTOCOL + 3 }, (_, i) => dim("market_industry", i));
  const capped = capResearchPlan(dimensions);
  assert.strictEqual(capped.length, MAX_DIMENSIONS_PER_PROTOCOL);
});

test("capResearchPlan enforces the total request cap across multiple protocols", () => {
  const dimensions = [
    ...Array.from({ length: MAX_DIMENSIONS_PER_PROTOCOL }, (_, i) => dim("market_industry", i)),
    ...Array.from({ length: MAX_DIMENSIONS_PER_PROTOCOL }, (_, i) => dim("competitive", i)),
    ...Array.from({ length: MAX_DIMENSIONS_PER_PROTOCOL }, (_, i) => dim("customer_audience", i)),
  ];
  const capped = capResearchPlan(dimensions);
  assert.strictEqual(capped.length, MAX_DIMENSIONS_PER_REQUEST);
});

test("capResearchPlan doesn't let one protocol crowd out another -- each protocol keeps its own dimensions up to its own cap", () => {
  const dimensions = [dim("market_industry", 1), dim("market_industry", 2), dim("competitive", 1)];
  const capped = capResearchPlan(dimensions);
  assert.ok(capped.some((d) => d.protocol === "competitive"));
  assert.strictEqual(capped.filter((d) => d.protocol === "market_industry").length, 2);
});

test("capResearchPlan passes through a plan already within bounds unchanged", () => {
  const dimensions = [dim("market_industry", 1), dim("competitive", 1)];
  assert.deepStrictEqual(capResearchPlan(dimensions), dimensions);
});

test("buildResearchPlanPrompt includes each selected protocol's own registered evidence requirements -- this is what was never read anywhere before", () => {
  const prompt = buildResearchPlanPrompt("Category summary text.", "Relevance text.", ["market_industry"]);
  assert.ok(prompt.includes("Industry research reports, benchmark data, market statistics"));
});

test("buildResearchPlanPrompt only includes the selected protocols' detail, not all six", () => {
  const prompt = buildResearchPlanPrompt("Category summary text.", "Relevance text.", ["market_industry"]);
  assert.ok(!prompt.includes("Observable competitor product pages"));
});

test("buildResearchPlanPrompt instructs tailoring to the actual question, not copying the illustrative examples verbatim", () => {
  const prompt = buildResearchPlanPrompt("Category summary text.", "Relevance text.", ["market_industry", "competitive"]);
  assert.ok(prompt.toLowerCase().includes("tailor"));
  assert.ok(prompt.includes("not a checklist to copy verbatim"));
});

test("buildResearchPlanPrompt includes the category summary and relevance framing, never inventing a separate consultancy description", () => {
  const prompt = buildResearchPlanPrompt("UNIQUE_CATEGORY_MARKER", "UNIQUE_RELEVANCE_MARKER", ["market_industry"]);
  assert.ok(prompt.includes("UNIQUE_CATEGORY_MARKER"));
  assert.ok(prompt.includes("UNIQUE_RELEVANCE_MARKER"));
});
