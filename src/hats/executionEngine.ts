import type { Env, WorkState } from "../types";
import type { ResolvedActionSkillSet } from "../platform/skillRegistry";
import { workSessionContext } from "../access";
import { logActivity } from "../log";
import { sendWorkspaceHatMessage } from "../telegram";
import { getPage, plainText, select } from "../notion";
import { updateHandoff } from "../handoffWriter";
import { dispatchMarketingHat } from "../units/marketing/marketingManifest";

/**
 * Marketing's Handoff-pickup entry point -- not a Hat registry, and not
 * a Hat-definition file. Each Marketing Hat remains independently defined
 * in its own file under src/units/marketing/ (purpose, owns, doesNotOwn,
 * routesTo); src/hats/registry.ts remains the one canonical place every
 * Hat is registered. Stage 1 (which Hat) and Stage 2 (deterministic
 * relationship resolution) intake classification, plus the
 * feedback/clarification continuation loops, now live in
 * src/units/marketing/marketingManifest.ts next to dispatchMarketingHat
 * (the per-Hat execution decision, Marketing's declared
 * "handle_request" action) -- relocated there UNCHANGED, byte-for-byte,
 * under the same rule the approval callbacks (handleTransitionApproval,
 * handleDraftApproval, handlePaidMediaApproval) already followed: any
 * function a manifest-declared entry needs -- callbackHandlers, and since
 * WP6 awaitingHandlers too -- must be DEFINED in marketingManifest.ts,
 * because importing it FROM this file would require marketingManifest.ts
 * to import back from here, inverting this file's existing one-way
 * dependency on marketingManifest.ts (dispatchMarketingHat) and risking
 * a circular import. This file keeps the Handoff-pickup entry, which no
 * manifest-declared field consumes (session.ts invokes it directly), so
 * the one-way edge stays one-way.
 *
 * Stage 1 candidate-Hat classification (classifyCandidateHats,
 * intakeClassification.ts) and Stage 2 deterministic relationship
 * resolution (resolveCandidateRelationships, relationships.ts) are
 * generic, reusable shapes a second Unit registers against directly --
 * marketingManifest.ts's handleMarketingIntake calls them bound to
 * Marketing's own taskId/Hat list/relationships, rather than owning that
 * classification logic itself.
 */

/**
 * Entry point for a Handoff addressed directly to Marketing Strategist --
 * created by an upstream Unit's approved Handoff (e.g. Strategy's
 * strategyhandoff approval). Skips the
 * two-stage intake classification handleMarketingIntake runs for chat-
 * originated work, since the sender already determined which Hat this
 * belongs to; reads the Handoff's own Reason/Verified Facts & Sources as
 * the task text, the same shape dispatchMarketingHat already expects from
 * state.marketingTaskText.
 */
export async function handleHandoffPickup(env: Env, state: WorkState, _skills: ResolvedActionSkillSet): Promise<WorkState> {
  const handoff = await getPage(env, state.handoffId!, workSessionContext(state));
  const taskText = plainText(handoff.properties["Verified Facts & Sources"]) || plainText(handoff.properties.Reason);
  if (!taskText.trim()) {
    console.error(`Marketing handleHandoffPickup: empty task text for handoff ${state.handoffId}`);
    await sendWorkspaceHatMessage(env, state, `Couldn't pick up a Handoff for Marketing Strategist (Handoff ${state.handoffId}) — it had no readable content.`);
    return state;
  }

  // Advancing the Handoff this Work item was picked up from, Pending -> Picked-up:
  // execution bookkeeping on a record the Work already owns. Ungated because the
  // Work records `handle_request` (Marketing Strategist's only Action), whose
  // consequence permits the write and whose gated effect is its own output, not
  // this Handoff's lifecycle.
  await updateHandoff(env, state.handoffId!, { Status: select("Picked-up") }, workSessionContext(state));
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
