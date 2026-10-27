/**
 * The Result review lifecycle (BD-8) -- Work's ONE generic enforcement
 * module. Unit-free: it reads the declared contract from the Work's own
 * registered Action (via the Unit registry) and enforces the completion rule
 * for every Unit identically. No Unit-specific branch exists here or in any
 * caller.
 *
 * WHAT BD-8 REQUIRES. A Result counts as finished only when (1) the
 * responsible Action declares its expected Result and explicit completion
 * criteria before execution; (2) an independent Checker, who did not perform
 * the work, verifies the available evidence against those criteria; (3)
 * Martin approves the Result; and (4) Work cannot close while the criteria
 * are missing, evidence is insufficient, verification fails, or required
 * approval is absent -- with the unresolved state and reason kept visible.
 *
 * HOW TRUST IS ESTABLISHED (no new mechanism). The repository already has two
 * trust patterns and this module composes them:
 *
 *   - the STAGED-APPROVAL pattern (staged decision on WorkState, consumed by
 *     a verified callback, minting the record of that consumption -- the same
 *     discipline as `mintApprovalProofForWork` in src/access.ts); and
 *   - the DURABLE BOUND-ATTESTATION pattern (a claim hash-bound to the exact
 *     record it reviews, recomputed fail-closed at consumption -- the same
 *     discipline as the Call Notes `record_approval` marker,
 *     src/records/callNotes/callNotesMarker.ts, built on the shared SHA-256
 *     primitive src/contentHash.ts).
 *
 * A Checker verdict and Martin's Result approval are therefore never
 * strings, timestamps or claimed approvers: each carries a SHA-256 over the
 * exact Work / expected Result / completion criteria / evidence it was
 * produced against, and `evaluateResultReviewGate` RECOMPUTES both hashes at
 * closure time. A verdict or approval bound to a different Work, Result,
 * criteria or evidence set -- or made stale by any of those changing after
 * it was recorded -- fails closed. Like `record_approval`, the persisted
 * records are procedural assurance (a bound claim recorded through the
 * sanctioned path), not cryptographic proof of the human events.
 *
 * CALL-SITE DISCIPLINE, same as mintApprovalProofForWork: `recordCheckerVerdict`
 * and `stageResultReviewApproval` are minter-style recorders. They may only be
 * called from a flow that actually established the fact being recorded (a
 * check that was actually performed; a staged approval actually presented to
 * Martin). The gate verifies BINDING, not the event; nothing in this module
 * may be called from text parsing, AI output, or ambient state.
 *
 * THE UNRESOLVED GOVERNANCE GAP (recorded, not papered over): BD-8 says the
 * Checker is "independent, who did not perform the work", but no rule yet
 * says WHO may be a Checker or how organizational independence is
 * established. This module enforces the mechanical minimum (the verdict is
 * hash-bound to the exact checked snapshot; the checker identity must be
 * distinct from the Work's recorded performer) and refuses everything else
 * fail-closed. The WHO rule is a governance decision for Architect/Martin,
 * recorded in docs/enig-operating-model.md (Open questions).
 */

import type {
  ResultReviewApproval,
  ResultReviewCheckerVerdict,
  ResultReviewEvidenceRef,
  ResultReviewState,
  WorkState,
} from "./types";
import { hashContent } from "./contentHash";

/** The stage values that mean "this Work reports a successful Result". */
export function isSuccessfulResultStage(stage: string): boolean {
  return stage === "delivered" || stage === "complete";
}

/** The stage a successful closure is refused into, with the reason kept visible. */
export const RESULT_REVIEW_BLOCKED_STAGE = "result_review_blocked";

// ---------------------------------------------------------------------------
// Canonical texts (fixed order, trim normalization, JSON escaping -- the same
// representation discipline as canonicalCallNotesApprovalText, so two
// different snapshots cannot hash the same and no hand-joined `name=value`
// line can be misread).
// ---------------------------------------------------------------------------

