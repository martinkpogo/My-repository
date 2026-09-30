import type { Env, Unit, WorkState } from "../types";
import type { UnitManifest } from "./unitManifest";
import { classifyCandidateHats, classifyAction } from "../hats/intakeClassification";
import { dispatchAction, findAction } from "../hats/actionRegistry";
import { sendWorkspaceHatMessage, sendHatMessage } from "../telegram";
import { logActivity } from "../log";
import { findUnitManifest } from "./registry";
import { findManifestAction } from "./unitManifest";

/**
 * Records the registered Action a Work item is currently performing.
 *
 * ENIG Operating Model: "Work is the concrete instance of an Action being
 * performed", and Work owns "resolved Action identity". This is the ONLY
 * sanctioned way to set `WorkState.actionName`, and it exists so that every
 * write to that field is visible in one place.
 *
 * It is called in two situations, and only these two:
 *
 *   1. AT CREATION/DISPATCH -- the code that creates the Work or dispatches a
 *      request records the Action it resolved. This is resolution, in the
 *      order the architecture requires: resolve Hat -> resolve Action ->
 *      persist Action identity on Work.
 *
 *   2. AT A GOVERNED LIFECYCLE TRANSITION -- when the code performing an
 *      operation is a *different* registered Action from the one already
 *      recorded, and it is about to perform that operation. A Work that
 *      drafts a Proposal and then submits it for approval is performing
 *      `proposal_draft` and then `proposal_submit`; a Work whose
 *      qualification has been approved and which is now committing the staged
 *      Entity is performing `create_entity`. This is the Work's own lifecycle
 *      advancing, in exactly the way `stage` and `awaiting` already advance,
 *      and it is recorded by the code that owns the transition rather than
 *      inferred by whatever runs next.
 *
 * What it is NOT: a way for a caller to name the Action its operation will be
 * judged by at the point of the governed call. Access reads the recorded
 * value; it never reads a name supplied alongside the call.
 *
 * Fail-closed: an Action that is not declared on the Work's own Hat is
 * rejected here, so a typo or an invented action name can never be recorded
 * as authority in the first place.
 */
export function recordWorkAction(state: WorkState, actionName: string): WorkState {
  if (typeof actionName !== "string" || actionName.length === 0) {
    throw new Error(`cannot record an empty Action on Work ${state.workId}.`);
  }
  if (state.unit === undefined || state.hat === undefined) {
    throw new Error(`Work ${state.workId} has no Unit/Hat, so action "${actionName}" cannot be validated against a manifest.`);
  }
  const manifest = findUnitManifest(state.unit);
  const hat = manifest?.hats[state.hat];
  if (!hat) {
    throw new Error(`Work ${state.workId}: ${state.unit} declares no Hat "${state.hat}", so action "${actionName}" cannot be recorded.`);
  }
  if (!findManifestAction(actionName, hat)) {
    throw new Error(`Work ${state.workId}: ${state.unit}/${state.hat} declares no action "${actionName}" -- refusing to record an unregistered Action as authority.`);
  }
  state.actionName = actionName;
  return state;
}

/** Type-narrowing helper for the Unit a Work belongs to, used by the creators above. */
export type WorkUnit = Unit;

/**
 * Generic Unit Registry dispatch orchestrator (ENIG Operating Model
 * design doc, "The Unit Registry" / "The Action Registry"). Runs entirely
 * BEFORE any WorkSession exists -- Stage 1 (which Hat) and Stage 2 (which
 * action) both run statelessly, and a "read" action answers directly with
 * no WorkSession ever created, matching the design doc's read/write split
 * exactly ("Read -- runs immediately... no WorkSession created"). Only
 * once an "internal" or "write" action is resolved does the caller
 * (dispatchCowork) init a WorkSession and hand off to the resolved Hat's
 * entryHandler -- this function never creates one itself.
 *
 * Unit-agnostic: works for any UnitManifest, not just Business
 * Development. dispatchCowork resolves `registry[decision.unit]` and
 * calls this once, rather than reimplementing Stage 1/2 per Unit.
 */
export type UnitDispatchResult =
  | { kind: "handled" }
  | { kind: "ambiguous" }
  | { kind: "continue"; hat: string; actionName: string };

