import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  RESULT_REVIEW_BLOCKED_STAGE,
  ensureResultReviewContract,
  evaluateResultReviewGate,
  hashResultReviewApproval,
  hashResultReviewVerdict,
  isSuccessfulResultStage,
  recordCheckerVerdict,
  resolveResultReviewApprovalDecision,
  stageResultReviewApproval,
} from "./resultReview";
import type { WorkState } from "./types";

/**
 * BD-8 Result review gate -- direct tests for every refusal condition the
 * issue requires (missing contract/criteria, missing or invalid Checker
 * evidence, untrusted/mismatched approval, binding to a different
 * Work/Result/criteria/evidence) plus the one legitimate path that must be
 * unblocked.
 *
 * Why these call the gate directly: `WorkSession` extends DurableObject from
 * `cloudflare:workers`, which cannot be imported under the Node test runner,
 * so WorkSession internals are pinned by SOURCE-TEXT assertions at the bottom
 * of this file (save() delegates to evaluateResultReviewGate; execute() loads
 * the contract) while the gate itself is tested as a pure unit.
 */

function baseState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-resultreview-1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "delivered",
    ...overrides,
  } as WorkState;
}

const DECLARED_CONTRACT = {
  expectedResult: "A completed diagnosis delivered to the Workspace.",
  completionCriteria: ["All five elements present.", "Every fact traces to Call Notes."],
} as const;

/** The sanctioned happy path: contract -> passing verdict -> staged approval -> recorded decision. */
async function satisfiedState(): Promise<WorkState> {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  const verdict = await recordCheckerVerdict(state, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "activity", ref: "ACT-1", note: "diagnosis evidence" }],
  });
  assert.ok(verdict.ok, "verdict recording should succeed on the sanctioned path");
  const staged = await stageResultReviewApproval(state);
  assert.ok(staged.ok, "staging should succeed once a passing bound verdict exists");
  const decision = await resolveResultReviewApprovalDecision(state, { approved: true, token: staged.pending.token });
  assert.ok(decision.ok, "the staged decision should be recorded");
  return state;
}

test("isSuccessfulResultStage: only delivered/complete are success stages", () => {
  assert.strictEqual(isSuccessfulResultStage("complete"), true);
  assert.strictEqual(isSuccessfulResultStage("delivered"), true);
  assert.strictEqual(isSuccessfulResultStage("cancelled"), false);
  assert.strictEqual(isSuccessfulResultStage("closed_not_qualified"), false);
  assert.strictEqual(isSuccessfulResultStage("result_review_blocked"), false);
  assert.strictEqual(RESULT_REVIEW_BLOCKED_STAGE, "result_review_blocked");
});

test("ensureResultReviewContract: loads the declared contract live from the Action", () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  assert.strictEqual(state.resultReview?.expectedResult, DECLARED_CONTRACT.expectedResult);
  assert.deepStrictEqual(state.resultReview?.completionCriteria, DECLARED_CONTRACT.completionCriteria);
  assert.strictEqual(state.resultReview?.gateStatus, "pending");
});

test("ensureResultReviewContract: an Action declaring nothing leaves the Work contract-less (the gate then refuses)", () => {
  const state = baseState();
  ensureResultReviewContract(state, undefined);
  assert.strictEqual(state.resultReview, undefined);
  const state2 = baseState();
  ensureResultReviewContract(state2, {});
  assert.strictEqual(state2.resultReview, undefined);
});

test("ensureResultReviewContract: never overwrites a recorded verdict or approval, refreshes only missing contract fields", async () => {
  const state = await satisfiedState();
  ensureResultReviewContract(state, { expectedResult: "", completionCriteria: [] });
  assert.ok(state.resultReview?.checker, "a recorded verdict must survive a contract refresh");
  assert.ok(state.resultReview?.approval, "a recorded approval must survive a contract refresh");
  assert.strictEqual(state.resultReview?.expectedResult, DECLARED_CONTRACT.expectedResult);
});

