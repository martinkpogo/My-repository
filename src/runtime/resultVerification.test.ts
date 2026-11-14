import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  RESULT_VERIFICATION_AUTHORITY_PAGE_ID,
  RESULT_VERIFICATION_TASK_ID,
  VERIFY_WORK_RESULT_CAPABILITY,
  assembleResultVerificationEvidence,
  needsResultVerification,
  parseResultVerificationAuthority,
  runMachineryResultVerification,
  type ResultVerificationDeps,
} from "./resultVerification";
import {
  RESULT_REVIEW_BLOCKED_STAGE,
  ensureResultReviewContract,
  evaluateResultReviewGate,
  recordCheckerVerdict,
  recordResultEvidence,
  stageResultReviewApproval,
} from "../resultReview";
import type { WorkState } from "../types";

/**
 * BD-13 Machinery Worker Result verification -- the Work lifecycle's
 * independent Checker path (src/runtime/resultVerification.ts). Covers
 * every fail-closed condition the design requires: missing/incomplete
 * Result contract, Checker-independence guard, absent/malformed authority
 * assignment (Martin's BD-12 recording), missing producing-Unit evidence,
 * an unusable check result, and the separation that a PASS is verification
 * and NEVER Martin's Result approval. Plus the loop-freedom guarantee:
 * needsResultVerification is true exactly when the verdict in force no
 * longer covers the Work's current snapshot.
 *
 * All I/O is injected through ResultVerificationDeps (the authority-page
 * read and the independent check), so no Notion call and no AI call ever
 * happens in these tests -- the production wiring (resultVerificationDeps
 * and WorkSession.save's trigger) is pinned as source text at the bottom,
 * same discipline as resultReview.test.ts applies to WorkSession.
 */

const AUTHORITY_PAGE = `# Operations

Some prose about operations.

result_verification_authority:
  machinery_worker_id: Machinery Worker Alpha
  granted_by: martin
  granted_capabilities: [verify_work_result]

next_top_level_section:
  key: value
`;

function baseState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-verify-1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "delivered",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  } as WorkState;
}

const CONTRACT = {
  expectedResult: "A completed diagnosis delivered to the Workspace.",
  completionCriteria: ["All five elements present.", "Every fact traces to Call Notes."],
} as const;

/** A contract-declared Work with the producing Unit's own Result evidence recorded. */
async function evidencedState(overrides: Partial<WorkState> = {}): Promise<WorkState> {
  const state = baseState(overrides);
  ensureResultReviewContract(state, CONTRACT);
  const recorded = await recordResultEvidence(state, [
    {
      kind: "diagnosis",
      ref: "DIAG-1",
      note: "the five-element diagnosis",
      content: "Symptom: falling margins. Problem: pricing. Cause: discounting. Constraint: contracts. Consequence: erosion.",
    },
  ]);
  assert.ok(recorded.ok, `evidence should record: ${!recorded.ok ? recorded.reason : ""}`);
  return state;
}

