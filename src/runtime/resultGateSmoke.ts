/**
 * ISOLATED LIVE RESULT GATE SMOKE HARNESS (ENIG issue #370, Task 2).
 *
 * One admin-key-protected endpoint drives a SYNTHETIC Work through the
 * NORMAL WorkSession execution/save lifecycle so the deployed Result Gate
 * (PR #368) can be observed live: Machinery Worker verification fires from
 * `WorkSession.save()` exactly as it does for real Work, the gate refuses
 * the successful closure, and Martin's Result approval card is staged for
 * his own separate `resultreview` callback. A PASS never approves and never
 * closes anything.
 *
 * This module owns the smoke's OWN policy (which Unit/Hat/Responsibility/
 * Action the synthetic Work targets, which Work id prefix it accepts, which
 * Telegram destination the approval card may go to, what the report looks
 * like) and its orchestration; it deliberately owns no mechanism of its own:
 *
 *   - the target is FIXED here (unit/hat/responsibility/action), so no
 *     caller can aim the harness at another Unit, Hat, Responsibility or
 *     Action -- the query string accepts only `origin`, `action` and
 *     `work_id`; `origin` and `action` are both REQUIRED and must equal
 *     these constants exactly, and a missing, empty or different value is
 *     refused BEFORE any Durable Object is looked up;
 *   - the Action is resolved through the LIVE IN-PROCESS Unit manifest and
 *     Resolution machinery (`findUnitManifest` -> `resolveOrganization` ->
 *     `resolveActionExecution`) BEFORE any Work exists -- an in-process
 *     validation only: it performs no network call and fetches no Notion
 *     page of its own, so a manifest that stops declaring the test Action
 *     (or its Result contract) refuses the run rather than running against a
 *     stale assumption. The canonical Operations authority page itself is
 *     fetched only later, by the UNCHANGED Machinery Worker verification
 *     inside `WorkSession.save()` -- never by this pre-flight;
 *   - the governed Work is created through the caller's creation seam (the
 *     WorkSession Durable Object's own `init`), so `recordWorkAction`
 *     validates the Action against the Unit Manifest exactly like any other
 *     Work, and the run advances through the caller's runner seam (the
 *     WorkSession's own `execute` cycle), so `ensureResultReviewContract`,
 *     `WorkSession.save()`'s Machinery Worker verification trigger and the
 *     Result review gate are all the UNCHANGED production ones;
 *   - synthetic evidence enters WorkState only through the existing
 *     evidence model (`recordResultEvidence`) -- this module never writes a
 *     Checker verdict and never calls the verifier.
 *
 * Fail-closed everywhere: a non-smoke Work id, a missing or non-exact
 * `origin`/`action`, an unconfigured Martin destination, an unresolvable
 * Action or an unestablished Work all refuse BEFORE any Work exists; a
 * resolved test Action that declares even ONE permitted Tool operation is
 * refused by the harness itself (zero-Tool-operation isolation is enforced
 * here, never assumed from today's manifest); an unavailable verification,
 * an unusable check or missing evidence can never produce PASS, a staged
 * approval or a closure; and the post-run invariant refuses the whole
 * report if the harness ever left the Work at a successful stage or with a
 * recorded approval.
 *
 * Isolation is enforced, not promised: no business handler, no Tool
 * operation, no Notion writer and no Telegram sender is imported here (see
 * `src/runtime/resultGateSmoke.test.ts`'s import scan), and no ordinary
 * intake, Resolution, Handoff-pickup or dispatch path names the test Action
 * (see the ordinary-path scan there).
 */
import type { Env, ResultReviewEvidenceItem, Unit, WorkState } from "../types";
import { isTerminalWorkStage } from "../matterContinuation";
import {
  isSuccessfulResultStage,
  recordResultEvidence,
} from "../resultReview";
import { findUnitManifest } from "../units/registry";
import type { UnitManifest } from "../units/unitManifest";
import { resolveActionExecution } from "./actionResolution";
import { workContractForRequest } from "./workContract";
import { resolveOrganization } from "./organization";

