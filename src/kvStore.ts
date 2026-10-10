import type { Env } from "./types";

/**
 * KV-primary / Turso-secondary coordination-state store (Section 5B).
 *
 * WHY THIS EXISTS: Cloudflare Workers Free caps KV at 1,000 writes/day, and
 * that quota was observed exhausted in production (2026-10-09): every write
 * failed until the UTC day rolled over, hard-blocking routing pointers,
 * dedup markers and session-index updates even though the Durable Object
 * (canonical Work state) was healthy. Section 5A made the polling paths
 * truthful under that failure; this module makes them *resilient*: a KV
 * write that fails for a fallback-eligible key is persisted to the Turso
 * database `enig-fallback` instead, and a KV read that misses consults the
 * same fallback, so the runtime keeps operating through a quota window
 * and reconciles back once KV recovers.
 *
 * ARCHITECTURAL POSITION (unchanged): KV stays the primary store and the
 * one true key namespace. Turso is a secondary *shadow copy* for
 * availability only -- no code path reads Turso without first consulting
 * KV, no business record lives only in Turso, and the Durable Objects
 * remain the canonical state for Work. If Turso is unconfigured (no
 * TURSO_DATABASE_URL binding) every function here is a byte-for-byte
 * passthrough to env.STATE_KV, so tests and any environment without the
 * binding behave exactly as before.
 *
 * DATA-CLASS POLICY (Architect-approved decision 2026-10-10, audited at
 * the VALUE level 2026-10-10): only "coordination + state" keys may fall
 * back to Turso, and eligibility is asserted against the value actually
 * stored, not the key's name. Conversation content and raw message text
 * stay Cloudflare-only; OAuth tokens, CSRF state and client secrets NEVER
 * leave Cloudflare under any circumstance. The classification is an
 * ALLOWLIST (isFallbackEligible): an unknown key defaults to
 * Cloudflare-only, so a new key written by future code cannot silently
 * leave the boundary -- it keeps today's fail-closed behaviour (the KV
 * error surfaces) until it is classified explicitly.
 *
 * Value-level rulings from the allowlist audit (each carries a line in
 * FALLBACK_ELIGIBLE_PREFIXES or NEVER_FALLBACK_EXACT_PREFIXES):
 * - `sessions_index` stays eligible because its stored labels are now a
 *   SAFE REPRESENTATION: token references (`ENT-<n>`/`MAT-<n>`) or fixed
 *   generic metadata only (sessionsIndex.ts deriveSessionLabel /
 *   sanitizeSessionsIndex rewrite every entry on every save). Human
 *   names, enquiry text and free-text approval labels are never stored.
 * - `google_option:` is Cloudflare-only: optionData is arbitrary and
 *   carries Google Doc bodies, Sheet rows and the account email
 *   (googleOAuth.ts saveOpaqueOption call sites).
 * - `google_doc_watch:` / `google_sheet_watch:` are Cloudflare-only: the
 *   records carry the account email and file titles, and the poll cannot
 *   function without them, so no minimal Turso representation exists.
 * - Drive folder caches (`google_drive_default_folder:`,
 *   `google_proposal_docs_folder:`) are Cloudflare-only: the KEY embeds
 *   the account email, and a failed cache write is surfaced truthfully by
 *   the writer instead of being absorbed by a fallback.
 * - `governance:` (cached Notion page content), `lookup_history:` (may
 *   carry real client identity) and every `google_oauth_*` key were
 *   already excluded.
 *
 * CONFLICT-RESOLUTION CONTRACT (KV vs Turso): neither store is trusted as
 * newer merely by name. Every eligible value written by kvPut is wrapped
 * in a versioned envelope {"__enig_kv":1,"seq":<epoch ms>,"val":<raw>};
 * an unwrapped (legacy) value decodes to seq 0, and a legacy Turso row's
 * seq is its updated_at column (actual write-time evidence). Reads compare
 * versions: the higher seq wins, a TIE goes to KV (the store that accepted
 * the write), and Turso is consulted on every eligible read so a fallback
 * row written for a failed KV write can never be shadowed by the older KV
 * value -- including after an isolate restart (versions live in the stored
 * bytes, not in isolate memory). Deleting a key clears both stores; when
 * the KV delete succeeds but the shadow delete fails, the row is
 * OVERWRITTEN with a tombstone so no read or sweep can resurrect it.
 * Sweep and read-repair apply the same version comparison and skip (and
 * clear) rows whose KV value is the same or newer. Residuals: KV has no
 * compare-and-swap, so a sweep racing a concurrent write inside the same
 * millisecond can lose the loser (bounded, pre-existing); and a shadow
 * delete that fails with Turso entirely down survives as a resurrection
 * window until the tombstone write retries or the key's next write.
 *
 * FAILURE SEMANTICS:
 * - KV put fails, key eligible, Turso write succeeds -> no error; the
 *   value is durable in the fallback.
 * - KV put fails AND the Turso write fails -> the original KV error is
 *   rethrown (identical to pre-§5B behaviour; §5A's typed catches such as
 *   CommentMarkerPersistenceError keep working unchanged).
 * - Ineligible key -> the KV error always surfaces; nothing is sent.
 * - KV delete fails -> the Turso shadow copy is cleared too (a swept row
 *   must never resurrect a cleared pointer) and the KV error is rethrown.
 *
 * RECONCILIATION: a successful KV put (or delete) of an eligible key also
 * removes its Turso shadow row, so in steady state the fallback holds
 * nothing -- and because reads/sweeps are version-aware, losing that
 * best-effort delete can no longer corrupt state: the stale row is either
 * superseded by the newer KV value or (post-delete) overwritten by a
 * tombstone. Rows that accumulated during an outage are swept back into KV
 * by sweepKvFallback (throttled, called from the doc-comment poll -- the
 * runtime's de-facto heartbeat -- and from scheduled()), and a KV read
 * whose fallback row is newer repairs KV opportunistically on the spot.
 * The previously documented v1 staleness window (an isolate restart
 * letting a stale shadow row be copied over an older KV value) is closed
 * by the versioned envelope -- the version travels in the stored bytes.
 */

