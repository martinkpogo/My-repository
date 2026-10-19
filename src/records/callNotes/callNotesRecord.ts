import type { Env } from "../../types";
import { getPage, plainText, queryDataSource, relationIds } from "../../notion";
import type { AccessContext } from "../../access";
import { resolveEntityMatterFromTokens } from "../../identityResolution";
import { consumeReadyCallNotes } from "./callNotesLifecycle";
import {
  parseRecordApprovalMarker,
  type CallNotesApprovalRecord,
  type RecordApprovalAttestation,
} from "./callNotesMarker";
import { resolveHandoffSources, type HandoffSourceRouteContract } from "../../handoffSources";

/**
 * Runtime's consumption of a governed Call Notes record, reached from a
 * call-notes Handoff's `Call_Notes_ID` reference.
 *
 * **The shape of the change.** The previous path treated the Handoff as the
 * carrier of the evidence itself: the isolated Sales project's de-identified
 * narrative in `Verified Facts & Sources` was read and qualified. The governed
 * path treats the Handoff as a **routing/reference carrier only** -- it names
 * WHICH Call Notes record to read, and the record is what the evidence comes
 * from. The Handoff never becomes authoritative about the record's content, and
 * once a `Call_Notes_ID` reference is present there is deliberately no fallback
 * to the old free-text narrative: if the record cannot be retrieved and
 * consumed, this returns a refusal and the Handoff is held.
 *
 * Five gates run in order, each failing closed with no write:
 *
 *   1. **Reference** -- a `Call_Notes_ID` line in the Handoff's own free text,
 *      read from the same reference convention `isCallNotesHandoff`
 *      (`src/checkHandoffs.ts`) already uses. No new Handoff property, no new
 *      transport, and never inferred from Entity/Matter.
 *   2. **Identity binding targets** -- the Handoff's `Entity_Token`/`Matter_Token`
 *      resolved to their real operational page IDs by the existing
 *      `resolveEntityMatterFromTokens`, so the record's relations have something
 *      to be checked against.
 *   3. **Exact lookup** -- one query on `env.CALL_NOTES_DATA_SOURCE_ID` matching
 *      the reference exactly on the `Call Notes ID` title. Zero matches and
 *      multiple matches are both refusals; there is no "nearest record" and no
 *      second pass with a looser filter.
 *   4. **Status and binding** -- the located record must be `Ready`, and its
 *      `Entity` and `Matter` relations must be exactly the pages gate 2
 *      resolved. A record belonging to another Entity or Matter is refused.
 *   5. **Attestation** -- the record's `Approval Attestation` is validated by
 *      the existing `parseRecordApprovalMarker` against the record's own
 *      registry fields, and only then is `Ready -> Consumed` attempted by
 *      `consumeReadyCallNotes`.
 *
 * What this module deliberately does NOT do: create a Call Notes record, write
 * anything other than the Status transition, re-run an approval flow, or mint
 * an ApprovalProof. The attestation it validates is the procedural one the
 * creation authority recorded on the record -- it is not proof that any
 * Runtime-side approval happened, and nothing here should be described as
 * having verified evidence contents.
 *
 * Reading the record's substantive `Note` property is deliberately absent from
 * this path too: Sales's consumption qualifies the record's registry fields,
 * and the `Note` is read only by Strategy's separate, read-only evidence
 * retrieval through the same five gates plus a final step (see
 * `src/units/strategy/strategyEvidence.ts`). Nothing here assumes the registry
 * fields are the whole of a record's evidence, and nothing there changes what
 * Sales receives here.
 */

/** The free-text reference convention and the registry reader live in
 * ./callNotesReference.ts (a leaf module, so handoffSources.ts -- the
 * direct-page Sources resolver -- can share exactly this implementation
 * without an import cycle). They are re-exported here unchanged: every
 * existing importer of this module keeps the same names and the same
 * behavior; there is still exactly ONE implementation of each. */
export { extractCallNotesReference, readApprovalRecord, type CallNotesReference } from "./callNotesReference";
import { extractCallNotesReference, readApprovalRecord } from "./callNotesReference";

/**
 * The governed record's six canonical registry fields, rendered for a model to
 * read.
 *
 * Exactly `CALL_NOTES_APPROVAL_FIELDS`' own names -- so that what is presented
 * is what the governed record says and nothing else. Presentation only: this
 * text is never hashed, never written back anywhere, and carries no claim the
 * record does not itself hold. (The canonical Call Notes schema carries no
 * Evidence Package properties, so nothing about one is ever presented here.)
 *
 * What it IS, by caller: Sales's own `retrieveAndConsumeCallNotes` hands these
 * fields, unchanged, to the existing commercial-value extraction and
 * qualification path -- that contract is untouched by Strategy's evidence
 * retrieval. Strategy's read-only path (`src/units/strategy/strategyEvidence.ts`)
 * uses this same rendering as the IDENTIFICATION section of its evidence base
 * and appends the record's separately-read `Note` property, labelled, as the
 * substantive evidence: the registry fields say which approved record was
 * read, they are never the situation a diagnosis is about.
 */
