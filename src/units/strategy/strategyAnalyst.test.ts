import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePickup,
  handleStrategyHandoffApproval,
  handleInterventionApproval,
  handleStrategyClarification,
  handleStrategyRefinement,
  evaluateCausationDiscipline,
  evaluateProposalCompleteness,
  formatDiagnosisForHandoff,
  type StrategyDiagnosisResult,
  type StrategyProposal,
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

const RAW_PROPOSAL = {
  executiveSummary: {
    businessSituation: "Recurring late-delivery complaints over two quarters.",
    strategicProblem: "Delivery reliability is degrading due to a capacity constraint, threatening the largest account.",
    recommendedDirection: "Expand interim delivery capacity via a third-party logistics partner within the quarter.",
    proposedIntervention: "Third-party logistics capacity expansion programme.",
    expectedBusinessEffect: "Restored delivery reliability and reduced churn risk on the largest account.",
    decisionRequired: "Approve, refine, or reject this proposed intervention.",
  },
  businessContext: {
    entityContext: "Existing client, two quarters of documented delivery issues.",
    businessObjectives: "Restore reliable delivery within the quarter.",
    relevantMarketContext: "Regional logistics capacity is tight but available via third parties.",
    relevantAudienceOrCustomerContext: "Largest account, high churn sensitivity.",
    currentState: "Missed delivery windows for two consecutive quarters.",
    engagementTrigger: "Sales call notes documenting the complaints.",
    relevantCommercialContext: "Account represents material recurring revenue.",
    evidence: ["Sales call notes, two quarters of delivery data referenced therein."],
  },
  strategicChallenge: {
    businessObjective: "Restore reliable delivery.",
    observedSituation: "Two consecutive quarters of missed delivery windows.",
    strategicQuestion: "How to restore delivery reliability given fixed warehouse capacity.",
    whyItMatters: "This account represents material recurring revenue.",
  },
  diagnosis: {
    symptom: "Late delivery complaints.",
    problem: "Delivery reliability has degraded for the largest account.",
    causes: ["Warehouse capacity constraint documented in call notes for two consecutive quarters."],
    constraints: ["Warehouse capacity fixed through year-end."],
    consequences: ["Client trust erosion, churn risk."],
    evidence: ["Sales call notes."],
    diagnosticConclusion: "The capacity constraint is the documented driver of the delivery degradation.",
  },
  strategicOpportunity: {
    opportunity: "Restore reliability ahead of competitors facing the same regional constraint.",
    basis: "Third-party logistics capacity is available now.",
    relevanceToBusinessObjective: "Directly restores the objective.",
    opportunityConditions: ["Partner onboarded within 30 days."],
  },
  strategicObjective: {
    objective: "Restore delivery reliability within the quarter.",
    intendedChange: "Eliminate missed delivery windows for the affected account.",
    businessAlignment: "Protects material recurring revenue.",
    measurementDirection: "Reduction in missed delivery windows.",
  },
  recommendedDirection: {
    direction: "Expand interim delivery capacity via a third-party logistics partner within the quarter.",
    rationale: "Directly addresses the documented capacity constraint within the client's tolerance window.",
    strategicLogic: "Fastest lever given fixed warehouse capacity through year-end.",
    alternativesConsidered: ["Internal capacity expansion (rejected -- not deliverable within the quarter)."],
    selectionBasis: "Speed and directness of fit to the documented constraint.",
  },
  proposedIntervention: {
    interventionName: "Third-party logistics capacity expansion",
    interventionSummary: "Onboard a third-party logistics partner to absorb overflow delivery volume.",
    workstreams: [
      {
        name: "Partner onboarding",
        objective: "Secure and onboard a capable third-party logistics partner.",
        activities: ["Shortlist partners", "Negotiate terms", "Integrate operationally"],
        output: "Operational third-party logistics partner.",
        dependencies: ["Client sign-off on added cost."],
        acceptanceCriteria: ["Partner live and receiving overflow volume within 30 days."],
      },
    ],
  },
  deliverables: [
    { name: "Partner onboarding plan", description: "Step-by-step onboarding plan.", format: "Document", acceptanceCriteria: ["Approved by Martin."] },
  ],
  timeline: {
    status: "Indicative",
    totalDuration: "Approximately 4-6 weeks, indicative.",
    phases: [
      { name: "Partner selection", duration: "2 weeks", activities: ["Shortlist", "Negotiate"], outputs: ["Signed terms"], dependencies: [], reviewPoint: "End of week 2" },
    ],
  },
  entityInputs: {
    requiredInformation: ["Current delivery volumes by region."],
    requiredDocuments: [],
    requiredAccess: [],
    requiredStakeholderParticipation: ["Operations lead."],
    requiredDecisions: ["Approval of added third-party cost."],
  },
  assumptions: [{ assumption: "Third-party logistics partner has available capacity.", basis: "Preliminary market scan.", materiality: "High -- the plan depends on it." }],
  dependencies: [{ dependency: "Client sign-off on added cost.", owner: "Client", impactIfUnavailable: "Programme cannot proceed as scoped." }],
  risksAndConstraints: {
    risks: [{ risk: "Vendor reliability unverified.", potentialEffect: "Delivery issues persist.", mitigationOrResponse: "Phased onboarding with review gate." }],
    constraints: [{ constraint: "Warehouse capacity fixed through year-end.", implication: "Internal expansion is not viable this quarter." }],
  },
  expectedBusinessEffect: {
    intendedEffects: ["Restored delivery reliability."],
    measurableEffects: ["Reduction in missed delivery windows."],
    effectsRequiringBaseline: ["Churn rate change."],
    limitations: ["Exact churn probability if unresolved is not established."],
  },
  successCriteria: [{ criterion: "No missed delivery windows for the account.", measurement: "Monthly delivery log.", evidenceRequired: "Operations delivery records." }],
  commercialScope: {
    included: ["Third-party partner onboarding", "Operational integration"],
    excluded: ["Warehouse capital expansion"],
    expectedResources: ["Operations lead time", "Third-party partner fees"],
    expectedDuration: "4-6 weeks",
    clientResponsibilities: ["Sign-off on added cost."],
    downstreamUnitResponsibilities: ["Finance to price the engagement."],
  },
  strategicRecommendation: {
    recommendation: "Expand interim delivery capacity via a third-party logistics partner within the quarter.",
    rationale: "Directly addresses the documented capacity constraint within the client's tolerance window.",
    evidenceBasis: ["Sales call notes, two quarters of delivery data referenced therein."],
    conditionsOfApproval: ["Partner onboarded within 30 days."],
  },
};

