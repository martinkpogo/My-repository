import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./types";
import {
  isFallbackEligible,
  kvDelete,
  kvFallbackStatus,
  kvGet,
  kvList,
  kvPut,
  maybeSweepKvFallback,
  sweepKvFallback,
  __resetKvStoreStateForTests,
  __setNowForTests,
  __setTursoFetchForTests,
} from "./kvStore";

/**
 * Section 5B tests: KV-primary / Turso-secondary coordination-state store.
 *
 * These prove the three properties the Architect approved:
 *   1. The data-class boundary: only allowlisted coordination keys ever
 *      reach Turso; conversation content, OAuth state and unknown keys
 *      never leave Cloudflare (the KV error surfaces exactly as before).
 *   2. Resilience: a KV write outage is absorbed for eligible keys (writes
 *      land in the fallback, reads keep working) and the original KV error
 *      still surfaces when there is no eligible fallback path.
 *   3. Reconciliation: fallback rows drain back into KV (opportunistic
 *      repair on read + the throttled sweep), a successful KV write clears
 *      its own shadow row, and the circuit breaker skips doomed KV writes
 *      during an outage window.
 *
 * Everything runs against an in-memory KV fake and an in-process fake of
 * Turso's /v2/pipeline HTTP API -- no network, no new runtime dependency.
 */

interface KvFake {
  store: Map<string, string>;
  putCalls: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }>;
  deleteCalls: string[];
  listCalls: number;
  failPut: boolean;
  failGet: boolean;
  failDelete: boolean;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean }>;
}

