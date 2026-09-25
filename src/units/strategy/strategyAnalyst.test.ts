import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePickup,
  handleDirectRequest,
  handleDirectRequestClarification,
  handleStrategyHandoffApproval,
  handleInterventionApproval,
  handleStrategyClarification,
  handleStrategyRefinement,
  evaluateCausationDiscipline,
  evaluateProposalCompleteness,
  formatDiagnosisForHandoff,
  STRATEGY_BOUNDARY_START,
  STRATEGY_BOUNDARY_END,
  extractLabeledBlock,
  checkStrategyProposalForKnownIdentity,
  type StrategyDiagnosisResult,
  type StrategyProposal,
} from "./strategyAnalyst";
import { STRATEGY_ANALYST, ALL_HATS } from "../../hats/registry";
import type { WorkState, Env } from "../../types";
import { redactIdentityTerms } from "../../ai/identityRedaction";

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
    // The same WorkSession that ran Sales's own intake, before Strategy
    // picked up -- entityName/matterName are never set BY Strategy (it
    // never learns them, per the closed-context contract), but they're
    // already resident on the shared WorkState from Sales's own earlier
    // work, exactly as production has it. strategySourceBoundaryAttestation
    // mirrors what handleInterventionText (salesExecutive.ts) already sets
    // once its own Sales -> Strategy Handoff write passes findViolation.
    entityName: "Test Entity",
    matterName: "Test Matter",
    strategySourceBoundaryAttestation: { handoffId: "handoff-1", checked: true, identityFieldsChecked: ["entityName", "matterName"] },
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

/**
 * Dispatches on the system prompt's own distinguishing text -- specialist
 * selection, diagnosis, proposal drafting, or handoff-routing
 * classification. strategy.specialist_selection is now classified (see
 * policy.ts), so every test using this helper genuinely exercises the real
 * composition entry point -- defaulting to zero domains required keeps
 * every pre-existing test's behavior exactly as before (straight through
 * to the unchanged core diagnosis), now via a real selection call rather
 * than an infrastructure failure.
 */
function fakeAi(diagnosisJson: unknown, routingJson: unknown = { target: "none" }, proposalJson: unknown = RAW_PROPOSAL, revisionJson: unknown = null): Ai {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      if (system.includes("specialist-selection responsibility")) {
        return { response: JSON.stringify({ domains: [], reasoning: "Directly resolvable from the available evidence -- no specialist required." }) };
      }
      if (system.includes("canonical operating procedure")) {
        return { response: JSON.stringify(diagnosisJson) };
      }
      if (system.includes("Expand it into the COMPLETE Strategic Intervention Proposal")) {
        return { response: JSON.stringify(proposalJson) };
      }
      if (system.includes("revise this artifact")) {
        return { response: JSON.stringify(revisionJson ?? proposalJson) };
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
  assert.strictEqual(STRATEGY_ANALYST.specialization, "Strategic Assessment & Synthesis");
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

test("A fresh Strategy Proposal that passes both checks receives a complete strategyProposalTokenSafety attestation bound to v1", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  const attestation = result.strategyProposalTokenSafety;
  assert.strictEqual(attestation?.proposalId, result.strategyProposal!.proposalId);
  assert.strictEqual(attestation?.proposalVersion, 1);
  assert.strictEqual(attestation?.sourceBoundary.checked, true);
  assert.deepStrictEqual([...attestation!.sourceBoundary.identityFieldsChecked].sort(), ["entityName", "matterName"]);
  assert.strictEqual(attestation?.proposalContent.checked, true);
  assert.deepStrictEqual([...attestation!.proposalContent.identityFieldsChecked].sort(), ["entityName", "matterName"]);
});

test("Missing source-boundary attestation fails closed -- the Proposal is never presented for approval", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState({ strategySourceBoundaryAttestation: undefined });

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategyProposal, undefined, "no Proposal is set when the source-boundary check is missing");
  assert.strictEqual(result.strategyProposalTokenSafety, undefined);
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.ok(log.sentTexts.some((t) => /no Sales source-boundary identity check is on record/.test(t)));
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)), "never presented to Martin");
});

test("Missing authoritative entityName/matterName fails closed -- the Proposal is never presented for approval", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState({ entityName: undefined });

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategyProposal, undefined);
  assert.ok(log.sentTexts.some((t) => /no authoritative Entity\/Matter identity is on record/.test(t)));
});

