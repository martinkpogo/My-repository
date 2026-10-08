import type { Env, Unit, WorkState } from "./types";
import { getPage } from "./notion";
import { workSessionContext } from "./access";
import { deriveHandoffDestination } from "./checkHandoffs";
import { recordWorkAction } from "./units/dispatch";
import { logActivity } from "./log";

/**
 * Cross-Unit Handoff pickup ownership -- the ONE place a WorkSession's
 * recorded Unit/Hat/Action changes owner (ENIG Operating Model:
 * "Handoff is a Business Object, not a routing subsystem").
 *
 * WHY THIS EXISTS. A Handoff chain runs on one WorkSession: the creating
 * Unit records `handoff_workitem:<handoffId> = <workId>` and adopts the new
 * record on `state.handoffId`, discovery schedules the destination Unit's
 * pickup on THAT SAME Durable Object, and the alarm runs it there. What the
 * creating path never changed was `WorkState.unit` / `state.hat` /
 * `state.actionName` -- set once at `WorkSession.init` -- so a destination
 * pickup used to run on a session still recorded as the SENDING Unit. Every
 * dispatch point reads those three fields (`handleCallback`'s prefix lookup,
 * `handleTextReply`'s awaiting lookup, `runUnderRecordedSkills`, Access's
 * `workSessionContext`, the sessions index), so the receiving Unit's own
 * buttons, replies, declared Skills and Action authority were unreachable:
 * "Redo Finance Quote" on a Strategy-originated session resolved nothing and
 * silently did nothing.
 *
 * THE MODEL. The Handoff stays the source of truth for who owns the work;
 * this module reads it once, at the claim/pickup boundary, and records that
 * owner on the Work -- exactly what the external path (a Handoff with no
 * existing session) already does when it `init`s a brand-new session with
 * the destination's unit/hat/actionName. Two existing patterns meet here:
 * `state.handoffId` adoption at Handoff creation, and destination
 * resolution at session creation. The session identity (`workId`), its
 * pointers and its history are deliberately untouched: ownership transfers,
 * the session does not split, and nothing is resolved dynamically at
 * dispatch time (no Notion read on a button tap, no second authority that
 * can drift from the Handoff).
 *
 * TIMING. Ownership moves when the receiving Unit claims the Handoff, not
 * when it is sent: between send and pickup the sending Unit's own approval
 * flow is still live on this session and still needs it.
 *
 * FAIL CLOSED. Anything unexpected (no recorded Handoff, a destination that
 * no longer matches this Unit, a Hat or Action the registry does not
 * declare) throws BEFORE the pickup handler runs. The caller's
 * `WorkSession.execute` then keeps the pre-error state unsaved, so nothing
 * is claimed, nothing is persisted, and the Handoff stays Pending for the
 * next discovery cycle.
 */

/**
 * The WorkState fields that are the SENDING Unit's staged interaction: a
 * continuation the receiving Unit must not inherit, resolve, or act on.
 * Cleared on transfer so a stale reply, a stale re-sent approval button or
 * a stale status bubble from before the transfer can never reach a handler
 * or mutate the receiving Unit's state (their manifest lookup would already
 * refuse most of them; this is belt and braces for the ones that are not
 * prefix-scoped).
 *
 * `pendingGoogleAction` is deliberately NOT here: a Google OAuth grant is
 * session-scoped infrastructure, not one Unit's staged business decision.
 * `entityName`/`matterName`/`strategyProposal` and the rest of the
 * substantive context are also left alone -- they are evidence the chain
 * carries forward, not interaction state.
 */
export const STAGED_INTERACTION_FIELDS: readonly (keyof WorkState)[] = [
  "awaiting",
  "pendingApproval",
  "pendingTransition",
  "pendingPaidMediaAction",
  "pendingStrategyHandoff",
  "pendingBDHandoff",
  "pendingBDDevelop",
  "pendingBDNextMove",
  "pendingStrategyApproval",
  "pendingStrategyRefinement",
  "pendingSalesProposalRevision",
  "pendingLeadOpportunity",
  "pendingActionSummary",
  "pendingHandoffAutoCheck",
  "workStatus",
  "workStatusMessageId",
];

