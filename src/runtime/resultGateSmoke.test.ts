import test from "node:test";
import assert from "node:assert";
import type { Env, WorkState } from "../types";
import {
  assessResultGateSmoke,
  martinTelegramChatId,
  newResultGateSmokeWorkId,
  parseResultGateSmokeParams,
  resolveResultGateSmokeAction,
  runResultGateSmoke,
  RESULT_GATE_SMOKE_TARGET,
  type ResultGateSmokeRunner,
} from "./resultGateSmoke";
import {
  isResultGateSmokeWorkId,
  resultGateSmokeArtefact,
  RESULT_GATE_SMOKE_ACTION,
  RESULT_GATE_SMOKE_CRITERIA,
  RESULT_GATE_SMOKE_EXPECTED_RESULT,
} from "./resultGateSmokeContract";
import {
  applyResultReviewGate,
  ensureResultReviewContract,
  recordApprovalRequestDelivery,
  resolveResultReviewApprovalDecision,
  RESULT_REVIEW_BLOCKED_STAGE,
  stageResultReviewApproval,
} from "../resultReview";
import { recordWorkAction } from "../units/dispatch";
import { findUnitManifest } from "../units/registry";
import { resolveActionExecution } from "./actionResolution";
import { workContractForRequest } from "./workContract";
import { handleResultGateSmokeInspect } from "../resultGateSmokeInspect";
import { handleResultGateSmokeRequest } from "../resultGateSmokeRoute";

// ENIG #370, rebuilt on the current gate (16 Nov 2026): the five requirements
// -- read-only inspection, non-circular evidence, truthful reporting, approval
// request separate from Martin's decision, verified final state.

const env = { MARTIN_TELEGRAM_USER_ID: "9999", WORKER_ADMIN_KEY: "admin-secret" } as unknown as Env;
const P = (q: string) => new URLSearchParams(q);
const OK_QUERY = `origin=result_gate_smoke&action=${RESULT_GATE_SMOKE_ACTION}`;

test("query contract: origin and action required and exact; only known params, once; work_id must be a smoke id", () => {
  assert.deepStrictEqual(parseResultGateSmokeParams(P(OK_QUERY)), { ok: true });
  for (const q of ["action=result_gate_smoke_test", "origin=result_gate_smoke", "origin=direct_request&action=result_gate_smoke_test", "origin=result_gate_smoke&action=diagnose", `${OK_QUERY}&unit=Sales`, `${OK_QUERY}&origin=result_gate_smoke`, `${OK_QUERY}&work_id=abc`]) {
    assert.strictEqual(parseResultGateSmokeParams(P(q)).ok, false, q);
  }
  const id = newResultGateSmokeWorkId();
  assert.ok(isResultGateSmokeWorkId(id));
  assert.deepStrictEqual(parseResultGateSmokeParams(P(`${OK_QUERY}&work_id=${id}&key=x`)), { ok: true, work_id: id });
  assert.strictEqual(martinTelegramChatId({ MARTIN_TELEGRAM_USER_ID: " 42 " } as any), 42);
  for (const v of [undefined, "", "abc", "-1", "0"]) assert.strictEqual(martinTelegramChatId({ MARTIN_TELEGRAM_USER_ID: v } as any), null);
});

test("isolation: the test Action resolves only under the smoke origin, with zero Tool operations", async () => {
  const resolved = await resolveResultGateSmokeAction();
  assert.deepStrictEqual(resolved, { ok: true, hat: RESULT_GATE_SMOKE_TARGET.hat, responsibility: RESULT_GATE_SMOKE_TARGET.responsibility });
  const manifest = findUnitManifest("Business Development")!;
  const organization = { business_function: null, unit: "Business Development", specialization: null, hat: RESULT_GATE_SMOKE_TARGET.hat, responsibility: RESULT_GATE_SMOKE_TARGET.responsibility } as any;
  for (const origin of ["direct_request", "handoff_pickup", "lifecycle_transition"]) {
    const contract = workContractForRequest({ requested_outcome: "x", current_context: { mode: "cowork", origin: origin as any, addressed_unit: "Business Development", requested_action: RESULT_GATE_SMOKE_ACTION } });
    const r = await resolveActionExecution(manifest, organization, contract);
    assert.notStrictEqual(r.kind, "resolved", `${origin} must never resolve the test Action`);
  }
  const hat = manifest.hats[RESULT_GATE_SMOKE_TARGET.hat];
  const withTool = { ...manifest, hats: { ...manifest.hats, [RESULT_GATE_SMOKE_TARGET.hat]: { ...hat, actions: hat.actions.map((a) => (a.name === RESULT_GATE_SMOKE_ACTION ? { ...a, tool_operations: [{ tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false }] } : a)) } } } as any;
  const refused = await resolveResultGateSmokeAction(withTool);
  assert.strictEqual(refused.ok, false);
  const without = { ...manifest, hats: { ...manifest.hats, [RESULT_GATE_SMOKE_TARGET.hat]: { ...hat, actions: hat.actions.filter((a) => a.name !== RESULT_GATE_SMOKE_ACTION) } } } as any;
  assert.strictEqual((await resolveResultGateSmokeAction(without)).ok, false, "a manifest that drops the Action refuses the run");
});

