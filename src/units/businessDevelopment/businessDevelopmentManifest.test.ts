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
import { resolveRecordedActionSkills } from "../../runtime/actionSkills";

/** The Skills a Hat's Action declares, resolved through the Skill Registry -- the same path execution uses. */
async function skillsFor(hat: { actions: any[] }, actionName: string) {
  return resolveRecordedActionSkills(hat, actionName);
}
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
 * Skills are a synchronous, repo-native lookup resolved by the Registry (migrated 2026-09-28
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

  const reply = await opportunityDevelopmentHat.readHandler(env, "discover_opportunity", "There's a potential opportunity in fintech", await skillsFor(opportunityDevelopmentHat, "discover_opportunity"));

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

  const reply = await opportunityDevelopmentHat.readHandler(env, "research_opportunity", "Martin shared some facts about a prospect", await skillsFor(opportunityDevelopmentHat, "research_opportunity"));

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.match(reply, /Findings: Fact one/);
});

test("discover_opportunity: fails closed with a clarifying message when the model returns no signal", async (t) => {
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = { run: async () => ({ response: JSON.stringify({}) }) } as any;

  const reply = await opportunityDevelopmentHat.readHandler(env, "discover_opportunity", "vague message", await skillsFor(opportunityDevelopmentHat, "discover_opportunity"));

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

  const reply = await opportunityDevelopmentHat.readHandler(env, "assess_opportunity", "Assess this opportunity", await skillsFor(opportunityDevelopmentHat, "assess_opportunity"));

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
  await opportunityDevelopmentHat.entryHandler(env, state, "qualify_opportunity", "qualify this", await skillsFor(opportunityDevelopmentHat, "qualify_opportunity"));

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
  await opportunityDevelopmentHat.entryHandler(env, state, "qualify_opportunity", "qualify this", await skillsFor(opportunityDevelopmentHat, "qualify_opportunity"));

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
  await opportunityDevelopmentHat.entryHandler(env, state, "develop_opportunity", "develop this", await skillsFor(opportunityDevelopmentHat, "develop_opportunity"));

  assert.strictEqual(capturedSystems.length, 1);
  assert.match(capturedSystems[0], new RegExp(FORWARD_PLANNING_DISTINCTIVE_LINE));
  assert.doesNotMatch(capturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.doesNotMatch(capturedSystems[0], new RegExp(QUALIFICATION_GATE_DISTINCTIVE_LINE));
  assert.ok(state.pendingBDDevelop, "should present a draft pending Martin's approval, never auto-commit");
  assert.strictEqual(state.bdOpportunity.developedState, undefined, "must not commit before approval");
});

/**
 * A1 regression coverage: Partnership Development, Growth & Market
 * Development, and the shared determine_next_move drafting prompt after
 * their migration onto the same three repo-native Skills Opportunity
 * Development already consumes. Each test asserts BOTH halves of the
 * migration: the Skill's real methodology content reaches the assembled
 * system prompt, and the retired inline copy of that methodology does
 * not -- proving the runtime resolves methodology through its declared, resolved Skill set
 * rather than silently falling back to the old hardcoded prompt.
 */
const PARTNERSHIP_DISCOVER_OLD_INLINE_RULE = "Never invent or infer evidence that isn't in the request";
const RESEARCH_OLD_INLINE_RULE = "Never fabricate facts, statistics, claims, or sources not present in the input";
const ASSESS_OLD_INLINE_RULE = "Base this only on what has actually been stated";
const QUALIFY_OLD_INLINE_RULE = "Qualification must not be based on enthusiasm, confidence, or superficial fit";
const DEVELOP_OLD_INLINE_RULE = "Ground everything only in the";
const NEXT_MOVE_OLD_INLINE_RULE = "Ground this only in the opportunity's actual signal";

const partnershipDevelopmentHat = businessDevelopmentManifest.hats["Partnerships Manager"];
const growthMarketDevelopmentHat = businessDevelopmentManifest.hats["Growth & Market Development Manager"];

/** Mocks Workers AI to capture the assembled system prompt and return `response`, plus the Telegram/Notion fetch stub. */
function captureSkillPrompt(t: any, response: Record<string, unknown>) {
  const capturedSystems: string[] = [];
  const env = fakeEnv();
  mockTelegramFetch(t);
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify(response) };
    },
  } as any;
  return { env, capturedSystems };
}

