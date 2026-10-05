import test from "node:test";
import { strategyManifest } from "./strategyManifest";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import { createResolvedActionSkillSet, resolveSkill } from "../../platform/skillRegistry";
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
  applyUnprovenCauseDiscipline,
  UNPROVEN_CAUSE_MARKER,
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
import { buildRecordApprovalMarker } from "../sales/callNotesMarker";
import {
  serializeCommercialValueEvidenceBlock,
  parseCommercialValueEvidenceBlock,
  COMMERCIAL_VALUE_EVIDENCE_START,
  COMMERCIAL_VALUE_EVIDENCE_END,
} from "../sales/commercialValueEvidence";
import { hasSubstantiveEvidence } from "./strategyEvidence";
import { SOURCE_BOUNDARY_CHECKS, buildSourceBoundaryMarker } from "../../handoffWriter";
import type { WorkState, Env } from "../../types";
import { redactIdentityTerms } from "../../ai/identityRedaction";

/**
 * The Skill set Strategy's own `diagnose` Action declares, resolved from the
 * manifest's OWN `skill_requirements` -- so a change to that declaration is
 * visible here immediately, and every test in this file exercises the real
 * declared Skill set rather than a hand-built stand-in.
 *
 * Resolution is synchronous (the Registry's own `resolveSkill`, which
 * validates id/format/status/runtime); the integrity-digest verification that
 * production runs at the execution boundary is covered by skillRegistry.test.ts
 * and actionSkills.test.ts respectively, not re-asserted on every call here.
 */
const STRATEGY_SKILLS: ResolvedActionSkillSet = createResolvedActionSkillSet(
  (strategyManifest.hats["Strategy Analyst"].actions.find((action) => action.name === "diagnose")?.skill_requirements ?? []).map((requirement) =>
    resolveSkill(requirement.skill_id),
  ),
);

/**
 * The Commercial Value Evidence block every Sales -> Strategy Handoff now
 * carries in its "Verified Facts & Sources" (handleInterventionText always
 * writes it -- bounded human-readable narrative first, structured block
 * last), so this fixture has the same shape a real Handoff does. Tests that
 * need an absent, malformed, or `Insufficient Evidence` block override
 * `verifiedFacts` explicitly.
 */
const DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK = serializeCommercialValueEvidenceBlock({
  determination: "Satisfied",
  evidenceText: "GHS 8000000-12000000 over annual, evidence type: client_estimated, source: Client-stated on call.",
  evidence: {
    valueAtStake: {
      low: 8000000,
      high: 12000000,
      currency: "GHS",
      period: "annual",
      evidenceType: "client_estimated",
      source: "Client-stated on call",
    },
  },
});

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

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work_strat_1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
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
    // once its own Sales -> Strategy Handoff write passes findViolation --
    // NOTE: handlePickup RE-SEEDS this field from the durable marker on the
    // Handoff record itself, so this session copy alone can never carry a
    // proposal through the gate (see readSourceBoundaryEvidence).
    entityName: "Test Entity",
    matterName: "Test Matter",
    strategySourceBoundaryAttestation: {
      handoffId: "handoff-1",
      checked: true,
      result: "Passed",
      checks: [...SOURCE_BOUNDARY_CHECKS],
      identityFieldsChecked: ["entityName", "matterName"],
    },
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
      // The composable-Skills cycle's Strategy Analysis move. "synthesize"
      // with no findings yet is the everyday case: Strategy Analysis judged
      // the supplied evidence sufficient on its own, so no bounded domain
      // Skill is invoked at all.
      if (system.includes("one move in a diagnostic cycle")) {
        return { response: JSON.stringify({ next: "synthesize", interpretation: "Directly resolvable from the available evidence.", diagnosticQuestion: "", rationale: "No domain method is required." }) };
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
  /** Every Activity Log page created by `logActivity` -- the only durable record of a Blocker's own rationale. */
  activityLogBodies: any[];
  sentTexts: string[];
  sentButtons: any[];
  matterPatchBodies: any[];
  /** Every request this harness received, as `METHOD url` -- the evidence for "no additional model/source access". */
  requests: string[];
  /** Every query issued against the Call Notes store -- the only way the evidence order can reach a Call Notes record. */
  callNotesQueryBodies: any[];
  /** Every page id whose block children were read, in order. The proof of WHICH page a body came from. */
  blockReads: string[];
  /** Every request whose target is the Call Notes store or a Call Notes page -- reads only; a write here is the bug these tests exist to catch. */
  callNotesRequests: string[];
  /** Every request to a host that is neither Notion nor Telegram -- evidence-only readers must never produce one. */
  nonNotionHosts: string[];
}

/**
 * The narrative a Call Notes record's page body carries by default.
 *
 * Deliberately distinct from every other fixture text so a test can tell
 * "the record's page body reached the prompt" apart from "governance page
 * content reached the prompt" (the mock serves those from DIFFERENT page
 * ids -- see the blocks handler below) and from the Handoff's own evidence.
 */
const DEFAULT_CALL_NOTES_BODY =
  "Direct client statement: proposals take roughly 20 staff hours to clean up because there is no single system for colours, fonts and layouts, and three logo versions are in circulation.";