test("non-circular: the contract and the evidence are about the synthetic artefact only, never verification or approval", async () => {
  const artefact = await resultGateSmokeArtefact("result-gate-smoke-00000000-0000-0000-0000-000000000000");
  for (const text of [RESULT_GATE_SMOKE_EXPECTED_RESULT, ...RESULT_GATE_SMOKE_CRITERIA, artefact.content, artefact.note ?? ""]) {
    assert.doesNotMatch(text, /verif|verdict|checker|approv|clos/i, text);
  }
  assert.match(artefact.content, /SHA-256: [0-9a-f]{64}/);
});

// ---------------------------------------------------------------------------
// The lifecycle, through the REAL gate functions save() uses.
// ---------------------------------------------------------------------------

function smokeWorld(opts: { delivered?: boolean } = {}) {
  let state: WorkState | undefined;
  const action = findUnitManifest("Business Development")!.hats[RESULT_GATE_SMOKE_TARGET.hat].actions.find((a) => a.name === RESULT_GATE_SMOKE_ACTION)!;
  const report = async (s: WorkState) => {
    const review = s.resultReview!;
    if (review.approval || review.pendingApproval) return;
    const staged = await stageResultReviewApproval(s);
    if (staged.ok) recordApprovalRequestDelivery(review, staged.pending.createdAt, opts.delivered !== false, 1);
  };
  const save = async (s: WorkState) => {
    await applyResultReviewGate(s, report);
    state = structuredClone(s);
    return s;
  };
  const runner: ResultGateSmokeRunner = {
    ensureGovernedWork: async (workId, chatId) => {
      if (state) return { ok: false, reason: "exists" };
      const s = { workId, chatId, unit: RESULT_GATE_SMOKE_TARGET.unit, hat: RESULT_GATE_SMOKE_TARGET.hat, stage: "new", createdAt: "", updatedAt: "" } as WorkState;
      recordWorkAction(s, RESULT_GATE_SMOKE_ACTION);
      await save(s);
      return { ok: true };
    },
    runWithWorkPersistence: async (_id, fn) => {
      const s = structuredClone(state!);
      ensureResultReviewContract(s, action as any);
      return save(await fn(s));
    },
  };
  const tap = async (approved: boolean) => {
    const s = structuredClone(state!);
    ensureResultReviewContract(s, action as any);
    const outcome = await resolveResultReviewApprovalDecision(s, { approved, token: s.resultReview!.pendingApproval!.token });
    assert.strictEqual(outcome.ok, true);
    if (approved && s.resultReview?.preBlockStage && s.stage === RESULT_REVIEW_BLOCKED_STAGE) {
      s.stage = s.resultReview.preBlockStage;
      s.resultReview.preBlockStage = undefined;
      s.blockedReason = undefined;
    }
    await save(s);
  };
  return { runner, tap, get state() { return state!; } };
}

test("a run: harness completed, gate blocked, card delivered, Martin pending -- overall awaiting_martin, never passed", async () => {
  const w = smokeWorld();
  const id = newResultGateSmokeWorkId();
  const report = await runResultGateSmoke(env, id, w.runner);
  assert.strictEqual(report.harness_execution, "completed");
  assert.strictEqual(report.overall, "awaiting_martin");
  assert.strictEqual(report.contract?.status, "established");
  assert.strictEqual(report.evidence?.status, "established");
  assert.strictEqual(report.gate_blocked_pending_approval?.status, "established");
  assert.strictEqual(report.approval_request?.status, "delivered");
  assert.strictEqual(report.martin_decision?.status, "pending");
  assert.strictEqual(report.final_state?.stage, RESULT_REVIEW_BLOCKED_STAGE);
  assert.strictEqual(report.final_state?.work_closed, false);
  assert.deepStrictEqual(report.missing, ["martin_approval", "final_state_closed"]);
  assert.strictEqual(report.advisory_checker?.recorded, false, "advisory: reported, not required");
});

