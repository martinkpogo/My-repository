/**
 * ISOLATED LIVE RESULT GATE SMOKE HARNESS (ENIG #370, rebuilt on the current
 * gate, 16 Nov 2026).
 *
 * One admin-key-protected endpoint drives a SYNTHETIC Work through the normal
 * WorkSession execute/save lifecycle, so the deployed Result Gate is observed
 * exactly as production runs it, on the gate as Martin decided it on 14 Nov:
 * closure needs the declared contract, the recorded evidence and Martin's
 * Result approval hash-bound to that evidence; the independent Checker is
 * advisory. The path tested is the separate Result-approval card.
 *
 * The sequence, and who does each step:
 *   1. this harness creates a fresh `result-gate-smoke-<uuid>` Work (the
 *      WorkSession's own `init`, which validates the recorded test Action
 *      against the Unit Manifest) and, inside the normal `execute` cycle,
 *      records ONE synthetic artefact through `recordResultEvidence` and
 *      reaches `complete`;
 *   2. the UNCHANGED gate in `WorkSession.save()` refuses the closure into
 *      `result_review_blocked` and stages Martin's Result-approval card,
 *      recording whether Telegram delivered it (`resultReview.approvalRequest`);
 *   3. the advisory Checker may assess the artefact from the Work's alarm --
 *      reported, never part of pass or fail;
 *   4. Martin taps Approve (or Reject) on the card -- his normal callback;
 *   5. the read-only inspection (src/resultGateSmokeInspect.ts) reads the
 *      saved Work and reports the final state.
 *
 * Truthful reporting (#370 findings 3-5): every fact is computed by ONE
 * function, `assessResultGateSmoke`, from the Work's saved state -- used by
 * both this harness's report and the inspection, so they can never disagree.
 * `harness_execution` says only whether the harness ran; `overall` is
 * "passed" only when every required fact is established after Martin's
 * approval, and is otherwise "awaiting_martin", "rejected" or "failed" with
 * the missing facts named. An HTTP 200 proves nothing on its own.
 *
 * The harness never records a verdict, an approval or a closure, never calls
 * the verifier or the advisory assessment, and imports no business handler,
 * Tool, Notion writer or Telegram sender.
 */
import type { Env, Unit, WorkState } from "../types";
import { isTerminalWorkStage } from "../matterContinuation";
import { evaluateResultReviewGate, isSuccessfulResultStage, recordResultEvidence, RESULT_REVIEW_BLOCKED_STAGE } from "../resultReview";
import { hashContent } from "../contentHash";
import { findUnitManifest } from "../units/registry";
import type { UnitManifest } from "../units/unitManifest";
import { resolveActionExecution } from "./actionResolution";
import { workContractForRequest } from "./workContract";
import { resolveOrganization } from "./organization";
import {
  isResultGateSmokeWorkId,
  recordedSmokeArtefact,
  resultGateSmokeArtefact,
  RESULT_GATE_SMOKE_ACTION,
  RESULT_GATE_SMOKE_ARTEFACT_KIND,
  RESULT_GATE_SMOKE_CRITERIA,
  RESULT_GATE_SMOKE_EXPECTED_RESULT,
  RESULT_GATE_SMOKE_ORIGIN,
  RESULT_GATE_SMOKE_PAYLOAD,
  RESULT_GATE_SMOKE_WORK_ID_PREFIX,
} from "./resultGateSmokeContract";

export { isResultGateSmokeWorkId, RESULT_GATE_SMOKE_ACTION, RESULT_GATE_SMOKE_ORIGIN, RESULT_GATE_SMOKE_WORK_ID_PREFIX } from "./resultGateSmokeContract";

// ---------------------------------------------------------------------------
// The fixed target. Nothing about it is caller-selectable.
// ---------------------------------------------------------------------------

export const RESULT_GATE_SMOKE_TARGET = {
  unit: "Business Development" as Unit,
  hat: "Business Development Manager",
  responsibility: "develop_opportunities",
  action: RESULT_GATE_SMOKE_ACTION,
} as const;

