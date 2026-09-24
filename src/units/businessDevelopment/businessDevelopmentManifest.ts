import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { SemanticTaskId } from "../../dataBoundary/types";
import type { BDOpportunityState } from "./types";
import type { HatManifest, UnitManifest } from "../unitManifest";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import { createHandoff } from "../../handoffWriter";
import { title, richText } from "../../notion";
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
 * and handoff_to_sales/handoff_to_strategy create real Handoffs via the
 * same evaluateHandoffContext + createHandoff path Strategy uses.
 * Partnership Development and Growth & Market Development are present --
 * so Hat resolution genuinely exercises three Hats, not one -- but their
 * handlers are explicit stubs pending the same treatment.
 *
 * Two things still not decided here, left as loud placeholders rather
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
 * TODO(governance): handoff_to_sales/handoff_to_strategy's
 * evaluateHandoffContext call below needs a `requiredCategory` that
 * matches an approved Data Boundary policy table entry (see
 * dataBoundary/policy.ts) -- placeholder value only, not yet an approved
 * category.
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
 * Entry handler for Opportunity Development's "internal" and "write"
 * actions. qualify_opportunity routes here (not readHandler) because it
 * needs the WorkSession to pause/resume on Held -- see
 * runQualifyOpportunity. handoff_to_sales/handoff_to_strategy create a
 * real Handoff via the same evaluateHandoffContext + createHandoff path
 * Strategy's handleDirectRequest uses, so the Handoff identity-write
 * boundary is enforced identically -- not a parallel, weaker path for BD.
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

  if (actionName === "handoff_to_sales" || actionName === "handoff_to_strategy") {
    const evalResult = evaluateHandoffContext(
      {
        entityToken: state.entityToken ?? "",
        matterToken: state.matterToken,
        sanitizedContext: text,
        provenance: "business_development.opportunity_development",
        // TODO(governance): placeholder -- needs an approved Data Boundary
        // policy table entry before this is a real requiredCategory.
        requiredCategory: "business_development_opportunity_handoff",
      },
      // TODO(governance): "sales.opportunity_handoff"/"strategy.opportunity_handoff"
      // are not registered SemanticTaskIds yet -- this cast is a deliberate,
      // loud placeholder so the draft typechecks, not an approved task.
      (actionName === "handoff_to_sales" ? "sales.opportunity_handoff" : "strategy.opportunity_handoff") as unknown as SemanticTaskId,
    );
    if (!evalResult.success) {
      await sendWorkspaceHatMessage(
        env,
        { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME },
        `Couldn't prepare this handoff.\n\n${evalResult.insufficientContext.reason}`,
      );
      return state;
    }
    await createHandoff(
      env,
      {
        Handoff: title(`Business Development -> ${actionName === "handoff_to_sales" ? "Sales" : "Strategy"}: opportunity handoff`),
        Reason: richText(evalResult.contract.sanitizedContext),
      },
      { entityToken: evalResult.contract.entityToken, matterToken: evalResult.contract.matterToken ?? "" },
    );
    await logActivity(env, {
      entry: `Business Development handed off opportunity to ${actionName === "handoff_to_sales" ? "Sales" : "Strategy"}`,
      type: "Activity",
      area: "Business Development",
      activity: `Opportunity Development Hat prepared a governed transition via ${actionName}.`,
      outcome: "Active",
    });
    return state;
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
};