test("after Martin approves on the card: approval bound to the current evidence, the Work closed -- overall passed", async () => {
  const w = smokeWorld();
  await runResultGateSmoke(env, newResultGateSmokeWorkId(), w.runner);
  await w.tap(true);
  const a = await assessResultGateSmoke(w.state);
  assert.strictEqual(a.overall, "passed");
  assert.deepStrictEqual(a.missing, []);
  assert.strictEqual(a.martin_decision.status, "approved");
  assert.strictEqual(a.martin_decision.via, "result_card");
  assert.strictEqual(a.martin_decision.bound_to_current_evidence, true);
  assert.strictEqual(a.approval_request.status, "delivered", "delivery stays a separate fact after the card is consumed");
  assert.strictEqual(a.final_state.stage, "complete");
  assert.strictEqual(a.final_state.work_closed, true);
});

test("Martin rejects: overall rejected, the Work stays open", async () => {
  const w = smokeWorld();
  await runResultGateSmoke(env, newResultGateSmokeWorkId(), w.runner);
  await w.tap(false);
  const a = await assessResultGateSmoke(w.state);
  assert.strictEqual(a.overall, "rejected");
  assert.strictEqual(a.martin_decision.status, "rejected");
  assert.strictEqual(a.final_state.work_closed, false);
});

test("a card Telegram never delivered is not left staged: overall failed, Martin's decision none", async () => {
  const w = smokeWorld({ delivered: false });
  const report = await runResultGateSmoke(env, newResultGateSmokeWorkId(), w.runner);
  assert.strictEqual(report.harness_execution, "completed", "the harness ran -- that is all a 200 means");
  assert.strictEqual(report.overall, "failed");
  assert.strictEqual(report.approval_request?.status, "failed");
  assert.match(report.approval_request?.reason ?? "", /did not deliver/);
  assert.strictEqual(report.martin_decision?.status, "none");
  assert.strictEqual(w.state.resultReview?.pendingApproval, undefined);
  assert.ok(report.missing?.includes("approval_request_delivered"));
});

test("evidence changed after Martin's approval: never passed", async () => {
  const w = smokeWorld();
  await runResultGateSmoke(env, newResultGateSmokeWorkId(), w.runner);
  await w.tap(true);
  const tampered = structuredClone(w.state);
  (tampered.resultReview!.evidence as any) = [...tampered.resultReview!.evidence!, { kind: "operator_note", ref: "x", content: "added later" }];
  const a = await assessResultGateSmoke(tampered);
  assert.strictEqual(a.overall, "failed");
  assert.ok(a.missing.includes("evidence"));
  assert.ok(a.missing.includes("approval_bound_to_current_evidence"));
});

test("refusals before any Work: bad id, no destination, existing Work; the harness never closes or approves", async () => {
  const w = smokeWorld();
  assert.strictEqual((await runResultGateSmoke(env, "work-123", w.runner)).harness_execution, "refused");
  assert.strictEqual((await runResultGateSmoke({} as Env, newResultGateSmokeWorkId(), w.runner)).harness_execution, "refused");
  const id = newResultGateSmokeWorkId();
  await runResultGateSmoke(env, id, w.runner);
  const again = await runResultGateSmoke(env, id, w.runner);
  assert.strictEqual(again.harness_execution, "refused", "an existing Work is never reused");
  const cheat: ResultGateSmokeRunner = { ...smokeWorld().runner, runWithWorkPersistence: async (_i, fn) => ({ ...(await fn({ workId: id, resultReview: { gateStatus: "pending", expectedResult: RESULT_GATE_SMOKE_EXPECTED_RESULT, completionCriteria: [...RESULT_GATE_SMOKE_CRITERIA] } } as any)), stage: "complete" }) };
  const left = await runResultGateSmoke(env, id, { ...cheat, ensureGovernedWork: async () => ({ ok: true }) });
  assert.strictEqual(left.harness_execution, "refused");
  assert.match(left.refusal ?? "", /success stage/);
});

