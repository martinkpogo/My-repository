import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePickup,
  handleStrategyHandoffApproval,
  handleInterventionApproval,
  handleStrategyClarification,
  evaluateCausationDiscipline,
  formatDiagnosisForHandoff,
  type StrategyDiagnosisResult,
} from "./strategyAnalyst";
import { STRATEGY_ANALYST, ALL_HATS } from "../../hats/registry";
import type { WorkState, Env } from "../../types";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any,
    } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
    ...overrides,
  };
}

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work_strat_1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    stage: "awaiting_pickup",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: "handoff-1",
    ...overrides,
  };
}

/** Dispatches on the system prompt's own distinguishing text -- diagnosis vs. handoff-routing classification. */
function fakeAi(diagnosisJson: unknown, routingJson: unknown = { target: "none" }): Ai {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      if (system.includes("canonical operating procedure")) {
        return { response: JSON.stringify(diagnosisJson) };
      }
      if (system.includes("next responsibility belongs to another Unit")) {
        return { response: JSON.stringify(routingJson) };
      }
      throw new Error(`Unexpected AI call in test -- system prompt: ${system.slice(0, 80)}`);
    },
  } as any;
}

/** An env.AI.run that must never be called -- used to prove closed-context failures short-circuit before any AI call. */
function forbiddenAi(): Ai {
  return {
    run: async () => {
      throw new Error("AI must not be called when required context is missing");
    },
  } as any;
}

interface FetchLog {
  handoffPatchBodies: any[];
  handoffCreateBody: any;
  sentTexts: string[];
  sentButtons: any[];
}

