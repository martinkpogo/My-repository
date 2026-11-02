import test from "node:test";
import assert from "node:assert/strict";
import { claimPendingHandoff, closeHandoffIfOpen, closeHandoffOnResult } from "./handoffLifecycle";
import { ensureResultReviewContract, recordCheckerVerdict, resolveResultReviewApprovalDecision, stageResultReviewApproval } from "./resultReview";
import { workSessionContext, type AccessContext } from "./access";
import type { Env, WorkState } from "./types";

function fakeEnv(): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
  };
}

/**
 * A Work that is advancing the very Handoff it was picked up from.
 *
 * `workSessionContext` is what these two functions are called with in
 * production: the Work item is claiming or closing its own inbound Handoff,
 * which is execution-state projection on a record the Work already owns. It
 * is NOT a governed business write and is NOT Martin's approval-gated effect,
 * so it needs no proof -- it needs an honest name for the Work doing it.
 */
function lifecycleAccess(handoffId: string): AccessContext {
  return workSessionContext({
    workId: "work-lifecycle",
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "new_enquiry",
    stage: "awaiting_pickup",
    handoffId,
  } as WorkState);
}

function mockFetch(t: any, initialStatus: string): { patchBodies: any[] } {
  const originalFetch = globalThis.fetch;
  const log = { patchBodies: [] as any[] };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      // `parent` is what src/notion.ts now reads to resolve the page's real
      // target, so the mock has to carry it: without it the target does not
      // resolve and every update is refused before it is ever attempted.
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          properties: { Status: { select: { name: initialStatus } } },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") {
      log.patchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "handoff-1", url: "https://notion.so/handoff-1", properties: {} }), { status: 200 });
    }
    if (method === "GET" && urlStr.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(urlStr.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: urlStr.split("/v1/pages/").pop()!.split("?")[0],
          url: urlStr,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return log;
}

test("claimPendingHandoff: claims a genuinely Pending Handoff, setting Picked-up", async (t) => {
  const log = mockFetch(t, "Pending");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, true);
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Picked-up");
});

test("claimPendingHandoff: refuses an already Picked-up Handoff, no write", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, false);
  if (!result.claimed) assert.strictEqual(result.currentStatus, "Picked-up");
  assert.strictEqual(log.patchBodies.length, 0);
});

test("claimPendingHandoff: refuses a Held Handoff, no write", async (t) => {
  const log = mockFetch(t, "Held");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, false);
  assert.strictEqual(log.patchBodies.length, 0);
});

test("claimPendingHandoff: refuses a Closed Handoff, no write", async (t) => {
  const log = mockFetch(t, "Closed");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, false);
  assert.strictEqual(log.patchBodies.length, 0);
});

test("closeHandoffIfOpen: closes a Pending Handoff with the reason recorded", async (t) => {
  const log = mockFetch(t, "Pending");
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Rejected by Martin, no further direction.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
  assert.match(log.patchBodies[0].properties["Open Questions"].rich_text[0].text.content, /Rejected by Martin/);
});

test("closeHandoffIfOpen: closes a Picked-up Handoff", async (t) => {
  const log = mockFetch(t, "Picked-up");
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Cancelled.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
});

test("closeHandoffIfOpen: does not reopen or rewrite an already-Closed Handoff", async (t) => {
  const log = mockFetch(t, "Closed");
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Cancelled.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies.length, 0, "a Closed Handoff must not be touched again");
});

/**
 * BD-8: `closeHandoffOnResult` is the ONE point where Work closes a
 * Handoff SUCCESSFULLY. The Result review gate is evaluated BEFORE any
 * Notion call: a refusal must leave the Handoff exactly as it is (no PATCH
 * at all), and only a fully satisfied review (declared contract + independent
 * bound Checker verdict + Martin's bound Result approval) may close it.
 */

function reviewState(handoffId: string): WorkState {
  return {
    workId: "work-result-gate",
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "proposal_draft",
    stage: "awaiting_pickup",
    handoffId,
  } as WorkState;
}

const CONTRACT = {
  expectedResult: "A verified Proposal recorded.",
  completionCriteria: ["Proposal record exists with its Version.", "The canonical Doc verified as that Version."],
} as const;