/** The only query parameters the harness accepts (`key` is admin auth, src/adminAuth.ts). */
export const RESULT_GATE_SMOKE_PARAMS = ["origin", "action", "work_id"] as const;
export const RESULT_GATE_SMOKE_AUTH_PARAM = "key";

/** A fresh synthetic Work id: the dedicated prefix plus a UUID, never caller-chosen. */
export function newResultGateSmokeWorkId(): string {
  return `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}${crypto.randomUUID()}`;
}

export type ResultGateSmokeParams = { ok: true; work_id?: string } | { ok: false; reason: string };

/**
 * Fail-closed query contract: only `origin`, `action` and `work_id` (plus the
 * admin `key`), each at most once; `origin` and `action` are required and must
 * equal the harness constants exactly; `work_id`, when given, must already be
 * a smoke id. No parameter can aim the harness at another Unit, Hat, Action or
 * destination.
 */
export function parseResultGateSmokeParams(params: URLSearchParams): ResultGateSmokeParams {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return { ok: false, reason: `duplicate query parameter "${key}" -- each parameter may appear at most once.` };
    seen.add(key);
    if (key === RESULT_GATE_SMOKE_AUTH_PARAM) continue;
    if (!(RESULT_GATE_SMOKE_PARAMS as readonly string[]).includes(key)) {
      return { ok: false, reason: `unknown query parameter "${key}" -- the Result Gate smoke harness accepts only ${RESULT_GATE_SMOKE_PARAMS.join(", ")}.` };
    }
  }
  const origin = params.get("origin");
  if (origin !== RESULT_GATE_SMOKE_ORIGIN) return { ok: false, reason: `origin is required and must be exactly "${RESULT_GATE_SMOKE_ORIGIN}".` };
  const action = params.get("action");
  if (action !== RESULT_GATE_SMOKE_ACTION) return { ok: false, reason: `action is required and must be exactly "${RESULT_GATE_SMOKE_ACTION}".` };
  const workId = params.get("work_id");
  if (workId !== null && !isResultGateSmokeWorkId(workId)) return { ok: false, reason: `work_id must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>".` };
  return { ok: true, ...(workId !== null ? { work_id: workId } : {}) };
}

/** Martin's own Telegram DM, from trusted configuration only; null when absent or unusable. */
export function martinTelegramChatId(env: Pick<Env, "MARTIN_TELEGRAM_USER_ID">): number | null {
  const raw = typeof env?.MARTIN_TELEGRAM_USER_ID === "string" ? env.MARTIN_TELEGRAM_USER_ID.trim() : "";
  const chatId = raw ? Number(raw) : NaN;
  return Number.isSafeInteger(chatId) && chatId > 0 ? chatId : null;
}

// ---------------------------------------------------------------------------
// Pre-flight: the live in-process manifest and Resolution decide, before any
// Work exists, whether the harness may run. No network call, no Notion read.
// ---------------------------------------------------------------------------

export type ResultGateSmokeActionResolution = { ok: true; hat: string; responsibility: string } | { ok: false; reason: string };

/**
 * Resolves the test Action through the same three boundaries ordinary
 * dispatch uses, under the harness's own origin. Refuses when the Unit, the
 * Organization or the Action cannot be resolved, when the Action's Result
 * contract is not exactly the smoke contract, or when it declares even ONE
 * Tool operation (zero-Tool isolation, enforced here, never assumed).
 * `manifest` is a test-only injection; production reads the live manifest.
 */
