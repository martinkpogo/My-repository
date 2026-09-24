import type { Env } from "../types";
import type { UnitManifest } from "./unitManifest";
import { classifyCandidateHats, classifyAction } from "../hats/intakeClassification";
import { dispatchAction, findAction } from "../hats/actionRegistry";
import { sendWorkspaceHatMessage } from "../telegram";
import { logActivity } from "../log";

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
    await sendWorkspaceHatMessage(env, { ...target, hat: hatName }, dispatchResult.reply);
    return { kind: "handled" };
  }

  return { kind: "continue", hat: hatName, actionName };
}