// ---------------------------------------------------------------------------
// The fixed target. Nothing about it is caller-selectable.
// ---------------------------------------------------------------------------

/** Every synthetic Work id begins with this prefix; a real Work id can never be used for the smoke. */
export const RESULT_GATE_SMOKE_WORK_ID_PREFIX = "result-gate-smoke-";

/**
 * The ONLY origin this harness's Action is applicable to. Ordinary entries
 * (`direct_request`, `handoff_pickup`, `lifecycle_transition`) can never
 * satisfy it, which is what keeps the test Action unselectable outside this
 * harness (src/runtime/workContract.ts, Business Development's manifest).
 */
export const RESULT_GATE_SMOKE_ORIGIN = "result_gate_smoke" as const;

/** The ONE test-only Action this harness records on its synthetic Work. */
export const RESULT_GATE_SMOKE_ACTION = "result_gate_smoke_test" as const;

/**
 * The fixed Unit/Hat/Responsibility/Action the synthetic Work runs as --
 * declared once, consumed by the pre-flight resolution and by the report, so
 * the two can never drift apart.
 */
export const RESULT_GATE_SMOKE_TARGET = {
  unit: "Business Development" as Unit,
  hat: "Business Development Manager",
  responsibility: "develop_opportunities",
  action: RESULT_GATE_SMOKE_ACTION,
} as const;

/** The only query parameters this harness accepts (`key` is admin auth, src/adminAuth.ts). */
export const RESULT_GATE_SMOKE_PARAMS = ["origin", "action", "work_id"] as const;

/** Admin-auth query parameter, accepted only because `isAdminAuthorized` reads it -- never a harness parameter. */
export const RESULT_GATE_SMOKE_AUTH_PARAM = "key";

/** `result-gate-smoke-` plus a canonical UUID -- the exact shape the harness generates and the only one it accepts. */
const SMOKE_WORK_ID_SHAPE = /^result-gate-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a Work id belongs to this harness (never a real business Work). */
export function isResultGateSmokeWorkId(workId: unknown): workId is string {
  return typeof workId === "string" && SMOKE_WORK_ID_SHAPE.test(workId);
}

/** A fresh synthetic Work id: the dedicated prefix plus a UUID, never a reusable or caller-chosen value. */
export function newResultGateSmokeWorkId(): string {
  return `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Query-parameter contract.
// ---------------------------------------------------------------------------

export type ResultGateSmokeParams =
  | { ok: true; work_id?: string }
  | { ok: false; reason: string };

/**
 * Validates the request's query parameters fail-closed. Only `origin`,
 * `action` and `work_id` exist (plus the existing admin-auth `key`); each
 * must appear at most once; `origin` and `action` are REQUIRED -- a missing
 * or empty value is refused exactly like a different one, and when present
 * they must equal these constants EXACTLY; `work_id`, when present, must
 * already be a harness Work id. There is no parameter for Unit, Hat,
 * Responsibility, destination, chat id, thread id or any other Action -- a
 * caller cannot ask the harness to aim anywhere but its fixed target, and
 * the harness never runs under an undeclared origin or Action.
 */
export function parseResultGateSmokeParams(params: URLSearchParams): ResultGateSmokeParams {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) {
      return { ok: false, reason: `duplicate query parameter "${key}" -- each parameter may appear at most once.` };
    }
    seen.add(key);
    if (key === RESULT_GATE_SMOKE_AUTH_PARAM) continue;
    if (!(RESULT_GATE_SMOKE_PARAMS as readonly string[]).includes(key)) {
      return {
        ok: false,
        reason: `unknown query parameter "${key}" -- the Result Gate smoke harness accepts only ${RESULT_GATE_SMOKE_PARAMS.join(", ")}. There is no caller choice of Unit, Hat, Responsibility, destination or Action.`,
      };
    }
  }

  const origin = params.get("origin");
  if (origin === null) {
    return { ok: false, reason: `origin is required and must be exactly "${RESULT_GATE_SMOKE_ORIGIN}" -- the Result Gate smoke harness never runs without its declared origin.` };
  }
  if (origin !== RESULT_GATE_SMOKE_ORIGIN) {
    return { ok: false, reason: `origin must be exactly "${RESULT_GATE_SMOKE_ORIGIN}" (got "${origin}") -- the harness never runs under any other origin.` };
  }
  const action = params.get("action");
  if (action === null) {
    return { ok: false, reason: `action is required and must be exactly "${RESULT_GATE_SMOKE_ACTION}" -- the Result Gate smoke harness never runs without its declared test-only Action.` };
  }
  if (action !== RESULT_GATE_SMOKE_ACTION) {
    return { ok: false, reason: `action must be exactly "${RESULT_GATE_SMOKE_ACTION}" (got "${action}") -- the harness records exactly one test-only Action.` };
  }
  const workId = params.get("work_id");
  if (workId !== null && !isResultGateSmokeWorkId(workId)) {
    return { ok: false, reason: `work_id must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>" (got "${workId}") -- a real or foreign Work id can never be driven by this harness.` };
  }
  return { ok: true, ...(workId !== null ? { work_id: workId } : {}) };
}