function deps(overrides: Partial<ResultVerificationDeps> = {}): ResultVerificationDeps {
  return {
    fetchAuthorityPage: async () => AUTHORITY_PAGE,
    runCheck: async () => ({ outcome: "pass", reason: "both criteria met by DIAG-1." }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authority parsing.
// ---------------------------------------------------------------------------

test("authority: a complete Martin-granted block parses to the Machinery Worker identity", () => {
  const parsed = parseResultVerificationAuthority(AUTHORITY_PAGE);
  assert.strictEqual(parsed.ok, true);
  if (parsed.ok) {
    assert.strictEqual(parsed.authority.machineryWorkerId, "Machinery Worker Alpha");
    assert.strictEqual(parsed.authority.grantedBy, "martin");
    assert.ok(parsed.authority.grantedCapabilities.includes(VERIFY_WORK_RESULT_CAPABILITY));
  }
});

test("authority: a flat (column-0) YAML block parses the same as an indented one, stopping at the next unknown key", () => {
  const flat = [
    "result_verification_authority:",
    "machinery_worker_id: Machinery Worker Beta",
    "granted_by: martin",
    "granted_capabilities: [verify_work_result]",
    "",
    "unrelated_section:",
    "  key: value",
  ].join("\n");
  const parsed = parseResultVerificationAuthority(flat);
  assert.strictEqual(parsed.ok, true);
  if (parsed.ok) assert.strictEqual(parsed.authority.machineryWorkerId, "Machinery Worker Beta");
});

test("authority: bullet-list capabilities parse, and a capability list missing verify_work_result fails closed", () => {
  const bullets = [
    "result_verification_authority:",
    "  machinery_worker_id: Machinery Worker Gamma",
    "  granted_by: martin",
    "  granted_capabilities:",
    "    - verify_work_result",
    "    - something_else",
    "  other_key: stops-the-list",
  ].join("\n");
  const ok = parseResultVerificationAuthority(bullets);
  assert.strictEqual(ok.ok, true);
  if (ok.ok) assert.deepStrictEqual(ok.authority.grantedCapabilities, ["verify_work_result", "something_else"]);

  const missingCapability = bullets.replace("    - verify_work_result\n", "");
  const bad = parseResultVerificationAuthority(missingCapability);
  assert.strictEqual(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /not granted the `verify_work_result` capability/);
});

test("authority: no anchor block fails closed with the BD-12-not-recorded reason", () => {
  const parsed = parseResultVerificationAuthority("# Operations\n\nJust prose, no assignment.\n");
  assert.strictEqual(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /declares no `result_verification_authority` block/);
});

test("authority: a block with no machinery_worker_id fails closed naming that exact gap", () => {
  const parsed = parseResultVerificationAuthority("result_verification_authority:\n  granted_by: martin\n  granted_capabilities: [verify_work_result]\n");
  assert.strictEqual(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /declares no `machinery_worker_id`/);
});

test("authority: a grant not from Martin fails closed -- only Martin grants verification authority", () => {
  const page = "result_verification_authority:\n  machinery_worker_id: MW-X\n  granted_by: someone_else\n  granted_capabilities: [verify_work_result]\n";
  const parsed = parseResultVerificationAuthority(page);
  assert.strictEqual(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /not Martin's grant/);
});

// ---------------------------------------------------------------------------
// Evidence assembly.
// ---------------------------------------------------------------------------

test("assembly: always carries the Work record, then Handoff, external operations and the Unit's own recorded evidence -- deduped, content-bounded", async () => {
  const state = await evidencedState({
    handoffId: "handoff-9",
    externalOperations: {
      op1: {
        work_id: "work-verify-1",
        tool_id: "google_doc",
        operation_id: "op1",
        version: "1",
        target_resource_id: "doc-1",
        status: "succeeded",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    },
  });
  const { refs, items } = assembleResultVerificationEvidence(state);
  assert.strictEqual(refs[0]?.kind, "work_record");
  assert.strictEqual(refs[0]?.ref, "work-verify-1");
  assert.ok(refs.some((r) => r.kind === "handoff" && r.ref === "handoff-9"));
  assert.ok(refs.some((r) => r.kind === "external_operation" && r.ref === "op1"));
  assert.ok(refs.some((r) => r.kind === "diagnosis" && r.ref === "DIAG-1"));
  // Dedupe: one ref per kind+ref.
  const keys = refs.map((r) => `${r.kind}:${r.ref}`);
  assert.strictEqual(new Set(keys).size, keys.length);
  // Every item carries content, bounded by the recorder's own bound.
  for (const item of items) assert.ok(item.content.length <= 4000);
});

// ---------------------------------------------------------------------------
// The re-verification trigger (loop freedom).
// ---------------------------------------------------------------------------

test("needsResultVerification: no verdict -> true; fresh verdict over the same refs -> false (no loop)", async () => {
  const state = await evidencedState();
  assert.strictEqual(await needsResultVerification(state), true, "a Work with no verdict must verify");

  const recorded = await recordCheckerVerdict(state, {
    checkerId: "Machinery Worker Alpha",
    outcome: "passed",
    reason: "criteria met.",
    evidenceRefs: assembleResultVerificationEvidence(state).refs,
  });
  assert.ok(recorded.ok, `verdict should record: ${!recorded.ok ? recorded.reason : ""}`);
  assert.strictEqual(await needsResultVerification(state), false, "an unchanged snapshot with a fresh verdict must NOT re-verify");
});

test("needsResultVerification: changed evidence refs -> true (the verdict no longer covers the current snapshot)", async () => {
  const state = await evidencedState();
  const recorded = await recordCheckerVerdict(state, {
    checkerId: "Machinery Worker Alpha",
    outcome: "passed",
    reason: "criteria met.",
    evidenceRefs: assembleResultVerificationEvidence(state).refs,
  });
  assert.ok(recorded.ok);
  assert.strictEqual(await needsResultVerification(state), false);

  // The producing Unit records a NEW evidence item: refs differ, so the
  // verdict in force must be re-verified against the new set.
  const reRecorded = await recordResultEvidence(state, [
    { kind: "diagnosis", ref: "DIAG-1", content: "updated content" },
    { kind: "call_notes", ref: "CN-7", content: "the call notes the diagnosis traces to" },
  ]);
  assert.ok(reRecorded.ok);
  assert.strictEqual(await needsResultVerification(state), true, "changed evidence must trigger re-verification");
});

test("needsResultVerification: no Result contract declared -> false (nothing to verify; the gate refuses with its own reason)", async () => {
  const state = baseState();
  assert.strictEqual(await needsResultVerification(state), false);
});

// ---------------------------------------------------------------------------
// The verification run.
// ---------------------------------------------------------------------------

test("run: a PASS records an independent verdict bound to the exact snapshot -- but stages NO approval (PASS is not approval)", async () => {
  const state = await evidencedState();
  const run = await runMachineryResultVerification(state, deps());
  assert.strictEqual(run.recorded, true);
  if (run.recorded) {
    assert.strictEqual(run.outcome, "passed");
    assert.ok(run.snapshotKey);
  }
  const verdict = state.resultReview?.checker;
  assert.ok(verdict, "a PASS must record the Checker verdict");
  assert.strictEqual(verdict.checkerId, "Machinery Worker Alpha");
  assert.strictEqual(verdict.outcome, "passed");
  assert.strictEqual(state.resultReview?.approval, undefined, "a PASS must NEVER record Martin's approval");
  assert.strictEqual(state.resultReview?.pendingApproval, undefined, "a PASS must never stage the approval card itself");

  // Martin's approval is still required: the gate refuses, and it refuses
  // naming the missing approval -- verification and approval stay separate.
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /no Result approval is recorded/);

  // The audit record is present and names this snapshot.
  assert.strictEqual(state.resultReview?.verificationAttempt?.outcome, "passed");
  assert.strictEqual(state.resultReview?.verificationAttempt?.snapshotKey, run.snapshotKey);

  // The approval card is staged only through the sanctioned staging path,
  // which then still leaves the gate refused until Martin decides.
  const staged = await stageResultReviewApproval(state);
  assert.ok(staged.ok, "a passing bound verdict can stage Martin's card");
  const afterStage = await evaluateResultReviewGate(state);
  assert.strictEqual(afterStage.allowed, false, "staged approval is not recorded approval");
  assert.match(afterStage.reason ?? "", /no Result approval is recorded/);
});

test("run: a FAIL records a failed verdict carrying the checker's exact reason", async () => {
  const state = await evidencedState();
  const run = await runMachineryResultVerification(
    state,
    deps({ runCheck: async () => ({ outcome: "fail", reason: "criterion 2 unmet: no fact traces to Call Notes." }) }),
  );
  assert.strictEqual(run.recorded, true);
  if (run.recorded) assert.strictEqual(run.outcome, "failed");
  const verdict = state.resultReview?.checker;
  assert.strictEqual(verdict?.outcome, "failed");
  assert.match(verdict?.reason ?? "", /criterion 2 unmet/);
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /verification failed: criterion 2 unmet/);
  assert.strictEqual(state.resultReview?.verificationAttempt?.outcome, "failed");
});

test("run: missing producing-Unit evidence fails closed as a FAILED verdict naming evidence insufficiency", async () => {
  const state = baseState();
  ensureResultReviewContract(state, CONTRACT);
  // No recordResultEvidence call happened at Result production.
  const run = await runMachineryResultVerification(state, deps());
  assert.strictEqual(run.recorded, true, "missing evidence is a substantive FAILED check, not an unavailable one");
  if (run.recorded) assert.strictEqual(run.outcome, "failed");
  assert.match(state.resultReview?.checker?.reason ?? "", /recorded no Result evidence/);
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
});

test("run: an incomplete Result contract records NOTHING (fail closed, specific reason)", async () => {
  const state = baseState();
  ensureResultReviewContract(state, { expectedResult: "something", completionCriteria: [] });
  const run = await runMachineryResultVerification(state, deps());
  assert.strictEqual(run.recorded, false);
  if (!run.recorded) assert.match(run.unavailableReason, /no complete Result contract/);
  assert.strictEqual(state.resultReview?.checker, undefined, "no contract, no verdict");
  assert.strictEqual(state.resultReview?.verificationAttempt?.outcome, "unavailable");
});

test("run: the independence guard -- verification never verifies Operations' or Result Verification's own Work", async () => {
  const operations = await evidencedState({ unit: "Operations", hat: undefined, actionName: undefined });
  const opRun = await runMachineryResultVerification(operations, deps());
  assert.strictEqual(opRun.recorded, false);
  if (!opRun.recorded) assert.match(opRun.unavailableReason, /cannot verify its own Work/);
  assert.strictEqual(operations.resultReview?.checker, undefined);

  const checkerWork = await evidencedState({ hat: "Result Verification" });
  const checkerRun = await runMachineryResultVerification(checkerWork, deps());
  assert.strictEqual(checkerRun.recorded, false);
  if (!checkerRun.recorded) assert.match(checkerRun.unavailableReason, /cannot verify its own Work/);
  assert.strictEqual(checkerWork.resultReview?.checker, undefined);
});

test("run: an unreadable authority page fails closed with the fetch reason, recording nothing", async () => {
  const state = await evidencedState();
  const run = await runMachineryResultVerification(
    state,
    deps({ fetchAuthorityPage: async () => { throw new Error("page deleted"); } }),
  );
  assert.strictEqual(run.recorded, false);
  if (!run.recorded) assert.match(run.unavailableReason, /could not be read.*page deleted/);
  assert.strictEqual(state.resultReview?.checker, undefined, "an unavailable verification must never record a verdict");
  assert.strictEqual(state.resultReview?.verificationAttempt?.outcome, "unavailable");
  assert.match(state.resultReview?.verificationAttempt?.reason ?? "", /page deleted/);
});

test("run: an authority page missing the assignment fails closed with Martin's exact BD-12 gap, recording nothing", async () => {
  const state = await evidencedState();
  const run = await runMachineryResultVerification(state, deps({ fetchAuthorityPage: async () => "# Operations\n\nprose only\n" }));
  assert.strictEqual(run.recorded, false);
  if (!run.recorded) assert.match(run.unavailableReason, /BD-12 Machinery Worker assignment is not recorded/);
  assert.strictEqual(state.resultReview?.checker, undefined);
});

test("run: a check that yields no usable verdict (null / malformed outcome / empty reason) fails closed, recording nothing", async () => {
  for (const runCheck of [
    async () => null,
    async () => ({ outcome: "maybe" as unknown as "pass", reason: "x" }),
    async () => ({ outcome: "pass" as const, reason: "   " }),
  ]) {
    const state = await evidencedState();
    const run = await runMachineryResultVerification(state, deps({ runCheck }));
    assert.strictEqual(run.recorded, false, "an unusable check result must never record a verdict");
    if (!run.recorded) assert.match(run.unavailableReason, /no usable verdict/);
    assert.strictEqual(state.resultReview?.checker, undefined);
  }
});

test("run: a check that throws is treated the same as one yielding nothing (fail closed)", async () => {
  const state = await evidencedState();
  const run = await runMachineryResultVerification(
    state,
    deps({ runCheck: async () => { throw new Error("provider exploded"); } }),
  );
  assert.strictEqual(run.recorded, false);
  if (!run.recorded) assert.match(run.unavailableReason, /no usable verdict/);
  assert.strictEqual(state.resultReview?.checker, undefined);
});

test("run: the verdict is bound to THIS Work -- the same snapshot on a different Work hashes differently", async () => {
  const a = await evidencedState();
  const b = await evidencedState({ workId: "work-verify-2" });
  const runA = await runMachineryResultVerification(a, deps());
  const runB = await runMachineryResultVerification(b, deps());
  assert.strictEqual(runA.recorded, true);
  assert.strictEqual(runB.recorded, true);
  if (runA.recorded && runB.recorded) {
    assert.notStrictEqual(runA.snapshotKey, runB.snapshotKey, "a different Work must never share a snapshot key");
  }
});

// ---------------------------------------------------------------------------
// Production wiring, pinned as source text (WorkSession and the AI call
// cannot be exercised end-to-end here: DurableObject cannot load under the
// Node test runner, and the real generate() path needs live providers).
// ---------------------------------------------------------------------------

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), "utf8");

test("WorkSession.save triggers the Machinery Worker verification BEFORE the gate, for success and blocked stages only", () => {
  const src = read("../session.ts");
  assert.match(src, /needsResultVerification\(state\)/, "save() must consult needsResultVerification before the gate");
  assert.match(
    src,
    /isSuccessfulResultStage\(state\.stage\) \|\| state\.stage === RESULT_REVIEW_BLOCKED_STAGE/,
    "verification runs for a success stage or an already-blocked Work, never for in-flight Work",
  );
  assert.match(src, /runMachineryResultVerification\(state, resultVerificationDeps\(this\.env\)\)/, "save() must run the verification with production deps");
  const verifyAt = src.indexOf("needsResultVerification(state)");
  const gateAt = src.indexOf("await applyResultReviewGate(state,");
  assert.ok(verifyAt >= 0 && gateAt > verifyAt, "verification must run BEFORE the gate so the block message carries the fresh reason");
});

test("WorkSession restores the pre-block stage on Martin's approval and retries the refused Handoff closure", () => {
  const src = read("../session.ts");
  assert.match(src, /review\?\.preBlockStage && state\.stage === RESULT_REVIEW_BLOCKED_STAGE/, "the resultreview callback must restore the remembered success stage");
  assert.match(src, /state\.stage = review\.preBlockStage/, "restoring means putting the remembered stage back");
  assert.match(src, /state\.resultReview\?\.gateStatus === \"passed\" && state\.resultReview\.pendingClosure/, "save() must retry the refused closure only once the gate actually passes");
  assert.match(src, /closeHandoffOnResult\(this\.env, state, pending\.handoffId, pending\.resultNote/, "the retry re-runs the exact refused closure payload");
});

test("production deps read the authority page from the canonical Operations page and run the check under the registered task id", () => {
  const src = read("resultVerification.ts");
  assert.match(src, /getPageContent\(env, RESULT_VERIFICATION_AUTHORITY_PAGE_ID, systemContext\(\)\)/, "the authority page must be read live from Notion, never hard-coded");
  assert.match(src, /RESULT_VERIFICATION_TASK_ID,\n?\s*mode: "json"/, "the check must run through generate() under this task's own SemanticTaskId");
  assert.match(src, /taskId: RESULT_VERIFICATION_TASK_ID/, "the check must carry the registered task id");
  assert.strictEqual(RESULT_VERIFICATION_TASK_ID, "work.result_verification");
  assert.strictEqual(RESULT_VERIFICATION_AUTHORITY_PAGE_ID, "3cecb004-e583-8104-961e-dba9e2a915e7");
});

test("resultVerificationDeps: the prompt carries only the token-safe snapshot (contract + recorded evidence), never raw enquiry text", () => {
  const src = read("resultVerification.ts");
  assert.doesNotMatch(src, /enquiryText/, "the verification prompt must never touch raw enquiry text");
  // The situation text is built from the snapshot ids/contract and the
  // recorded evidence items only.
  assert.match(src, /Work \$\{snapshot\.workId\}/, "the situation identifies the Work by canonical id");
  assert.match(src, /evidenceText/, "the situation carries the recorded evidence");
});

test("the verification evidence assembly and the Unit recorders share one sanctioned entry point", () => {
  // recordResultEvidence is the ONLY sanctioned way evidence enters
  // WorkState; the assembly only reads it. No second evidence path exists.
  const resultReviewSrc = read("../resultReview.ts");
  assert.match(resultReviewSrc, /export async function recordResultEvidence/, "the recorder stays the one sanctioned entry point");
  const verifySrc = read("resultVerification.ts");
  assert.match(verifySrc, /state\.resultReview\?\.evidence/, "assembly reads the recorded set, it never writes one");
  assert.doesNotMatch(verifySrc, /state\.resultReview!\.evidence =/, "assembly must never assign evidence");
});

test("the blocked-stage recovery state (preBlockStage/pendingClosure) is declared on the review state", () => {
  const typesSrc = read("../types.ts");
  assert.match(typesSrc, /preBlockStage\?: string/, "the remembered success stage must live on ResultReviewState");
  assert.match(typesSrc, /pendingClosure\?: \{ handoffId: string; resultNote: string \}/, "the refused closure payload must live on ResultReviewState");
  assert.match(typesSrc, /verificationAttempt\?:/, "the audit record of the last attempt must live on ResultReviewState");
  assert.match(typesSrc, /gateStatus: \"pending\" \| \"blocked\" \| \"passed\"/, "gateStatus must remain a required field of ResultReviewState");
  assert.strictEqual(RESULT_REVIEW_BLOCKED_STAGE, "result_review_blocked");
});

test("Checker prompt names the exact answer shape (2026-11-14): outcome pass|fail and a reason -- the shape the parser accepts", async () => {
  const { buildResultCheckPromptParts, RESULT_CHECK_RESPONSE_FORMAT } = await import("./resultVerification");
  const parts = buildResultCheckPromptParts(
    { workId: "w1", unit: "Marketing", hat: "Marketing Strategist", action: "handle_request", stage: "delivered", expectedResult: "A draft", completionCriteria: ["It answers the task"] } as any,
    { machineryWorkerId: "MW-1" } as any,
    "[1] draft (x)\nbody",
  );
  assert.ok(parts.context.includes(RESULT_CHECK_RESPONSE_FORMAT));
  assert.match(RESULT_CHECK_RESPONSE_FORMAT, /\{"outcome": "pass", "reason"/);
  assert.match(RESULT_CHECK_RESPONSE_FORMAT, /exactly "pass" or "fail"/);
  assert.match(parts.skillContent, /PASS only when every criterion is met/, "what the Checker judges is unchanged");
});
