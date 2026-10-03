/**
 * THE SHARED MARKER CHANNEL's own tests.
 *
 * The grammar here is what both typed readers are built on -- the Handoff
 * `source_boundary_check` marker (`src/handoffWriter.ts`) and the Call Notes
 * `record_approval` marker (`src/units/sales/callNotesMarker.ts`) -- so these
 * pin the properties both of them depend on: a named marker matches only its
 * own bracket group, field order survives a read, a value cannot smuggle a
 * second result past a reader that checks for repeated keys, and a marker
 * name that is not an identifier is refused rather than compiled.
 *
 * The typed readers' own fail-closed behaviour is tested in their own files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarker, markerDuplicateKeys, markerFieldEntries, markerPattern } from "./markerChannel";

test("build -> read round trip: a marker built from ordered fields reads back as those exact fields inside surrounding free text", () => {
  const marker = buildMarker("source_boundary_check", [
    ["result", "Passed"],
    ["entity", "E-20"],
    ["matter", "MAT-20"],
  ]);

  assert.strictEqual(marker, "[source_boundary_check result=Passed entity=E-20 matter=MAT-20]");

  const match = markerPattern("source_boundary_check").exec(`Reason text before it. ${marker} Reason text after it.`);
  assert.ok(match, "the marker must be found in free text on either side of it");
  assert.deepStrictEqual(
    markerFieldEntries(match[1]),
    [
      ["result", "Passed"],
      ["entity", "E-20"],
      ["matter", "MAT-20"],
    ],
    "field order must survive the read, and no field may be dropped or reordered",
  );
});

test("a marker name matches only its own bracket group -- the two types on this channel cannot consume each other's evidence", () => {
  const sourceBoundary = buildMarker("source_boundary_check", [["result", "Passed"], ["entity", "E-20"], ["matter", "MAT-20"]]);
  const recordApproval = buildMarker("record_approval", [["result", "Approved"], ["record", "CN-007"]]);

  assert.strictEqual(markerPattern("record_approval").exec(sourceBoundary), null, "a Handoff's marker is never a Call Notes approval");
  assert.strictEqual(markerPattern("source_boundary_check").exec(recordApproval), null, "a Call Notes approval is never a Handoff's marker");
  assert.ok(markerPattern("source_boundary_check").exec(sourceBoundary));
  assert.ok(markerPattern("record_approval").exec(recordApproval));
});

test("a repeated key is surfaced, not folded -- a plain Map would let a later `result` overwrite an earlier one", () => {
  // The grammar ends a value at whitespace, so a value carrying a space is read
  // as two fields rather than one. Nothing about the grammar can make that safe
  // on its own. What makes it safe is that a reader refuses a marker whose keys
  // repeat instead of letting the last one win.
  const injected = buildMarker("record_approval", [
    ["result", "Rejected result=Approved"],
    ["record", "CN-007"],
  ]);

  const match = markerPattern("record_approval").exec(injected);
  assert.ok(match);
  const entries = markerFieldEntries(match[1]);
  assert.deepStrictEqual(
    entries,
    [
      ["result", "Rejected"],
      ["result", "Approved"],
      ["record", "CN-007"],
    ],
    "both `result` entries must come back, in order, with neither dropped",
  );
  assert.deepStrictEqual(markerDuplicateKeys(entries), ["result"], "the repeated key must be reported by name");
  assert.strictEqual(
    new Map(entries).get("result"),
    "Approved",
    "this is the fail-open: a plain Map takes the last value, which is exactly why readers check markerDuplicateKeys first",
  );
});

test("a marker name that is not an identifier is refused, so no pattern can be built that matches unintended text", () => {
  assert.throws(() => markerPattern("source_boundary_check .*"), /is not an identifier/);
  assert.throws(() => markerPattern("record_approval]"), /is not an identifier/);
  assert.throws(() => buildMarker("record_approval [x", [["k", "v"]]), /is not an identifier/);
});

test("a value stops at whitespace or ']' -- why every binding value in this channel is a token or a hash, never prose", () => {
  const marker = buildMarker("record_approval", [
    ["record", "CN 007"],
    ["version", "1"],
  ]);

  const match = markerPattern("record_approval").exec(marker);
  assert.ok(match);
  assert.deepStrictEqual(
    markerFieldEntries(match[1]),
    [
      ["record", "CN"],
      ["version", "1"],
    ],
    "the value is truncated at its space, so a binding value containing whitespace can never round trip -- it fails closed at the reader instead of passing silently",
  );
});
