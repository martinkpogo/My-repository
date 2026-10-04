import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMERCIAL_VALUE_EVIDENCE_START,
  COMMERCIAL_VALUE_EVIDENCE_END,
  serializeCommercialValueEvidenceBlock,
  parseCommercialValueEvidenceBlock,
  stripCommercialValueEvidenceBlock,
} from "./commercialValueEvidence";
import { extractLabeledBlock } from "../../labeledBlock";
import type { CommercialEvidence } from "../../types";

const EVIDENCE: CommercialEvidence = {
  financialConsequence: "Late deliveries erode the wholesale channel.",
  valueAtStake: {
    low: 8000000,
    high: 12000000,
    currency: "GHS",
    period: "annual",
    evidenceType: "client_estimated",
    source: "Client-stated on call",
    assumptions: "Assumes the current churn rate holds.",
  },
  costOfInaction: { value: 2500000, currency: "GHS", period: "annual", evidenceType: "derived", source: "Derived from stated churn cost" },
  affectedRevenueOrOpportunity: "Wholesale fulfilment contract renewal",
  desiredMeasurableOutcome: "Qualified opportunity progression rate",
  uncertainty: "Seasonality not yet separated from the trend.",
};

test("serialize: deterministic -- same record, byte-identical output, fixed key order (never Object.keys order over AI input)", () => {
  const record = { determination: "Satisfied" as const, evidenceText: "GHS 8000000-12000000 over annual, evidence type: client_estimated, source: Client-stated on call.", evidence: EVIDENCE };
  const first = serializeCommercialValueEvidenceBlock(record);
  const second = serializeCommercialValueEvidenceBlock(record);
  assert.strictEqual(first, second, "serialization must be reproducible byte for byte");
  assert.ok(first.startsWith(`${COMMERCIAL_VALUE_EVIDENCE_START}\n`));
  assert.ok(first.endsWith(`\n${COMMERCIAL_VALUE_EVIDENCE_END}`));

  const payload = JSON.parse(extractLabeledBlock(first, COMMERCIAL_VALUE_EVIDENCE_START, COMMERCIAL_VALUE_EVIDENCE_END)!);
  assert.deepStrictEqual(
    Object.keys(payload),
    ["determination", "evidenceText", "evidence"],
    "the top-level key order must come from the serializer's own literal, not from input ordering",
  );
  assert.deepStrictEqual(
    Object.keys(payload.evidence),
    ["financialConsequence", "valueAtStake", "costOfInaction", "affectedRevenueOrOpportunity", "desiredMeasurableOutcome", "uncertainty"],
    "evidence keys must follow the serializer's fixed projection order",
  );
});

test("parse: round-trips the serialized record exactly -- no rewording, no re-derivation, original bytes preserved in `block`", () => {
  const record = { determination: "Satisfied" as const, evidenceText: "GHS 8000000-12000000 over annual, evidence type: client_estimated, source: Client-stated on call.", evidence: EVIDENCE };
  const block = serializeCommercialValueEvidenceBlock(record);
  const parsed = parseCommercialValueEvidenceBlock(`Narrative first.\n\n${block}\n\nTrailing context.`);
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.block, block, "the carried block must be the sender's bytes, not a re-serialization");
  assert.deepStrictEqual(parsed.record, record);
});

test("parse: an absent or partially-present block fails closed with a reason -- never a partial guess", () => {
  const absent = parseCommercialValueEvidenceBlock("Just narrative, no structured block.");
  assert.strictEqual(absent.ok, false);
  assert.match(absent.ok === false ? absent.reason : "", /absent/);

  const startOnly = parseCommercialValueEvidenceBlock(`${COMMERCIAL_VALUE_EVIDENCE_START}\n{"determination":"Satisfied"}`);
  assert.strictEqual(startOnly.ok, false, "a start marker without its end marker is not a block");

  const endOnly = parseCommercialValueEvidenceBlock(`{"determination":"Satisfied"}\n${COMMERCIAL_VALUE_EVIDENCE_END}`);
  assert.strictEqual(endOnly.ok, false);

  const empty = parseCommercialValueEvidenceBlock("");
  assert.strictEqual(empty.ok, false);
});

