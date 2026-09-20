import test from "node:test";
import assert from "node:assert";
import {
  MAX_DIMENSIONS_PER_PROTOCOL,
  MAX_DIMENSIONS_PER_REQUEST,
  buildResearchPlanPrompt,
  capResearchPlan,
  generateResearchPlan,
} from "./researchPlan";
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

function mockChatCompletion(dimensions: Array<{ protocol: string; subQuestion: string }>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ dimensions }) } }] }),
    { status: 200 },
  );
}

test("generateResearchPlan makes one independent AI call per selected protocol, not one combined call -- the fix for multi-protocol requests blowing past free-tier size limits", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: any[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: any) => {
    if (String(url) === "https://api.groq.com/openai/v1/chat/completions") {
      const body = JSON.parse(init.body);
      requestBodies.push(body);
      const protocol = body.messages[0].content.includes("Industry research reports, benchmark data") ? "market_industry" : "competitive";
      return mockChatCompletion([{ protocol, subQuestion: `Sub-question for ${protocol}` }]);
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const env = { GROQ_API_KEY: "key" } as any;
    const plan = await generateResearchPlan(env, "Category", "Relevance", "What is the market?", ["market_industry", "competitive"]);

    assert.strictEqual(requestBodies.length, 2, "one call per protocol, not one combined call");
    assert.ok(plan);
    assert.strictEqual(plan!.length, 2);
    assert.ok(plan!.some((d) => d.protocol === "market_industry"));
    assert.ok(plan!.some((d) => d.protocol === "competitive"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateResearchPlan returns a partial plan when only some protocols' calls succeed -- one protocol's failure no longer fails the whole plan", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: any) => {
    if (String(url) === "https://api.groq.com/openai/v1/chat/completions") {
      const body = JSON.parse(init.body);
      const isMarket = body.messages[0].content.includes("Industry research reports, benchmark data");
      if (!isMarket) {
        // Simulates a provider returning unparsable output for this one protocol's call.
        return new Response("not valid json", { status: 200 });
      }
      return mockChatCompletion([{ protocol: "market_industry", subQuestion: "What is the market size?" }]);
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const env = { GROQ_API_KEY: "key" } as any;
    const plan = await generateResearchPlan(env, "Category", "Relevance", "question", ["market_industry", "competitive"]);

    assert.ok(plan, "a partial plan is still a usable plan, not a failure");
    assert.strictEqual(plan!.length, 1);
    assert.strictEqual(plan![0].protocol, "market_industry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateResearchPlan returns null only when every protocol's call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: any) => {
    if (String(url) === "https://api.groq.com/openai/v1/chat/completions") {
      return new Response("not valid json", { status: 200 });
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const env = { GROQ_API_KEY: "key" } as any;
    const plan = await generateResearchPlan(env, "Category", "Relevance", "question", ["market_industry", "competitive"]);
    assert.strictEqual(plan, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateResearchPlan scopes each dimension to the protocol its call was made for, regardless of what the model echoes back", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: any) => {
    if (String(url) === "https://api.groq.com/openai/v1/chat/completions") {
      // Every call returns a dimension claiming a wrong/unrelated protocol name -- the
      // real protocol comes from which call this is, not from trusting this field.
      return mockChatCompletion([{ protocol: "totally-not-a-real-protocol", subQuestion: "Some sub-question" }]);
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const env = { GROQ_API_KEY: "key" } as any;
    const plan = await generateResearchPlan(env, "Category", "Relevance", "question", ["market_industry"]);
    assert.ok(plan);
    assert.strictEqual(plan!.length, 1);
    assert.strictEqual(plan![0].protocol, "market_industry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
