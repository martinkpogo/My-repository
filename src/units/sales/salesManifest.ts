import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
import { discoverLeadsReadHandler, handleLeadOpportunityApproval } from "./leadGenerationDiscovery";
import * as sales from "./salesExecutive";

/**
 * Sales's Unit Registry manifest (ENIG Operating Model design doc, "The
 * Unit Registry"). Sales has two Hats (Sales Executive, specialization
 * Sales Progression; Lead Generation Specialist, specialization Lead
 * Discovery -- see hats/registry.ts's SALES_EXECUTIVE/
 * LEAD_GENERATION_SPECIALIST), both declared here.
 *
 * Sales Executive is a thin wrap, mirroring strategyManifest.ts's
 * "diagnose"/marketingManifest.ts's "handle_request" exactly: one
 * declared action (new_enquiry) whose entryHandler calls
 * salesExecutive.ts's own handleIncomingEnquiry UNCHANGED -- the entire
 * entity-match/matter-identify/call-prep/qualification/proposal/quote
 * chain inside it (spanning many downstream approval gates of its own:
 * entity creation, matter creation, proposal approval, Finance's quote
 * approval) is untouched, zero behavioral changes. Like Strategy's
 * "diagnose," this is a single top-level action with several legitimate
 * approval gates nested inside its own flow, not a claim that
 * new_enquiry itself is the only privileged step. Sales Executive still
 * fetches its Hat Definition live from Notion at runtime and has no
 * code-native sub-action list (status_check/follow_up/revise_draft,
 * named as illustrative candidates in the design doc's own Action
 * Registry table, are not implemented as separate actions) --
 * decomposing it further would be a separate, larger task nobody has
 * asked for.
 *
 * dispatchSalesExecutiveHat (exported below), mirroring
 * dispatchStrategyHat/dispatchMarketingHat exactly, is the genuine
 * runtime execution point -- session.ts's handleIncomingEnquiry calls
 * this instead of sales.handleIncomingEnquiry directly, making the
 * manifest the actual dispatch surface rather than a decorative parallel
 * structure. router.ts's dispatchCowork keeps its own hardcoded
 * `if (decision.unit === "Sales")` branch unchanged -- it still checks
 * `decision.hat === "Lead Generation Specialist"` first, and Sales
 * Executive's own sub-branch still calls stub.handleIncomingEnquiry(text)
 * exactly as before; only that method's own internal implementation now
 * routes through this manifest.
 *
 * Sales Executive's own continuation states (call_notes, intervention,
 * value_context_more, matter_redo_reason, entity_redo_reason,
 * proposal_feedback, sales_proposal_revision, etc.) all remain hardcoded
 * cases in session.ts's handleTextReply switch, exactly as they were --
 * matching Strategy's own precedent (strategyAnalystHat's
 * awaitingHandlers is likewise empty despite Strategy having its own
 * awaiting states already hardcoded there). Only the entry point moves;
 * every existing multi-turn flow is untouched.
 *
 * Lead Generation Specialist declares one action -- discover_leads, the
 * on-demand discovery request ("find me 3 companies showing a
 * positioning problem"). This is the only Lead Generation Specialist
 * capability reachable through a Cowork/Workspace chat message today;
 * the /lead Telegram command and cron-triggered runAutonomousLeadDiscovery
 * (leadGenerationDiscovery.ts) run entirely outside dispatchCowork and
 * have no manifest equivalent to move to (see docs/enig-operating-model.md's
 * scoping notes on those two). The "leadopportunity" Telegram approval
 * callback (proposeLeadOpportunity/handleLeadOpportunityApproval,
 * leadGenerationDiscovery.ts) IS migrated below, onto
 * HatManifest.callbackHandlers -- same generic approval-callback dispatch
 * mechanism Business Development proved (PRs #203-205). This is the
 * first non-BD prefix migrated, proving the mechanism generalizes beyond
 * the Unit it was built against.
 *
 * discover_leads is "read": it never creates a WorkSession (confirmed by
 * workspaceRouter.test.ts's own assertion that this dispatch must never go
 * through newWorkId/stub.init) and has no hold/resume `awaiting` state --
 * exactly matching the existing capability's behavior, which this manifest
 * reuses unchanged (see discoverLeadsReadHandler's own doc comment).
 */
