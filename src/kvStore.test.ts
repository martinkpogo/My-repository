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
  calls: Array<{ url: string; requests: Array<{ type: string; stmt?: { sql: string; args: unknown[] } }> }>;
  failAll: boolean;
  /** Fails only DELETE statements -- simulates a shadow delete refused while inserts still work. */
  failDeletes: boolean;
  fetch: typeof fetch;
}

function makeTurso(): TursoFake {
  const fake: TursoFake = { rows: new Map(), calls: [], failAll: false, failDeletes: false, fetch: undefined as unknown as typeof fetch };
  const argValue = (a: unknown): string | number | null => {
    if (a === null || a === undefined) return null;
    if (typeof a === "object") return (a as { value: string | number }).value;
    return a as string | number;
  };
  const handle = (request: { type: string; stmt?: { sql: string; args?: unknown[] } }): Record<string, unknown> => {
    if (request.type === "close") return { type: "ok", response: { type: "close" } };
    const sql = request.stmt?.sql ?? "";
    const args = (request.stmt?.args ?? []).map(argValue);
    // Turso's documented /v2/pipeline envelope: {type:"ok", response:{type:"execute", result:{cols, rows, ...}}}
    // with rows as arrays of typed cells ({type, value} | null).
    const executed = (rows: Array<Array<{ type: string; value: string } | null>>, affected = 0): Record<string, unknown> => ({
      type: "ok",
      response: { type: "execute", result: { cols: [], rows, affected_row_count: affected, last_insert_rowid: null } },
    });
    if (sql.startsWith("CREATE TABLE")) return executed([], 0);
    if (sql.startsWith("INSERT INTO")) {
      const [key, value, expiresAt, updatedAt] = args as [string, string, string | null, string];
      fake.rows.set(key, { value, expires_at: expiresAt === null ? null : Number(expiresAt), updated_at: Number(updatedAt) });
      return executed([], 1);
    }
    if (sql.startsWith("DELETE FROM")) {
      fake.rows.delete(args[0] as string);
      return executed([], 1);
    }
    if (sql.startsWith('SELECT "value"')) {
      const row = fake.rows.get(args[0] as string);
      return executed(
        row
          ? [
              [
                { type: "text", value: row.value },
                row.expires_at === null ? null : { type: "integer", value: String(row.expires_at) },
                { type: "integer", value: String(row.updated_at) },
              ],
            ]
          : [],
      );
    }
    if (sql.startsWith('SELECT "key" FROM') && sql.includes("substr")) {
      const prefix = args[0] as string;
      return executed([...fake.rows.keys()].filter((k) => k.startsWith(prefix)).map((k) => [{ type: "text", value: k }]));
    }
    if (sql.startsWith('SELECT "key", "value", "expires_at"')) {
      const limitMatch = sql.match(/LIMIT (\d+)/);
      const limit = limitMatch ? Number(limitMatch[1]) : fake.rows.size;
      const sorted = [...fake.rows.entries()].sort((a, b) => a[1].updated_at - b[1].updated_at).slice(0, limit);
      return executed(
        sorted.map(([k, row]) => [
          { type: "text", value: k },
          { type: "text", value: row.value },
          row.expires_at === null ? null : { type: "integer", value: String(row.expires_at) },
          { type: "integer", value: String(row.updated_at) },
        ]),
      );
    }
    if (sql.startsWith("SELECT COUNT(*)")) {
      return executed([[{ type: "integer", value: String(fake.rows.size) }]]);
    }
    throw new Error(`fake Turso got unexpected SQL: ${sql}`);
  };
  fake.fetch = (async (url: unknown, init: unknown) => {
    const requests = (JSON.parse((init as { body: string }).body) as { requests: TursoFake["calls"][number]["requests"] }).requests;
    fake.calls.push({ url: String(url), requests });
    if (fake.failAll) return { ok: false, status: 500, json: async () => ({}), text: async () => "simulated Turso outage" } as unknown as Response;
    const hasDelete = requests.some((r) => (r.stmt?.sql ?? "").startsWith("DELETE FROM"));
    if (fake.failDeletes && hasDelete) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => "simulated delete refusal" } as unknown as Response;
    }
    const results = requests.map((r) => handle(r as { type: string; stmt?: { sql: string; args?: unknown[] } }));
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" } as unknown as Response;
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

function seedRow(turso: TursoFake, key: string, value: string, expiresAt: number | null = null, updatedAt: number = Date.now()): void {
  turso.rows.set(key, { value, expires_at: expiresAt, updated_at: updatedAt });
}

/**
 * Read back what a fake store holds: eligible values are written as the
 * versioned envelope {"__enig_kv":1,"seq":...,"val":<raw>}, so tests assert
 * on the DECODED raw value (and can inspect the envelope itself when the
 * envelope is the subject, e.g. tombstones).
 */
function unwrap(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { __enig_kv?: number; val?: string; tombstone?: number };
    if (parsed && parsed.__enig_kv === 1 && typeof parsed.val === "string") return parsed.val;
  } catch {
    /* not JSON -- a legacy plain value */
  }
  return raw;
}