function mockFetch(
  t: any,
  opts: {
    verifiedFacts?: string;
    entityToken?: string;
    matterToken?: string;
    initialStatus?: string;
    requiredNextAction?: string;
    /**
     * When set, the Handoff carries a `Call_Notes_ID` reference and -- unless
     * `verifiedFacts` is given explicitly -- holds NO substantive evidence of
     * its own (evidence order 2 becomes the only route to a situation). The
     * referenced Call Notes record is then served by this mock's query
     * handler.
     */
    callNotesId?: string;
    /** The record's Status; defaults to `Ready`. */
    callNotesStatus?: string;
    /** The record's own `Approval Attestation`, built by the test. */
    callNotesAttestation?: string;
    /** The record's registry Version; defaults to 1. */
    callNotesVersion?: number;
    /**
     * The record's PAGE BODY -- what `/blocks/{id}/children` returns for the
     * Call Notes page. Defaults to a substantive narrative; pass `""` for a
     * metadata-only record (no body at all).
     */
    callNotesBody?: string;
    /** Serve the record's block children as a 500, exercising the structured body-read-failure path. */
    callNotesBodyReadFails?: boolean;
    /** The record's `Entity` relation; defaults to the page the fixture's Entity token resolves to. */
    callNotesEntityRelation?: string;
    /** The record's `Matter` relation; defaults to the page the fixture's Matter token resolves to. */
    callNotesMatterRelation?: string;
    /** How many exact-title matches the store returns; defaults to 1. `2` exercises the multiple-match refusal. */
    callNotesMatches?: number;
    /**
     * The durable source-boundary marker recorded in the Handoff's Reason.
     * Defaults to a valid Passed marker built by the same builder the
     * runtime uses, bound to this fixture's own tokens (production shape).
     * Pass `null` to simulate a Handoff with NO recorded evidence (e.g. one
     * created outside the runtime before this contract existed), or a
     * Failed/custom marker to exercise fail-closed handling.
     */
    sourceBoundaryMarker?: string | null;
  } = {},
): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = { handoffPatchBodies: [], handoffCreateBody: null, activityLogBodies: [], sentTexts: [], sentButtons: [], matterPatchBodies: [], requests: [], callNotesQueryBodies: [], blockReads: [], callNotesRequests: [], nonNotionHosts: [] };
  const verifiedFacts =
    opts.verifiedFacts ??
    (opts.callNotesId
      ? `Call_Notes_ID: ${opts.callNotesId}`
      : `Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.\n\n${DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK}`);
  const entityToken = opts.entityToken ?? "E-47";
  const matterToken = opts.matterToken ?? "M-12";
  const initialStatus = opts.initialStatus ?? "Pending";
  const requiredNextAction = opts.requiredNextAction ?? "";
  const sourceBoundaryMarker =
    opts.sourceBoundaryMarker === null
      ? null
      : (opts.sourceBoundaryMarker ??
        buildSourceBoundaryMarker({ entityToken, matterToken }, "Passed", ["entityName", "matterName"]));
  const reason = `Commercial fit/progression approved for ${matterToken}. Entry type: inbound_enquiry.${
    opts.callNotesId ? `\nCall_Notes_ID: ${opts.callNotesId}` : ""
  }${sourceBoundaryMarker ? `\n${sourceBoundaryMarker}` : ""}`;

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    // Every request this mock saw, so a test can prove a path performed no
    // read beyond the ones it already performs -- and reached no other host.
    log.requests.push(`${method} ${urlStr}`);
    // A read-only evidence retrieval must touch Notion (and, in this harness,
    // Telegram for the operator message) and nothing else. Anything else is
    // recorded so a test can assert no external retrieval ever happened.
    if (!urlStr.includes("api.notion.com") && !urlStr.includes("api.telegram.org")) {
      log.nonNotionHosts.push(`${method} ${urlStr}`);
    }
    if (urlStr.includes("call-notes-ds") || urlStr.includes("/cn-page-1")) {
      log.callNotesRequests.push(`${method} ${urlStr}`);
    }

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
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          properties: {
            Status: { select: { name: initialStatus } },
            "Verified Facts & Sources": { rich_text: [{ plain_text: verifiedFacts }] },
            "Required Next Action": { rich_text: [{ plain_text: requiredNextAction }] },
            Reason: { rich_text: [{ plain_text: reason }] },
            Entity_Token: { rich_text: [{ plain_text: entityToken }] },
            Matter_Token: { rich_text: [{ plain_text: matterToken }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") {
      log.handoffPatchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "handoff-1", url: "https://notion.so/handoff-1", parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/data_sources/call-notes-ds/query") && method === "POST") {
      // The only route the evidence order has to a Call Notes record. Reads
      // alone: any PATCH/PUT against this store falls through to the throw at
      // the bottom of this mock, which is itself the proof that no write
      // happens on this path.
      const body = JSON.parse(init.body);
      log.callNotesQueryBodies.push(body);
      const requested = body?.filter?.title?.equals;
      const matchCount = opts.callNotesMatches ?? 1;
      if (!opts.callNotesId || requested !== opts.callNotesId || matchCount === 0) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      const record = (index: number) => ({
        id: `cn-page-1${index > 0 ? `-${index + 1}` : ""}`,
        url: `https://notion.so/cn-page-1${index > 0 ? `-${index + 1}` : ""}`,
        parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
        properties: {
          "Call Notes ID": { title: [{ plain_text: opts.callNotesId }] },
          Status: { select: { name: opts.callNotesStatus ?? "Ready" } },
          Version: { number: opts.callNotesVersion ?? 1 },
          "Call Date": { date: { start: "2026-09-01" } },
          "Call Type": { select: { name: "Discovery" } },
          "Source ID": { rich_text: [{ plain_text: "SRC-1" }] },
          "Source Type": { rich_text: [{ plain_text: "transcript" }] },
          Entity: { relation: [{ id: opts.callNotesEntityRelation ?? "entity-page-1" }] },
          Matter: { relation: [{ id: opts.callNotesMatterRelation ?? "matter-page-1" }] },
          "Approval Attestation": { rich_text: [{ plain_text: opts.callNotesAttestation ?? "" }] },
        },
      });
      return new Response(
        JSON.stringify({
          results: Array.from({ length: matchCount }, (_, index) => record(index)),
        }),
        { status: 200 },
      );
    }
    if (urlStr.includes("/pages/cn-page-1") && method === "GET") {
      // getPageContent resolves the page's REAL parent before it reads a
      // single block, exactly like every other page read -- so the Call Notes
      // page must be resolvable as living in the Call Notes data source.
      const pageId = urlStr.split("/").pop();
      return new Response(
        JSON.stringify({
          id: pageId,
          url: `https://notion.so/${pageId}`,
          parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      // PAGE-ID AWARE: which page was read decides what it returns, so
      // governance-page content can never be served as Call Notes content
      // (or the reverse) and a test asserting on a prompt can tell them
      // apart. Recorded in log.blockReads as the evidence of which page a
      // body actually came from.
      const pageId = urlStr.split("/blocks/")[1]?.split("/")[0] ?? "(unknown)";
      log.blockReads.push(pageId);
      if (pageId === "cn-page-1") {
        // Serves EXACTLY what the fixture declared as the record's body --
        // no extra blocks -- so a test asserting "this body is (not)
        // substantive" is asserting on what the reader actually saw.
        if (opts.callNotesBodyReadFails) {
          return new Response(JSON.stringify({ object: "error", status: 500, message: "could not read block children" }), { status: 500 });
        }
        const bodyText = opts.callNotesBody ?? DEFAULT_CALL_NOTES_BODY;
        if (!bodyText.trim()) return new Response(JSON.stringify({ results: [] }), { status: 200 });
        return new Response(
          JSON.stringify({
            results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: bodyText }] } }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        log.handoffCreateBody = body;
        return new Response(JSON.stringify({ id: "handoff-new", url: "https://notion.so/handoff-new", parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} }), { status: 200 });
      }
      // Everything else from this mock's `/pages` POST is an Activity Log
      // append (`logActivity` swallows its own failures, so a test that wants
      // to assert what a Blocker entry actually recorded has to capture the
      // body here rather than infer it from the user-facing message).
      log.activityLogBodies.push(body);
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }
    // Handoff pickup now resolves the Handoff's own tokens to their real
    // Matter/Entity page IDs (resolveEntityMatterFromTokens) to advance the
    // Matter's operational Status to Commercial Development. Mocked
    // generically here so every existing handlePickup-based test doesn't
    // need its own fixture for this.
    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      const matterShape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(matterToken);
      if (!matterShape) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "matter-page-1",
              url: "https://notion.so/matter-page-1",
              parent: { type: "data_source_id", data_source_id: "matters-ds" },
              properties: {
                Matter_ID: { unique_id: { prefix: matterShape[1], number: Number(matterShape[2]) } },
                Entity: { relation: [{ id: "entity-page-1" }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/entity-page-1") && method === "GET") {
      const entityShape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(entityToken);
      return new Response(
        JSON.stringify({
          id: "entity-page-1",
          url: "https://notion.so/entity-page-1",
          parent: { type: "data_source_id", data_source_id: "entity-ds" },
          properties: entityShape ? { Entity_ID: { unique_id: { prefix: entityShape[1], number: Number(entityShape[2]) } } } : {},
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "GET") {
      // The Matter page must be readable as well as writable: updatePage
      // resolves a page's target AUTHORITATIVELY from its real parent before
      // dispatching, so a governed write is preceded by a GET of the page
      // being written. Answering the PATCH without answering this left the
      // target unresolvable, and the Matter status advance at pickup silently
      // failed closed (its error is swallowed and logged) while the pickup
      // itself appeared to succeed.
      const shape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(matterToken);
      return new Response(
        JSON.stringify({
          id: "matter-page-1",
          url: "https://notion.so/matter-page-1",
          parent: { type: "data_source_id", data_source_id: "matters-ds" },
          properties: {
            Matter_ID: { unique_id: { prefix: shape?.[1] ?? "M", number: Number(shape?.[2] ?? 1) } },
            Entity: { relation: [{ id: "entity-page-1" }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "PATCH") {
      log.matterPatchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", parent: { type: "data_source_id", data_source_id: "matters-ds" }, properties: {} }), { status: 200 });
    }
    if (method === "GET" && /\/pages\/[0-9a-f-]{32,36}$/i.test(new URL(urlStr).pathname)) {
      // A standalone governance page (Hat Definition, Universal Role
      // Contract): its parent is a page, not a data source, which is
      // precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: urlStr.split("/").pop(),
          url: urlStr,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.ok(result.strategyQuestion, "the strategic question/context must be populated from the Handoff");
  assert.notStrictEqual(result.stage, "awaiting_pickup", "pickup must actually progress the work item");
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Picked-up"), "the claim step must set Picked-up");
});

test("3b. Handoff pickup advances the Matter's operational Status to Commercial Development -- now authorized per the identity architecture decision", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  await handlePickup(env, state, STRATEGY_SKILLS);

  assert.ok(
    log.matterPatchBodies.some((p) => p.properties?.Status?.select?.name === "Commercial Development"),
    "the Matter's own operational Status must advance at Handoff pickup, not just the Handoff's",
  );
});

test("3c. Handoff pickup still completes, and Operations is notified, when the Handoff's tokens don't resolve to a real Matter -- never blocks the diagnosis Martin is waiting on", async (t) => {
  const originalFetch = globalThis.fetch;
  const opsMessages: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      opsMessages.push(body.text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          properties: {
            Status: { select: { name: "Pending" } },
            "Verified Facts & Sources": { rich_text: [{ plain_text: "Sales call notes: recurring client complaints." }] },
            Entity_Token: { rich_text: [{ plain_text: "E-47" }] },
            Matter_Token: { rich_text: [{ plain_text: "M-12" }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") return new Response(JSON.stringify({ id: "handoff-1", url: "x", parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} }), { status: 200 });
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Gov." }] } }] }), { status: 200 });
    }
    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      return new Response(JSON.stringify({ id: "p", url: "x", properties: {} }), { status: 200 });
    }
    if (method === "GET" && /\/pages\/[0-9a-f-]{32,36}$/i.test(new URL(urlStr).pathname)) {
      // A standalone governance page (Hat Definition, Universal Role
      // Contract): its parent is a page, not a data source, which is
      // precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: urlStr.split("/").pop(),
          url: urlStr,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.notStrictEqual(result.stage, "awaiting_pickup", "the diagnosis must still proceed even though the Matter status couldn't be advanced");
  assert.ok(opsMessages.some((m) => /Matter status could not be advanced/.test(m)), "Operations must be notified so the status can be advanced by hand");
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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.match(result.strategyContext ?? "", /evidence-bounded framing/, "guidance written into Required Next Action must reach the diagnosis input");
});

test("4. Strategy refuses a Handoff already Picked-up", async (t) => {
  const log = mockFetch(t, { initialStatus: "Picked-up" });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategyDiagnosis, undefined, "must not process a Handoff that isn't genuinely Pending");
  assert.strictEqual(log.handoffPatchBodies.length, 0, "no Notion write should occur -- refused before any processing");
});

test("5. Strategy refuses a Closed Handoff", async (t) => {
  const log = mockFetch(t, { initialStatus: "Closed" });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeState();

  await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(log.handoffPatchBodies.length, 0);
});

test("6. Strategy can place a blocked case on Held", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, blockedCategory: "ambiguous_question", blockedReason: "The strategic question could mean either a pricing problem or a delivery problem -- materially different diagnoses follow from each." });
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

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

// --- Three separate questions: problem, cause, direction ---------------------------
// `sufficient` = the problem is supported; `diagnosis.causationSupported` = the cause is
// supported; `directionSupport` = the recommended direction is itself supported.

const UNPROVEN_CAUSE_DIAGNOSIS: StrategyDiagnosisResult = {
  ...SUFFICIENT_DIAGNOSIS,
  diagnosis: { ...SUFFICIENT_DIAGNOSIS.diagnosis, causationSupported: false },
  recommendedDirection: "Run a focused diagnostic of delivery operations to establish the cause of the late deliveries.",
};

test("Gate: supported cause + supported direction proceeds", () => {
  const result = evaluateCausationDiscipline({ ...SUFFICIENT_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: false } });
  assert.strictEqual(result.valid, true);
  // A supported cause with a direction that does depend on it is exactly the normal case.
  assert.strictEqual(evaluateCausationDiscipline({ ...SUFFICIENT_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: true } }).valid, true);
});

test("Gate: unsupported cause + independently supported direction proceeds", () => {
  const result = evaluateCausationDiscipline({ ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: false } });
  assert.strictEqual(result.valid, true);
});

test("Gate: unsupported cause + direction that materially depends on it is blocked", () => {
  const result = evaluateCausationDiscipline({ ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: true } });
  assert.strictEqual(result.valid, false);
  if (!result.valid) assert.match(result.reason, /materially depends on a diagnosed cause/);
});

test("Gate: a direction that is itself insufficiently supported is blocked, whether or not the cause is supported", () => {
  for (const base of [SUFFICIENT_DIAGNOSIS, UNPROVEN_CAUSE_DIAGNOSIS]) {
    const result = evaluateCausationDiscipline({ ...base, directionSupport: { supported: false, dependsOnUnsupportedCause: false } });
    assert.strictEqual(result.valid, false);
    if (!result.valid) assert.match(result.reason, /direction itself is not sufficiently supported/);
  }
});

test("Gate: unsupported cause with NO statement about the direction is still blocked -- the existing causation gate is not weakened", () => {
  for (const directionSupport of [undefined, { supported: true } as any]) {
    const result = evaluateCausationDiscipline({ ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport });
    assert.strictEqual(result.valid, false);
  }
});

test("Gate: ambiguous or malformed direction evidence is held, never coerced -- whether or not the cause is supported", () => {
  // Ambiguous: the field is simply absent while the cause is unproven, so
  // there is no direction evidence to weigh.
  assert.strictEqual(evaluateCausationDiscipline({ ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport: undefined }).valid, false);

  // Malformed: present but not the two booleans the contract declares. It is
  // refused on its own terms rather than being read as "supported", and the
  // refusal does not depend on how the cause fared.
  const malformed: unknown[] = [
    { supported: true },                                     // incomplete -- no dependsOnUnsupportedCause
    { dependsOnUnsupportedCause: false },                    // incomplete -- no supported
    { supported: "yes", dependsOnUnsupportedCause: false },  // wrong type
    { supported: true, dependsOnUnsupportedCause: "no" },    // wrong type
    { supported: 1, dependsOnUnsupportedCause: 0 },          // numbers are not booleans
    { supported: true, dependsOnUnsupportedCause: undefined },
    "supported",                                             // not an object at all
    true,
    null,                                                    // explicit null is present, not absent
    [],
  ];
  for (const base of [SUFFICIENT_DIAGNOSIS, UNPROVEN_CAUSE_DIAGNOSIS]) {
    for (const directionSupport of malformed) {
      const result = evaluateCausationDiscipline({ ...base, directionSupport } as any);
      assert.strictEqual(result.valid, false, `expected hold for ${JSON.stringify(directionSupport)} on ${base === SUFFICIENT_DIAGNOSIS ? "supported" : "unproven"} cause`);
      if (!result.valid) assert.match(result.reason, /directionSupport evidence is malformed/);
    }
  }
});

test("Gate: an incomplete causal explanation never becomes a generic ask for more market/churn data -- every hold names the specific direction defect", () => {
  const reasons: string[] = [];
  const holds = [
    { directionSupport: { supported: true, dependsOnUnsupportedCause: true } },   // depends on the unproven cause
    { directionSupport: { supported: false, dependsOnUnsupportedCause: false } }, // direction itself unsupported
    { directionSupport: { supported: true } },                                    // malformed / partial
  ];
  for (const hold of holds) {
    const result = evaluateCausationDiscipline({ ...UNPROVEN_CAUSE_DIAGNOSIS, ...hold } as any);
    assert.strictEqual(result.valid, false, `expected a hold for ${JSON.stringify(hold)}`);
    if (!result.valid) reasons.push(result.reason);
  }
  assert.strictEqual(reasons.length, holds.length);
  for (const reason of reasons) {
    // The hold must name the direction/dependence defect -- it must never
    // fall back to a generic request for market, churn or "more data".
    assert.doesNotMatch(reason, /\bmarket\b|\bchurn\b|more data|additional evidence/i, `hold reason must not demand generic market/churn input: ${reason}`);
    assert.match(reason, /direction/i);
  }
});

test("applyUnprovenCauseDiscipline: an unsupported cause is kept as an explicit, labelled hypothesis -- idempotent, and a supported cause is untouched", () => {
  const proceeding: StrategyDiagnosisResult = { ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: false } };
  const once = applyUnprovenCauseDiscipline(proceeding);
  assert.ok(once.diagnosis!.cause!.startsWith(UNPROVEN_CAUSE_MARKER));
  assert.match(once.unresolvedQuestions!, /is unproven; the recommended direction does not depend on it/);
  assert.deepStrictEqual(applyUnprovenCauseDiscipline(once), once, "applying it twice changes nothing");
  assert.strictEqual(proceeding.diagnosis!.cause, SUFFICIENT_DIAGNOSIS.diagnosis!.cause, "the input is not mutated");

  assert.strictEqual(applyUnprovenCauseDiscipline(SUFFICIENT_DIAGNOSIS), SUFFICIENT_DIAGNOSIS, "supported cause: unchanged");
  assert.strictEqual(applyUnprovenCauseDiscipline(NO_RECOMMENDATION_DIAGNOSIS), NO_RECOMMENDATION_DIAGNOSIS, "no recommendation: unchanged");
});

test("Pickup: supported cause + supported direction proceeds to a proposal for Martin's approval", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ ...SUFFICIENT_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: false } });

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "awaiting_intervention_approval");
  assert.strictEqual(result.strategyDiagnosis!.diagnosis!.cause, SUFFICIENT_DIAGNOSIS.diagnosis!.cause, "a supported cause is not relabelled");
});

test("Pickup: unsupported cause + independently supported direction proceeds, and the cause stays explicitly unproven", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: false } });

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "awaiting_intervention_approval", "an independently supported direction proceeds although the cause is unresolved");
  const diagnosis = result.strategyDiagnosis!;
  assert.strictEqual(diagnosis.diagnosis!.causationSupported, false, "causationSupported keeps its meaning");
  assert.ok(diagnosis.diagnosis!.cause!.startsWith(UNPROVEN_CAUSE_MARKER), "the unsupported cause is never presented as established fact");
  assert.match(diagnosis.unresolvedQuestions!, /is unproven/);
  assert.ok(log.sentTexts.some((text) => text.includes("UNPROVEN HYPOTHESIS")), "the uncertainty is visible to Martin, not only in state");
  assert.strictEqual(log.handoffCreateBody, null, "no Handoff is created before Martin approves");
});

