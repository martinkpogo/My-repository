import type { Env, WorkState } from "../types";
import { logActivity } from "../log";
import { sendWorkspaceHatMessage } from "../telegram";
import { getPage, plainText, richText, select } from "../notion";
import { updateHandoff } from "../handoffWriter";
import type { MarketingHatName } from "./types";
import { isMarketingHat, marketingHatSummaryList } from "./registry";
import {
  resolveMarketingCandidateRelationships,
  selectMarketingAmbiguityReasonCode,
} from "./relationships";
import { classifyCandidateHats } from "./intakeClassification";
import { dispatchMarketingHat } from "../units/marketing/marketingManifest";

/**
 * Shared Marketing execution mechanics only — not a Hat registry, and not
 * a Hat-definition file. Each Marketing Hat remains independently defined
 * in its own file under src/units/marketing/ (purpose, owns,
 * doesNotOwn, routesTo); src/hats/registry.ts remains the one canonical
 * place every Hat is registered. This file owns Stage 1 (which Hat) and
 * Stage 2 (deterministic relationship resolution) intake classification,
 * plus the approval/feedback/clarification loops -- the actual per-Hat
 * execution decision (draft/route/clarify) has moved to
 * src/units/marketing/marketingManifest.ts's Unit Registry manifest
 * (dispatchMarketingHat), since that decision is Marketing's declared
 * "handle_request" action, not classification/routing mechanics. See
 * marketingManifest.ts's own doc comment for why Stage 1/2 stayed here
 * rather than migrating onto the generic manifest resolver too
 * (deterministic relationship-based tie-breaking has no equivalent
 * there).
 *
 * Stage 1 candidate-Hat classification (classifyCandidateHats,
 * intakeClassification.ts) and Stage 2 deterministic relationship
 * resolution (resolveCandidateRelationships, relationships.ts) are
 * generic, reusable shapes a second Unit registers against directly --
 * this file calls them bound to Marketing's own taskId/Hat list/
 * relationships, rather than owning that classification logic itself.
 */

/**
 * Entry point for a Handoff addressed directly to Marketing Strategist --
 * currently only ever created by Research & Intelligence's own
 * auto-routing (see researchAnalyst.ts's routeToConsumingHat). Skips the
 * two-stage intake classification handleMarketingIntake runs for chat-
 * originated work, since the sender already determined which Hat this
 * belongs to; reads the Handoff's own Reason/Verified Facts & Sources as
 * the task text, the same shape dispatchMarketingHat already expects from
 * state.marketingTaskText.
 */
export async function handleHandoffPickup(env: Env, state: WorkState): Promise<WorkState> {
  const handoff = await getPage(env, state.handoffId!);
  const taskText = plainText(handoff.properties["Verified Facts & Sources"]) || plainText(handoff.properties.Reason);
  if (!taskText.trim()) {
    console.error(`Marketing handleHandoffPickup: empty task text for handoff ${state.handoffId}`);
    await sendWorkspaceHatMessage(env, state, `Couldn't pick up a Handoff for Marketing Strategist (Handoff ${state.handoffId}) — it had no readable content.`);
    return state;
  }

  await updateHandoff(env, state.handoffId!, { Status: select("Picked-up") });
  state.hat = "Marketing Strategist";
  state.marketingTaskText = taskText;
  await logActivity(env, {
    entry: `Marketing Strategist picked up a Handoff`,
    type: "Activity",
    area: "Marketing",
    activity: `Handoff ${state.handoffId} picked up.`,
    outcome: "Active",
  });

  return dispatchMarketingHat(env, state);
}

/**
 * Entry point for a new Marketing work item, analogous to
 * sales.handleIncomingEnquiry. Uses a two-stage deterministic routing model:
 * - Stage 1 identifies genuinely plausible candidate Hats and whether establishing is needed.
 * - Stage 2 evaluates specific registered sequential relationships between candidates deterministically.
 */