/**
 * Reads the Handoff this Work was picked up from and adopts its destination
 * as this Work's recorded ownership. Mutates `state` in place only once the
 * whole destination has validated; returns the same state object.
 *
 * A destination identical to what the Work already records (the external
 * path, or a same-Unit continuation) is a strict no-op: no field is touched,
 * no Activity is written, so an already-correct session keeps behaving
 * exactly as it did.
 */
export async function adoptHandoffOwnership(env: Env, state: WorkState, expectedUnit: Unit): Promise<WorkState> {
  if (!state.handoffId) {
    throw new Error(
      `Work ${state.workId}: a ${expectedUnit} pickup ran with no Handoff recorded on the Work -- refusing to guess which destination owns it.`,
    );
  }

  // The same record `handlePickup` will claim a few lines later, so the
  // ownership adopted here and the Handoff claimed there can never be two
  // different Handoffs. Reads are never gated by Access (an approval
  // authorizes a change, and reading is not one), so this costs one page
  // read and no approval.
  const handoff = await getPage(env, state.handoffId, workSessionContext(state));
  const destination = await deriveHandoffDestination(handoff, expectedUnit);
  if (!destination.ok) {
    throw new Error(
      `Handoff ${state.handoffId}: ${destination.reason} -- refusing to run the ${expectedUnit} pickup without an established destination.`,
    );
  }

  const { unit, hat, actionName } = destination;
  if (state.unit === unit && state.hat === hat && state.actionName === actionName) return state;

  // Validate the whole destination against a candidate first: if the
  // registered manifest does not declare this Hat/Action, recordWorkAction
  // throws and the live state is still untouched. recordWorkAction is the
  // only sanctioned writer of WorkState.actionName, so the new Action goes
  // through it rather than being assigned here.
  const candidate: WorkState = { ...state, unit, hat };
  recordWorkAction(candidate, actionName);

  const previousUnit = state.unit;
  const previousHat = state.hat;
  state.unit = unit;
  state.hat = hat;
  state.actionName = candidate.actionName;
  for (const field of STAGED_INTERACTION_FIELDS) {
    (state as unknown as Record<string, unknown>)[field] = undefined;
  }

  // Governance evidence for the transfer itself: which Handoff moved it,
  // from where to where. Written by the receiving Unit's area.
  await logActivity(env, {
    entry: `Work ownership transferred: ${previousUnit ?? "(unassigned)"}${previousHat ? `/${previousHat}` : ""} -> ${unit}/${hat}`,
    type: "Activity",
    area: unit,
    activity: `Handoff ${state.handoffId} picked up by ${unit}; Work ${state.workId} now records that Unit, Hat and Action.`,
    decisionRationale:
      "The Handoff's destination facts (To Unit / To Hat) are the source of truth for who owns the work, so the Work's recorded Unit/Hat/Action are updated to match at pickup -- every dispatch point (callback prefixes, awaiting replies, declared Skills, Access authority, the sessions index) resolves against the receiving Unit from here on.",
    outcome: "Complete",
    workId: state.workId,
  });

  return state;
}

/**
 * The pickup boundary every scheduled runner wraps its handler in: adopt
 * the Handoff's destination as this Work's ownership, then run. Any failure
 * propagates before `run` is called, which is what makes it fail closed --
 * the handler never runs on a session still recorded as the sending Unit,
 * and nothing partial is saved.
 */
export async function runWithAdoptedOwnership(
  env: Env,
  state: WorkState,
  expectedUnit: Unit,
  run: (state: WorkState) => Promise<WorkState>,
): Promise<WorkState> {
  const adopted = await adoptHandoffOwnership(env, state, expectedUnit);
  return run(adopted);
}