const TURSO_TABLE = "kv_fallback";

/** Consecutive KV put failures before the circuit opens and writes go straight to Turso. */
const KV_CIRCUIT_FAILURE_THRESHOLD = 2;
/** How long the circuit stays open (KV writes skipped) before the next attempt doubles as a probe. */
const KV_CIRCUIT_COOLDOWN_MS = 60_000;
/** Minimum sweep interval for maybeSweepKvFallback. */
const SWEEP_THROTTLE_MS = 15 * 60_000;
/** Default/max rows moved per sweep pass. */
const SWEEP_DEFAULT_LIMIT = 100;

/**
 * The ONLY allowlist behind which a KV key may be persisted to Turso.
 * Prefix matches, plus exact names. Keep in sync with the data-class
 * policy note at the top of this file and with kvStore.test.ts's
 * classification suite.
 */
const FALLBACK_ELIGIBLE_PREFIXES: readonly string[] = [
  // sessionRouting.ts / matterContinuation.ts routing + interaction state
  // (values: workId / mode / "1" strings -- no content, no identity)
  "active:",
  "mode:",
  "cowork_pending:",
  "reply_msg:",
  "matter_current_work:",
  // session registry + its alert throttle (session.ts). Value-level safe:
  // SessionSummary labels are token references / fixed generic metadata
  // only -- sessionsIndex.ts sanitizeSessionsIndex rewrites EVERY entry on
  // every save, so names, enquiry text and free-text approval labels never
  // reach this value (see the policy note above).
  "sessions_index",
  "pending_approval_backlog_last_alert",
  // comment-processing coordination (googleDocComments.ts / googleSheetComments.ts)
  // (values: the literal "1" plus a 90-day TTL -- nothing else)
  "google_comment_processed:",
  "google_comment_clarification_pending:",
  // handoff discovery coordination (checkHandoffs.ts + Unit pickup sites)
  // (values: workId, epoch-ms timestamps, pageId:Status fingerprint --
  // ids and statuses only, never Handoff text)
  "handoff_workitem:",
  "sales_handoff_notified:",
  "stale_handoff_digest_last_sent",
  "stale_handoff_digest_last_fingerprint",
  "checkhandoffs_auto_inflight",
  // operational diagnostics timestamps (index.ts, comment pollers)
  // (values: ISO-8601 / epoch-ms strings)
  "last_cron_run",
  "last_google_doc_comment_poll_run",
  "last_google_sheet_comment_poll_run",
  "watchdog_alert_last_sent",
];

/** Exact-key allowlist, kept separate for readability. */
const FALLBACK_ELIGIBLE_EXACT: readonly string[] = ["sessions_index"];

/**
 * Named exclusions -- documentation of the never-fallback classes. The
 * allowlist above already excludes them; these exist so a reader (and the
 * classification test) can state the boundary positively. Each entry's
 * reason is the VALUE it stores, audited at the value level.
 */
