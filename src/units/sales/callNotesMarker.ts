/**
 * The Call Notes `record_approval` marker -- the recorded approval
 * attestation of a Call Notes record, and one of the two marker types on the
 * shared durable marker channel (`src/markerChannel.ts`).
 *
 * **What it is.** A bracket group written atomically with the Call Notes
 * record it describes, carrying the approval result, the record's own binding
 * references (its `Call_Notes_ID`, Entity reference, Matter reference,
 * Version), and `fields_hash` -- a SHA-256 over the canonical text of the
 * agreed registry fields. The hash is what extends the binding beyond the
 * four references the marker spells out: change `Call Date`, `Call Type`,
 * `Source ID`, or `Source Type` after the attestation was written and the
 * hash no longer matches, so the record fails closed.
 *
 * **What it is not.** It is **procedural assurance, not cryptographic proof
 * of Martin's approval event.** Nothing in this channel proves that a human
 * approved: there is no signature, no key, no nonce, and no attestation of
 * who wrote the marker. What the marker proves is only that *a claim bound to
 * exactly this record exists in the agreed shape* -- which is the property a
 * later reader needs in order to refuse an unattested record. Never describe
 * a `record_approval` marker as proof that approval happened, and never
 * weaken a Runtime check on the strength of a marker's mere presence.
 *
 * **Who writes it, who reads it.** Isolated Sales is the Call Notes creation
 * authority and writes the marker outside this Worker. Runtime Sales only
 * retrieves and consumes Call Notes; it never creates one and never gains an
 * identity-resolution capability from doing so. `buildRecordApprovalMarker`
 * exists so the format has exactly one definition (and so it can be round
 * tripped in tests) -- Runtime consumption paths must call
 * `parseRecordApprovalMarker` only. A Runtime-side build would be the
 * creation authority inventing its own approval, which is the one thing this
 * attestation exists to prevent.
 *
 * Every read is fail-closed: missing marker, malformed marker, a result other
 * than `Approved`, a reference that does not match the record it was read
 * from, a Version that does not match, or a `fields_hash` that does not match
 * the canonical hash of this record's registry fields all return
 * `{ ok: false }` with a non-sensitive reason. Marker presence alone is never
 * read as approval.
 */

import { buildMarker, markerDuplicateKeys, markerFieldEntries, markerPattern, type MarkerEvidence } from "../../markerChannel";
import { hashContent } from "./tokenSafeProposal";

/** The marker type name within the shared channel. */
export const RECORD_APPROVAL_MARKER_NAME = "record_approval";

/** The recorded approval result. Only `Approved` is ever consumable. */
export type RecordApprovalResult = "Approved" | "Rejected";

/**
 * The Call Notes registry fields the approval attestation binds, in the fixed
 * order the canonical hash uses. Field names are the contract's own
 * (`Call_Notes_ID`, `Call Date`, ...) and are part of the hashed value:
 * renaming one changes every hash, which is deliberate rather than a detail to
 * paper over.
 */
export const CALL_NOTES_APPROVAL_FIELDS = [
  "Call_Notes_ID",
  "Entity",
  "Matter",
  "Call Date",
  "Call Type",
  "Source ID",
  "Source Type",
  "Version",
] as const;

export type CallNotesApprovalField = (typeof CALL_NOTES_APPROVAL_FIELDS)[number];

/**
 * The registry fields an approval is bound to, as the reader supplies them
 * from the record itself.
 *
 * `entity` and `matter` are deliberately opaque strings: this module does not
 * decide whether an Entity/Matter reference is an `Entity_Token` or a Notion
 * relation id. Whatever representation the writer hashed and the reader
 * supplies must be the same one, or `fields_hash` fails closed. Resolving
 * which representation Call Notes uses is an open contract question, not
 * something this module settles.
 */
