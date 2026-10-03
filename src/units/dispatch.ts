import type { Env, Unit, WorkState } from "../types";
import type { HatManifest, UnitManifest } from "./unitManifest";
import { classifyCandidateHats, classifyAction } from "../hats/intakeClassification";
import { dispatchAction } from "../hats/actionRegistry";
import { sendWorkspaceHatMessage, sendHatMessage } from "../telegram";
import { logActivity } from "../log";
import { findUnitManifest } from "./registry";
import { findManifestAction } from "./unitManifest";
import { resolveOrganization, type OrganizationFailureReason } from "../runtime/organization";
import { bindExecutionSkills } from "../runtime/actionSkills";
import { NO_ACTION_SKILLS, SkillResolutionError, type ResolvedActionSkillSet } from "../platform/skillRegistry";
import { resolveActionExecution, type ActionExecutionContext, type ActionFailureReason } from "../runtime/actionResolution";
import { workContractForRequest, type WorkMode, type WorkRequest } from "../runtime/workContract";

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
 * Generic Unit Registry dispatch orchestrator (ENIG Operating Model:
 * "The Unit Registry" / Action Resolution). Runs entirely BEFORE any
 * WorkSession exists -- Organization resolution and Action resolution both
 * run statelessly, and a "read" action answers directly with no WorkSession
 * ever created ("Read -- runs immediately... no WorkSession created"). Only
 * once an "internal" or "write" action resolves does the caller
 * (dispatchCowork) init a WorkSession and hand the resolved execution
 * context to WorkSession.handleUnitAction -- this function never creates
 * one itself.
 *
 * The resolution boundaries it drives:
 *
 *   1. `resolveOrganization` (runtime/organization.ts) decides Unit/Hat/
 *      Responsibility from the canonical definitions alone. Stage 1's AI
 *      classification may PROPOSE Hat candidates when a multi-Hat Unit was
 *      addressed to none of them; it is validated input, never authority,
 *      and ambiguity fails closed.
 *   2. `resolveActionExecution` (runtime/actionResolution.ts) evaluates the
 *      declared applicability of every manifest-exposed Action against the
 *      Work contract and requires exactly one to apply. An intake
 *      interpretation (Stage 2) runs ONLY when the Work context alone
 *      determines no Action -- its output enters the contract as
 *      `requested_action` and is validated like any other condition, never
 *      chosen by similarity or confidence.
 *
 * Unit-agnostic: works for any UnitManifest. dispatchCowork resolves
 * `findUnitManifest(decision.unit)` and calls this once, rather than
 * reimplementing resolution per Unit.
 */
export type UnitDispatchResult =
  | { kind: "handled" }
  | { kind: "ambiguous" }
  | {
      kind: "continue";
      hat: string;
      actionName: string;
      /** The full resolved Action Execution Context -- consumed by WorkSession.handleUnitAction rather than re-derived there. */
      execution: ActionExecutionContext;
    };

interface DispatchTarget {
  chatId: number;
  threadId?: number;
}

/**
 * An intake interpretation of WHICH Hat a request belongs to (Stage 1).
 * Untrusted input: the Organization boundary validates these candidates
 * against the Unit's own manifest and can only reject them -- never fall
 * back to a default, never pick the closest match.
 */
interface HatInterpretation {
  candidates: string[];
  reason?: string;
}

/**
 * Runs Stage 1 (which Hat) ONLY when one can actually matter: the Unit
 * declares several Hats and the Work was addressed to none of them.
 * Returns undefined when no interpretation is needed (a single-Hat Unit, or
 * an explicitly addressed Hat), so resolution is then purely structural.
 *
 * Shared by Cowork and Chat: this function neither logs nor replies on
 * ambiguity. What each mode does with an unresolved Organization differs
 * (Cowork asks a clarifying question and logs a Blocker; Chat falls open to
 * conversation silently) and lives in each caller, exactly as before.
 */
