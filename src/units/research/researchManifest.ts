import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
import * as research from "./researchAnalyst";

/**
 * Research & Intelligence's Unit Registry manifest (ENIG Operating Model
 * design doc, "The Unit Registry") -- deliberately partial by design,
 * mirroring strategyManifest.ts exactly. R&I has exactly one Hat
 * (Research & Intelligence Analyst -- see hats/registry.ts's
 * RESEARCH_INTELLIGENCE_ANALYST; research "protocols," selected per
 * request, are not separate Hats -- see researchAnalyst.ts's own doc
 * comment), so there is no Stage 1 Hat-ambiguity to preserve. There is
 * also no "which action" decision Martin's message selects between --
 * handleDirectRequest is the only chat-triggered entry, every time. So
 * this manifest declares exactly one action, research ("write",
 * requiresApproval: true), whose entryHandler calls
 * research.handleDirectRequest UNCHANGED -- the entire protocol-
 * selection/synthesis/Handoff-routing chain inside it (spanning its own
 * downstream gates: outbound Handoff approval) is untouched, zero
 * behavioral changes.
 *
 * R&I's OTHER entry point, handlePickup (Handoff-originated, called from
 * session.ts's own dedicated method), is deliberately left OUTSIDE this
 * manifest -- same reasoning as Strategy's own handlePickup: it resolves
 * Handoff-specific context (resolveResearchHandoffContext) that
 * handleDirectRequest's own free-text resolution has no equivalent for,
 * so wrapping it through this manifest's entryHandler would be
 * semantically wrong.
 *
 * researchAnalystHat.callbackHandlers declares researchhandoff (the
 * outbound-Handoff approve/reject callback research.ts's own routing
 * sends) -- approval-callback dispatch mechanism (PRs #203-211), the
 * first prefix migrated for R&I now that a manifest exists to attach it
 * to.
 *
 * intakeClassificationTaskId/actionClassificationTaskId reuse
 * research.synthesis purely as a type-satisfying placeholder -- required
 * by UnitManifest's shape, but never actually invoked through this
 * manifest: dispatchCowork's R&I branch (unchanged) never calls
 * resolveUnitRequest for R&I at all, and even if it did, resolveHat's
 * single-Hat shortcut skips Stage 1 entirely. No new SemanticTaskId
 * registration or Architect review needed.
 */
type ResearchAction = "research";

const RESEARCH_ANALYST_HAT_NAME = "Research & Intelligence Analyst";
const RESEARCH_ANALYST_SPECIALIZATION = "Research Intelligence";

const researchAnalystActions: ActionDefinition<ResearchAction>[] = [
  {
    name: "research",
    consequence: "write",
    requiresApproval: true,
    description:
      "Investigate a research question using the appropriate protocol(s), synthesize evidence-backed findings, and either present them for Martin's review or route them to the responsible Hat via a governed Handoff -- always gated on Martin's explicit approval before any outbound Handoff is treated as final.",
  },
];

async function researchEntryHandler(env: Env, state: WorkState, _actionName: ResearchAction, text: string): Promise<WorkState> {
  return research.handleDirectRequest(env, state, text);
}

/** R&I declares no "read" action -- research is always "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function researchReadHandler(_env: Env, actionName: ResearchAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Research & Intelligence Analyst only declares "research" ("write").`);
}

// The callback_data prefix research.ts's own outbound-handoff proposal
// buttons are built with (see the "researchhandoff:<workId>:approve"
// literal in researchAnalyst.ts). Migrates onto
// HatManifest.callbackHandlers same as Business Development's/Sales's/
// Marketing's/Strategy's prefixes (PRs #203-211) -- no relocation
// needed, this manifest already imports the whole researchAnalyst.ts
// namespace (`* as research`), and researchAnalyst.ts never imports back.
export const RESEARCH_HANDOFF_CALLBACK_PREFIX = "researchhandoff" as const;

const researchAnalystCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [RESEARCH_HANDOFF_CALLBACK_PREFIX]: research.handleResearchHandoffApproval,
};

const researchAnalystHat: HatManifest<ResearchAction> = {
  name: RESEARCH_ANALYST_HAT_NAME,
  specialization: RESEARCH_ANALYST_SPECIALIZATION,
  responsibility:
    "Investigate research questions for ENIG using the appropriate protocol(s), producing evidence-backed synthesis grounded only in verifiable sources -- never a fabricated fact, an unverifiable source, or a preliminary hypothesis presented as a finding. Routes synthesis to the responsible Hat via a governed Handoff when the question originated there, or presents it directly to Martin otherwise. Never treats an outbound Handoff as final without Martin's explicit approval.",
  actions: researchAnalystActions,
  readHandler: researchReadHandler,
  entryHandler: researchEntryHandler,
  // Every one of R&I's own continuation states (research_clarification,
  // research_feedback) remains a hardcoded case in session.ts's
  // handleTextReply switch, exactly as before this migration -- matching
  // Strategy's own precedent. Only the entry point moves; no multi-turn
  // flow changes.
  awaitingHandlers: {},
  callbackHandlers: researchAnalystCallbackHandlers,
};

export const researchManifest: UnitManifest = {
  unit: "Research & Intelligence",
  hats: {
    [researchAnalystHat.name]: researchAnalystHat,
  },
  intakeClassificationTaskId: "research.synthesis",
  intakeIntroLine: "You route incoming Research & Intelligence requests for ENIG, to its Research & Intelligence Analyst Hat.",
  actionClassificationTaskId: "research.synthesis",
};

/**
 * The genuine runtime execution point for R&I's chat-triggered entry
 * point -- session.ts's handleResearchRequest calls this instead of
 * research.handleDirectRequest directly, making the manifest the actual
 * dispatch surface rather than a decorative parallel structure. R&I has
 * only one Hat/one action, so no Stage 1/2 resolution is needed here --
 * mirrors dispatchStrategyHat exactly.
 */
export async function dispatchResearchHat(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const hat = researchManifest.hats[RESEARCH_ANALYST_HAT_NAME];
  return hat.entryHandler(env, state, "research", text);
}
