import test from "node:test";
import assert from "node:assert";
import { businessDevelopmentManifest } from "./businessDevelopmentManifest";
import type { Env } from "../../types";

/**
 * Covers Opportunity Development's discover_opportunity/research_opportunity
 * read actions after their migration onto the shared `research-signal`
 * Skill (Skills architecture proof, Build order Step 2) -- proves the
 * Skill's methodology content actually reaches the assembled AI prompt,
 * not just that the functions still return a string. The cross-Hat reuse
 * half of this proof (the same Skill, invoked by Sales's Lead Generation
 * Specialist under a different Persona/Data Source/consequence) lives in
 * src/platform/researchSignal.crossHat.test.ts.
 */

const RESEARCH_SIGNAL_MARKER = "STUB_RESEARCH_SIGNAL_METHODOLOGY_MARKER";
const QUALIFICATION_GATE_MARKER = "STUB_QUALIFICATION_GATE_METHODOLOGY_MARKER";
const FORWARD_PLANNING_MARKER = "STUB_FORWARD_PLANNING_METHODOLOGY_MARKER";

function createMockKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function fakeEnv(): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    STATE_KV: createMockKv() as any,
  } as unknown as Env;
}

function mockNotionFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const urlStr = String(url);
    if (urlStr.includes("/blocks/")) {
      let marker = RESEARCH_SIGNAL_MARKER;
      if (urlStr.includes("973b-c176")) marker = QUALIFICATION_GATE_MARKER;
      else if (urlStr.includes("b8dc-c86f")) marker = FORWARD_PLANNING_MARKER;
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: marker }] } }] }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function fakeWorkState(overrides: Record<string, unknown> = {}) {
  return {
    workId: "work-1",
    chatId: 12345,
    threadId: 777,
    hat: "Business Development Manager",
    unit: "Business Development",
    bdOpportunity: { hatFamily: "opportunity_development" as const, signal: "A candidate signal", evidence: ["Some evidence"] },
    ...overrides,
  } as any;
}

const opportunityDevelopmentHat = businessDevelopmentManifest.hats["Business Development Manager"];

test("discover_opportunity: assembles a prompt carrying the shared research-signal Skill's methodology, not a hardcoded rule", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ signal: "A new market signal", whyItMayMatter: "Because reasons", evidenceNeeded: ["more data"] }) };
    },
  } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "discover_opportunity", "There's a potential opportunity in fintech");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));
  assert.match(reply, /Signal: A new market signal/);
  assert.match(reply, /Why it may matter: Because reasons/);
});

test("research_opportunity: assembles a prompt carrying the shared research-signal Skill's methodology", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ findings: ["Fact one"], implications: "Could matter", limitations: [], sources: ["Martin's own account"] }) };
    },
  } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "research_opportunity", "Martin shared some facts about a prospect");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));
  assert.match(reply, /Findings: Fact one/);
});

test("discover_opportunity: fails closed with a clarifying message when the model returns no signal", async (t) => {
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = { run: async () => ({ response: JSON.stringify({}) }) } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "discover_opportunity", "vague message");

  assert.match(reply, /Couldn't identify a clear opportunity signal/);
});

test("assess_opportunity: assembles a prompt carrying the shared research-signal Skill's methodology (its third consumer)", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ assessment: "Worth pursuing", strategicRelevance: "High", commercialRelevance: "Medium", capabilityFit: "Good", evidenceQuality: "Thin", unresolvedQuestions: ["budget"] }) };
    },
  } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "assess_opportunity", "Assess this opportunity");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));
  assert.match(reply, /Assessment: Worth pursuing/);
});

test("qualify_opportunity: assembles a prompt carrying the shared opportunity-qualification-gate Skill's methodology, distinct from research-signal", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ qualification: "Qualified", rationale: "Strong evidence" }) };
    },
  } as any;

  const state = fakeWorkState();
  await opportunityDevelopmentHat.entryHandler(env, state, "qualify_opportunity", "qualify this");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(QUALIFICATION_GATE_MARKER));
  assert.doesNotMatch(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));
  assert.strictEqual(state.bdOpportunity.qualification, "Qualified");
  assert.strictEqual(state.awaiting, undefined);
});

test("qualify_opportunity: holds (pauses the WorkSession) rather than inferring when the model can't judge sufficiency", async (t) => {
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = { run: async () => ({ response: JSON.stringify({}) }) } as any;

  const state = fakeWorkState();
  await opportunityDevelopmentHat.entryHandler(env, state, "qualify_opportunity", "qualify this");

  assert.strictEqual(state.bdOpportunity.qualification, "Held");
  assert.strictEqual(state.awaiting, "bd_opportunity_evidence_gap");
});

test("develop_opportunity: assembles a prompt carrying the shared opportunity-forward-planning Skill's methodology, distinct from research-signal and the qualification gate", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockNotionFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ stakeholders: "Martin", valueHypothesis: "Clear value", route: "Direct outreach", dependencies: "None", risks: "Low", nextStep: "Reach out" }) };
    },
  } as any;

  const state = fakeWorkState({ bdOpportunity: { hatFamily: "opportunity_development", signal: "A signal", evidence: [], qualification: "Qualified", qualificationRationale: "Strong" } });
  await opportunityDevelopmentHat.entryHandler(env, state, "develop_opportunity", "develop this");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(FORWARD_PLANNING_MARKER));
  assert.doesNotMatch(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));
  assert.doesNotMatch(capturedSystems[0], new RegExp(QUALIFICATION_GATE_MARKER));
  assert.ok(state.pendingBDDevelop, "should present a draft pending Martin's approval, never auto-commit");
  assert.strictEqual(state.bdOpportunity.developedState, undefined, "must not commit before approval");
});