function makeKv(): KvFake {
  const fake: KvFake = {
    store: new Map(),
    putCalls: [],
    deleteCalls: [],
    listCalls: 0,
    failPut: false,
    failGet: false,
    failDelete: false,
    async get(key: string): Promise<string | null> {
      if (fake.failGet) throw new Error("kv get boom");
      return fake.store.has(key) ? fake.store.get(key)! : null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      fake.putCalls.push({ key, value, opts });
      if (fake.failPut) throw new Error("kv put boom");
      fake.store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      fake.deleteCalls.push(key);
      if (fake.failDelete) throw new Error("kv delete boom");
      fake.store.delete(key);
    },
    async list(opts: { prefix: string }): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
      fake.listCalls += 1;
      const keys = [...fake.store.keys()].filter((k) => k.startsWith(opts.prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
  return fake;
}

interface TursoFake {
  rows: Map<string, { value: string; expires_at: number | null; updated_at: number }>;
  calls: Array<{ url: string; requests: Array<{ type: string; stmt: { sql: string; args: unknown[] } }> }>;
  failAll: boolean;
  fetch: typeof fetch;
}

function makeTurso(): TursoFake {
  const fake: TursoFake = { rows: new Map(), calls: [], failAll: false, fetch: undefined as unknown as typeof fetch };
  const argValue = (a: unknown): string | number | null => {
    if (a === null || a === undefined) return null;
    if (typeof a === "object") return (a as { value: string | number }).value;
    return a as string | number;
  };
  const handle = (request: { stmt: { sql: string; args?: unknown[] } }): Record<string, unknown> => {
    const sql = request.stmt.sql;
    const args = (request.stmt.args ?? []).map(argValue);
    if (sql.startsWith("CREATE TABLE")) return { type: "execute", response: { type: "ok" } };
    if (sql.startsWith("INSERT INTO")) {
      const [key, value, expiresAt, updatedAt] = args as [string, string, string | null, string];
      fake.rows.set(key, { value, expires_at: expiresAt === null ? null : Number(expiresAt), updated_at: Number(updatedAt) });
      return { type: "execute", response: { type: "ok" } };
    }
    if (sql.startsWith("DELETE FROM")) {
      fake.rows.delete(args[0] as string);
      return { type: "execute", response: { type: "ok" } };
    }
    if (sql.startsWith('SELECT "value"')) {
      const row = fake.rows.get(args[0] as string);
      return {
        type: "query",
        response: {
          type: "rows",
          columns: ["value", "expires_at"],
          rows: row
            ? [
                {
                  name: "r",
                  columns: [
                    { type: "text", value: row.value },
                    row.expires_at === null ? null : { type: "integer", value: String(row.expires_at) },
                  ],
                },
              ]
            : [],
        },
      };
    }
    if (sql.startsWith('SELECT "key" FROM') && sql.includes("substr")) {
      const prefix = args[0] as string;
      const matched = [...fake.rows.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: "r", columns: [{ type: "text", value: k }] }));
      return { type: "query", response: { type: "rows", columns: ["key"], rows: matched } };
    }
    if (sql.startsWith('SELECT "key", "value", "expires_at"')) {
      const limitMatch = sql.match(/LIMIT (\d+)/);
      const limit = limitMatch ? Number(limitMatch[1]) : fake.rows.size;
      const sorted = [...fake.rows.entries()].sort((a, b) => a[1].updated_at - b[1].updated_at).slice(0, limit);
      return {
        type: "query",
        response: {
          type: "rows",
          columns: ["key", "value", "expires_at"],
          rows: sorted.map(([k, row]) => ({
            name: "r",
            columns: [
              { type: "text", value: k },
              { type: "text", value: row.value },
              row.expires_at === null ? null : { type: "integer", value: String(row.expires_at) },
            ],
          })),
        },
      };
    }
    if (sql.startsWith("SELECT COUNT(*)")) {
      return {
        type: "query",
        response: { type: "rows", columns: ["n"], rows: [{ name: "r", columns: [{ type: "integer", value: String(fake.rows.size) }] }] },
      };
    }
    throw new Error(`fake Turso got unexpected SQL: ${sql}`);
  };
  fake.fetch = (async (url: unknown, init: unknown) => {
    const requests = (JSON.parse((init as { body: string }).body) as { requests: TursoFake["calls"][number]["requests"] }).requests;
    fake.calls.push({ url: String(url), requests });
    if (fake.failAll) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    const results = requests.map((r) => handle(r));
    return { ok: true, status: 200, json: async () => ({ results }) } as unknown as Response;
  }) as typeof fetch;
  return fake;
}

function reset(): void {
  __resetKvStoreStateForTests();
  __setTursoFetchForTests(undefined);
  __setNowForTests(undefined);
}

function makeEnv(kv: KvFake, turso?: TursoFake): Env {
  return {
    STATE_KV: kv,
    ...(turso ? { TURSO_DATABASE_URL: "libsql://enig-fallback-test.turso.io", TURSO_AUTH_TOKEN: "test-turso-token" } : {}),
  } as unknown as Env;
}

function seedRow(turso: TursoFake, key: string, value: string, expiresAt: number | null = null): void {
  turso.rows.set(key, { value, expires_at: expiresAt, updated_at: Date.now() });
}

// ---------------------------------------------------------------------------
// 1. Passthrough + classification
// ---------------------------------------------------------------------------

test("unconfigured Turso: every operation is an exact STATE_KV passthrough", async () => {
  reset();
  const kv = makeKv();
  const env = makeEnv(kv);
  await kvPut(env, "active:1:dm", "work-1");
  assert.equal(await kvGet(env, "active:1:dm"), "work-1");
  await kvDelete(env, "active:1:dm");
  assert.equal(await kvGet(env, "active:1:dm"), null);
  const page = await kvList(env, { prefix: "active:" });
  assert.deepEqual(page.keys, []);
  assert.equal(kv.listCalls, 1);
  assert.equal(kv.putCalls.length, 1);
});

test("classification: coordination keys eligible, content/identity/OAuth/unknown keys never", () => {
  reset();
  const eligible = [
    "active:1:dm",
    "mode:-100:604",
    "cowork_pending:1:604",
    "reply_msg:42",
    "matter_current_work:MAT-1",
    "sessions_index",
    "pending_approval_backlog_last_alert",
    "google_comment_processed:c-1",
    "google_comment_clarification_pending:c-1",
    "handoff_workitem:h-1",
    "sales_handoff_notified:h-1",
    "stale_handoff_digest_last_sent",
    "stale_handoff_digest_last_fingerprint",
    "checkhandoffs_auto_inflight",
    "last_cron_run",
    "last_google_doc_comment_poll_run",
    "last_google_sheet_comment_poll_run",
    "watchdog_alert_last_sent",
    "google_doc_watch:doc-1",
    "google_sheet_watch:sheet-1",
    "google_option:w-1:abc",
    "google_drive_default_folder:acct-1",
  ];
  for (const key of eligible) assert.equal(isFallbackEligible(key), true, `${key} must be fallback-eligible`);

  const never = [
    "chat_history:1:dm", // conversation content
    "lookup_history:1:dm:matters", // lookup results that may carry real identity
    "governance:page-1", // cached Notion page content
    "google_oauth_state:csrf", // OAuth CSRF state
    "google_oauth_tokens:default", // OAuth tokens
    "some_future_key", // unknown keys default to Cloudflare-only (fail-closed data boundary)
  ];
  for (const key of never) assert.equal(isFallbackEligible(key), false, `${key} must NEVER fall back`);
});

// ---------------------------------------------------------------------------
// 2. Write resilience + data boundary
// ---------------------------------------------------------------------------

test("KV write failure: eligible key lands in the Turso fallback and nothing throws", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failPut = true;
  await kvPut(env, "active:1:dm", "work-1");
  assert.equal(turso.rows.get("active:1:dm")?.value, "work-1");
  assert.equal(kv.store.has("active:1:dm"), false);
});

