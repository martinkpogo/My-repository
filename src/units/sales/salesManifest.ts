import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest } from "../unitManifest";
import { discoverLeadsReadHandler } from "./leadGenerationDiscovery";

/**
 * Sales's Unit Registry manifest (ENIG Operating Model design doc, "The
 * Unit Registry") -- deliberately partial. Sales has two Hats (Sales
 * Executive, specialization Sales Progression; Lead Generation Specialist,
 * specialization Lead Discovery -- see hats/registry.ts's SALES_EXECUTIVE/
 * LEAD_GENERATION_SPECIALIST), but only Lead Generation Specialist is
 * declared here.
 *
 * Sales Executive is intentionally NOT migrated: it fetches its Hat
 * Definition live from Notion at runtime and has no code-native action
 * list at all (see salesExecutive.ts) -- converting it to declarative
 * ActionDefinitions would be a separate, much larger task nobody has asked
 * for. This is safe because router.ts's dispatchCowork keeps its own
 * hardcoded `if (decision.unit === "Sales")` branch, which still checks
 * `decision.hat === "Lead Generation Specialist"` first and returns
 * unconditionally either way -- Sales Executive's own sub-branch
 * (stub.init/handleIncomingEnquiry) is untouched and never reaches this
 * manifest or resolveUnitRequest's Stage 1 Hat-ambiguity resolution.
 *
 * Only one action is declared -- discover_leads, the on-demand discovery
 * request ("find me 3 companies showing a positioning problem"). This is
 * the only Lead Generation Specialist capability reachable through a
 * Cowork/Workspace chat message today; the /lead Telegram command,
 * cron-triggered runAutonomousLeadDiscovery (leadGenerationDiscovery.ts),
 * and the "leadopportunity" Telegram approval callback (session.ts's
 * handleCallback) all run entirely outside dispatchCowork and have no
 * manifest equivalent to move to -- Business Development's own approval
 * flows are likewise still hardcoded handleCallback cases, since the
 * manifest pattern doesn't yet have a generic approval-callback mechanism.
 *
 * discover_leads is "read": it never creates a WorkSession (confirmed by
 * workspaceRouter.test.ts's own assertion that this dispatch must never go
 * through newWorkId/stub.init) and has no hold/resume `awaiting` state --
 * exactly matching the existing capability's behavior, which this manifest
 * reuses unchanged (see discoverLeadsReadHandler's own doc comment).
 */
import { sendMessage } from "../../telegram";
import { SALES_DIRECT_ENTRY_PAUSED } from "../../sessionRouting";

type LGSAction = "discover_leads";

const LEAD_GENERATION_SPECIALIST_HAT_NAME = "Lead Generation Specialist";
const LEAD_GENERATION_SPECIALIST_SPECIALIZATION = "Lead Discovery";

const leadGenerationSpecialistActions: ActionDefinition<LGSAction>[] = [
  {
    name: "discover_leads",
    consequence: "read",
    description: "Proactively search for organisations showing evidence of a problem worth investigating, and send promising signals to Research & Intelligence.",
  },
];

async function leadGenerationSpecialistReadHandler(env: Env, _actionName: LGSAction, text: string): Promise<string> {
  return discoverLeadsReadHandler(env, text);
}

/** No internal/write actions are declared on this Hat today -- reaching either of these would mean dispatchAction resolved a consequence this manifest never declared. Fails closed rather than silently no-opping. */
async function leadGenerationSpecialistEntryHandler(_env: Env, _state: WorkState, actionName: LGSAction): Promise<WorkState> {
  throw new Error(`${actionName}: not an internal/write action on Lead Generation Specialist -- only discover_leads ("read") is declared.`);
}

const leadGenerationSpecialistHat: HatManifest<LGSAction> = {
  name: LEAD_GENERATION_SPECIALIST_HAT_NAME,
  specialization: LEAD_GENERATION_SPECIALIST_SPECIALIZATION,
  responsibility:
    "Identify and prepare potential commercial leads through proactive research and discovery, creating a reliable acquisition record that can be taken into the Sales process when appropriate. Owns the work of finding potential opportunities before a person or organisation has expressed interest in engaging with ENIG. Does not create or modify an Entity, qualify Lead-to-Prospect, or draft proposals/quotes -- those remain Sales Executive's authority.",
  actions: leadGenerationSpecialistActions,
  readHandler: leadGenerationSpecialistReadHandler,
  entryHandler: leadGenerationSpecialistEntryHandler,
  awaitingHandlers: {},
};

type SalesExecutiveAction = "new_enquiry" | "process_call_notes" | "route_to_strategy" | "draft_proposal";