async function interpretHat(
  env: Env,
  manifest: UnitManifest,
  text: string,
  priorHat?: string,
): Promise<HatInterpretation | undefined> {
  const hatNames = Object.keys(manifest.hats);
  if (priorHat || hatNames.length === 1) {
    return undefined;
  }

  const hatSummaryList = hatNames.map((name) => `- ${name}: ${manifest.hats[name].responsibility}`).join("\n");
  const stage1 = await classifyCandidateHats<string>(
    env,
    { taskId: manifest.intakeClassificationTaskId, introLine: manifest.intakeIntroLine, hatSummaryList },
    text,
  );

  return {
    candidates: (stage1?.candidates ?? []).filter((name) => hatNames.includes(name)),
    reason: stage1?.reason,
  };
}

/**
 * Builds the Work contract (Work.requested_outcome + Work.current_context)
 * that both resolution boundaries read. The addressed Unit is a fact
 * workspaceRouter already resolved deterministically; `origin` says how this
 * Work was entered (a direct request -- Handoff pickups enter through
 * checkHandoffs instead).
 */
function contractForRequest(
  text: string,
  mode: WorkMode,
  manifest: UnitManifest,
  priorHat: string | undefined,
  interpretation: HatInterpretation | undefined,
) {
  const request: WorkRequest = {
    requested_outcome: text,
    current_context: {
      mode,
      origin: "direct_request",
      addressed_unit: manifest.unit,
      addressed_hat: priorHat,
      interpreted_hats: interpretation?.candidates,
    },
  };
  return workContractForRequest(request);
}

/** Attaches an intake interpretation's exact Action id to a contract (Resolution reads it as `current_context.requested_action`). */
function withRequestedAction(
  contract: ReturnType<typeof contractForRequest>,
  requestedAction: string | null,
): ReturnType<typeof contractForRequest> {
  return { ...contract, current_context: { ...contract.current_context, requested_action: requestedAction } };
}

/**
 * Cowork's discipline when the Organization cannot be resolved: log a
 * Blocker and ask the one clarifying question (identical text to what
 * resolveHat sent before Resolution existed), except for an addressee that
 * names a Hat this Unit doesn't declare -- that detail is already the whole
 * message.
 */