test("parse: malformed content fails closed and names what could not be parsed deterministically", () => {
  const wrap = (inner: string) => `${COMMERCIAL_VALUE_EVIDENCE_START}\n${inner}\n${COMMERCIAL_VALUE_EVIDENCE_END}`;

  const notJson = parseCommercialValueEvidenceBlock(wrap("determination: Satisfied"));
  assert.strictEqual(notJson.ok, false);
  assert.match(notJson.ok === false ? notJson.reason : "", /not valid JSON/);

  const notObject = parseCommercialValueEvidenceBlock(wrap("[1,2,3]"));
  assert.strictEqual(notObject.ok, false);

  const unknownDetermination = parseCommercialValueEvidenceBlock(wrap(JSON.stringify({ determination: "probably fine", evidenceText: "x", evidence: null })));
  assert.strictEqual(unknownDetermination.ok, false);
  assert.match(unknownDetermination.ok === false ? unknownDetermination.reason : "", /determination/);

  const missingText = parseCommercialValueEvidenceBlock(wrap(JSON.stringify({ determination: "Satisfied", evidence: null })));
  assert.strictEqual(missingText.ok, false);
  assert.match(missingText.ok === false ? missingText.reason : "", /evidenceText/);

  const wrongType = parseCommercialValueEvidenceBlock(
    wrap(JSON.stringify({ determination: "Satisfied", evidenceText: "ok", evidence: { valueAtStake: { low: "8000000" } } })),
  );
  assert.strictEqual(wrongType.ok, false);
  assert.match(wrongType.ok === false ? wrongType.reason : "", /evidence\.valueAtStake\.low is not a finite number/);

  const unknownKey = parseCommercialValueEvidenceBlock(
    wrap(JSON.stringify({ determination: "Satisfied", evidenceText: "ok", evidence: null, pricingHint: "just use the budget" })),
  );
  assert.strictEqual(unknownKey.ok, false, "an unrecognised field must not ride through into a typed record");
  assert.match(unknownKey.ok === false ? unknownKey.reason : "", /pricingHint/);
});

test("parse: `Insufficient Evidence` is a perfectly valid, provenance-complete result -- parsing never judges the determination", () => {
  const block = serializeCommercialValueEvidenceBlock({
    determination: "Insufficient Evidence",
    evidenceText: "No numerical value connected to the business problem or opportunity has been established.",
    evidence: null,
  });
  const parsed = parseCommercialValueEvidenceBlock(block);
  assert.ok(parsed.ok, "an insufficient determination must still parse -- provenance and sufficiency are different questions");
  assert.strictEqual(parsed.record.determination, "Insufficient Evidence");
  assert.strictEqual(parsed.record.evidence, null);
});

test("strip: removes only the labelled block, and leaves a malformed marker pair untouched", () => {
  const block = serializeCommercialValueEvidenceBlock({ determination: "Satisfied", evidenceText: "x", evidence: null });
  const text = `Narrative.\n\n${block}\n\nMore narrative.`;
  const stripped = stripCommercialValueEvidenceBlock(text);
  assert.strictEqual(stripped, "Narrative.\n\n\n\nMore narrative.");
  assert.ok(!stripped.includes(COMMERCIAL_VALUE_EVIDENCE_START));
  assert.ok(stripped.includes("Narrative.") && stripped.includes("More narrative."), "narrative on both sides survives");

  const malformed = `${COMMERCIAL_VALUE_EVIDENCE_START}\n{"determination":"Satisfied"}`;
  assert.strictEqual(stripCommercialValueEvidenceBlock(malformed), malformed, "no end marker means nothing is deleted");
  assert.strictEqual(stripCommercialValueEvidenceBlock("plain narrative"), "plain narrative");
});
