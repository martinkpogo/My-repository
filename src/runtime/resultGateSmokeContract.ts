import type { ResultReviewEvidenceItem, WorkState } from "../types";
import { hashContent } from "../contentHash";
import { RESULT_REVIEW_BLOCKED_STAGE } from "../resultReview";

/**
 * The Result Gate smoke test's OWN contract (ENIG #370, rebuilt on the current
 * gate, 16 Nov 2026): the identifiers, the test-only Action's Result contract
 * and the one synthetic artefact it produces. Dependency-light on purpose, so
 * the Business Development manifest (which registers the test Action) and the
 * harness (src/runtime/resultGateSmoke.ts) share one definition without an
 * import cycle.
 *
 * Non-circular by construction (the #370 review's finding 2): the expected
 * Result and every completion criterion are about the synthetic artefact
 * alone -- something the producing side makes and anyone can check from the
 * recorded evidence. Nothing here describes verification, a verdict, an
 * approval or closure; the harness and the read-only inspection report those
 * separately, from the Work's saved state.
 */

/** Every synthetic Work id begins with this prefix; a real Work id can never be used for the smoke. */
export const RESULT_GATE_SMOKE_WORK_ID_PREFIX = "result-gate-smoke-";

/** `result-gate-smoke-` plus a canonical UUID -- the exact shape the harness generates and the only one it accepts. */
export const RESULT_GATE_SMOKE_WORK_ID_SHAPE = /^result-gate-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a Work id belongs to the smoke harness (never a real business Work). */
export function isResultGateSmokeWorkId(workId: unknown): workId is string {
  return typeof workId === "string" && RESULT_GATE_SMOKE_WORK_ID_SHAPE.test(workId);
}

/** The ONLY origin the test Action is applicable to; no ordinary entry can ever satisfy it. */
export const RESULT_GATE_SMOKE_ORIGIN = "result_gate_smoke" as const;

/** The ONE test-only Action. */
export const RESULT_GATE_SMOKE_ACTION = "result_gate_smoke_test" as const;

/** The evidence kind of the synthetic artefact. */
export const RESULT_GATE_SMOKE_ARTEFACT_KIND = "synthetic_artefact" as const;

/** The fixed, clearly marked payload of the synthetic artefact. */
export const RESULT_GATE_SMOKE_PAYLOAD = "ENIG Result Gate smoke test -- synthetic artefact. This text is a fixed test payload. It is not a business output and refers to no client, Entity, Matter, Lead, Proposal or Handoff.";

export const RESULT_GATE_SMOKE_EXPECTED_RESULT =
  "One synthetic test artefact for this Work: the fixed, clearly marked smoke-test payload, recorded with its SHA-256 so it can be checked from the evidence alone.";

export const RESULT_GATE_SMOKE_CRITERIA = [
  "Exactly one synthetic artefact is recorded for this Work.",
  "The artefact's recorded SHA-256 matches its payload.",
  "The artefact names this Work and declares itself synthetic, with no business outcome and no client identity.",
] as const;

/** The artefact's evidence content: the Work, the payload and its SHA-256, one per line. */
export async function resultGateSmokeArtefact(workId: string): Promise<ResultReviewEvidenceItem> {
  const sha256 = await hashContent(RESULT_GATE_SMOKE_PAYLOAD);
  return {
    kind: RESULT_GATE_SMOKE_ARTEFACT_KIND,
    ref: `${RESULT_GATE_SMOKE_ARTEFACT_KIND}:${workId}`,
    note: "synthetic smoke-test artefact -- no business outcome",
    content: [`Work: ${workId}`, "Synthetic: yes", `SHA-256: ${sha256}`, `Payload: ${RESULT_GATE_SMOKE_PAYLOAD}`].join("\n"),
  };
}

/** The artefact as recorded on the Work, or undefined. */
export function recordedSmokeArtefact(state: Pick<WorkState, "resultReview">): ResultReviewEvidenceItem | undefined {
  return state.resultReview?.evidence?.find((e) => e.kind === RESULT_GATE_SMOKE_ARTEFACT_KIND);
}

/**
 * The advisory Checker's view of the test Action (declared on the Action, as
 * every advisory assessment is): the artefact, while the Result awaits
 * Martin's approval. Advisory only -- never part of the smoke's pass or fail.
 */
export const RESULT_GATE_SMOKE_ADVISORY = {
  output: (state: WorkState) => recordedSmokeArtefact(state)?.content,
  request: () => "Check the synthetic smoke-test artefact against the criteria.",
  criteria: RESULT_GATE_SMOKE_CRITERIA,
  awaitingStage: RESULT_REVIEW_BLOCKED_STAGE,
};