function isTombstone(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const parsed = JSON.parse(raw) as { __enig_kv?: number; tombstone?: number };
    return Boolean(parsed && parsed.__enig_kv === 1 && parsed.tombstone === 1);
  } catch {
    return false;
  }
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

test("classification: coordination keys eligible, content/identity/OAuth/content-bearing keys never (value-level)", () => {
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
  ];
  for (const key of eligible) assert.equal(isFallbackEligible(key), true, `${key} must be fallback-eligible`);

  const never = [
    "chat_history:1:dm", // conversation content
    "lookup_history:1:dm:matters", // lookup results that may carry real identity
    "governance:page-1", // cached Notion page content
    "google_oauth_state:csrf", // OAuth CSRF state
    "google_oauth_tokens:default", // OAuth tokens
    "google_option:w-1:abc", // approval-option staging: Doc bodies, Sheet rows, titles, account email
    "google_doc_watch:doc-1", // watch registry: account email + Doc title, required by the poll
    "google_sheet_watch:sheet-1", // watch registry: account email + Sheet title, required by the poll
    "google_drive_default_folder:me@example.com", // folder cache: the KEY embeds the account email
    "google_proposal_docs_folder:me@example.com", // same class -- never silently added to the allowlist
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
  assert.equal(unwrap(turso.rows.get("active:1:dm")?.value), "work-1");
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
  assert.equal(unwrap(kv.store.get("sessions_index")), "[fresh]");
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
  assert.equal(unwrap(kv.store.get("active:1:dm")), "work-9", "KV must be repaired so the next read needs no Turso round trip");
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

test("KV hit: Turso IS consulted (version check) but an empty table means no state change -- the stale-row case can only be resolved by consulting it", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.store.set("active:1:dm", "work-1");
  assert.equal(await kvGet(env, "active:1:dm"), "work-1", "the KV value is served");
  assert.ok(turso.calls.length > 0, "every eligible read consults Turso for a possibly-newer fallback row");
  assert.equal(turso.rows.size, 0, "steady state: the empty table changes nothing");

  // The reason the consultation exists: a fallback row NEWER than the KV
  // hit must win (see the stale-read regression test below) -- a KV-only
  // read would have returned the older value as if the write succeeded.
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
  assert.equal(unwrap(turso.rows.get("active:1:dm")?.value), "v3");

  const status = await kvFallbackStatus(env);
  assert.equal(status.circuit_open, true);
  assert.equal(status.consecutive_kv_failures, 2);

  currentNow += 61_000; // cooldown elapsed -- the next attempt is the probe
  kv.failPut = false;
  await kvPut(env, "active:1:dm", "v4");
  assert.equal(kv.putCalls.length, 3, "the probe must retry KV");
  assert.equal(unwrap(kv.store.get("active:1:dm")), "v4");
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
  assert.equal(unwrap(kv.store.get("active:1:dm")), "work-1");
  assert.equal(unwrap(kv.store.get("sessions_index")), "[...]");
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
  assert.equal(unwrap(turso.rows.get("active:1:dm")?.value), "work-1", "the row must remain held for a later pass");
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

test("kvList: eligible prefixes merge fallback rows into the KV page; removed/cloudflare-only prefixes are passthrough", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.store.set("handoff_workitem:h-1", "work-1");
  seedRow(turso, "handoff_workitem:h-2", "work-2");
  const page = await kvList(env, { prefix: "handoff_workitem:" });
  assert.deepEqual(
    page.keys.map((k) => k.name).sort(),
    ["handoff_workitem:h-1", "handoff_workitem:h-2"],
    "the merged page must carry both KV and fallback keys",
  );

  const callsBefore = turso.calls.length;
  const oauthPage = await kvList(env, { prefix: "google_oauth_tokens:" });
  assert.deepEqual(oauthPage.keys, []);
  assert.equal(turso.calls.length, callsBefore, "an ineligible prefix must never query Turso");

  // The watch registries were REMOVED from eligibility (values carry the
  // account email + file titles): even with a fallback row present they are
  // a pure Cloudflare passthrough, never a merge.
  kv.store.set("google_doc_watch:doc-1", "{}");
  seedRow(turso, "google_doc_watch:doc-2", "{}");
  const watchPage = await kvList(env, { prefix: "google_doc_watch:" });
  assert.deepEqual(watchPage.keys.map((k) => k.name), ["google_doc_watch:doc-1"], "the KV page passes through unmerged");
  assert.equal(turso.calls.length, callsBefore, "a removed class must never query Turso");
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

test("quota window end to end: outage absorbed for coordination state, recovery reconciled, content never sent", async () => {  reset();
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
  // Inspect the ACTUAL Turso-bound bytes (not just the key name): eligible
  // values travel as the versioned envelope around the caller's raw value.
  assert.equal(unwrap(turso.rows.get("active:1:dm")?.value), "work-1");
  assert.equal(unwrap(turso.rows.get("sessions_index")?.value), JSON.stringify([{ workId: "work-1" }]));

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
  assert.equal(unwrap(kv.store.get("active:1:dm")), "work-1");
  assert.equal(unwrap(kv.store.get("google_comment_processed:c-1")), "1");
  assert.equal(turso.rows.size, 0, "steady state holds nothing in Turso");
  assert.equal(kv.store.has("chat_history:1:dm"), false, "conversation content never left Cloudflare at any point");
});

test("Turso wire contract: only execute/close request types are sent and every pipeline ends with close (regression: the legacy 'query' type is rejected HTTP 400)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  seedRow(turso, "active:1:dm", "work-1");
  await kvGet(env, "active:1:dm"); // SELECT path (+ repair)
  await kvPut(env, "sessions_index", "[]"); // INSERT path (+ shadow DELETE)
  await kvDelete(env, "active:1:dm"); // DELETE path
  await sweepKvFallback(env); // sweep SELECT + DELETE
  await kvFallbackStatus(env); // COUNT path
  assert.ok(turso.calls.length > 0, "the exercise must have produced Turso traffic");
  for (const call of turso.calls) {
    const types = call.requests.map((r) => r.type);
    assert.ok(
      types.every((t) => t === "execute" || t === "close"),
      `only execute/close may be sent (Turso rejects anything else with HTTP 400): ${JSON.stringify(types)}`,
    );
    assert.equal(types[types.length - 1], "close", "every pipeline must close its connection");
    for (const request of call.requests) {
      if (request.type === "execute") assert.ok(request.stmt?.sql, "every execute request carries its statement");
    }
  }
});

test("HTTP failures surface Turso's response body in the error (diagnosability regression)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failPut = true;
  turso.failAll = true;
  // Both stores refusing with the circuit still closed surfaces the KV error
  // (fail-closed continuity, tested above); once the circuit is open no KV
  // attempt happens, so the Turso error is the only evidence and must carry
  // the response body -- without it the production 400s were undiagnosable.
  await assert.rejects(() => kvPut(env, "sessions_index", "[]"), /kv put boom/);
  await assert.rejects(() => kvPut(env, "sessions_index", "[]"), /kv put boom/); // second consecutive failure opens the circuit
  await assert.rejects(() => kvPut(env, "sessions_index", "[]"), /Turso HTTP 500: simulated Turso outage/);
});

// ---------------------------------------------------------------------------
// 10. Conflict-resolution contract (versioned envelope) -- the §5B follow-up
//     regressions. Each mirrors a real failure mode found in the audit.
// ---------------------------------------------------------------------------

test("regression 1: failed KV write of a newer value -- a read must not silently return the older KV hit (stale-read fix)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.store.set("active:1:dm", "old"); // the value KV still holds (legacy bytes, seq 0)

  kv.failPut = true; // the write of "new" is refused by KV, so it lands in Turso only
  await kvPut(env, "active:1:dm", "new");
  kv.failPut = false;
  assert.equal(kv.store.get("active:1:dm"), "old", "precondition: KV still holds the older value");

  // Pre-fix kvGet returned the KV hit without consulting Turso: "old" was
  // served as if the write of "new" had succeeded.
  assert.equal(await kvGet(env, "active:1:dm"), "new", "the newer fallback row must win");
  assert.equal(unwrap(kv.store.get("active:1:dm")), "new", "the read repairs KV so later reads are consistent");
  assert.equal(turso.rows.size, 0, "the repaired shadow is cleared");

  // Retry after partial persistence: a later successful write re-establishes
  // single-store truth without leaving a conflict candidate behind.
  await kvPut(env, "active:1:dm", "newest");
  assert.equal(await kvGet(env, "active:1:dm"), "newest");
  assert.equal(turso.rows.size, 0);
});

test("regression 2: shadow-delete failure after a successful KV write -- neither read nor sweep may overwrite the newer KV value with the stale row", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  let currentNow = 1_000_000_000_000;
  __setNowForTests(() => currentNow);
  const env = makeEnv(kv, turso);

  kv.failPut = true; // t0: write of "old" fails in KV -> Turso row (seq t0)
  await kvPut(env, "active:1:dm", "old");
  kv.failPut = false;

  currentNow += 1_000; // t1: KV recovers; write of "new" succeeds but the shadow delete is refused
  turso.failDeletes = true;
  await kvPut(env, "active:1:dm", "new");
  turso.failDeletes = false;
  assert.equal(unwrap(turso.rows.get("active:1:dm")?.value), "old", "precondition: a stale row now sits behind a newer KV value");
  assert.equal(unwrap(kv.store.get("active:1:dm")), "new");

  // Read path: KV wins (higher version) and the stale row is cleared.
  assert.equal(await kvGet(env, "active:1:dm"), "new", "the newer KV value must be served, never the stale row");
  assert.equal(turso.rows.size, 0, "the stale row is cleared on read");

  // And the sweep path independently: re-seed the same stale conflict.
  kv.store.set("active:1:dm", JSON.stringify({ __enig_kv: 1, seq: currentNow, val: "new" }));
  seedRow(turso, "active:1:dm", "old", null, currentNow - 1_000);
  const result = await sweepKvFallback(env);
  assert.equal(result.superseded, 1, "the stale row must be superseded, not restored");
  assert.equal(result.swept, 0, "nothing may be written over the newer KV value");
  assert.equal(unwrap(kv.store.get("active:1:dm")), "new");
  assert.equal(turso.rows.size, 0);
});

