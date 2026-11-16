# Task instruction: Result Gate smoke test on the current gate (#370, rebuilt)

Status: **approved by Martin (16 Nov 2026)**, with all four recommendations. Execution authority: implement, open a PR, watch it through merge. **The live smoke run is not authorized here.** Martin runs it himself after deploy. The PR auto-merges once CI passes, and merging deploys.

## 1. Problem

#370's smoke test (PR #371, branch `enig-370-result-gate-smoke`) was built on the PR #368 gate. In that gate the Machinery Worker verification ran in `WorkSession.save()`, and a PASS staged Martin's card. Martin's 14 Nov decision (#420/#421) changed this:

- the Checker is advisory;
- closure needs the declared contract, the recorded evidence, and Martin's Result approval hash-bound to that evidence.

The branch is now about 25,000 lines behind and conflicts with merged decisions. Five requirements from its review still stand:

1. Read-only inspection of a smoke Work.
2. Non-circular evidence.
3. Truthful end-to-end reporting.
4. Approval request kept separate from Martin's decision.
5. Verified final state.

## 2. Approved design or decision

Martin, 16 Nov 2026: carry the five requirements into a new smoke test built against the current gate.

- **Closure path tested:** the separate Result-approval card (`resultreview` callback). `outputApprovalClosesWork` is not tested here.
- **The advisory Checker** is declared on the test Action and reported, but it is never part of pass or fail.
- **PR #371** is superseded and closed by Martin. Issue #370's acceptance criteria are replaced by Martin (draft below).
- **The stale doc** (`docs/enig-operating-model.md`, the Result review lifecycle paragraph) is corrected in the same change.

## 3. Scope

- **Test-only Action** `result_gate_smoke_test` on Business Development / Business Development Manager (`develop_opportunities`).
  - It is applicable only to the new origin `result_gate_smoke` (`WorkOrigin`).
  - It declares a non-circular Result contract and an `advisoryAssessment` at `result_review_blocked`.
  - It declares no Tool operation and no Skill.
- **Harness** `src/runtime/resultGateSmoke.ts`, ported from the #370 branch. Kept as-is:
  - the fixed target;
  - the id shape `result-gate-smoke-<uuid>`;
  - strict query parameters;
  - Martin's DM from configuration only;
  - an in-process preflight with zero Tool operations;
  - no reuse of an existing Work.

  Rewritten for the current gate:
  - the synthetic body records **one synthetic artefact** as evidence and reaches `complete`;
  - the unchanged gate then blocks it and stages the card;
  - **one shared `assessResultGateSmoke(state)`** computes every fact for both the harness report and the inspection.
- **Route** `GET /admin/smoke-result-gate`: admin key, then the harness.
- **Inspection** `GET /admin/smoke-result-gate-inspect?workId=…`: admin header, smoke ids only, `getState()` only, then the shared assessment. No chat ids, no tokens, no artefact content.
- **Gate delivery fact (generic).** `reportResultReviewBlocked` sends the card with `sendMessageWithOutcome` and records `resultReview.approvalRequest` (`stagedAt`, `deliveredAt` or `failedReason`).
  - A card Telegram never delivered is un-staged, and the existing "cannot close yet / Re-check" message follows, so Re-check can stage it again.
  - A smoke Work's card is marked **TEST ONLY**.
- **Docs:** `docs/enig-operating-model.md`, in the same change.

## 4. No-change scope

- Gate rules: `evaluateResultReviewGate`, hashing, approval binding, `outputApprovalClosesWork`, the Re-check logic and the resultreview callback, except that it now reads delivery from the new field.
- The advisory Checker's behaviour and authority.
- Every real Unit, Hat and Action; normal intake, Action Resolution, Handoff pickup and dispatch.
- No Notion writes, no business records, no external Tool operations, no external-party messages.

## 5. Boundaries

- There is no second verification trigger and no bypass. The harness never records a verdict, an approval or a closure, and never calls the verifier or the advisory assessment.
- The test Action can't be selected through any ordinary origin.
- The smoke Work holds no client identity. The inspection exposes no chat id, thread id, button token or identity field.
- **Fail closed.** Anything unestablished is reported as not established. `passed` is only ever computed from the saved state.

## 6. Live-state checks

- `WORKER_ADMIN_KEY` and `MARTIN_TELEGRAM_USER_ID` are configured. They're checked at run time, and the harness refuses without them.
- No Notion page is required by the harness. The advisory Checker reads its own governance as it does today; if it can't, the advisory fact reports "not recorded" and nothing else changes.

## 7. Acceptance criteria

See the #370 draft below. Each item has a test, except the live run (item 12), which is Martin's.

## 8. Verification

- `npx tsc --noEmit`
- `npm test` (including `src/handoffContracts/unitBoundary.test.ts`)
- **After deploy (Martin):**
  1. `curl -s "https://<worker>/admin/smoke-result-gate?key=$KEY&origin=result_gate_smoke&action=result_gate_smoke_test"` should return `overall: "awaiting_martin"`, with the card delivered.
  2. Tap **✅ Approve Result** on the TEST ONLY card in your DM.
  3. `curl -s -H "X-Worker-Admin-Key: $KEY" "https://<worker>/admin/smoke-result-gate-inspect?workId=<id>"` should return `overall: "passed"`.

## 9. Execution authority

Implement, open a PR, watch it through merge. No live smoke run.

## 10. Stop rule

If the current gate can't be exercised without changing its rules, adding a trigger or a bypass, stop and report.

---

## Draft: replacement acceptance criteria for #370 (for Martin to post)

1. A test-only Action `result_gate_smoke_test` is registered on an existing Unit/Hat, and its Result contract is loaded from the manifest through the Work's recorded Action.
2. No ordinary origin (direct request, Handoff pickup, lifecycle transition) can resolve or execute it. It declares zero Tool operations.
3. The harness creates only a fresh `result-gate-smoke-<uuid>` Work and refuses to reuse or overwrite an existing one.
4. The Result contract is non-circular. The evidence is one synthetic artefact (a fixed, clearly marked payload with its SHA-256), and the criteria can be established from that artefact alone. Nothing in the evidence describes verification or approval.
5. The unchanged gate blocks the Work into `result_review_blocked` pending Martin's approval. The harness never records a verdict, an approval or a closure.
6. Delivery of the approval card is recorded and reported separately from Martin's decision: staged, delivered or failed (with the reason). A card Telegram never delivered isn't left looking staged.
7. Martin's decision is reported separately: pending, approved (via the card, bound to the current evidence) or rejected.
8. The Work closes only after Martin's card approval, bound to the exact recorded evidence.
9. The advisory Checker is declared and reported (recorded or not, and its recommendation), and it never affects pass or fail.
10. A read-only, admin-only inspection of a smoke Work reads saved state only (`getState()`) and exposes no chat id, token or identity field.
11. Reporting is truthful. An HTTP 200 means only that the harness ran. `overall` is `passed` only when every required fact is established from the saved state after Martin's approval. Otherwise it's `awaiting_martin`, `rejected` or `failed`, naming the missing facts.
12. One live run by Martin shows the harness reporting `awaiting_martin` with the card delivered, then, after his tap, the inspection reporting `passed`. The run can be repeated with a fresh id.