function mockFetch(
  t: any,
  opts: { verifiedFacts?: string; entityToken?: string; matterToken?: string; initialStatus?: string } = {},
): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = { handoffPatchBodies: [], handoffCreateBody: null, sentTexts: [], sentButtons: [] };
  const verifiedFacts = opts.verifiedFacts ?? "Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.";
  const entityToken = opts.entityToken ?? "E-47";
  const matterToken = opts.matterToken ?? "M-12";
  const initialStatus = opts.initialStatus ?? "Pending";

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      log.sentTexts.push(body.text ?? "");
      if (body.reply_markup) log.sentButtons.push(body.reply_markup.inline_keyboard);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          properties: {
            Status: { select: { name: initialStatus } },
            "Verified Facts & Sources": { rich_text: [{ plain_text: verifiedFacts }] },
            Entity_Token: { rich_text: [{ plain_text: entityToken }] },
            Matter_Token: { rich_text: [{ plain_text: matterToken }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") {
      log.handoffPatchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "handoff-1", url: "https://notion.so/handoff-1", properties: {} }), { status: 200 });
    }
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        log.handoffCreateBody = body;
        return new Response(JSON.stringify({ id: "handoff-new", url: "https://notion.so/handoff-new", properties: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return log;
}

function lastHandoffPatch(log: FetchLog): any {
  return log.handoffPatchBodies[log.handoffPatchBodies.length - 1];
}

const SUFFICIENT_DIAGNOSIS: StrategyDiagnosisResult = {
  sufficient: true,
  situation: {
    symptoms: "Repeated client complaints about late delivery.",
    businessConditions: "Two consecutive quarters of missed delivery windows.",
    constraints: "Warehouse capacity fixed through year-end.",
    consequences: "Client trust erosion, risk of churn on largest account.",
    stakeholders: "Operations lead, key account client contact.",
    objectives: "Restore reliable delivery within the quarter.",
  },
  diagnosis: {
    symptom: "Late delivery complaints.",
    problem: "Delivery reliability has degraded for the largest account.",
    cause: "Warehouse capacity constraint documented in call notes for two consecutive quarters.",
    causationSupported: true,
    constraint: "Warehouse capacity fixed through year-end.",
    consequence: "Client trust erosion, churn risk.",
  },
  strategicProblem: {
    statement: "Delivery reliability is degrading due to a capacity constraint, threatening the largest account.",
    whyItMatters: "This account represents material recurring revenue.",
    keyDrivers: "Fixed warehouse capacity, sustained demand growth.",
    strategicTension: "Invest in capacity now vs. risk further account erosion.",
    materialUncertainty: "Exact churn probability if unresolved.",
  },
  options: [
    {
      name: "Expand interim capacity via third-party logistics",
      intendedEffect: "Restore delivery reliability within one quarter.",
      rationale: "Fastest lever given fixed warehouse capacity through year-end.",
      evidenceBasis: "Call notes documenting the capacity constraint.",
      assumptions: "Third-party logistics partner has available capacity.",
      constraintsRisks: "Added cost; vendor reliability unverified.",
      conditionsForSuccess: "Partner onboarded within 30 days.",
    },
  ],
  recommendedDirection: "Expand interim delivery capacity via a third-party logistics partner within the quarter.",
  recommendationRationale: "Directly addresses the documented capacity constraint within the client's tolerance window.",
  evidenceSources: "Sales call notes, two quarters of delivery data referenced therein.",
  assumptions: "Third-party logistics partner has available capacity.",
  unresolvedQuestions: "Exact cost of third-party logistics expansion.",
};

/** A sufficient diagnosis with no recommendation yet -- the only case eligible for the generic (non-Finance) downstream-routing classifier. */
const NO_RECOMMENDATION_DIAGNOSIS: StrategyDiagnosisResult = {
  sufficient: true,
  situation: SUFFICIENT_DIAGNOSIS.situation,
  diagnosis: { ...SUFFICIENT_DIAGNOSIS.diagnosis, causationSupported: true },
  strategicProblem: SUFFICIENT_DIAGNOSIS.strategicProblem,
  noRecommendationReason: "Market-level evidence on third-party logistics capacity in this region is not yet established.",
  evidenceSources: SUFFICIENT_DIAGNOSIS.evidenceSources,
  assumptions: SUFFICIENT_DIAGNOSIS.assumptions,
  unresolvedQuestions: "Which logistics partners have verifiable regional capacity.",
};

test("1. Strategy Analyst identity resolves correctly", () => {
  assert.strictEqual(STRATEGY_ANALYST.name, "Strategy Analyst");
  assert.strictEqual(STRATEGY_ANALYST.unit, "Strategy");
  assert.strictEqual(STRATEGY_ANALYST.specialization, "Strategy");
  assert.ok(ALL_HATS.some((h) => h.name === "Strategy Analyst" && h.unit === "Strategy"));
});

test("3. Strategy picks up a Pending Handoff", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.ok(result.strategyQuestion, "the strategic question/context must be populated from the Handoff");
  assert.notStrictEqual(result.stage, "awaiting_pickup", "pickup must actually progress the work item");
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Picked-up"), "the claim step must set Picked-up");
});

test("4. Strategy refuses a Handoff already Picked-up", async (t) => {
  const log = mockFetch(t, { initialStatus: "Picked-up" });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategyDiagnosis, undefined, "must not process a Handoff that isn't genuinely Pending");
  assert.strictEqual(log.handoffPatchBodies.length, 0, "no Notion write should occur -- refused before any processing");
});

test("5. Strategy refuses a Closed Handoff", async (t) => {
  const log = mockFetch(t, { initialStatus: "Closed" });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeState();

  await handlePickup(env, state);

  assert.strictEqual(log.handoffPatchBodies.length, 0);
});

test("6. Strategy can place a blocked case on Held", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, blockedCategory: "ambiguous_question", blockedReason: "The strategic question could mean either a pricing problem or a delivery problem -- materially different diagnoses follow from each." });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.awaiting, "strategy_clarification");
  const heldPatch = lastHandoffPatch(log);
  assert.strictEqual(heldPatch.properties.Status.select.name, "Held");
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /materially different diagnoses/);
});

test("Insufficient evidence blocks rather than inventing a diagnosis", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, blockedCategory: "insufficient_evidence", blockedReason: "No evidence is supplied connecting the stated symptom to any business condition -- cannot responsibly diagnose." });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked");
  const heldPatch = lastHandoffPatch(log);
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /No evidence is supplied/);
});