// ---------------------------------------------------------------------------
// The approval destination: Martin's Telegram DM, from trusted config only.
// ---------------------------------------------------------------------------

/**
 * Martin's own Telegram DM, read from trusted Worker configuration and
 * nothing else. Fail-closed: an absent, empty, non-numeric or non-positive
 * value yields `null` and the harness refuses before any Work exists. There
 * is deliberately no parameter, argument or state field that can supply or
 * override this destination.
 */
export function martinTelegramChatId(env: Pick<Env, "MARTIN_TELEGRAM_USER_ID">): number | null {
  const raw = typeof env?.MARTIN_TELEGRAM_USER_ID === "string" ? env.MARTIN_TELEGRAM_USER_ID.trim() : "";
  if (!raw) return null;
  const chatId = Number(raw);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return null;
  return chatId;
}

// ---------------------------------------------------------------------------
// Pre-flight: the LIVE IN-PROCESS Unit manifest and Resolution machinery
// decide, before a Work exists, whether this harness may run at all. This
// is an in-process validation only -- it performs no network call and fetches
// no Notion page. The canonical Operations authority page is read later, by
// the UNCHANGED Machinery Worker verification inside WorkSession.save().
// ---------------------------------------------------------------------------

export interface ResultGateSmokeActionPlan {
  unit: Unit;
  hat: string;
  responsibility: string;
  action: string;
  expectedResult: string;
  completionCriteria: readonly string[];
  /** Tool operations the resolved Action declares -- refused unless empty (zero-Tool-operation isolation, enforced here). */
  toolOperations: readonly string[];
}

export type ResultGateSmokeActionResolution =
  | { ok: true; plan: ResultGateSmokeActionPlan }
  | { ok: false; reason: string };

/**
 * Resolves the test-only Action through the SAME three canonical boundaries
 * ordinary dispatch uses (`findUnitManifest` -> `resolveOrganization` ->
 * `resolveActionExecution`), under the harness's own fixed origin. This is
 * in-process manifest + Resolution validation, NOT an authority-page fetch:
 * it reads the registered Unit manifest and performs no network or Notion
 * read of its own (the canonical Operations authority is verified separately
 * and later, by the normal Machinery Worker verification path).
 *
 * Refuses fail-closed when the Unit is unregistered, the Organization cannot
 * be resolved, the Action is not exactly `result_gate_smoke_test`, the
 * Action declares no complete Result contract, OR the Action declares even
 * ONE permitted Tool operation -- always BEFORE any Work exists, so no
 * evidence, no verification and no approval can be produced on such a
 * refusal. Never interprets, never substitutes, never falls back.
 *
 * `manifest` exists so a test can prove these refusals against a manifest
 * that no longer declares the Action or that declares a Tool operation;
 * production passes nothing and reads the live in-process manifest.
 */