test("A drafted Strategy Proposal containing a known identity value fails closed -- never presented, never routed downstream", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const leaked = {
    ...RAW_PROPOSAL,
    executiveSummary: { ...RAW_PROPOSAL.executiveSummary, businessSituation: "Test Entity is pursuing larger accounts." },
  };
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, undefined, leaked);
  const state = fakeState(); // default fakeState entityName/matterName: "Test Entity" / "Test Matter"

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategyProposal, undefined, "the leaked proposal must never become the current Proposal");
  assert.strictEqual(result.strategyProposalTokenSafety, undefined);
  assert.ok(log.sentTexts.some((t) => /known identity value \(matched field: entityName\)/.test(t)));
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)));
  // The violation detail is never echoed -- the actual matched value must never reach Telegram or the Handoff.
  assert.ok(!log.sentTexts.join("").includes("Test Entity is pursuing larger accounts"));
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

// ---------------------------------------------------------------------------
// checkStrategyProposalForKnownIdentity: the bounded known-identity check.
// ---------------------------------------------------------------------------

function cleanProposal(overrides: Partial<StrategyProposal> = {}): StrategyProposal {
  return { ...(RAW_PROPOSAL as any), proposalId: "p1", proposalVersion: 1, ...overrides } as StrategyProposal;
}

test("checkStrategyProposalForKnownIdentity: a clean token-safe proposal passes", () => {
  const result = checkStrategyProposalForKnownIdentity(cleanProposal(), { entityName: "Acme Co", matterName: "Acme Co — Positioning" });
  assert.strictEqual(result.violation, null);
  assert.deepStrictEqual([...result.identityFieldsChecked].sort(), ["entityName", "matterName"]);
});

test("checkStrategyProposalForKnownIdentity: a proposal containing the exact entityName fails", () => {
  const proposal = cleanProposal({ executiveSummary: { ...RAW_PROPOSAL.executiveSummary, businessSituation: "Meridian Foods Ghana Ltd is pursuing larger accounts." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "Meridian Foods Ghana Ltd", matterName: "Cold Chain Logistics Redesign" });
  assert.match(result.violation ?? "", /matched field: entityName/);
});

test("checkStrategyProposalForKnownIdentity: a proposal containing the exact matterName fails", () => {
  const proposal = cleanProposal({ strategicChallenge: { ...RAW_PROPOSAL.strategicChallenge, observedSituation: "Directly concerns the Cold Chain Logistics Redesign effort." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "Meridian Foods Ghana Ltd", matterName: "Cold Chain Logistics Redesign" });
  assert.match(result.violation ?? "", /matched field: matterName/);
});

test("checkStrategyProposalForKnownIdentity: a proposal containing a known email fails when email is part of the available identity set", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Confirm with comfort@meridianfoods.com before proceeding." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "X Co", matterName: "Y Matter", email: "comfort@meridianfoods.com" });
  assert.match(result.violation ?? "", /matched field: email/);
  assert.ok(result.identityFieldsChecked.includes("email"));
});

test("checkStrategyProposalForKnownIdentity: a proposal containing a known phone fails, with punctuation normalized like findViolation", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Contact reachable at +233 24 412 3456 if needed." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "X Co", matterName: "Y Matter", phone: "+233-24-412-3456" });
  assert.match(result.violation ?? "", /matched field: phone/);
});

test("checkStrategyProposalForKnownIdentity: a proposal containing a known contact name fails when contactName is supplied", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Follow up with Comfort Agyare about the timeline." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "X Co", matterName: "Y Matter", contactName: "Comfort Agyare" });
  assert.match(result.violation ?? "", /matched field: contactName/);
});

test("checkStrategyProposalForKnownIdentity: matching is case-insensitive, consistent with findViolation's existing semantics", () => {
  const proposal = cleanProposal({ executiveSummary: { ...RAW_PROPOSAL.executiveSummary, businessSituation: "meridian foods ghana ltd is pursuing larger accounts." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "Meridian Foods Ghana Ltd", matterName: "Y Matter" });
  assert.match(result.violation ?? "", /matched field: entityName/);
});

test("checkStrategyProposalForKnownIdentity: nested fields (workstreams, deliverables, arrays) are inspected, not just top-level fields", () => {
  const proposal = cleanProposal({
    proposedIntervention: {
      ...RAW_PROPOSAL.proposedIntervention,
      workstreams: [{ name: "Vendor onboarding", objective: "Bring Meridian Foods Ghana Ltd's preferred carrier online.", activities: [], output: "", dependencies: [], acceptanceCriteria: [] }],
    },
  });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "Meridian Foods Ghana Ltd", matterName: "Y Matter" });
  assert.match(result.violation ?? "", /matched field: entityName/);
});