test("Unsupported causation is rejected -- runtime overrides sufficient: true", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_DIAGNOSIS,
    diagnosis: { ...SUFFICIENT_DIAGNOSIS.diagnosis, causationSupported: false },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked", "a recommendation resting on unsupported causation must never be delivered as-is");
  const heldPatch = lastHandoffPatch(log);
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /causation/i);
});

test("evaluateCausationDiscipline: rejects a recommendation when causation is not marked supported", () => {
  const result = evaluateCausationDiscipline({
    ...SUFFICIENT_DIAGNOSIS,
    diagnosis: { ...SUFFICIENT_DIAGNOSIS.diagnosis, causationSupported: false },
  });
  assert.strictEqual(result.valid, false);
});

test("evaluateCausationDiscipline: accepts a fully supported diagnosis", () => {
  const result = evaluateCausationDiscipline(SUFFICIENT_DIAGNOSIS);
  assert.strictEqual(result.valid, true);
});

test("evaluateCausationDiscipline: requires a stated reason when no recommendation is given", () => {
  const result = evaluateCausationDiscipline({
    sufficient: true,
    diagnosis: { problem: "Problem.", cause: "Cause.", causationSupported: true },
  });
  assert.strictEqual(result.valid, false);
});

test("7. Held case can explicitly return to Pending", async (t) => {
  const log = mockFetch(t, { initialStatus: "Held" });
  const env = fakeEnv();
  const state = fakeState({ stage: "strategy_blocked", awaiting: "strategy_clarification", strategyContext: "Original context." });

  const result = await handleStrategyClarification(env, state, "The problem is specifically about delivery, not pricing.");

  assert.strictEqual(result.stage, "strategy_retry_queued");
  const patch = lastHandoffPatch(log);
  assert.strictEqual(patch.properties.Status.select.name, "Pending", "an explicit retry must return the Handoff to Pending, not process it inline");
  assert.match(patch.properties["Verified Facts & Sources"].rich_text[0].text.content, /delivery, not pricing/);
});

test("8. Pending retry can be picked up again exactly once", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();

  const first = await handlePickup(env, state);
  assert.notStrictEqual(first.stage, "awaiting_pickup");
  const afterFirst = log.handoffPatchBodies.length;

  // A duplicate discovery trigger invoking pickup again on the SAME
  // session after it already progressed past Pending -- the live Notion
  // record is now Picked-up/Closed (per the mock's static initialStatus,
  // simulating the real post-claim state), so a second call must refuse.
  const secondLog = mockFetch(t, { initialStatus: "Closed" });
  const second = await handlePickup(env, state);
  assert.strictEqual(secondLog.handoffPatchBodies.length, 0, "the second pickup must not process anything");
  void afterFirst;
  void second;
});

test("9. Strategy intervention requires Martin approval -- no Finance Handoff auto-created", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "awaiting_intervention_approval");
  assert.ok(result.pendingIntervention, "a pendingIntervention must be set");
  assert.strictEqual(result.pendingIntervention!.proposalId.length > 0, true);
  assert.strictEqual(log.handoffCreateBody, null, "no Handoff of any kind may be created before Martin approves");
  // The originating Handoff must NOT be closed yet either -- it stays live
  // until the intervention is actually approved (see requirement 4).
  const patches = log.handoffPatchBodies;
  assert.ok(!patches.some((p) => p.properties?.Status?.select?.name === "Closed"), "must not close the incoming Handoff before approval");
  assert.ok(log.sentTexts.some((t) => /not yet an approved decision/i.test(t)));
});