/** The full review snapshot a verdict binds to: contract + evidence + outcome + reason. */
function canonicalVerdictText(
  workId: string,
  expectedResult: string,
  completionCriteria: readonly string[],
  evidenceRefs: readonly ResultReviewEvidenceRef[],
  outcome: ResultReviewCheckerVerdict["outcome"],
  reason: string | undefined,
): string {
  return JSON.stringify([
    ["work", workId.trim()],
    ["expected_result", expectedResult.trim()],
    ["criteria", completionCriteria.map((c) => c.trim())],
    ["evidence", evidenceRefs.map((e) => [e.kind.trim(), e.ref.trim(), (e.note ?? "").trim()])],
    ["outcome", outcome],
    ["reason", (reason ?? "").trim()],
  ]);
}

/** The snapshot an approval binds to: contract + the verdict hash in force. */
function canonicalApprovalText(workId: string, expectedResult: string, completionCriteria: readonly string[], verdictHash: string): string {
  return JSON.stringify([
    ["work", workId.trim()],
    ["expected_result", expectedResult.trim()],
    ["criteria", completionCriteria.map((c) => c.trim())],
    ["verdict_hash", verdictHash.trim()],
  ]);
}

/**
 * The hash of a Checker verdict over the exact snapshot it was rendered
 * against. Recomputed by the gate; recomputable by any auditor from the
 * stored state.
 */
export async function hashResultReviewVerdict(input: {
  workId: string;
  expectedResult: string;
  completionCriteria: readonly string[];
  evidenceRefs: readonly ResultReviewEvidenceRef[];
  outcome: ResultReviewCheckerVerdict["outcome"];
  reason?: string;
}): Promise<string> {
  return hashContent(
    canonicalVerdictText(input.workId, input.expectedResult, input.completionCriteria, input.evidenceRefs, input.outcome, input.reason),
  );
}

/** The hash of the snapshot Martin's Result approval binds to. */
export async function hashResultReviewApproval(input: {
  workId: string;
  expectedResult: string;
  completionCriteria: readonly string[];
  verdictHash: string;
}): Promise<string> {
  return hashContent(canonicalApprovalText(input.workId, input.expectedResult, input.completionCriteria, input.verdictHash));
}

// ---------------------------------------------------------------------------
// Contract initialization -- loaded LIVE from the Work's registered Action,
// never hand-written and never hard-coded (the operating model's governance
// pattern: declarations live on the Unit's own manifest).
// ---------------------------------------------------------------------------

/**
 * Ensures `state.resultReview` exists and carries the contract its recorded
 * Action declares. The caller resolves the registered Action (WorkSession
 * does, through the Unit registry, once per mutation cycle -- this module
 * deliberately imports no registry so Unit handlers can depend on it without
 * a module cycle), so dispatch entries AND Handoff pickups (whose Action is
 * adopted at the pickup boundary) are covered by one mechanism.
 *
 * Never overwrites a recorded checker verdict or approval; refreshes only the
 * contract fields the manifest declares. A Work whose recorded Action is not
 * registered, or that declares no contract, is left contract-less -- the gate
 * then refuses its successful closure with that exact reason (BD-8 condition
 * 4: missing criteria prevents closure).
 */
export function ensureResultReviewContract(
  state: WorkState,
  action: { expectedResult?: string; completionCriteria?: readonly string[] } | undefined,
): void {
  const expectedResult = action?.expectedResult;
  const completionCriteria = action?.completionCriteria;
  if (!state.resultReview) {
    if (!expectedResult && !completionCriteria) return;
    state.resultReview = {
      expectedResult,
      completionCriteria,
      gateStatus: "pending",
    };
    return;
  }
  if (!state.resultReview.expectedResult && expectedResult) state.resultReview.expectedResult = expectedResult;
  if (!state.resultReview.completionCriteria && completionCriteria) {
    state.resultReview.completionCriteria = completionCriteria;
  }
}