interface DispatchTarget {
  chatId: number;
  threadId?: number;
}

async function resolveHat(env: Env, manifest: UnitManifest, target: DispatchTarget, text: string): Promise<string | null> {
  const hatNames = Object.keys(manifest.hats);
  if (hatNames.length === 1) {
    return hatNames[0];
  }

  const hatSummaryList = hatNames.map((name) => `- ${name}: ${manifest.hats[name].responsibility}`).join("\n");
  const stage1 = await classifyCandidateHats<string>(
    env,
    { taskId: manifest.intakeClassificationTaskId, introLine: manifest.intakeIntroLine, hatSummaryList },
    text,
  );

  const candidates = (stage1?.candidates ?? []).filter((name) => hatNames.includes(name));
  if (candidates.length === 1) {
    return candidates[0];
  }

  const reasonText = stage1?.reason ?? (candidates.length === 0 ? "none of this Unit's Hats clearly match." : "more than one Hat could plausibly own this.");
  await logActivity(env, {
    entry: `${manifest.unit} intake ambiguous -- ${reasonText}`,
    type: "Blocker",
    area: manifest.unit,
    decisionRationale: reasonText,
    outcome: "Blocked",
  });
  await sendWorkspaceHatMessage(env, target, `I'm not sure which ${manifest.unit} Hat this belongs to -- ${reasonText} Can you clarify what's needed?`);
  return null;
}

/**
 * Stage 1 + Stage 2 + read dispatch, entirely stateless. Returns
 * "handled" once it has already replied (read action answered, or
 * Hat/action ambiguity surfaced back to Martin) -- the caller does
 * nothing further. Returns "continue" with the resolved Hat/action name
 * for the caller to init a WorkSession and call entryHandler.
 */
export async function resolveUnitRequest(env: Env, manifest: UnitManifest, target: DispatchTarget, text: string, priorHat?: string): Promise<UnitDispatchResult> {
  const hatName = priorHat ?? (await resolveHat(env, manifest, target, text));
  if (!hatName) {
    return { kind: "handled" };
  }

  const hat = manifest.hats[hatName];
  if (!hat) {
    // Fail closed: priorHat named a Hat this manifest doesn't declare.
    await sendWorkspaceHatMessage(env, target, `"${hatName}" isn't a registered ${manifest.unit} Hat.`);
    return { kind: "handled" };
  }

  const stage2 = await classifyAction(
    env,
    { taskId: manifest.actionClassificationTaskId, introLine: `You decide which action this request needs, within ${manifest.unit}'s ${hatName} Hat.` },
    hat.actions,
    text,
  );

  const actionName = stage2?.action ?? undefined;
  if (!actionName || !findAction(actionName, hat.actions)) {
    const reasonText = stage2?.reason ?? "none of this Hat's declared actions clearly match.";
    await logActivity(env, {
      entry: `${manifest.unit}.${hatName} action ambiguous -- ${reasonText}`,
      type: "Blocker",
      area: manifest.unit,
      decisionRationale: reasonText,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...target, hat: hatName }, `I'm not sure what to do here -- ${reasonText} Can you clarify?`);
    return { kind: "handled" };
  }

  const dispatchResult = await dispatchAction(actionName, text, hat.actions, (name, t) => hat.readHandler(env, name, t));
  if (!dispatchResult) {
    // Unreachable given the findAction check above -- fail closed anyway rather than silently continuing.
    await sendWorkspaceHatMessage(env, { ...target, hat: hatName }, `"${actionName}" isn't a registered action on this Hat.`);
    return { kind: "handled" };
  }

  if (dispatchResult.kind === "read") {
    // An empty reply means the readHandler already sent its own message(s)
    // directly (e.g. Lead Generation Specialist's discovery action, whose
    // interstitial "searching..." ack must go out before its search loop
    // completes, not after) -- nothing further to send. Every existing
    // read handler always returns non-empty text, so this is additive,
    // never a behavior change for them.
    if (dispatchResult.reply.trim().length > 0) {
      await sendWorkspaceHatMessage(env, { ...target, hat: hatName }, dispatchResult.reply);
    }
    return { kind: "handled" };
  }

  return { kind: "continue", hat: hatName, actionName };
}