test("regression 3: restart recovery -- version decisions survive an isolate restart and resolve both directions", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  let currentNow = 1_000_000_000_000;
  __setNowForTests(() => currentNow);
  const env = makeEnv(kv, turso);

  // Case A: failed KV write left a NEWER row behind an OLDER KV value.
  kv.store.set("active:1:dm", "kv-old");
  kv.failPut = true;
  await kvPut(env, "active:1:dm", "row-new");
  kv.failPut = false;

  // Case B: a successful KV write left a STALE row behind a NEWER KV value.
  currentNow += 1_000;
  turso.failDeletes = true;
  kv.store.delete("mode:-100:604"); // ensure a clean KV side
  await kvPut(env, "mode:-100:604", "kv-new"); // first write of this key: KV succeeds, shadow n/a
  turso.failDeletes = false;
  // (no stale row for case B here -- covered by regression 2; instead seed an
  // older-versioned stale row for this key to model a pre-restart leftover)
  seedRow(turso, "mode:-100:604", "stale", null, currentNow - 5_000);

  __resetKvStoreStateForTests(); // restart: all isolate memory (circuit, lastSweep) is gone
  __setNowForTests(() => currentNow + 60_000);

  assert.equal(await kvGet(env, "active:1:dm"), "row-new", "restart + newer row: the row must win and repair KV");
  assert.equal(unwrap(kv.store.get("active:1:dm")), "row-new");
  assert.equal(await kvGet(env, "mode:-100:604"), "kv-new", "restart + newer KV: KV must win, the stale row never resurfaces");
  assert.equal(turso.rows.size, 0, "both losers were cleared after the restart");

  // The sweep applies the same post-restart discipline: nothing newer is overwritten.
  // (updated_at strictly older than row-new's seq so the row is the loser.)
  seedRow(turso, "active:1:dm", "post-restart-stale", null, currentNow - 2_000);
  const swept = await sweepKvFallback(env);
  assert.equal(swept.superseded, 1, "a stale row found after a restart is superseded by the newer KV value");
  assert.equal(unwrap(kv.store.get("active:1:dm")), "row-new");
});

