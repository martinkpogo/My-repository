import type { Env } from "../../types";
import { getPage, plainText, queryDataSource, relationIds, type NotionPage } from "../../notion";
import type { AccessContext } from "../../access";
import { resolveEntityMatterFromTokens } from "../../identityResolution";
import { consumeReadyCallNotes } from "./callNotesLifecycle";
import {
  parseRecordApprovalMarker,
  type CallNotesApprovalRecord,
  type RecordApprovalAttestation,
} from "./callNotesMarker";

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
 * anything other than the Status transition, retrieve or verify the Evidence
 * Package, re-run an approval flow, or mint an ApprovalProof. The attestation
 * it validates is the procedural one the creation authority recorded on the
 * record -- it is not proof that any Runtime-side approval happened, and
 * nothing here should be described as having verified evidence contents.
 */

/** The free-text fields a call-notes Handoff's own `Call_Notes_ID` reference is read from. */
const REFERENCE_FIELDS = ["Reason", "Handoff"] as const;

/**
 * The reference grammar, matching `requiredCategory:\s*call_notes`'s style of
 * "a key, a separator, a value" on the Handoff's free text.
 *
 * `[ \t]*` (not `\s*`) before the value matters: `\s` would let the pattern
 * swallow the newline after an empty reference and report the NEXT line's text
 * as the id, turning a malformed reference into a plausible one. Value capture
 * stops at the end of the line so a reference embedded in a sentence still
 * yields exactly what follows the key, and nothing before it.
 */
const CALL_NOTES_REFERENCE_PATTERN = /Call_Notes_ID[ \t]*[:=][ \t]*([^\r\n]*)/;

/** A reference is a single token; longer than this is malformed rather than an id. */
const MAX_REFERENCE_LENGTH = 200;

export type CallNotesReference =
  | { ok: true; callNotesId: string }
  | { ok: false; reason: string };

/**
 * Reads the `Call_Notes_ID` reference a call-notes Handoff carries.
 *
 * Fail-closed on every way the reference can be unusable:
 *
 *   - **missing** -- neither free-text field mentions the key at all;
 *   - **empty** -- the key is present with no value after it;
 *   - **malformed** -- the value contains whitespace (a reference is one
 *     token, so `CN-007 (see below)` is not an id) or is absurdly long;
 *   - **ambiguous** -- the two fields record two DIFFERENT ids. Repeating the
 *     same id in both is not ambiguous and is accepted.
 *
 * It never falls back to `Entity_Token`/`Matter_Token` or to anything else on
 * the Handoff: those identify WHICH Entity and Matter the work concerns, not
 * which record to read, and inferring one from the other would be inventing a
 * lookup the record itself does not establish.
 *
 * `Verified Facts & Sources` is deliberately NOT searched. It is the Handoff's
 * substantive payload field, and this slice's whole point is that its content
 * is no longer authoritative about Call Notes -- using it as the place a
 * reference is looked up would keep one foot in the path being retired.
 */
export function extractCallNotesReference(
  properties: Record<string, any>,
): CallNotesReference {
  const found: string[] = [];

  for (const field of REFERENCE_FIELDS) {
    const raw = plainText(properties?.[field]);
    if (!raw) continue;

    const match = CALL_NOTES_REFERENCE_PATTERN.exec(raw);
    if (!match) continue;

    const value = match[1].trim();
    if (!value) {
      return { ok: false, reason: `the Handoff's ${field} records Call_Notes_ID with no value -- a reference with nothing after it is refused rather than looked up by any other means.` };
    }
    if (/\s/.test(value)) {
      return { ok: false, reason: `the Handoff's ${field} records a malformed Call_Notes_ID ("${value.slice(0, MAX_REFERENCE_LENGTH)}") -- a Call Notes reference is a single whitespace-free token.` };
    }
    if (value.length > MAX_REFERENCE_LENGTH) {
      return { ok: false, reason: `the Handoff's ${field} records a Call_Notes_ID longer than ${MAX_REFERENCE_LENGTH} characters, which is malformed rather than an id.` };
    }
    found.push(value);
  }

  if (found.length === 0) {
    return {
      ok: false,
      reason: `the Handoff carries no Call_Notes_ID reference in its ${REFERENCE_FIELDS.join(" or ")} -- there is no governed Call Notes record to read, and the Handoff's own narrative is not used as one.`,
    };
  }

  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    return { ok: false, reason: `the Handoff records conflicting Call_Notes_ID references (${distinct.join(", ")}) -- which record to consume is ambiguous, so nothing is read.` };
  }

  return { ok: true, callNotesId: distinct[0] };
}

