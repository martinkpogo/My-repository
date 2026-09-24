import type { Env, WorkState, Unit } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { BDOpportunityState } from "./types";
import type { HatManifest, UnitManifest } from "../unitManifest";
import { createHandoff } from "../../handoffWriter";
import { title, richText, select } from "../../notion";
import { sendWorkspaceHatMessage } from "../../telegram";
import { logActivity } from "../../log";

/**
 * Business Development's Unit Manifest -- the first Unit built entirely
 * on the manifest/registry pattern (ENIG Operating Model design doc,
 * "Business Development as conformance test"). NOT yet wired into
 * dispatchCowork/WorkSession/handleTextReply -- this is the manifest
 * itself, built from the real Hat Definitions already in Notion (ENIG HQ
 * / 2. Units & Hats / Units / Business Development), so it reflects real
 * requirements rather than a theoretical schema.
 *
 * All three Hats share one action shape (discover -> research -> assess
 * -> qualify -> develop -> determine_next_move -> handoff_to_sales /
 * handoff_to_strategy) with domain-specific action names per Hat, which
 * is exactly why action resolution must be scoped per Hat (see
 * unitManifest.ts's doc comment) -- `determine_next_move`,
 * `handoff_to_sales`, and `handoff_to_strategy` are literally the same
 * name on all three Hats.
 *
 * CONSEQUENCE LEVELS (per Architect's Action Registry correction --
 * see actionRegistry.ts): discover/research/assess are "read" (no
 * persisted state). qualify_* is "internal" -- it needs a WorkSession to
 * pause on Held/missing-evidence and resume later, but that is execution
 * state, not a privileged commitment, so it never requires approval.
 * develop_* / determine_next_move / handoff_to_sales / handoff_to_strategy
 * are "write" with requiresApproval: true -- these commit real direction or
 * cross a Unit boundary, so they gate on Martin's sign-off before being
 * final. This is BD's own conformance-test proof that internal and write
 * are genuinely different gates, not a relabeled binary.
 *
 * STATUS: Opportunity Development is built out close to real -- its
 * qualify_opportunity hold/resume flow is real (against BDOpportunityState),
 * and handoff_to_sales/handoff_to_strategy follow the same preview +
 * Martin-approval + createHandoff pattern Strategy's routeToUnit/
 * handleStrategyHandoffApproval and R&I's routeToConsumingHat/
 * handleResearchHandoffApproval already use -- not a parallel, weaker
 * path for BD. (An earlier draft of this file called
 * evaluateHandoffContext with a made-up SemanticTaskId here, which was
 * simply the wrong pattern: that function validates *inbound* context
 * for a Handoff pickup or direct request, e.g. strategy.diagnosis --
 * it's never used to gate an *outbound* Handoff creation, which is a
 * preview object + Telegram approve/reject buttons + createHandoff only
 * on approval, no SemanticTaskId involved at all. Corrected here; no
 * governance decision was actually needed.)
 *
 * Partnership Development and Growth & Market Development are present --
 * so Hat resolution genuinely exercises three Hats, not one -- but their
 * handlers are explicit stubs pending the same treatment.
 *
 * One thing still not decided here, left as a loud placeholder rather
 * than invented:
 *
 * TODO(intelligence): discover_opportunity/research_opportunity/
 * assess_opportunity, and qualify_opportunity's actual evidence-sufficiency
 * judgment, all need real, registered AI tasks (matching how
 * marketing.hat_action_decision and strategy's diagnosis tasks are
 * registered) -- qualify_opportunity's hold/resume *mechanism* below is
 * real, but what decides Qualified/Held/Blocked is still a placeholder
 * rule (non-empty evidence => Qualified), not real reasoning.
 *
 * NOTE: the approval callback itself (Martin tapping "Send handoff") is
 * routed today by a hand-wired switch in session.ts (`case
 * "researchhandoff":` / `case "strategyhandoff":`) -- a fourth hand-wired
 * chokepoint beyond the three the design doc already names
 * (dispatchCowork, WorkSession's per-Unit methods, handleTextReply's
 * awaiting-switch). handleBDOpportunityHandoffApproval below is written
 * to slot into that same pattern once BD is actually wired into
 * dispatch; not fixed here, since wiring dispatch at all is a later,
 * separate step per the design doc's rollout order.
 */

