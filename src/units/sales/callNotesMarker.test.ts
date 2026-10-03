/**
 * THE Call Notes `record_approval` marker's own tests.
 *
 * Each of these is written as the case that must NOT be consumable: a missing
 * marker, a malformed one, a result other than Approved, a reference that
 * belongs to a different record, a Version that has moved, a hash that does
 * not match. A marker being present is never the property under test -- the
 * property is that it survives every binding check against the record it was
 * read from.
 *
 * These also pin the one claim the marker deliberately does NOT make: it is
 * procedural assurance that a claim bound to this record exists, not
 * cryptographic proof that Martin approved. Nothing here can establish who
 * wrote a marker, so nothing here should ever be described as proving the
 * approval event.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarker } from "../../markerChannel";
import {
  CALL_NOTES_APPROVAL_FIELDS,
  RECORD_APPROVAL_MARKER_NAME,
  buildRecordApprovalMarker,
  canonicalCallNotesApprovalText,
  hashCallNotesApprovalRecord,
  parseRecordApprovalMarker,
  type CallNotesApprovalRecord,
} from "./callNotesMarker";

const record: CallNotesApprovalRecord = {
  callNotesId: "CN-007",
  entity: "E-47",
  matter: "M-12",
  callDate: "2026-10-01",
  callType: "Discovery",
  sourceId: "SRC-1",
  sourceType: "Sales Call",
  version: 1,
};

/** Reads a marker that is complete and correctly hashed, with only `overrides` differing from `record`. */
async function markerWith(overrides: Partial<Record<"result" | "record" | "entity" | "matter" | "version" | "fields_hash", string>>): Promise<string> {
  const fields: Record<string, string> = {
    result: "Approved",
    record: record.callNotesId,
    entity: record.entity,
    matter: record.matter,
    version: String(record.version),
    fields_hash: await hashCallNotesApprovalRecord(record),
    ...overrides,
  };
  return buildMarker(RECORD_APPROVAL_MARKER_NAME, Object.entries(fields));
}

/** Asserts the read is refused, and returns the refusal reason to be checked. */
async function refusalReason(text: string, expected: CallNotesApprovalRecord = record): Promise<string> {
  const parsed = await parseRecordApprovalMarker(text, expected);
  if (parsed.ok) {
    throw new Error(`expected the marker to be refused, but it was consumed as: ${JSON.stringify(parsed.attestation)}`);
  }
  return parsed.reason;
}

test("valid record-approval marker round trip: written by the creation authority, read back as an Approved attestation bound to this record", async () => {
  const marker = await buildRecordApprovalMarker(record, "Approved");

  const parsed = await parseRecordApprovalMarker(`Call note free text before it. ${marker} Free text after it.`, record);
  if (!parsed.ok) assert.fail(`expected to consume the marker, got: ${parsed.reason}`);

  assert.strictEqual(parsed.attestation.result, "Approved");
  assert.strictEqual(parsed.attestation.recordId, "CN-007");
  assert.strictEqual(parsed.attestation.entity, "E-47");
  assert.strictEqual(parsed.attestation.matter, "M-12");
  assert.strictEqual(parsed.attestation.version, 1);
  assert.strictEqual(parsed.attestation.fieldsHash, await hashCallNotesApprovalRecord(record));
});

test("the canonical registry fields are exactly the agreed eight, in the order the hash binds them", () => {
  assert.deepStrictEqual([...CALL_NOTES_APPROVAL_FIELDS], [
    "Call_Notes_ID",
    "Entity",
    "Matter",
    "Call Date",
    "Call Type",
    "Source ID",
    "Source Type",
    "Version",
  ]);
});

test("the canonical hash is deterministic for a record, and changes when any field it covers changes", async () => {
  assert.strictEqual(canonicalCallNotesApprovalText({ ...record }), canonicalCallNotesApprovalText(record), "the same record must always produce the same canonical text");
  assert.strictEqual(await hashCallNotesApprovalRecord({ ...record }), await hashCallNotesApprovalRecord(record));

  for (const changed of [
    { callDate: "2026-10-02" },
    { callType: "Negotiation" },
    { sourceId: "SRC-2" },
    { sourceType: "Inbound" },
  ] as Array<Partial<CallNotesApprovalRecord>>) {
    assert.notStrictEqual(
      await hashCallNotesApprovalRecord({ ...record, ...changed }),
      await hashCallNotesApprovalRecord(record),
      `${Object.keys(changed)[0]} must be covered by the hash`,
    );
  }
});