// ---------------------------------------------------------------------------
// Checker authority (BD-9): an explicit, organizationally-established set of
// identities that hold the Result Verification responsibility under ENIG's
// canonical organizational rules. Empty by default -- no identity is
// authorized until an organizational rule explicitly establishes one. This is
// NOT inferred from identity/Hat/Unit/technical ability to call a function:
// membership is the authority check, and nothing else grants it.
// ---------------------------------------------------------------------------

/** Module-level set of Checker identities explicitly authorized under BD-9. */
const authorizedCheckerIds = new Set<string>();

/**
 * Registers `checkerId` as holding the Result Verification responsibility --
 * the only way an identity gains Checker authority in the runtime. Called by
 * whatever flow establishes organizational authorization; the runtime itself
 * never invents authority.
 */
export function authorizeResultVerificationChecker(checkerId: string): void {
  authorizedCheckerIds.add(checkerId.trim());
}

/** Returns true when `checkerId` holds the Result Verification responsibility. */
export function isAuthorizedResultVerificationChecker(checkerId: string): boolean {
  return authorizedCheckerIds.has(checkerId.trim());
}

/**
 * The production verification path: an authorized, independent Checker
 * evaluates the declared completion criteria against identifiable evidence
 * and records a PASS or FAIL verdict bound to the exact Work, expected
 * Result, criteria, and evidence snapshot.
 *
 * Enforces BD-9 before recording:
 *   - the checker holds the Result Verification responsibility (authority);
 *   - the checker is not the Work's recorded performer (independence);
 *   - a Result contract is declared (contract);
 *   - evidence refs are present and well-formed (evidence).
 *
 * Refuses PASS when authority, independence, or evidence cannot be
 * established; surfaces the specific unresolved dependency. Martin's separate
 * Result approval remains mandatory -- a passing verdict is a prerequisite,
 * not a substitute for approval.
 */
export async function verifyResultReview(
  state: WorkState,
  input: {
    checkerId: string;
    outcome: ResultReviewCheckerVerdict["outcome"];
    reason?: string;
    evidenceRefs: readonly ResultReviewEvidenceRef[];
  },
): Promise<ResultReviewRecorderRefusal> {
  const checkerId = input.checkerId.trim();
  if (!checkerId) return { ok: false, reason: "cannot verify this Result without a checker identity." };
  if (!isAuthorizedResultVerificationChecker(checkerId)) {
    return {
      ok: false,
      reason: `cannot verify this Result: "${checkerId}" does not hold the Result Verification responsibility under ENIG's canonical organizational rules -- BD-9 requires explicit organizational authorization before a Checker may issue a verdict.`,
    };
  }
  const review = state.resultReview;
  if (!review?.expectedResult?.trim() || !review.completionCriteria?.length) {
    return { ok: false, reason: "cannot verify this Result: this Work declares no Result contract to check against." };
  }
  if (checkerId === state.actionName || checkerId === state.hat) {
    return {
      ok: false,
      reason: "cannot verify this Result: the checker identity equals the Work's recorded performer -- BD-8 requires a Checker who did not perform the work, and a different identity alone is insufficient.",
    };
  }
  if (!input.evidenceRefs.length) {
    return { ok: false, reason: "cannot verify this Result over an empty evidence set -- evidence insufficiency must be judged against evidence, not against nothing." };
  }
  for (const ref of input.evidenceRefs) {
    if (!ref.kind.trim() || !ref.ref.trim()) {
      return { ok: false, reason: "cannot verify this Result carrying a malformed evidence reference (kind and ref are both required)." };
    }
  }
  return recordCheckerVerdict(state, { checkerId, outcome: input.outcome, reason: input.reason, evidenceRefs: input.evidenceRefs });
}

// ---------------------------------------------------------------------------
// Sanctioned recorders (see module header for the call-site discipline).
// ---------------------------------------------------------------------------