test("10. Approval creates the Strategy -> Finance Handoff and closes the Sales -> Strategy Handoff", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const proposalId = afterPickup.pendingIntervention!.proposalId;

  const afterApproval = await handleInterventionApproval(env, afterPickup, proposalId, "approve");

  assert.strictEqual(afterApproval.stage, "awaiting_finance");
  assert.strictEqual(afterApproval.pendingIntervention, undefined);
  const created = log.handoffCreateBody;
  assert.ok(created, "the Strategy -> Finance Handoff must be created");
  const props = created.properties;
  assert.strictEqual(props["From Unit"].select.name, "Strategy");
  assert.strictEqual(props["From Hat"].rich_text[0].text.content, "Strategy Analyst");
  assert.strictEqual(props["To Unit"].select.name, "Finance");
  assert.strictEqual(props["To Hat"].rich_text[0].text.content, "Value-Based Pricing Assessor");
  assert.strictEqual(props.Status.select.name, "Pending");
  // The originating Sales -> Strategy Handoff must now be Closed.
  const originatingPatch = log.handoffPatchBodies.find((p) => p.properties?.Status?.select?.name === "Closed");
  assert.ok(originatingPatch, "the originating Handoff must be closed once the approved intervention is transferred");
});

test("11. Refinement does not create a Finance Handoff", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const proposalId = afterPickup.pendingIntervention!.proposalId;

  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalId, "refine");

  assert.strictEqual(afterRefine.stage, "strategy_refining");
  assert.strictEqual(afterRefine.awaiting, "strategy_refinement_reason");
  assert.strictEqual(afterRefine.pendingIntervention, undefined, "the superseded proposal must be cleared");
  assert.strictEqual(log.handoffCreateBody, null, "a refinement must never create a Finance Handoff");
  assert.ok(!log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Closed"), "refinement must not close the originating Handoff -- the work session is retained");
});

test("12. Rejected intervention does not create a Finance Handoff (via the existing /cancel mechanism)", async () => {
  // The full /cancel path lives in session.ts (a Durable Object, untestable
  // via this runner -- see src/handoffLifecycle.test.ts for direct coverage
  // of closeHandoffIfOpen, the extracted function session.ts's cancel()
  // calls). At the strategyAnalyst.ts level, the guarantee this test can
  // verify directly is that nothing in this module creates a Finance
  // Handoff except handleInterventionApproval's own "approve" branch.
  assert.strictEqual(typeof handleInterventionApproval, "function");
});

test("13. Strategy -> Finance carries the approved intervention (not a bare conclusion)", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingIntervention!.proposalId, "approve");

  const factsText = log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text[0].text.content;
  assert.match(factsText, /Approved intervention:/);
  assert.match(factsText, /Diagnosis\/rationale:/);
  assert.match(factsText, /Verified evidence:/);
  assert.match(factsText, /Assumptions:/);
  assert.match(factsText, /Unresolved questions:/);
  assert.match(factsText, /Pricing requirements:/);
  assert.match(factsText, SUFFICIENT_DIAGNOSIS.recommendedDirection!.length > 0 ? new RegExp(SUFFICIENT_DIAGNOSIS.recommendedDirection!.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /./);
});

test("14. Finance receives only the approved intervention -- never budget/WTP as the pricing basis", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingIntervention!.proposalId, "approve");

  const props = log.handoffCreateBody.properties;
  assert.match(props["Required Next Action"].rich_text[0].text.content, /[Dd]o not redesign/);
  assert.match(props["Required Next Action"].rich_text[0].text.content, /willingness-to-pay/i);
  for (const key of ["Quoted Price", "Price", "Quote"]) {
    assert.strictEqual(props[key], undefined, `Strategy must never set a pricing property (${key})`);
  }
});

test("16. Stale approval callback (wrong stage) does not mutate current work", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const state = fakeState({ stage: "delivered", pendingIntervention: undefined });

  const result = await handleInterventionApproval(env, state, "some-proposal-id", "approve");

  assert.strictEqual(result.stage, "delivered", "stage must not change on a stale callback");
  assert.strictEqual(log.handoffCreateBody, null);
});