type OpportunityDevelopmentAction =
  | "discover_opportunity"
  | "research_opportunity"
  | "assess_opportunity"
  | "qualify_opportunity"
  | "develop_opportunity"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

const OPPORTUNITY_DEVELOPMENT_HAT_NAME = "Business Development Manager — Opportunity Development";
const EVIDENCE_GAP_AWAITING_STATE = "bd_opportunity_evidence_gap" as const;

const opportunityDevelopmentActions: ActionDefinition<OpportunityDevelopmentAction>[] = [
  { name: "discover_opportunity", consequence: "read", description: "Identify a candidate BD opportunity from a signal, market, organisation, or relationship." },
  { name: "research_opportunity", consequence: "read", description: "Gather evidence-backed findings on a named opportunity signal." },
  { name: "assess_opportunity", consequence: "read", description: "Determine whether a researched signal has a substantive reason for ENIG to pursue it." },
  {
    name: "qualify_opportunity",
    consequence: "internal",
    description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated.",
  },
  { name: "develop_opportunity", consequence: "write", requiresApproval: true, description: "Take a qualified opportunity forward: stakeholders, value hypothesis, route, dependencies, risks, next step." },
  { name: "determine_next_move", consequence: "write", requiresApproval: true, description: "Commit to the next concrete action for an active opportunity." },
  { name: "handoff_to_sales", consequence: "write", requiresApproval: true, description: "Governed transition to Sales once the opportunity is a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", consequence: "write", requiresApproval: true, description: "Governed transition to Strategy when the opportunity needs strategic diagnosis rather than client-acquisition progression." },
];

async function opportunityDevelopmentReadHandler(_env: Env, actionName: OpportunityDevelopmentAction, _text: string): Promise<string> {
  switch (actionName) {
    case "discover_opportunity":
    case "research_opportunity":
    case "assess_opportunity":
      // TODO(intelligence): real AI-driven evidence reasoning per the Hat
      // Definition's per-action Output contract (Notion). Each of these
      // needs its own registered, governed AI task before this can
      // produce a real answer rather than an explicit placeholder.
      throw new Error(`business_development.opportunity_development.${actionName}: read handler not yet implemented -- draft manifest only.`);
    default:
      // qualify_opportunity is "internal" and develop_opportunity/
      // determine_next_move/handoff_to_sales/handoff_to_strategy are
      // "write" -- dispatchAction never routes any of them here;
      // reaching this branch means the caller didn't respect the
      // declared consequence.
      throw new Error(`${actionName}: not a read action on Opportunity Development.`);
  }
}

/** Placeholder qualification rule -- TODO(intelligence) above. Real reasoning replaces this once qualify_opportunity's AI task is registered. */
function placeholderQualify(state: BDOpportunityState): { qualification: "Qualified" | "Held"; rationale: string; missingEvidence?: string[] } {
  if (state.evidence.length === 0) {
    return {
      qualification: "Held",
      rationale: "No evidence gathered yet for this opportunity.",
      missingEvidence: ["at least one piece of supporting evidence for this opportunity"],
    };
  }
  return { qualification: "Qualified", rationale: `Qualified on ${state.evidence.length} piece(s) of gathered evidence.` };
}

async function runQualifyOpportunity(env: Env, state: WorkState, hatName: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  const result = placeholderQualify(opportunity);

  state.bdOpportunity = {
    ...opportunity,
    qualification: result.qualification,
    qualificationRationale: result.rationale,
    missingEvidence: result.missingEvidence,
  };

  if (result.qualification === "Held") {
    state.awaiting = EVIDENCE_GAP_AWAITING_STATE;
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: hatName },
      `Held -- ${result.rationale}\n\nWhat evidence can you share for: ${result.missingEvidence?.join(", ")}?`,
    );
    return state;
  }

  state.awaiting = undefined;
  await sendWorkspaceHatMessage(env, { ...state, hat: hatName }, `Qualified -- ${result.rationale}`);
  return state;
}