/**
 * The registry record a validation runs against, built from the located Call
 * Notes record's own properties.
 *
 * `entity`/`matter` carry the Handoff's `Entity_Token`/`Matter_Token`, which is
 * exactly what gate 4 established the record's relations ARE: the relations were
 * compared to the pages those tokens resolve to, so the tokens are this record's
 * own Entity and Matter references by that check, and they are also the
 * representation the approved marker shape (`entity=E-47 matter=M-12`) and this
 * repository's own fixtures use. The fields' representation is an open contract
 * question `callNotesMarker.ts` explicitly leaves open -- if the creation
 * authority ever hashes a different representation, `fields_hash` disagrees and
 * this fails closed rather than guessing.
 */
/**
 * Reads the record's own registry fields for validation -- exported so a
 * caller that must NOT consume the record (a read-only, idempotent consumer
 * that cannot transition Status without breaking its own retry loop) can
 * still re-verify the same attestation against exactly the same fields.
 * Exporting it changes no Sales behavior: `retrieveAndConsumeCallNotes`
 * calls it identically.
 */
export function readApprovalRecord(
  page: NotionPage,
  entityToken: string,
  matterToken: string,
): { ok: true; record: CallNotesApprovalRecord } | { ok: false; reason: string } {
  const properties = page.properties ?? {};

  const callNotesId = plainText(properties["Call Notes ID"]).trim();
  if (!callNotesId) {
    return { ok: false, reason: "the located Call Notes record carries no Call Notes ID title, so it cannot be identified." };
  }

  const version = properties.Version?.number;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    // Read straight off the number property rather than through plainText()
    // and a parse: plainText() would render a missing Version as "" and
    // Number("") is 0, which would silently present an unversioned record as
    // Version 0 instead of refusing it.
    return { ok: false, reason: "the located Call Notes record's Version property is missing or is not a non-negative integer, so no exact current Version can be bound." };
  }

  const callDate = properties["Call Date"]?.date?.start;
  return {
    ok: true,
    record: {
      callNotesId,
      entity: entityToken.trim(),
      matter: matterToken.trim(),
      callDate: typeof callDate === "string" ? callDate : "",
      callType: plainText(properties["Call Type"]),
      sourceId: plainText(properties["Source ID"]),
      sourceType: plainText(properties["Source Type"]),
      version,
    },
  };
}

/**
 * The governed record's fields as passed into the existing commercial-value
 * extraction and qualification path.
 *
 * Exactly the eight canonical registry fields -- `CALL_NOTES_APPROVAL_FIELDS`'
 * own names -- so that what reaches the model is what the governed record says
 * and nothing else. Presentation only: this text is never hashed, never written
 * back anywhere, and carries no claim about the Evidence Package (which Runtime
 * does not retrieve in this slice) and no narrative the record does not itself
 * hold.
 */
export function callNotesEvidenceText(record: CallNotesApprovalRecord): string {
  return [
    `Call_Notes_ID: ${record.callNotesId}`,
    `Entity: ${record.entity}`,
    `Matter: ${record.matter}`,
    `Call Date: ${record.callDate}`,
    `Call Type: ${record.callType}`,
    `Source ID: ${record.sourceId}`,
    `Source Type: ${record.sourceType}`,
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
): Promise<CallNotesConsumption> {
  const refuse = (detail: string): CallNotesConsumption => ({
    ok: false,
    reason: `Call Notes consumption refused for Handoff ${handoffId} -- ${detail}`,
  });

  // ---- Gate 1: the Handoff's own reference -------------------------------
  const handoff = await getPage(env, handoffId, access);
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
  // attempted. Its own refusal (already Consumed, Superseded, ...) comes back
  // as a refusal too, and is what makes a replay a no-op.
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
