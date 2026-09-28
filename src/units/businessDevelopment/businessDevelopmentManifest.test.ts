import test from "node:test";
import assert from "node:assert";
import {
  businessDevelopmentManifest,
  handleBDHandoffApproval,
  handleBDDevelopApproval,
  handleBDNextMoveApproval,
  BD_OPPORTUNITY_HANDOFF_CALLBACK_PREFIX,
  BD_DEVELOP_CALLBACK_PREFIX,
  BD_NEXT_MOVE_CALLBACK_PREFIX,
} from "./businessDevelopmentManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env } from "../../types";

/**
 * Covers Opportunity Development's discover_opportunity/research_opportunity
 * read actions after their migration onto the shared `research_signal`
 * Skill (Skills architecture proof, Build order Step 2) -- proves the
 * Skill's methodology content actually reaches the assembled AI prompt,
 * not just that the functions still return a string. The cross-Hat reuse
 * half of this proof (the same Skill, invoked by Sales's Lead Generation
 * Specialist under a different Persona/Data Source/consequence) lives in
 * src/platform/researchSignal.crossHat.test.ts.
 *
 * getSkillContent is a synchronous, repo-native lookup (migrated 2026-09-28
 * from the retired Notion-backed fetchSkill/SkillDefinition arrangement --
 * see skillRegistry.ts's own doc comment), so these tests match distinctive
 * substrings of each Skill's real methodology content directly, rather than
 * mocking Notion fetches keyed by page id.
 */

const RESEARCH_SIGNAL_DISTINCTIVE_LINE = "Only use evidence actually given";
const QUALIFICATION_GATE_DISTINCTIVE_LINE = "hold -- never infer it";
const FORWARD_PLANNING_DISTINCTIVE_LINE = "Build only from what's already established";

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

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const urlStr = String(url);
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

test("discover_opportunity: assembles a prompt carrying the shared research_signal Skill's methodology, not a hardcoded rule", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ signal: "A new market signal", whyItMayMatter: "Because reasons", evidenceNeeded: ["more data"] }) };
    },
  } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "discover_opportunity", "There's a potential opportunity in fintech");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.match(reply, /Signal: A new market signal/);
  assert.match(reply, /Why it may matter: Because reasons/);
});

test("research_opportunity: assembles a prompt carrying the shared research_signal Skill's methodology", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ findings: ["Fact one"], implications: "Could matter", limitations: [], sources: ["Martin's own account"] }) };
    },
  } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "research_opportunity", "Martin shared some facts about a prospect");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.match(reply, /Findings: Fact one/);
});

test("discover_opportunity: fails closed with a clarifying message when the model returns no signal", async (t) => {
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = { run: async () => ({ response: JSON.stringify({}) }) } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "discover_opportunity", "vague message");

  assert.match(reply, /Couldn't identify a clear opportunity signal/);
});

test("assess_opportunity: assembles a prompt carrying the shared research_signal Skill's methodology (its third consumer)", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ assessment: "Worth pursuing", strategicRelevance: "High", commercialRelevance: "Medium", capabilityFit: "Good", evidenceQuality: "Thin", unresolvedQuestions: ["budget"] }) };
    },
  } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "assess_opportunity", "Assess this opportunity");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.match(reply, /Assessment: Worth pursuing/);
});

test("qualify_opportunity: assembles a prompt carrying the shared opportunity_qualification_gate Skill's methodology, distinct from research_signal", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ qualification: "Qualified", rationale: "Strong evidence" }) };
    },
  } as any;

  const state = fakeWorkState();
  await opportunityDevelopmentHat.entryHandler(env, state, "qualify_opportunity", "qualify this");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(QUALIFICATION_GATE_DISTINCTIVE_LINE));
  assert.doesNotMatch(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.strictEqual(state.bdOpportunity.qualification, "Qualified");
  assert.strictEqual(state.awaiting, undefined);
});

test("qualify_opportunity: holds (pauses the WorkSession) rather than inferring when the model can't judge sufficiency", async (t) => {
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = { run: async () => ({ response: JSON.stringify({}) }) } as any;

  const state = fakeWorkState();
  await opportunityDevelopmentHat.entryHandler(env, state, "qualify_opportunity", "qualify this");

  assert.strictEqual(state.bdOpportunity.qualification, "Held");
  assert.strictEqual(state.awaiting, "bd_opportunity_evidence_gap");
});