const SALES_EXECUTIVE_HAT_NAME = "Sales Executive";
const SALES_EXECUTIVE_SPECIALIZATION = "Sales Progression";

const SALES_PAUSED_MESSAGE =
  "Sales Executive intake is paused here in this runtime by standing policy until an AI provider with an acceptable personal-data/training policy is available. This enquiry was not processed here -- it is being handled by the isolated Sales Executive project in Claude (with its own Notion and Gmail access), which owns and actively works this domain now.";

const salesExecutiveActions: ActionDefinition<SalesExecutiveAction>[] = [
  {
    name: "new_enquiry",
    consequence: "write",
    requiresApproval: true,
    description: "Process a new incoming client enquiry, extract contact details, and identify or match an Entity and Matter.",
  },
  {
    name: "process_call_notes",
    consequence: "write",
    requiresApproval: true,
    description: "Process sales call notes, extract commercial-value evidence, and evaluate Lead-to-Prospect qualification criteria.",
  },
  {
    name: "route_to_strategy",
    consequence: "write",
    requiresApproval: true,
    description: "Route a qualified commercial situation to Strategy for strategic diagnosis.",
  },
  {
    name: "draft_proposal",
    consequence: "write",
    requiresApproval: true,
    description: "Prepare and present a client-facing draft proposal based on an authoritative quote.",
  },
];

async function salesExecutiveReadHandler(_env: Env, actionName: SalesExecutiveAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action on Sales Executive.`);
}

async function salesExecutiveEntryHandler(env: Env, state: WorkState, actionName: SalesExecutiveAction, text: string): Promise<WorkState> {
  const sales = await import("./salesExecutive");
  if (actionName === "new_enquiry") {
    if (SALES_DIRECT_ENTRY_PAUSED) {
      console.error(`Sales Executive direct entry paused — enquiry not processed (chat ${state.chatId})`);
      await sendMessage(env, state.chatId, SALES_PAUSED_MESSAGE, undefined, state.threadId);
      return state;
    }
    return sales.handleIncomingEnquiry(env, state, text);
  }

  if (actionName === "process_call_notes") {
    return sales.handleCallNotes(env, state, text);
  }

  if (actionName === "route_to_strategy") {
    return sales.handleInterventionText(env, state, text);
  }

  if (actionName === "draft_proposal") {
    return sales.handleQuoteReceived(env, state);
  }

  throw new Error(`${actionName}: unsupported action on Sales Executive.`);
}

const salesExecutiveAwaitingHandlers: HatManifest<SalesExecutiveAction>["awaitingHandlers"] = {
  call_notes: async (env, state, text) => (await import("./salesExecutive")).handleCallNotes(env, state, text),
  intervention: async (env, state, text) => (await import("./salesExecutive")).handleInterventionText(env, state, text),
  value_context_more: async (env, state, text) => (await import("./salesExecutive")).handleMoreValueContext(env, state, text),
  proposal_feedback: async (env, state, text) => (await import("./salesExecutive")).handleProposalFeedback(env, state, text),
  matter_redo_reason: async (env, state, text) => (await import("./salesExecutive")).handleMatterRedoReason(env, state, text),
  entity_redo_reason: async (env, state, text) => (await import("./salesExecutive")).handleEntityRedoReason(env, state, text),
  sales_proposal_revision: async (env, state, text) => (await import("./tokenSafeProposal")).handleSalesProposalRevisionText(env, state, text),
};

const salesExecutiveHat: HatManifest<SalesExecutiveAction> = {
  name: SALES_EXECUTIVE_HAT_NAME,
  specialization: SALES_EXECUTIVE_SPECIALIZATION,
  responsibility:
    "Manage commercial relationships and progress sales pipeline opportunities from initial enquiry to proposal agreement. Own Entity/Matter identification, Lead-to-Prospect qualification, and client proposal presentation.",
  actions: salesExecutiveActions,
  readHandler: salesExecutiveReadHandler,
  entryHandler: salesExecutiveEntryHandler,
  awaitingHandlers: salesExecutiveAwaitingHandlers,
};

export const salesManifest: UnitManifest = {
  unit: "Sales",
  hats: {
    [leadGenerationSpecialistHat.name]: leadGenerationSpecialistHat,
    [salesExecutiveHat.name]: salesExecutiveHat,
  },
  intakeClassificationTaskId: "sales.intake_classification",
  intakeIntroLine: "You route incoming Sales requests for ENIG, among its specialist Hats.",
  actionClassificationTaskId: "sales.hat_action_decision",
};