test("Pickup: unsupported cause + direction that materially depends on it is blocked and the Handoff is Held", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ ...UNPROVEN_CAUSE_DIAGNOSIS, directionSupport: { supported: true, dependsOnUnsupportedCause: true } });

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyProposal, undefined);
  const held = lastHandoffPatch(log);
  assert.strictEqual(held.properties.Status.select.name, "Held");
  assert.match(held.properties["Open Questions"].rich_text[0].text.content, /materially depends on a diagnosed cause/);
});

test("Pickup: a direction with insufficient support is blocked -- it does not proceed to a proposal", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ ...SUFFICIENT_DIAGNOSIS, directionSupport: { supported: false, dependsOnUnsupportedCause: false } });

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyProposal, undefined);
  assert.match(lastHandoffPatch(log).properties["Open Questions"].rich_text[0].text.content, /direction itself is not sufficiently supported/);
});

test("Pickup: with no recommendation, the existing no-recommendation path is unchanged", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);
  assert.strictEqual(result.stage, "delivered");
  assert.strictEqual(result.strategyProposal, undefined);
});

test("7. Held case can explicitly return to Pending", async (t) => {
  const log = mockFetch(t, { initialStatus: "Held" });
  const env = fakeEnv();
  const state = fakeState({ stage: "strategy_blocked", awaiting: "strategy_clarification", strategyContext: "Original context." });

  const result = await handleStrategyClarification(env, state, "The problem is specifically about delivery, not pricing.", STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_retry_queued");
  const patch = lastHandoffPatch(log);
  assert.strictEqual(patch.properties.Status.select.name, "Pending", "an explicit retry must return the Handoff to Pending, not process it inline");
  assert.match(patch.properties["Verified Facts & Sources"].rich_text[0].text.content, /delivery, not pricing/);
});

test("7b. A clarification whose combined context exceeds 1,900 characters is stored completely -- Martin's added evidence is never truncated off the end", async (t) => {
  const log = mockFetch(t, { initialStatus: "Held" });
  const env = fakeEnv();
  const original = `Original context. ${"Established client facts. ".repeat(140)}`; // ~3,700 chars, well past the old 1,900 cut
  assert.ok(original.length > 3000);
  const state = fakeState({ stage: "strategy_blocked", awaiting: "strategy_clarification", strategyContext: original });
  const detail = "ADDED EVIDENCE: the delivery delays began after the warehouse consolidation in Q2, per the operations lead.";

  const result = await handleStrategyClarification(env, state, detail, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_retry_queued");
  const patch = lastHandoffPatch(log);
  assert.strictEqual(patch.properties.Status.select.name, "Pending", "the Handoff is still returned to Pending for re-pickup");
  const items = patch.properties["Verified Facts & Sources"].rich_text;
  assert.ok(items.length > 1, "content past one 2,000-char rich-text item is chunked, not cut");
  for (const item of items) assert.ok(item.text.content.length <= 2000);
  const stored = items.map((item: any) => item.text.content).join("");
  assert.strictEqual(stored, `${original}\n\nAdditional detail: ${detail}`, "the complete context, original and added, is persisted verbatim");
  assert.ok(stored.length > 1900);
  assert.ok(stored.endsWith(detail), "the clarification text at the end survives in full");
});

test("8. Pending retry can be picked up again exactly once", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();

  const first = await handlePickup(env, state, STRATEGY_SKILLS);
  assert.notStrictEqual(first.stage, "awaiting_pickup");
  const afterFirst = log.handoffPatchBodies.length;

  // A duplicate discovery trigger invoking pickup again on the SAME
  // session after it already progressed past Pending -- the live Notion
  // record is now Picked-up/Closed (per the mock's static initialStatus,
  // simulating the real post-claim state), so a second call must refuse.
  const secondLog = mockFetch(t, { initialStatus: "Closed" });
  const second = await handlePickup(env, state, STRATEGY_SKILLS);
  assert.strictEqual(secondLog.handoffPatchBodies.length, 0, "the second pickup must not process anything");
  void afterFirst;
  void second;
});

test("9. A recommended diagnosis develops a full Strategic Intervention Proposal requiring Martin approval -- no Finance Handoff auto-created", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  const attestation = result.strategyProposalTokenSafety;
  assert.strictEqual(attestation?.proposalId, result.strategyProposal!.proposalId);
  assert.strictEqual(attestation?.proposalVersion, 1);
  assert.strictEqual(attestation?.sourceBoundary.checked, true);
  assert.deepStrictEqual([...attestation!.sourceBoundary.identityFieldsChecked].sort(), ["entityName", "matterName"]);
  assert.strictEqual(attestation?.proposalContent.checked, true);
  // entityName/matterName are never checkable content-scan fields (see
  // KnownIdentityCheckInput); this default fakeState has no entityDraft
  // (contactName/email/phone), so nothing was available to check.
  assert.deepStrictEqual(attestation!.proposalContent.identityFieldsChecked, []);
});

test("Missing durable boundary evidence fails closed -- a Passed WorkState session copy cannot substitute for the Handoff's recorded attestation, and the Proposal is never presented", async (t) => {
  const log = mockFetch(t, { sourceBoundaryMarker: null });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  // Deliberately NO state override: fakeState carries a Passed session copy
  // (as a same-session Sales creation would leave behind). The durable
  // marker on the Handoff is absent, so pickup must re-seed from the record
  // and fail closed -- missing evidence is never inferred as Passed, and a
  // stale session copy cannot mask it.
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategySourceBoundaryAttestation, undefined, "no usable durable evidence must leave the attestation unset");
  assert.strictEqual(result.strategyProposal, undefined, "no Proposal is set when the source-boundary check is missing");
  assert.strictEqual(result.strategyProposalTokenSafety, undefined);
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.ok(log.sentTexts.some((t) => /no Sales source-boundary identity check is on record/.test(t)));
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)), "never presented to Martin");
});

test("Failed durable boundary evidence fails closed -- the Proposal is never presented for approval", async (t) => {
  const log = mockFetch(t, {
    sourceBoundaryMarker: buildSourceBoundaryMarker({ entityToken: "E-47", matterToken: "M-12" }, "Failed", ["entityName", "matterName"]),
  });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategySourceBoundaryAttestation, undefined, "a recorded Failed result must never be accepted as evidence");
  assert.strictEqual(result.strategyProposal, undefined);
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.ok(log.sentTexts.some((t) => /no Sales source-boundary identity check is on record/.test(t)));
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)), "never presented to Martin");
});

test("Missing operational Entity/Matter reference fails closed -- the Proposal is never presented for approval", async (t) => {
  const log = mockFetch(t, { matterToken: "" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategyProposal, undefined);
  assert.strictEqual(result.strategyProposalTokenSafety, undefined);
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.ok(log.sentTexts.some((t) => /no operational Entity\/Matter reference/.test(t)));
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)), "never presented to Martin");
});

test("Fresh Strategy session consumes the durable attestation from the Handoff and reaches proposal approval using only Entity_ID/Matter_ID -- entityName/matterName never required or populated", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  // Fresh session: no shared Sales WorkState at all -- no attestation copy,
  // no entityName/matterName. Evidence comes only from the Handoff record;
  // operational context comes only from Entity_ID/Matter_ID.
  const state = fakeState({ strategySourceBoundaryAttestation: undefined, entityName: undefined, matterName: undefined });

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.ok(result.pendingStrategyApproval, "a fresh session must reach the proposal-approval stage");
  assert.strictEqual(result.strategyProposal!.proposalVersion, 1);
  // The attestation was seeded from the durable marker, bound to this Handoff.
  assert.strictEqual(result.strategySourceBoundaryAttestation?.checked, true);
  assert.strictEqual(result.strategySourceBoundaryAttestation?.result, "Passed");
  assert.strictEqual(result.strategySourceBoundaryAttestation?.handoffId, "handoff-1");
  assert.deepStrictEqual([...result.strategySourceBoundaryAttestation!.checks].sort(), [...SOURCE_BOUNDARY_CHECKS].sort());
  // Operational references only -- Strategy never resolves real-world identity.
  assert.strictEqual(result.entityToken, "E-47");
  assert.strictEqual(result.matterToken, "M-12");
  assert.strictEqual(result.entityName, undefined, "Strategy must never populate entityName as a workaround");
  assert.strictEqual(result.matterName, undefined, "Strategy must never populate matterName as a workaround");
});

test("A drafted Strategy Proposal containing a known identity value fails closed -- never presented, never routed downstream", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const leaked = {
    ...RAW_PROPOSAL,
    executiveSummary: { ...RAW_PROPOSAL.executiveSummary, businessSituation: "Confirm with comfort@meridianfoods.com before proceeding." },
  };
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, undefined, leaked);
  // entityName/matterName are never checkable content-scan fields (they're
  // always the token, never a real name) -- entityDraft.email is the real
  // identity value this test needs to prove still leaks-detects correctly.
  const state = fakeState({ entityDraft: { name: "", email: "comfort@meridianfoods.com", phone: "", type: "Organisation" } });

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategyProposal, undefined, "the leaked proposal must never become the current Proposal");
  assert.strictEqual(result.strategyProposalTokenSafety, undefined);
  assert.ok(log.sentTexts.some((t) => /known identity value \(matched field: email\)/.test(t)));
  assert.ok(!log.sentTexts.some((t) => /Strategy Proposal Ready for Review/i.test(t)));
  // The violation detail is never echoed -- the actual matched value must never reach Telegram or the Handoff.
  assert.ok(!log.sentTexts.join("").includes("comfort@meridianfoods.com"));
});

test("Proposal contains every required structural section", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);
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
  const result = checkStrategyProposalForKnownIdentity(cleanProposal(), { contactName: "Comfort Agyare" });
  assert.strictEqual(result.violation, null);
  assert.deepStrictEqual([...result.identityFieldsChecked].sort(), ["contactName"]);
});

// entityName/matterName are deliberately NOT checkable fields (see
// KnownIdentityCheckInput's own doc comment): per the identity
// architecture decision recorded in Notion (Sept 2026), those are always
// the Entity/Matter's own token, never a real name, and a Strategy
// Proposal legitimately references its own token throughout -- scanning
// for it would false-positive-block ordinary content, not catch a leak.
test("checkStrategyProposalForKnownIdentity: entityName/matterName are not accepted as identity fields at all -- a Matter token appearing in the proposal's own content is never flagged", () => {
  const proposal = cleanProposal({ strategicChallenge: { ...RAW_PROPOSAL.strategicChallenge, observedSituation: "Directly concerns the MAT-20 Cold Chain Logistics Redesign effort." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, {});
  assert.strictEqual(result.violation, null);
  assert.deepStrictEqual(result.identityFieldsChecked, []);
});

test("checkStrategyProposalForKnownIdentity: a proposal containing a known email fails when email is part of the available identity set", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Confirm with comfort@meridianfoods.com before proceeding." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { email: "comfort@meridianfoods.com" });
  assert.match(result.violation ?? "", /matched field: email/);
  assert.ok(result.identityFieldsChecked.includes("email"));
});

test("checkStrategyProposalForKnownIdentity: a proposal containing a known phone fails, with punctuation normalized like findViolation", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Contact reachable at +233 24 412 3456 if needed." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { phone: "+233-24-412-3456" });
  assert.match(result.violation ?? "", /matched field: phone/);
});