export function callNotesEvidenceText(record: CallNotesApprovalRecord): string {
  return [
    `Call_Notes_ID: ${record.callNotesId}`,
    `Entity: ${record.entity}`,
    `Matter: ${record.matter}`,
    `Call Date: ${record.callDate}`,
    `Call Type: ${record.callType}`,
    `Version: ${String(record.version)}`,
  ].join("\n");
}

export type CallNotesConsumption =
  | {
      ok: true;
      record: CallNotesApprovalRecord;
      pageId: string;
      attestation: RecordApprovalAttestation;
      evidenceText: string;
    }
  | { ok: false; reason: string };

/**
 * Resolves a call-notes Handoff's reference to a consumed, governed Call Notes
 * record -- the whole chain above, in order, all five gates.
 *
 * Returns the record's registry fields for the caller to feed into the existing
 * qualification path, or a refusal the caller should hold the Handoff on. On a
 * refusal nothing has been written anywhere: the Handoff's own Status is the
 * caller's business (it is set to Held by the caller), and the Call Notes
 * record has not been transitioned.
 *
 * The `access` context is the pickup Work's own context. Retrieval is a read of
 * a governed source, and the `Ready -> Consumed` write resolves to the same
 * recorded Action -- this reuses the Handoff pickup Action rather than
 * introducing a second one, so no new Action, Work type, or approval gate is
 * added to the manifest by this slice.
 */
export async function retrieveAndConsumeCallNotes(
  env: Env,
  handoffId: string,
  tokens: { entityToken: string; matterToken: string },
  access: AccessContext,
  /**
   * Test seam for the direct-page Sources path, mirroring
   * `resolveHandoffSources`'s own: a contract table to resolve a
   * Sources-enabled Handoff's route against instead of the production one.
   * Production callers (salesExecutive's call-notes pickup) never pass it;
   * omitting it resolves against `HANDOFF_SOURCE_ROUTE_CONTRACTS` exactly
   * as production does. It has no effect on a legacy (Sources-absent)
   * Handoff, which resolves before any route lookup.
   */
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): Promise<CallNotesConsumption> {
  const refuse = (detail: string): CallNotesConsumption => ({
    ok: false,
    reason: `Call Notes consumption refused for Handoff ${handoffId} -- ${detail}`,
  });

  // ---- Gate 0: the Handoff's direct-page Sources property, if it has one --
  // Compatibility seam: a Handoff with no `Sources` property resolves
  // `legacy` here and gates 1-5 below run exactly as they always have (the
  // free-text Call_Notes_ID reference convention). A SOURCES-ENABLED
  // Handoff takes the canonical path instead: resolveHandoffSources has
  // fetched the exact referenced page by id and validated its real parent
  // database, the route contract, its Entity/Matter binding to this
  // Handoff's tokens, its lifecycle Status, its registry fields, and its
  // recorded approval attestation -- so the legacy reference extraction and
  // exact database lookup below are deliberately NOT re-run (that would be
  // a second mechanism over the same question, and a free-text reference is
  // never a fallback for a canonical page). Consumption here is still
  // stricter than Strategy's read-only acceptance: Ready is required,
  // because this path transitions Ready -> Consumed.
  const handoff = await getPage(env, handoffId, access);
  const sources = await resolveHandoffSources(env, {
    properties: handoff.properties,
    tokens,
    route: {
      fromUnit: plainText(handoff.properties?.["From Unit"]),
      toUnit: plainText(handoff.properties?.["To Unit"]),
    },
    access,
    ...(contracts ? { contracts } : {}),
  });
  if (!sources.ok) return refuse(sources.reason);

  if (sources.mode === "sources") {
    if (!sources.callNotes) {
      return refuse(
        `the Handoff's Sources property carries no canonical Call Notes page, and with the Sources path enabled the free-text Call_Notes_ID reference is never consulted as a fallback -- there is no governed Call Notes record this Handoff establishes.`,
      );
    }
    const located = sources.callNotes;
    if (located.status !== "Ready") {
      return refuse(
        `Call Notes record ${located.pageId} reports Status "${located.status}", not "Ready" -- only a Ready record may be consumed.`,
      );
    }
    const claim = await consumeReadyCallNotes(env, located.pageId, access);
    if (!claim.consumed) return refuse(claim.reason);
    return {
      ok: true,
      record: located.record,
      pageId: located.pageId,
      attestation: located.attestation,
      evidenceText: callNotesEvidenceText(located.record),
    };
  }

  // ---- Gate 1: the Handoff's own reference -------------------------------
  const reference = extractCallNotesReference(handoff.properties);
  if (!reference.ok) return refuse(reference.reason);

  // ---- Gate 2: what the Handoff's Entity/Matter refer to -----------------
  // Resolved before the record query so a Handoff whose own tokens are broken
  // reports that, rather than being dressed up as a missing-record problem.
  const resolved = await resolveEntityMatterFromTokens(env, tokens.entityToken, tokens.matterToken);
  if (!resolved) {
    return refuse(
      `the Handoff's Entity_Token "${tokens.entityToken || "(empty)"}" / Matter_Token "${tokens.matterToken || "(empty)"}" did not resolve to a real, related Entity/Matter record, so the Call Notes record's Entity and Matter relations cannot be verified -- without that check any record would do.`,
    );
  }

  // ---- Gate 3: exact lookup ---------------------------------------------
  if (!env.CALL_NOTES_DATA_SOURCE_ID) {
    return refuse("CALL_NOTES_DATA_SOURCE_ID is not configured, so there is no authoritative Call Notes store to read from.");
  }

  const matches = await queryDataSource(
    env,
    env.CALL_NOTES_DATA_SOURCE_ID,
    access,
    { property: "Call Notes ID", title: { equals: reference.callNotesId } },
    { pageSize: 100 },
  );

  if (matches.length === 0) {
    return refuse(`no Call Notes record has Call_Notes_ID "${reference.callNotesId}" -- an exact match is required and no other record is considered.`);
  }
  if (matches.length > 1) {
    return refuse(`${matches.length} Call Notes records carry Call_Notes_ID "${reference.callNotesId}" -- the reference does not identify exactly one record, so none is consumed.`);
  }

  const located = matches[0];

  // ---- Gate 4: Status and Entity/Matter binding --------------------------
  const status = plainText(located.properties?.Status);
  if (status !== "Ready") {
    return refuse(`Call Notes record ${located.id} reports Status "${status || "(empty)"}", not "Ready" -- only a Ready record may be consumed.`);
  }

  const entityRelations = relationIds(located.properties?.Entity);
  if (entityRelations.length !== 1 || entityRelations[0] !== resolved.entityId) {
    return refuse(
      `Call Notes record ${located.id} carries Entity relation [${entityRelations.join(", ") || "none"}] but the Handoff's Entity resolves to ${resolved.entityId} -- the record is not bound to this Work's Entity.`,
    );
  }

  const matterRelations = relationIds(located.properties?.Matter);
  if (matterRelations.length !== 1 || matterRelations[0] !== resolved.matterId) {
    return refuse(
      `Call Notes record ${located.id} carries Matter relation [${matterRelations.join(", ") || "none"}] but the Handoff's Matter resolves to ${resolved.matterId} -- the record is not bound to this Work's Matter.`,
    );
  }

  const registry = readApprovalRecord(located, tokens.entityToken, tokens.matterToken);
  if (!registry.ok) return refuse(registry.reason);

  // ---- Gate 5: the recorded approval attestation -------------------------
  const attestation = await parseRecordApprovalMarker(
    plainText(located.properties?.["Approval Attestation"]),
    registry.record,
  );
  if (!attestation.ok) return refuse(attestation.reason);

  // Only now -- reference valid, record located exactly once, binding proven,
  // attestation proven against THIS record -- is the lifecycle transition
  // attempted. Its own refusal (already Consumed, or any Status other than
  // Ready -- `Superseded` is no longer a permitted schema option but is still
  // refused rather than consumed) comes back as a refusal too, and is what
  // makes a replay a no-op.
  const claim = await consumeReadyCallNotes(env, located.id, access);
  if (!claim.consumed) return refuse(claim.reason);

  return {
    ok: true,
    record: registry.record,
    pageId: located.id,
    attestation: attestation.attestation,
    evidenceText: callNotesEvidenceText(registry.record),
  };
}