test("KV write failure: an ineligible key never reaches Turso and the KV error surfaces unchanged", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failPut = true;
  await assert.rejects(() => kvPut(env, "chat_history:1:dm", "[{...}]"), /kv put boom/);
  await assert.rejects(() => kvPut(env, "google_oauth_tokens:default", "secret"), /kv put boom/);
  await assert.rejects(() => kvPut(env, "unknown_future_key", "value"), /kv put boom/);
  assert.equal(turso.calls.length, 0, "no Turso request may be made for ineligible keys");
  assert.equal(turso.rows.size, 0);
});

test("KV and Turso both failing: the original KV error is rethrown (fail-closed, pre-§5B contract)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failPut = true;
  turso.failAll = true;
  await assert.rejects(() => kvPut(env, "sessions_index", "[]"), /kv put boom/);
});

test("successful eligible KV write clears its own stale shadow row (sweep can never resurrect it)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "sessions_index", "[]");
  await kvPut(env, "sessions_index", "[fresh]");
  assert.equal(kv.store.get("sessions_index"), "[fresh]");
  assert.equal(turso.rows.has("sessions_index"), false, "the shadow row must be deleted after a successful KV write");
});

// ---------------------------------------------------------------------------
// 3. Read resilience + opportunistic repair
// ---------------------------------------------------------------------------

test("KV miss with a live fallback row: read serves from Turso and repairs KV in place", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "active:1:dm", "work-9");
  assert.equal(await kvGet(env, "active:1:dm"), "work-9");
  assert.equal(kv.store.get("active:1:dm"), "work-9", "KV must be repaired so the next read needs no Turso round trip");
  assert.equal(turso.rows.has("active:1:dm"), false, "the repaired row must not linger as a stale shadow");
});

test("expired fallback row: read reports a miss and drops the row", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  __setNowForTests(() => 1_000_000_000_000);
  const env = makeEnv(kv, turso);
  seedRow(turso, "reply_msg:1", "work-old", 999_999_999_000); // expired long before the injected now()
  assert.equal(await kvGet(env, "reply_msg:1"), null);
  assert.equal(turso.rows.has("reply_msg:1"), false);
});

test("KV read itself failing with a live fallback row: the fallback value is served", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "handoff_workitem:h-1", "work-1");
  kv.failGet = true;
  assert.equal(await kvGet(env, "handoff_workitem:h-1"), "work-1");
});

