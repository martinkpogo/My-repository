import test from "node:test";
import assert from "node:assert/strict";
import { handleInterventionText } from "./units/sales/salesExecutive";
import { handlePickup, type StrategyDiagnosisResult } from "./units/strategy/strategyAnalyst";
import { strategyManifest } from "./units/strategy/strategyManifest";
import { createResolvedActionSkillSet, resolveSkill, type ResolvedActionSkillSet } from "./platform/skillRegistry";
import { parseSourceBoundaryMarker } from "./handoffWriter";
import { parseCommercialValueEvidenceBlock } from "./handoffContracts/commercialValueEvidence";
import type { Env, WorkState } from "./types";

/**
 * The Sales -> Strategy seam, exercised end to end through BOTH real
 * implementations on ONE WorkSession.
 *
 * Phase 1 runs the real Sales Handoff writer (handleInterventionText ->
 * createHandoff) and captures the exact Notion properties it POSTs. Phase 2
 * materializes THAT captured record as the page the real Strategy pickup
 * (handlePickup) claims and reads -- the same mocked Handoff, never a
 * hand-built fixture. Everything crosses the seam through the production
 * property shapes: write shape at creation, read shape (plain_text) at
 * consumption, converted here exactly as the Notion API itself converts a
 * written record into a readable page.
 *
 * What this proves where the per-unit tests cannot:
 *   - the durable source-boundary marker AND Commercial Value Evidence block
 *     the real writer writes parse with the REAL parsers Strategy consumes
 *     (an unparseable one blocks before any AI call -- WP2a/WP2b);
 *   - the cross-unit record carries tokens only (E-47/M-12), never the real
 *     Entity/Matter/contact/email/phone identity the Sales state holds;
 *   - the pickup claims the record (Pending -> Picked-up), resolves the
 *     writer's Matter token, and reaches Martin's approval lifecycle with the
 *     incoming Handoff still open;
 *   - Martin's approval is still the only thing that could create the next
 *     Handoff: none exists after pickup.
 *
 * TEST-ONLY by scope: no production file is touched, nothing here runs
 * outside this mocked world, and it does NOT make the workflow MVP -- MVP
 * still requires one real quote request through all four governed Handoff
 * legs (Sales -> Strategy -> Finance -> Sales) on live records.
 */

/** The id this mock returns when the real Sales writer creates the Handoff; Phase 2 reads that same record back. */
const CREATED_HANDOFF_ID = "handoff-page-1";

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
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
    ...overrides,
  };
}

interface FetchLog {
  /** Every Handoff create the real Sales writer POSTed -- exactly one, ever. */
  handoffCreateBodies: any[];
  /** Every PATCH against the Handoff record: the pickup claim (and nothing closing it early). */
  handoffPatchBodies: any[];
  matterPatchBodies: any[];
  /** Every matters-ds query: token resolution must run on the writer's own Matter token. */
  matterQueryBodies: any[];
  activityLogBodies: any[];
  sentTexts: string[];
  sentButtons: any[];
  requests: string[];
}

/**
 * Converts Notion WRITE shape (`{ text: { content } }` items, as createHandoff
 * POSTs) into Notion READ shape (`{ plain_text }` items, as a GET returns) --
 * the same transformation the Notion API performs between writing a record
 * and serving it back. plainText (src/notion.ts) reads plain_text only, so
 * every read Strategy performs goes through exactly this conversion.
 */
