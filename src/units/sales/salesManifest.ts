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
type SalesAction = "discover_leads";

const LEAD_GENERATION_SPECIALIST_HAT_NAME = "Lead Generation Specialist";
const LEAD_GENERATION_SPECIALIST_SPECIALIZATION = "Lead Discovery";

const leadGenerationSpecialistActions: ActionDefinition<SalesAction>[] = [
  {
    name: "discover_leads",
    consequence: "read",
    description: "Proactively search for organisations showing evidence of a problem worth investigating, and send promising signals to Research & Intelligence.",
  },
];

async function leadGenerationSpecialistReadHandler(env: Env, _actionName: SalesAction, text: string): Promise<string> {
  return discoverLeadsReadHandler(env, text);
}

/** No internal/write actions are declared on this Hat today -- reaching either of these would mean dispatchAction resolved a consequence this manifest never declared. Fails closed rather than silently no-opping. */
async function leadGenerationSpecialistEntryHandler(_env: Env, _state: WorkState, actionName: SalesAction): Promise<WorkState> {
  throw new Error(`${actionName}: not an internal/write action on Lead Generation Specialist -- only discover_leads ("read") is declared.`);
}

const leadGenerationSpecialistHat: HatManifest<SalesAction> = {
  name: LEAD_GENERATION_SPECIALIST_HAT_NAME,
  specialization: LEAD_GENERATION_SPECIALIST_SPECIALIZATION,
  responsibility:
    "Identify and prepare potential commercial leads through proactive research and discovery, creating a reliable acquisition record that can be taken into the Sales process when appropriate. Owns the work of finding potential opportunities before a person or organisation has expressed interest in engaging with ENIG. Does not create or modify an Entity, qualify Lead-to-Prospect, or draft proposals/quotes -- those remain Sales Executive's authority.",
  actions: leadGenerationSpecialistActions,
  readHandler: leadGenerationSpecialistReadHandler,
  entryHandler: leadGenerationSpecialistEntryHandler,
  awaitingHandlers: {},
};

export const salesManifest: UnitManifest = {
  unit: "Sales",
  hats: {
    [leadGenerationSpecialistHat.name]: leadGenerationSpecialistHat,
  },
  // Registered in dataBoundary/types.ts + registry.ts, but NOT yet
  // classified in PRODUCTION_TASK_SENSITIVITY (dataBoundary/policy.ts) --
  // pending Architect review, same discipline as every new BD task before
  // it. Calls against these taskIds fail closed (UNRESOLVED_POLICY_HOLD)
  // until classified; router.ts's dispatchCowork calls resolveUnitRequest
  // with an explicit priorHat (see its own comment), so Stage 1's
  // intakeClassificationTaskId is never actually invoked in practice while
  // only one Hat is registered here (resolveHat's own single-Hat
  // shortcut) -- it's declared only because UnitManifest requires it.
  intakeClassificationTaskId: "sales.intake_classification",
  intakeIntroLine: "You route incoming Sales requests for ENIG, among its manifest-based Hats.",
  actionClassificationTaskId: "sales.hat_action_decision",
};