/**
 * Proposes (never auto-creates) a BD -> Sales/Strategy opportunity
 * handoff -- mirrors Strategy's routeToUnit / R&I's routeToConsumingHat
 * exactly: build a preview into pendingBDHandoff, present Telegram
 * approve/reject buttons, and only create the Handoff in
 * handleBDOpportunityHandoffApproval once Martin approves. No
 * SemanticTaskId or evaluateHandoffContext involved -- that machinery is
 * for validating inbound context, not gating an outbound Handoff.
 */
async function proposeOpportunityHandoff(env: Env, state: WorkState, targetUnit: Unit, targetHat: string, text: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity;
  const opportunitySummary = (opportunity?.qualificationRationale ?? text).slice(0, 1900);
  const reason = `Business Development's Opportunity Development Hat judged this opportunity ready for ${targetHat}'s ownership.`;

  state.pendingBDHandoff = {
    unit: targetUnit,
    hat: targetHat,
    handoffTitle: `Business Development -> ${targetHat}: opportunity handoff`,
    reason,
    opportunitySummary,
  };

  await logActivity(env, {
    entry: `Business Development proposed handoff to ${targetHat} -- pending approval`,
    type: "Decision",
    area: "Business Development",
    decisionRationale: reason,
    outcome: "Blocked",
  });

  const handoffMessage = `This opportunity looks ready for *${targetHat}*: ${reason}\n\n*Preview of what would be sent:*\n${opportunitySummary}\n\nThis is a recommendation, not yet an approved decision. Send this handoff?`;
  const handoffButtons = [
    [
      { text: "✅ Send handoff", callback_data: `bdopportunityhandoff:${state.workId}:approve` },
      { text: "🚫 Don't send", callback_data: `bdopportunityhandoff:${state.workId}:reject` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, handoffMessage, handoffButtons);
  return state;
}

/**
 * Resolves handoff_to_sales/handoff_to_strategy's approve/reject callback
 * -- mirrors handleStrategyHandoffApproval/handleResearchHandoffApproval
 * exactly. Pre-Entity, same as Lead Discovery's own pre-Entity Handoffs
 * (leadGenerationDiscovery.ts): BD never resolves a real Entity/Matter,
 * so this uses the same "E-UNBOUND"/"M-UNBOUND" placeholder tokens
 * rather than leaving the required fields empty.
 */
export async function handleBDOpportunityHandoffApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingBDHandoff;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "There's no pending handoff to act on.");
    return state;
  }

  if (!approved) {
    state.pendingBDHandoff = undefined;
    await logActivity(env, {
      entry: `Business Development handoff to ${pending.hat} declined by Martin`,
      type: "Decision",
      area: "Business Development",
      decisionRationale: "Martin chose not to send this opportunity to the proposed Hat.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, `Okay -- this opportunity wasn't sent to *${pending.hat}*.`);
    return state;
  }

  await createHandoff(
    env,
    {
      Handoff: title(pending.handoffTitle),
      "From Unit": select("Business Development"),
      "From Hat": richText(OPPORTUNITY_DEVELOPMENT_HAT_NAME),
      "To Unit": select(pending.unit),
      "To Hat": richText(pending.hat),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(pending.reason),
      "Verified Facts & Sources": richText(pending.opportunitySummary),
    },
    { entityToken: "E-UNBOUND", matterToken: "M-UNBOUND" },
  );
  await logActivity(env, {
    entry: `Business Development handed off opportunity to ${pending.hat}`,
    type: "Activity",
    area: "Business Development",
    activity: `Opportunity Development Hat's handoff to ${pending.hat} approved by Martin.`,
    outcome: "Active",
  });
  state.pendingBDHandoff = undefined;
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, `Sent to *${pending.hat}*.`);
  return state;
}

/**
 * Entry handler for Opportunity Development's "internal" and "write"
 * actions. qualify_opportunity routes here (not readHandler) because it
 * needs the WorkSession to pause/resume on Held -- see
 * runQualifyOpportunity. handoff_to_sales/handoff_to_strategy only
 * propose the handoff here -- the actual Handoff is created in
 * handleBDOpportunityHandoffApproval once Martin approves.
 */
