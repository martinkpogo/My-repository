import type { Env } from "../../types";
import { getPage, plainText, select, updatePage } from "../../notion";
import type { AccessContext } from "../../access";

/**
 * Runtime's one write to a Call Notes record: `Ready` -> `Consumed`.
 *
 * **The Runtime owns `Ready` -> `Consumed` and nothing else.** It never creates
 * a Call Notes record (Isolated Sales is the creation authority), never writes
 * `Superseded`, never writes any other property of the record, and never
 * re-reads or re-writes a record it already consumed. The lifecycle is
 * `Ready -> Consumed -> Superseded`: this module advances the first arrow, and
 * Isolated Sales owns both the create and the second.
 *
 * **Why this shape.** It is deliberately the same compare-current-status ->
 * write-or-refuse guard `claimPendingHandoff` uses in `src/handoffLifecycle.ts`,
 * for the same reason that guard exists there: a discovery query's filter only
 * reflects Status as of the moment it was answered, so a record can be Ready
 * when it is looked up and no longer Ready by the time a write would land. Two
 * sequences -- a retried invocation, or a second pickup racing the first -- must
 * not be able to consume the same record twice, and the only thing that makes
 * that true is re-reading Status at the actual write boundary rather than
 * trusting whatever the caller last saw.
 *
 * A record that is already `Consumed`, is `Superseded`, or carries any other
 * Status is refused **with no write at all**: the caller is told the current
 * Status and nothing is touched. That refusal is what makes replay safe -- the
 * second attempt observes `Consumed`, declines, and the record's history stays
 * a single honest transition instead of a double-consumed one.
 *
 * The write payload is `{ Status }` and nothing else. The record's `Entity` and
 * `Matter` relations, its `Version`, and every other registry field are left
 * exactly as the creation authority wrote them -- this lifecycle step advances
 * a Status and is not permitted to become a second writer of the record's
 * substance.
 */
export type ConsumeReadyCallNotesResult =
  | { consumed: true; pageId: string }
  | { consumed: false; reason: string };

/**
 * Transitions a Call Notes record from `Ready` to `Consumed`, or refuses.
 *
 * The comparison happens on a page read immediately before the write, not on
 * whatever the discovery/lookup query returned, so a caller can never turn a
 * stale Status into a write.
 */
export async function consumeReadyCallNotes(
  env: Env,
  callNotesPageId: string,
  access: AccessContext,
): Promise<ConsumeReadyCallNotesResult> {
  const page = await getPage(env, callNotesPageId, access);
  const currentStatus = plainText(page.properties?.Status);

  if (currentStatus !== "Ready") {
    return {
      consumed: false,
      reason:
        `Call Notes record ${callNotesPageId} reports Status "${currentStatus || "(empty)"}", not "Ready" -- ` +
        `the Runtime consumes a record exactly once and only from Ready, so this transition is refused with no write.`,
    };
  }

  await updatePage(env, callNotesPageId, { Status: select("Consumed") }, access);
  return { consumed: true, pageId: callNotesPageId };
}