/** Dispatches on the system prompt's own distinguishing text -- diagnosis vs. proposal drafting vs. handoff-routing classification. */
function fakeAi(diagnosisJson: unknown, routingJson: unknown = { target: "none" }, proposalJson: unknown = RAW_PROPOSAL): Ai {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      if (system.includes("canonical operating procedure")) {
        return { response: JSON.stringify(diagnosisJson) };
      }
      if (system.includes("Expand it into the COMPLETE Strategic Intervention Proposal")) {
        return { response: JSON.stringify(proposalJson) };
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
  opts: { verifiedFacts?: string; entityToken?: string; matterToken?: string; initialStatus?: string; requiredNextAction?: string } = {},
): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = { handoffPatchBodies: [], handoffCreateBody: null, sentTexts: [], sentButtons: [] };
  const verifiedFacts = opts.verifiedFacts ?? "Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.";
  const entityToken = opts.entityToken ?? "E-47";
  const matterToken = opts.matterToken ?? "M-12";
  const initialStatus = opts.initialStatus ?? "Pending";
  const requiredNextAction = opts.requiredNextAction ?? "";

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
            "Required Next Action": { rich_text: [{ plain_text: requiredNextAction }] },
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

test("Required Next Action content is folded into the diagnosis context, not silently ignored", async (t) => {
  // Regression test for a live incident: a human returned a Held Handoff
  // to Pending directly in Notion, writing detailed refinement guidance
  // into Required Next Action (the field a person naturally edits) rather
  // than through the bot's own Telegram reply flow (which appends to
  // Verified Facts & Sources instead). resolveStrategyHandoffContext only
  // ever read Verified Facts & Sources/Reason, so the guidance was never
  // seen and re-diagnosis reproduced the identical Held outcome.
  mockFetch(t, { requiredNextAction: "Re-run the diagnosis using evidence-bounded framing: do not assert an unproven causal link to lost revenue." });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.match(result.strategyContext ?? "", /evidence-bounded framing/, "guidance written into Required Next Action must reach the diagnosis input");
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

test("9. A recommended diagnosis develops a full Strategic Intervention Proposal requiring Martin approval -- no Finance Handoff auto-created", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "awaiting_intervention_approval");
  assert.strictEqual(result.strategyApprovalState, "AWAITING_INTERVENTION_APPROVAL");
  assert.ok(result.strategyProposal, "a strategyProposal must be set");
  assert.strictEqual(result.strategyProposal!.proposalVersion, 1);
  assert.ok(result.pendingStrategyApproval, "a pendingStrategyApproval must be set");
  assert.strictEqual(result.pendingStrategyApproval!.proposalId, result.strategyProposal!.proposalId);
  assert.strictEqual(result.pendingStrategyApproval!.proposalVersion, 1);
  assert.deepStrictEqual(result.pendingStrategyApproval!.decisionOptions, ["approve", "refine", "reject"]);
  assert.strictEqual(log.handoffCreateBody, null, "no Handoff of any kind may be created before Martin approves");
  // The originating Handoff must NOT be closed yet either -- it stays live
  // (Picked-up) until the intervention is actually approved.
  const patches = log.handoffPatchBodies;
  assert.ok(!patches.some((p) => p.properties?.Status?.select?.name === "Closed"), "must not close the incoming Handoff before approval");
  assert.ok(log.sentTexts.some((t) => /not yet an approved decision/i.test(t)));
  assert.ok(log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)));
});