test("regression 4: KV read failure + expired fallback row -- the expired value is never served", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  __setNowForTests(() => 1_000_000_000_000);
  const env = makeEnv(kv, turso);
  seedRow(turso, "reply_msg:1", "expired-value", 999_999_999_000); // expired relative to injected now()
  kv.failGet = true;

  // Pre-fix kvGet returned the expired row's bytes whenever KV errored,
  // bypassing the expiry check entirely.
  await assert.rejects(() => kvGet(env, "reply_msg:1"), /kv get boom/, "the KV error must surface -- never an expired value");
  assert.equal(turso.rows.has("reply_msg:1"), false, "the expired row must be dropped, not left for a later path to serve");
});

test("regression 5: delete -- KV failure keeps the pointer and surfaces the error (no false claim); shadow-delete failure writes a tombstone so nothing resurrects", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);

  // (a) KV delete fails: the pointer genuinely survives, the fallback copy is
  // cleared, and the caller sees the error -- no unsafe resume claim either way.
  seedRow(turso, "active:1:dm", "work-1");
  kv.store.set("active:1:dm", "work-1");
  kv.failDelete = true;
  await assert.rejects(() => kvDelete(env, "active:1:dm"), /kv delete boom/);
  assert.equal(kv.store.get("active:1:dm"), "work-1", "the pointer is unchanged -- the delete did not happen");
  assert.equal(turso.rows.has("active:1:dm"), false);
  assert.equal(await kvGet(env, "active:1:dm"), "work-1", "the still-present pointer is readable; the error was explicit");
  kv.failDelete = false;

  // (b) KV delete succeeds but the shadow delete is refused: a tombstone
  // overwrites the stale value so no read can resurrect it.
  seedRow(turso, "cowork_pending:1:604", "1");
  kv.store.set("cowork_pending:1:604", "1");
  turso.failDeletes = true;
  await kvDelete(env, "cowork_pending:1:604"); // no throw: the KV delete succeeded, which is what the caller asked for
  turso.failDeletes = false;
  assert.equal(kv.store.has("cowork_pending:1:604"), false, "the KV delete happened");
  assert.ok(isTombstone(turso.rows.get("cowork_pending:1:604")?.value), "the stale row was overwritten with a tombstone");
  assert.equal(await kvGet(env, "cowork_pending:1:604"), null, "the deleted pointer must never come back");
  assert.equal(turso.rows.has("cowork_pending:1:604"), false, "the tombstone is dropped on read");

  // (b2) The sweep drops tombstones too, without counting them as restored.
  seedRow(turso, "reply_msg:7", JSON.stringify({ __enig_kv: 1, seq: 1_000, tombstone: 1 }));
  const result = await sweepKvFallback(env);
  assert.equal(result.superseded, 1);
  assert.equal(result.swept, 0);
  assert.equal(turso.rows.size, 0);
});