async function opportunityDevelopmentEntryHandler(
  env: Env,
  state: WorkState,
  actionName: OpportunityDevelopmentAction,
  text: string,
): Promise<WorkState> {
  if (actionName === "qualify_opportunity") {
    return runQualifyOpportunity(env, state, OPPORTUNITY_DEVELOPMENT_HAT_NAME);
  }

  if (actionName === "handoff_to_sales") {
    return proposeOpportunityHandoff(env, state, "Sales", "Sales Executive", text);
  }

  if (actionName === "handoff_to_strategy") {
    return proposeOpportunityHandoff(env, state, "Strategy", "Strategy Analyst", text);
  }

  // TODO: develop_opportunity/determine_next_move -- these mutate
  // bdOpportunity.developedState; not yet implemented beyond the type
  // existing (see BDOpportunityState.developedState).
  throw new Error(`business_development.opportunity_development.${actionName}: entry handler not yet implemented beyond qualify/handoff actions -- draft manifest only.`);
}

/**
 * Resumes a WorkSession held on qualify_opportunity's evidence gap --
 * appends the reply as new evidence and re-runs qualification, exactly
 * as the initial call does, rather than a separate, drifting
 * implementation of the same rule.
 */
async function resumeQualifyOpportunity(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: "", evidence: [] };
  state.bdOpportunity = { ...opportunity, evidence: [...opportunity.evidence, text] };
  return runQualifyOpportunity(env, state, OPPORTUNITY_DEVELOPMENT_HAT_NAME);
}

const opportunityDevelopmentAwaitingHandlers: HatManifest<OpportunityDevelopmentAction>["awaitingHandlers"] = {
  [EVIDENCE_GAP_AWAITING_STATE]: resumeQualifyOpportunity,
};

const opportunityDevelopmentHat: HatManifest<OpportunityDevelopmentAction> = {
  name: OPPORTUNITY_DEVELOPMENT_HAT_NAME,
  responsibility:
    "Own the development of specific opportunities that could create meaningful growth for ENIG. Turn an observed market, organisation, partnership, channel, offering, or relationship signal into an evidenced BD opportunity that can either be developed further or handed to the appropriate ENIG Unit. Does not own the client/entity lifecycle once an opportunity becomes a genuine client-acquisition opportunity -- that boundary belongs to Sales.",
  actions: opportunityDevelopmentActions,
  readHandler: opportunityDevelopmentReadHandler,
  entryHandler: opportunityDevelopmentEntryHandler,
  awaitingHandlers: opportunityDevelopmentAwaitingHandlers,
};

// --- Partnership Development and Growth & Market Development: present so
// Hat resolution genuinely exercises three Hats (not one), but stubbed --
// same 8-action shape as Opportunity Development per their Notion Hat
// Definitions, pending the same real-implementation pass (including the
// same internal/write split qualify_partnership/qualify_growth_opportunity
// will need once built out).

type PartnershipDevelopmentAction =
  | "discover_partner"
  | "research_partner"
  | "assess_partnership"
  | "qualify_partnership"
  | "develop_partnership"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