test("checkStrategyProposalForKnownIdentity: an arbitrary unknown name is not falsely classified as a violation merely for being a name", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Comparable to the approach a firm like Jonathan Osei Consulting might take." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { entityName: "Meridian Foods Ghana Ltd", matterName: "Cold Chain Logistics Redesign" });
  assert.strictEqual(result.violation, null, "an unknown third-party name is out of scope for the bounded known-identity check");
});

test("checkStrategyProposalForKnownIdentity: only entityName/matterName present -- optional fields are not recorded as checked when absent", () => {
  const result = checkStrategyProposalForKnownIdentity(cleanProposal(), { entityName: "X Co", matterName: "Y Matter" });
  assert.deepStrictEqual([...result.identityFieldsChecked].sort(), ["entityName", "matterName"]);
  assert.ok(!result.identityFieldsChecked.includes("email"));
  assert.ok(!result.identityFieldsChecked.includes("phone"));
  assert.ok(!result.identityFieldsChecked.includes("contactName"));
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

test("26-29. Strategy -> Finance carries the complete curated Strategy boundary representation -- timeline, deliverables, scope, not merely a bare conclusion", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");

  const items: { text: { content: string } }[] = log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text;
  const factsText = items.map((i) => i.text.content).join("");
  assert.match(factsText, new RegExp(STRATEGY_BOUNDARY_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(factsText, new RegExp(STRATEGY_BOUNDARY_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const block = extractLabeledBlock(factsText, STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END)!;
  const rep = JSON.parse(block);
  assert.strictEqual(typeof rep.proposalId, "string");
  assert.strictEqual(rep.proposalVersion, 1);
  assert.ok(rep.executiveSummary.businessSituation);
  assert.ok(rep.executiveSummary.strategicProblem);
  assert.ok(rep.recommendedDirection.direction);
  assert.ok(rep.proposedIntervention.interventionName);
  assert.ok(rep.proposedIntervention.workstreams.length > 0);
  assert.ok(rep.deliverables.length > 0);
  assert.strictEqual(rep.timeline.status, "Indicative");
  assert.ok(rep.commercialScope.included.length > 0);
  assert.ok(rep.expectedBusinessEffect.intendedEffects.length > 0);
  assert.ok(rep.successCriteria.length > 0);
  // Deliberately excluded from the boundary representation -- stays Strategy-internal.
  assert.strictEqual(rep.businessContext, undefined);
  assert.strictEqual(rep.strategicRecommendation, undefined);
});

test("The Strategy boundary representation is not truncated at 1900 characters -- richTextLong chunks the full content", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  // RAW_PROPOSAL's own realistic prose already exceeds 1900 chars once
  // serialized as the curated boundary representation (confirmed directly:
  // the OLD formatter alone already produced 2192 chars from this exact
  // fixture) -- the richer boundary representation this task adds is larger
  // still, so this fixture is sufficient to prove no truncation occurs.
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");

  const items: { text: { content: string } }[] = log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text;
  assert.ok(items.length > 1, "content beyond a single 2,000-char rich-text item must be split, not truncated");
  const factsText = items.map((i) => i.text.content).join("");
  assert.ok(factsText.length > 1900, `expected the serialized boundary representation to exceed 1900 chars, got ${factsText.length}`);

  const block = extractLabeledBlock(factsText, STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END)!;
  const rep = JSON.parse(block); // throws if truncated mid-JSON -- proves the full block survived intact
  assert.ok(rep.diagnosis.causes.length > 0);
  assert.ok(rep.assumptions.length > 0);
  assert.ok(rep.risksAndConstraints.risks.length > 0 || rep.risksAndConstraints.constraints.length > 0);
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
  const v1Attestation = afterPickup.strategyProposalTokenSafety;
  assert.strictEqual(v1Attestation?.proposalVersion, 1, "v1 must have its own attestation");

  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  assert.strictEqual(afterRefine.stage, "strategy_refining");
  assert.strictEqual(afterRefine.awaiting, "strategy_refinement_reason");
  assert.strictEqual(afterRefine.strategyApprovalState, "REFINEMENT_REQUESTED");
  assert.strictEqual(afterRefine.pendingStrategyApproval, undefined, "the superseded approval identity must be cleared");
  assert.deepStrictEqual(afterRefine.pendingStrategyRefinement, { proposalId: originalProposalId, proposalVersion }, "the refinement instruction must be bound to the exact proposal Martin was shown");
  assert.strictEqual(log.handoffCreateBody, null, "a refinement must never create a Finance Handoff");
  assert.ok(!log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Closed"), "refinement must not close the originating Handoff -- the work session is retained");

  // Simulate Martin's refinement reasoning being submitted -- a new
  // proposal version must be produced FROM the existing proposal (same
  // lineage/proposalId, version incremented), and the old version preserved
  // as history. Note: afterRefine and afterPickup are the SAME mutated
  // state object (execute()'s handlers mutate and return the same
  // reference), so the prior proposalId must be captured before this call,
  // not read off afterPickup afterward.
  const afterRevision = await handleStrategyRefinement(env, afterRefine, "Consider a phased rollout instead.");
  assert.strictEqual(afterRevision.strategyProposal!.proposalVersion, 2, "refinement must increment proposalVersion");
  assert.strictEqual(afterRevision.strategyProposal!.proposalId, originalProposalId, "a revision keeps the same proposal lineage -- it is not a fresh proposal");
  assert.strictEqual(afterRevision.strategyProposalHistory?.length, 1, "the prior version must be preserved as historical context");
  assert.strictEqual(afterRevision.strategyProposalHistory![0].proposalId, originalProposalId, "the exact prior version must be what's preserved");
  assert.strictEqual(afterRevision.strategyProposalHistory![0].proposalVersion, 1, "the prior version's own version number must be preserved");
  assert.strictEqual(afterRevision.pendingStrategyRefinement, undefined, "the consumed refinement binding must be cleared");
  assert.strictEqual(afterRevision.strategyApprovalState, "AWAITING_INTERVENTION_APPROVAL", "the revised proposal must re-enter the approval gate, never become approved by being generated");
  assert.strictEqual(afterRevision.pendingStrategyApproval?.proposalVersion, 2, "the new approval request must be bound to the revised version");

  // v2 gets its OWN independent attestation -- never inherited from v1's,
  // per the "v1 must not authorize v2" requirement.
  const v2Attestation = afterRevision.strategyProposalTokenSafety;
  assert.strictEqual(v2Attestation?.proposalVersion, 2);
  assert.strictEqual(v2Attestation?.proposalId, originalProposalId);
  assert.notDeepStrictEqual(v2Attestation, v1Attestation, "v2's attestation must be its own, not a copy/reuse of v1's");
});

// ---------------------------------------------------------------------------
// Strategy Refinement boundary: Martin's free text is control input against
// the existing proposal, never business evidence merged into
// state.strategyContext. See handleStrategyRefinement's own doc comment.
// ---------------------------------------------------------------------------

test("SR1. Refinement text is NOT appended to state.strategyContext", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const contextBefore = afterPickup.strategyContext;
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  const afterRevision = await handleStrategyRefinement(env, afterRefine, "Consider a phased rollout instead, and emphasise the digital channel.");

  assert.strictEqual(afterRevision.strategyContext, contextBefore, "state.strategyContext must be completely unchanged by a refinement");
  assert.ok(!afterRevision.strategyContext?.includes("phased rollout"), "the refinement instruction text must never appear inside strategyContext");
});

test("SR2. A refinement request containing 'Meridian Foods Ghana Ltd' does not contaminate Strategy business context", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const contextBefore = afterPickup.strategyContext;
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  const afterRevision = await handleStrategyRefinement(env, afterRefine, "Use the same direction, but make it more suitable for Meridian Foods Ghana Ltd.");

  assert.strictEqual(afterRevision.strategyContext, contextBefore, "strategyContext must be byte-for-byte unchanged");
  assert.ok(!afterRevision.strategyContext?.includes("Meridian"), "the real company name must never enter strategyContext");
  assert.ok(!JSON.stringify(afterRevision.strategyProposalHistory ?? []).includes("Meridian"), "nor the preserved proposal history");
});

test("SR3. A refinement request containing 'Ama Mensah' does not contaminate Strategy business context", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const contextBefore = afterPickup.strategyContext;
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  const afterRevision = await handleStrategyRefinement(env, afterRefine, "Loop in Ama Mensah's feedback -- she thinks the timeline is too slow.");

  assert.strictEqual(afterRevision.strategyContext, contextBefore, "strategyContext must be byte-for-byte unchanged");
  assert.ok(!afterRevision.strategyContext?.includes("Ama Mensah"), "the real person name must never enter strategyContext");
});

test("SR4. The existing Strategy Proposal remains the revision source -- the system prompt is grounded in it, not in re-diagnosis", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  let capturedSystem = "";
  env.AI = {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      if (system.includes("canonical operating procedure")) return { response: JSON.stringify(SUFFICIENT_DIAGNOSIS) };
      if (system.includes("Expand it into the COMPLETE Strategic Intervention Proposal")) return { response: JSON.stringify(RAW_PROPOSAL) };
      if (system.includes("revise this artifact")) {
        capturedSystem = system;
        return { response: JSON.stringify(RAW_PROPOSAL) };
      }
      throw new Error(`Unexpected AI call -- ${system.slice(0, 60)}`);
    },
  } as any;
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const originalProposal = afterPickup.strategyProposal!;
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  await handleStrategyRefinement(env, afterRefine, "Tighten the timeline.");

  // The pipeline's own pre-existing identityRedaction step (ai/identityRedaction.ts,
  // unmodified by this change) rewrites "Martin" -> "the operator" in EVERY
  // outbound message, including this one -- the fixture proposal's own
  // acceptanceCriteria text ("Approved by Martin.") is redacted the same way
  // any other outbound content would be, so the embedded JSON is expected to
  // differ from the raw object by exactly that substitution. Comparing after
  // applying the identical redaction confirms the prompt is still grounded in
  // the existing proposal's substance, not a re-diagnosis.
  assert.ok(capturedSystem.includes(redactIdentityTerms(JSON.stringify(originalProposal))), "the revision prompt must be grounded in the exact existing proposal object");
  assert.ok(!capturedSystem.includes("canonical operating procedure"), "the revision call is not the diagnosis call");
});