function assertCarriesSkillAndNotRetiredRule(prompt: string, skillLine: string, retiredRule: string) {
  assert.ok(prompt.includes(skillLine), `prompt must carry the Skill's methodology (${skillLine})`);
  assert.ok(!prompt.includes(retiredRule), `prompt must not fall back to the retired inline copy (${retiredRule})`);
}

test("discover_partner: resolves research_signal through its declared, resolved Skill set instead of its retired inline evidence rule", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { signal: "A regional banking partner", whyItMayMatter: "Reach into a new segment", evidenceNeeded: ["reference check"] });

  const reply = await partnershipDevelopmentHat.readHandler(env, "discover_partner", "Consider partnering with a regional bank", await skillsFor(partnershipDevelopmentHat, "discover_partner"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], RESEARCH_SIGNAL_DISTINCTIVE_LINE, PARTNERSHIP_DISCOVER_OLD_INLINE_RULE);
  assert.match(reply, /Signal: A regional banking partner/);
});

test("research_partner: resolves research_signal through its declared, resolved Skill set; keeps only the action's own no-live-search capability framing", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { findings: ["Stated fact"], implications: "Relevant to ENIG", limitations: [], sources: ["Martin's own account"] });

  const reply = await partnershipDevelopmentHat.readHandler(env, "research_partner", "Research this prospective partner", await skillsFor(partnershipDevelopmentHat, "research_partner"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], RESEARCH_SIGNAL_DISTINCTIVE_LINE, RESEARCH_OLD_INLINE_RULE);
  assert.match(capturedSystems[0], /no live search or external research capability/, "the action's own capability constraint is persona, not methodology, and must survive");
  assert.match(reply, /Findings: Stated fact/);
});

test("assess_partnership: resolves research_signal through its declared, resolved Skill set instead of its retired inline evidence rule", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { assessment: "Worth pursuing", mutualValue: "High", strategicFit: "Strong", complementaryCapabilities: "Yes", risksAndDependencies: "None", unresolvedQuestions: ["budget"] });

  const reply = await partnershipDevelopmentHat.readHandler(env, "assess_partnership", "Assess this partnership", await skillsFor(partnershipDevelopmentHat, "assess_partnership"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], RESEARCH_SIGNAL_DISTINCTIVE_LINE, ASSESS_OLD_INLINE_RULE);
  assert.match(reply, /Assessment: Worth pursuing/);
});

test("qualify_partnership: resolves opportunity_qualification_gate through its declared, resolved Skill set, distinct from research_signal", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { qualification: "Qualified", rationale: "Strong evidence" });

  const state = fakeWorkState({ hat: "Partnerships Manager", bdOpportunity: { hatFamily: "partnership_development", signal: "A partner signal", evidence: ["Evidence one"] } });
  await partnershipDevelopmentHat.entryHandler(env, state, "qualify_partnership", "qualify this partnership", await skillsFor(partnershipDevelopmentHat, "qualify_partnership"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], QUALIFICATION_GATE_DISTINCTIVE_LINE, QUALIFY_OLD_INLINE_RULE);
  assert.ok(!capturedSystems[0].includes(RESEARCH_SIGNAL_DISTINCTIVE_LINE), "the threshold decision must not carry the evidence-interpretation Skill");
  assert.strictEqual(state.bdOpportunity.qualification, "Qualified");
});

test("develop_partnership: resolves opportunity_forward_planning through its declared, resolved Skill set instead of its retired inline grounding rule", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { stakeholders: "Martin", valueHypothesis: "Mutual value", route: "Co-sell", dependencies: "None", risks: "Low", nextStep: "Intro call" });

  const state = fakeWorkState({
    hat: "Partnerships Manager",
    bdOpportunity: { hatFamily: "partnership_development", signal: "A partner signal", evidence: [], qualification: "Qualified", qualificationRationale: "Strong" },
  });
  await partnershipDevelopmentHat.entryHandler(env, state, "develop_partnership", "develop this partnership", await skillsFor(partnershipDevelopmentHat, "develop_partnership"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], FORWARD_PLANNING_DISTINCTIVE_LINE, DEVELOP_OLD_INLINE_RULE);
  assert.ok(!capturedSystems[0].includes(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.ok(!capturedSystems[0].includes(QUALIFICATION_GATE_DISTINCTIVE_LINE));
  assert.ok(state.pendingBDDevelop, "should present a draft pending Martin's approval, never auto-commit");
  assert.strictEqual(state.bdOpportunity.developedState, undefined, "must not commit before approval");
});