export async function resolveResultGateSmokeAction(manifest?: UnitManifest): Promise<ResultGateSmokeActionResolution> {
  const { unit, hat, action } = RESULT_GATE_SMOKE_TARGET;
  const resolvedManifest = manifest ?? findUnitManifest(unit);
  if (!resolvedManifest) return { ok: false, reason: `no Unit manifest is registered for "${unit}".` };
  const contract = workContractForRequest({
    requested_outcome: "Synthetic Result Gate smoke test Work -- no business outcome.",
    current_context: { mode: "cowork", origin: RESULT_GATE_SMOKE_ORIGIN, addressed_unit: unit, addressed_hat: hat, requested_action: action },
  });
  const organization = resolveOrganization(contract, resolvedManifest);
  if (organization.kind !== "resolved") return { ok: false, reason: `the smoke Organization could not be resolved (${organization.reason}): ${organization.detail}` };
  const resolution = await resolveActionExecution(resolvedManifest, organization.organization, contract);
  if (resolution.kind !== "resolved") {
    return { ok: false, reason: resolution.kind === "failed" ? `the test Action could not be resolved (${resolution.reason}): ${resolution.detail}` : "the test Action cannot be resolved without an intake interpretation, and the harness never supplies one." };
  }
  const execution = resolution.execution;
  if (execution.action.action_id !== action) return { ok: false, reason: `resolution produced "${execution.action.action_id}" instead of "${action}".` };
  if (execution.expected_result !== RESULT_GATE_SMOKE_EXPECTED_RESULT || JSON.stringify(execution.completion_criteria ?? []) !== JSON.stringify(RESULT_GATE_SMOKE_CRITERIA)) {
    return { ok: false, reason: `the test Action "${action}" does not declare the smoke test's Result contract.` };
  }
  const toolOperations = execution.tool_context?.permitted_operations ?? [];
  if (toolOperations.length > 0) {
    return { ok: false, reason: `isolation violated: the test Action declares ${toolOperations.length} Tool operation(s) -- the smoke permits none.` };
  }
  return { ok: true, hat: organization.organization.hat, responsibility: organization.organization.responsibility };
}

// ---------------------------------------------------------------------------
// The one assessment: every fact, from the Work's saved state.
// ---------------------------------------------------------------------------

export type SmokeFactStatus = "established" | "not_established" | "pending";

export interface ResultGateSmokeAssessment {
  /** "passed" only after Martin's card approval, with every required fact established. */
  overall: "passed" | "awaiting_martin" | "rejected" | "failed";
  /** The required facts not (yet) established, by name. */
  missing: string[];
  contract: { status: SmokeFactStatus; detail: string };
  evidence: { status: SmokeFactStatus; detail: string; artefact_ref: string | null; artefact_sha256: string | null };
  gate_blocked_pending_approval: { status: SmokeFactStatus; detail: string };
  approval_request: { status: "not_staged" | "staged" | "delivered" | "failed"; staged_at: string | null; delivered_at: string | null; reason: string | null };
  martin_decision: { status: "none" | "pending" | "approved" | "rejected"; decided_at: string | null; via: string | null; bound_to_current_evidence: boolean | null };
  final_state: { stage: string | null; gate_status: string | null; work_closed: boolean; status: SmokeFactStatus };
  /** Advisory: reported for visibility, never part of `overall`. */
  advisory_checker: { recorded: boolean; recommended: string | null; checker_id: string | null; assessed_at: string | null };
}

const REJECTED_BY_MARTIN = "Result approval rejected by Martin";

async function assessArtefact(state: WorkState): Promise<ResultGateSmokeAssessment["evidence"]> {
  const items = state.resultReview?.evidence ?? [];
  const artefacts = items.filter((e) => e.kind === RESULT_GATE_SMOKE_ARTEFACT_KIND);
  const artefact = recordedSmokeArtefact(state);
  const none = { artefact_ref: artefact?.ref ?? null, artefact_sha256: null };
  if (!artefact) return { status: "not_established", detail: "no synthetic artefact is recorded.", ...none };
  if (artefacts.length !== 1 || items.length !== 1) return { status: "not_established", detail: `expected exactly one evidence item (the synthetic artefact); found ${items.length}.`, ...none };
  const lines = new Map(artefact.content.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()] as [string, string]));
  const payload = lines.get("Payload") ?? "";
  const recordedSha = lines.get("SHA-256") ?? "";
  const actualSha = await hashContent(payload);
  if (lines.get("Work") !== state.workId) return { status: "not_established", detail: "the artefact does not name this Work.", ...none };
  if (lines.get("Synthetic") !== "yes" || payload !== RESULT_GATE_SMOKE_PAYLOAD) return { status: "not_established", detail: "the artefact is not the fixed synthetic payload.", ...none };
  if (recordedSha !== actualSha) return { status: "not_established", detail: "the artefact's recorded SHA-256 does not match its payload.", ...none };
  return { status: "established", detail: "one synthetic artefact, its SHA-256 matching its payload.", artefact_ref: artefact.ref, artefact_sha256: recordedSha };
}