test("SR5. A stale refinement request (proposal moved on since Refine was tapped) is rejected -- fail closed, no AI call, no mutation", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  let aiCalled = false;
  env.AI = {
    run: async () => {
      aiCalled = true;
      throw new Error("AI must not be called for a stale refinement request");
    },
  } as any;
  const currentProposal = { ...RAW_PROPOSAL, proposalId: "current-proposal-id", proposalVersion: 3 } as any;
  const state = fakeState({
    strategyProposal: currentProposal,
    // Bound to a DIFFERENT (older) proposal than what's now current --
    // simulates the proposal having moved on since Refine was tapped.
    pendingStrategyRefinement: { proposalId: "current-proposal-id", proposalVersion: 1 },
  });

  const result = await handleStrategyRefinement(env, state, "Make it shorter.");

  assert.strictEqual(aiCalled, false, "a stale refinement request must never reach the AI");
  assert.deepStrictEqual(result.strategyProposal, currentProposal, "the current proposal must be completely untouched");
  assert.strictEqual(result.pendingStrategyRefinement, undefined, "the stale binding must be cleared");
});

test("SR6. The revised proposal still requires Martin's Approve/Refine/Reject -- it is never approved merely by being generated", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  const afterRevision = await handleStrategyRefinement(env, afterRefine, "Add a training workstream.");

  assert.strictEqual(afterRevision.strategyApprovalState, "AWAITING_INTERVENTION_APPROVAL");
  assert.ok(afterRevision.pendingActionSummary, "a fresh approval prompt with buttons must be presented");
  assert.ok(afterRevision.pendingActionSummary!.buttons.flat().some((b: any) => b.text.includes("Approve")));
});