test("missing marker: no marker, no approval -- and another marker type is never read as this one", async () => {
  assert.strictEqual(
    await refusalReason("The record_approval decision is still pending for this call."),
    "no record_approval attestation marker is recorded on this Call Notes record",
    "the words alone, with no marker, must not be evidence",
  );
  assert.strictEqual(
    await refusalReason("Sanitized call summary containing no attestation whatsoever."),
    "no record_approval attestation marker is recorded on this Call Notes record",
    "absence of an approval claim is never read as approval",
  );
  assert.strictEqual(
    await refusalReason(buildMarker("source_boundary_check", [["result", "Passed"], ["entity", "E-47"], ["matter", "M-12"]])),
    "no record_approval attestation marker is recorded on this Call Notes record",
    "a Handoff's source-boundary marker is not a Call Notes approval",
  );
  assert.strictEqual(
    await refusalReason("[record_approval]"),
    "no record_approval attestation marker is recorded on this Call Notes record",
    "a bracket group carrying no fields is refused as absent, never read as present",
  );
});

test("malformed marker: a marker that cannot be fully read is refused -- presence alone is never approval", async () => {
  // Only the result. The bracket group exists and says Approved; that is still
  // not an attestation, because nothing binds it or hashes the record.
  const resultOnly = buildMarker(RECORD_APPROVAL_MARKER_NAME, [["result", "Approved"]]);
  const resultOnlyReason = await refusalReason(resultOnly);
  assert.match(resultOnlyReason, /malformed: field\(s\) missing or empty/);
  assert.match(resultOnlyReason, /record, entity, matter, version, fields_hash/);

  // Present but empty.
  const emptyResult = buildMarker(RECORD_APPROVAL_MARKER_NAME, [
    ["result", ""],
    ["record", "CN-007"],
    ["entity", "E-47"],
    ["matter", "M-12"],
    ["version", "1"],
    ["fields_hash", await hashCallNotesApprovalRecord(record)],
  ]);
  assert.match(await refusalReason(emptyResult), /malformed: field\(s\) missing or empty: result/);

  // A repeated key must be refused rather than resolved last-wins.
  const duplicated = buildMarker(RECORD_APPROVAL_MARKER_NAME, [
    ["result", "Rejected"],
    ["result", "Approved"],
    ["record", "CN-007"],
    ["entity", "E-47"],
    ["matter", "M-12"],
    ["version", "1"],
    ["fields_hash", await hashCallNotesApprovalRecord(record)],
  ]);
  assert.match(await refusalReason(duplicated), /malformed: field\(s\) recorded more than once: result/);

  // A hash that is not a SHA-256 is malformed, not merely a mismatch.
  assert.match(await refusalReason(await markerWith({ fields_hash: "not-a-sha" })), /fields_hash is malformed/);
  assert.match(await refusalReason(await markerWith({ fields_hash: "ABCD" })), /fields_hash is malformed/);
});

test("result other than Approved: a Rejected or unrecognized result is refused before any binding is read", async () => {
  assert.strictEqual(await refusalReason(await markerWith({ result: "Rejected" })), "the recorded record_approval result is Rejected");
  assert.match(await refusalReason(await markerWith({ result: "Pending" })), /result is missing or malformed/);
  assert.match(await refusalReason(await markerWith({ result: "passed" })), /result is missing or malformed/);
});

test("record mismatch: an attestation bound to a different Call Notes record is refused", async () => {
  assert.strictEqual(
    await refusalReason(await markerWith({ record: "CN-888" })),
    "the recorded record_approval attestation is not bound to this record's Call_Notes_ID",
  );
});

test("entity mismatch: an attestation bound to a different Entity reference is refused", async () => {
  assert.strictEqual(
    await refusalReason(await markerWith({ entity: "E-99" })),
    "the recorded record_approval attestation is not bound to this record's Entity reference",
  );
});

test("matter mismatch: an attestation bound to a different Matter reference is refused", async () => {
  assert.strictEqual(
    await refusalReason(await markerWith({ matter: "M-99" })),
    "the recorded record_approval attestation is not bound to this record's Matter reference",
  );
});