export async function resolveResultGateSmokeAction(manifest?: UnitManifest): Promise<ResultGateSmokeActionResolution> {
  const { unit, hat, action } = RESULT_GATE_SMOKE_TARGET;
  const resolvedManifest = manifest ?? findUnitManifest(unit);
  if (!resolvedManifest) {
    return { ok: false, reason: `no Unit manifest is registered for "${unit}" -- the in-process preflight found no manifest to validate the test Action against, so the Result Gate smoke harness refuses before any Work exists (the canonical Operations authority page itself is read later, by the normal Machinery Worker verification).` };
  }

  const contract = workContractForRequest({
    requested_outcome: "Synthetic Result Gate smoke harness Work -- no business outcome.",
    current_context: {
      mode: "cowork",
      origin: RESULT_GATE_SMOKE_ORIGIN,
      addressed_unit: unit,
      addressed_hat: hat,
      requested_action: action,
    },
  });

  const organization = resolveOrganization(contract, resolvedManifest);
  if (organization.kind !== "resolved") {
    return { ok: false, reason: `the Result Gate smoke harness could not resolve its Organization context (${organization.reason}): ${organization.detail}` };
  }

  const resolution = await resolveActionExecution(resolvedManifest, organization.organization, contract);
  if (resolution.kind !== "resolved") {
    return {
      ok: false,
      reason:
        resolution.kind === "failed"
          ? `the Result Gate smoke harness could not resolve its test-only Action (${resolution.reason}): ${resolution.detail}`
          : "the Result Gate smoke harness cannot resolve its test-only Action without an intake interpretation, and it never supplies one.",
    };
  }

  const execution = resolution.execution;
  if (execution.action.action_id !== action) {
    return { ok: false, reason: `resolution produced Action "${execution.action.action_id}" instead of "${action}" -- the harness refuses to run any other Action.` };
  }
  const expectedResult = execution.expected_result;
  const completionCriteria = execution.completion_criteria;
  if (!expectedResult?.trim() || !completionCriteria?.length) {
    return { ok: false, reason: `the test-only Action "${action}" declares no complete Result contract (expectedResult and completionCriteria are both required) -- the Result Gate smoke harness refuses without one.` };
  }

  // ZERO permitted Tool operations, enforced HERE by the harness itself --
  // never assumed from today's manifest declaring an empty list. A resolved
  // Action that declares even one operation breaks the smoke's isolation, so
  // the run is refused before the runner is asked to create or mutate any
  // Work: no evidence is recorded, no verification is triggered and no
  // approval can be staged.
  const toolOperations = (execution.tool_context?.permitted_operations ?? []).map((op) => `${op.tool_id}:${op.operation_id}`);
  if (toolOperations.length > 0) {
    return {
      ok: false,
      reason: `isolation violated: the test-only Action "${action}" declares ${toolOperations.length} permitted Tool operation(s) (${toolOperations.join(", ")}) -- the Result Gate smoke harness permits ZERO Tool operations, so it refuses before any Work is created, before any evidence is recorded and before any verification or approval can be staged.`,
    };
  }

  return {
    ok: true,
    plan: {
      unit,
      hat: organization.organization.hat,
      responsibility: organization.organization.responsibility,
      action: execution.action.action_id,
      expectedResult,
      completionCriteria,
      toolOperations,
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic evidence -- through the existing evidence model, never a verdict.
// ---------------------------------------------------------------------------

/**
 * The clearly marked synthetic evidence this harness records on its own Work
 * through `recordResultEvidence` (the sanctioned recorder). Two bounded
 * items, both naming the Work and the synthetic nature of the run; no
 * Entity, Matter, Lead, Proposal, Handoff, client identity or external
 * resource appears in either. The producing side's evidence is what the
 * Machinery Worker judges the declared criteria against, so the synthetic
 * set is deliberately self-describing rather than fabricated business
 * content.
 */
export function resultGateSmokeEvidence(workId: string): ResultReviewEvidenceItem[] {
  return [
    {
      kind: "smoke_test",
      ref: workId,
      note: "synthetic Result Gate smoke harness Work -- no business outcome",
      content: [
        "ENIG Result Gate live smoke harness (issue #370).",
        `Work: ${workId}`,
        `Action: ${RESULT_GATE_SMOKE_ACTION}`,
        `Origin: ${RESULT_GATE_SMOKE_ORIGIN}`,
        "Synthetic evidence only: no Entity, Matter, Lead, Proposal, Handoff, client record, business handler or external Tool operation was created.",
      ].join("\n"),
    },
    {
      kind: "smoke_test",
      ref: "result-gate-smoke-sequence",
      note: "the synthetic sequence this Work exercises",
      content: [
        "Sequence: create the synthetic Work -> record synthetic evidence through the existing evidence model -> reach the success stage -> WorkSession.save() runs the Machinery Worker verification -> the Result Gate refuses the successful closure -> Martin's Result approval card is staged for his separate decision.",
        "A PASS never auto-approves and never closes this Work; only Martin's normal resultreview callback records his decision.",
        `Work: ${workId}`,
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------
// The caller-side seams, implemented by the WorkSession Durable Object.
// ---------------------------------------------------------------------------

/**
 * The two seams this harness needs from the WorkSession: genuine Work
 * creation (which validates the Action against the Unit Manifest) and the
 * `execute` cycle that owns `ensureResultReviewContract`, `save()`'s
 * Machinery Worker verification trigger and the Result review gate. Exactly
 * two -- the harness has no close seam, because it must never close its own
 * Work.
 */
export interface ResultGateSmokeRunner {
  ensureGovernedWork(workId: string, chatId: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  runWithWorkPersistence(workId: string, fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState>;
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/** One recorded evidence item, projected for the report (never the bounded `content`). */
export interface ResultGateSmokeEvidenceReport {
  kind: string;
  ref: string;
  note?: string;
}

export interface ResultGateSmokeReport {
  /**
   * True only when the harness completed its full sequence with a recorded
   * Checker verdict and no post-run invariant was violated. A recorded
   * FAIL verdict still reports `ok: true` -- the harness did its job and
   * the gate correctly refused -- while `verification.outcome` carries the
   * verdict itself. Every refusal reports `ok: false` with `refusal`.
   *
   * `ok` answers only "did the harness run?". It is NEVER the Result Gate
   * verdict: read `harness_execution` and `result_gate` below for the two
   * facts an operator must not confuse.
   */
  ok: boolean;
  /**
   * Harness execution, stated separately from the verdict so successful
   * harness execution can never be mistaken for a passing Result Gate test:
   * `"completed"` = the harness ran its full sequence and recorded a Checker
   * verdict (HTTP 200); `"refused"` = it refused, or could not produce a
   * usable verdict (HTTP 500, with `refusal` set). Exactly `ok`'s meaning,
   * spelled out: `harness_execution === "completed"` iff `ok === true`.
   */
  harness_execution: "completed" | "refused";
  /**
   * The RESULT GATE verdict itself, never the harness's own success:
   * `"passed"` / `"failed"` are the recorded Machinery Worker verdicts over
   * the exact Result snapshot (a recorded FAIL is `"failed"` -- it is never
   * presented as a passing Result Gate test), and `"no_usable_verdict"`
   * means nothing could be verified, so everything fails closed.
   */
  result_gate: "passed" | "failed" | "no_usable_verdict";
  work_id: string;
  target: { unit: string; hat: string; responsibility: string; action: string };
  stage: string | null;
  evidence: ResultGateSmokeEvidenceReport[];
  /** The Machinery Worker verdict over this exact snapshot, or null when nothing could be verified (fail closed). */
  verification: {
    outcome: "passed" | "failed";
    checker_id: string;
    reason: string | null;
    verdict_hash: string | null;
    evidence_refs: ResultGateSmokeEvidenceReport[];
    snapshot_key: string | null;
  } | null;
  /** Martin's staged Result decision. The button token is deliberately NOT reported. */
  approval: { staged: boolean; review_hash: string | null } | null;
  blocked_reason: string | null;
  work_closed: boolean;
  /** Set only when the harness refused; never together with `ok: true`. */
  refusal?: string;
}

function refusalReport(workId: string, reason: string): ResultGateSmokeReport {
  return {
    ok: false,
    harness_execution: "refused",
    result_gate: "no_usable_verdict",
    work_id: String(workId),
    target: { ...RESULT_GATE_SMOKE_TARGET },
    stage: null,
    evidence: [],
    verification: null,
    approval: null,
    blocked_reason: null,
    work_closed: false,
    refusal: reason,
  };
}

function projectRefs(refs: readonly { kind: string; ref: string; note?: string }[] | undefined): ResultGateSmokeEvidenceReport[] {
  return (refs ?? []).map((r) => ({ kind: r.kind, ref: r.ref, ...(r.note ? { note: r.note } : {}) }));
}

// ---------------------------------------------------------------------------
// The orchestration.
// ---------------------------------------------------------------------------

/**
 * The synthetic Work's own body, run INSIDE the runner's `execute` cycle so
 * the Result contract has already been loaded from the Work's recorded
 * Action (`ensureResultReviewContract`, WorkSession.execute) and so the
 * return value flows into `WorkSession.save()`, where the Machinery Worker
 * verification trigger and the Result review gate run unchanged.
 *
 * It records synthetic evidence through the existing evidence model and
 * then reaches the success stage -- which is what makes `save()` verify and
 * the gate refuse. It never touches a verdict, an approval, a stage after
 * the gate, or a closure.
 */
async function runSyntheticWorkBody(state: WorkState, workId: string): Promise<WorkState> {
  if (state.workId !== workId) {
    throw new Error(`Result Gate smoke Work mismatch: the runner presented Work ${state.workId} for smoke ${workId} -- refusing to run under another Work.`);
  }
  const review = state.resultReview;
  if (!review?.expectedResult?.trim() || !review.completionCriteria?.length) {
    throw new Error("the synthetic Work carries no Result contract -- the recorded Action must declare expectedResult and completionCriteria for the Result Gate to judge.");
  }
  const recorded = await recordResultEvidence(state, resultGateSmokeEvidence(workId));
  if (!recorded.ok) {
    throw new Error(`the synthetic evidence was refused by the existing evidence model -- nothing was recorded (${recorded.reason})`);
  }
  // Reach the success stage so WorkSession.save() runs the Machinery Worker
  // verification and then the Result review gate -- the exact sequence this
  // smoke exists to observe. The gate, not this line, is what decides the
  // Work's actual stage afterwards.
  state.stage = "complete";
  return state;
}

/**
 * Runs one Result Gate smoke: resolve the fixed test Action through the
 * in-process manifest and Resolution machinery, establish a fresh synthetic
 * Work, drive it through the normal `execute`/`save` lifecycle, and report
 * exactly what the Result Gate did.
 *
 * Refuses (no Work created, nothing run, no evidence, no verification, no
 * approval) on: a non-smoke Work id, an unconfigured Martin destination, an
 * unresolvable Action or Result contract, a resolved Action that declares
 * even one permitted Tool operation (zero-Tool-operation isolation, enforced
 * by this harness), or a Work the runner cannot establish (including reuse
 * of an existing one). After the run it refuses the report itself if the
 * harness somehow left the Work at a successful stage or with a recorded
 * approval.
 *
 * `manifest` is a TEST-ONLY injection mirroring
 * `resolveResultGateSmokeAction(manifest?)`: it lets a test prove a refusal
 * (e.g. a Tool operation being declared) against a non-live manifest while
 * still asserting that no Work was created or mutated. Production call
 * sites pass nothing and always read the live in-process manifest.
 */
export async function runResultGateSmoke(
  env: Env,
  workId: string,
  runner: ResultGateSmokeRunner,
  manifest?: UnitManifest,
): Promise<ResultGateSmokeReport> {
  if (!isResultGateSmokeWorkId(workId)) {
    return refusalReport(workId, `smoke Work ids must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>" -- a real, foreign or malformed Work id can never be driven by this harness.`);
  }

  const chatId = martinTelegramChatId(env);
  if (chatId === null) {
    return refusalReport(workId, "Martin's Telegram destination is not configured (MARTIN_TELEGRAM_USER_ID is missing or unusable) -- the approval card has no destination, so no Work is created.");
  }

  // Resolved BEFORE the runner is asked to create or mutate anything: an
  // unusable Action (including one that declares a Tool operation) refuses
  // with no Work, no evidence, no verification and no approval.
  const resolution = await resolveResultGateSmokeAction(manifest);
  if (!resolution.ok) {
    return refusalReport(workId, resolution.reason);
  }

  const established = await runner.ensureGovernedWork(workId, chatId);
  if (!established.ok) {
    return refusalReport(workId, established.reason);
  }

  const after = await runner.runWithWorkPersistence(workId, (state) => runSyntheticWorkBody(state, workId));
  const review = after.resultReview;
  const checker = review?.checker;
  const { plan } = resolution;

  const report: ResultGateSmokeReport = {
    ok: false,
    // The harness refused until it can prove a recorded verdict: this is
    // flipped to "completed" only on the final, verified return below.
    harness_execution: "refused",
    result_gate: checker ? checker.outcome : "no_usable_verdict",
    work_id: String(after.workId ?? workId),
    target: { unit: plan.unit, hat: plan.hat, responsibility: plan.responsibility, action: plan.action },
    stage: after.stage ?? null,
    evidence: projectRefs(review?.evidence),
    verification: checker
      ? {
          outcome: checker.outcome,
          checker_id: checker.checkerId,
          reason: checker.reason ?? null,
          verdict_hash: checker.verdictHash ?? null,
          evidence_refs: projectRefs(checker.evidenceRefs),
          snapshot_key: review?.verificationAttempt?.snapshotKey ?? null,
        }
      : null,
    approval: checker ? { staged: !!review?.pendingApproval, review_hash: review?.pendingApproval?.reviewHash ?? null } : null,
    blocked_reason: review?.blockReason ?? after.blockedReason ?? null,
    work_closed: isTerminalWorkStage(after.stage ?? ""),
  };

  // Post-run invariants -- the harness must never approve and never close.
  const violations: string[] = [];
  if (isSuccessfulResultStage(after.stage ?? "")) {
    violations.push(`the harness left the synthetic Work at successful stage "${after.stage}" -- a PASS must never auto-close this Work`);
  }
  if (review?.approval) {
    violations.push("the harness recorded a Result approval -- only Martin's normal resultreview callback may record one");
  }
  if (violations.length) {
    return { ...report, ok: false, refusal: violations.join("; ") };
  }

  if (!checker) {
    const attempt = review?.verificationAttempt;
    const detail = attempt?.reason ?? (attempt ? `the verification attempt was "${attempt.outcome}"` : "the Machinery Worker verification never ran");
    return { ...report, ok: false, refusal: `verification_unavailable: ${detail}` };
  }

  // A recorded verdict is what makes the harness "completed" -- `ok` and
  // `harness_execution` state the harness; `result_gate` states the verdict
  // (`"passed"` or `"failed"`), so a recorded FAIL is never a passing test.
  return { ...report, ok: true, harness_execution: "completed" };
}