const NEVER_FALLBACK_EXACT_PREFIXES: readonly string[] = [
  "chat_history:", // conversation content (chat.ts)
  "lookup_history:", // lookup results that may carry real client identity (dataLookup.ts)
  "governance:", // cached Notion page content (governance.ts) -- refetchable, so never needed as a fallback
  "google_oauth_state:", // OAuth CSRF state (googleOAuth.ts)
  "google_oauth_tokens:", // OAuth tokens (googleOAuth.ts)
  // Approval-option staging (googleOAuth.ts saveOpaqueOption): optionData is
  // arbitrary -- Google Doc bodies, Sheet rows, titles and the account email
  // (call sites :1430/:1516/:1628). No minimal safe contract exists at every
  // writer, so the class is Cloudflare-only and a failed save stays explicit.
  "google_option:",
  // Watch registries (googleOAuth.ts): records carry the account email and
  // the file title, and the comment poll cannot run without them -- there is
  // no reduced schema that would still function, so they stay Cloudflare-only.
  "google_doc_watch:",
  "google_sheet_watch:",
  // Drive folder-id caches: the KEY embeds the account email
  // (`<kv_key>:<account>`), so both the key and the class stay
  // Cloudflare-only; writers surface a failed cache write truthfully instead
  // of absorbing it (never silently re-added to the allowlist -- see policy).
  "google_drive_default_folder:",
  "google_proposal_docs_folder:",
];

export function isFallbackEligible(key: string): boolean {
  if (FALLBACK_ELIGIBLE_EXACT.includes(key)) return true;
  if (NEVER_FALLBACK_EXACT_PREFIXES.some((p) => key.startsWith(p))) return false;
  return FALLBACK_ELIGIBLE_PREFIXES.some((p) => key.startsWith(p));
}

// ---------------------------------------------------------------------------
// Turso HTTP client (Turso's documented /v2/pipeline REST API over fetch).
//
// Deliberately NOT @libsql/client: the runtime's needs are four statements
// and this repo has zero production dependencies, so a small explicit HTTP
// client avoids adding a bundling/runtime dependency to a Workers Free
// bundle for what is a trivial request/response protocol. All statements
// are parameterized; no value is ever interpolated into SQL.
// ---------------------------------------------------------------------------

interface TursoConfig {
  url: string;
  token: string;
}

interface TursoRow {
  key: string;
  value: string;
  expiresAt: number | null;
  updatedAt: number | null;
}

type TursoArg = { type: "text"; value: string } | { type: "integer"; value: string } | null;

function tursoConfig(env: Env): TursoConfig | null {
  const url = env.TURSO_DATABASE_URL?.trim();
  const token = env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !token) return null;
  // libsql:// is the Turso CLI scheme; the HTTP API is plain https://.
  return { url: url.replace(/^libsql:\/\//, "https://").replace(/\/+$/, ""), token };
}

/** Injectable for tests; unset means the real global fetch. */
let tursoFetchOverride: typeof fetch | undefined;
export function __setTursoFetchForTests(fn: typeof fetch | undefined): void {
  tursoFetchOverride = fn;
}
/** Injectable for the circuit breaker's clock. */
let nowOverride: (() => number) | undefined;
export function __setNowForTests(fn: (() => number) | undefined): void {
  nowOverride = fn;
}
function now(): number {
  return nowOverride ? nowOverride() : Date.now();
}

/** Module-level state that must survive across calls inside one isolate. */
interface KvStoreRuntimeState {
  schemaReady: boolean;
  circuitFailures: number;
  circuitOpenUntil: number;
  lastSweepAt: number;
}
function runtimeState(): KvStoreRuntimeState {
  const g = globalThis as Record<string, unknown>;
  const existing = g.__enigKvStoreState as KvStoreRuntimeState | undefined;
  if (existing) return existing;
  const created: KvStoreRuntimeState = { schemaReady: false, circuitFailures: 0, circuitOpenUntil: 0, lastSweepAt: 0 };
  g.__enigKvStoreState = created;
  return created;
}
export function __resetKvStoreStateForTests(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.__enigKvStoreState;
}

function textArg(value: string): TursoArg {
  return { type: "text", value };
}
function intArg(value: number): TursoArg {
  return { type: "integer", value: String(Math.trunc(value)) };
}

async function tursoRequest(cfg: TursoConfig, requests: unknown[]): Promise<Array<Record<string, any>>> {
  const doFetch = tursoFetchOverride ?? fetch;
  const res = await doFetch(`${cfg.url}/v2/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
    },
    // /v2/pipeline supports exactly two request types -- `execute` and `close`
    // (SELECTs are executed, not "queried"; the legacy libsql `query` request
    // type is rejected with HTTP 400). Connections are left open until they
    // time out unless closed, so every pipeline ends with `close`.
    body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
  });
  if (!res.ok) {
    // Include the response body: without it a 400 is undiagnosable from logs
    // (exactly what happened on the first live §5B traffic).
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Turso HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`);
  }
  const body = (await res.json()) as { results?: Array<Record<string, any>> };
  const results = body.results ?? [];
  for (const result of results) {
    if (result.type === "error") {
      const message = (result.error as { message?: string } | undefined)?.message ?? "unknown Turso error";
      throw new Error(`Turso statement failed: ${message}`);
    }
  }
  return results;
}