function toReadShape(properties: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value && Array.isArray(value.rich_text)) {
      out[key] = { rich_text: value.rich_text.map((item: any) => ({ plain_text: item?.text?.content ?? item?.plain_text ?? "" })) };
    } else if (value && Array.isArray(value.title)) {
      out[key] = { title: value.title.map((item: any) => ({ plain_text: item?.text?.content ?? item?.plain_text ?? "" })) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function plainJoined(prop: any): string {
  return (prop?.rich_text ?? []).map((item: any) => item?.plain_text ?? "").join("");
}

function selectName(prop: any): string {
  return prop?.select?.name ?? "";
}

/** One mock world serving BOTH phases: every route salesExecutive.test.ts proves the writer uses, plus every route strategyAnalyst.test.ts proves the pickup uses. Anything else throws, so an unaccounted external call fails the test loudly. */
function mockFetch(t: any): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = {
    handoffCreateBodies: [],
    handoffPatchBodies: [],
    matterPatchBodies: [],
    matterQueryBodies: [],
    activityLogBodies: [],
    sentTexts: [],
    sentButtons: [],
    requests: [],
  };

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    log.requests.push(`${method} ${urlStr}`);

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      log.sentTexts.push(body.text ?? "");
      if (body.reply_markup) log.sentButtons.push(body.reply_markup.inline_keyboard);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }

    // Standalone governance page (Hat Definition / Universal Role Contract):
    // parent is a page, not a data source -- how it resolves to "no governed
    // target" (getGovernance at pickup).
    if (method === "GET" && /\/pages\/[0-9a-f-]{32,36}$/i.test(new URL(urlStr).pathname)) {
      return new Response(
        JSON.stringify({ id: urlStr.split("/").pop(), url: urlStr, parent: { type: "page", page_id: "governance-root" }, properties: {} }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/entity-page-1") && method === "GET") {
      return new Response(
        JSON.stringify({ id: "entity-page-1", url: "https://notion.so/entity-page-1", parent: { type: "data_source_id", data_source_id: "entity-ds" }, properties: { Entity_ID: { unique_id: { prefix: "E", number: 47 } } } }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "GET") {
      return new Response(
        JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", parent: { type: "data_source_id", data_source_id: "matters-ds" }, properties: { Matter_ID: { unique_id: { prefix: "M", number: 12 } }, Entity: { relation: [{ id: "entity-page-1" }] } } }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "PATCH") {
      log.matterPatchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", parent: { type: "data_source_id", data_source_id: "matters-ds" }, properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      log.matterQueryBodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "matter-page-1",
              url: "https://notion.so/matter-page-1",
              parent: { type: "data_source_id", data_source_id: "matters-ds" },
              properties: {
                Matter_ID: { unique_id: { prefix: "M", number: 12 } },
                Entity: { relation: [{ id: "entity-page-1" }] },
                // The Matter's own operational Status -- the pickup's guarded
                // advance reads it in this same query (canonical precondition).
                Status: { select: { name: "Qualified" } },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith(`/pages/${CREATED_HANDOFF_ID}`) && method === "GET") {
      if (log.handoffCreateBodies.length === 0) {
        throw new Error("The Handoff record was requested before the Sales writer created it -- Phase 1 must run first");
      }
      return new Response(
        JSON.stringify({
          id: CREATED_HANDOFF_ID,
          url: `https://notion.so/${CREATED_HANDOFF_ID}`,
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          // THE seam: the page Strategy reads IS the properties Sales wrote.
          properties: toReadShape(log.handoffCreateBodies[0].properties),
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith(`/pages/${CREATED_HANDOFF_ID}`) && method === "PATCH") {
      log.handoffPatchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: CREATED_HANDOFF_ID, url: `https://notion.so/${CREATED_HANDOFF_ID}`, parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} }), { status: 200 });
    }
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        log.handoffCreateBodies.push(body);
        return new Response(JSON.stringify({ id: CREATED_HANDOFF_ID, url: `https://notion.so/${CREATED_HANDOFF_ID}`, parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} }), { status: 200 });
      }
      // Everything else the writer logs is an Activity Log append.
      log.activityLogBodies.push(body);
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in integration test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return log;
}

/**
 * The Sales-side state exactly as salesExecutive.test.ts builds it for
 * handleInterventionText, with a DISTINCTIVE real-looking identity on every
 * known-identity field -- so the token-only assertions below fail loudly if
 * any of it ever reaches the cross-unit record.
 */
function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work_integration_1",
    chatId: 1,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "new_enquiry",
    stage: "awaiting_intervention",
    awaiting: "intervention",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entityId: "entity-page-1",
    entityName: "Northwind Traders GmbH",
    matterId: "matter-page-1",
    matterName: "Northwind Traders GmbH — Rebrand",
    enquiryText: "We're rebranding our stores and packaging -- can you help us reposition?",
    entryType: "inbound_enquiry",
    entityDraft: { type: "Individual", name: "Johanna Weiss", email: "johanna@northwind-traders.example", phone: "+49 30 55501234" },
    ...overrides,
  };
}

/**
 * The Skill set Strategy's own `diagnose` Action declares, resolved from the
 * manifest's OWN `skill_requirements` (same construction as
 * strategyAnalyst.test.ts): a change to that declaration is visible here
 * immediately, and this test exercises the real declared Skill set rather
 * than a hand-built stand-in.
 */
const STRATEGY_SKILLS: ResolvedActionSkillSet = createResolvedActionSkillSet(
  (strategyManifest.hats["Strategy Analyst"].actions.find((action) => action.name === "diagnose")?.skill_requirements ?? []).map((requirement) =>
    resolveSkill(requirement.skill_id),
  ),
);

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


function fakeAi(diagnosisJson: unknown, routingJson: unknown = { target: "none" }, proposalJson: unknown = RAW_PROPOSAL, revisionJson: unknown = null): Ai {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      // Strategy Analysis's one planning call. An empty plan is the everyday
      // case: Strategy Analysis judged the supplied evidence sufficient on its
      // own, so no bounded domain Skill is invoked at all.
      if (system.includes("This call plans the diagnosis once")) {
        return { response: JSON.stringify({ interpretation: "Directly resolvable from the available evidence.", plan: [], rationale: "No domain method is required." }) };
      }
      if (system.includes("reconciling the bounded Strategy Skill findings")) {
        return { response: JSON.stringify({ sufficient: true, synthesizedContext: "test synthesis" }) };
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

test("Sales -> Strategy seam: the real writer's Handoff record is claimed and read by the real pickup — tokens only, provenance parses, approval still required", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();

  // ---------- Phase 1: the REAL Sales Handoff writer ----------
  const salesState = fakeState();
  const afterSales = await handleInterventionText(env, salesState, "Rebrand the storefront and packaging.");

  assert.equal(log.handoffCreateBodies.length, 1, "the Sales -> Strategy Handoff must be created through handoffWriter exactly once");
  const writeProps = log.handoffCreateBodies[0].properties;
  const createdProps = toReadShape(writeProps);

  // Routing + lifecycle facts on the captured record itself.
  assert.equal(selectName(createdProps["From Unit"]), "Sales");
  assert.equal(selectName(createdProps["To Unit"]), "Strategy");
  assert.equal(selectName(createdProps.Status), "Pending", "a new Handoff must be Pending");
  assert.equal(plainJoined(createdProps.Entity_Token), "E-47", "the writer must embed the Entity token");
  assert.equal(plainJoined(createdProps.Matter_Token), "M-12", "the writer must embed the Matter token");
  assert.equal(afterSales.handoffId, CREATED_HANDOFF_ID, "the Work must track the created Handoff");
  assert.equal(afterSales.stage, "awaiting_strategy");
  assert.equal(afterSales.pendingHandoffAutoCheck, true, "the existing queue continuation must be armed");

  // The two durable provenance artifacts Strategy consumes at pickup must
  // parse with the REAL parsers over what the REAL writer wrote -- this is
  // exactly what WP2a/WP2b fail closed on when absent or unparseable.
  const marker = parseSourceBoundaryMarker(plainJoined(createdProps.Reason), {
    handoffId: CREATED_HANDOFF_ID,
    entityToken: "E-47",
    matterToken: "M-12",
  });
  assert.ok(marker.ok, `the source-boundary marker the real writer wrote must parse for the real consumer: ${marker.ok ? "" : marker.reason}`);
  const evidence = parseCommercialValueEvidenceBlock(plainJoined(createdProps["Verified Facts & Sources"]));
  assert.ok(evidence.ok, `the Commercial Value Evidence block the real writer wrote must parse for the real consumer: ${evidence.ok ? "" : evidence.reason}`);

  // Token-only: none of the distinctive identity the Sales state holds may
  // appear anywhere in the cross-unit record (any protected field, any value).
  const payload = JSON.stringify(writeProps);
  for (const secret of ["Northwind", "Johanna Weiss", "johanna@northwind-traders.example", "+49 30 55501234"]) {
    assert.ok(!payload.includes(secret), `the Handoff must stay token-only: found "${secret}" in the created record`);
  }

  // ---------- Phase 2: the REAL Strategy pickup on THAT record ----------
  const handoffPatchesBefore = log.handoffPatchBodies.length;
  const matterPatchesBefore = log.matterPatchBodies.length;
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const strategyState: WorkState = {
    ...afterSales,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "awaiting_pickup",
    awaiting: undefined,
    handoffId: CREATED_HANDOFF_ID,
  };
  const picked = await handlePickup(env, strategyState, STRATEGY_SKILLS);

  // Lifecycle: exactly one claim (Pending -> Picked-up); the incoming Handoff
  // is never closed before Martin's decision.
  const claims = log.handoffPatchBodies.slice(handoffPatchesBefore).filter((p) => p.properties?.Status?.select?.name === "Picked-up");
  assert.equal(claims.length, 1, "the pickup must claim the Handoff exactly once");
  assert.ok(!log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Closed"), "the incoming Handoff must stay open until the intervention is approved");

  // The pickup ran against the writer's OWN tokens and evidence.
  // The production resolution filter is `Matter_ID unique_id equals <number>`
  // (identityResolution.ts), and the served candidate must resolve to the
  // writer's own token -- both halves asserted against the captured request.
  assert.ok(
    log.matterQueryBodies.some((b) => b?.filter?.property === "Matter_ID" && b?.filter?.unique_id?.equals === 12),
    "token resolution must query the Matters store for the Matter token the writer embedded (M-12 -> number 12)",
  );
  assert.ok(log.matterPatchBodies.length > matterPatchesBefore, "the guarded Matter Status advance must be attempted at pickup");
  assert.ok(log.sentTexts.some((msg) => /Strategy Proposal Ready for Review/i.test(msg)), "the proposal must be presented to Martin for decision");

  // Approval gate intact on real writer output: diagnosis + proposal reach
  // Martin's approval lifecycle, and NOTHING creates the next Handoff.
  assert.equal(picked.stage, "awaiting_intervention_approval");
  assert.equal(picked.strategy?.approvalState, "AWAITING_INTERVENTION_APPROVAL");
  assert.equal(picked.strategy?.proposal?.proposalVersion, 1);
  assert.deepEqual([...(picked.strategy?.pendingApproval?.decisionOptions ?? [])], ["approve", "refine", "reject"]);
  assert.equal(
    log.handoffCreateBodies.length,
    1,
    "no Handoff of any kind (Strategy -> Finance included) may be created before Martin approves",
  );
});
