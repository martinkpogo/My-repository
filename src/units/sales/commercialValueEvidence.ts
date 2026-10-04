import { extractLabeledBlock } from "../../labeledBlock";
import type { CommercialEvidence, QualificationAssessment, ValueAtStake } from "../../types";

/**
 * The labelled structured block Sales writes into the Sales -> Strategy
 * Handoff's "Verified Facts & Sources" so Strategy (and, verbatim, Finance)
 * can consume the upstream commercial-value determination without
 * re-deriving, re-wording, or re-estimating it.
 *
 * Authority model: Sales's deterministic `evaluateCommercialValueEvidence`
 * is the ONLY thing that produces `determination`/`evidenceText` -- this
 * module only serialises and parses them. Finance remains the sole
 * authority on whether that determination is sufficient to price
 * (validateFinanceJudgement, unchanged), and Strategy never authorises a
 * number of its own. The block is therefore transport and provenance, not a
 * second evidence model: it carries exactly the existing
 * `state.commercialEvidence` plus the existing evaluator's determination.
 *
 * Grammar: same labelled-block grammar as STRATEGY BOUNDARY REPRESENTATION
 * (start marker, deterministic JSON, end marker), extracted with the shared
 * extractLabeledBlock primitive.
 */
export const COMMERCIAL_VALUE_EVIDENCE_START = "=== COMMERCIAL VALUE EVIDENCE ===";
/** Closes the Commercial Value Evidence block -- see COMMERCIAL_VALUE_EVIDENCE_START. */
export const COMMERCIAL_VALUE_EVIDENCE_END = "=== END COMMERCIAL VALUE EVIDENCE ===";

/** Exactly the two-value shape `evaluateCommercialValueEvidence` produces for this condition (`QualificationAssessment` is its declared return type). */
export type CommercialValueDetermination = QualificationAssessment;

export interface CommercialValueEvidenceRecord {
  /** The upstream Sales determination, verbatim -- never re-computed by any consumer. */
  determination: CommercialValueDetermination;
  /** The upstream evaluator's own reason, verbatim -- this is what names the specific missing fact on a hold. */
  evidenceText: string;
  /** `state.commercialEvidence` as captured at qualification time, or null when nothing was captured. */
  evidence: CommercialEvidence | null;
}

const DETERMINATIONS: CommercialValueDetermination[] = ["Satisfied", "Not Satisfied", "Insufficient Evidence"];
const EVIDENCE_TYPES: string[] = ["directly_measured", "client_estimated", "derived", "assumption"];

/** Fixed projection of a figure, in a fixed key order -- JSON.stringify drops the undefined members, so two runs over the same evidence produce byte-identical output. */
function projectFigure(v: ValueAtStake | undefined): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  return {
    value: v.value,
    low: v.low,
    high: v.high,
    currency: v.currency,
    period: v.period,
    evidenceType: v.evidenceType,
    source: v.source,
    evidenceQuality: v.evidenceQuality,
    assumptions: v.assumptions,
    limitations: v.limitations,
  };
}

/**
 * Deterministic serialization: a fixed key order taken from the object
 * literals here (never Object.keys order over AI-produced input), wrapped in
 * the explicit markers above. A consumer locates, parses, and -- when
 * carrying it downstream -- copies this block byte-for-byte.
 */
export function serializeCommercialValueEvidenceBlock(record: CommercialValueEvidenceRecord): string {
  const evidence = record.evidence ?? null;
  const payload = {
    determination: record.determination,
    evidenceText: record.evidenceText,
    evidence:
      evidence === null
        ? null
        : {
            financialConsequence: evidence.financialConsequence,
            valueAtStake: projectFigure(evidence.valueAtStake),
            costOfInaction: projectFigure(evidence.costOfInaction),
            affectedRevenueOrOpportunity: evidence.affectedRevenueOrOpportunity,
            desiredMeasurableOutcome: evidence.desiredMeasurableOutcome,
            uncertainty: evidence.uncertainty,
          },
  };
  return `${COMMERCIAL_VALUE_EVIDENCE_START}\n${JSON.stringify(payload)}\n${COMMERCIAL_VALUE_EVIDENCE_END}`;
}

/**
 * Removes the labelled structured block from a text, leaving everything
 * else (including a malformed/partial marker pair) untouched.
 *
 * Needed wherever the question is "is there a human-written BUSINESS
 * SITUATION here?" -- a structured provenance block is a record of a
 * determination, not a narrative, so it must never be mistaken for one (or
 * handed to a diagnosis as if it were the situation it is about). Removal
 * is marker-based and structural: nothing outside the marker pair is
 * inspected, judged, or rewritten.
 */
export function stripCommercialValueEvidenceBlock(text: string): string {
  const startIdx = text.indexOf(COMMERCIAL_VALUE_EVIDENCE_START);
  if (startIdx === -1) return text;
  const contentStart = startIdx + COMMERCIAL_VALUE_EVIDENCE_START.length;
  const endIdx = text.indexOf(COMMERCIAL_VALUE_EVIDENCE_END, contentStart);
  // No matching end marker: leave the text exactly as it is -- a malformed
  // block is a provenance failure for whoever parses it, never licence to
  // silently delete the rest of the field.
  if (endIdx === -1) return text;
  const before = text.slice(0, startIdx);
  const after = text.slice(endIdx + COMMERCIAL_VALUE_EVIDENCE_END.length);
  return `${before}${after}`;
}