type LeadGenerationSpecialistAction = "discover_leads";
type SalesExecutiveAction = "new_enquiry";

const LEAD_GENERATION_SPECIALIST_HAT_NAME = "Lead Generation Specialist";
const LEAD_GENERATION_SPECIALIST_SPECIALIZATION = "Lead Discovery";

const leadGenerationSpecialistActions: ActionDefinition<LeadGenerationSpecialistAction>[] = [
  {
    name: "discover_leads",
    consequence: "read",
    description: "Proactively search for organisations showing evidence of a problem worth investigating, and send promising signals to Research & Intelligence.",
  },
];

async function leadGenerationSpecialistReadHandler(env: Env, _actionName: LeadGenerationSpecialistAction, text: string): Promise<string> {
  return discoverLeadsReadHandler(env, text);
}

/** No internal/write actions are declared on this Hat today -- reaching either of these would mean dispatchAction resolved a consequence this manifest never declared. Fails closed rather than silently no-opping. */
async function leadGenerationSpecialistEntryHandler(_env: Env, _state: WorkState, actionName: LeadGenerationSpecialistAction): Promise<WorkState> {
  throw new Error(`${actionName}: not an internal/write action on Lead Generation Specialist -- only discover_leads ("read") is declared.`);
}

// The callback_data prefix proposeLeadOpportunity's own buttons are built
// with (see its "leadopportunity:<workId>:approve/reject" literal in
// leadGenerationDiscovery.ts). Migrates onto HatManifest.callbackHandlers
// same as Business Development's three prefixes (PRs #203-205) -- first
// non-BD Unit to use this mechanism.
export const LEAD_OPPORTUNITY_CALLBACK_PREFIX = "leadopportunity" as const;

const leadGenerationSpecialistCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [LEAD_OPPORTUNITY_CALLBACK_PREFIX]: handleLeadOpportunityApproval,
};

const leadGenerationSpecialistHat: HatManifest<LeadGenerationSpecialistAction> = {
  name: LEAD_GENERATION_SPECIALIST_HAT_NAME,
  specialization: LEAD_GENERATION_SPECIALIST_SPECIALIZATION,
  responsibility:
    "Identify and prepare potential commercial leads through proactive research and discovery, creating a reliable acquisition record that can be taken into the Sales process when appropriate. Owns the work of finding potential opportunities before a person or organisation has expressed interest in engaging with ENIG. Does not create or modify an Entity, qualify Lead-to-Prospect, or draft proposals/quotes -- those remain Sales Executive's authority.",
  actions: leadGenerationSpecialistActions,
  readHandler: leadGenerationSpecialistReadHandler,
  entryHandler: leadGenerationSpecialistEntryHandler,
  awaitingHandlers: {},
  callbackHandlers: leadGenerationSpecialistCallbackHandlers,
};

// Matches SALES_EXECUTIVE's HatIdentity in ../../hats/registry.ts -- see
// OPPORTUNITY_DEVELOPMENT_HAT_NAME's comment in businessDevelopmentManifest.ts
// for the name/specialization split rationale (name is what dispatch keys
// on; specialization is documentation/display only).
const SALES_EXECUTIVE_HAT_NAME = "Sales Executive";
const SALES_EXECUTIVE_SPECIALIZATION = "Sales Progression";

const salesExecutiveActions: ActionDefinition<SalesExecutiveAction>[] = [
  {
    name: "new_enquiry",
    consequence: "write",
    requiresApproval: true,
    description:
      "Process an incoming business enquiry: match or create the Entity, identify or create the Matter, prepare for the sales call, qualify, and draft a proposal -- gated throughout on Martin's explicit approval at each privileged step (entity/matter creation, proposal approval, Finance's quote approval) before anything is treated as final.",
  },
];