/**
 * The row set of the pipeline's first `execute` result. Turso returns rows
 * as arrays of typed cells (`{type, value}` or null for NULL), one array
 * per row, with the column list in `result.cols`.
 */
type TursoCell = { type: string; value: string | number } | null;
function execRows(results: Array<Record<string, any>>): TursoCell[][] {
  const executed = results.find((r) => r.type === "ok" && r.response?.type === "execute");
  return ((executed?.response?.result?.rows ?? []) as TursoCell[][]) ?? [];
}

async function ensureSchema(cfg: TursoConfig): Promise<void> {
  if (runtimeState().schemaReady) return;
  await tursoRequest(cfg, [
    {
      type: "execute",
      stmt: {
        sql: `CREATE TABLE IF NOT EXISTS ${TURSO_TABLE} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "expires_at" INTEGER, "updated_at" INTEGER NOT NULL)`,
        args: [],
      },
    },
  ]);
  runtimeState().schemaReady = true;
}

function decodeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return String((value as { value: unknown }).value);
  }
  return String(value);
}

function decodeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as { value: unknown }).value;
    const parsed = Number(inner);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Versioned value envelope -- the conflict-resolution contract (see the
// header). Every eligible value written by kvPut is wrapped so that KV and
// Turso versions can be compared deterministically regardless of which
// store is called primary or whether an isolate restarted in between:
//   {"__enig_kv":1,"seq":<epoch ms>,"val":<caller's raw value string>}
// A tombstone (delete marker) has no val and flag "tombstone":1.
// A value that does not decode as an envelope is LEGACY: KV legacy = seq 0
// (no timestamp evidence), Turso legacy = the row's updated_at column.
// ---------------------------------------------------------------------------

const ENVELOPE_SENTINEL = "__enig_kv";
const ENVELOPE_VERSION = 1;

interface DecodedValue {
  seq: number;
  value: string;
  tombstone: boolean;
}

function wrapValue(value: string, seq: number): string {
  return JSON.stringify({ [ENVELOPE_SENTINEL]: ENVELOPE_VERSION, seq, val: value });
}

function wrapTombstone(seq: number): string {
  return JSON.stringify({ [ENVELOPE_SENTINEL]: ENVELOPE_VERSION, seq, tombstone: 1 });
}

function decodeEnvelope(raw: string): DecodedValue | null {
  // Fast path: envelopes are objects, so they start with '{'. Legacy plain
  // values (workIds, "1", ISO timestamps, JSON arrays like sessions_index)
  // and arbitrary non-JSON bytes fall through to seq 0.
  if (!raw || raw.charCodeAt(0) !== 123) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record[ENVELOPE_SENTINEL] !== ENVELOPE_VERSION || typeof record.seq !== "number") return null;
  if (record.tombstone === 1) return { seq: record.seq, value: "", tombstone: true };
  if (typeof record.val === "string") return { seq: record.seq, value: record.val, tombstone: false };
  return null;
}

/** Decode any stored bytes (KV value or Turso row value) into version + raw value. */
function decodeStored(raw: string): DecodedValue {
  return decodeEnvelope(raw) ?? { seq: 0, value: raw, tombstone: false };
}

/**
 * A Turso row's effective version: the envelope's seq when present,
 * otherwise the row's updated_at column (actual write-time evidence from
 * the store that held the row) -- never "assume Turso is newer".
 */
function decodeRow(row: TursoRow): DecodedValue {
  const envelope = decodeEnvelope(row.value);
  if (envelope) return envelope;
  return { seq: row.updatedAt ?? 0, value: row.value, tombstone: false };
}

