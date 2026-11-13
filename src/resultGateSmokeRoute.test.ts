import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { Env } from "./types";
import { handleResultGateSmokeRequest } from "./resultGateSmokeRoute";
import {
  RESULT_GATE_SMOKE_ACTION,
  RESULT_GATE_SMOKE_ORIGIN,
  RESULT_GATE_SMOKE_WORK_ID_PREFIX,
  isResultGateSmokeWorkId,
  type ResultGateSmokeReport,
} from "./runtime/resultGateSmoke";

/**
 * `/admin/smoke-result-gate` -- the operator endpoint for the isolated live
 * Result Gate smoke harness (ENIG issue #370), proven at its own boundary:
 *
 * - the ONE admin-key check runs first, and a refusal never instantiates a
 *   Durable Object;
 * - the query string accepts only `origin`, `action` and `work_id` (plus the
 *   admin-auth `key`), each at most once, with `origin`/`action` REQUIRED
 *   and required to equal the harness constants exactly -- a missing, empty
 *   or different value is 400 before any Durable Object is looked up, and
 *   there is no parameter for a Unit, Hat, Responsibility, Telegram
 *   destination or any other Action;
 * - `work_id`, when supplied, must already be a harness id, and a generated
 *   one always carries the dedicated prefix; both are validated BEFORE
 *   `idFromName`, so garbage input never instantiates a Durable Object;
 * - the ONLY Durable Object call is `runResultGateSmoke(workId)`;
 * - the response is the harness report itself and carries no Telegram
 *   destination of any kind; `harness_execution` states whether the harness
 *   ran and `result_gate` is the Result Gate verdict (`"passed"`, `"failed"`
 *   or `"no_usable_verdict"`), so a recorded FAIL is never mistaken for a
 *   passing test. HTTP 200 means the sequence completed with a recorded
 *   verdict (read `result_gate` for the verdict), a harness refusal is
 *   HTTP 500 with `ok: false` and `refusal`, and an unexpected throw is
 *   HTTP 500 with a fixed body.
 *
 * The live endpoint is never invoked here: the live run is authorized
 * separately, after Architect review.
 */