export type ResultReviewRecorderRefusal = { ok: false; reason: string } | { ok: true };

/**
 * Records a Checker verdict over the CURRENT review snapshot of this Work --
 * the only sanctioned way a verdict enters WorkState. Refuses (nothing is
 * recorded) when no contract is declared, the evidence set is empty, the
 * outcome or identity is malformed, or the checker identity is not distinct
 * from the Work's recorded performer (Action or Hat).
 *
 * Recording a new verdict INVALIDATES any previously bound approval and
 * staged approval: an approval reviews one exact verdict, and a superseding
 * verdict must re-earn it.
 */
export async function recordCheckerVerdict(
  state: WorkState,
  input: {
    checkerId: string;
    outcome: ResultReviewCheckerVerdict["outcome"];
    reason?: string;
    evidenceRefs: readonly ResultReviewEvidenceRef[];
  },
): Promise<ResultReviewRecorderRefusal> {
  const review = state.resultReview;
  if (!review?.expectedResult?.trim() || !review.completionCriteria?.length) {
    return { ok: false, reason: "cannot record a Checker verdict: this Work declares no Result contract to check against." };
  }
  if (!input.checkerId.trim()) return { ok: false, reason: "cannot record a Checker verdict without a checker identity." };
  if (input.outcome !== "passed" && input.outcome !== "failed") {
    return { ok: false, reason: "cannot record a Checker verdict with a malformed outcome." };
  }
  if (!input.evidenceRefs.length) {
    return { ok: false, reason: "cannot record a Checker verdict over an empty evidence set -- evidence insufficiency must be judged against evidence, not against nothing." };
  }
  for (const ref of input.evidenceRefs) {
    if (!ref.kind.trim() || !ref.ref.trim()) {
      return { ok: false, reason: "cannot record a Checker verdict carrying a malformed evidence reference (kind and ref are both required)." };
    }
  }
  if (input.checkerId.trim() === state.actionName || input.checkerId.trim() === state.hat) {
    return {
      ok: false,
      reason: "cannot record a Checker verdict: the checker identity equals the Work's recorded performer -- BD-8 requires a Checker who did not perform the work.",
    };
  }
  const verdictHash = await hashResultReviewVerdict({
    workId: state.workId,
    expectedResult: review.expectedResult,
    completionCriteria: review.completionCriteria,
    evidenceRefs: input.evidenceRefs,
    outcome: input.outcome,
    reason: input.reason,
  });
  review.checker = {
    checkerId: input.checkerId.trim(),
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    checkedAt: new Date().toISOString(),
    evidenceRefs: input.evidenceRefs,
    verdictHash,
  };
  review.approval = undefined;
  review.pendingApproval = undefined;
  review.gateStatus = "pending";
  review.blockReason = input.outcome === "failed" ? `Independent Checker verification FAILED: ${input.reason ?? "criteria not met"}` : undefined;
  return { ok: true };
}

/**
 * Stages Martin's Result decision on the exact current snapshot -- the only
 * sanctioned way a pending Result approval enters WorkState. Refuses unless
 * a PASSING, currently-bound verdict already exists (there is nothing to
 * approve before verification), and binds the staged card (and its button
 * token) to that exact snapshot.
 *
 * The caller (a verified flow, or WorkSession when it surfaces the card)
 * presents the returned card; the decision returns through the `resultreview`
 * callback, never through free text.
 */
export async function stageResultReviewApproval(state: WorkState): Promise<
  { ok: true; pending: NonNullable<ResultReviewState["pendingApproval"]> } | { ok: false; reason: string }