async function organizationFailedCowork(
  env: Env,
  manifest: UnitManifest,
  target: DispatchTarget,
  failure: { reason: OrganizationFailureReason; detail: string },
  interpretation: HatInterpretation | undefined,
): Promise<UnitDispatchResult> {
  if (failure.reason === "ambiguous_ownership") {
    const reasonText =
      interpretation?.reason ??
      ((interpretation?.candidates.length ?? 0) === 0
        ? "none of this Unit's Hats clearly match."
        : "more than one Hat could plausibly own this.");
    await logActivity(env, {
      entry: `${manifest.unit} intake ambiguous -- ${reasonText}`,
      type: "Blocker",
      area: manifest.unit,
      decisionRationale: reasonText,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, target, `I'm not sure which ${manifest.unit} Hat this belongs to -- ${reasonText} Can you clarify what's needed?`);
    return { kind: "handled" };
  }
  await sendWorkspaceHatMessage(env, target, failure.detail);
  return { kind: "handled" };
}

/**
 * Cowork's discipline when no single Action applies: log a Blocker and ask
 * the one clarifying question (identical text to what the pre-Resolution
 * Stage 2 failure path sent). When an intake interpretation was consulted,
 * its reason is the reason; when Resolution failed on its own declarations
 * (e.g. several applicable without precedence), that detail is.
 */
async function actionFailedCowork(
  env: Env,
  manifest: UnitManifest,
  hatName: string,
  target: DispatchTarget,
  failure: { reason: ActionFailureReason; detail: string },
  interpretationReason: string | undefined,
): Promise<UnitDispatchResult> {
  const reasonText =
    interpretationReason ??
    (failure.reason === "zero_applicable" ? "none of this Hat's declared actions clearly match." : failure.detail);
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

/**
 * Runs the resolved Action through the shared Action Registry dispatch:
 * a "read" answers immediately (its reply targeted per mode -- Cowork's
 * replies go to the Workspace stream, Chat's go wherever the message came
 * from); an "internal"/"write" returns the resolved execution context for
 * the caller to create the WorkSession with.
 */
async function dispatchResolvedAction(
  env: Env,
  hat: HatManifest,
  hatName: string,
  target: DispatchTarget,
  execution: ActionExecutionContext,
  text: string,
  mode: WorkMode,
): Promise<UnitDispatchResult> {
  const actionName = execution.action.action_id;
  // A read Action runs here, so its declared Skills are bound here: the same
  // check handleUnitAction applies to write/internal Actions, before any
  // handler can run. An Action declaring none binds the empty set.
  const declaredAction = hat.actions.find((a) => a.name === actionName);
  let skills: ResolvedActionSkillSet = NO_ACTION_SKILLS;
  if (declaredAction) {
    try {
      skills = await bindExecutionSkills(execution.skills, declaredAction);
    } catch (err) {
      if (!(err instanceof SkillResolutionError)) throw err;
      console.error(`dispatchResolvedAction: required Skill resolution failed for ${actionName}: ${err.reason}`);
      if (mode === "chat") return { kind: "ambiguous" };
      await sendWorkspaceHatMessage(env, { ...target, hat: hatName }, "A Skill this action requires could not be verified -- nothing was run.");
      return { kind: "handled" };
    }
  }
  const dispatchResult = await dispatchAction(actionName, text, hat.actions, (name, t) => hat.readHandler(env, name, t, skills));
  if (!dispatchResult) {
    // Unreachable: Resolution only ever returns manifest-exposed Actions.
    // Fail closed/silent anyway rather than silently continuing.
    if (mode === "chat") return { kind: "ambiguous" };
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
      if (mode === "chat") {
        await sendHatMessage(env, { ...target, hat: hatName }, dispatchResult.reply);
      } else {
        await sendWorkspaceHatMessage(env, { ...target, hat: hatName }, dispatchResult.reply);
      }
    }
    return { kind: "handled" };
  }

  return { kind: "continue", hat: hatName, actionName, execution };
}

/**
 * Cowork-mode Organization + Action Resolution and read dispatch,
 * entirely stateless. Returns "handled" once it has already replied (read
 * answer sent, or an Organization/Action ambiguity surfaced back to Martin)
 * -- the caller does nothing further. Returns "continue" with the resolved
 * Hat and the full execution context for the caller to init a
 * WorkSession and call handleUnitAction.
 */
export async function resolveUnitRequest(
  env: Env,
  manifest: UnitManifest,
  target: DispatchTarget,
  text: string,
  priorHat?: string,
): Promise<UnitDispatchResult> {
  // 1. Organization resolution (Unit/Hat/Responsibility). Stage 1's
  // candidates, when consulted, are validated here -- not authority.
  const interpretation = await interpretHat(env, manifest, text, priorHat);
  let contract = contractForRequest(text, "cowork", manifest, priorHat, interpretation);
  const organization = resolveOrganization(contract, manifest);
  if (organization.kind === "failed") {
    return organizationFailedCowork(env, manifest, target, organization, interpretation);
  }
  const org = organization.organization;
  const hat = manifest.hats[org.hat]!; // resolveOrganization only returns a Hat this manifest declares

  // 2. Action resolution. Context first, with no AI involved; an intake
  // interpretation runs only when the Work context alone determines no
  // Action (a Unit whose Actions differ only by what was asked for).
  let resolution = await resolveActionExecution(manifest, org, contract);
  let interpretationReason: string | undefined;
  if (resolution.kind === "need_interpretation") {
    const stage2 = await classifyAction(
      env,
      { taskId: manifest.actionClassificationTaskId, introLine: `You decide which action this request needs, within ${manifest.unit}'s ${org.hat} Hat.` },
      hat.actions,
      text,
    );
    interpretationReason = stage2?.reason;
    contract = withRequestedAction(contract, stage2?.action ?? null);
    resolution = await resolveActionExecution(manifest, org, contract);
  }
  if (resolution.kind === "need_interpretation") {
    // Unreachable: the re-resolution above always carries an interpretation
    // state (a string, or null for "attempted, nothing usable") -- never
    // "not attempted yet". Fail closed rather than looping or guessing.
    return actionFailedCowork(
      env,
      manifest,
      org.hat,
      target,
      { reason: "zero_applicable", detail: "no declared Action of this Hat is applicable, even after an intake interpretation" },
      interpretationReason,
    );
  }
  if (resolution.kind === "failed") {
    return actionFailedCowork(env, manifest, org.hat, target, resolution, interpretationReason);
  }

  return dispatchResolvedAction(env, hat, org.hat, target, resolution.execution, text, "cowork");
}

/**
 * Chat-mode counterpart to resolveUnitRequest ("Chat is action-capable,
 * not read-only", 2026-09-28 decision). Same resolution boundaries, the
 * same Action Registry, the same read/write split and approval-gate
 * semantics -- but opposite ambiguity handling and reply targeting:
 *
 *   - Never sends a clarifying question and never creates a Blocker
 *     Activity entry on a miss -- returns { kind: "ambiguous" } instead,
 *     so the caller falls through to ordinary conversation. Cowork's
 *     whole point is explicit direction (forcing ambiguity to resolve is
 *     correct there); Chat's whole point is low-friction conversation
 *     (blocking it with "I'm not sure what to do" for every message that
 *     isn't an action would defeat that entirely).
 *   - An intake interpretation is REQUIRED here: Chat only starts
 *     governed Work when an interpretation names a declared Action, and
 *     the resolved Action must be the one that was named. That is
 *     Chat's own mode policy (its fail-open discipline), applied before
 *     Resolution; the named Action is still only a proposal that
 *     Resolution validates against its declared applicability -- and a
 *     proposal that names nothing this Hat can actually be entered with
 *     falls open to conversation rather than starting the wrong Work.
 *   - A "read" action's reply goes to `target` directly (wherever the
 *     chat message actually came from -- a DM or a Unit's own topic),
 *     never forced to the shared Workspace stream the way
 *     resolveUnitRequest's replies are.
 */
export async function tryResolveUnitAction(
  env: Env,
  manifest: UnitManifest,
  target: DispatchTarget,
  text: string,
  priorHat?: string,
): Promise<UnitDispatchResult> {
  const interpretation = await interpretHat(env, manifest, text, priorHat);
  const contract = contractForRequest(text, "chat", manifest, priorHat, interpretation);
  const organization = resolveOrganization(contract, manifest);
  if (organization.kind === "failed") {
    return { kind: "ambiguous" };
  }
  const org = organization.organization;
  const hat = manifest.hats[org.hat]!; // resolveOrganization only returns a Hat this manifest declares

  const stage2 = await classifyAction(
    env,
    { taskId: manifest.actionClassificationTaskId, introLine: `You decide which action this request needs, within ${manifest.unit}'s ${org.hat} Hat.` },
    hat.actions,
    text,
  );
  if (!stage2?.action) {
    // Chat's classification gate: no interpretation, no governed Work --
    // fall open to conversation (unchanged from before Resolution).
    return { kind: "ambiguous" };
  }

  const resolution = await resolveActionExecution(manifest, org, withRequestedAction(contract, stage2.action));
  if (resolution.kind !== "resolved" || resolution.execution.action.action_id !== stage2.action) {
    return { kind: "ambiguous" };
  }

  return dispatchResolvedAction(env, hat, org.hat, target, resolution.execution, text, "chat");
}