test("discover_growth_opportunity: resolves research_signal through its declared, resolved Skill set instead of its retired inline evidence rule", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { signal: "A new channel", whyItMayMatter: "New demand", evidenceNeeded: ["demand data"] });

  const reply = await growthMarketDevelopmentHat.readHandler(env, "discover_growth_opportunity", "Look at the LATAM market", await skillsFor(growthMarketDevelopmentHat, "discover_growth_opportunity"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], RESEARCH_SIGNAL_DISTINCTIVE_LINE, PARTNERSHIP_DISCOVER_OLD_INLINE_RULE);
  assert.match(reply, /Signal: A new channel/);
});

test("research_market: resolves research_signal through its declared, resolved Skill set; keeps only the action's own no-live-search capability framing", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { findings: ["Stated market fact"], implications: "Relevant to growth", limitations: [], sources: ["Martin's own account"] });

  const reply = await growthMarketDevelopmentHat.readHandler(env, "research_market", "Research this market", await skillsFor(growthMarketDevelopmentHat, "research_market"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], RESEARCH_SIGNAL_DISTINCTIVE_LINE, RESEARCH_OLD_INLINE_RULE);
  assert.match(capturedSystems[0], /no live search or external research capability/, "the action's own capability constraint is persona, not methodology, and must survive");
  assert.match(reply, /Findings: Stated market fact/);
});

test("assess_market_opportunity: resolves research_signal through its declared, resolved Skill set instead of its retired inline evidence rule", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { assessment: "Worth pursuing", marketAttractiveness: "High", strategicCommercialRelevance: "Medium", capabilityFit: "Good", unresolvedQuestions: ["timing"] });

  const reply = await growthMarketDevelopmentHat.readHandler(env, "assess_market_opportunity", "Assess this market opportunity", await skillsFor(growthMarketDevelopmentHat, "assess_market_opportunity"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], RESEARCH_SIGNAL_DISTINCTIVE_LINE, ASSESS_OLD_INLINE_RULE);
  assert.match(reply, /Assessment: Worth pursuing/);
});

test("qualify_growth_opportunity: resolves opportunity_qualification_gate through its declared, resolved Skill set, distinct from research_signal", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { qualification: "Qualified", rationale: "Strong evidence" });

  const state = fakeWorkState({ hat: "Growth & Market Development Manager", bdOpportunity: { hatFamily: "growth_market_development", signal: "A growth signal", evidence: ["Evidence one"] } });
  await growthMarketDevelopmentHat.entryHandler(env, state, "qualify_growth_opportunity", "qualify this growth opportunity", await skillsFor(growthMarketDevelopmentHat, "qualify_growth_opportunity"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], QUALIFICATION_GATE_DISTINCTIVE_LINE, QUALIFY_OLD_INLINE_RULE);
  assert.ok(!capturedSystems[0].includes(RESEARCH_SIGNAL_DISTINCTIVE_LINE), "the threshold decision must not carry the evidence-interpretation Skill");
  assert.strictEqual(state.bdOpportunity.qualification, "Qualified");
});