async function tursoUpsert(cfg: TursoConfig, key: string, value: string, expiresAt: number | null): Promise<void> {
  await ensureSchema(cfg);
  await tursoRequest(cfg, [
    {
      type: "execute",
      stmt: {
        sql: `INSERT INTO ${TURSO_TABLE} ("key", "value", "expires_at", "updated_at") VALUES (?, ?, ?, ?)
              ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "expires_at" = excluded."expires_at", "updated_at" = excluded."updated_at"`,
        args: [textArg(key), textArg(value), expiresAt === null ? null : intArg(expiresAt), intArg(now())],
      },
    },
  ]);
}

async function tursoGet(cfg: TursoConfig, key: string): Promise<TursoRow | null> {
  await ensureSchema(cfg);
  const results = await tursoRequest(cfg, [
    {
      type: "execute",
      stmt: { sql: `SELECT "value", "expires_at", "updated_at" FROM ${TURSO_TABLE} WHERE "key" = ?`, args: [textArg(key)] },
    },
  ]);
  const rows = execRows(results);
  if (rows.length === 0) return null;
  return { key, value: decodeText(rows[0][0]), expiresAt: decodeInteger(rows[0][1]), updatedAt: decodeInteger(rows[0][2]) };
}

async function tursoDelete(cfg: TursoConfig, key: string): Promise<void> {
  await ensureSchema(cfg);
  await tursoRequest(cfg, [
    {
      type: "execute",
      stmt: { sql: `DELETE FROM ${TURSO_TABLE} WHERE "key" = ?`, args: [textArg(key)] },
    },
  ]);
}

async function tursoListKeys(cfg: TursoConfig, prefix: string, limit = 1000): Promise<string[]> {
  await ensureSchema(cfg);
  const results = await tursoRequest(cfg, [
    {
      type: "execute",
      stmt: {
        sql: `SELECT "key" FROM ${TURSO_TABLE} WHERE substr("key", 1, length(?)) = ? LIMIT ${limit}`,
        args: [textArg(prefix), textArg(prefix)],
      },
    },
  ]);
  return execRows(results).map((row) => decodeText(row[0]));
}

async function tursoSelectForSweep(cfg: TursoConfig, limit: number): Promise<TursoRow[]> {
  await ensureSchema(cfg);
  const results = await tursoRequest(cfg, [
    {
      type: "execute",
      stmt: {
        sql: `SELECT "key", "value", "expires_at", "updated_at" FROM ${TURSO_TABLE} ORDER BY "updated_at" LIMIT ${limit}`,
        args: [],
      },
    },
  ]);
  return execRows(results).map((row) => ({
    key: decodeText(row[0]),
    value: decodeText(row[1]),
    expiresAt: decodeInteger(row[2]),
    updatedAt: decodeInteger(row[3]),
  }));
}