export interface CallNotesApprovalRecord {
  /** `Call_Notes_ID` -- the record's own id, and the primary binding. */
  callNotesId: string;
  /** `Entity` -- the operational Entity reference this record binds to. */
  entity: string;
  /** `Matter` -- the operational Matter reference this record binds to. */
  matter: string;
  /** `Call Date`. */
  callDate: string;
  /** `Call Type`. */
  callType: string;
  /** `Source ID`. */
  sourceId: string;
  /** `Source Type`. */
  sourceType: string;
  /** `Version`. */
  version: number;
}

/** What a successful read establishes -- the binding and the hash that were checked. */
export interface RecordApprovalAttestation {
  result: RecordApprovalResult;
  recordId: string;
  entity: string;
  matter: string;
  version: number;
  fieldsHash: string;
}

/**
 * The record-level preconditions both the builder and the reader apply.
 *
 * Returns a non-sensitive reason the record cannot carry a meaningful
 * attestation, or `null`. The builder refuses rather than writing a marker
 * the reader could only ever reject; the reader refuses rather than checking a
 * record whose own references are absent, which is the difference between "not
 * approved" and "nothing to approve against".
 */
function approvalRecordProblem(record: CallNotesApprovalRecord): string | null {
  if (!record.callNotesId.trim()) return "the record carries no Call_Notes_ID";
  if (!record.entity.trim()) return "the record carries no Entity reference";
  if (!record.matter.trim()) return "the record carries no Matter reference";
  if (!Number.isInteger(record.version) || record.version < 0) return `the record's Version (${String(record.version)}) is not a non-negative integer`;
  return null;
}

/**
 * The canonical, deterministic text of the registry fields this approval binds.
 *
 * Fixed field order, `trim()` normalization on every string field, and a JSON
 * array of `[name, value]` pairs rather than a hand-joined `name=value` line.
 * JSON escaping is what keeps the representation unambiguous: a value
 * containing a newline or an `=` cannot be read back as two fields, so two
 * different records cannot hash the same canonical text. Both writer and
 * reader run this exact function -- there is no second serialization to drift.
 */
export function canonicalCallNotesApprovalText(record: CallNotesApprovalRecord): string {
  const values: Record<CallNotesApprovalField, string> = {
    Call_Notes_ID: record.callNotesId.trim(),
    Entity: record.entity.trim(),
    Matter: record.matter.trim(),
    "Call Date": record.callDate.trim(),
    "Call Type": record.callType.trim(),
    "Source ID": record.sourceId.trim(),
    "Source Type": record.sourceType.trim(),
    Version: String(record.version),
  };
  return JSON.stringify(CALL_NOTES_APPROVAL_FIELDS.map((field) => [field, values[field]]));
}

/**
 * The `fields_hash` of a Call Notes record, via `hashContent` (`src/units/sales/tokenSafeProposal.ts`)
 * -- the repository's one SHA-256 primitive for content binding. No second
 * hashing implementation exists here by design.
 */
export async function hashCallNotesApprovalRecord(record: CallNotesApprovalRecord): Promise<string> {
  return hashContent(canonicalCallNotesApprovalText(record));
}

/**
 * Builds the `record_approval` marker for an approved Call Notes record.
 *
 * **Runtime consumption paths must not call this.** Isolated Sales is the
 * Call Notes creation authority; a Runtime-side build would manufacture the
 * approval this attestation is meant to evidence. It exists for the creation
 * authority's one canonical format definition and for round-trip tests.
 *
 * The marker is meant to be written inside the same create payload as the
 * record itself, so it exists on exactly the record it was computed for.
 */
export async function buildRecordApprovalMarker(record: CallNotesApprovalRecord, result: RecordApprovalResult): Promise<string> {
  const problem = approvalRecordProblem(record);
  if (problem) {
    throw new Error(`cannot build a record_approval marker: ${problem} -- refusing to write an attestation that could never be validated when read back.`);
  }
  const fieldsHash = await hashCallNotesApprovalRecord(record);
  return buildMarker(RECORD_APPROVAL_MARKER_NAME, [
    ["result", result],
    ["record", record.callNotesId.trim()],
    ["entity", record.entity.trim()],
    ["matter", record.matter.trim()],
    ["version", String(record.version)],
    ["fields_hash", fieldsHash],
  ]);
}