test("develop_growth_opportunity: resolves opportunity_forward_planning through its declared, resolved Skill set instead of its retired inline grounding rule", async (t) => {
  const { env, capturedSystems } = captureSkillPrompt(t, { stakeholders: "Martin", valueHypothesis: "Growth value", route: "New channel", dependencies: "None", risks: "Low", nextStep: "Pilot" });

  const state = fakeWorkState({
    hat: "Growth & Market Development Manager",
    bdOpportunity: { hatFamily: "growth_market_development", signal: "A growth signal", evidence: [], qualification: "Qualified", qualificationRationale: "Strong" },
  });
  await growthMarketDevelopmentHat.entryHandler(env, state, "develop_growth_opportunity", "develop this growth opportunity", await skillsFor(growthMarketDevelopmentHat, "develop_growth_opportunity"));

  assert.strictEqual(capturedSystems.length, 1);
  assertCarriesSkillAndNotRetiredRule(capturedSystems[0], FORWARD_PLANNING_DISTINCTIVE_LINE, DEVELOP_OLD_INLINE_RULE);
  assert.ok(!capturedSystems[0].includes(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.ok(!capturedSystems[0].includes(QUALIFICATION_GATE_DISTINCTIVE_LINE));
  assert.ok(state.pendingBDDevelop, "should present a draft pending Martin's approval, never auto-commit");
  assert.strictEqual(state.bdOpportunity.developedState, undefined, "must not commit before approval");
});

test("determine_next_move on all three BD Hats: the shared draftNextMove resolves opportunity_forward_planning once, never its retired inline grounding rule", async (t) => {
  const cases = [
    { hat: opportunityDevelopmentHat, hatName: "Business Development Manager", hatFamily: "opportunity_development" },
    { hat: partnershipDevelopmentHat, hatName: "Partnerships Manager", hatFamily: "partnership_development" },
    { hat: growthMarketDevelopmentHat, hatName: "Growth & Market Development Manager", hatFamily: "growth_market_development" },
  ];

  for (const c of cases) {
    const { env, capturedSystems } = captureSkillPrompt(t, { nextMove: "Reach out to the candidate", rationale: "Evidence supports it", requiresHumanDecision: null });

    const state = fakeWorkState({
      hat: c.hatName,
      bdOpportunity: { hatFamily: c.hatFamily, signal: "A signal", evidence: ["Evidence one"], qualification: "Qualified", qualificationRationale: "Strong", developedState: "Stakeholders: Martin" },
    });
    await c.hat.entryHandler(env, state, "determine_next_move", "what's the next move?", await skillsFor(c.hat, "determine_next_move"));

    assert.strictEqual(capturedSystems.length, 1, `${c.hatName} must run exactly one drafting call`);
    assertCarriesSkillAndNotRetiredRule(capturedSystems[0], FORWARD_PLANNING_DISTINCTIVE_LINE, NEXT_MOVE_OLD_INLINE_RULE);
    assert.ok(state.pendingBDNextMove, `${c.hatName} should present a recommendation pending Martin's approval, never auto-commit`);
    assert.strictEqual(state.bdOpportunity.nextMove, undefined, "must not commit before approval");
  }
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

// --- Skills are declared by the Action and supplied by the execution boundary ---

test("every BD Action that consumes a Skill declares it, and a handler given no Skill set fails closed rather than looking one up", async () => {
  const expected: Array<[typeof opportunityDevelopmentHat, string, string]> = [
    [opportunityDevelopmentHat, "discover_opportunity", "research_signal"],
    [opportunityDevelopmentHat, "qualify_opportunity", "opportunity_qualification_gate"],
    [opportunityDevelopmentHat, "develop_opportunity", "opportunity_forward_planning"],
    [opportunityDevelopmentHat, "determine_next_move", "opportunity_forward_planning"],
    [partnershipDevelopmentHat as any, "assess_partnership", "research_signal"],
    [partnershipDevelopmentHat as any, "qualify_partnership", "opportunity_qualification_gate"],
    [partnershipDevelopmentHat as any, "develop_partnership", "opportunity_forward_planning"],
    [growthMarketDevelopmentHat as any, "research_market", "research_signal"],
    [growthMarketDevelopmentHat as any, "qualify_growth_opportunity", "opportunity_qualification_gate"],
    [growthMarketDevelopmentHat as any, "determine_next_move", "opportunity_forward_planning"],
  ];
  for (const [hat, action, skill] of expected) {
    const declared = hat.actions.find((a: any) => a.name === action);
    assert.deepStrictEqual(declared?.skill_requirements, [{ skill_id: skill }], `${action} must declare ${skill}`);
  }

  const { NO_ACTION_SKILLS } = await import("../../platform/skillRegistry");
  await assert.rejects(
    () => opportunityDevelopmentHat.readHandler({} as any, "discover_opportunity", "a signal", NO_ACTION_SKILLS),
    /was not declared by this Action/,
  );
  // The `handoff_*` Actions consume no Skill and declare none.
  assert.strictEqual(opportunityDevelopmentHat.actions.find((a) => a.name === "handoff_to_sales")?.skill_requirements, undefined);
});