/** The sanctioned path to a satisfied review: contract -> passing verdict -> staged approval -> recorded decision. */
async function satisfiedReview(handoffId: string): Promise<WorkState> {
  const state = reviewState(handoffId);
  ensureResultReviewContract(state, CONTRACT);
  const verdict = await recordCheckerVerdict(state, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "proposal", ref: "PP-1", note: "version + doc hash" }],
  });
  assert.ok(verdict.ok, `verdict should record: ${!verdict.ok ? verdict.reason : ""}`);
  const staged = await stageResultReviewApproval(state);
  assert.ok(staged.ok, `staging should succeed: ${!staged.ok ? staged.reason : ""}`);
  const decision = await resolveResultReviewApprovalDecision(state, { approved: true, token: staged.pending.token });
  assert.ok(decision.ok, `decision should record: ${!decision.ok ? decision.reason : ""}`);
  return state;
}

test("closeHandoffOnResult: refuses a Work with no Result contract -- NO Notion write happens", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const state = reviewState("handoff-1");
  const result = await closeHandoffOnResult(fakeEnv(), state, "handoff-1", "Done.", workSessionContext(state));
  assert.strictEqual(result.closed, false);
  if (!result.closed) assert.match(result.reason, /declares no expected Result or completion criteria/);
  assert.strictEqual(log.patchBodies.length, 0, "the gate must refuse BEFORE any Notion call");
});

test("closeHandoffOnResult: refuses while the Checker verification or Martin's approval is missing -- NO Notion write", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const declaredOnly = reviewState("handoff-1");
  ensureResultReviewContract(declaredOnly, CONTRACT);
  const r1 = await closeHandoffOnResult(fakeEnv(), declaredOnly, "handoff-1", "Done.", workSessionContext(declaredOnly));
  assert.strictEqual(r1.closed, false);
  if (!r1.closed) assert.match(r1.reason, /no Checker verdict is recorded/);
  assert.strictEqual(log.patchBodies.length, 0, "a missing verdict must leave the Handoff untouched");

  // Verdict recorded but Martin has not approved: still refused, still no write.
  await recordCheckerVerdict(declaredOnly, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "proposal", ref: "PP-1" }],
  });
  const r2 = await closeHandoffOnResult(fakeEnv(), declaredOnly, "handoff-1", "Done.", workSessionContext(declaredOnly));
  assert.strictEqual(r2.closed, false);
  if (!r2.closed) assert.match(r2.reason, /no Result approval is recorded/);
  assert.strictEqual(log.patchBodies.length, 0, "an unapproved Result must leave the Handoff untouched");
});

test("closeHandoffOnResult: refuses when the verdict was rendered against a different snapshot of the Work -- NO Notion write", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const state = await satisfiedReview("handoff-1");
  // The completion criteria changed after the verdict+approval were bound:
  // both hashes now recompute differently, so the review no longer binds.
  state.resultReview!.completionCriteria = ["A criterion nobody checked."];
  const result = await closeHandoffOnResult(fakeEnv(), state, "handoff-1", "Done.", workSessionContext(state));
  assert.strictEqual(result.closed, false);
  if (!result.closed) assert.match(result.reason, /bound to a different|bound to a different Work, Result, completion criteria or Checker verdict/);
  assert.strictEqual(log.patchBodies.length, 0, "a stale review must leave the Handoff untouched");
});

test("closeHandoffOnResult: a fully satisfied review closes the Handoff with the Work Completed reason", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const state = await satisfiedReview("handoff-1");
  const result = await closeHandoffOnResult(fakeEnv(), state, "handoff-1", "Proposal PP-1 recorded and verified.", workSessionContext(state));
  assert.strictEqual(result.closed, true);
  assert.strictEqual(log.patchBodies.length, 1, "the one legitimate closure must write exactly once");
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
  assert.match(log.patchBodies[0].properties["Work Completed"].rich_text[0].text.content, /PP-1 recorded and verified/);
});