async function tursoCount(cfg: TursoConfig): Promise<number | null> {
  try {
    await ensureSchema(cfg);
    const results = await tursoRequest(cfg, [
      { type: "execute", stmt: { sql: `SELECT COUNT(*) FROM ${TURSO_TABLE}`, args: [] } },
    ]);
    const rows = execRows(results);
    return rows.length ? decodeInteger(rows[0][0]) : 0;
  } catch (err) {
    console.error("kvStore: Turso row count failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker -- after KV_CIRCUIT_FAILURE_THRESHOLD consecutive KV put
// failures, eligible writes skip KV and go straight to Turso for
// KV_CIRCUIT_COOLDOWN_MS (free-tier quota windows last hours; this just
// avoids burning a doomed KV attempt on every single write). The first
// attempt after the cooldown is the probe: success closes the circuit,
// another failure re-opens it. Reads never go through the circuit -- KV
// reads are not quota-limited.
// ---------------------------------------------------------------------------

function circuitIsOpen(): boolean {
  return now() < runtimeState().circuitOpenUntil;
}
function circuitNoteFailure(): void {
  const state = runtimeState();
  state.circuitFailures += 1;
  if (state.circuitFailures >= KV_CIRCUIT_FAILURE_THRESHOLD) {
    state.circuitOpenUntil = now() + KV_CIRCUIT_COOLDOWN_MS;
  }
}
function circuitNoteSuccess(): void {
  const state = runtimeState();
  state.circuitFailures = 0;
  state.circuitOpenUntil = 0;
}

function remainingTtlSeconds(expiresAt: number | null): number | null {
  if (expiresAt === null) return null;
  return Math.floor((expiresAt - now()) / 1000);
}

// ---------------------------------------------------------------------------
// Public seam -- drop-in replacements for the four KVNamespace operations.
// Every signature mirrors the KV call it replaces; call sites change their
// callee only, never their semantics.
// ---------------------------------------------------------------------------

export async function kvGet(env: Env, key: string): Promise<string | null> {
  const cfg = tursoConfig(env);
  if (!cfg || !isFallbackEligible(key)) return env.STATE_KV.get(key);

  // Both stores are consulted on EVERY eligible read (conflict-resolution
  // contract in the header): a fallback row can be newer than a KV value
  // that is still present -- the KV write of the newer value failed -- and
  // isolate memory cannot decide that after a restart, so the decision uses
  // the version envelopes stored with the bytes. In steady state Turso
  // holds no rows, making the Turso side an empty-table probe.
  let kvValue: string | null = null;
  let kvError: unknown = null;
  let row: TursoRow | null = null;
  const [kvResult, rowResult] = await Promise.allSettled([env.STATE_KV.get(key), tursoGet(cfg, key)]);
  if (kvResult.status === "fulfilled") {
    kvValue = kvResult.value;
  } else {
    kvError = kvResult.reason;
  }
  if (rowResult.status === "fulfilled") {
    row = rowResult.value;
  } else {
    console.error(`kvStore: Turso read failed for ${key}`, rowResult.reason);
  }

  const kvEntry = kvValue === null || kvValue === undefined ? null : decodeStored(kvValue);

  // Resolve the Turso side once. Tombstones (delete markers) and expired
  // rows are never live state and are dropped here, so no later path --
  // including a KV read error -- can serve them.
  let liveRow: { row: TursoRow; entry: DecodedValue; ttl: number | null } | null = null;
  if (row) {
    const entry = decodeRow(row);
    const ttl = remainingTtlSeconds(row.expiresAt);
    if (entry.tombstone) {
      await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: failed to drop tombstone row ${key}`, err));
    } else if (ttl !== null && ttl <= 0) {
      await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: failed to drop expired fallback row ${key}`, err));
    } else {
      liveRow = { row, entry, ttl };
    }
  }

  if (kvError) {
    // A LIVE fallback row is the best durable truth we have while KV itself
    // is erroring; with no live row the KV error surfaces unchanged
    // (pre-§5B contract -- an expired row counts as "no live row" and is
    // never returned as live state).
    if (liveRow) return serveRow(env, cfg, key, liveRow);
    throw kvError;
  }

  if (kvEntry && liveRow) {
    if (liveRow.entry.seq > kvEntry.seq) {
      // The row is the newer write (its KV attempt failed) -- it wins. This
      // is exactly the case a KV-only read would have silently gotten wrong
      // by returning the older KV value as if the write had succeeded.
      return serveRow(env, cfg, key, liveRow);
    }
    // KV holds this version or a newer one -- the row is obsolete; clear it
    // so no later sweep can resurrect it.
    await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: stale row delete failed for ${key}`, err));
    return kvEntry.value;
  }
  if (kvEntry) return kvEntry.value;
  if (liveRow) return serveRow(env, cfg, key, liveRow);
  return null;
}

/**
 * Serve a live fallback row: restore it into KV preserving its version
 * envelope and remaining TTL (so every later comparison keeps the same
 * ordering), clear the shadow on success, and hand the value back either
 * way -- when the repair write fails the row remains the only durable copy.
 */
async function serveRow(
  env: Env,
  cfg: TursoConfig,
  key: string,
  live: { row: TursoRow; entry: DecodedValue; ttl: number | null },
): Promise<string> {
  const bytes = decodeEnvelope(live.row.value) ? live.row.value : wrapValue(live.entry.value, live.entry.seq);
  try {
    await env.STATE_KV.put(key, bytes, live.ttl !== null ? { expirationTtl: Math.max(live.ttl, 60) } : undefined);
  } catch (err) {
    console.error(`kvStore: KV repair write failed for ${key}`, err);
    return live.entry.value;
  }
  await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: repaired shadow delete failed for ${key}`, err));
  return live.entry.value;
}