/** Every field a `record_approval` marker must carry to be readable at all. */
const REQUIRED_APPROVAL_FIELDS = ["result", "record", "entity", "matter", "version", "fields_hash"] as const;

/**
 * Reads and validates the durable approval attestation recorded on a Call
 * Notes record.
 *
 * This is CONSUMPTION of recorded evidence: it re-runs no approval flow,
 * asks no provider, and resolves no identity. `expected` is the Call Notes
 * record the marker was read from, with its registry fields as the reader
 * found them -- which is what binds the attestation to this record and no
 * other.
 *
 * Async only because `fields_hash` must be recomputed; everything else is the
 * same kind of check `parseSourceBoundaryMarker` performs for Handoffs.
 */
export async function parseRecordApprovalMarker(
  text: string,
  expected: CallNotesApprovalRecord,
): Promise<MarkerEvidence<RecordApprovalAttestation>> {
  const problem = approvalRecordProblem(expected);
  if (problem) {
    return { ok: false, reason: `cannot check a record_approval attestation against this Call Notes record -- ${problem}` };
  }

  const match = markerPattern(RECORD_APPROVAL_MARKER_NAME).exec(text ?? "");
  if (!match) {
    return { ok: false, reason: "no record_approval attestation marker is recorded on this Call Notes record" };
  }

  const entries = markerFieldEntries(match[1]);
  const duplicates = markerDuplicateKeys(entries);
  if (duplicates.length > 0) {
    return { ok: false, reason: `the recorded record_approval marker is malformed: field(s) recorded more than once: ${duplicates.join(", ")}` };
  }

  const fields = new Map(entries);
  const missing = REQUIRED_APPROVAL_FIELDS.filter((key) => !fields.get(key));
  if (missing.length > 0) {
    return { ok: false, reason: `the recorded record_approval marker is malformed: field(s) missing or empty: ${missing.join(", ")}` };
  }

  // Result before binding: a record that was never approved is refused on
  // that ground alone, and its binding is not read as anything.
  const result = fields.get("result");
  if (result !== "Approved" && result !== "Rejected") {
    return { ok: false, reason: "the recorded record_approval result is missing or malformed" };
  }
  if (result !== "Approved") {
    return { ok: false, reason: "the recorded record_approval result is Rejected" };
  }

  const record = fields.get("record")!;
  const entity = fields.get("entity")!;
  const matter = fields.get("matter")!;
  if (record !== expected.callNotesId.trim()) {
    return { ok: false, reason: "the recorded record_approval attestation is not bound to this record's Call_Notes_ID" };
  }
  if (entity !== expected.entity.trim()) {
    return { ok: false, reason: "the recorded record_approval attestation is not bound to this record's Entity reference" };
  }
  if (matter !== expected.matter.trim()) {
    return { ok: false, reason: "the recorded record_approval attestation is not bound to this record's Matter reference" };
  }

  const versionText = fields.get("version")!;
  if (!/^\d+$/.test(versionText)) {
    return { ok: false, reason: "the recorded record_approval marker's version field is malformed" };
  }
  if (Number(versionText) !== expected.version) {
    return { ok: false, reason: "the recorded record_approval attestation is not bound to this record's Version" };
  }

  const recordedHash = fields.get("fields_hash")!;
  if (!/^[0-9a-f]{64}$/.test(recordedHash)) {
    return { ok: false, reason: "the recorded record_approval marker's fields_hash is malformed" };
  }
  const canonicalHash = await hashCallNotesApprovalRecord(expected);
  if (recordedHash !== canonicalHash) {
    return { ok: false, reason: "the recorded record_approval marker's fields_hash does not match this record's registry fields" };
  }

  return {
    ok: true,
    attestation: {
      result: "Approved",
      recordId: record,
      entity,
      matter,
      version: Number(versionText),
      fieldsHash: recordedHash,
    },
  };
}
