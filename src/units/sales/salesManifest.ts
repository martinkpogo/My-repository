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
 * salesExecutiveHat.callbackHandlers declares four of Sales Executive's
 * own nested approval-gate prefixes -- entitynew, matternew, qualify,
 * proposal -- migrated off session.ts's hardcoded switch cases onto the
 * generic manifest lookup (approval-callback dispatch mechanism, PRs
 * #203-210). entity/matter (N-way choice pickers, not approve/reject)
 * and the sales-proposal decision callback (compound-encoded
 * "<number>.<version>.<a|r>" value) are deliberately NOT migrated --
 * they don't fit ApprovalCallbackHandler's plain boolean shape. All four
 * migrated handlers are unchanged, byte-for-byte.
 *
 * Lead Generation Specialist declares one action -- discover_leads, the
 * on-demand discovery request ("find me 3 companies showing a
 * positioning problem"). This is the only Lead Generation Specialist
 * capability reachable through a Cowork/Workspace chat message today;
 * the /lead Telegram command and cron-triggered runAutonomousLeadDiscovery
 * (leadGenerationDiscovery.ts) run entirely outside dispatchCowork and
 * have no manifest equivalent to move to -- deliberately, not an
 * oversight: see docs/enig-operating-model.md's "Open questions" entry
 * resolving this (2026-09-28) as "leave alone," since neither is a
 * chat-triggered request and building new manifest schema against
 * exactly one existing caller each would repeat the design doc's own
 * "don't design the final schema up front" warning. The "leadopportunity" Telegram approval
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

/**
 * Sales Executive's declared Actions.
 *
 * The five Proposal-lifecycle actions are the canonical token-safe Runtime
 * Proposal model (units/sales/tokenSafeProposal.ts) and exist as separate
 * Actions because their authority genuinely differs, not for symmetry:
 *
 *   proposal_draft   -- create/refresh the Draft Proposal record and its
 *                       first Version. Staging: never presented, never
 *                       approvable, so it needs no approval.
 *   proposal_submit  -- transition the Proposal to Pending Approval and
 *                       present it. Requests approval; is not approval.
 *   proposal_approve -- apply Martin's approval of the exact Version he was
 *                       shown. The ONLY approval-gated Proposal operation.
 *   proposal_revision-- build a new Version after a requested change and
 *                       return it to Pending Approval. A prior approval
 *                       never carries over to a revised Version.
 *
 * `create_entity` and `create_matter` likewise exist because committing a
 * staged Entity or Matter draft is Martin's decision, and is the Action whose
 * approval requirement therefore applies to that commit.
 *
 * `new_enquiry` is the workflow Action that carries the enquiry end to end.
 * Its own governed effects -- reads, and the lifecycle bookkeeping on the
 * Handoff this Work item was itself picked up from -- are not effects any
 * approval governs, so it declares requiresApproval: false. Each privileged
 * step inside its flow is the operation it actually performs, and is recorded
 * on the Work as such (see WorkState.actionName). That is the granularity
 * Business Development already uses, and it is what lets
 * `approvalGatedTargets` be deleted: there is no longer any need for a second
 * field narrowing a single Action's gate to a list of targets.
 *
 * ONE DISCLOSED ASYMMETRY, so it is not mistaken for an oversight: under
 * `new_enquiry` this Action also creates the outbound Strategy Handoff, and
 * that create is NOT independently approval-gated. Strategy's outbound Handoff
 * create is gated (`commit_diagnosis`). The two differ because that is the
 * behaviour each had before this change: Strategy's was gated by Martin's
 * approval callback, Sales' was not independently gated at all. Splitting
 * `new_enquiry` further would introduce a NEW gate on an effect that has never
 * had one, which is a business-policy decision rather than a structural one.
 * It is recorded as an open question rather than resolved here.
 */
type SalesExecutiveAction =
  | "new_enquiry"
  | "create_entity"
  | "create_matter"
  | "proposal_draft"
  | "proposal_submit"
  | "proposal_approve"
  | "proposal_revision";

const LEAD_GENERATION_SPECIALIST_HAT_NAME = "Lead Generation Specialist";
const LEAD_GENERATION_SPECIALIST_SPECIALIZATION = "Lead Discovery";

const leadGenerationSpecialistActions: ActionDefinition<LeadGenerationSpecialistAction>[] = [
  {
    name: "discover_leads",
    responsibility: "acquire_new_leads",
    consequence: "read",
    // Declared `read` because that is exactly what this Action is: it searches,
    // screens, and reports. A read Action can never authorize a governed write
    // (see consequencePermits in access.ts), which means the three governed
    // writes this capability used to perform -- a Lead create on a
    // Martin-approved opportunity, the scheduled run's R&I research-Handoff
    // create, and the /lead command's Lead create -- now FAIL CLOSED rather
    // than proceeding under an Action the caller chose.
    //
    // That is deliberate, and it is a known gap rather than an oversight
    // (see docs/enig-operating-model.md, "Known gaps and drift"). Each of
    // those writes creates a record another Unit acts on, which is the same
    // shape of effect as Strategy's gated commit_diagnosis -- but whether a
    // Pending internal research Handoff or a Lead-on-approval is a *privileged*
    // effect or ordinary operational bookkeeping is a governance question
    // reserved to the Architect, and it is not answered here by inventing an
    // Action. The refusal is logged at each site with that reasoning inline.
    requiresApproval: false,
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
  responsibilityId: "acquire_new_leads",
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
    responsibility: "own_client_acquisition",
    consequence: "write",
    // The enquiry workflow itself is not an approval-gated operation. Its
    // own governed effects are reads, and the lifecycle bookkeeping on the
    // Handoff this Work item was itself picked up from (Pending -> Picked-up
    // -> Closed) -- execution bookkeeping on a record the Work already owns,
    // which no approval ever governed. Every privileged step inside the
    // flow is the operation it actually performs, and is declared as its own
    // Action below carrying its own approval requirement. That is what makes
    // a per-target narrowing of THIS action unnecessary, and it is why
    // `approvalGatedTargets` is gone rather than merely unused.
    requiresApproval: false,
    description:
      "Process an incoming business enquiry: match or create the Entity, identify or create the Matter, prepare for the sales call, qualify, and route onward -- with each privileged step inside the flow (entity/matter creation, proposal approval, Finance's quote approval) performed as its own approval-gated Action.",
  },
  {
    name: "create_entity",
    responsibility: "own_client_acquisition",
    consequence: "write",
    requiresApproval: true,
    description:
      "Commit the Entity record for a staged Entity draft Martin approved. The record exists only because he approved that specific draft, so committing it is his approved governed effect.",
  },
  {
    name: "create_matter",
    responsibility: "own_client_acquisition",
    consequence: "write",
    requiresApproval: true,
    description:
      "Commit the Matter record for a staged Matter draft Martin approved. The record exists only because he approved that specific draft, so committing it is his approved governed effect.",
  },
  {
    name: "proposal_draft",
    responsibility: "own_client_acquisition",
    consequence: "write",
    requiresApproval: false,
    description:
      "Create or refresh the canonical token-safe Runtime Proposal record and its first Version. Staging only -- the Proposal is Draft, never presented and never approvable until its content is written, so drafting it requires no approval.",
  },
  {
    name: "proposal_submit",
    responsibility: "own_client_acquisition",
    consequence: "write",
    requiresApproval: false,
    description:
      "Transition the Runtime Proposal to Pending Approval and present that exact Version to Martin. Submission requests approval; it is not approval, so it does not itself require an ApprovalProof.",
  },
  {
    name: "proposal_approve",
    responsibility: "own_client_acquisition",
    consequence: "write",
    requiresApproval: true,
    description:
      "Apply Martin's approval to the exact Proposal Version he reviewed, recording Approval Status = Approved and the Approved Version. The approval stays bound to that Work, that Proposal, that Version, and that content hash -- an earlier approval never authorizes a later Version.",
  },
  {
    name: "proposal_revision",
    responsibility: "own_client_acquisition",
    consequence: "write",
    requiresApproval: false,
    description:
      "Build a new Runtime Proposal Version from Martin's requested change and return it to Pending Approval, leaving the prior Version's content intact. A revised Version requires its own subsequent approval.",
  },
];

/**
 * Sales Executive's entry point.
 *
 * Only `new_enquiry` is entered as a dispatched Action. The other six are
 * operations the Worker performs *inside* that flow (or, for the Proposal
 * lifecycle, inside the Handoff-pickup run) -- each recorded on the Work as
 * the operation it is performing, which is what gives Access its authority.
 * They fail closed here rather than falling through to the enquiry handler,
 * because running `new_enquiry` under any of their names would be performing
 * one registered operation while claiming another.
 */
async function salesExecutiveEntryHandler(env: Env, state: WorkState, actionName: SalesExecutiveAction, text: string): Promise<WorkState> {
  if (actionName !== "new_enquiry") {
    throw new Error(
      `${actionName}: not an entry-point Action on Sales Executive -- it is performed within new_enquiry's own flow (or the token-safe Proposal pickup) and is recorded on the Work there, never dispatched directly.`,
    );
  }
  return sales.handleIncomingEnquiry(env, state, text);
}

/** Sales Executive declares no "read" action -- every declared action is "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function salesExecutiveReadHandler(_env: Env, actionName: SalesExecutiveAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Sales Executive declares no "read" Actions.`);
}

// The callback_data prefixes Sales Executive's own approval gates build their
// buttons with. Migrates onto HatManifest.callbackHandlers same as every
// other Unit's prefixes so far (PRs #203-210) -- no relocation needed,
// salesManifest.ts already imports the whole salesExecutive.ts namespace
// (`* as sales`), and salesExecutive.ts never imports back from
// salesManifest.ts.
//
// The "proposal" prefix is GONE, and its handler with it. It dispatched
// salesExecutive.ts's handleProposalApproval, the older identity-bearing
// Proposal path that wrote Entity/Matter *relations* into a Proposal record
// and contradicted the canonical token-safe Runtime Proposal model. That path
// was also unreachable: the only code that ever sent a "proposal:" button was
// handleProposalFeedback, which is itself only reachable once
// handleProposalApproval has rejected -- a closed cycle with no entry point.
// The Runtime Proposal lifecycle now has exactly one implementation
// (units/sales/tokenSafeProposal.ts, dispatched under the proposal_draft /
// proposal_submit / proposal_approve / proposal_revision Actions) and exactly
// one model.
//
// The entity/matter pickers (N-way choice, not approve/reject) and the
// sales-proposal decision callback (compound-encoded
// "<number>.<version>.<a|r>" value) remain outside
// ApprovalCallbackHandler's plain boolean shape, as before.
export const ENTITY_NEW_CALLBACK_PREFIX = "entitynew" as const;
export const MATTER_NEW_CALLBACK_PREFIX = "matternew" as const;
export const QUALIFY_CALLBACK_PREFIX = "qualify" as const;

const salesExecutiveCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [ENTITY_NEW_CALLBACK_PREFIX]: sales.handleEntityCreationApproval,
  [MATTER_NEW_CALLBACK_PREFIX]: sales.handleMatterCreationApproval,
  [QUALIFY_CALLBACK_PREFIX]: sales.handleLeadToProspectApproval,
};

const salesExecutiveHat: HatManifest<SalesExecutiveAction> = {
  name: SALES_EXECUTIVE_HAT_NAME,
  specialization: SALES_EXECUTIVE_SPECIALIZATION,
  responsibility:
    "Own the client-acquisition lifecycle from an incoming enquiry through to a proposal ready for Martin's review: Entity/Matter identification, sales-call preparation, evidence-based qualification, and proposal drafting. Never treats an Entity, Matter, or proposal as final without Martin's explicit approval at each privileged step.",
  responsibilityId: "own_client_acquisition",
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
  callbackHandlers: salesExecutiveCallbackHandlers,
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