/**
 * Reads the record's `Note` rich-text property as raw text, validating its
 * shape first.
 *
 * Canonical Call Notes schema (aligned 2026-10-17): `Note` is the SOLE
 * canonical source of substantive note content. The page body is never read
 * by this slice, and there is no body fallback: a record whose `Note` is
 * missing, unreadable, or empty fails here regardless of what its page body
 * may hold.
 *
 * Every defect is a structured, non-sensitive reason that names the defect
 * and never the content: the property must be PRESENT, it must be rich text
 * (an array of rich-text items -- a number, select, or other wrong-typed
 * property is refused rather than coerced), and its extracted text must be
 * non-empty after trimming. Text extraction follows the same per-item shape
 * the repository's other rich-text readers accept (`plain_text`, falling
 * back to `text.content`), so a write-shaped item reads the same as a
 * read-shaped one; an item carrying neither contributes nothing, and a Note
 * made only of such items is refused as empty.
 */
export function readCallNotesNoteProperty(
  properties: Record<string, any> | undefined,
): { ok: true; note: string } | { ok: false; reason: string } {
  const prop = properties?.["Note"];
  if (prop === undefined || prop === null) {
    return { ok: false, reason: "carries no Note property" };
  }
  const items = (prop as { rich_text?: unknown }).rich_text;
  if (!Array.isArray(items)) {
    return { ok: false, reason: "carries a Note property that is not rich text" };
  }
  const note = items
    .map((item) => {
      const entry = item as { plain_text?: unknown; text?: { content?: unknown } } | null;
      if (typeof entry?.plain_text === "string") return entry.plain_text;
      if (typeof entry?.text?.content === "string") return entry.text.content;
      return "";
    })
    .join("");
  if (!note.trim()) {
    return { ok: false, reason: "carries an empty Note property" };
  }
  return { ok: true, note };
}