const ADMIN_KEY = "test-admin-key-370";
const MARTIN_CHAT = "998877665";
const WORK_ID = `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const ROUTE = "https://enig-agent.martnkpogo.workers.dev/admin/smoke-result-gate";
const EXACT_QUERY = `origin=${RESULT_GATE_SMOKE_ORIGIN}&action=${RESULT_GATE_SMOKE_ACTION}`;

function passingReport(workId: string): ResultGateSmokeReport {
  return {
    ok: true,
    harness_execution: "completed",
    result_gate: "passed",
    work_id: workId,
    target: {
      unit: "Business Development",
      hat: "Business Development Manager",
      responsibility: "develop_opportunities",
      action: RESULT_GATE_SMOKE_ACTION,
    },
    stage: "result_review_blocked",
    evidence: [{ kind: "smoke_test", ref: workId, note: "synthetic" }],
    verification: {
      outcome: "passed",
      checker_id: "Machinery Worker Alpha",
      reason: "criteria met",
      verdict_hash: "a".repeat(64),
      evidence_refs: [{ kind: "work_record", ref: workId }],
      snapshot_key: "b".repeat(64),
    },
    approval: { staged: true, review_hash: "c".repeat(64) },
    blocked_reason: "Martin's Result approval required",
    work_closed: false,
  };
}

/**
 * The harness completed its sequence and recorded a FAILED verdict: HTTP
 * 200 with `ok: true`, but NEVER a passing Result Gate test.
 */
function failedVerdictReport(workId: string): ResultGateSmokeReport {
  return {
    ...passingReport(workId),
    result_gate: "failed",
    verification: {
      outcome: "failed",
      checker_id: "Machinery Worker Alpha",
      reason: "the producing side recorded no Result evidence, so no completion criterion is satisfied.",
      verdict_hash: "d".repeat(64),
      evidence_refs: [{ kind: "work_record", ref: workId }],
      snapshot_key: "e".repeat(64),
    },
    approval: { staged: false, review_hash: null },
    blocked_reason: "Result verification failed -- successful closure blocked",
  };
}

type FakeEnv = { env: Env; calls: { idFromName: string[]; run: string[] } };

/**
 * Fake runtime: a WORK_SESSION namespace whose stub exposes ONLY
 * `runResultGateSmoke`. Every other Durable Object method throws, so a
 * passing test also proves the route reaches nothing else.
 */
function createFakeEnv(options: { adminKey?: string; report?: ResultGateSmokeReport; throwError?: boolean } = {}): FakeEnv {
  const calls = { idFromName: [] as string[], run: [] as string[] };
  const stub = {
    runResultGateSmoke: async (workId: string) => {
      calls.run.push(workId);
      if (options.throwError) throw new Error("durable object exploded");
      return options.report ?? passingReport(workId);
    },
    getState: async () => {
      throw new Error("the smoke route must not call getState()");
    },
    execute: async () => {
      throw new Error("the smoke route must not call execute()");
    },
    init: async () => {
      throw new Error("the smoke route must not call init()");
    },
    handleTextReply: async () => {
      throw new Error("the smoke route must not call handleTextReply()");
    },
    handleCallback: async () => {
      throw new Error("the smoke route must not call handleCallback()");
    },
    cancel: async () => {
      throw new Error("the smoke route must not call cancel()");
    },
    runGoogleDocsSmoke: async () => {
      throw new Error("the smoke route must not call runGoogleDocsSmoke()");
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
    MARTIN_TELEGRAM_USER_ID: MARTIN_CHAT,
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, calls };
}

function smokeRequest(query: string | null = EXACT_QUERY, options: { key?: string | null } = {}): Request {
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
  const res = await handleResultGateSmokeRequest(smokeRequest(EXACT_QUERY, { key: null }), env);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(await res.text(), "forbidden");
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.run, []);
});

test("auth: incorrect X-Worker-Admin-Key header -> 403, no Durable Object touched", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(EXACT_QUERY, { key: "wrong-key" }), env);
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.run, []);
});

test("auth: missing WORKER_ADMIN_KEY secret -> 403 even with the right header (fail closed)", async () => {
  const { env, calls } = createFakeEnv({ adminKey: undefined });
  const res = await handleResultGateSmokeRequest(smokeRequest(EXACT_QUERY, { key: ADMIN_KEY }), env);
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(calls.idFromName, []);
  assert.deepStrictEqual(calls.run, []);
});

test("auth: an empty WORKER_ADMIN_KEY secret -> 403 (fail closed)", async () => {
  const { env, calls } = createFakeEnv({ adminKey: "" });
  const res = await handleResultGateSmokeRequest(smokeRequest(EXACT_QUERY, { key: "" }), env);
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(calls.run, []);
});

// ---------------------------------------------------------------------------
// Parameter validation -- exact target only, never a destination.
// ---------------------------------------------------------------------------

test("validation: an arbitrary origin is refused with 400 and no Durable Object", async () => {
  for (const origin of ["direct_request", "handoff_pickup", "lifecycle_transition", "user_request"]) {
    const { env, calls } = createFakeEnv();
    const res = await handleResultGateSmokeRequest(smokeRequest(`origin=${origin}&action=${RESULT_GATE_SMOKE_ACTION}`), env);
    assert.strictEqual(res.status, 400, `origin=${origin} must be refused`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /origin must be exactly "result_gate_smoke"/);
    assert.deepStrictEqual(calls.idFromName, []);
    assert.deepStrictEqual(calls.run, []);
  }
});

test("validation: an arbitrary action is refused with 400 and no Durable Object", async () => {
  for (const action of ["develop_opportunity", "diagnose", "proposal_draft", "result_gate_smoke", ""]) {
    const { env, calls } = createFakeEnv();
    const res = await handleResultGateSmokeRequest(smokeRequest(`origin=${RESULT_GATE_SMOKE_ORIGIN}&action=${action}`), env);
    assert.strictEqual(res.status, 400, `action=${action} must be refused`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /action must be exactly "result_gate_smoke_test"/);
    assert.deepStrictEqual(calls.idFromName, []);
    assert.deepStrictEqual(calls.run, []);
  }
});

test("validation: origin and action are REQUIRED -- missing, empty and incorrect values all return 400 with no Durable Object", async () => {
  const cases: Array<[label: string, query: string, expected: RegExp]> = [
    ["missing origin", `action=${RESULT_GATE_SMOKE_ACTION}`, /origin is required/],
    ["missing action", `origin=${RESULT_GATE_SMOKE_ORIGIN}`, /action is required/],
    ["both missing", "", /origin is required/],
    ["empty origin", `origin=&action=${RESULT_GATE_SMOKE_ACTION}`, /origin must be exactly/],
    ["empty action", `origin=${RESULT_GATE_SMOKE_ORIGIN}&action=`, /action must be exactly/],
    ["incorrect origin", `origin=direct_request&action=${RESULT_GATE_SMOKE_ACTION}`, /origin must be exactly/],
    ["incorrect action", `origin=${RESULT_GATE_SMOKE_ORIGIN}&action=develop_opportunity`, /action must be exactly/],
  ];
  for (const [label, query, expected] of cases) {
    const { env, calls } = createFakeEnv();
    const res = await handleResultGateSmokeRequest(smokeRequest(query), env);
    assert.strictEqual(res.status, 400, `${label} must be refused with 400`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false, label);
    assert.match(body.error, expected, `${label} -> ${body.error}`);
    // Validation happens BEFORE any Durable Object lookup or access.
    assert.deepStrictEqual(calls.idFromName, [], `${label}: no Durable Object id lookup`);
    assert.deepStrictEqual(calls.run, [], `${label}: no Durable Object method call`);
  }
});

test("validation: no parameter can name a Unit, Hat, Responsibility or Telegram destination", async () => {
  const forbidden = [
    `chat_id=${MARTIN_CHAT}`,
    `chatId=${MARTIN_CHAT}`,
    `thread_id=42`,
    `destination=${MARTIN_CHAT}`,
    "unit=Sales",
    "hat=Sales%20Executive",
    "responsibility=develop_opportunities",
    "mode=chat",
  ];
  for (const query of forbidden) {
    const { env, calls } = createFakeEnv();
    const res = await handleResultGateSmokeRequest(smokeRequest(`${EXACT_QUERY}&${query}`), env);
    assert.strictEqual(res.status, 400, `${query} must be refused`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /unknown query parameter/);
    assert.deepStrictEqual(calls.idFromName, []);
    assert.deepStrictEqual(calls.run, []);
  }
});

test("validation: a duplicate parameter is refused with 400", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(`${EXACT_QUERY}&work_id=${WORK_ID}&work_id=${WORK_ID}`), env);
  assert.strictEqual(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.match(body.error, /duplicate query parameter "work_id"/);
  assert.deepStrictEqual(calls.run, []);
});

test("validation: a foreign work_id prefix is refused with 400 and never instantiates a Durable Object", async () => {
  for (const workId of [
    "df99c0e2-e522-4853-a994-51fae8dd2f06",
    `smoke-googledocs-aaaaaaaa-0000-4000-8000-000000000000`,
    `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}not-a-uuid`,
    "",
  ]) {
    const { env, calls } = createFakeEnv();
    const res = await handleResultGateSmokeRequest(smokeRequest(`${EXACT_QUERY}&work_id=${workId}`), env);
    assert.strictEqual(res.status, 400, `work_id=${workId} must be refused`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /result-gate-smoke-/);
    assert.deepStrictEqual(calls.idFromName, []);
    assert.deepStrictEqual(calls.run, []);
  }
});

// ---------------------------------------------------------------------------
// The happy path: one fresh synthetic Work, one Durable Object call.
// ---------------------------------------------------------------------------

test("run: exact parameters generate one fresh prefixed Work id and make exactly one Durable Object call", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(), env);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as ResultGateSmokeReport;

  assert.strictEqual(body.ok, true);
  assert.ok(isResultGateSmokeWorkId(body.work_id), "the generated id carries the dedicated prefix");
  assert.deepStrictEqual(calls.idFromName, [body.work_id], "the Durable Object is keyed by exactly the reported Work id");
  assert.deepStrictEqual(calls.run, [body.work_id]);
  assert.strictEqual(calls.run.length, 1, "exactly one harness run");
});

test("run: an explicitly supplied harness work_id is used verbatim", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(`${EXACT_QUERY}&work_id=${WORK_ID}`), env);

  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as ResultGateSmokeReport;
  assert.strictEqual(body.work_id, WORK_ID);
  assert.deepStrictEqual(calls.idFromName, [WORK_ID]);
  assert.deepStrictEqual(calls.run, [WORK_ID]);
});

test("run: the admin-auth key parameter alone does not change the target", async () => {
  const { env, calls } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(`key=${ADMIN_KEY}&${EXACT_QUERY}`), env);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.run.length, 1);
  assert.ok(isResultGateSmokeWorkId(calls.run[0]));
});

test("projection: the response is the harness report and carries no Telegram destination", async () => {
  const { env } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(), env);
  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;

  assert.ok(!("chat_id" in body), "no chat id field");
  assert.ok(!("chatId" in body), "no chatId field");
  assert.ok(!("destination" in body), "no destination field");
  assert.ok(!raw.includes(MARTIN_CHAT), "Martin's Telegram id must never be reported");
  assert.ok(!raw.includes("token"), "the approval token must never be reported");
  assert.strictEqual(body.harness_execution, "completed", "the harness state is explicit");
  assert.strictEqual(body.result_gate, "passed", "the Result Gate verdict is its own explicit field");
  assert.deepStrictEqual(
    Object.keys(body).sort(),
    ["ok", "harness_execution", "result_gate", "work_id", "target", "stage", "evidence", "verification", "approval", "blocked_reason", "work_closed"].sort(),
    "the response is a fixed projection of the harness report",
  );
});

// ---------------------------------------------------------------------------
// Refusals and errors.
// ---------------------------------------------------------------------------

test("refusal: a harness refusal is HTTP 500 carrying ok:false and the exact refusal", async () => {
  const refused: ResultGateSmokeReport = {
    ...passingReport(WORK_ID),
    ok: false,
    harness_execution: "refused",
    result_gate: "no_usable_verdict",
    verification: null,
    approval: null,
    refusal: "verification_unavailable: the canonical Result verification authority page could not be read (page deleted)",
  };
  const { env, calls } = createFakeEnv({ report: refused });
  const res = await handleResultGateSmokeRequest(smokeRequest(), env);

  assert.strictEqual(res.status, 500, "an unusable smoke run is a failed run");
  const body = (await res.json()) as ResultGateSmokeReport;
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.harness_execution, "refused");
  assert.strictEqual(body.result_gate, "no_usable_verdict");
  assert.match(body.refusal ?? "", /verification_unavailable/);
  assert.strictEqual(body.verification, null);
  assert.strictEqual(body.work_closed, false);
  assert.deepStrictEqual(calls.run.length, 1, "the harness still ran and reported why it refused");
});

test("semantics: a recorded FAILED verdict is HTTP 200 with harness_execution completed but result_gate failed -- never a passing test", async () => {
  const { env, calls } = createFakeEnv({ report: failedVerdictReport(WORK_ID) });
  const res = await handleResultGateSmokeRequest(smokeRequest(`${EXACT_QUERY}&work_id=${WORK_ID}`), env);

  // The harness completed and recorded a verdict, so the run itself is 200.
  assert.strictEqual(res.status, 200, "harness execution completed");
  const body = (await res.json()) as ResultGateSmokeReport;
  assert.strictEqual(body.ok, true, "ok reports the HARNESS, not the Result Gate");
  assert.strictEqual(body.harness_execution, "completed");
  // ...and the Result Gate verdict is unmistakably FAILED.
  assert.strictEqual(body.result_gate, "failed");
  assert.notStrictEqual(body.result_gate, "passed", "a recorded FAIL is never presented as a passing Result Gate test");
  assert.strictEqual(body.verification?.outcome, "failed");
  assert.strictEqual(body.approval?.staged, false, "a FAIL stages no approval");
  assert.strictEqual(body.work_closed, false);
  assert.strictEqual(calls.run.length, 1, "exactly one harness run");
  assert.strictEqual(body.work_id, calls.run[0], "the report is that run's report");
  assert.ok(isResultGateSmokeWorkId(calls.run[0]));
});

test("semantics: a passing Result Gate test reports result_gate passed alongside harness_execution completed", async () => {
  const { env } = createFakeEnv();
  const res = await handleResultGateSmokeRequest(smokeRequest(), env);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as ResultGateSmokeReport;
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.harness_execution, "completed");
  assert.strictEqual(body.result_gate, "passed");
  assert.strictEqual(body.verification?.outcome, "passed");
});

test("error: a thrown Durable Object call is HTTP 500 with a fixed body", async () => {
  const { env, calls } = createFakeEnv({ throwError: true });
  const res = await handleResultGateSmokeRequest(smokeRequest(), env);

  assert.strictEqual(res.status, 500);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.error, "internal error, logged");
  assert.deepStrictEqual(calls.run, [calls.run[0]], "the call was attempted");
  assert.ok(!JSON.stringify(body).includes("durable object exploded"), "internal details are not echoed");
});

// ---------------------------------------------------------------------------
// Wiring and boundary pins (the Worker entry point cannot be imported here).
// ---------------------------------------------------------------------------

test("wiring: index.ts exposes GET /admin/smoke-result-gate through the handler", () => {
  const index = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const at = index.indexOf('url.pathname === "/admin/smoke-result-gate" && request.method === "GET"');
  assert.ok(at > -1, "the GET route exists");
  const slice = index.slice(at, at + 400);
  assert.ok(slice.includes("return handleResultGateSmokeRequest(request, env);"), "the route delegates to the handler");
  assert.ok(index.includes('import { handleResultGateSmokeRequest } from "./resultGateSmokeRoute";'), "the handler is imported");
});

test("boundary: the handler authorizes before it parses or touches a Durable Object", () => {
  const source = fs.readFileSync(path.join(__dirname, "resultGateSmokeRoute.ts"), "utf8");
  const authAt = source.indexOf("isAdminAuthorized(request, env)");
  const parseAt = source.indexOf("parseResultGateSmokeParams(");
  const stubAt = source.indexOf("getSessionStub(env, workId)");
  assert.ok(authAt > -1 && parseAt > -1 && stubAt > -1);
  assert.ok(authAt < parseAt, "authentication precedes parameter parsing");
  assert.ok(parseAt < stubAt, "parameter validation precedes any Durable Object instantiation");
  assert.equal((source.match(/getSessionStub\(/g) ?? []).length, 1, "exactly one Durable Object access");
  assert.equal((source.match(/\.runResultGateSmoke\(/g) ?? []).length, 1, "exactly one harness call");
});
