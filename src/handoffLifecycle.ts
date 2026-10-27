import type { Env, WorkState } from "./types";
import { getPage, plainText, richText, select } from "./notion";
import { updateHandoff, type HandoffIdentity } from "./handoffWriter";
import type { AccessContext } from "./access";
import { evaluateResultReviewGate } from "./resultReview";

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

export async function claimPendingHandoff(env: Env, handoffId: string, access: AccessContext): Promise<HandoffClaimResult> {
  const page = await getPage(env, handoffId, access);
  const status = plainText(page.properties.Status);
  if (status !== "Pending") {
    return {
      claimed: false,
      currentStatus: status || "(unknown)",
      reason: `Handoff ${handoffId} is currently "${status || "unknown"}", not Pending -- refusing to process it again.`,
    };
  }
  await updateHandoff(env, handoffId, { Status: select("Picked-up") }, access);
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
export async function closeHandoffIfOpen(env: Env, handoffId: string, reason: string, access: AccessContext): Promise<void> {
  const page = await getPage(env, handoffId, access);
  const status = plainText(page.properties.Status);
  if (status === "Closed") return;
  await updateHandoff(
    env,
    handoffId,
    {
      Status: select("Closed"),
      "Open Questions": richText(reason.slice(0, 1900)),
    },
    access,
  );
}

/**
 * THE point where Work closes a Handoff SUCCESSFULLY (BD-8): the generic
 * gate in front of every `Status: Closed` + `Work Completed` write a Unit's
 * handler performs when its Work's Result is complete. The Result review gate
 * is evaluated BEFORE any Notion call; while it refuses, the Handoff is left
 * exactly as it is (Picked-up/Held) and the refusal reason is returned so the
 * caller can record it -- the Handoff never closes unchecked.
 *
 * Generic by construction: it takes no Unit, no Hat and no Action, and every
 * Unit's successful closure routes through it (the enforcement lives here,
 * not in any Unit). Cancellation and explicit NON-success closure keep their
 * existing routes (`closeHandoffIfOpen` and each handler's own explicit
 * write) and are deliberately untouched -- this helper is never used for
 * them.
 *
 * A refusal is a return value, not an exception: ignoring it only ever leaves
 * the Handoff open (the safe direction), never closed. Durable Object
 * serialization still applies on top, and `WorkSession.save` re-evaluates
 * the same gate as defence in depth.
 */
export async function closeHandoffOnResult(
  env: Env,
  state: WorkState,
  handoffId: string,
  reason: string,
  access: AccessContext,
  identity?: HandoffIdentity,
): Promise<{ closed: true } | { closed: false; reason: string }> {
  const gate = await evaluateResultReviewGate(state);
  if (!gate.allowed) {
    return { closed: false, reason: gate.reason ?? "Result review gate refused successful Handoff closure." };
  }
  await updateHandoff(
    env,
    handoffId,
    {
      Status: select("Closed"),
      "Work Completed": richText(reason.slice(0, 1900)),
    },
    access,
    identity,
  );
  return { closed: true };
}