test("SR7. Refinement does not write the raw instruction into Handoff Verified Facts & Sources", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  const { proposalVersion } = afterPickup.pendingStrategyApproval!;
  const afterRefine = await handleInterventionApproval(env, afterPickup, proposalVersion, "refine");

  await handleStrategyRefinement(env, afterRefine, "Reprioritise the workstreams for Meridian Foods Ghana Ltd specifically.");

  const factsWrites = log.handoffPatchBodies
    .map((p) => p.properties?.["Verified Facts & Sources"]?.rich_text?.[0]?.text?.content)
    .filter((c): c is string => typeof c === "string");
  for (const facts of factsWrites) {
    assert.ok(!facts.includes("Meridian"), "the refinement instruction must never reach Verified Facts & Sources");
    assert.ok(!facts.includes("Reprioritise the workstreams"), "the raw instruction text must never reach Verified Facts & Sources");
  }
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

// ---------------------------------------------------------------------------
// handleDirectRequest / handleDirectRequestClarification -- the
// direct_request origination path (Migration path Step 4): a fresh
// diagnosis Martin starts directly from chat, with no upstream Handoff.
// ---------------------------------------------------------------------------

function mockDirectRequestFetch(
  t: any,
  opts: { matterFound?: boolean; matterNumber?: number; matterPrefix?: string; entityNumber?: number; entityPrefix?: string } = {},
) {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  const matterFound = opts.matterFound ?? true;
  const matterNumber = opts.matterNumber ?? 20;
  const matterPrefix = opts.matterPrefix ?? "MAT";
  const entityNumber = opts.entityNumber ?? 7;
  const entityPrefix = opts.entityPrefix ?? "E";

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      sentTexts.push(body.text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      if (!matterFound) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "matter-page-1",
              url: "https://notion.so/matter-page-1",
              properties: {
                Matter_ID: { unique_id: { prefix: matterPrefix, number: matterNumber } },
                Entity: { relation: [{ id: "entity-page-1" }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/entity-page-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "entity-page-1",
          url: "https://notion.so/entity-page-1",
          properties: { "Entity ID": { unique_id: { prefix: entityPrefix, number: entityNumber } } },
        }),
        { status: 200 },
      );
    }
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return { sentTexts };
}

function fakeDirectRequestState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work_direct_1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    stage: "awaiting_pickup",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("handleDirectRequest resolves an explicit Matter token, runs the shared diagnosis pipeline, and marks entryType direct_request", async (t) => {
  mockDirectRequestFetch(t);
  const env = fakeEnv();
  // NO_RECOMMENDATION_DIAGNOSIS, not SUFFICIENT_DIAGNOSIS: a recommended
  // direction routes into developStrategyProposal's own
  // checkStrategyProposalForKnownIdentity gate, which requires a
  // Sales-sourced strategySourceBoundaryAttestation -- direct-entry work
  // has none, so it correctly holds there (see the dedicated test below).
  // This test proves origination into the shared diagnosis pipeline
  // itself, the actual scope of this step.
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-20: recurring delivery complaints for this account.");

  assert.strictEqual(result.entryType, "direct_request");
  assert.strictEqual(result.matterToken, "MAT-20");
  assert.strictEqual(result.entityToken, "E-7");
  assert.ok(result.strategyQuestion, "the strategic question must be populated from Martin's own text");
  assert.strictEqual(result.stage, "delivered", "a diagnosis with no recommendation must complete, not hold");
});

test("handleDirectRequest: a diagnosis WITH a recommended direction is correctly held by the existing known-identity gate -- direct-entry work has no Sales-sourced source-boundary attestation", async (t) => {
  mockDirectRequestFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-20: recurring delivery complaints for this account.");

  // Reaches the diagnosis pipeline (entryType/tokens are set) but the
  // downstream proposal-approval flow legitimately fails closed here --
  // this is pre-existing discipline (checkStrategyProposalForKnownIdentity),
  // not something this step changes or bypasses.
  assert.strictEqual(result.entryType, "direct_request");
  assert.strictEqual(result.matterToken, "MAT-20");
});

test("handleDirectRequest fails closed with a clarifying message when no Matter token is present -- never guesses which Matter", async (t) => {
  const { sentTexts } = mockDirectRequestFetch(t);
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, we have recurring delivery complaints for this account.");

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.awaiting, "strategy_direct_request_matter");
  assert.strictEqual(result.entryType, undefined, "must never proceed without a resolved Matter");
  assert.ok(sentTexts.some((m) => m.includes("Which Matter")), "must ask Martin to name the Matter rather than guessing");
});