export async function handleMarketingIntake(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.marketingTaskText = text;

  // Stage 1: LLM identifies candidate Hats and establishing context
  const stage1 = await classifyCandidateHats<MarketingHatName>(
    env,
    {
      taskId: "marketing.intake_classification",
      introLine: "You route incoming Marketing-specialization tasks for ENIG, within the Sales, Marketing & Business Development Unit.",
      hatSummaryList: marketingHatSummaryList(),
      light: true,
    },
    text,
  );

  if (!stage1 || !stage1.candidates) {
    const reasonCode = selectMarketingAmbiguityReasonCode(null);
    console.error(`Marketing Stage 1 classification failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Marketing intake blocked [${reasonCode}] — classification failed`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: `Could not classify Marketing candidates for this request. Refusing to guess. Reason code: ${reasonCode}`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, "Couldn't determine which Marketing Hat this belongs to — classification failed. Please resend or rephrase.");
    return state;
  }

  const validCandidates = stage1.candidates.filter(isMarketingHat);

  // Stage 2: Deterministic, request-text-free evaluation of registered sequential relationships
  const stage2 = resolveMarketingCandidateRelationships(validCandidates, stage1.establishing);

  if (!stage2.resolved || !stage2.hat) {
    const reasonCode = selectMarketingAmbiguityReasonCode(stage2);
    const reasonText = stage2.reason ?? stage1.reason ?? "Request could plausibly belong to more than one Marketing Hat.";
    await logActivity(env, {
      entry: `Marketing intake ambiguous [${reasonCode}]`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: `${reasonText} (Reason code: ${reasonCode})`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, `I'm not sure which Marketing Hat this belongs to — ${reasonText}. Can you clarify what's needed?`);
    state.stage = "marketing_ambiguous";
    state.awaiting = "marketing_clarification";
    return state;
  }

  state.hat = stage2.hat;
  await logActivity(env, {
    entry: `Marketing task routed to ${stage2.hat}${stage2.relationshipId ? ` via relationship ${stage2.relationshipId}` : ""}`,
    type: "Activity",
    area: "Marketing",
    activity: text,
    outcome: "Active",
  });

  return dispatchMarketingHat(env, state);
}

export async function handleTransitionApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingTransition;
  if (!pending) {
    await sendWorkspaceHatMessage(env, state, "This transition has already been resolved -- nothing to do.");
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(env, state, "Got it — what should change? Tell me what to reconsider and I'll take another look.");
    state.pendingTransition = undefined;
    state.awaiting = "marketing_feedback";
    return state;
  }

  const fromHat = state.hat;
  state.hat = pending.toHat;
  state.pendingTransition = undefined;
  await logActivity(env, {
    entry: `Marketing work routed: ${fromHat} -> ${pending.toHat}`,
    type: "Decision",
    area: "Marketing",
    decisions: `Confirmed by Martin.`,
    decisionRationale: pending.reason,
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, state, `Routed to *${pending.toHat}*.`);

  return dispatchMarketingHat(env, state);
}

export async function handleDraftApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (state.stage !== "awaiting_marketing_draft_approval") {
    await sendWorkspaceHatMessage(env, state, "This draft approval has already been resolved -- nothing to do.");
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(env, state, "Got it — what should change? Tell me what's off or what to take into account, and I'll redo it.");
    state.awaiting = "marketing_feedback";
    return state;
  }

  // If this work item arrived via a Handoff (currently only from R&I's
  // auto-routing to Marketing Strategist), close it out as the
  // completion signal -- same pattern Finance/Sales/R&I already use.
  if (state.handoffId) {
    await updateHandoff(env, state.handoffId, {
      Status: select("Closed"),
      "Work Completed": richText((state.marketingDraft ?? "").slice(0, 1900)),
    }).catch((err) => console.error(`Marketing: failed to close Handoff ${state.handoffId}`, err));
  }

  await logActivity(env, {
    entry: `${state.hat} output approved`,
    type: "Decision",
    area: "Marketing",
    decisions: state.marketingDraft?.slice(0, 500) ?? "",
    decisionRationale: "Approved by Martin.",
    outcome: "Complete",
  });
  await sendWorkspaceHatMessage(env, state, `Approved.`);
  state.marketingDraft = undefined;
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

export async function handlePaidMediaApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (state.stage !== "awaiting_paid_media_approval") {
    await sendWorkspaceHatMessage(env, state, "This spend approval has already been resolved -- nothing to do.");
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(env, state, "Got it — what should change about this spend/action? Tell me what to reconsider and I'll redo it.");
    state.pendingPaidMediaAction = undefined;
    state.awaiting = "marketing_feedback";
    return state;
  }

  await logActivity(env, {
    entry: `Digital Marketer paid media action approved`,
    type: "Decision",
    area: "Marketing",
    decisions: state.pendingPaidMediaAction?.description.slice(0, 500) ?? "",
    decisionRationale: "Budget/spend approved by Martin.",
    outcome: "Complete",
  });
  await sendWorkspaceHatMessage(env, state, `Spend approved.`);
  state.pendingPaidMediaAction = undefined;
  state.marketingDraft = undefined;
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

/** Redo loop: append Martin's reasoning to the task text and re-run the current Hat's decision from scratch. */
export async function handleMarketingFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.marketingTaskText = `${state.marketingTaskText ?? ""}\n\nMartin's feedback: ${text}`;
  return dispatchMarketingHat(env, state);
}

/** Clarification loop: re-runs intake classification if no Hat is assigned yet, otherwise re-runs the current Hat. */
export async function handleMarketingClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const augmented = `${state.marketingTaskText ?? ""}\n\nAdditional detail: ${text}`;
  if (isMarketingHat(state.hat)) {
    state.marketingTaskText = augmented;
    return dispatchMarketingHat(env, state);
  }
  return handleMarketingIntake(env, state, augmented);
}