> {
  const review = state.resultReview;
  if (!review?.expectedResult?.trim() || !review.completionCriteria?.length) {
    return { ok: false, reason: "cannot stage a Result approval: this Work declares no Result contract." };
  }
  const verdict = review.checker;
  if (!verdict || verdict.outcome !== "passed") {
    return { ok: false, reason: "cannot stage a Result approval before a passing independent Checker verdict exists." };
  }
  if (await verdictStaleReason(state)) {
    return { ok: false, reason: "cannot stage a Result approval: the Checker verdict in force is bound to a different snapshot of this Work." };
  }
  const reviewHash = await hashResultReviewApproval({
    workId: state.workId,
    expectedResult: review.expectedResult,
    completionCriteria: review.completionCriteria,
    verdictHash: verdict.verdictHash,
  });
  review.pendingApproval = {
    token: crypto.randomUUID(),
    reviewHash,
    createdAt: new Date().toISOString(),
  };
  return { ok: true, pending: review.pendingApproval };
}

/**
 * Records Martin's Result decision at the moment the staged approval is
 * consumed -- the ONLY sanctioned way a Result approval enters WorkState.
 * `token` must match the staged card's own token (the button is bound to the
 * exact card), and the staged approval is cleared as the decision is
 * recorded, so a replayed callback finds nothing left to consume.
 */