async function salesExecutiveEntryHandler(env: Env, state: WorkState, _actionName: SalesExecutiveAction, text: string): Promise<WorkState> {
  return sales.handleIncomingEnquiry(env, state, text);
}

/** Sales Executive declares no "read" action -- new_enquiry is always "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function salesExecutiveReadHandler(_env: Env, actionName: SalesExecutiveAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Sales Executive only declares "new_enquiry" ("write").`);
}

const salesExecutiveHat: HatManifest<SalesExecutiveAction> = {
  name: SALES_EXECUTIVE_HAT_NAME,
  specialization: SALES_EXECUTIVE_SPECIALIZATION,
  responsibility:
    "Own the client-acquisition lifecycle from an incoming enquiry through to a proposal ready for Martin's review: Entity/Matter identification, sales-call preparation, evidence-based qualification, and proposal drafting. Never treats an Entity, Matter, or proposal as final without Martin's explicit approval at each privileged step.",
  actions: salesExecutiveActions,
  readHandler: salesExecutiveReadHandler,
  entryHandler: salesExecutiveEntryHandler,
  // Every one of Sales Executive's own continuation states (call_notes,
  // intervention, value_context_more, matter_redo_reason,
  // entity_redo_reason, proposal_feedback, sales_proposal_revision, etc.)
  // remains a hardcoded case in session.ts's handleTextReply switch,
  // exactly as before this migration -- matching Strategy's own
  // precedent (strategyAnalystHat's awaitingHandlers is likewise empty
  // despite Strategy having its own awaiting states already hardcoded
  // there). Only the entry point moves; no multi-turn flow changes.
  awaitingHandlers: {},
};

export const salesManifest: UnitManifest = {
  unit: "Sales",
  hats: {
    [leadGenerationSpecialistHat.name]: leadGenerationSpecialistHat,
    [salesExecutiveHat.name]: salesExecutiveHat,
  },
  // Registered in dataBoundary/types.ts + registry.ts and already
  // classified business_sensitive in PRODUCTION_TASK_SENSITIVITY
  // (dataBoundary/policy.ts) -- Architect-reviewed as part of the Sales
  // Stage 1/2 batch: the payload crossing this boundary is Martin-authored
  // Workspace text plus static, code-authored routing/action metadata, the
  // same boundary as business_development's own intake/action tasks, so no
  // Sales-specific sensitivity dimension applies. Neither Hat actually
  // reaches Stage 1 resolution in practice, though -- Lead Generation
  // Specialist is dispatched via resolveUnitRequest with an explicit
  // priorHat (router.ts's own comment), which bypasses resolveHat entirely
  // regardless of how many Hats are registered, and Sales Executive is
  // dispatched via dispatchSalesExecutiveHat below, entirely outside
  // resolveUnitRequest -- these taskIds are declared only because
  // UnitManifest requires them.
  intakeClassificationTaskId: "sales.intake_classification",
  intakeIntroLine: "You route incoming Sales requests for ENIG, among its manifest-based Hats.",
  actionClassificationTaskId: "sales.hat_action_decision",
};

/**
 * The genuine runtime execution point for Sales Executive's chat-triggered
 * entry point -- session.ts's handleIncomingEnquiry calls this instead of
 * sales.handleIncomingEnquiry directly, making the manifest the actual
 * dispatch surface rather than a decorative parallel structure. Sales
 * Executive has only one Hat/one action, so no Stage 1/2 resolution is
 * needed here -- mirrors dispatchStrategyHat exactly.
 */
export async function dispatchSalesExecutiveHat(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const hat = salesManifest.hats[SALES_EXECUTIVE_HAT_NAME];
  return hat.entryHandler(env, state, "new_enquiry", text);
}