export async function kvPut(env: Env, key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
  const cfg = tursoConfig(env);
  if (!cfg || !isFallbackEligible(key)) return env.STATE_KV.put(key, value, opts);

  // Versioned envelope: the seq stamps this write so reads/sweeps can tell
  // which store holds the newer value without assuming either is newer.
  const seq = now();
  const bytes = wrapValue(value, seq);

  let kvError: unknown = null;
  if (!circuitIsOpen()) {
    try {
      await env.STATE_KV.put(key, bytes, opts);
      circuitNoteSuccess();
      // Clear any stale shadow so it cannot linger as a conflict candidate.
      // Best-effort by design: correctness no longer depends on this delete
      // succeeding -- reads and the sweep compare versions, so a surviving
      // (older) row is superseded instead of resurrected.
      await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: shadow delete failed for ${key}`, err));
      return;
    } catch (err) {
      kvError = err;
      circuitNoteFailure();
      console.error(`kvStore: KV put failed for ${key} -- falling back to Turso`, err);
    }
  }
  const expiresAt = opts?.expirationTtl ? now() + opts.expirationTtl * 1000 : null;
  try {
    await tursoUpsert(cfg, key, bytes, expiresAt);
  } catch (tursoErr) {
    console.error(`kvStore: Turso fallback write failed for ${key} -- both stores refused this write`, tursoErr);
    // Fail-closed continuity: the caller sees the same KV error it always saw when
    // this write could not persist (the Turso failure is logged context, not a new contract).
    if (kvError) throw kvError;
    throw tursoErr; // circuit was open (no fresh KV attempt): the Turso failure is the only evidence to surface
  }
}

export async function kvDelete(env: Env, key: string): Promise<void> {
  const cfg = tursoConfig(env);
  if (!cfg || !isFallbackEligible(key)) return env.STATE_KV.delete(key);
  try {
    await env.STATE_KV.delete(key);
  } catch (err) {
    // Clear the fallback copy too -- a swept row must never resurrect a pointer this call just cleared --
    // then surface the KV failure exactly as the pre-§5B code did. The KV
    // key itself survives (the delete did not happen), so the caller both
    // sees the error and keeps a consistent view of the still-present value.
    await tursoDelete(cfg, key).catch((tursoErr) => console.error(`kvStore: fallback delete failed for ${key}`, tursoErr));
    throw err;
  }
  try {
    await tursoDelete(cfg, key);
  } catch (err) {
    // The KV delete succeeded: this key is deleted. The shadow row (if any)
    // is now stale and must never be served or swept back. Plain delete
    // failed, so OVERWRITE the row with a tombstone -- that destroys the
    // stale value at its source; readers and the sweep drop tombstones on
    // sight. If even the tombstone write fails (Turso down), it is logged
    // loudly: the stale row would otherwise survive as a resurrection
    // window until Turso's next successful contact with this key.
    console.error(`kvStore: shadow delete failed for ${key} -- overwriting with a tombstone`, err);
    try {
      await tursoUpsert(cfg, key, wrapTombstone(now()), null);
    } catch (tombstoneErr) {
      console.error(
        `kvStore: tombstone write failed for ${key} -- a stale shadow row may survive Turso recovery until this key's next write`,
        tombstoneErr,
      );
    }
  }
}

export interface KvListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

/**
 * Merged listing. KV pages are returned as-is; fallback rows matching the
 * eligible prefix are appended to the first page (they carry no cursor --
 * v1 simplification: the fallback is drained by the sweeper, so merged rows
 * are transient). Ineligible prefixes and unconfigured environments are
 * exact passthroughs.
 */
export async function kvList(env: Env, opts: { prefix: string; cursor?: string }): Promise<KvListResult> {
  const cfg = tursoConfig(env);
  const page = (await env.STATE_KV.list(opts)) as unknown as KvListResult;
  if (!cfg || !isFallbackEligible(opts.prefix)) return page;
  try {
    const extraKeys = await tursoListKeys(cfg, opts.prefix);
    const seen = new Set(page.keys.map((k) => k.name));
    const added = extraKeys.filter((name) => !seen.has(name)).map((name) => ({ name }));
    if (added.length) return { ...page, keys: [...page.keys, ...added] };
  } catch (err) {
    console.error(`kvStore: Turso list merge failed for prefix ${opts.prefix}`, err);
  }
  return page;
}

// ---------------------------------------------------------------------------
// Reconciliation sweep -- drains fallback rows back into KV once it has
// quota again. Expired rows are dropped rather than restored (KV would not
// have returned them). A KV write failure stops the pass and leaves the
// remaining rows for the next sweep (the circuit will also have opened).
// ---------------------------------------------------------------------------

export interface SweepResult {
  swept: number;
  expired: number;
  /** Rows dropped without restoring: tombstones and rows already superseded by an equal-or-newer KV value. */
  superseded: number;
  remaining: boolean;
}