test("checkStrategyProposalForKnownIdentity: a proposal containing a known contact name fails when contactName is supplied", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Follow up with Comfort Agyare about the timeline." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { contactName: "Comfort Agyare" });
  assert.match(result.violation ?? "", /matched field: contactName/);
});

test("checkStrategyProposalForKnownIdentity: matching is case-insensitive, consistent with findViolation's existing semantics", () => {
  const proposal = cleanProposal({ executiveSummary: { ...RAW_PROPOSAL.executiveSummary, businessSituation: "comfort agyare is the primary contact." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { contactName: "Comfort Agyare" });
  assert.match(result.violation ?? "", /matched field: contactName/);
});

test("checkStrategyProposalForKnownIdentity: nested fields (workstreams, deliverables, arrays) are inspected, not just top-level fields", () => {
  const proposal = cleanProposal({
    proposedIntervention: {
      ...RAW_PROPOSAL.proposedIntervention,
      workstreams: [{ name: "Vendor onboarding", objective: "Loop in Comfort Agyare as the preferred contact.", activities: [], output: "", dependencies: [], acceptanceCriteria: [] }],
    },
  });
  const result = checkStrategyProposalForKnownIdentity(proposal, { contactName: "Comfort Agyare" });
  assert.match(result.violation ?? "", /matched field: contactName/);
});

test("checkStrategyProposalForKnownIdentity: an arbitrary unknown name is not falsely classified as a violation merely for being a name", () => {
  const proposal = cleanProposal({ diagnosis: { ...RAW_PROPOSAL.diagnosis, diagnosticConclusion: "Comparable to the approach a firm like Jonathan Osei Consulting might take." } });
  const result = checkStrategyProposalForKnownIdentity(proposal, { contactName: "Comfort Agyare" });
  assert.strictEqual(result.violation, null, "an unknown third-party name is out of scope for the bounded known-identity check");
});

test("checkStrategyProposalForKnownIdentity: only contactName present -- optional fields are not recorded as checked when absent", () => {
  const result = checkStrategyProposalForKnownIdentity(cleanProposal(), { contactName: "Comfort Agyare" });
  assert.deepStrictEqual(result.identityFieldsChecked, ["contactName"]);
  assert.ok(!result.identityFieldsChecked.includes("email"));
  assert.ok(!result.identityFieldsChecked.includes("phone"));
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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

/** An upstream determination that does NOT satisfy the value-evidence rule -- provenance complete, sufficiency absent. */
const INSUFFICIENT_COMMERCIAL_VALUE_BLOCK = serializeCommercialValueEvidenceBlock({
  determination: "Insufficient Evidence",
  evidenceText: "No numerical value connected to the business problem or opportunity has been established.",
  evidence: null,
});

test("Provenance gate: a Sales -> Strategy Handoff with NO Commercial Value Evidence block fails the Strategy proposal gate closed -- never presented, never routed to Finance", async (t) => {
  const log = mockFetch(t, {
    verifiedFacts:
      "Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.",
  });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked", "missing provenance must fail closed");
  assert.strictEqual(result.awaiting, "strategy_clarification");
  assert.strictEqual(result.strategyApprovalState, undefined, "no approval request is staged without provenance");
  assert.strictEqual(result.strategyProposal, undefined, "the proposal is never adopted on a provenance failure");
  assert.strictEqual(result.commercialValueEvidenceBlock, undefined);
  assert.strictEqual(log.handoffCreateBody, null, "no Strategy -> Finance Handoff is ever created");
  const message = log.sentTexts.join("\n");
  assert.match(message, /Commercial Value Evidence/, "the failure names the exact block that is missing");
  assert.match(message, /never authors, estimates, or infers/i, "and says why Strategy will not fill the gap itself");
});

test("Provenance gate: a malformed Commercial Value Evidence block fails closed and names what could not be parsed -- never repaired, never ignored", async (t) => {
  const log = mockFetch(t, {
    verifiedFacts:
      `Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.\n\n` +
      `${COMMERCIAL_VALUE_EVIDENCE_START}\n{"determination": "Insufficient Evidence", "evidenceText": \n${COMMERCIAL_VALUE_EVIDENCE_END}`,
  });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.commercialValueEvidenceBlock, undefined, "an unparseable block is never carried as if it were valid");
  assert.match(result.commercialValueEvidenceError ?? "", /not valid JSON/);
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(log.handoffCreateBody, null);
  assert.match(log.sentTexts.join("\n"), /not valid JSON/, "the gate reports the exact parse failure");
});

test("An upstream `Insufficient Evidence` determination does NOT fail the Strategy proposal gate -- the gate checks provenance, pricing sufficiency is Finance's call", async (t) => {
  const log = mockFetch(t, {
    verifiedFacts:
      `Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.\n\n` +
      INSUFFICIENT_COMMERCIAL_VALUE_BLOCK,
  });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(afterPickup.stage, "awaiting_intervention_approval", "Strategy may be approved even when nothing is quantified upstream");
  assert.ok(afterPickup.pendingStrategyApproval, "Approval Needed is reached as usual");
  const carried = parseCommercialValueEvidenceBlock(afterPickup.commercialValueEvidenceBlock ?? "");
  assert.ok(carried.ok, carried.ok ? "" : carried.reason);
  assert.strictEqual(carried.record.determination, "Insufficient Evidence", "the determination is carried as-is, unchanged by Strategy");

  // Strategy does not add a numerical-value requirement of its own: proposal
  // completeness is unaffected by the determination.
  assert.strictEqual(evaluateProposalCompleteness(afterPickup.strategyProposal!).valid, true);

  // And the approval still commits a Finance Handoff carrying both blocks.
  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");
  const factsText = (log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text as { text: { content: string } }[])
    .map((i) => i.text.content)
    .join("");
  assert.ok(factsText.includes(INSUFFICIENT_COMMERCIAL_VALUE_BLOCK), "the insufficient determination still travels downstream verbatim");
});

test("Strategy copies the upstream Commercial Value Evidence block byte-identically into the Finance Handoff, beside the unchanged Strategy boundary representation", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
  assert.strictEqual(afterPickup.commercialValueEvidenceBlock, DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK, "pickup holds the sender's bytes");

  await handleInterventionApproval(env, afterPickup, afterPickup.pendingStrategyApproval!.proposalVersion, "approve");

  const items: { text: { content: string } }[] = log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text;
  const factsText = items.map((i) => i.text.content).join("");

  // Finance receives BOTH blocks.
  assert.ok(factsText.includes(DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK), "the Commercial Value Evidence block is copied byte-for-byte, never paraphrased or regenerated");
  const copied = extractLabeledBlock(factsText, COMMERCIAL_VALUE_EVIDENCE_START, COMMERCIAL_VALUE_EVIDENCE_END);
  assert.strictEqual(
    `${COMMERCIAL_VALUE_EVIDENCE_START}\n${copied}\n${COMMERCIAL_VALUE_EVIDENCE_END}`,
    DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK,
    "byte-equality of the carried block",
  );
  assert.ok(factsText.includes(STRATEGY_BOUNDARY_START) && factsText.includes(STRATEGY_BOUNDARY_END), "the approved Strategy boundary representation is present too");

  // Deterministic parse of what Finance will read -- no interpretation needed.
  const parsed = parseCommercialValueEvidenceBlock(factsText);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.strictEqual(parsed.record.determination, "Satisfied");
  assert.strictEqual(parsed.block, DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK);
});

test("A Strategy clarification preserves the upstream Commercial Value Evidence block when the evidence base came from approved Call Notes (order 2)", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const state = fakeState({
    handoffId: "handoff-1",
    stage: "strategy_clarification",
    awaiting: "strategy_clarification",
    // Order-2 evidence base: the Handoff's own narrative carried only a
    // reference, so `strategyContext` holds the retrieved Call Notes text
    // and does NOT contain the block -- exactly the shape whose rewrite used
    // to delete it.
    strategyContext: "Fulfilment delays: recurring stockouts across the regional warehouse network.",
    commercialValueEvidenceBlock: DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK,
  });

  await handleStrategyClarification(env, state, "The board review is scheduled for the last week of the quarter.", STRATEGY_SKILLS);

  const patch = log.handoffPatchBodies.find((p) => p.properties?.["Verified Facts & Sources"]);
  assert.ok(patch, "the clarification requeues by rewriting Verified Facts & Sources");
  const facts = (patch.properties["Verified Facts & Sources"].rich_text as { text: { content: string } }[])
    .map((i) => i.text.content)
    .join("");
  assert.match(facts, /Additional detail: The board review is scheduled/);
  assert.ok(facts.includes(DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK), "the block is re-appended verbatim, so the next pickup's provenance gate still passes");
  const reparsed = parseCommercialValueEvidenceBlock(facts);
  assert.ok(reparsed.ok, reparsed.ok ? "" : reparsed.reason);
  assert.strictEqual(reparsed.block, DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK, "byte-identical after the rewrite");
});

test("30. Finance cannot receive an unapproved proposal -- never budget/WTP as the pricing basis", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);
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

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);
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
  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);

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

test("Missing-evidence work is NOT routed anywhere: a 'research' target resolves to no route, so the diagnosis stays blocked rather than reaching a retired Unit", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  // Research & Intelligence is retired and no owning Action/runtime path has
  // been designed for evidence recovery. Even if a (misbehaving) classifier
  // returned "research", it is not a key in HANDOFF_ROUTES, so nothing is
  // proposed and no Handoff is ever created.
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "research", reason: "Regional logistics capacity evidence needed." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(afterPickup.pendingStrategyHandoff, undefined, "no downstream Handoff may be proposed for a missing-evidence diagnosis");
  assert.strictEqual(log.handoffCreateBody, null, "and none may be written");
});

test("39. The generic downstream classifier can never route to Finance -- Finance is reachable only via the Approve gate", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  // Even if a (misbehaving) classifier returned "finance", it isn't a key
  // in HANDOFF_ROUTES any more, so no route resolves and nothing is proposed.
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS, { target: "finance", reason: "should be impossible" });
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

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

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategyDiagnosis, undefined, "no diagnosis should have been attempted");
});