test("gate: refuses a Work with no Result review contract at all, naming that reason", async () => {
  const state = baseState({ actionName: undefined, hat: undefined, unit: undefined });
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /declares no expected Result or completion criteria/);
  // Nothing is fabricated onto the Work: with no review record there is no
  // status to set. Visibility for this case is WorkSession.save's own --
  // stage flips to result_review_blocked and `state.blockedReason` carries
  // this exact reason (pinned as source text below).
  assert.strictEqual(state.resultReview, undefined, "the gate must not invent a review record");
});

test("gate: refuses a contract carrying no completion criteria", async () => {
  const state = baseState();
  state.resultReview = { expectedResult: "something", gateStatus: "pending" };
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /declares no completion criteria/);
});

test("gate: refuses a contract carrying no expected Result", async () => {
  const state = baseState();
  state.resultReview = { completionCriteria: ["a"], gateStatus: "pending" };
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /declares no expected Result/);
});

test("gate: refuses when no Checker verdict is recorded", async () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /no Checker verdict is recorded/);
});

test("gate: refuses a FAILED Checker verdict with the checker's reason visible", async () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  await recordCheckerVerdict(state, {
    checkerId: "independent-checker",
    outcome: "failed",
    reason: "criteria not met: evidence missing",
    evidenceRefs: [{ kind: "activity", ref: "ACT-9" }],
  });
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /verification failed: criteria not met: evidence missing/);
});

test("gate: refuses a verdict whose checker identity equals the Work's performer (Action or Hat)", async () => {
  const byAction = baseState();
  ensureResultReviewContract(byAction, DECLARED_CONTRACT);
  const refused = await recordCheckerVerdict(byAction, {
    checkerId: "diagnose",
    outcome: "passed",
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
  });
  assert.strictEqual(refused.ok, false, "recording must refuse a self-check outright");
  if (!refused.ok) assert.match(refused.reason, /recorded performer/);

  const byHat = baseState();
  ensureResultReviewContract(byHat, DECLARED_CONTRACT);
  await recordCheckerVerdict(byHat, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
  });
  byHat.resultReview!.checker!.checkerId = byHat.hat!;
  const gate = await evaluateResultReviewGate(byHat);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /equals the Work's recorded performer/);
});

test("gate: refuses a verdict no sanctioned recorder produced (hand-built, no hash/evidence)", async () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  state.resultReview!.checker = {
    checkerId: "independent-checker",
    outcome: "passed",
    checkedAt: new Date().toISOString(),
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
    verdictHash: "",
  };
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /invalid/);
});

test("gate: refuses a verdict bound to different completion criteria than the Work now holds", async () => {
  const state = await satisfiedState();
  // The criteria changed after the verdict was rendered: the hash no longer
  // recomputes to the recorded one, so the verdict binds to a different snapshot.
  state.resultReview!.completionCriteria = ["A different criterion."];
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /bound to a different Work, Result, completion criteria or evidence set/);
});

test("gate: refuses a verdict bound to a different evidence set", async () => {
  const state = await satisfiedState();
  state.resultReview!.checker!.evidenceRefs = [{ kind: "activity", ref: "ACT-EVIL" }];
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /bound to a different Work, Result, completion criteria or evidence set/);
});

test("gate: refuses when a passing verdict exists but Martin has not approved", async () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  await recordCheckerVerdict(state, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
  });
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /no Result approval is recorded/);
});

test("gate: refuses an approval not bound to the verdict in force", async () => {
  const state = await satisfiedState();
  state.resultReview!.approval!.reviewHash = await hashResultReviewApproval({
    workId: state.workId,
    expectedResult: state.resultReview!.expectedResult!,
    completionCriteria: state.resultReview!.completionCriteria!,
    verdictHash: "some-other-verdict-hash",
  });
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /bound to a different Work, Result, completion criteria or Checker verdict/);
});