test("resumption: a Handoff left open by a refusal closes once the review is later satisfied", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const state = reviewState("handoff-1");
  ensureResultReviewContract(state, CONTRACT);
  const refused = await closeHandoffOnResult(fakeEnv(), state, "handoff-1", "Done.", workSessionContext(state));
  assert.strictEqual(refused.closed, false);
  assert.strictEqual(log.patchBodies.length, 0);

  // The sanctioned flow completes: verdict, then Martin's approval.
  const verdict = await recordCheckerVerdict(state, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs: [{ kind: "proposal", ref: "PP-1" }],
  });
  assert.ok(verdict.ok);
  const staged = await stageResultReviewApproval(state);
  assert.ok(staged.ok);
  const decision = await resolveResultReviewApprovalDecision(state, { approved: true, token: staged.pending.token });
  assert.ok(decision.ok);

  const closed = await closeHandoffOnResult(fakeEnv(), state, "handoff-1", "Done after review.", workSessionContext(state));
  assert.strictEqual(closed.closed, true, "the same Handoff must close once the review is satisfied");
  assert.strictEqual(log.patchBodies.length, 1);
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
});

/**
 * Each applicable successful Handoff closure route while review is pending:
 * every Unit's handler routes through closeHandoffOnResult, so each must be
 * refused (no Notion write) when the review is not yet satisfied.
 */
const unitStates: Array<[string, WorkState]> = [
  [
    "Sales / new_enquiry",
    { ...reviewState("handoff-sales"), unit: "Sales", hat: "Sales Executive", actionName: "new_enquiry" },
  ],
  [
    "Sales / proposal_draft",
    { ...reviewState("handoff-sales-pd"), unit: "Sales", hat: "Sales Executive", actionName: "proposal_draft" },
  ],
  [
    "Strategy / diagnose",
    { ...reviewState("handoff-strategy"), unit: "Strategy", hat: "Strategy Analyst", actionName: "diagnose" },
  ],
  [
    "Finance / price",
    { ...reviewState("handoff-finance"), unit: "Finance", hat: "Value-Based Pricing Assessor", actionName: "price" },
  ],
  [
    "Marketing / handle_request",
    { ...reviewState("handoff-marketing"), unit: "Marketing", hat: "Marketing Strategist", actionName: "handle_request" },
  ],
];

for (const [label, state] of unitStates) {
  test(`closeHandoffOnResult: ${label} closure refused while review pending -- NO Notion write`, async (t) => {
    const log = mockFetch(t, "Picked-up");
    ensureResultReviewContract(state, CONTRACT);
    // Contract declared but no verdict/approval: gate must refuse before any Notion call.
    const result = await closeHandoffOnResult(fakeEnv(), state, state.handoffId!, "Done.", workSessionContext(state));
    assert.strictEqual(result.closed, false, `${label} must not close without a satisfied review`);
    if (!result.closed) assert.match(result.reason, /no Checker verdict is recorded/);
    assert.strictEqual(log.patchBodies.length, 0, `${label}: the gate must refuse BEFORE any Notion call`);
  });
}

test("closeHandoffIfOpen: cancellation still closes while a Result review is pending (non-success unchanged)", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const state = reviewState("handoff-1");
  ensureResultReviewContract(state, CONTRACT);
  // Review is pending (no verdict, no approval) but cancellation is non-success and must not be gated.
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Work item cancelled by Martin.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies.length, 1);
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
  assert.match(log.patchBodies[0].properties["Open Questions"].rich_text[0].text.content, /cancelled by Martin/);
});

/**
 * Result production and legitimate Handoffs remaining possible while review is pending:
 * the gate blocks successful Handoff closure, but it does not block the Work from
 * running or new Handoffs from being created. createHandoff is not gated by review.
 */
test("closeHandoffOnResult: blocks Handoff closure while review pending but does not block the Work itself", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const state = reviewState("handoff-prod");
  ensureResultReviewContract(state, CONTRACT);

  // Gate refuses closure...
  const refused = await closeHandoffOnResult(fakeEnv(), state, "handoff-prod", "Done.", workSessionContext(state));
  assert.strictEqual(refused.closed, false);
  assert.strictEqual(log.patchBodies.length, 0);

  // ...but the Work can still advance its stage (result production continues;
  // WorkSession.save will flip a terminal success stage to result_review_blocked,
  // but non-terminal stage changes are never blocked by the gate).
  state.stage = "in_review";
  assert.strictEqual(state.stage, "in_review");
  assert.strictEqual(log.patchBodies.length, 0, "no Notion write from a stage change alone");
});