export async function sweepKvFallback(env: Env, limit = SWEEP_DEFAULT_LIMIT): Promise<SweepResult> {
  const result: SweepResult = { swept: 0, expired: 0, superseded: 0, remaining: false };
  const cfg = tursoConfig(env);
  if (!cfg) return result;
  let rows: TursoRow[];
  try {
    rows = await tursoSelectForSweep(cfg, limit + 1);
  } catch (err) {
    console.error("kvStore: sweep row listing failed", err);
    return result;
  }
  result.remaining = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    const entry = decodeRow(row);
    if (entry.tombstone) {
      // A delete marker: its whole purpose was to destroy a stale value.
      // Drop it so the table returns to its empty steady state.
      await tursoDelete(cfg, row.key).catch((err) => console.error(`kvStore: sweep tombstone drop failed for ${row.key}`, err));
      result.superseded += 1;
      continue;
    }
    const ttl = remainingTtlSeconds(row.expiresAt);
    if (ttl !== null && ttl <= 60) {
      // Expired (or expiring inside KV's 60-second TTL floor): the value's life is over.
      await tursoDelete(cfg, row.key).catch((err) => console.error(`kvStore: sweep drop failed for ${row.key}`, err));
      result.expired += 1;
      continue;
    }
    // Version-aware conflict check: read what KV actually holds for this key
    // and only restore when the row is newer. Never assume either store is
    // newer by name -- this is the check that stops a stale row (e.g. one
    // whose shadow delete failed) from overwriting a fresher KV value.
    let kvRaw: string | null = null;
    let kvError: unknown = null;
    try {
      kvRaw = await env.STATE_KV.get(row.key);
    } catch (err) {
      kvError = err;
    }
    if (kvError) {
      console.error(`kvStore: sweep cannot version-check ${row.key}; row held for a later pass`, kvError);
      break;
    }
    const kvEntry = kvRaw === null || kvRaw === undefined ? null : decodeStored(kvRaw);
    if (kvEntry && kvEntry.seq >= entry.seq) {
      await tursoDelete(cfg, row.key).catch((err) => console.error(`kvStore: sweep superseded-row delete failed for ${row.key}`, err));
      result.superseded += 1;
      continue;
    }
    try {
      // Preserve the row's version when restoring, so a row whose shadow
      // delete later fails can never win against a subsequent KV write.
      const bytes = decodeEnvelope(row.value) ? row.value : wrapValue(entry.value, entry.seq);
      await env.STATE_KV.put(row.key, bytes, ttl !== null ? { expirationTtl: Math.max(ttl, 60) } : undefined);
    } catch (err) {
      console.error(`kvStore: sweep KV write failed at ${row.key}; remaining rows held for a later pass`, err);
      break;
    }
    // If this delete fails, both stores now hold the SAME version+value --
    // a tie the contract resolves to KV -- so nothing stale can be restored.
    await tursoDelete(cfg, row.key).catch((err) => console.error(`kvStore: sweep row delete failed for ${row.key}`, err));
    result.swept += 1;
  }
  runtimeState().lastSweepAt = now();
  return result;
}

/**
 * Throttled sweep trigger -- safe to call from any heartbeat (the
 * doc-comment poll, scheduled()). Does nothing when unconfigured or inside
 * the throttle window; the throttle is per-isolate and best-effort, which
 * is all a reconciliation nicety needs.
 */
export async function maybeSweepKvFallback(env: Env): Promise<SweepResult | null> {
  const cfg = tursoConfig(env);
  if (!cfg) return null;
  const state = runtimeState();
  if (now() - state.lastSweepAt < SWEEP_THROTTLE_MS) return null;
  state.lastSweepAt = now(); // set first: a slow sweep must not be re-entered by the next heartbeat
  return sweepKvFallback(env);
}

/** Diagnostics for /admin/turso-fallback. Never returns the auth token. */
export async function kvFallbackStatus(env: Env): Promise<Record<string, unknown>> {
  const cfg = tursoConfig(env);
  const state = runtimeState();
  return {
    configured: Boolean(cfg),
    circuit_open: circuitIsOpen(),
    consecutive_kv_failures: state.circuitFailures,
    circuit_open_until: state.circuitOpenUntil ? new Date(state.circuitOpenUntil).toISOString() : null,
    last_sweep_at: state.lastSweepAt ? new Date(state.lastSweepAt).toISOString() : null,
    fallback_rows: cfg ? await tursoCount(cfg) : null,
  };
}