test("version mismatch: an attestation computed for another Version is refused, and a non-integer version is malformed", async () => {
  assert.strictEqual(
    await refusalReason(await markerWith({ version: "7" })),
    "the recorded record_approval attestation is not bound to this record's Version",
  );
  assert.match(await refusalReason(await markerWith({ version: "abc" })), /version field is malformed/);
  assert.match(await refusalReason(await markerWith({ version: "1.0" })), /version field is malformed/);
});

test("fields_hash mismatch: a tampered hash, and a registry field that moved after attestation, are both refused", async () => {
  const marker = await buildRecordApprovalMarker(record, "Approved");

  const tampered = marker.replace(/fields_hash=[0-9a-f]{64}/, `fields_hash=${await hashCallNotesApprovalRecord({ ...record, callNotesId: "CN-999" })}`);
  assert.notStrictEqual(tampered, marker, "the marker must actually have been tampered with for this to prove anything");
  assert.match(await refusalReason(tampered), /fields_hash does not match this record's registry fields/);

  // The four fields the marker does not spell out are bound by the hash alone.
  for (const drifted of [
    { callDate: "2026-10-05" },
    { callType: "Negotiation" },
    { sourceId: "SRC-9" },
    { sourceType: "Inbound" },
  ] as Array<Partial<CallNotesApprovalRecord>>) {
    assert.match(
      await refusalReason(marker, { ...record, ...drifted }),
      /fields_hash does not match this record's registry fields/,
      `${Object.keys(drifted)[0]} changed after attestation -- the hash must catch it`,
    );
  }
});

test("successful binding: the attestation holds for this record and fails for every one of the eight fields it covers", async () => {
  const marker = await buildRecordApprovalMarker(record, "Approved");

  const parsed = await parseRecordApprovalMarker(marker, record);
  assert.strictEqual(parsed.ok, true, "the unmodified record must consume its own attestation");

  const changed: Array<[string, CallNotesApprovalRecord]> = [
    ["Call_Notes_ID", { ...record, callNotesId: "CN-008" }],
    ["Entity", { ...record, entity: "E-48" }],
    ["Matter", { ...record, matter: "M-13" }],
    ["Call Date", { ...record, callDate: "2026-11-11" }],
    ["Call Type", { ...record, callType: "Negotiation" }],
    ["Source ID", { ...record, sourceId: "SRC-77" }],
    ["Source Type", { ...record, sourceType: "Inbound" }],
    ["Version", { ...record, version: 2 }],
  ];
  for (const [field, variant] of changed) {
    assert.strictEqual(
      (await parseRecordApprovalMarker(marker, variant)).ok,
      false,
      `${field} differs from the record the attestation was computed for -- it must fail closed`,
    );
  }

  // Binding values are normalized identically on both sides, so surrounding
  // whitespace cannot manufacture a mismatch -- or a match on a different record.
  assert.strictEqual((await parseRecordApprovalMarker(marker, { ...record, entity: " E-47 " })).ok, true);
  assert.strictEqual((await parseRecordApprovalMarker(marker, { ...record, entity: "E-47 " })).ok, true);
  assert.strictEqual((await parseRecordApprovalMarker(marker, { ...record, callNotesId: "CN-007 ", callDate: "2026-10-01 " })).ok, true);
});

test("a record with no id, Entity, or Matter has nothing to bind against -- refused rather than checked", async () => {
  const marker = await buildRecordApprovalMarker(record, "Approved");

  for (const broken of [
    { ...record, callNotesId: "" },
    { ...record, entity: "   " },
    { ...record, matter: "" },
    { ...record, version: Number.NaN },
  ] as CallNotesApprovalRecord[]) {
    const parsed = await parseRecordApprovalMarker(marker, broken);
    assert.strictEqual(parsed.ok, false, "a record with no binding reference must not be checked as though it had one");
    if (parsed.ok) continue;
    assert.match(parsed.reason, /cannot check a record_approval attestation against this Call Notes record/);
  }

  await assert.rejects(() => buildRecordApprovalMarker({ ...record, entity: "" }, "Approved"), /cannot build a record_approval marker/);
  await assert.rejects(() => buildRecordApprovalMarker({ ...record, version: 1.5 }, "Approved"), /cannot build a record_approval marker/);
});
