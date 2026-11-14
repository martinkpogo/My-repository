import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { Env, WorkState } from "./types";
import { handleResultGateSmokeInspect } from "./resultGateSmokeInspect";
import {
  RESULT_GATE_SMOKE_WORK_ID_PREFIX,
} from "./runtime/resultGateSmoke";

/**
 * GET /admin/smoke-result-gate-inspect -- read-only operator inspection of one
 * Result Gate smoke Work's persisted state (ENIG issue #370, correction A),
 * proven at its own boundary:
 *
 * - the ONE admin-key check runs first, and a refusal never instantiates a
 *   Durable Object;
 * - only `result-gate-smoke-<uuid>` ids are accepted -- a real business Work
 *   id can never be inspected through this route; validation happens before
 *   `idFromName`, so garbage input never instantiates a Durable Object;
 * - the ONLY Durable Object call is stub.getState() -- no execute(), no
 *   init(), no mutation of any kind;
 * - 404 if no Work exists at that id;
 * - the response is a minimal projection carrying no identity-bearing fields
 *   (chatId, threadId, entityName, matterName, enquiryText) and no approval
 *   button token;
 * - the live endpoint is never invoked here: the live run is authorized
 *   separately, after Architect review.
 */

const ADMIN_KEY = "test-admin-key-370";
const WORK_ID = `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const ROUTE = "https://enig-agent.martnkpogo.workers.dev/admin/smoke-result-gate-inspect";

function smokeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: WORK_ID,
    chatId: 777000111,
    threadId: 555,
    entityName: "ACME Corp",
    matterName: "Matter-1",
    enquiryText: "some enquiry text",
    unit: "Business Development",
    hat: "Business Development Manager",
    actionName: "result_gate_smoke_test",
    stage: "result_review_blocked",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    handoffId: "handoff-123",
    blockedReason: "Independent Checker verification failed: criteria not met",
    resultReview: {
      gateStatus: "blocked",
      blockReason: "Independent Checker verification failed: criteria not met",
      preBlockStage: "complete",
      evidence: [{ kind: "smoke_test", ref: WORK_ID }, { kind: "smoke_test", ref: "result-gate-smoke-sequence" }],
      verificationAttempt: {
        snapshotKey: "snapshot-key-123",
        outcome: "failed",
        reason: "criteria not met",
        at: "2026-01-02T00:00:00Z",
      },
      checker: {
        checkerId: "Machinery Worker Alpha",
        outcome: "failed",
        reason: "criteria not met",
        checkedAt: "2026-01-02T00:00:00Z",
        evidenceRefs: [{ kind: "work_record", ref: WORK_ID }],
        verdictHash: "a".repeat(64),
      },
      approval: {
        approver: "martin",
        token: "token-123",
        approvedAt: "2026-01-03T00:00:00Z",
        reviewHash: "b".repeat(64),
      },
      pendingApproval: {
        token: "staged-token",
        reviewHash: "c".repeat(64),
        createdAt: "2026-01-02T00:00:00Z",
      },
    },
    ...overrides,
  } as unknown as WorkState;
}

type FakeEnv = { env: Env; calls: { idFromName: string[]; getState: string[] } };

function createFakeEnv(options: { adminKey?: string; state?: WorkState | undefined; throwError?: boolean } = {}): FakeEnv {
  const calls = { idFromName: [] as string[], getState: [] as string[] };
  const stub = {
    getState: async () => {
      calls.getState.push("getState");
      if (options.throwError) throw new Error("durable object exploded");
      return options.state;
    },
    execute: async () => {
      throw new Error("the inspect route must not call execute()");
    },
    init: async () => {
      throw new Error("the inspect route must not call init()");
    },
    runResultGateSmoke: async () => {
      throw new Error("the inspect route must not call runResultGateSmoke()");
    },
  };
  const env = {
    WORK_SESSION: {
      idFromName: (name: string) => {
        calls.idFromName.push(name);
        return name;
      },
      get: () => stub,
    },
    WORKER_ADMIN_KEY: "adminKey" in options ? options.adminKey : ADMIN_KEY,
    MARTIN_TELEGRAM_USER_ID: "998877665",
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, calls };
}

function smokeRequest(query: string | null = `workId=${WORK_ID}`, options: { key?: string | null } = {}): Request {
  const url = query === null ? ROUTE : `${ROUTE}?${query}`;
  const headers = new Headers();
  const key = "key" in options ? options.key : ADMIN_KEY;
  if (key) headers.set("X-Worker-Admin-Key", key);
  return new Request(url, { headers });
}

// ---------------------------------------------------------------------------
// Authentication -- fail closed, before any Durable Object exists.
// ---------------------------------------------------------------------------

test("auth: missing X-Worker-Admin-Key header -> 403, no Durable Object touched", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeInspect(smokeRequest(null, { key: null }), env);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(await res.text(), "forbidden");
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.getState, []);
});

test("auth: incorrect X-Worker-Admin-Key header -> 403, no Durable Object touched", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeInspect(smokeRequest(null, { key: "wrong-key" }), env);
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.getState, []);
});

test("auth: missing WORKER_ADMIN_KEY secret -> 403 even with the right header (fail closed)", async () => {
  const { env, calls } = createFakeEnv({ adminKey: undefined });
  const res = await handleResultGateSmokeInspect(smokeRequest(null, { key: ADMIN_KEY }), env);
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.getState, []);
});

// ---------------------------------------------------------------------------
// Parameter validation -- smoke Work id only, never a real business id.
// ---------------------------------------------------------------------------

test("validation: missing workId -> 400, no Durable Object touched", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeInspect(smokeRequest(null), env);
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.strictEqual(body.ok, false);
  assert.match(body.error, /result-gate-smoke-/);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.getState, []);
});

test("validation: a non-smoke Work id is refused with 400 and never instantiates a Durable Object", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeInspect(smokeRequest("workId=df99c0e2-e522-4853-a994-51fae8dd2f06"), env);
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.strictEqual(body.ok, false);
  assert.match(body.error, /result-gate-smoke-/);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.getState, []);
});

test("validation: a malformed smoke Work id is refused with 400", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeInspect(smokeRequest(`workId=${RESULT_GATE_SMOKE_WORK_ID_PREFIX}not-a-uuid`), env);
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.strictEqual(body.ok, false);
  assert.match(body.error, /result-gate-smoke-/);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.getState, []);
});

// ---------------------------------------------------------------------------
// 404 when no Work exists at the id.
// ---------------------------------------------------------------------------

test("inspect: no Work at the id -> 404, exactly one getState call", async () => {
  const { env, calls } = createFakeEnv({ state: undefined });
  const res = await handleResultGateSmokeInspect(smokeRequest(), env);
  assert.strictEqual(res.status, 404);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.strictEqual(body.ok, false);
  assert.strictEqual(calls.getState.length, 1, "exactly one getState call");
});

// ---------------------------------------------------------------------------
// Happy path -- minimal projection, no identity fields.
// ---------------------------------------------------------------------------

test("inspect: returns a minimal projection with no identity-bearing fields", async () => {
  const { env, calls } = createFakeEnv({ state: smokeState() });
  const res = await handleResultGateSmokeInspect(smokeRequest(), env);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as Record<string, unknown>;

  assert.strictEqual(calls.getState.length, 1, "exactly one getState call");

  // Core lifecycle fields.
  assert.strictEqual(body.workId, WORK_ID);
  assert.strictEqual(body.unit, "Business Development");
  assert.strictEqual(body.hat, "Business Development Manager");
  assert.strictEqual(body.action, "result_gate_smoke_test");
  assert.strictEqual(body.stage, "result_review_blocked");
  assert.strictEqual(body.createdAt, "2026-01-01T00:00:00Z");
  assert.strictEqual(body.updatedAt, "2026-01-02T00:00:00Z");
  assert.strictEqual(body.blockedReason, "Independent Checker verification failed: criteria not met");
  assert.strictEqual(body.workClosed, false, "result_review_blocked is not a terminal stage");

  // Synthetic evidence references, sourced from persisted evidence items.
  assert.deepStrictEqual(body.evidenceRefs, [
    { kind: "smoke_test", ref: WORK_ID },
    { kind: "smoke_test", ref: "result-gate-smoke-sequence" },
  ]);

  // Exact verification snapshot key, sourced from persisted verificationAttempt.
  assert.strictEqual(body.snapshotKey, "snapshot-key-123");

  // No handoff identifiers in the smoke's Result Gate state projection.
  assert.ok(!("handoffId" in body), "no handoffId in projection");

  // No identity-bearing fields anywhere.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("chatId"), "no chatId in projection");
  assert.ok(!raw.includes("threadId"), "no threadId in projection");
  assert.ok(!raw.includes("entityName"), "no entityName in projection");
  assert.ok(!raw.includes("matterName"), "no matterName in projection");
  assert.ok(!raw.includes("enquiryText"), "no enquiryText in projection");

  // No approval button token.
  assert.ok(!raw.includes("staged-token"), "the staged approval token must not be reported");
  assert.ok(!raw.includes("token-123"), "the consumed approval token must not be reported");

  // Fixed projection shape.
  assert.deepStrictEqual(
    Object.keys(body).sort(),
    [
      "action",
      "blockedReason",
      "createdAt",
      "evidenceRefs",
      "hat",
      "resultReview",
      "stage",
      "snapshotKey",
      "unit",
      "updatedAt",
      "workClosed",
      "workId",
    ].sort(),
    "the response is a fixed minimal projection",
  );
});

test("inspect: result review projection excludes identity and token", async () => {
  const { env } = createFakeEnv({ state: smokeState() });
  const res = await handleResultGateSmokeInspect(smokeRequest(), env);
  const body = (await res.json()) as { resultReview: Record<string, unknown> };

  const review = body.resultReview;
  assert.strictEqual(review.gateStatus, "blocked");
  assert.strictEqual(review.blockReason, "Independent Checker verification failed: criteria not met");
  assert.strictEqual(review.preBlockStage, "complete");

  // Checker projection: no identity, no token.
  assert.deepStrictEqual(review.checker, {
    outcome: "failed",
    checkerId: "Machinery Worker Alpha",
    reason: "criteria not met",
    verdictHash: "a".repeat(64),
  });

  // Approval projection: no token.
  assert.deepStrictEqual(review.approval, {
    approver: "martin",
    approvedAt: "2026-01-03T00:00:00Z",
    reviewHash: "b".repeat(64),
  });

  // Pending approval: staged flag + timestamp, no token.
  assert.deepStrictEqual(review.pendingApproval, {
    staged: true,
    createdAt: "2026-01-02T00:00:00Z",
  });
});

test("inspect: result review with no checker, no approval, no pending", async () => {
  const { env } = createFakeEnv({ state: smokeState({ resultReview: undefined }) });
  const res = await handleResultGateSmokeInspect(smokeRequest(), env);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { resultReview: Record<string, unknown> | null };
  assert.strictEqual(body.resultReview, null);
});

test("inspect: result review with empty fields", async () => {
  const { env } = createFakeEnv({
    state: smokeState({
      resultReview: { gateStatus: "pending" } as unknown as NonNullable<WorkState["resultReview"]>,
    }),
  });
  const res = await handleResultGateSmokeInspect(smokeRequest(), env);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { resultReview: Record<string, unknown> | null };
  assert.ok(body.resultReview);
  assert.strictEqual(body.resultReview.gateStatus, "pending");
  assert.strictEqual(body.resultReview.checker, null);
  assert.strictEqual(body.resultReview.approval, null);
  assert.strictEqual(body.resultReview.pendingApproval, null);
});

test("inspect: workClosed is true for terminal stages and false otherwise", async () => {
  const { env } = createFakeEnv({
    state: smokeState({ stage: "complete" }),
  });
  const res = await handleResultGateSmokeInspect(smokeRequest(), env);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as { workClosed: boolean };
  assert.strictEqual(body.workClosed, true);

  const { env: env2 } = createFakeEnv({
    state: smokeState({ stage: "result_review_blocked" }),
  });
  const res2 = await handleResultGateSmokeInspect(smokeRequest(), env2);
  assert.strictEqual(res2.status, 200);
  const body2 = (await res2.json()) as { workClosed: boolean };
  assert.strictEqual(body2.workClosed, false);
});

// ---------------------------------------------------------------------------
// Read-only discipline: the route never mutates.
// ---------------------------------------------------------------------------

test("route: never calls execute, init, or runResultGateSmoke", () => {
  const source = fs.readFileSync(path.join(__dirname, "resultGateSmokeInspect.ts"), "utf8");
  assert.ok(!/\.execute\s*\(/.test(source), "no execute() call");
  assert.ok(!/\.init\s*\(/.test(source), "no init() call");
  assert.ok(!/runResultGateSmoke\s*\(/.test(source), "no runResultGateSmoke() call");
  assert.equal((source.match(/\.getState\s*\(/g) ?? []).length, 1, "exactly one getState() call");
});

// ---------------------------------------------------------------------------
// Wiring: index.ts exposes GET /admin/smoke-result-gate-inspect.
// ---------------------------------------------------------------------------

test("wiring: index.ts exposes GET /admin/smoke-result-gate-inspect through the handler", () => {
  const index = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const at = index.indexOf('url.pathname === "/admin/smoke-result-gate-inspect" && request.method === "GET"');
  assert.ok(at > -1, "the GET route exists");
  const slice = index.slice(at, at + 400);
  assert.ok(slice.includes("return handleResultGateSmokeInspect(request, env);"), "the route delegates to the handler");
  assert.ok(index.includes('import { handleResultGateSmokeInspect } from "./resultGateSmokeInspect";'), "the handler is imported");
});