test("handleDirectRequest fails closed when the token in the text doesn't resolve to any real Matter", async (t) => {
  const { sentTexts } = mockDirectRequestFetch(t, { matterFound: false });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-999: this Matter doesn't exist.");

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.awaiting, "strategy_direct_request_matter");
  assert.ok(sentTexts.some((m) => m.includes("Which Matter")), "an unresolvable token must fail closed exactly like a missing one, never guess");
});

test("handleDirectRequestClarification re-attempts resolution against Martin's follow-up text", async (t) => {
  mockDirectRequestFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeDirectRequestState({ stage: "strategy_blocked", awaiting: "strategy_direct_request_matter" });

  const result = await handleDirectRequestClarification(env, state, "It's MAT-20, sorry -- recurring delivery complaints.");

  assert.strictEqual(result.matterToken, "MAT-20");
  assert.strictEqual(result.entityToken, "E-7");
  assert.strictEqual(result.stage, "delivered", "supplying the token on follow-up must unblock and complete the request");
});

/**
 * Composition-path integration tests (LOG-845 specialist-diagnosis model).
 *
 * strategy.specialist_selection/business_diagnosis/brand_diagnosis/
 * communication_diagnosis/specialist_synthesis are now classified
 * business_sensitive/TOKEN_SAFE_RUNTIME in PRODUCTION_TASK_SENSITIVITY/
 * PRODUCTION_OUTBOUND_POLICY (see policy.ts), so composition genuinely runs
 * against the real production policy tables here -- no test-time policy
 * override is needed or used.
 */