test("Proposal contains every required structural section", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);
  const p = result.strategyProposal as StrategyProposal;

  assert.ok(p.strategicObjective.objective, "must contain a strategic objective");
  assert.ok(p.recommendedDirection.direction, "must contain a recommended direction");
  assert.ok(p.proposedIntervention.workstreams.length > 0, "must contain intervention workstreams");
  assert.ok(p.deliverables.length > 0, "must contain deliverables");
  assert.ok(p.timeline.totalDuration, "must contain a timeline");
  assert.ok(["Indicative", "Confirmed"].includes(p.timeline.status));
  assert.ok(p.commercialScope.included.length > 0, "must contain scope boundaries");
  assert.ok(p.assumptions.length > 0, "must contain assumptions");
  assert.ok(p.dependencies.length > 0, "must contain dependencies");
  assert.ok(p.risksAndConstraints.risks.length > 0 || p.risksAndConstraints.constraints.length > 0, "must contain risks/constraints");
  assert.ok(p.expectedBusinessEffect.intendedEffects.length > 0, "must contain expected business effects");
  assert.ok(p.successCriteria.length > 0, "must contain success criteria");
});

test("evaluateProposalCompleteness: accepts a fully-populated proposal", () => {
  const proposal = { ...(RAW_PROPOSAL as any), proposalId: "p1", proposalVersion: 1 };
  const result = evaluateProposalCompleteness(proposal);
  assert.strictEqual(result.valid, true);
});

