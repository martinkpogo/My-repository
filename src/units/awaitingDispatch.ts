import type { WorkState } from "../types";
import type { AwaitingStateHandler } from "./unitManifest";
import { findUnitManifest } from "./registry";

/**
 * Resolves the handler for a Work's current `state.awaiting` value from the
 * owning Unit's registered manifest (`manifest.hats[state.hat]
 * .awaitingHandlers[state.awaiting]`) -- the ONE dispatch point
 * `WorkSession.handleTextReply` uses. This replaces the hardcoded
 * `switch (state.awaiting)` that used to live there; every continuation state
 * is now declared on the Hat that owns it (WP6).
 *
 * Pure lookup: no logging, no replies, no Skill resolution. handleTextReply
 * still wraps the resolved handler in runUnderRecordedSkills before invoking
 * it (declared Skills resolved through the Registry for the Action the Work
 * already recorded, exactly as before).
 *
 * Fail closed: returns undefined whenever no declared handler reaches the
 * state -- missing unit/hat/awaiting, an unregistered Unit or Hat, or an
 * awaiting value no Hat declares -- which is the caller's signal to send the
 * unchanged "This work item isn't awaiting a reply right now" message rather
 * than silently doing nothing.
 */
export function resolveAwaitingHandler(
  state: Pick<WorkState, "unit" | "hat" | "awaiting">,
): AwaitingStateHandler | undefined {
  const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
  const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
  return hat && state.awaiting ? hat.awaitingHandlers[state.awaiting] : undefined;
}
