import type { Env } from "./types";
import { getPage, plainText, richText, select, updatePage } from "./notion";

/**
 * Shared Handoff pickup-idempotency guard, used by every Unit pickup that
 * needs to verify+claim a Handoff at the actual processing boundary rather
 * than trusting the discovery query's Pending filter alone (that filter
 * only reflects Status at query time -- a duplicate discovery trigger, a
 * retried invocation, or an externally reopened/edited record can all
 * present a Handoff for pickup a second time). This re-reads the Handoff's
 * live Status and only proceeds -- claiming it by setting Picked-up -- if
 * it is genuinely Pending at that moment. Picked-up/Held/Closed are all
 * refused. Durable Object per-workId serialization still applies on top of
 * this (two calls against the same WorkSession run sequentially, never
 * concurrently), but this guard is what makes a second call, or a call
 * against a record that was closed/held out from under it, a safe no-op
 * instead of silently reprocessing.
 */
export type HandoffClaimResult = { claimed: true } | { claimed: false; currentStatus: string; reason: string };

export async function claimPendingHandoff(env: Env, handoffId: string): Promise<HandoffClaimResult> {
  const page = await getPage(env, handoffId);
  const status = plainText(page.properties.Status);
  if (status !== "Pending") {
    return {
      claimed: false,
      currentStatus: status || "(unknown)",
      reason: `Handoff ${handoffId} is currently "${status || "unknown"}", not Pending -- refusing to process it again.`,
    };
  }
  await updatePage(env, handoffId, { Status: select("Picked-up") });
  return { claimed: true };
}

/**
 * Closes a Handoff with a rejection/cancellation reason recorded, but only
 * if it isn't already terminal -- used by the runtime's existing generic
 * terminal action (WorkSession.cancel/"/cancel") to satisfy "explicit
 * rejection with no further direction: close the current Handoff/work
 * attempt with the rejection recorded; do not silently reopen it." A
 * Closed Handoff is left untouched (never reopened here); a materially new
 * attempt after this must use a new Handoff, per the same discipline every
 * pickup boundary already enforces via claimPendingHandoff.
 */
export async function closeHandoffIfOpen(env: Env, handoffId: string, reason: string): Promise<void> {
  const page = await getPage(env, handoffId);
  const status = plainText(page.properties.Status);
  if (status === "Closed") return;
  await updatePage(env, handoffId, {
    Status: select("Closed"),
    "Open Questions": richText(reason.slice(0, 1900)),
  });
}