test("evaluateProposalCompleteness: rejects a proposal missing required sections (workstreams, deliverables, success criteria)", () => {
  const proposal = {
    ...(RAW_PROPOSAL as any),
    proposalId: "p1",
    proposalVersion: 1,
    proposedIntervention: { ...RAW_PROPOSAL.proposedIntervention, workstreams: [] },
    deliverables: [],
    successCriteria: [],
  };
  const result = evaluateProposalCompleteness(proposal);
  assert.strictEqual(result.valid, false);
  if (!result.valid) {
    assert.match(result.reason, /intervention workstreams/);
    assert.match(result.reason, /deliverables/);
    assert.match(result.reason, /success criteria/);
  }
});

test("An incomplete AI-drafted proposal is held (not presented for approval) -- the deterministic completeness check overrides the AI's own JSON output", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const incompleteProposal = {
    ...RAW_PROPOSAL,
    proposedIntervention: { ...RAW_PROPOSAL.proposedIntervention, workstreams: [] },
    deliverables: [],
    successCriteria: [],
  };
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, { target: "none" }, incompleteProposal);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked", "an incomplete proposal must be held, not presented for approval");
  assert.strictEqual(result.awaiting, "strategy_clarification");
  assert.strictEqual(result.strategyProposal, undefined, "no proposal should be adopted into state on a completeness failure");
  assert.strictEqual(result.pendingStrategyApproval, undefined);
  const heldPatch = lastHandoffPatch(log);
  assert.strictEqual(heldPatch.properties.Status.select.name, "Held");
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /missing required section/i);
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)), "the incomplete proposal must never reach the approval preview");
});

test("10. Approval creates the Strategy -> Finance Handoff and closes the Sales -> Strategy Handoff", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;

  const afterApproval = await handleInterventionApproval(env, afterPickup, proposalVersion, "approve");

  assert.strictEqual(afterApproval.stage, "awaiting_finance");
  assert.strictEqual(afterApproval.strategyApprovalState, "APPROVED");
  assert.strictEqual(afterApproval.pendingStrategyApproval, undefined);
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
  assert.ok(originatingPatch, "the originating Handoff must be closed once the approved proposal is transferred");
  assert.strictEqual(afterApproval.pendingHandoffAutoCheck, true, "successful Strategy -> Finance Handoff creation must automatically invoke the existing /checkhandoffs path");
});

test("18. Strategy -> Finance creates a token-only Handoff -- Entity_Token/Matter_Token carry exactly what the originating Handoff supplied, never a real name", async (t) => {
  const log = mockFetch(t, { entityToken: "E-47", matterToken: "M-12" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.strictEqual(afterPickup.entityToken, "E-47");
  assert.strictEqual(afterPickup.matterToken, "M-12");

  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");

  const props = log.handoffCreateBody.properties;
  assert.strictEqual(props.Entity_Token.rich_text[0].text.content, "E-47");
  assert.strictEqual(props.Matter_Token.rich_text[0].text.content, "M-12");
});

test("26-29. Strategy -> Finance carries the complete approved proposal -- timeline, deliverables, scope, not merely a bare conclusion", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");

  const factsText = log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text[0].text.content;
  assert.match(factsText, /Business situation:/);
  assert.match(factsText, /Strategic problem:/);
  assert.match(factsText, /Approved recommended direction:/);
  assert.match(factsText, /Approved intervention:/);
  assert.match(factsText, /Workstreams:/);
  assert.match(factsText, /Deliverables:/);
  assert.match(factsText, /Timeline \(Indicative\):/);
  assert.match(factsText, /Commercial scope:/);
  assert.match(factsText, /Expected business effect:/);
  assert.match(factsText, /Success criteria:/);
});

test("30. Finance cannot receive an unapproved proposal -- never budget/WTP as the pricing basis", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");

  const props = log.handoffCreateBody.properties;
  assert.match(props["Required Next Action"].rich_text[0].text.content, /redesign/i);
  assert.match(props["Required Next Action"].rich_text[0].text.content, /willingness-to-pay/i);
  for (const key of ["Quoted Price", "Price", "Quote"]) {
    assert.strictEqual(props[key], undefined, `Strategy must never set a pricing property (${key})`);
  }
});