export type CommercialValueEvidenceParse =
  | { ok: true; block: string; record: CommercialValueEvidenceRecord }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FIGURE_STRING_FIELDS = ["currency", "period", "source", "evidenceQuality", "assumptions", "limitations"] as const;
const FIGURE_NUMBER_FIELDS = ["value", "low", "high"] as const;
const FIGURE_FIELDS: string[] = [...FIGURE_NUMBER_FIELDS, ...FIGURE_STRING_FIELDS, "evidenceType"];

function parseFigure(raw: unknown, path: string, problems: string[]): ValueAtStake | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    problems.push(`${path} is not an object`);
    return undefined;
  }
  const out: { -readonly [K in keyof ValueAtStake]?: ValueAtStake[K] } = {};
  for (const key of Object.keys(raw)) {
    if (!FIGURE_FIELDS.includes(key)) problems.push(`${path}.${key} is not a known value-at-stake field`);
  }
  for (const key of FIGURE_NUMBER_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${path}.${key} is not a finite number`);
      continue;
    }
    out[key] = value;
  }
  for (const key of FIGURE_STRING_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      problems.push(`${path}.${key} is not a string`);
      continue;
    }
    out[key] = value;
  }
  const evidenceType = raw.evidenceType;
  if (evidenceType !== undefined && evidenceType !== null) {
    if (typeof evidenceType !== "string" || !EVIDENCE_TYPES.includes(evidenceType)) {
      problems.push(`${path}.evidenceType is not a known evidence type`);
    } else {
      out.evidenceType = evidenceType as ValueAtStake["evidenceType"];
    }
  }
  return out;
}

const EVIDENCE_STRING_FIELDS = ["financialConsequence", "affectedRevenueOrOpportunity", "desiredMeasurableOutcome", "uncertainty"] as const;
const EVIDENCE_FIELDS: string[] = [...EVIDENCE_STRING_FIELDS, "valueAtStake", "costOfInaction"];

function parseEvidence(raw: unknown, problems: string[]): CommercialEvidence | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    problems.push("evidence is not an object");
    return null;
  }
  const out: { -readonly [K in keyof CommercialEvidence]?: CommercialEvidence[K] } = {};
  for (const key of Object.keys(raw)) {
    if (!EVIDENCE_FIELDS.includes(key)) problems.push(`evidence.${key} is not a known commercial-evidence field`);
  }
  for (const key of EVIDENCE_STRING_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      problems.push(`evidence.${key} is not a string`);
      continue;
    }
    out[key] = value;
  }
  out.valueAtStake = parseFigure(raw.valueAtStake, "evidence.valueAtStake", problems);
  out.costOfInaction = parseFigure(raw.costOfInaction, "evidence.costOfInaction", problems);
  return out;
}

/**
 * Structurally parses the Commercial Value Evidence block out of a larger
 * field (a Handoff's "Verified Facts & Sources", or Strategy's combined
 * context text). Fails closed on anything that is absent or cannot be parsed
 * deterministically: absent markers, non-JSON inner content, a non-object
 * payload, an unknown determination, or a field of the wrong type. Nothing is
 * defaulted, inferred, or re-derived -- a consumer that gets `{ ok: false }`
 * has provenance it cannot rely on and must not paper over.
 *
 * `block` is the ORIGINAL inner content re-wrapped in the marker constants,
 * so a consumer copying it downstream copies the sender's bytes rather than
 * a re-serialization of them.
 */
export function parseCommercialValueEvidenceBlock(text: string): CommercialValueEvidenceParse {
  const inner = extractLabeledBlock(text, COMMERCIAL_VALUE_EVIDENCE_START, COMMERCIAL_VALUE_EVIDENCE_END);
  if (inner === null) {
    return {
      ok: false,
      reason: `the ${COMMERCIAL_VALUE_EVIDENCE_START} block is absent (start/end markers not both present, in order)`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(inner);
  } catch {
    return { ok: false, reason: `the ${COMMERCIAL_VALUE_EVIDENCE_START} block is present but its content is not valid JSON` };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, reason: `the ${COMMERCIAL_VALUE_EVIDENCE_START} block does not contain a JSON object` };
  }

  const problems: string[] = [];
  for (const key of Object.keys(payload)) {
    if (!["determination", "evidenceText", "evidence"].includes(key)) {
      problems.push(`${key} is not a known Commercial Value Evidence field`);
    }
  }

  const determination = payload.determination;
  if (typeof determination !== "string" || !DETERMINATIONS.includes(determination as CommercialValueDetermination)) {
    problems.push("determination is not a known commercial-value determination");
  }
  const evidenceText = payload.evidenceText;
  if (typeof evidenceText !== "string" || evidenceText.trim() === "") {
    problems.push("evidenceText is not a non-empty string");
  }
  const evidence = parseEvidence(payload.evidence, problems);

  if (problems.length > 0) {
    return {
      ok: false,
      reason: `the ${COMMERCIAL_VALUE_EVIDENCE_START} block cannot be parsed deterministically: ${problems.join("; ")}`,
    };
  }

  return {
    ok: true,
    block: `${COMMERCIAL_VALUE_EVIDENCE_START}\n${inner}\n${COMMERCIAL_VALUE_EVIDENCE_END}`,
    record: {
      determination: determination as CommercialValueDetermination,
      evidenceText: evidenceText as string,
      evidence,
    },
  };
}