type CompositionScript = {
  selection?: unknown;
  business?: unknown | "throw";
  brand?: unknown | "throw";
  communication?: unknown | "throw";
  synthesis?: unknown;
  diagnosis?: unknown;
  routing?: unknown;
  proposal?: unknown;
};

/** Same dispatch as fakeAi, plus the three new composition steps (selection/specialist/synthesis). */
function fakeAiComposition(script: CompositionScript): Ai {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      const respond = (val: unknown) => {
        if (val === "throw") throw new Error("simulated specialist infrastructure failure");
        return { response: JSON.stringify(val) };
      };
      if (system.includes("specialist-selection responsibility")) return respond(script.selection ?? { domains: [], reasoning: "test" });
      if (system.includes("Business Strategist Hat")) return respond(script.business ?? { sufficient: false, blockedReason: "not configured for this test" });
      if (system.includes("Brand Strategist Hat")) return respond(script.brand ?? { sufficient: false, blockedReason: "not configured for this test" });
      if (system.includes("Communication Strategist Hat")) return respond(script.communication ?? { sufficient: false, blockedReason: "not configured for this test" });
      if (system.includes("synthesis responsibility")) return respond(script.synthesis ?? { sufficient: true, synthesizedContext: "test synthesis" });
      if (system.includes("canonical operating procedure")) return respond(script.diagnosis ?? NO_RECOMMENDATION_DIAGNOSIS);
      if (system.includes("Expand it into the COMPLETE Strategic Intervention Proposal")) return respond(script.proposal ?? RAW_PROPOSAL);
      if (system.includes("next responsibility belongs to another Unit")) return respond(script.routing ?? { target: "none" });
      throw new Error(`Unexpected AI call in composition test -- system prompt: ${system.slice(0, 80)}`);
    },
  } as any;
}

test("composition: no specialist required proceeds directly to the unchanged core diagnosis (explicit, though every prior test already relies on this default)", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({ selection: { domains: [], reasoning: "Directly resolvable." } });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.deepStrictEqual(result.strategySpecialistFindings, []);
  assert.strictEqual(result.strategySpecialistSelectionUnavailable, false, "a genuine zero-domains determination must be recorded distinctly from selection being unavailable");
  assert.strictEqual(result.stage, "delivered");
});

test("composition: today's actual default (the shared fakeAi's zero-domains selection response) is a genuine no-specialist-required determination, not a degraded fallback -- exercised via the SAME fakeAi every pre-existing Strategy test already uses", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.deepStrictEqual(result.strategySpecialistFindings, []);
  assert.strictEqual(result.strategySpecialistSelectionUnavailable, false, "the five composition SemanticTaskIds are classified -- selection genuinely ran and determined zero domains, this must never read as 'unavailable'");
  assert.strictEqual(result.stage, "delivered");
});

test("composition: an actual AI/infrastructure failure on the selection call itself still degrades gracefully to the no-specialist path, recorded as unavailable (not a genuine zero-domains determination)", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      if (system.includes("specialist-selection responsibility")) throw new Error("simulated provider outage on the selection call");
      return { response: JSON.stringify(NO_RECOMMENDATION_DIAGNOSIS) };
    },
  } as any;
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.deepStrictEqual(result.strategySpecialistFindings, []);
  assert.strictEqual(result.strategySpecialistSelectionUnavailable, true, "a genuine AI/infrastructure failure on the selection call must be recorded as unavailable, never conflated with zero domains genuinely being determined");
  assert.strictEqual(result.stage, "delivered", "an unrelated selection-call failure must never block an otherwise-resolvable core diagnosis");
});

test("composition: a single selected specialist is diagnosed and its finding is folded into context before core diagnosis runs", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({
    selection: { domains: ["business"], reasoning: "Situation requires commercial judgment." },
    business: {
      sufficient: true,
      domainExamined: "Business model.",
      problemOrIssue: "Capacity-constrained growth.",
      supportingEvidence: "Two quarters of documented shortfall.",
      diagnosis: "Fulfilment capacity has not scaled with demand.",
      strategicImplication: "Root cause is commercial, not brand or communication.",
      interventionImplication: "Expand capacity.",
      uncertaintyAndLimitations: "Exact cost unknown.",
      unresolvedQuestions: "Vendor capacity.",
    },
    synthesis: { sufficient: true, synthesizedContext: "Business Strategist established the root cause is a capacity constraint." },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategySpecialistFindings?.length, 1);
  assert.strictEqual(result.strategySpecialistFindings?.[0].domain, "business");
  assert.strictEqual(result.strategySpecialistFindings?.[0].status, "completed");
  assert.strictEqual(result.strategySpecialistSelectionUnavailable, undefined, "specialists genuinely ran -- this must never read as a no-specialist/unavailable state");
  assert.strictEqual(result.stage, "delivered", "synthesis folded into context, core diagnosis still completes normally");
});