/**
 * Assesses a smoke Work from its saved state. Read-only: the gate is evaluated
 * on a COPY, so nothing on `state` is changed.
 */
export async function assessResultGateSmoke(state: WorkState): Promise<ResultGateSmokeAssessment> {
  const review = state.resultReview;
  const contractOk = review?.expectedResult === RESULT_GATE_SMOKE_EXPECTED_RESULT && JSON.stringify(review?.completionCriteria ?? []) === JSON.stringify(RESULT_GATE_SMOKE_CRITERIA);
  const contract = { status: (contractOk ? "established" : "not_established") as SmokeFactStatus, detail: contractOk ? "loaded from the test Action's manifest declaration." : "the Work does not carry the test Action's Result contract." };
  const evidence = await assessArtefact(state);

  const request = review?.approvalRequest;
  const approval_request: ResultGateSmokeAssessment["approval_request"] = {
    status: !request ? "not_staged" : request.deliveredAt ? "delivered" : request.failedReason ? "failed" : "staged",
    staged_at: request?.stagedAt ?? null,
    delivered_at: request?.deliveredAt ?? null,
    reason: request?.failedReason ?? (request && !request.deliveredAt ? "staged, but delivery was never confirmed." : null),
  };

  const approval = review?.approval;
  const rejected = !approval && (review?.blockReason ?? "").startsWith(REJECTED_BY_MARTIN);
  let bound: boolean | null = null;
  if (approval) {
    const copy = structuredClone(state);
    if (copy.stage === RESULT_REVIEW_BLOCKED_STAGE) copy.stage = review?.preBlockStage ?? "complete";
    bound = (await evaluateResultReviewGate(copy)).allowed;
  }
  const martin_decision: ResultGateSmokeAssessment["martin_decision"] = {
    status: approval ? "approved" : rejected ? "rejected" : review?.pendingApproval ? "pending" : "none",
    decided_at: approval?.approvedAt ?? null,
    via: approval ? (approval.via ?? "result_card") : null,
    bound_to_current_evidence: bound,
  };

  const blockedNow = state.stage === RESULT_REVIEW_BLOCKED_STAGE && review?.gateStatus === "blocked";
  // A card can only be staged while the gate holds the Work blocked, so a
  // decision on the card proves the block happened before it.
  const gateBlocked = blockedNow || Boolean(approval && martin_decision.via === "result_card") || rejected;
  const gate_blocked_pending_approval = {
    status: (gateBlocked ? "established" : "not_established") as SmokeFactStatus,
    detail: gateBlocked ? "the gate refused closure into result_review_blocked pending Martin's approval." : "the gate has not held the Work blocked pending approval.",
  };

  const closed = isTerminalWorkStage(state.stage ?? "") && isSuccessfulResultStage(state.stage ?? "") && review?.gateStatus === "passed";
  const final_state = {
    stage: state.stage ?? null,
    gate_status: review?.gateStatus ?? null,
    work_closed: isTerminalWorkStage(state.stage ?? ""),
    status: (closed ? "established" : approval ? "not_established" : "pending") as SmokeFactStatus,
  };

  const assessment = review?.assessment;
  const advisory_checker = {
    recorded: Boolean(assessment),
    recommended: assessment?.recommended ?? null,
    checker_id: assessment?.checkerId ?? null,
    assessed_at: assessment?.assessedAt ?? null,
  };

  const missing: string[] = [];
  if (contract.status !== "established") missing.push("contract");
  if (evidence.status !== "established") missing.push("evidence");
  if (gate_blocked_pending_approval.status !== "established") missing.push("gate_blocked_pending_approval");
  if (approval_request.status !== "delivered") missing.push("approval_request_delivered");
  if (martin_decision.status !== "approved") missing.push("martin_approval");
  else {
    if (martin_decision.via !== "result_card") missing.push("approval_via_result_card");
    if (!bound) missing.push("approval_bound_to_current_evidence");
  }
  if (final_state.status !== "established") missing.push("final_state_closed");

  const ready = contract.status === "established" && evidence.status === "established" && gate_blocked_pending_approval.status === "established" && approval_request.status === "delivered";
  const overall: ResultGateSmokeAssessment["overall"] =
    missing.length === 0 ? "passed" : rejected && ready ? "rejected" : ready && martin_decision.status === "pending" ? "awaiting_martin" : "failed";

  return { overall, missing, contract, evidence, gate_blocked_pending_approval, approval_request, martin_decision, final_state, advisory_checker };
}