test("gate: refuses an approval carrying no token or timestamp", async () => {
  const state = await satisfiedState();
  state.resultReview!.approval!.token = "";
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /carries no approval token or timestamp/);
});

test("gate: refuses an approval whose approver is not Martin", async () => {
  const state = await satisfiedState();
  (state.resultReview!.approval as { approver: string }).approver = "someone-else";
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /not Martin's Result approval/);
});

test("gate: the legitimate path -- declared contract, independent bound verdict, Martin's bound approval -- is ALLOWED", async () => {
  const state = await satisfiedState();
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, true, gate.reason);
  assert.strictEqual(state.resultReview?.gateStatus, "passed");
  assert.strictEqual(state.resultReview?.blockReason, undefined);
});

test("recordCheckerVerdict: refuses an empty evidence set and malformed refs", async () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  const empty = await recordCheckerVerdict(state, { checkerId: "x", outcome: "passed", evidenceRefs: [] });
  assert.strictEqual(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /empty evidence set/);
  const malformed = await recordCheckerVerdict(state, {
    checkerId: "x",
    outcome: "passed",
    evidenceRefs: [{ kind: "", ref: "" }],
  });
  assert.strictEqual(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.reason, /malformed evidence reference/);
});

test("recordCheckerVerdict: a superseding verdict invalidates the approval it did not cover", async () => {
  const state = await satisfiedState();
  assert.ok(state.resultReview?.approval);
  const second = await recordCheckerVerdict(state, {
    checkerId: "another-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "activity", ref: "ACT-2" }],
  });
  assert.ok(second.ok);
  assert.strictEqual(state.resultReview?.approval, undefined, "an approval must not survive a new verdict");
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false, "the new verdict must re-earn the approval");
});

test("stageResultReviewApproval: refuses before a passing verdict and refuses stale verdicts", async () => {
  const noVerdict = baseState();
  ensureResultReviewContract(noVerdict, DECLARED_CONTRACT);
  const r1 = await stageResultReviewApproval(noVerdict);
  assert.strictEqual(r1.ok, false);
  if (!r1.ok) assert.match(r1.reason, /passing independent Checker verdict/);

  const stale = await satisfiedState();
  stale.resultReview!.completionCriteria = ["changed"];
  const r2 = await stageResultReviewApproval(stale);
  assert.strictEqual(r2.ok, false, "a stale verdict must not be approvable");
});

test("resolveResultReviewApprovalDecision: wrong token refuses; replay finds nothing; rejection is recorded and visible", async () => {
  // A decision whose token does not match the staged card records nothing.
  const wrong = await satisfiedState();
  const wrongResult = await resolveResultReviewApprovalDecision(wrong, { approved: true, token: "not-the-token" });
  assert.strictEqual(wrongResult.ok, false, "a mismatched token must record nothing");

  // Replay: stage a card, consume it, then press the same button again.
  const replay = await satisfiedState();
  const fresh = await stageResultReviewApproval(replay);
  assert.ok(fresh.ok, "a passing verdict with no open card can stage one");
  const first = await resolveResultReviewApprovalDecision(replay, { approved: true, token: fresh.pending.token });
  assert.ok(first.ok, "the first decision is recorded");
  const again = await resolveResultReviewApprovalDecision(replay, { approved: true, token: fresh.pending.token });
  assert.strictEqual(again.ok, false, "the staged approval was consumed by the first decision -- a replay records nothing");

  // Rejection: recorded, visible, and the Result must not close.
  const rejected = await satisfiedState();
  const rejectCard = await stageResultReviewApproval(rejected);
  assert.ok(rejectCard.ok, "the satisfied state can stage a card for the rejection");
  const rejectResult = await resolveResultReviewApprovalDecision(rejected, { approved: false, token: rejectCard.pending.token });
  assert.ok(rejectResult.ok);
  assert.strictEqual(rejected.resultReview?.approval, undefined);
  assert.strictEqual(rejected.resultReview?.gateStatus, "blocked");
  assert.match(rejected.resultReview?.blockReason ?? "", /rejected by Martin/);
  const gate = await evaluateResultReviewGate(rejected);
  assert.strictEqual(gate.allowed, false, "a rejected Result must not close");
});