test("Missing Telegram stream configuration fails closed rather than throwing", async (t) => {
  mockFetch(t);
  const env = fakeEnv({ TELEGRAM_GROUP_CHAT_ID: undefined, WORKSPACE_TOPIC_ID: undefined });
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();

  // Must not throw even though every sendWorkspaceHatMessage call in the
  // pipeline will fail closed (return undefined) for lack of stream config.
  const result = await handlePickup(env, state, STRATEGY_SKILLS);
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
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
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
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") return new Response(JSON.stringify({ id: "handoff-1", url: "x", parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} }), { status: 200 });
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Gov." }] } }] }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "activity-log-ds") logEntries.push(body.properties);
      return new Response(JSON.stringify({ id: "p", url: "x", properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "matter-page-1",
              url: "https://notion.so/matter-page-1",
              parent: { type: "data_source_id", data_source_id: "matters-ds" },
              properties: {
                Matter_ID: { unique_id: { prefix: "M", number: 1 } },
                Entity: { relation: [{ id: "entity-page-1" }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/entity-page-1") && method === "GET") {
      return new Response(JSON.stringify({ id: "entity-page-1", url: "x", parent: { type: "data_source_id", data_source_id: "entity-ds" }, properties: { Entity_ID: { unique_id: { prefix: "E", number: 1 } } } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "GET") {
      // See the first mock's equivalent: updatePage resolves a governed page's
      // target from its real parent before dispatching, so the Matter page has
      // to be readable as well as writable.
      return new Response(JSON.stringify({ id: "matter-page-1", url: "x", parent: { type: "data_source_id", data_source_id: "matters-ds" }, properties: { Matter_ID: { unique_id: { prefix: "M", number: 1 } }, Entity: { relation: [{ id: "entity-page-1" }] } } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "PATCH") {
      return new Response(JSON.stringify({ id: "matter-page-1", url: "x", parent: { type: "data_source_id", data_source_id: "matters-ds" }, properties: {} }), { status: 200 });
    }
    if (method === "GET" && /\/pages\/[0-9a-f-]{32,36}$/i.test(new URL(urlStr).pathname)) {
      // A standalone governance page (Hat Definition, Universal Role
      // Contract): its parent is a page, not a data source, which is
      // precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: urlStr.split("/").pop(),
          url: urlStr,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeState();
  await handlePickup(env, state, STRATEGY_SKILLS);

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
              parent: { type: "data_source_id", data_source_id: "matters-ds" },
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
          parent: { type: "data_source_id", data_source_id: "entity-ds" },
          properties: { Entity_ID: { unique_id: { prefix: entityPrefix, number: entityNumber } } },
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
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }
    if (method === "GET" && /\/pages\/[0-9a-f-]{32,36}$/i.test(new URL(urlStr).pathname)) {
      // A standalone governance page (Hat Definition, Universal Role
      // Contract): its parent is a page, not a data source, which is
      // precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: urlStr.split("/").pop(),
          url: urlStr,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
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
    actionName: "diagnose",
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

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-20: recurring delivery complaints for this account.", STRATEGY_SKILLS);

  assert.strictEqual(result.entryType, "direct_request");
  assert.strictEqual(result.matterToken, "MAT-20");
  assert.strictEqual(result.entityToken, "E-7");
  assert.ok(result.strategyQuestion, "the strategic question must be populated from Martin's own text");
  assert.strictEqual(result.stage, "delivered", "a diagnosis with no recommendation must complete, not hold");
});

test("handleDirectRequest: a diagnosis WITH a recommended direction reaches an approvable Strategy Proposal -- direct_request sets entityName/matterName to the tokens themselves and is exempt from the Sales-sourced source-boundary attestation (nothing to attest to with no Handoff)", async (t) => {
  mockDirectRequestFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-20: recurring delivery complaints for this account.", STRATEGY_SKILLS);

  assert.strictEqual(result.entryType, "direct_request");
  assert.strictEqual(result.matterToken, "MAT-20");
  assert.strictEqual(result.entityName, result.entityToken, "entityName is the token itself, never a real name");
  assert.strictEqual(result.matterName, result.matterToken, "matterName is the token itself, never a real name");
  assert.ok(result.pendingStrategyApproval, "must reach the approval gate, not be held");
  assert.strictEqual(result.pendingStrategyApproval?.decisionOptions.includes("approve"), true);
});

test("handleDirectRequest: a Proposal that genuinely mentions its own Matter token in its content is NOT false-positive-blocked -- regression test for the risk introduced by setting entityName/matterName to the token", async (t) => {
  mockDirectRequestFetch(t);
  const env = fakeEnv();
  const proposalMentioningOwnToken = {
    ...RAW_PROPOSAL,
    strategicChallenge: { ...RAW_PROPOSAL.strategicChallenge, observedSituation: "Recurring delivery complaints for MAT-20 stem from inconsistent handoff between warehouse and dispatch." },
  };
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, undefined, proposalMentioningOwnToken);
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-20: recurring delivery complaints for this account.", STRATEGY_SKILLS);

  assert.ok(result.pendingStrategyApproval, "a Proposal mentioning its own token must still be presented, not blocked as a false identity leak");
});

test("handleDirectRequest fails closed with a clarifying message when no Matter token is present -- never guesses which Matter", async (t) => {
  const { sentTexts } = mockDirectRequestFetch(t);
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeDirectRequestState();

  const result = await handleDirectRequest(env, state, "Strategy, we have recurring delivery complaints for this account.", STRATEGY_SKILLS);

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

  const result = await handleDirectRequest(env, state, "Strategy, diagnose MAT-999: this Matter doesn't exist.", STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.awaiting, "strategy_direct_request_matter");
  assert.ok(sentTexts.some((m) => m.includes("Which Matter")), "an unresolvable token must fail closed exactly like a missing one, never guess");
});

test("handleDirectRequestClarification re-attempts resolution against Martin's follow-up text", async (t) => {
  mockDirectRequestFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);
  const state = fakeDirectRequestState({ stage: "strategy_blocked", awaiting: "strategy_direct_request_matter" });

  const result = await handleDirectRequestClarification(env, state, "It's MAT-20, sorry -- recurring delivery complaints.", STRATEGY_SKILLS);

  assert.strictEqual(result.matterToken, "MAT-20");
  assert.strictEqual(result.entityToken, "E-7");
  assert.strictEqual(result.stage, "delivered", "supplying the token on follow-up must unblock and complete the request");
});


/**
 * Composable-Skills composition tests (ENIG Core Structure v3.0).
 *
 * These replace LOG-845's specialist-Hat composition tests. Strategy is ONE
 * organizational Hat; the specialist domains are Skills it follows one move
 * at a time; every Skill reaches execution only through the generic Registry
 * (the set is resolved from the manifest's own `skill_requirements`, exactly
 * as production resolves it).
 *
 * `strategy.specialist_selection` / `business_diagnosis` / `brand_diagnosis` /
 * `communication_diagnosis` / `specialist_synthesis` are classified
 * business_sensitive/TOKEN_SAFE_RUNTIME in PRODUCTION_TASK_SENSITIVITY/
 * PRODUCTION_OUTBOUND_POLICY (see policy.ts), so the cycle genuinely runs
 * against the real production policy tables here -- no test-time policy
 * override is needed or used.
 */
type Move = { next: "invoke"; skillId: string; focus?: string } | { next: "synthesize" } | "throw";

type CycleScript = {
  /** Strategy Analysis moves, consumed in order; the last entry repeats once exhausted. Defaults to a single "synthesize" (no Skill needed). */
  moves?: Move[];
  /** Per-Skill responses, keyed by Skill id. Defaults to a completed finding. */
  skills?: Record<string, unknown | "throw">;
  synthesis?: unknown;
  diagnosis?: unknown;
  routing?: unknown;
  proposal?: unknown;
};

interface RecordedCall {
  kind: "analysis" | "skill" | "synthesis" | "diagnosis" | "routing" | "proposal";
  skillId?: string;
  prompt: string;
}

/** Same dispatch as fakeAi, plus the cycle's own steps -- and a record of every call, so prompts are assertable. */
function fakeAiCycle(script: CycleScript): { ai: Ai; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const defaultSkillFinding = (skillId: string) => ({
    sufficient: true,
    finding: `${skillId} established a bounded domain finding.`,
    evidenceLimitation: `${skillId} could not establish cost or market size from the evidence given.`,
    implication: `${skillId} implies the open question is the binding constraint.`,
    unresolvedQuestion: `What does ${skillId} still need to know?`,
  });
  const ai = {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      const all = JSON.stringify(opts?.messages ?? []);
      const respond = (val: unknown) => {
        if (val === "throw") throw new Error("simulated provider failure");
        return { response: JSON.stringify(val) };
      };

      if (system.includes("one move in a diagnostic cycle")) {
        const moves = script.moves && script.moves.length > 0 ? script.moves : [{ next: "synthesize" as const }];
        const move = moves[Math.min(calls.filter((c) => c.kind === "analysis").length, moves.length - 1)];
        calls.push({ kind: "analysis", prompt: all });
        if (move === "throw") throw new Error("simulated Strategy Analysis provider failure");
        if (move.next === "synthesize") return respond({ next: "synthesize", interpretation: "the evidence answers the question", diagnosticQuestion: "", rationale: "no further method needed" });
        return respond({ next: "invoke", skillId: move.skillId, focus: move.focus ?? "the open diagnostic question", interpretation: "", diagnosticQuestion: "", rationale: "this domain of judgment is required" });
      }

      const skillMatch = system.match(/applying one bounded Strategy Skill: `([^`]+)`/);
      if (skillMatch) {
        const skillId = skillMatch[1];
        calls.push({ kind: "skill", skillId, prompt: all });
        return respond(script.skills?.[skillId] ?? defaultSkillFinding(skillId));
      }

      if (system.includes("reconciling the bounded Strategy Skill findings")) {
        calls.push({ kind: "synthesis", prompt: all });
        return respond(script.synthesis ?? { sufficient: true, synthesizedContext: "reconciled findings" });
      }
      if (system.includes("canonical operating procedure")) {
        calls.push({ kind: "diagnosis", prompt: all });
        return respond(script.diagnosis ?? NO_RECOMMENDATION_DIAGNOSIS);
      }
      if (system.includes("Expand it into the COMPLETE Strategic Intervention Proposal")) {
        calls.push({ kind: "proposal", prompt: all });
        return respond(script.proposal ?? RAW_PROPOSAL);
      }
      if (system.includes("next responsibility belongs to another Unit")) {
        calls.push({ kind: "routing", prompt: all });
        return respond(script.routing ?? { target: "none" });
      }
      throw new Error(`Unexpected AI call in cycle test -- system prompt: ${system.slice(0, 120)}`);
    },
  } as any;
  return { ai, calls };
}

const COMPLETED_SKILL_FINDING = {
  sufficient: true,
  finding: "Fulfilment capacity has not scaled with demand for two quarters.",
  evidenceLimitation: "No cost or vendor-capacity figures were supplied.",
  implication: "The binding constraint appears commercial rather than brand.",
  unresolvedQuestion: "What is the cost of adding capacity?",
};

test("Skills: Strategy's diagnose Action resolves exactly its declared Strategy Skill set through the generic Registry", async () => {
  assert.deepStrictEqual(
    STRATEGY_SKILLS.declared,
    ["strategy_analysis", "brand_strategy", "business_strategy", "communication_strategy", "research_signal"],
    "the multi-Skill Responsibility declares the orchestration Skill, the three bounded domain Skills, and the reused research_signal -- no Skill is duplicated and none is mandatory",
  );
  // Resolved content is the Registry's own verified package, not something
  // the handler built -- the same call production makes at the execution
  // boundary.
  assert.match(STRATEGY_SKILLS.get("strategy_analysis").content, /diagnostic-cycle discipline/);
  assert.strictEqual(STRATEGY_SKILLS.get("research_signal").content, resolveSkill("research_signal").content);
  assert.strictEqual(STRATEGY_SKILLS.get("research_signal").version, resolveSkill("research_signal").version);
  // There is no mandatory primary Skill: every one of them is optional
  // methodology, and the cycle may follow none at all (asserted below).
  assert.strictEqual(strategyManifest.hats["Strategy Analyst"].actions.filter((a) => a.skill_requirements?.length).length, 1);
});

test("Skills: Strategy remains ONE organizational Hat -- the specialist Hats are not registered and can never be addressed or switched to", () => {
  assert.deepStrictEqual(Object.keys(strategyManifest.hats), ["Strategy Analyst"]);
  const strategyHats = ALL_HATS.filter((h) => h.unit === "Strategy");
  assert.deepStrictEqual(strategyHats.map((h) => h.name), ["Strategy Analyst"], "Strategy owns exactly one Hat");
  for (const retired of ["Business Strategist", "Brand Strategist", "Communication Strategist"]) {
    assert.ok(!ALL_HATS.some((h) => h.name === retired), `${retired} must no longer exist as a Hat`);
  }
  // Marketing Strategist stays exclusively Marketing's, as before.
  assert.ok(!ALL_HATS.some((h) => h.name === "Marketing Strategist" && h.unit === "Strategy"));
});

test("Skills: no call in the cycle is ever addressed as a specialist Hat -- the Strategy Analyst stays the single accountable actor", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "invoke", skillId: "brand_strategy" }, { next: "synthesize" }],
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  assert.strictEqual(result.hat, "Strategy Analyst", "Hat switching must never happen -- the accountable Hat is unchanged");
  assert.ok(calls.some((c) => c.kind === "skill"), "the Skills genuinely ran");
  for (const call of calls) {
    for (const retired of ["Business Strategist Hat", "Brand Strategist Hat", "Communication Strategist Hat"]) {
      assert.ok(!call.prompt.includes(retired), `no cycle call may be addressed as the retired ${retired}`);
    }
  }
  // The three cycle steps are Skill methodology only -- none of them fetches
  // or follows a Hat Definition. (The unchanged core-diagnosis step still
  // does, and still should: it is the Strategy Analyst's own governance.)
  for (const call of calls.filter((c) => c.kind === "analysis" || c.kind === "skill" || c.kind === "synthesis")) {
    assert.ok(!call.prompt.includes("Hat Definition"), "a Strategy Skill is methodology, not a fetched Hat Definition");
  }
});

test("composition: Strategy Analysis can invoke ONE Strategy Skill and finish", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "brand_strategy", focus: "is positioning the real constraint?" }, { next: "synthesize" }],
    skills: { brand_strategy: COMPLETED_SKILL_FINDING },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.strategySkillFindings?.length, 1);
  assert.strictEqual(result.strategySkillFindings?.[0].skillId, "brand_strategy");
  assert.strictEqual(result.strategySkillFindings?.[0].status, "completed");
  assert.strictEqual(result.strategySkillCycleUnavailable, undefined, "a Skill genuinely ran -- this must never read as a no-Skill/unavailable state");
  assert.strictEqual(result.stage, "delivered", "synthesis folded into context, core diagnosis still completes normally");
  assert.deepStrictEqual(calls.filter((c) => c.kind === "skill").map((c) => c.skillId), ["brand_strategy"], "exactly one Skill was invoked");
});

test("composition: Strategy Analysis can invoke multiple Strategy Skills sequentially, each after the previous one returned", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [
      { next: "invoke", skillId: "business_strategy" },
      { next: "invoke", skillId: "brand_strategy" },
      { next: "invoke", skillId: "communication_strategy" },
      { next: "synthesize" },
    ],
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.deepStrictEqual(
    result.strategySkillFindings?.map((f) => f.skillId),
    ["business_strategy", "brand_strategy", "communication_strategy"],
    "Skills run one at a time, in the order Strategy Analysis chose them -- never concurrently",
  );
  assert.ok(result.strategySkillFindings?.every((f) => f.status === "completed"));
  // Strict ordering: skill 2 is only requested after skill 1 has returned.
  const kinds = calls.map((c) => c.kind);
  assert.deepStrictEqual(kinds.filter((k) => k === "analysis" || k === "skill"), [
    "analysis", "skill", "analysis", "skill", "analysis", "skill", "analysis",
  ]);
  assert.strictEqual(result.stage, "delivered");
});

test("composition: a later Strategy Skill's move is chosen from an earlier Skill's finding -- Strategy Analysis reads what came back before deciding again", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [
      { next: "invoke", skillId: "business_strategy" },
      { next: "invoke", skillId: "brand_strategy", focus: "is the brand-perception symptom downstream of the capacity constraint?" },
      { next: "synthesize" },
    ],
    skills: { business_strategy: COMPLETED_SKILL_FINDING },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  const skillCalls = calls.filter((c) => c.kind === "skill");
  const brandCall = skillCalls.find((c) => c.skillId === "brand_strategy");
  assert.ok(brandCall, "the second Skill must have run");
  assert.ok(
    brandCall!.prompt.includes("Fulfilment capacity has not scaled with demand for two quarters."),
    "the later Skill must be handed the earlier Skill's finding -- the cycle accumulates, it does not start over",
  );
  assert.ok(
    brandCall!.prompt.includes("downstream of the capacity constraint"),
    "the move's own `focus` names the dependency the Strategy Analysis move chose",
  );
  const analysisAfterFirstSkill = calls.filter((c) => c.kind === "analysis")[1];
  assert.ok(
    analysisAfterFirstSkill.prompt.includes("Fulfilment capacity has not scaled with demand for two quarters."),
    "Strategy Analysis itself resumes with the accumulated finding in front of it",
  );
});

test("composition: unnecessary Strategy Skills are skipped -- a genuine no-Skill determination is distinct from the cycle being unavailable", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({ moves: [{ next: "synthesize" }] });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.deepStrictEqual(result.strategySkillFindings, [], "no Skill was invoked");
  assert.strictEqual(calls.filter((c) => c.kind === "skill").length, 0, "a skipped Skill is never invoked 'for completeness'");
  assert.strictEqual(result.strategySkillCycleUnavailable, false, "Strategy Analysis genuinely ran and determined no Skill was needed -- never conflated with the cycle not being able to run");
  assert.strictEqual(result.stage, "delivered");
});

test("composition: Strategy Analysis resumes after every Strategy Skill -- one analysis move before each Skill, and one final move that stops", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "invoke", skillId: "brand_strategy" }, { next: "synthesize" }],
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(calls.filter((c) => c.kind === "analysis").length, 3, "two Skills invoked, so Strategy Analysis runs three times (twice to choose, once to stop)");
  assert.strictEqual(result.stage, "delivered");
});

test("composition: an unusable Strategy Analysis move degrades to the unchanged core diagnosis, recorded as unavailable", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({ moves: ["throw"] });
  env.AI = ai;
  const state = fakeState();

  const originalWarn = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  t.after(() => {
    console.warn = originalWarn;
  });

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.deepStrictEqual(result.strategySkillFindings, []);
  assert.strictEqual(result.strategySkillCycleUnavailable, true, "a genuine provider failure on the analysis move must be recorded as unavailable, never conflated with no Skill being needed");
  assert.strictEqual(result.stage, "delivered", "an unrelated cycle failure must never block an otherwise-resolvable core diagnosis");
  assert.ok(warned.some((w) => w.includes("Skill cycle unavailable")), "the degradation is logged, never silently swallowed");
});

test("composition: every invoked Strategy Skill failing fails closed via the existing handleBlocked -- never proceeds as if the findings were complete", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "synthesize" }],
    skills: { business_strategy: { sufficient: false, blockedReason: "the supplied evidence cannot support a defensible business finding" } },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "core diagnosis must never run when the only requested finding is unavailable");
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.Status?.select?.name === "Held"));
});

test("composition: a partial Skill failure still allows synthesis to proceed, with the unavailable Skill explicit rather than backfilled", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "invoke", skillId: "brand_strategy" }, { next: "synthesize" }],
    skills: {
      business_strategy: COMPLETED_SKILL_FINDING,
      brand_strategy: { sufficient: false, blockedReason: "no perception evidence was supplied" },
    },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  const bySkill = Object.fromEntries((result.strategySkillFindings ?? []).map((f) => [f.skillId, f]));
  assert.strictEqual(bySkill.business_strategy.status, "completed");
  assert.strictEqual(bySkill.brand_strategy.status, "failed");
  assert.ok(bySkill.brand_strategy.failureReason?.includes("no perception evidence"), "the failure reason travels with the finding");
  const synthesisCall = calls.find((c) => c.kind === "synthesis");
  assert.ok(synthesisCall?.prompt.includes("UNAVAILABLE"), "synthesis is told the finding is missing -- never given it as if it were neutral");
  assert.strictEqual(result.stage, "delivered");
});

test("composition: synthesis judged insufficient fails closed and never produces a proposal", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "synthesize" }],
    skills: { business_strategy: COMPLETED_SKILL_FINDING },
    synthesis: { sufficient: false, insufficiencyReason: "The business and brand findings materially conflict on root cause and cannot be reconciled from the supplied evidence." },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "must never proceed to core diagnosis/proposal on an unreconciled conflict");
  assert.strictEqual(result.strategyProposal, undefined);
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content?.includes("conflict")));
});

test("composition: a move naming a Skill this Action did not declare is refused at the point of use", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  // Only two Skills declared -- `communication_strategy` is a real Strategy
  // domain Skill, but not one THIS Action requires.
  const twoSkills = createResolvedActionSkillSet([resolveSkill("strategy_analysis"), resolveSkill("brand_strategy")]);
  const { ai } = fakeAiCycle({ moves: [{ next: "invoke", skillId: "communication_strategy" }] });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, twoSkills);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined);
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content?.includes("did not declare")));
});

test("composition: a move naming something that is not a Strategy domain Skill is refused -- no improvisation substitutes for a declared Skill", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({ moves: [{ next: "invoke", skillId: "opportunity_qualification_gate" }] });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined);
  assert.ok(log.handoffPatchBodies.some((p) => p.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content?.includes("not a Strategy domain Skill")));
});

test("composition: which Strategy Skills ran is observable in logs -- otherwise execution is unreconstructable after the fact (nothing else persists it)", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "invoke", skillId: "brand_strategy" }, { next: "synthesize" }],
  });
  env.AI = ai;
  const state = fakeState();

  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  t.after(() => {
    console.log = originalLog;
  });

  await handlePickup(env, state, STRATEGY_SKILLS);

  assert.ok(logged.some((l) => l.includes("invoked 2 Strategy Skill(s): business_strategy:completed, brand_strategy:completed")), "must log which Skills ran and their outcome");
  assert.ok(logged.some((l) => l.includes("synthesis") && l.includes("sufficient")), "must log that synthesis was folded into the diagnosis");
});

test("composition: a genuine no-Skill determination is also observable in logs, distinct from the Skills-invoked case", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({ moves: [{ next: "synthesize" }] });
  env.AI = ai;
  const state = fakeState();

  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  t.after(() => {
    console.log = originalLog;
  });

  await handlePickup(env, state, STRATEGY_SKILLS);

  assert.ok(logged.some((l) => l.includes("no Strategy Skill was required")), "must log the genuine no-Skill determination distinctly from a cycle failure");
});

test("composition never lets a Strategy Skill touch the canonical Strategy Proposal -- state.strategyProposal is untouched immediately after composition/diagnosis, set only later by the existing approval-gated developStrategyProposal step", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "synthesize" }],
    skills: { business_strategy: COMPLETED_SKILL_FINDING },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  // NO_RECOMMENDATION_DIAGNOSIS (this file's default composition-test
  // diagnosis) never reaches developStrategyProposal at all -- confirming
  // strategyProposal stays undefined throughout composition/diagnosis/
  // routing, exactly like every existing no-recommendation test above.
  assert.strictEqual(result.strategyProposal, undefined);
  assert.strictEqual(result.stage, "delivered");
});

test("composition reaches the existing Strategy Approval Needed gate -- a recommended direction still stops for Martin's decision, never auto-approves", async (t) => {
  mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "synthesize" }],
    skills: { business_strategy: COMPLETED_SKILL_FINDING },
    diagnosis: SUFFICIENT_DIAGNOSIS,
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "awaiting_intervention_approval");
  assert.strictEqual(result.strategyApprovalState, "AWAITING_INTERVENTION_APPROVAL");
  assert.ok(result.strategyProposal, "the approval-gated proposal is built by the unchanged step, after the cycle");
  assert.ok(result.pendingStrategyApproval, "Approval Needed is reached: Martin's explicit Approve/Refine/Reject is still required");
  assert.deepStrictEqual(result.pendingStrategyApproval!.decisionOptions, ["approve", "refine", "reject"]);
});

/**
 * Governed evidence-retrieval order tests (ENIG Core Structure v3.0) --
 * orders 1, 2 and 4 of strategyEvidence.ts, plus the KoraGrid-shaped case
 * they exist for.
 *
 * Order 3 (any other explicitly governed approved source) has no
 * implementation because none exists; it is documented as a deliberate
 * no-op rather than a speculative lookup, so there is deliberately nothing
 * here to assert for it beyond that.
 */
function recordAi(inner: Ai, prompts: string[]): Ai {
  return {
    run: async (model: any, opts: any) => {
      prompts.push(JSON.stringify(opts?.messages ?? []));
      return inner.run(model, opts);
    },
  } as any;
}

const CALL_NOTES_APPROVAL_RECORD = {
  callNotesId: "CN-007",
  entity: "E-47",
  matter: "M-12",
  callDate: "2026-09-01",
  callType: "Discovery",
  sourceId: "SRC-1",
  sourceType: "transcript",
  version: 1,
};

test("Evidence order: when the Handoff holds substantive approved evidence of its own, that is order 1 and the Call Notes store is never queried", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, {
    callNotesId: "CN-007",
    callNotesAttestation: attestation,
    verifiedFacts: "Recurring client complaints about late delivery over two quarters, tied to a warehouse capacity constraint.",
  });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  assert.strictEqual(log.callNotesQueryBodies.length, 0, "order 1 must short-circuit -- no governed secondary source is consulted while the Handoff's own evidence is usable");
});

test("Evidence order: a reference-only Handoff falls through to the approved Call Notes record, read-only, and the diagnosis is grounded in it", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation });
  const env = fakeEnv();
  const prompts: string[] = [];
  env.AI = recordAi(fakeAi(NO_RECOMMENDATION_DIAGNOSIS), prompts);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(log.callNotesQueryBodies.length, 1, "exactly one exact-match lookup -- no nearest-record pass, and never inferred from Entity/Matter");
  assert.strictEqual(log.callNotesQueryBodies[0].filter?.title?.equals, "CN-007", "the lookup is the Handoff's own reference, matched exactly");
  assert.ok(
    prompts.some((p) => p.includes("Call_Notes_ID: CN-007") && p.includes("Call Date: 2026-09-01")),
    "the diagnosis is actually grounded in the governed record's registry fields, not in a bare reference",
  );
  assert.ok(
    prompts.some((p) => p.includes("order 2 -- the Handoff held no substantive evidence of its own")),
    "the provenance of the evidence is stated to the diagnosis rather than passed off as the Handoff's own narrative",
  );
  assert.strictEqual(result.stage, "delivered", "the existing core-diagnosis gate still decides sufficiency on top of the retrieved evidence");
});

test("Evidence order: an already-Consumed Call Notes record is still readable -- Strategy's read is idempotent and consumes nothing", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesStatus: "Consumed" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered", "a Consumed record still carries approved evidence; Strategy's Held -> Pending -> re-pickup loop must be able to re-read it every attempt");
  assert.strictEqual(log.callNotesQueryBodies.length, 1);
});

test("Evidence order: a Superseded Call Notes record is refused -- there is no approved current evidence to diagnose from", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesStatus: "Superseded" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "must never diagnose from a superseded record");
  const message = log.sentTexts.join("\n");
  assert.match(message, /Clarification needed/);
  assert.match(message, /Status "Superseded"/, "the reason names the exact unresolved fact");
  assert.match(message, /materially affects the decision/);
  assert.strictEqual(result.strategyApprovalState, undefined, "Clarification Needed is kept separate from Approval Needed");
});

test("Evidence order: a record whose Approval Attestation does not match its own registry fields is refused, and the refusal names the mismatch", async (t) => {
  // A syntactically valid attestation whose fields_hash no longer matches
  // what the record actually holds -- the record was altered after approval.
  const valid = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const tampered = valid.replace(/fields_hash=[0-9a-f]+/, `fields_hash=${"0".repeat(64)}`);
  assert.notStrictEqual(tampered, valid, "the fixture must actually differ from a valid attestation");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: tampered });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "an unverifiable attestation is never treated as approved evidence");
  const message = log.sentTexts.join("\n");
  assert.match(message, /Clarification needed/);
  assert.match(message, /fields_hash does not match/, "the reason names the exact unresolved fact rather than a generic 'not enough context'");
  assert.match(message, /materially affects the decision/, "order 4 must explain why the unresolved fact changes the decision");
});

test("Evidence order: with no governed reference anywhere on the Handoff, Clarification Needed names the exact fact and the Call Notes store is never queried", async (t) => {
  const log = mockFetch(t, { verifiedFacts: "Call_Notes_ID: CN-007" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(log.callNotesQueryBodies.length, 0, "a reference is never inferred from Entity/Matter -- nothing is looked up without one");
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.awaiting, "strategy_clarification", "Clarification Needed, kept separate from Approval Needed");
  assert.strictEqual(result.strategyApprovalState, undefined, "clarification must never read as an approval request");
  const message = log.sentTexts.join("\n");
  assert.match(message, /the business situation this diagnosis is about has not been established/);
  assert.match(message, /materially affects the decision/);
  assert.match(message, /points at evidence rather than being evidence/);
});

test("Evidence order: hasSubstantiveEvidence treats a Call_Notes_ID reference as pointing at evidence, never being it", () => {
  assert.strictEqual(hasSubstantiveEvidence(""), false);
  assert.strictEqual(hasSubstantiveEvidence("   \n  "), false);
  assert.strictEqual(hasSubstantiveEvidence("Call_Notes_ID: CN-007"), false);
  assert.strictEqual(hasSubstantiveEvidence("Call_Notes_ID: CN-007\nCall_Notes_ID: CN-007"), false);
  assert.strictEqual(hasSubstantiveEvidence("Recurring delivery complaints over two quarters, tied to warehouse capacity."), true, "narrative is substantive even though it carries no structured reference");
  assert.strictEqual(
    hasSubstantiveEvidence("Call_Notes_ID: CN-007\nRecurring delivery complaints over two quarters."),
    true,
    "a reference alongside a real account is retained, not discarded",
  );
});

test("KoraGrid: the case progresses from an approved Call Notes Handoff all the way to Strategy Approval Needed, without Martin doing the diagnosis", async (t) => {
  // KoraGrid-shaped fixture: the Handoff carries no narrative of its own --
  // only the governed Call_Notes_ID reference -- so the entire situation
  // reaches the diagnosis through evidence order 2. It DOES carry the
  // structured Commercial Value Evidence block every Sales -> Strategy
  // Handoff now writes (provenance for the proposal gate, deliberately not
  // counted as narrative -- see hasSubstantiveEvidence). Nothing in
  // production knows the name; this is a fixture, not a special case.
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, {
    callNotesId: "CN-007",
    callNotesAttestation: attestation,
    initialStatus: "Pending",
    verifiedFacts: `Call_Notes_ID: CN-007\n\n${DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK}`,
  });
  const env = fakeEnv();
  const prompts: string[] = [];
  env.AI = recordAi(fakeAi(SUFFICIENT_DIAGNOSIS), prompts);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(log.callNotesQueryBodies.length, 1, "the approved Call Notes record is read once, read-only");
  assert.ok(
    prompts.some((p) => p.includes("Call_Notes_ID: CN-007")),
    "the diagnosis ran on the retrieved evidence rather than on a bare reference",
  );
  assert.strictEqual(result.stage, "awaiting_intervention_approval");
  assert.strictEqual(result.strategyApprovalState, "AWAITING_INTERVENTION_APPROVAL");
  assert.ok(result.strategyProposal, "the unchanged approval-gated proposal step ran on top of the retrieved evidence");
  assert.ok(result.pendingStrategyApproval, "Approval Needed is reached -- Martin still decides; nothing auto-approves");
  assert.deepStrictEqual(result.pendingStrategyApproval!.decisionOptions, ["approve", "refine", "reject"]);
});

/**
 * The substantive-body retrieval (strategyEvidence.ts's gate 6): after every
 * existing gate has proven WHICH approved record this is, the record's own
 * page body is read and is what the diagnosis is actually grounded in.
 *
 * The registry fields remain, but as identification -- and a record with no
 * body of its own is refused rather than promoted into evidence.
 */
test("Evidence order: the approved Call Notes record's own page body reaches the Strategy diagnosis prompt, clearly separated from its registry metadata", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation });
  const env = fakeEnv();
  const prompts: string[] = [];
  env.AI = recordAi(fakeAi(NO_RECOMMENDATION_DIAGNOSIS), prompts);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  assert.ok(log.blockReads.includes("cn-page-1"), "the record's page body was actually read -- after attestation, not assumed");
  const prompt = prompts.find((p) => p.includes("Call_Notes_ID: CN-007"));
  assert.ok(prompt, "the diagnosis prompt carries the governed Call Notes record");
  assert.ok(prompt!.includes(DEFAULT_CALL_NOTES_BODY), "the substantive narrative itself reaches the prompt -- not only the eight registry fields");
  assert.ok(prompt!.includes("=== Call Notes registry fields (identification"), "registry metadata is presented as identification, labelled as such");
  assert.ok(prompt!.includes("=== Approved Call Notes page content (the substantive evidence"), "the body is presented as the substantive evidence, labelled as such");
  const callNotesSection = prompt!.slice(prompt!.indexOf("=== Approved Call Notes page content"));
  assert.ok(!callNotesSection.includes("Governance content."), "page-ID-aware: governance-page content is never served as the Call Notes body");
  assert.deepStrictEqual(log.nonNotionHosts, [], "reading the body reaches nothing outside Notion");
});

test("Evidence order: an approved Call Notes record with no page body never masquerades as substantive evidence -- metadata is not a situation", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesBody: "" });
  const env = fakeEnv();
  const prompts: string[] = [];
  env.AI = recordAi(fakeAi(SUFFICIENT_DIAGNOSIS), prompts);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.ok(log.blockReads.includes("cn-page-1"), "the body was read -- the refusal comes from what it held, not from an earlier gate");
  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "a metadata-only record is never the situation a diagnosis runs on");
  assert.strictEqual(result.strategyApprovalState, undefined, "Clarification Needed stays separate from Approval Needed");
  const message = log.sentTexts.join("\n");
  assert.match(message, /Clarification needed/);
  assert.match(message, /carries no page body/);
  assert.match(message, /registry fields identify the approved record but hold no narrative/);
  assert.match(message, /materially affects the decision/);
  assert.ok(
    !prompts.some((p) => p.includes("Call_Notes_ID: CN-007")),
    "the eight registry fields are never handed to a diagnosis as if they were the evidence",
  );
});

test("Evidence order: a Call Notes body that only points at evidence is refused as non-substantive -- the same test order 1 applies", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, {
    callNotesId: "CN-007",
    callNotesAttestation: attestation,
    callNotesBody: `Call_Notes_ID: CN-007\n\n${DEFAULT_COMMERCIAL_VALUE_EVIDENCE_BLOCK}`,
  });
  const env = fakeEnv();
  env.AI = forbiddenAi();

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined);
  const message = log.sentTexts.join("\n");
  assert.match(message, /carries a page body but nothing substantive in it/);
  assert.match(message, /only points at evidence/);
});

test("Evidence order: every gate ahead of the body read fails closed WITHOUT reading the record's page body", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const tampered = attestation.replace(/fields_hash=[0-9a-f]+/, `fields_hash=${"0".repeat(64)}`);
  assert.notStrictEqual(tampered, attestation, "the tampered fixture must actually differ from a valid attestation");

  const cases: Array<{ name: string; opts: Parameters<typeof mockFetch>[1]; match: RegExp }> = [
    {
      name: "wrong Entity relation",
      opts: { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesEntityRelation: "some-other-entity-page" },
      match: /not bound to this Work's Entity/,
    },
    {
      name: "wrong Matter relation",
      opts: { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesMatterRelation: "some-other-matter-page" },
      match: /not bound to this Work's Matter/,
    },
    {
      name: "invalid Status",
      opts: { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesStatus: "Superseded" },
      match: /Status "Superseded"/,
    },
    {
      name: "tampered Approval Attestation",
      opts: { callNotesId: "CN-007", callNotesAttestation: tampered },
      match: /fields_hash does not match/,
    },
    {
      name: "zero exact matches",
      opts: { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesMatches: 0 },
      match: /no Call Notes record has Call_Notes_ID "CN-007"/,
    },
    {
      name: "multiple exact matches",
      opts: { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesMatches: 2 },
      match: /2 Call Notes records carry Call_Notes_ID "CN-007"/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const log = mockFetch(st, entry.opts);
      const env = fakeEnv();
      env.AI = forbiddenAi();

      const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

      assert.strictEqual(result.stage, "strategy_blocked", "the gate refuses rather than proceeding");
      assert.strictEqual(result.strategyDiagnosis, undefined, "no diagnosis runs on an unproven record");
      assert.ok(!log.blockReads.includes("cn-page-1"), "the page body was never read -- the refusal came first, and nothing was fetched for it");
      assert.strictEqual(log.callNotesQueryBodies.length, 1, "exactly one exact lookup, as before");
      const message = log.sentTexts.join("\n");
      assert.match(message, /Clarification needed/);
      assert.match(message, entry.match, "the refusal names the exact unresolved fact");
      assert.match(message, /materially affects the decision/);
    });
  }
});

test("Evidence order: an Evidence Package URL inside the Call Notes body is text the diagnosis reads, never a retrieval to follow", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const body =
    "Evidence Package Location: https://files.example.com/packages/koragrid-call-note-update.pdf -- Evidence Package ID: /projects/01a101bb/areas/koragrid-call-note-update.md";
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesBody: body });
  const env = fakeEnv();
  const prompts: string[] = [];
  env.AI = recordAi(fakeAi(NO_RECOMMENDATION_DIAGNOSIS), prompts);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  const prompt = prompts.find((p) => p.includes("Call_Notes_ID: CN-007"));
  assert.ok(prompt, "the diagnosis prompt carries the record");
  assert.ok(prompt!.includes("https://files.example.com/packages/koragrid-call-note-update.pdf"), "the URL reaches the model as TEXT");
  assert.deepStrictEqual(log.nonNotionHosts, [], "the URL is never followed -- no request to any external host");
  assert.deepStrictEqual(
    log.blockReads.filter((id) => id === "cn-page-1"),
    ["cn-page-1"],
    "exactly one body read: the body is the evidence, and nothing in it is retrieved",
  );
});

test("Evidence order: order 1 still wins outright -- a substantive Handoff never reaches the Call Notes record OR its body", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, {
    callNotesId: "CN-007",
    callNotesAttestation: attestation,
    verifiedFacts: "Recurring client complaints about late delivery over two quarters, tied to a warehouse capacity constraint.",
  });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  assert.strictEqual(log.callNotesQueryBodies.length, 0, "order 1 short-circuits -- the store is never queried");
  assert.ok(!log.blockReads.includes("cn-page-1"), "and the record's page body is never read either");
});

test("Evidence order: repeated Strategy pickup re-reads the same body read-only -- no Status write, no consumption, on either attempt", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesStatus: "Ready" });
  const env = fakeEnv();
  env.AI = fakeAi(NO_RECOMMENDATION_DIAGNOSIS);

  const first = await handlePickup(env, fakeState(), STRATEGY_SKILLS);
  const second = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(first.stage, "delivered");
  assert.strictEqual(second.stage, "delivered", "the Held -> Pending -> re-pickup loop re-reads the same approved evidence every attempt");
  assert.strictEqual(log.callNotesQueryBodies.length, 2, "one exact lookup per pickup");
  assert.deepStrictEqual(
    log.blockReads.filter((id) => id === "cn-page-1"),
    ["cn-page-1", "cn-page-1"],
    "the body is read again on the second attempt rather than consumed away",
  );
  assert.ok(
    log.callNotesRequests.every((request) => /^(GET|POST) /.test(request)),
    `the Call Notes record is only ever read (requests made: ${log.callNotesRequests.join(" | ")}) -- a Status transition would be a PATCH, and the mock has no write route for this store`,
  );
  assert.ok(
    log.callNotesRequests.some((request) => request.startsWith("POST ") && request.includes("/data_sources/call-notes-ds/query")),
    "the exact-title lookup is the only query issued against the store",
  );
});

test("Evidence order: a body read that fails is a named gap on the structured refusal path, not a generic exception about Handoff access", async (t) => {
  const attestation = await buildRecordApprovalMarker(CALL_NOTES_APPROVAL_RECORD, "Approved");
  const log = mockFetch(t, { callNotesId: "CN-007", callNotesAttestation: attestation, callNotesBodyReadFails: true });
  const env = fakeEnv();
  env.AI = forbiddenAi();

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked", "the failure is converted into the existing structured refusal, so the flow stays fail-closed");
  assert.strictEqual(result.strategyDiagnosis, undefined, "no diagnosis runs on a record whose evidence could not be read");
  assert.ok(log.blockReads.includes("cn-page-1"), "the read was attempted -- after attestation -- and it is that read which failed");
  const message = log.sentTexts.join("\n");
  assert.match(message, /Clarification needed/);
  assert.match(message, /could not be read beyond its registry fields/);
  assert.match(message, /registry fields identify the record but are not the evidence/);
  assert.match(message, /materially affects the decision/);
  assert.ok(
    !message.includes("handoff record access"),
    "the failure is NOT reported as the generic outer Handoff-access exception",
  );
});

/** The Activity Log Blocker entry's own rationale, exactly as `logActivity` wrote it. */
function activityLogBlocker(log: FetchLog): string {
  const entry = log.activityLogBodies.find((body) => body.properties?.Type?.select?.name === "Blocker");
  return String(entry?.properties?.["Decision Rationale"]?.rich_text?.[0]?.text?.content ?? "");
}

/** The six moves the cap test needs: the seventh analysis decision is the one MAX_STRATEGY_SKILL_INVOCATIONS refuses. */
const SIX_INVOKE_MOVES: Move[] = [
  { next: "invoke", skillId: "business_strategy" },
  { next: "invoke", skillId: "brand_strategy" },
  { next: "invoke", skillId: "communication_strategy" },
  { next: "invoke", skillId: "research_signal" },
  { next: "invoke", skillId: "business_strategy" },
  { next: "invoke", skillId: "brand_strategy" },
];

test("failure observability: a cap hold records which Skills ran -- six skillId:status entries in invocation order, original termination reason preserved, no finding prose", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai } = fakeAiCycle({ moves: SIX_INVOKE_MOVES });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategyDiagnosis, undefined, "the cap hold fails closed -- core diagnosis never runs on it");
  assert.strictEqual(result.strategySkillFindings?.length, 6, "six findings were recorded before the seventh invoke move was refused");

  const blocker = activityLogBlocker(log);
  assert.ok(blocker, "the Activity Log Blocker entry is written");
  const termination = "The diagnostic cycle did not converge within 6 Strategy Skill invocations";
  assert.ok(blocker.includes(termination), "the original termination reason is preserved verbatim");
  const expected = [
    "1. business_strategy:completed",
    "2. brand_strategy:completed",
    "3. communication_strategy:completed",
    "4. research_signal:completed",
    "5. business_strategy:completed",
    "6. brand_strategy:completed",
  ];
  let cursor = -1;
  for (const entry of expected) {
    const at = blocker.indexOf(entry);
    assert.ok(at > cursor, `blocker must carry ${entry} in original invocation order -- got: ${blocker}`);
    cursor = at;
  }
  assert.ok(
    blocker.indexOf(termination) < blocker.indexOf(expected[0]),
    "the termination reason comes first and the metadata summary is appended after it",
  );
  for (const prose of [
    "established a bounded domain finding",
    "could not establish cost or market size",
    "implies the open question",
    "still need to know",
    "failureReason",
    "evidenceLimitation",
    "implication:",
  ]) {
    assert.ok(!blocker.includes(prose), `no finding prose may appear in the blocker summary (found: ${prose})`);
  }
  const handoffReason = log.handoffPatchBodies
    .map((p) => p.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content)
    .find((c) => typeof c === "string" && c.includes(termination));
  assert.ok(handoffReason?.includes("6. brand_strategy:completed"), "the Handoff's Open Questions carry the same metadata summary");
  assert.ok(
    log.sentTexts.some((s) => s.includes(termination) && s.includes("1. business_strategy:completed") && s.includes("6. brand_strategy:completed")),
    "the operator message carries the same metadata summary",
  );
});

test("failure observability: failed Skill invocations keep their status metadata on the cap path -- blockedReason/failure prose never reaches the blocker", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const failingProse = [
    "FAILING PROSE business: no cost or vendor-capacity figures were supplied",
    "FAILING PROSE brand: no perception evidence was supplied",
    "FAILING PROSE communication: no messaging evidence was supplied",
    "FAILING PROSE research: the single supplied source is not corroborated",
  ];
  const { ai } = fakeAiCycle({
    moves: SIX_INVOKE_MOVES,
    skills: {
      business_strategy: { sufficient: false, blockedReason: failingProse[0] },
      brand_strategy: { sufficient: false, blockedReason: failingProse[1] },
      communication_strategy: { sufficient: false, blockedReason: failingProse[2] },
      research_signal: { sufficient: false, blockedReason: failingProse[3] },
    },
  });
  env.AI = ai;
  const state = fakeState();

  const result = await handlePickup(env, state, STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.strategySkillFindings?.length, 6);
  assert.ok(
    result.strategySkillFindings?.every((f) => f.status === "failed"),
    "every recorded finding is failed -- the statuses are what the blocker may show",
  );

  const blocker = activityLogBlocker(log);
  assert.ok(blocker, "the Activity Log Blocker entry is written");
  const termination = "The diagnostic cycle did not converge within 6 Strategy Skill invocations";
  assert.ok(blocker.includes(termination), "the cap termination reason is what stopped this cycle");
  assert.ok(
    !blocker.includes("Every Strategy Skill invoked"),
    "the separate 'every Skill failed' diagnosis was NOT taken: Strategy Analysis kept choosing invoke, so the cap is what refused it",
  );
  const expected = [
    "1. business_strategy:failed",
    "2. brand_strategy:failed",
    "3. communication_strategy:failed",
    "4. research_signal:failed",
    "5. business_strategy:failed",
    "6. brand_strategy:failed",
  ];
  let cursor = -1;
  for (const entry of expected) {
    const at = blocker.indexOf(entry);
    assert.ok(at > cursor, `blocker must carry ${entry} in original invocation order -- got: ${blocker}`);
    cursor = at;
  }
  for (const prose of failingProse) {
    assert.ok(!blocker.includes(prose), `failed finding prose must never appear in the blocker (found: ${prose})`);
  }
  assert.ok(!blocker.includes("UNAVAILABLE"), "a failed finding is reported by status only, never by its narrative");
  assert.ok(!log.sentTexts.join("\n").includes(failingProse[0]), "the operator message carries no failed-finding prose either");
});

test("failure observability: a converging cycle still synthesizes and raises no blocker, so no invocation metadata is appended anywhere", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({
    moves: [{ next: "invoke", skillId: "business_strategy" }, { next: "synthesize" }],
    skills: { business_strategy: COMPLETED_SKILL_FINDING },
  });
  env.AI = ai;

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "delivered");
  assert.ok(calls.some((c) => c.kind === "synthesis"), "synthesis still runs -- the metadata summary exists only on the hold path");
  assert.ok(calls.some((c) => c.kind === "diagnosis"), "the unchanged core diagnosis still follows synthesis");
  const blockers = log.activityLogBodies.filter((b) => b.properties?.Type?.select?.name === "Blocker");
  assert.strictEqual(blockers.length, 0, "no blocker is raised when the cycle converges");
  assert.ok(
    log.sentTexts.every((s) => !s.includes("Strategy Skill invocations (number. skillId:status)")),
    "no invocation metadata is appended to a non-blocked run's messages",
  );
  assert.ok(
    log.handoffPatchBodies.every((p) => !(p.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content ?? "").includes("Strategy Skill invocations (number.")),
    "no invocation metadata is appended to a non-blocked run's Handoff writes",
  );
});

test("failure observability: the invocation metadata costs no additional AI call, no Notion read and no external source access", async (t) => {
  const log = mockFetch(t, { initialStatus: "Pending" });
  const env = fakeEnv();
  const { ai, calls } = fakeAiCycle({ moves: SIX_INVOKE_MOVES });
  env.AI = ai;

  const result = await handlePickup(env, fakeState(), STRATEGY_SKILLS);

  assert.strictEqual(result.stage, "strategy_blocked");
  // Exactly the cycle's own work: six Skill executions and seven Strategy
  // Analysis decisions (the seventh being the move the cap refuses).
  assert.strictEqual(calls.filter((c) => c.kind === "skill").length, 6, "six Skill executions, unchanged");
  assert.strictEqual(calls.filter((c) => c.kind === "analysis").length, 7, "seven analysis decisions, unchanged");
  assert.strictEqual(
    calls.filter((c) => c.kind === "synthesis" || c.kind === "diagnosis" || c.kind === "routing" || c.kind === "proposal").length,
    0,
    "the summary is assembled from the persisted findings alone -- no further model step of any kind runs to produce it",
  );
  assert.deepStrictEqual(
    log.requests.filter((r) => r.includes("/blocks/")),
    [],
    "no Notion page-content (block-children) read is performed to build or write the summary",
  );
  const notionReads = log.requests.filter((r) => r.startsWith("GET ") && r.includes("api.notion.com"));
  assert.ok(
    notionReads.every((r) => /\/pages\/(handoff-1|entity-page-1|matter-page-1)$/.test(r)),
    `the only Notion reads are the pre-existing pickup lookups -- no governance page, no Call Notes record and no page body is read to build the summary (got: ${notionReads.join(" | ")})`,
  );
  assert.deepStrictEqual(
    log.requests.filter((r) => !r.includes("api.notion.com") && !r.includes("api.telegram.org")),
    [],
    "no external source is touched",
  );
  assert.strictEqual(
    log.requests.filter((r) => r === "POST https://api.notion.com/v1/pages").length,
    2,
    "the only Activity Log writes are the pre-existing pickup entry and this blocker -- the summary creates nothing new",
  );
});