test("KV read failing with no fallback row: the KV error surfaces (unchanged contract)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failGet = true;
  await assert.rejects(() => kvGet(env, "active:1:dm"), /kv get boom/);
});

test("KV hit: the fallback is never consulted (KV stays the primary store)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.store.set("active:1:dm", "work-1");
  assert.equal(await kvGet(env, "active:1:dm"), "work-1");
  assert.equal(turso.calls.length, 0, "a KV hit must not cost a Turso round trip");
});

// ---------------------------------------------------------------------------
// 4. Deletes
// ---------------------------------------------------------------------------

test("successful eligible KV delete also clears the fallback copy", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "active:1:dm", "work-1");
  kv.store.set("active:1:dm", "work-1");
  await kvDelete(env, "active:1:dm");
  assert.equal(kv.store.has("active:1:dm"), false);
  assert.equal(turso.rows.has("active:1:dm"), false);
});

test("KV delete failure: the fallback copy is cleared too, then the KV error is rethrown (no resurrection)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "cowork_pending:1:604", "1");
  kv.store.set("cowork_pending:1:604", "1");
  kv.failDelete = true;
  await assert.rejects(() => kvDelete(env, "cowork_pending:1:604"), /kv delete boom/);
  assert.equal(turso.rows.has("cowork_pending:1:604"), false, "a swept row must never resurrect a pointer this call cleared");
  assert.equal(kv.store.get("cowork_pending:1:604"), "1", "KV is unchanged by the failed delete, exactly as before §5B");
});

// ---------------------------------------------------------------------------
// 5. Circuit breaker
// ---------------------------------------------------------------------------

test("circuit: consecutive KV put failures open it, writes skip KV during the window, a successful probe closes it", async () => {
  reset();
  let currentNow = 1_000_000_000_000;
  __setNowForTests(() => currentNow);
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failPut = true;

  await kvPut(env, "active:1:dm", "v1"); // failure 1 -- KV attempted
  await kvPut(env, "active:1:dm", "v2"); // failure 2 -- circuit opens
  assert.equal(kv.putCalls.length, 2);

  await kvPut(env, "active:1:dm", "v3"); // circuit open -- KV must be skipped
  assert.equal(kv.putCalls.length, 2, "an open circuit must not attempt KV");
  assert.equal(turso.rows.get("active:1:dm")?.value, "v3");

  const status = await kvFallbackStatus(env);
  assert.equal(status.circuit_open, true);
  assert.equal(status.consecutive_kv_failures, 2);

  currentNow += 61_000; // cooldown elapsed -- the next attempt is the probe
  kv.failPut = false;
  await kvPut(env, "active:1:dm", "v4");
  assert.equal(kv.putCalls.length, 3, "the probe must retry KV");
  assert.equal(kv.store.get("active:1:dm"), "v4");
  assert.equal((await kvFallbackStatus(env)).circuit_open, false, "a successful probe must close the circuit");
});

// ---------------------------------------------------------------------------
// 6. Reconciliation sweep
// ---------------------------------------------------------------------------

test("sweep: live rows drain back into KV with remaining TTL; expired rows are dropped", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  __setNowForTests(() => 1_000_000_000_000);
  const env = makeEnv(kv, turso);
  seedRow(turso, "active:1:dm", "work-1");
  seedRow(turso, "sessions_index", "[...]");
  seedRow(turso, "reply_msg:9", "work-old", 999_999_999_000); // expired
  const result = await sweepKvFallback(env);
  assert.equal(result.swept, 2);
  assert.equal(result.expired, 1);
  assert.equal(kv.store.get("active:1:dm"), "work-1");
  assert.equal(kv.store.get("sessions_index"), "[...]");
  assert.equal(turso.rows.size, 0, "the fallback must be empty after a complete sweep");
});

test("sweep with KV still refusing writes: rows are held, nothing is lost, nothing is claimed", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "active:1:dm", "work-1");
  kv.failPut = true;
  const result = await sweepKvFallback(env);
  assert.equal(result.swept, 0);
  assert.equal(turso.rows.get("active:1:dm")?.value, "work-1", "the row must remain held for a later pass");
});