const partnershipDevelopmentActions: ActionDefinition<PartnershipDevelopmentAction>[] = [
  { name: "discover_partner", consequence: "read", description: "Identify a potential partner or strategic relationship." },
  { name: "research_partner", consequence: "read", description: "Research the organisation, stakeholders, capabilities, and relationship context." },
  { name: "assess_partnership", consequence: "read", description: "Assess mutual value, strategic fit, and relationship viability." },
  { name: "qualify_partnership", consequence: "internal", description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated." },
  { name: "develop_partnership", consequence: "write", requiresApproval: true, description: "Develop a qualified partnership: stakeholders, value proposition, route, dependencies, risks." },
  { name: "determine_next_move", consequence: "write", requiresApproval: true, description: "Commit to the next concrete action for an active partnership opportunity." },
  { name: "handoff_to_sales", consequence: "write", requiresApproval: true, description: "Governed transition to Sales once the partnership becomes a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", consequence: "write", requiresApproval: true, description: "Governed transition to Strategy when the partnership needs strategic diagnosis." },
];

function notYetImplementedHat<A extends string>(hatName: string, responsibility: string, actions: ActionDefinition<A>[]): HatManifest<A> {
  return {
    name: hatName,
    responsibility,
    actions,
    readHandler: async (_env, actionName) => {
      throw new Error(`${hatName}.${actionName}: read handler not yet implemented -- draft manifest only.`);
    },
    entryHandler: async (_env, _state, actionName) => {
      throw new Error(`${hatName}.${actionName}: entry handler not yet implemented -- draft manifest only.`);
    },
    awaitingHandlers: {},
  };
}

const partnershipDevelopmentHat = notYetImplementedHat(
  "Partnerships Manager — Partnership Development",
  "Own the development of strategic relationships and partnership opportunities that could create meaningful value for ENIG. Identify, assess, and develop relationships where the relationship or partnership itself is the central business opportunity. Does not automatically own client acquisition, strategic diagnosis, or execution responsibilities belonging to another ENIG Unit.",
  partnershipDevelopmentActions,
);

type GrowthMarketDevelopmentAction =
  | "discover_growth_opportunity"
  | "research_market"
  | "assess_market_opportunity"
  | "qualify_growth_opportunity"
  | "develop_growth_opportunity"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

const growthMarketDevelopmentActions: ActionDefinition<GrowthMarketDevelopmentAction>[] = [
  { name: "discover_growth_opportunity", consequence: "read", description: "Identify a potential market, channel, offering, or growth space." },
  { name: "research_market", consequence: "read", description: "Research market/industry signals, segments, channels, competitors, demand." },
  { name: "assess_market_opportunity", consequence: "read", description: "Assess market attractiveness, strategic/commercial relevance, capability fit." },
  { name: "qualify_growth_opportunity", consequence: "internal", description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated." },
  { name: "develop_growth_opportunity", consequence: "write", requiresApproval: true, description: "Develop a qualified growth opportunity: value hypothesis, requirements, route, risks." },
  { name: "determine_next_move", consequence: "write", requiresApproval: true, description: "Commit to the next concrete action for an active growth opportunity." },
  { name: "handoff_to_sales", consequence: "write", requiresApproval: true, description: "Governed transition to Sales once the growth opportunity becomes a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", consequence: "write", requiresApproval: true, description: "Governed transition to Strategy when the growth opportunity needs strategic diagnosis." },
];

const growthMarketDevelopmentHat = notYetImplementedHat(
  "Growth & Market Development Manager — Growth & Market Development",
  "Own the identification and development of broader opportunities for ENIG's growth across markets, channels, offerings, and growth directions. Identify, research, assess, and develop growth directions where the central question concerns ENIG's broader market position, expansion, channels, offerings, or future sources of growth. Does not automatically own client acquisition, strategic diagnosis, or execution responsibilities belonging to another ENIG Unit.",
  growthMarketDevelopmentActions,
);

export const businessDevelopmentManifest: UnitManifest = {
  unit: "Business Development",
  hats: {
    [opportunityDevelopmentHat.name]: opportunityDevelopmentHat,
    [partnershipDevelopmentHat.name]: partnershipDevelopmentHat,
    [growthMarketDevelopmentHat.name]: growthMarketDevelopmentHat,
  },
  // Registered in dataBoundary/types.ts + registry.ts, but NOT yet
  // classified in PRODUCTION_TASK_SENSITIVITY (dataBoundary/policy.ts) --
  // pending Architect review. Calls against these taskIds fail closed
  // (UNRESOLVED_POLICY_HOLD) until that classification lands; this
  // manifest is wired into dispatch but not yet live end-to-end.
  intakeClassificationTaskId: "business_development.intake_classification",
  intakeIntroLine: "You route incoming Business Development requests for ENIG, among its three parallel specialist Hats.",
  actionClassificationTaskId: "business_development.hat_action_decision",
};