export async function resolveResultReviewApprovalDecision(
  state: WorkState,
  decision: { approved: boolean; token: string },
): Promise<{ ok: true; approval?: ResultReviewApproval; rejectedReason?: string } | { ok: false; reason: string }> {
  const review = state.resultReview;
  const staged = review?.pendingApproval;
  if (!staged) {
    return { ok: false, reason: "this Work has no staged Result review approval to consume -- a replayed or stale decision is never recorded." };
  }
  if (!decision.token.trim() || staged.token !== decision.token.trim()) {
    return { ok: false, reason: "the supplied decision token does not match the staged Result review approval -- nothing was recorded." };
  }
  review!.pendingApproval = undefined;
  if (!decision.approved) {
    review!.approval = undefined;
    review!.gateStatus = "blocked";
    review!.blockReason = "Result approval rejected by Martin -- the Result is not accepted; the Work stays open with the rejection visible.";
    return { ok: true, rejectedReason: review!.blockReason };
  }
  const approval: ResultReviewApproval = {
    approver: "martin",
    token: staged.token,
    approvedAt: new Date().toISOString(),
    reviewHash: staged.reviewHash,
  };
  review!.approval = approval;
  review!.gateStatus = "pending";
  review!.blockReason = undefined;
  return { ok: true, approval };
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

/** Returns the stale-reason when the recorded verdict no longer binds to the current snapshot; null when it binds. */
async function verdictStaleReason(state: WorkState): Promise<string | null> {
  const review = state.resultReview!;
  const verdict = review.checker!;
  if (!verdict.checkedAt?.trim()) return "the Checker verification carries no timestamp.";
  if (!verdict.evidenceRefs?.length) return "the Checker verification carries no evidence references.";
  const recomputed = await hashResultReviewVerdict({
    workId: state.workId,
    expectedResult: review.expectedResult!,
    completionCriteria: review.completionCriteria!,
    evidenceRefs: verdict.evidenceRefs,
    outcome: verdict.outcome,
    reason: verdict.reason,
  });
  if (recomputed !== verdict.verdictHash) {
    return "the Checker verification is bound to a different Work, Result, completion criteria or evidence set than this Work now holds.";
  }
  return null;
}

/**
 * THE Result review gate (BD-8 condition 4). Evaluates the current snapshot,
 * records `gateStatus`/`blockReason` on the review, and returns whether a
 * successful closure may proceed. Fail-closed at every step; every refusal
 * reason names the exact missing, invalid, untrusted or mismatched element.
 *
 * Enforcement points: `WorkSession.save` (a success stage flips to
 * `result_review_blocked` when this refuses) and `closeHandoffOnResult`
 * (a successful Handoff closure is refused before any Notion write).
 */
export async function evaluateResultReviewGate(state: WorkState): Promise<{ allowed: boolean; reason?: string }> {
  const refuse = (reason: string): { allowed: false; reason: string } => {
    const review = state.resultReview;
    if (review) {
      review.gateStatus = "blocked";
      review.blockReason = reason;
    }
    return { allowed: false, reason };
  };

  const review = state.resultReview;
  if (!review) return refuse("Result review contract required for successful closure -- this Work's Action declares no expected Result or completion criteria.");
  if (!review.expectedResult?.trim()) {
    return refuse("Result contract missing: the responsible Action declares no expected Result.");
  }
  if (!review.completionCriteria?.length) {
    return refuse("Result contract missing: the responsible Action declares no completion criteria.");
  }

  const verdict = review.checker;
  if (!verdict) return refuse("Independent Checker verification required: no Checker verdict is recorded against this Result.");
  if (verdict.outcome !== "passed") {
    return refuse(verdict.reason ? `Independent Checker verification failed: ${verdict.reason}` : "Independent Checker verification failed.");
  }
  if (!verdict.checkerId?.trim()) return refuse("Checker verification invalid: it records no checker identity.");
  if (verdict.checkerId.trim() === state.actionName || verdict.checkerId.trim() === state.hat) {
    return refuse("Checker verification invalid: the checker identity equals the Work's recorded performer -- BD-8 requires a Checker who did not perform the work.");
  }
  const stale = await verdictStaleReason(state);
  if (stale) return refuse(`Checker verification invalid: ${stale}`);

  const approval = review.approval;
  if (!approval) return refuse("Martin's Result approval required: no Result approval is recorded for this verified Result.");
  if (approval.approver !== "martin") return refuse("Result approval invalid: it is not Martin's Result approval.");
  if (!approval.token?.trim() || !approval.approvedAt?.trim()) {
    return refuse("Result approval invalid: it carries no approval token or timestamp.");
  }
  const approvalHash = await hashResultReviewApproval({
    workId: state.workId,
    expectedResult: review.expectedResult,
    completionCriteria: review.completionCriteria,
    verdictHash: verdict.verdictHash,
  });
  if (approval.reviewHash !== approvalHash) {
    return refuse("Result approval invalid: it is bound to a different Work, Result, completion criteria or Checker verdict than this Work now holds.");
  }

  review.gateStatus = "passed";
  review.blockReason = undefined;
  return { allowed: true };
}

/**
 * Applies the Result review gate to a WorkState during save(), exactly as
 * WorkSession.save() does. Extracted so the gate logic can be exercised
 * without importing the Durable Object (which cannot be loaded under the
 * Node test runner).
 *
 * Behavior-preserving: save() calls this with its own reportBlocked
 * callback, so the same mutation, stage flip, and blockedReason retention
 * happen in production and in tests.
 *
 * Returns { blocked: true, reason } when a successful closure was refused
 * (stage flipped to result_review_blocked, blockedReason retained), or
 * { blocked: false } when the Work passes through unblocked (no contract,
 * or gate allowed).
 */
export async function applyResultReviewGate(
  state: WorkState,
  reportBlocked: (state: WorkState, reason?: string) => Promise<void>
): Promise<{ blocked: boolean; reason?: string }> {
  if (!isSuccessfulResultStage(state.stage) || !state.resultReview) {
    return { blocked: false };
  }
  const wasBlocked = state.resultReview.gateStatus === "blocked";
  const gate = await evaluateResultReviewGate(state);
  if (!gate.allowed) {
    state.stage = RESULT_REVIEW_BLOCKED_STAGE;
    if (!state.blockedReason) state.blockedReason = gate.reason ?? "Result review gate failed";
    if (state.resultReview && !state.resultReview.blockReason) state.resultReview.blockReason = state.blockedReason;
    if (!wasBlocked) await reportBlocked(state, gate.reason);
    return { blocked: true, reason: gate.reason };
  }
  return { blocked: false };
}