test("maybeSweep: throttled (null inside the window, runs again after it) and null when unconfigured", async () => {
  reset();
  let currentNow = 1_000_000_000_000;
  __setNowForTests(() => currentNow);
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "sessions_index", "[x]");
  assert.ok(await maybeSweepKvFallback(env)); // runs
  assert.equal(turso.rows.size, 0);
  seedRow(turso, "sessions_index", "[y]");
  assert.equal(await maybeSweepKvFallback(env), null, "immediately re-running must be throttled");
  assert.equal(turso.rows.has("sessions_index"), true);
  currentNow += 16 * 60_000;
  assert.ok(await maybeSweepKvFallback(env));
  assert.equal(turso.rows.size, 0);

  const bare = makeKv();
  assert.equal(await maybeSweepKvFallback(makeEnv(bare)), null, "unconfigured means a no-op");
});

// ---------------------------------------------------------------------------
// 7. Merged listing + status
// ---------------------------------------------------------------------------

test("kvList: eligible prefixes merge fallback rows into the KV page; ineligible prefixes are passthrough", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.store.set("google_doc_watch:doc-1", "{}");
  seedRow(turso, "google_doc_watch:doc-2", "{}");
  const page = await kvList(env, { prefix: "google_doc_watch:" });
  assert.deepEqual(
    page.keys.map((k) => k.name).sort(),
    ["google_doc_watch:doc-1", "google_doc_watch:doc-2"],
    "the merged page must carry both KV and fallback keys",
  );

  const callsBefore = turso.calls.length;
  const oauthPage = await kvList(env, { prefix: "google_oauth_tokens:" });
  assert.deepEqual(oauthPage.keys, []);
  assert.equal(turso.calls.length, callsBefore, "an ineligible prefix must never query Turso");
});

test("kvFallbackStatus: reports configuration and counts, and never leaks the auth token", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "active:1:dm", "work-1");
  const status = await kvFallbackStatus(env);
  assert.equal(status.configured, true);
  assert.equal(status.fallback_rows, 1);
  assert.equal(JSON.stringify(status).includes("test-turso-token"), false);

  const bare = await kvFallbackStatus(makeEnv(makeKv()));
  assert.equal(bare.configured, false);
  assert.equal(bare.fallback_rows, null);
});

// ---------------------------------------------------------------------------
// 8. End-to-end quota window
// ---------------------------------------------------------------------------

test("quota window end to end: outage absorbed for coordination state, recovery reconciled, content never sent", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);

  // The outage: KV accepts reads but every write fails (observed 2026-10-09).
  kv.failPut = true;
  await kvPut(env, "active:1:dm", "work-1"); // routing pointer
  await kvPut(env, "google_comment_processed:c-1", "1"); // dedup marker
  await kvPut(env, "sessions_index", JSON.stringify([{ workId: "work-1" }]));
  await assert.rejects(() => kvPut(env, "chat_history:1:dm", '[{"user":"hi"}]'), /kv put boom/);
  assert.equal(turso.rows.size, 3, "exactly the three coordination keys are in the fallback");

  // Reads keep working through the outage.
  assert.equal(await kvGet(env, "active:1:dm"), "work-1");
  assert.equal(await kvGet(env, "google_comment_processed:c-1"), "1");

  // Recovery: KV accepts writes again; the throttled heartbeat drains the fallback.
  kv.failPut = false;
  let currentNow = 1_000_000_000_000;
  __setNowForTests(() => currentNow);
  currentNow += 16 * 60_000;
  const swept = await maybeSweepKvFallback(env);
  assert.ok(swept);
  assert.equal(swept.swept, 3);
  assert.equal(kv.store.get("active:1:dm"), "work-1");
  assert.equal(kv.store.get("google_comment_processed:c-1"), "1");
  assert.equal(turso.rows.size, 0, "steady state holds nothing in Turso");
  assert.equal(kv.store.has("chat_history:1:dm"), false, "conversation content never left Cloudflare at any point");
});