test("11/21/22. Refine does not create a Finance Handoff, and a new proposal version increments proposalVersion", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const originalProposalId = afterPickup.strategyProposal!.proposalId;

  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  assert.strictEqual(afterRefine.stage, "strategy_refining");
  assert.strictEqual(afterRefine.awaiting, "strategy_refinement_reason");
  assert.strictEqual(afterRefine.strategyApprovalState, "REFINEMENT_REQUESTED");
  assert.strictEqual(afterRefine.pendingStrategyApproval, undefined, "the superseded approval identity must be cleared");
  assert.strictEqual(log.handoffCreateBody, null, "a refinement must never create a Finance Handoff");
  assert.ok(!log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Closed"), "refinement must not close the originating Handoff -- the work session is retained");

  // Simulate Martin's refinement reasoning being submitted -- a new
  // proposal version must be produced and the old one preserved as history.
  // Note: afterRefine and afterPickup are the SAME mutated state object
  // (execute()'s handlers mutate and return the same reference), so the
  // prior proposalId must be captured before this call, not read off
  // afterPickup afterward.
  const afterRevision = await handleStrategyRefinement(env, afterRefine, "Consider a phased rollout instead.");
  assert.strictEqual(afterRevision.strategyProposal!.proposalVersion, 2, "refinement must increment proposalVersion");
  assert.strictEqual(afterRevision.strategyProposalHistory?.length, 1, "the prior version must be preserved as historical context");
  assert.strictEqual(afterRevision.strategyProposalHistory![0].proposalId, originalProposalId, "the exact prior version must be what's preserved");
  assert.notStrictEqual(afterRevision.strategyProposal!.proposalId, originalProposalId, "a fresh proposalId must be minted for the revision");
});

test("12/25. Reject records the rejection, closes the current attempt, and creates no Finance Handoff", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;

  const afterReject = await handleInterventionApproval(env, afterPickup, proposalVersion, "reject");

  assert.strictEqual(afterReject.stage, "strategy_rejected");
  assert.strictEqual(afterReject.strategyApprovalState, "REJECTED");
  assert.strictEqual(afterReject.pendingStrategyApproval, undefined);
  assert.strictEqual(log.handoffCreateBody, null, "rejection must never create a Finance Handoff");
  const closedPatch = log.handoffPatchBodies.find((p) => p.properties?.Status?.select?.name === "Closed");
  assert.ok(closedPatch, "the current strategic attempt (originating Handoff) must be closed on rejection");
  assert.notStrictEqual(afterReject.pendingHandoffAutoCheck, true, "no Handoff was queued, so the /checkhandoffs continuation must not be invoked");
});

test("23. Old approval callback (superseded proposal version) cannot approve a revised proposal", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const proposalV2: StrategyProposal = {
    ...(RAW_PROPOSAL as any),
    proposalId: "current-proposal",
    proposalVersion: 2,
  };
  const state = fakeState({
    stage: "awaiting_intervention_approval",
    strategyApprovalState: "AWAITING_INTERVENTION_APPROVAL",
    strategyProposal: proposalV2,
    pendingStrategyApproval: {
      kind: "strategy_intervention",
      strategyWorkSessionId: "work_strat_1",
      proposalId: "current-proposal",
      proposalVersion: 2,
      decisionOptions: ["approve", "refine", "reject"],
    },
  });

  // A callback carrying an OLD version (1) -- simulating a stale button
  // from before Refine produced v2. Only proposalVersion travels through
  // the actual Telegram callback (see the byte-limit test below), so this
  // is the operative staleness check.
  const result = await handleInterventionApproval(env, state, 1, "approve");

  assert.strictEqual(log.handoffCreateBody, null, "a version-mismatched callback must never create the Finance Handoff");
  assert.strictEqual(result.pendingStrategyApproval?.proposalVersion, 2, "the current pending approval must remain untouched");
});