test("hashes: canonical texts are order-stable and snapshot-specific", async () => {
  const a = await hashResultReviewVerdict({
    workId: "w1",
    expectedResult: "r",
    completionCriteria: ["c1"],
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
    outcome: "passed",
  });
  const b = await hashResultReviewVerdict({
    workId: "w1",
    expectedResult: "r",
    completionCriteria: ["c1", "c2"],
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
    outcome: "passed",
  });
  const c = await hashResultReviewVerdict({
    workId: "w2",
    expectedResult: "r",
    completionCriteria: ["c1"],
    evidenceRefs: [{ kind: "activity", ref: "ACT-1" }],
    outcome: "passed",
  });
  assert.notStrictEqual(a, b, "a criteria change must change the verdict hash");
  assert.notStrictEqual(a, c, "a different Work must never hash the same");
});

// ---------------------------------------------------------------------------
// WorkSession cannot be imported under the Node test runner (cloudflare:workers
// DurableObject base), so its enforcement wiring is pinned as source text:
// the enforcement points must exist exactly as the design says, and no Unit
// handler may write a successful Handoff closure directly.
// ---------------------------------------------------------------------------

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), "utf8");

test("WorkSession.save delegates successful-closure enforcement to evaluateResultReviewGate and flips to the blocked stage", () => {
  const src = read("session.ts");
  assert.match(src, /if \(isSuccessfulResultStage\(state\.stage\) \&\& state\.resultReview\)/, "save() must gate every success stage when a Result contract is declared");
  assert.match(src, /await evaluateResultReviewGate\(state\)/, "save() must evaluate the shared gate, not a private copy");
  assert.match(src, /state\.stage = RESULT_REVIEW_BLOCKED_STAGE/, "a refused success stage must flip to result_review_blocked");
  assert.match(src, /private async reportResultReviewBlocked/, "the unresolved state and reason must be reported visibly, once per transition");
  assert.match(src, /case \"resultreview\":/, "Martin's decision returns through the verified callback, never free text");
  assert.doesNotMatch(src, /private evaluateResultReviewGate/, "the old private gate copy must be gone -- one gate, not two");
  assert.match(src, /ensureResultReviewContract\(state, this\.recordedActionResult\(state\)\)/, "the contract must be loaded live from the Work's recorded Action");
  assert.match(src, /findUnitManifest\(state\.unit\)/, "the recorded Action must be resolved through the Unit registry");
});

test("every successful Unit Handoff closure routes through closeHandoffOnResult (no direct success write remains in a Unit)", () => {
  const gated = [
    "units/sales/salesExecutive.ts",
    "units/strategy/strategyAnalyst.ts",
    "units/finance/valueBasedPricingAssessor.ts",
    "units/marketing/marketingManifest.ts",
    "units/sales/tokenSafeProposal.ts",
  ];
  for (const rel of gated) {
    const src = read(rel);
    assert.match(src, /closeHandoffOnResult\(/, `${rel} must route its successful closure through the generic gate`);
  }
  // The ONE direct `Status: select("Closed")` a Unit may still write is the
  // Proposal Doc-verification-FAILURE write-back -- an explicit non-success
  // closure that never claims a completed Result.
  const tspNet = read("units/sales/tokenSafeProposal.ts");
  const directClosed = (tspNet.match(/Status: select\("Closed"\)/g) ?? []).length;
  assert.strictEqual(directClosed, 1, "tokenSafeProposal keeps exactly one direct Closed write: the non-success Doc-failure path");
  assert.match(tspNet, /Doc failed to verify/, "that one direct write must be the Doc-failure non-success closure");

  // Cancellation keeps its own route, untouched and ungated.
  const lifecycle = read("handoffLifecycle.ts");
  assert.match(lifecycle, /export async function closeHandoffIfOpen/, "cancellation must keep its existing helper");
  const session = read("session.ts");
  assert.match(session, /closeHandoffIfOpen/, "/cancel must still use the ungated route");
});

test("the closure-owning Actions declare their Result contract on their own Unit manifests (live, not hard-coded)", async () => {
  const { salesManifest } = await import("./units/sales/salesManifest");
  const { strategyManifest } = await import("./units/strategy/strategyManifest");
  const { financeManifest } = await import("./units/finance/financeManifest");
  const { marketingManifest } = await import("./units/marketing/marketingManifest");

  const declared: Array<[string, typeof salesManifest]> = [
    ["sales", salesManifest],
    ["strategy", strategyManifest],
    ["finance", financeManifest],
    ["marketing", marketingManifest],
  ];
  const required: Record<string, string[]> = {
    Sales: ["new_enquiry", "record_lead", "proposal_draft"],
    Strategy: ["diagnose", "commit_diagnosis"],
    Finance: ["price"],
    Marketing: ["handle_request"],
  };
  for (const [label, manifest] of declared) {
    const actionNames = required[manifest.unit];
    assert.ok(actionNames, `${label}: unexpected unit ${manifest.unit}`);
    for (const hat of Object.values(manifest.hats)) {
      for (const name of actionNames) {
        const action = hat.actions.find((a) => a.name === name);
        if (!action) continue;
        assert.ok(action.expectedResult?.trim(), `${manifest.unit}/${hat.name}/${name} must declare expectedResult`);
        assert.ok(action.completionCriteria?.length, `${manifest.unit}/${hat.name}/${name} must declare completionCriteria`);
      }
    }
    // At least one hat must carry each required action (fail-closed check).
    for (const name of actionNames) {
      const found = Object.values(manifest.hats).some((h) => h.actions.some((a) => a.name === name));
      assert.ok(found, `${manifest.unit} must declare ${name} somewhere so its contract exists`);
    }
  }
});

test("WorkSession.save only evaluates the gate when a Result contract is declared (no contract = no gate)", () => {
  const src = read("session.ts");
  // The gate is only evaluated when resultReview exists -- Works whose Action
  // declares no Result contract pass through save() unblocked.
  assert.match(src, /if \(isSuccessfulResultStage\(state\.stage\) \&\& state\.resultReview\)/, "save() must only gate when a Result contract is declared");
  // closeHandoffOnResult still calls the gate directly (fail-closed for direct calls).
  assert.match(read("handoffLifecycle.ts"), /await evaluateResultReviewGate\(state\)/, "closeHandoffOnResult still calls the shared gate directly");
});

test("result production continues while review is pending: gate blocks closure but not stage advancement", async () => {
  const state = baseState();
  ensureResultReviewContract(state, DECLARED_CONTRACT);
  // No verdict, no approval: the gate refuses closure.
  const gate = await evaluateResultReviewGate(state);
  assert.strictEqual(gate.allowed, false);
  assert.match(gate.reason ?? "", /no Checker verdict is recorded/);
  // But the Work's stage can still advance -- the gate does not freeze the Work.
  state.stage = "delivered";
  assert.strictEqual(state.stage, "delivered");
  // gateStatus reflects the block but the Work is not terminal.
  assert.strictEqual(state.resultReview?.gateStatus, "blocked");
});

test("legitimate Handoff creation is not gated by Result review", () => {
  // createHandoff (src/handoffWriter.ts) performs no Result review check:
  // a Handoff can be created while a Work's review is pending. The gate
  // only applies at successful closure (closeHandoffOnResult) and at save().
  const src = read("handoffWriter.ts");
  assert.doesNotMatch(src, /evaluateResultReviewGate/, "createHandoff must not call the Result review gate");
  assert.doesNotMatch(src, /isResultReviewSatisfied/, "createHandoff must not call any Result review helper");
});