test("regression 6: KV exhaustion, Turso outage, both-fail, then retry -- each combination has one truthful outcome", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);

  // KV exhausted (writes refuse), Turso healthy: absorbed, value durable in the fallback.
  kv.failPut = true;
  await kvPut(env, "active:1:dm", "work-1");
  assert.equal(await kvGet(env, "active:1:dm"), "work-1", "reads keep working through the window");

  // Both stores refuse: the original KV error is rethrown -- nothing claims persistence.
  turso.failAll = true;
  await assert.rejects(() => kvPut(env, "active:1:dm", "work-2"), /kv put boom/);
  turso.failAll = false;

  // Retry after partial persistence: the next successful write lands in KV,
  // the row it superseded is cleared, and both stores converge on the retry.
  kv.failPut = false;
  await kvPut(env, "active:1:dm", "work-3");
  assert.equal(await kvGet(env, "active:1:dm"), "work-3");
  assert.equal(turso.rows.size, 0, "converged: single-store truth after recovery");

  // And a total outage (KV reads + writes both down, Turso down) still fails
  // closed with the KV error rather than serving nothing-as-something.
  kv.failGet = true;
  kv.failPut = true;
  turso.failAll = true;
  await assert.rejects(() => kvGet(env, "active:1:dm"), /kv get boom/);
});