test("24. Stale approval callback (wrong stage) does not mutate current work", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const state = fakeState({ stage: "delivered", strategyApprovalState: undefined, pendingStrategyApproval: undefined });

  const result = await handleInterventionApproval(env, state, 1, "approve");

  assert.strictEqual(result.stage, "delivered", "stage must not change on a stale callback");
  assert.strictEqual(log.handoffCreateBody, null);
});

test("17. A callback for a completed/superseded session (no matching pendingStrategyApproval at all) is a no-op", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  // Simulates a callback arriving after the session moved on (e.g. already
  // approved and awaiting Finance) -- pendingStrategyApproval/strategyProposal
  // are already cleared, so there is nothing for any version number to match.
  const state = fakeState({
    stage: "awaiting_finance",
    strategyApprovalState: "APPROVED",
    strategyProposal: undefined,
    pendingStrategyApproval: undefined,
  });

  const result = await handleInterventionApproval(env, state, 1, "approve");

  assert.strictEqual(log.handoffCreateBody, null, "a callback for a completed/superseded session must never create the Finance Handoff");
  assert.strictEqual(result.stage, "awaiting_finance", "the completed session's state must not be disturbed");
});

test("Telegram callback_data byte-limit regression: every strategy-proposal button stays within Telegram's hard 64-byte limit", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  // A realistic-length workId (crypto.randomUUID() shape, 36 chars) -- the
  // actual production failure this test guards against: the prior
  // callback_data format embedded a second full UUID (proposalId)
  // alongside workId and silently exceeded 64 bytes, causing Telegram to
  // reject the entire message (buttons included) with no visible error.
  const state = fakeState({ workId: "a1b2c3d4-e5f6-47a8-89ab-cdef01234567" });

  const result = await handlePickup(env, state);
  assert.ok(result.pendingStrategyApproval, "a pendingStrategyApproval must be set for this test to be meaningful");

  const buttonRows = state.pendingActionSummary!.buttons;
  for (const row of buttonRows) {
    for (const button of row) {
      const byteLength = Buffer.byteLength(button.callback_data, "utf8");
      assert.ok(byteLength <= 64, `callback_data "${button.callback_data}" is ${byteLength} bytes, exceeding Telegram's 64-byte limit`);
    }
  }
});

test("Marketing-specific work is routed to Marketing when there is no recommendation yet (not absorbed by Strategy)", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "marketing", reason: "Positioning decision needed." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.unit, "Marketing");
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.hat, "Marketing Strategist");

  const afterApproval = await handleStrategyHandoffApproval(env, afterPickup, true);
  const props = log.handoffCreateBody.properties;
  assert.strictEqual(props["To Unit"].select.name, "Marketing");
  assert.strictEqual(props.Entity_Token.rich_text[0].text.content, "E-47");
  assert.strictEqual(props.Matter_Token.rich_text[0].text.content, "M-12");
  assert.strictEqual(afterApproval.pendingHandoffAutoCheck, true, "successful Strategy -> downstream Handoff creation must automatically invoke the existing /checkhandoffs path");
});

test("Strategy -> downstream: a failed Handoff creation must not invoke the /checkhandoffs continuation", async (t) => {
  mockFetch(t, {}); // baseline mock, then override POST /pages to fail for this test
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "marketing", reason: "Positioning decision needed." });
  const state = fakeState();
  const afterPickup = await handlePickup(env, state);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/pages") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        return new Response("simulated failure", { status: 500 });
      }
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  try {
    const afterApproval = await handleStrategyHandoffApproval(env, afterPickup, true);
    assert.notStrictEqual(afterApproval.pendingHandoffAutoCheck, true, "a failed Handoff creation must not invoke the /checkhandoffs continuation");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("39. The generic downstream classifier can never route to Finance -- Finance is reachable only via the Approve gate", async (t) => {
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

test("36/37/38. Closed-context protections remain intact -- missing Entity_Token blocks before any AI call", async (t) => {
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