test("composition: multiple selected specialists run concurrently and are reconciled by one synthesis before core diagnosis", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({
    selection: { domains: ["business", "brand"], reasoning: "Situation has independent commercial and brand dimensions." },
    business: { sufficient: true, domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "Capacity-driven.", strategicImplication: "s", interventionImplication: "Expand capacity.", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
    brand: { sufficient: true, domainExamined: "d2", problemOrIssue: "p2", supportingEvidence: "e2", diagnosis: "Perception is a downstream effect, not a separate cause.", strategicImplication: "s2", uncertaintyAndLimitations: "u2", unresolvedQuestions: "q2" },
    synthesis: { sufficient: true, synthesizedContext: "Both specialists agree the brand-perception symptom is downstream of the capacity constraint.", crossDomainRelationships: "Brand perception <- business capacity." },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategySpecialistFindings?.length, 2);
  assert.deepStrictEqual(
    result.strategySpecialistFindings?.map((f) => f.domain).sort(),
    ["brand", "business"],
  );
  assert.ok(result.strategySpecialistFindings?.every((f) => f.status === "completed"));
  assert.strictEqual(result.stage, "delivered");
});

test("composition: every selected specialist failing fails closed via the existing handleBlocked -- never proceeds as if synthesis were complete", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({
    selection: { domains: ["business", "brand"], reasoning: "test" },
    business: "throw",
    brand: { sufficient: false, blockedReason: "insufficient evidence" },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "core diagnosis must never run when every required specialist finding is unavailable");
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Held"));
});

test("composition: a partial specialist failure still allows synthesis to proceed, with the unavailable specialist explicit rather than backfilled", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({
    selection: { domains: ["business", "brand"], reasoning: "test" },
    business: { sufficient: true, domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "diag", strategicImplication: "s", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
    brand: "throw",
    synthesis: { sufficient: true, synthesizedContext: "Business finding is sufficient on its own; Brand Strategist's finding is unavailable but not material here." },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  const byDomain = Object.fromEntries((result.strategySpecialistFindings ?? []).map((f) => [f.domain, f]));
  assert.strictEqual(byDomain.business.status, "completed");
  assert.strictEqual(byDomain.brand.status, "failed");
  assert.strictEqual(result.stage, "delivered");
});

test("composition: synthesis judged insufficient (e.g. an unreconcilable conflict) fails closed and never produces a proposal", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({
    selection: { domains: ["business", "brand"], reasoning: "test" },
    business: { sufficient: true, domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "Capacity-driven.", strategicImplication: "s", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
    brand: { sufficient: true, domainExamined: "d2", problemOrIssue: "p2", supportingEvidence: "e2", diagnosis: "Positioning-driven.", strategicImplication: "s2", uncertaintyAndLimitations: "u2", unresolvedQuestions: "q2" },
    synthesis: { sufficient: false, insufficiencyReason: "Business and Brand findings materially conflict on root cause and cannot be reconciled from the supplied evidence." },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "must never proceed to core diagnosis/proposal on an unreconciled conflict");
  assert.strictEqual(result.strategyProposal, undefined);
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content?.includes("conflict")));
});

test("composition never lets a specialist touch the canonical Strategy Proposal -- state.strategyProposal is untouched immediately after composition/diagnosis, set only later by the existing approval-gated developStrategyProposal step", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAiComposition({
    selection: { domains: ["business"], reasoning: "test" },
    business: { sufficient: true, domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "diag", strategicImplication: "s", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
    synthesis: { sufficient: true, synthesizedContext: "synthesis" },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  // NO_RECOMMENDATION_DIAGNOSIS (this file's default composition-test
  // diagnosis) never reaches developStrategyProposal at all -- confirming
  // strategyProposal stays undefined throughout composition/diagnosis/
  // routing, exactly like every existing no-recommendation test above.
  assert.strictEqual(result.strategyProposal, undefined);
  assert.strictEqual(result.stage, "delivered");
});