test("recordApprovalRequestDelivery: delivered keeps the time; undelivered withdraws the staged approval", () => {
  const review: any = { gateStatus: "blocked", pendingApproval: { token: "t", reviewHash: "h", createdAt: "c" } };
  assert.strictEqual(recordApprovalRequestDelivery(review, "c", true, 1), true);
  assert.ok(review.approvalRequest.deliveredAt);
  assert.ok(review.pendingApproval, "a delivered card stays staged for Martin's tap");
  assert.strictEqual(recordApprovalRequestDelivery(review, "c", false, 3), false);
  assert.strictEqual(review.pendingApproval, undefined);
  assert.match(review.approvalRequest.failedReason, /3 attempt/);
});

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

function stubEnv(getState: () => Promise<unknown>, calls: string[]) {
  const stub = new Proxy({} as any, {
    get: (_t, prop) => {
      calls.push(String(prop));
      if (prop === "getState") return getState;
      if (prop === "then") return undefined;
      throw new Error(`the inspection must call only getState(), not ${String(prop)}`);
    },
  });
  return { ...env, WORK_SESSION: { idFromName: (n: string) => { calls.push(`idFromName:${n}`); return n; }, get: () => stub } } as unknown as Env;
}

test("inspection: admin only, smoke ids only (checked before any Durable Object), getState() only, no identity in the response", async () => {
  const w = smokeWorld();
  const id = newResultGateSmokeWorkId();
  await runResultGateSmoke(env, id, w.runner);
  const saved = { ...w.state, threadId: 604, entityName: "Acme Ltd" };
  const calls: string[] = [];
  const e = stubEnv(async () => saved, calls);
  const url = (q: string) => `https://w.example/admin/smoke-result-gate-inspect?${q}`;
  assert.strictEqual((await handleResultGateSmokeInspect(new Request(url(`workId=${id}`)), e)).status, 403);
  const bad = await handleResultGateSmokeInspect(new Request(url("workId=work-1"), { headers: { "X-Worker-Admin-Key": "admin-secret" } }), e);
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(calls, [], "a bad id never reaches idFromName");
  const res = await handleResultGateSmokeInspect(new Request(url(`workId=${id}`), { headers: { "X-Worker-Admin-Key": "admin-secret" } }), e);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((calls as string[]).filter((c) => !c.startsWith("idFromName")), ["getState"]);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.strictEqual(body.overall, "awaiting_martin");
  assert.strictEqual(body.work_id, id);
  for (const secret of ["9999", "604", "Acme", saved.resultReview!.pendingApproval!.token, "Payload:"]) assert.ok(!text.includes(secret), `the response never carries ${secret}`);
  const missing = await handleResultGateSmokeInspect(new Request(url(`workId=${newResultGateSmokeWorkId()}`), { headers: { "X-Worker-Admin-Key": "admin-secret" } }), stubEnv(async () => undefined, []));
  assert.strictEqual(missing.status, 404);
});

test("harness route: admin only; a bad query is refused before any Durable Object; 200 only when the harness ran", async () => {
  const calls: string[] = [];
  const e = stubEnv(async () => undefined, calls);
  const url = (q: string) => `https://w.example/admin/smoke-result-gate?${q}`;
  assert.strictEqual((await handleResultGateSmokeRequest(new Request(url(OK_QUERY)), e)).status, 403);
  assert.strictEqual((await handleResultGateSmokeRequest(new Request(url("origin=x&key=admin-secret")), e)).status, 400);
  assert.deepStrictEqual(calls, []);
  const run = (report: unknown) => ({ ...env, WORK_SESSION: { idFromName: (n: string) => n, get: () => ({ runResultGateSmoke: async () => report }) } }) as unknown as Env;
  assert.strictEqual((await handleResultGateSmokeRequest(new Request(url(`${OK_QUERY}&key=admin-secret`)), run({ harness_execution: "completed", overall: "awaiting_martin" }))).status, 200);
  assert.strictEqual((await handleResultGateSmokeRequest(new Request(url(`${OK_QUERY}&key=admin-secret`)), run({ harness_execution: "refused", refusal: "x" }))).status, 500);
});