// ---------------------------------------------------------------------------
// The harness run.
// ---------------------------------------------------------------------------

/** The two WorkSession seams: genuine Work creation and the normal execute cycle. No close seam. */
export interface ResultGateSmokeRunner {
  ensureGovernedWork(workId: string, chatId: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  runWithWorkPersistence(workId: string, fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState>;
}

export type ResultGateSmokeReport = {
  /** Whether the harness ran its sequence -- never the Result Gate's outcome (read `overall`). */
  harness_execution: "completed" | "refused";
  refusal?: string;
  work_id: string;
  target: { unit: string; hat: string; responsibility: string; action: string };
} & Partial<ResultGateSmokeAssessment>;

function refusal(workId: string, reason: string): ResultGateSmokeReport {
  return { harness_execution: "refused", refusal: reason, work_id: String(workId), target: { ...RESULT_GATE_SMOKE_TARGET } };
}

/** The synthetic Work's body, inside the normal execute cycle (the contract is already loaded). */
async function runSyntheticWorkBody(state: WorkState, workId: string): Promise<WorkState> {
  if (state.workId !== workId) throw new Error(`Result Gate smoke Work mismatch: ${state.workId} is not ${workId}.`);
  const recorded = await recordResultEvidence(state, [await resultGateSmokeArtefact(workId)]);
  if (!recorded.ok) throw new Error(`the synthetic artefact was refused by the evidence model: ${recorded.reason}`);
  // The success stage is what makes the unchanged gate in save() refuse the
  // closure and stage Martin's card; the gate decides the stage afterwards.
  state.stage = "complete";
  return state;
}

/**
 * One smoke run: preflight, a fresh synthetic Work, the normal execute/save
 * cycle, then the shared assessment of the saved result. Refuses before any
 * Work exists on a bad id, no Martin destination or an unusable Action; after
 * the run, refuses the report if the harness ever left the Work closed or
 * approved (only Martin's callback may).
 */
export async function runResultGateSmoke(env: Env, workId: string, runner: ResultGateSmokeRunner, manifest?: UnitManifest): Promise<ResultGateSmokeReport> {
  if (!isResultGateSmokeWorkId(workId)) return refusal(workId, `smoke Work ids must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>".`);
  const chatId = martinTelegramChatId(env);
  if (chatId === null) return refusal(workId, "Martin's Telegram destination is not configured (MARTIN_TELEGRAM_USER_ID) -- no Work is created.");
  const resolution = await resolveResultGateSmokeAction(manifest);
  if (!resolution.ok) return refusal(workId, resolution.reason);
  const established = await runner.ensureGovernedWork(workId, chatId);
  if (!established.ok) return refusal(workId, established.reason);

  const after = await runner.runWithWorkPersistence(workId, (state) => runSyntheticWorkBody(state, workId));
  const target = { unit: RESULT_GATE_SMOKE_TARGET.unit, hat: resolution.hat, responsibility: resolution.responsibility, action: RESULT_GATE_SMOKE_ACTION };
  const assessment = await assessResultGateSmoke(after);
  const violations: string[] = [];
  if (isSuccessfulResultStage(after.stage ?? "")) violations.push(`the Work was left at success stage "${after.stage}" without Martin's approval`);
  if (after.resultReview?.approval) violations.push("a Result approval was recorded without Martin's callback");
  if (violations.length) return { ...refusal(workId, violations.join("; ")), target, ...assessment };
  return { harness_execution: "completed", work_id: String(after.workId ?? workId), target, ...assessment };
}