test("value boundary: document content and account email under google_option:/watch/folder keys never reach Turso (explicit failure instead)", async () => {
  reset();
  const kv = makeKv();
  const turso = makeTurso();
  __setTursoFetchForTests(turso.fetch);
  const env = makeEnv(kv, turso);
  kv.failPut = true; // quota window -- the case where a fallback would have been used

  const docContent = JSON.stringify({ kind: "doc", accountIdentifier: "me@acme.example", content: "ACME Corp renewal proposal body" });
  await assert.rejects(() => kvPut(env, "google_option:w-1:abc", docContent), /kv put boom/, "the failure is explicit");
  await assert.rejects(() => kvPut(env, "google_doc_watch:doc-1", JSON.stringify({ accountIdentifier: "me@acme.example", title: "ACME Board Deck" })), /kv put boom/);
  await assert.rejects(() => kvPut(env, "google_sheet_watch:sheet-1", JSON.stringify({ accountIdentifier: "me@acme.example", title: "ACME Q3 forecast" })), /kv put boom/);
  await assert.rejects(() => kvPut(env, "google_drive_default_folder:me@acme.example", "folder-123"), /kv put boom/);
  await assert.rejects(() => kvPut(env, "google_proposal_docs_folder:me@acme.example", "folder-456"), /kv put boom/);

  assert.equal(turso.calls.length, 0, "no Turso request was ever made for these keys");
  assert.equal(turso.rows.size, 0);
  for (const call of turso.calls) {
    const body = JSON.stringify(call.requests);
    assert.equal(body.includes("ACME Corp renewal proposal body"), false, "document content must never appear in Turso-bound bytes");
    assert.equal(body.includes("me@acme.example"), false, "account email must never appear in Turso-bound bytes");
  }
});
