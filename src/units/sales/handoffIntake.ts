import { plainText } from "../../notion";
import { sendOperationsMessage } from "../../telegram";
import { kvGet, kvPut } from "../../kvStore";
import type { Env } from "../../types";
import { SALES_EXECUTIVE_PAUSED } from "../../sessionRouting";
import type { HandoffPickupDeclaration } from "../unitManifest";
import { handleProposalHandoffPickup } from "./tokenSafeProposal";

/**
 * How Sales takes in Handoffs addressed to it -- the Sales-specific parts of
 * Handoff discovery, declared on Sales's manifest (UnitManifest.handoffPickup)
 * so the generic Worker names no Unit. Moved here, unchanged in behaviour,
 * from checkHandoffs.ts's former discoverPendingSalesHandoffs.
 */

type DiscoveredHandoff = { id: string; properties?: Record<string, any> };

/**
 * Sends the Operations-topic "a Sales Handoff needs a human to activate
 * the Sales Claude Project" notification -- fired the first time a given
 * Pending Sales Handoff is detected while Sales Executive's own automated
 * pickup stays paused (see SALES_EXECUTIVE_PAUSED). Deliberately carries
 * only opaque identifiers (Matter_Token, the Handoff's own Notion page id)
 * -- never a real Entity/company name, matching the Operations security
 * contract every other cross-Unit summary already follows. Deduped
 * per-Handoff via a plain KV flag: this is a notification-noise
 * optimization only, never the authority for whether the Handoff itself
 * may be processed (that remains its live Status, per claimPendingHandoff).
 */
async function notifySalesHandoffReady(env: Env, handoff: { id: string }, matterToken: string): Promise<void> {
  const notifiedKey = `sales_handoff_notified:${handoff.id}`;
  if (await kvGet(env, notifiedKey)) return;
  await sendOperationsMessage(
    env,
    `*SALES HANDOFF READY*\nMatter: ${matterToken}\nHandoff: ${handoff.id}\nTo: Sales Executive\nStatus: Pending\n\nAction required: open the Sales Executive workspace (the isolated Sales Claude Project) and check the pending Handoff.`,
  );
  await kvPut(env, notifiedKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }).catch((err) =>
    console.error(`Failed to record sales_handoff_notified for ${handoff.id}`, err),
  );
}

/**
 * One Operations notice per call-notes Handoff that reaches Runtime Sales
 * after LOG-987, so it is never silently ignored -- and never re-sent every
 * discovery cycle (KV key per Handoff, kept 30 days).
 */
async function notifyRetiredCallNotesHandoff(env: Env, handoff: DiscoveredHandoff): Promise<void> {
  const key = `sales_callnotes_retired_notice:${handoff.id}`;
  if (await kvGet(env, key)) return;
  const matterToken = plainText(handoff.properties?.Matter_Token) || "(unknown)";
  await sendOperationsMessage(
    env,
    `⛔ Call-notes Handoff for ${matterToken} was not picked up by Runtime Sales.\n\nRuntime Sales no longer qualifies or progresses Leads (LOG-987). Run *sales-fit-assessment*, then *sales-progression*, in Isolated Sales for this Matter. The Handoff was left as it is.`,
  );
  await kvPut(env, key, new Date().toISOString(), { expirationTtl: 30 * 24 * 60 * 60 });
}

/**
 * Identifies a call-notes Handoff created by the isolated Sales Executive
 * Claude project (per its Project Instructions' Section 6A) rather than by
 * this Worker's own Finance/Strategy code. Detected by a case-insensitive
 * match on "requiredCategory: call_notes" anywhere in Reason OR the
 * Handoff title -- not a strict opening-phrase prefix, and not a single
 * fixed field -- since both are free text a Claude session composes
 * itself and neither their exact wording nor which field carries the
 * marker is reliably reproducible run to run (confirmed live: HO-69
 * carried it in Reason; HO-73 carried it only in the Handoff title, with
 * Reason containing no such text at all -- checking Reason alone silently
 * misrouted HO-73 into runProposalDrafting, which then failed trying to
 * parse a Finance quote out of call notes). requiredCategory is the field
 * name HandoffContextContract already uses for this exact purpose.
 */
function isCallNotesHandoff(handoff: DiscoveredHandoff): boolean {
  const marker = /requiredCategory:\s*call_notes\b/i;
  return marker.test(plainText(handoff.properties?.Reason)) || marker.test(plainText(handoff.properties?.Handoff));
}

/**
 * Sales's Handoff intake.
 *
 * screen -- LOG-987: Runtime Sales does not qualify. A call-notes Handoff to
 * Sales is not picked up, registered or claimed; fit assessment and
 * progression belong to Isolated Sales. Martin is told once per Handoff and
 * the record is left exactly as found.
 *
 * hold -- Execution stays gated behind SALES_EXECUTIVE_PAUSED for every
 * remaining Sales Handoff: while paused, the Handoff is registered,
 * Operations is notified, and it stays Pending. The governed work happens
 * only once Martin opens the Sales Claude Project and says "Check Handoff" --
 * a deliberate human activation boundary discovery must not cross. When not
 * paused every non-call-notes Sales Handoff (a Finance -> Sales quote
 * Handoff included) runs the token-safe Proposal flow (LOG-808).
 *
 * `paused` defaults to SALES_EXECUTIVE_PAUSED and exists so the unpaused path
 * can be tested; production passes nothing.
 */
export function salesHandoffPickup(paused: boolean = SALES_EXECUTIVE_PAUSED): HandoffPickupDeclaration {
  return {
    handler: (env, state, skills) => handleProposalHandoffPickup(env, state, skills),
    async screen(env, handoff) {
      if (!isCallNotesHandoff(handoff)) return "accept";
      await notifyRetiredCallNotesHandoff(env, handoff).catch((err) =>
        console.error(`Failed to send the LOG-987 notice for call-notes Handoff ${handoff.id}`, err),
      );
      return "skip";
    },
    async hold(env, handoff) {
      if (!paused) return false;
      const matterToken = plainText(handoff.properties?.Matter_Token) || "(unknown)";
      await notifySalesHandoffReady(env, handoff, matterToken).catch((err) =>
        console.error(`Failed to send Sales Handoff ready notification for ${handoff.id}`, err),
      );
      return true;
    },
  };
}