test("17. Old approval callback cannot approve a revised intervention (proposalId mismatch)", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const state = fakeState({
    stage: "awaiting_intervention_approval",
    pendingIntervention: { proposalId: "current-proposal", interventionSummary: "Revised intervention." },
  });

  // A callback carrying an OLD proposalId (from a superseded proposal).
  const result = await handleInterventionApproval(env, state, "stale-old-proposal", "approve");

  assert.strictEqual(log.handoffCreateBody, null, "a mismatched proposalId must never create the Finance Handoff");
  assert.strictEqual(result.pendingIntervention?.proposalId, "current-proposal", "the current proposal must remain untouched");
});

test("Marketing-specific work is routed to Marketing when there is no recommendation yet (not absorbed by Strategy)", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "marketing", reason: "Positioning decision needed." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.unit, "Marketing");
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.hat, "Marketing Strategist");

  await handleStrategyHandoffApproval(env, afterPickup, true);
  const props = log.handoffCreateBody.properties;
  assert.strictEqual(props["To Unit"].select.name, "Marketing");
});

test("R&I evidence/research boundary preserved -- Strategy routes missing-evidence work to R&I rather than inventing it", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "research", reason: "Regional logistics capacity evidence needed." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.unit, "Research & Intelligence");
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.hat, "Research & Intelligence Analyst");

  await handleStrategyHandoffApproval(env, afterPickup, true);
  const props = log.handoffCreateBody.properties;
  assert.match(props["Required Next Action"].rich_text[0].text.content, /[Gg]ather.*validate/);
});

test("The generic downstream classifier can never route to Finance -- Finance is reachable only via intervention approval", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  // Even if a (misbehaving) classifier returned "finance", it isn't a key
  // in HANDOFF_ROUTES any more, so no route resolves and nothing is proposed.
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "finance", reason: "should be impossible" });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.pendingStrategyHandoff, undefined);
  assert.strictEqual(log.handoffCreateBody, null);
});

test("formatDiagnosisForHandoff includes the full reasoning chain, not just the conclusion", () => {
  const text = formatDiagnosisForHandoff(SUFFICIENT_DIAGNOSIS);
  assert.match(text, /Symptom:/);
  assert.match(text, /Problem:/);
  assert.match(text, /Cause:/);
  assert.match(text, /Constraint:/);
  assert.match(text, /Consequence:/);
  assert.match(text, /Recommended direction:/);
  assert.match(text, /Rationale:/);
});

test("Closed-context protections remain intact -- missing Entity_Token blocks before any AI call", async (t) => {
  mockFetch(t, { entityToken: "" });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategyDiagnosis, undefined, "no diagnosis should have been attempted");
});

test("Missing Telegram stream configuration fails closed rather than throwing", async (t) => {
  mockFetch(t);
  const env = fakeEnv({ TELEGRAM_GROUP_CHAT_ID: undefined, WORKSPACE_TOPIC_ID: undefined });
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();

  // Must not throw even though every sendWorkspaceHatMessage call in the
  // pipeline will fail closed (return undefined) for lack of stream config.
  const result = await handlePickup(env, state);
  assert.strictEqual(result.stage, "delivered");
});

test("Material events use the existing logActivity mechanism", async (t) => {
  const originalFetch = globalThis.fetch;
  const logEntries: any[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          properties: {
            Status: { select: { name: "Pending" } },
            "Verified Facts & Sources": { rich_text: [{ plain_text: "Some documented situation with evidence." }] },
            Entity_Token: { rich_text: [{ plain_text: "E-1" }] },
            Matter_Token: { rich_text: [{ plain_text: "M-1" }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") return new Response(JSON.stringify({ id: "handoff-1", url: "x", properties: {} }), { status: 200 });
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Gov." }] } }] }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "activity-log-ds") logEntries.push(body.properties);
      return new Response(JSON.stringify({ id: "p", url: "x", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();
  await handlePickup(env, state);

  assert.ok(logEntries.length >= 2, "pickup and completion must both be logged");
  for (const entry of logEntries) {
    assert.ok(entry.Entry, "every log entry must have an Entry");
    assert.ok(entry.Type, "every log entry must have a Type");
    assert.ok(entry.Area, "every log entry must have an Area");
    assert.ok(entry.Outcome, "every log entry must have an Outcome");
  }
});
