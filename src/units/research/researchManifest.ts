import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
import * as research from "./capabilityPackage";

/**
 * Invocation/registry surface for the Research & Intelligence Capability
 * Package (Core Structure v2.4).
 *
 * WHAT THIS FILE IS -- still-required technical manifest/invocation
 * infrastructure, preserved (not deleted) because it is referenced:
 * - `dispatchResearchHat` is the chat-triggered entry session.ts calls;
 * - the manifest's Hat key is the existing routing/registry label used by
 *   router.ts's fallback, `findCallbackHandler`, and WorkState;
 * - the Unit Manifest / Action Registry is the only sanctioned mechanism
 *   by which a capability is triggered, so the Package keeps exactly one
 *   declared action (`research`, "write", requiresApproval: true) and its
 *   outbound-Handoff approval callback.
 *
 * WHAT THIS FILE IS NOT -- not an organizational Unit/Hat definition, not
 * a second dispatcher, and not a Procedure registry. The six canonical
 * Procedure contracts live in protocols.ts; all execution lives in
 * capabilityPackage.ts (one shared pipeline); nothing here routes work to
 * a per-Procedure engine. The `Research & Intelligence` unit label and
 * the `Research & Intelligence Analyst` hat key are the existing registry
 * labels those callers depend on -- routing identity, NOT a claim that a
 * retired organizational R&I Unit or R&I Analyst Hat owns this
 * capability. The capability's ownership language that DID claim that
 * (persona/responsibility text) has been rewritten to the Capability
 * Package boundary.
 *
 * R&I declares no second entry point through this manifest:
 * handlePickup (Handoff-originated, called from session.ts's own
 * dedicated method) stays outside it because it resolves
 * Handoff-specific context (resolveResearchHandoffContext) that
 * handleDirectRequest's free-text path has no equivalent for -- wrapping
 * it through this manifest's entryHandler would be semantically wrong.
 * `awaitingHandlers` stays empty: the Package's own continuation states
 * (research_clarification, research_feedback) remain hardcoded in
 * session.ts, matching Strategy's own precedent.
 *
 * `intakeClassificationTaskId`/`actionClassificationTaskId` reuse
 * `research.synthesis` purely as a type-satisfying placeholder -- required
 * by UnitManifest's shape, never actually invoked through this manifest
 * (dispatchCowork's R&I branch never calls resolveUnitRequest for R&I,
 * and resolveHat's single-Hat shortcut skips Stage 1 anyway). No new
 * SemanticTaskId registration or Architect review needed.
 */

// The `research` action is Package invocation: "write" consequence,
// approval required before an outbound Handoff is treated as final.
type ResearchAction = "research";

const RESEARCH_PACKAGE_HAT_LABEL = "Research & Intelligence Analyst";

const researchPackageActions: ActionDefinition<ResearchAction>[] = [
  {
    name: "research",
    responsibility: "produce_research_packages",
    consequence: "write",
    requiresApproval: true,
    // Martin's approval gates the outbound Handoff this action creates
    // (R&I -> the consuming Hat), and creating that Handoff is this
    // action's only governed effect -- so the action-level
    // requiresApproval above accurately describes it. The inbound Handoff
    // this work item was picked up from is execution bookkeeping on a
    // record it already owns: NOT an approval-gated effect, and needing no
    // exemption, because no Action here performs it under a gated Action.
    // (That separation used to be expressed by an `approvalGatedTargets`
    // list narrowing the gate to handoffs/create. It was removed: a second
    // field able to silence `requiresApproval` split one authority in two,
    // and failed open whenever an Action declared the flag but omitted the
    // list.)
    // Structural entry, exactly like Finance's `price`: one Hat, one
    // Action, so a direct request or a Handoff addressed to this Unit
    // resolves `research` from context alone (the former dispatchCowork
    // R&I branch hardcoded the same Action).
    applicability: {
      mode: "any",
      conditions: [
        { source: "work", field: "origin", operator: "in", value: ["direct_request", "handoff_pickup"] },
        { source: "work", field: "requested_action", operator: "equals", value: "research" },
      ],
    },
    description:
      "Invoke the Research & Intelligence Capability Package to execute the applicable canonical research Procedure(s), synthesize evidence-backed findings, and either present them for Martin's review or route them to the responsible Hat via a governed Handoff -- always gated on Martin's explicit approval before any outbound Handoff is treated as final.",
  },
];

async function researchEntryHandler(env: Env, state: WorkState, _actionName: ResearchAction, text: string): Promise<WorkState> {
  return research.handleDirectRequest(env, state, text);
}

/** R&I declares no "read" action -- research is always "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function researchReadHandler(_env: Env, actionName: ResearchAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Research & Intelligence Analyst only declares "research" ("write").`);
}

// The callback_data prefix capabilityPackage.ts's own outbound-handoff
// proposal buttons are built with (see the "researchhandoff:<workId>:approve"
// literal there). Approval-callback dispatch mechanism (PRs #203-211).
// This manifest imports the whole capabilityPackage.ts namespace
// (`* as research`), and capabilityPackage.ts never imports back.
export const RESEARCH_HANDOFF_CALLBACK_PREFIX = "researchhandoff" as const;

const researchPackageCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [RESEARCH_HANDOFF_CALLBACK_PREFIX]: research.handleResearchHandoffApproval,
};

const researchInvocationHat: HatManifest<ResearchAction> = {
  // Registry label, not an organizational claim -- see the header.
  name: RESEARCH_PACKAGE_HAT_LABEL,
  specialization: "Research Intelligence",
  responsibility:
    "Invoke the Research & Intelligence Capability Package's canonical research Procedures to investigate research questions for ENIG, producing evidence-backed synthesis grounded only in verifiable sources -- never a fabricated fact, an unverifiable source, or a preliminary hypothesis presented as a finding. Route synthesis to the responsible Hat via a governed Handoff when the question originated there, or present it directly to Martin otherwise. Never treat an outbound Handoff as final without Martin's explicit approval. Business ownership, authority to act, and accountability for the resulting Output stay with the Responsibility that requested the research.",
  actions: researchPackageActions,
  responsibilityId: "produce_research_packages",
  readHandler: researchReadHandler,
  entryHandler: researchEntryHandler,
  awaitingHandlers: {},
  callbackHandlers: researchPackageCallbackHandlers,
};

export const researchManifest: UnitManifest = {
  unit: "Research & Intelligence",
  hats: {
    [researchInvocationHat.name]: researchInvocationHat,
  },
  intakeClassificationTaskId: "research.synthesis",
  intakeIntroLine: "You route incoming Research & Intelligence requests for ENIG, to the Research & Intelligence Capability Package's research invocation.",
  actionClassificationTaskId: "research.synthesis",
};

/**
 * The Package's manifest-level dispatch helper for its chat-triggered
 * entry point: routes through the manifest instead of calling
 * research.handleDirectRequest directly, making the manifest the actual
 * dispatch surface rather than a decorative parallel structure. One
 * invocation path, no Hat interpretation needed here -- mirrors
 * dispatchStrategyHat.
 *
 * Production entry no longer goes through a per-Unit WorkSession wrapper
 * (handleResearchRequest is gone): WorkSession.handleUnitAction resolves
 * the manifest and calls the Hat's entryHandler directly. This export
 * stays as the manifest's self-contained equivalent, exercised by the
 * research manifest/capabilityPackage tests.
 */
export async function dispatchResearchHat(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const hat = researchManifest.hats[RESEARCH_PACKAGE_HAT_LABEL];
  return hat.entryHandler(env, state, "research", text);
}