test("develop_opportunity: assembles a prompt carrying the shared opportunity_forward_planning Skill's methodology, distinct from research_signal and the qualification gate", async (t) => {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ stakeholders: "Martin", valueHypothesis: "Clear value", route: "Direct outreach", dependencies: "None", risks: "Low", nextStep: "Reach out" }) };
    },
  } as any;

  const state = fakeWorkState({ bdOpportunity: { hatFamily: "opportunity_development", signal: "A signal", evidence: [], qualification: "Qualified", qualificationRationale: "Strong" } });
  await opportunityDevelopmentHat.entryHandler(env, state, "develop_opportunity", "develop this");

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(FORWARD_PLANNING_DISTINCTIVE_LINE));
  assert.doesNotMatch(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.doesNotMatch(capturedSystems[0], new RegExp(QUALIFICATION_GATE_DISTINCTIVE_LINE));
  assert.ok(state.pendingBDDevelop, "should present a draft pending Martin's approval, never auto-commit");
  assert.strictEqual(state.bdOpportunity.developedState, undefined, "must not commit before approval");
});

/**
 * Covers HatManifest.callbackHandlers -- the generic approval-callback
 * dispatch mechanism (session.ts's handleCallback default case), proven
 * on bdopportunityhandoff (PR #203), bddevelop (PR #204), and now
 * bdnextmove -- all three of BD's approval-callback prefixes, none left
 * hardcoded in session.ts's switch.
 */
test("all three BD Hats declare exactly bdopportunityhandoff, bddevelop, and bdnextmove in callbackHandlers", () => {
  for (const hat of Object.values(businessDevelopmentManifest.hats)) {
    assert.deepStrictEqual(
      new Set(Object.keys(hat.callbackHandlers ?? {})),
      new Set([BD_OPPORTUNITY_HANDOFF_CALLBACK_PREFIX, BD_DEVELOP_CALLBACK_PREFIX, BD_NEXT_MOVE_CALLBACK_PREFIX]),
    );
    assert.strictEqual(hat.callbackHandlers?.[BD_OPPORTUNITY_HANDOFF_CALLBACK_PREFIX], handleBDHandoffApproval);
    assert.strictEqual(hat.callbackHandlers?.[BD_DEVELOP_CALLBACK_PREFIX], handleBDDevelopApproval);
    assert.strictEqual(hat.callbackHandlers?.[BD_NEXT_MOVE_CALLBACK_PREFIX], handleBDNextMoveApproval);
  }
});

test("findCallbackHandler resolves bdopportunityhandoff on Opportunity Development and genuinely delegates to handleBDHandoffApproval -- rejecting a pending handoff clears it and replies, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    pendingBDHandoff: { unit: "Sales", hat: "Sales Executive", handoffTitle: "Test handoff", reason: "Test reason", opportunitySummary: "Test summary" },
  });

  const handler = findCallbackHandler(BD_OPPORTUNITY_HANDOFF_CALLBACK_PREFIX, opportunityDevelopmentHat);
  assert.ok(handler, "bdopportunityhandoff must resolve on Opportunity Development's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingBDHandoff, undefined);
});

test("findCallbackHandler resolves bddevelop on Opportunity Development and genuinely delegates to handleBDDevelopApproval -- rejecting a pending draft discards it without committing developedState, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    pendingBDDevelop: { draftSummary: "Test draft" },
  });

  const handler = findCallbackHandler(BD_DEVELOP_CALLBACK_PREFIX, opportunityDevelopmentHat);
  assert.ok(handler, "bddevelop must resolve on Opportunity Development's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingBDDevelop, undefined);
  assert.strictEqual(result.bdOpportunity?.developedState, undefined, "must not commit before approval");
});

test("findCallbackHandler resolves bdnextmove on Opportunity Development and genuinely delegates to handleBDNextMoveApproval -- rejecting a pending recommendation discards it without committing nextMove, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    pendingBDNextMove: { nextMoveSummary: "Test next move" },
  });

  const handler = findCallbackHandler(BD_NEXT_MOVE_CALLBACK_PREFIX, opportunityDevelopmentHat);
  assert.ok(handler, "bdnextmove must resolve on Opportunity Development's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingBDNextMove, undefined);
  assert.strictEqual(result.bdOpportunity?.nextMove, undefined, "must not commit before approval");
});