/**
 * Chat-mode counterpart to resolveHat above: same Stage 1 candidate
 * resolution, but never sends a clarifying message and never logs a
 * Blocker Activity entry on ambiguity. Ordinary conversation not matching
 * any action is Chat's expected, common case, not a blocker worth an
 * audit trail entry the way an unresolved Cowork request is -- logging
 * every miss here would flood the Activity Log with noise from normal
 * chat. Returns null for anything not confidently resolved.
 */
async function resolveHatSilently(env: Env, manifest: UnitManifest, text: string): Promise<string | null> {
  const hatNames = Object.keys(manifest.hats);
  if (hatNames.length === 1) {
    return hatNames[0];
  }

  const hatSummaryList = hatNames.map((name) => `- ${name}: ${manifest.hats[name].responsibility}`).join("\n");
  const stage1 = await classifyCandidateHats<string>(
    env,
    { taskId: manifest.intakeClassificationTaskId, introLine: manifest.intakeIntroLine, hatSummaryList },
    text,
  );

  const candidates = (stage1?.candidates ?? []).filter((name) => hatNames.includes(name));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Chat-mode counterpart to resolveUnitRequest (ENIG Operating Model
 * design doc, "Chat is action-capable, not read-only", 2026-09-28
 * decision). Same Stage 1/Stage 2/dispatch mechanism as Cowork's
 * resolveUnitRequest -- the same Action Registry, the same read/write
 * split, the same approval-gate semantics for write actions (a
 * requiresApproval action is exactly as privileged reached from here as
 * from Cowork; this function makes no approval decision itself, it only
 * resolves and dispatches) -- but opposite ambiguity handling and reply
 * targeting:
 *
 *   - Never sends a clarifying question and never creates a Blocker
 *     Activity entry on a miss -- returns { kind: "ambiguous" } instead,
 *     so the caller falls through to ordinary conversation. Cowork's
 *     whole point is explicit direction (forcing ambiguity to resolve is
 *     correct there); Chat's whole point is low-friction conversation
 *     (blocking it with "I'm not sure what to do" for every message that
 *     isn't an action would defeat that entirely).
 *   - A "read" action's reply goes to `target` directly (wherever the
 *     chat message actually came from -- a DM or a Unit's own topic),
 *     never forced to the shared Workspace stream the way
 *     resolveUnitRequest's replies are -- Cowork only ever runs inside
 *     that one stream, so forcing it there is correct for Cowork and
 *     would misroute Chat's reply to the wrong chat entirely.
 */
export async function tryResolveUnitAction(
  env: Env,
  manifest: UnitManifest,
  target: DispatchTarget,
  text: string,
  priorHat?: string,
): Promise<UnitDispatchResult> {
  const hatName = priorHat ?? (await resolveHatSilently(env, manifest, text));
  if (!hatName) {
    return { kind: "ambiguous" };
  }

  const hat = manifest.hats[hatName];
  if (!hat) {
    // priorHat named a Hat this manifest doesn't declare -- Chat never
    // had explicit confirmation of this Hat to begin with, so fail
    // silent (fall through to conversation) rather than closed.
    return { kind: "ambiguous" };
  }

  const stage2 = await classifyAction(
    env,
    { taskId: manifest.actionClassificationTaskId, introLine: `You decide which action this request needs, within ${manifest.unit}'s ${hatName} Hat.` },
    hat.actions,
    text,
  );

  const actionName = stage2?.action ?? undefined;
  if (!actionName || !findAction(actionName, hat.actions)) {
    return { kind: "ambiguous" };
  }

  const dispatchResult = await dispatchAction(actionName, text, hat.actions, (name, t) => hat.readHandler(env, name, t));
  if (!dispatchResult) {
    // Unreachable given the findAction check above -- fail silent (not
    // closed) anyway, consistent with this function's whole discipline.
    return { kind: "ambiguous" };
  }

  if (dispatchResult.kind === "read") {
    if (dispatchResult.reply.trim().length > 0) {
      await sendHatMessage(env, { ...target, hat: hatName }, dispatchResult.reply);
    }
    return { kind: "handled" };
  }

  return { kind: "continue", hat: hatName, actionName };
}
