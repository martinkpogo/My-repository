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
 * DATA-CLASS POLICY (Architect-approved decision, 2026-10-10): only
 * "coordination + state" keys may fall back to Turso -- routing pointers,
 * dedup/clarification markers, digest/alert throttles, poll diagnostics,
 * the sessions index, the watch registries. Conversation content and raw
 * message text stay Cloudflare-only, and OAuth tokens, CSRF state and
 * client secrets NEVER leave Cloudflare under any circumstance. The
 * classification is an ALLOWLIST (isFallbackEligible): an unknown key
 * defaults to Cloudflare-only, so a new key written by future code cannot
 * silently leave the boundary -- it simply keeps today's fail-closed
 * behaviour (the KV error surfaces) until it is classified explicitly.
 * Deliberately excluded although they are not conversation content:
 * `governance:` (cached Notion page content -- a pure refetchable cache),
 * `lookup_history:` (lookup results that can carry real client identity,
 * so leaving it Cloudflare-only is the conservative data-boundary call),
 * and every `google_oauth_*` key.
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
 * nothing. Rows that accumulated during an outage are swept back into KV
 * by sweepKvFallback (throttled, called from the doc-comment poll -- the
 * runtime's de-facto heartbeat -- and from scheduled()), and a KV read
 * that misses while a fresh fallback row exists repairs KV opportunistically
 * on the spot. The one residual staleness window (isolate restarted between
 * a fallback write and its repair, leaving a stale shadow row that a sweep
 * copies over an older-but-present KV value) is bounded by the next write
 * to that key and was documented to the Architect as a v1 simplification.
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
  "active:",
  "mode:",
  "cowork_pending:",
  "reply_msg:",
  "matter_current_work:",
  // session registry + its alert throttle (session.ts)
  "sessions_index",
  "pending_approval_backlog_last_alert",
  // comment-processing coordination (googleDocComments.ts / googleSheetComments.ts)
  "google_comment_processed:",
  "google_comment_clarification_pending:",
  // handoff discovery coordination (checkHandoffs.ts + Unit pickup sites)
  "handoff_workitem:",
  "sales_handoff_notified:",
  "stale_handoff_digest_last_sent",
  "stale_handoff_digest_last_fingerprint",
  "checkhandoffs_auto_inflight",
  // operational diagnostics timestamps (index.ts, comment pollers)
  "last_cron_run",
  "last_google_doc_comment_poll_run",
  "last_google_sheet_comment_poll_run",
  "watchdog_alert_last_sent",
  // Google Workspace watch registries (googleOAuth.ts) -- ids/metadata, not document content
  "google_doc_watch:",
  "google_sheet_watch:",
  // approval-callback option staging (googleOAuth.ts saveOpaqueOption) -- 10-min TTL control state
  "google_option:",
  // Drive folder-id cache (runtime/tools/googleDriveFolderTool.ts)
  "google_drive_default_folder:",
];

/** Exact-key allowlist, kept separate for readability. */
const FALLBACK_ELIGIBLE_EXACT: readonly string[] = ["sessions_index"];

/**
 * Named exclusions -- documentation of the never-fallback classes. The
 * allowlist above already excludes them; these exist so a reader (and the
 * classification test) can state the boundary positively.
 */
const NEVER_FALLBACK_EXACT_PREFIXES: readonly string[] = [
  "chat_history:", // conversation content (chat.ts)
  "lookup_history:", // lookup results that may carry real client identity (dataLookup.ts)
  "governance:", // cached Notion page content (governance.ts) -- refetchable, so never needed as a fallback
  "google_oauth_state:", // OAuth CSRF state (googleOAuth.ts)
  "google_oauth_tokens:", // OAuth tokens (googleOAuth.ts)
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
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
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
      type: "query",
      stmt: { sql: `SELECT "value", "expires_at" FROM ${TURSO_TABLE} WHERE "key" = ?`, args: [textArg(key)] },
    },
  ]);
  const rows = results[0]?.response?.rows as Array<{ columns: unknown[] }> | undefined;
  if (!rows || rows.length === 0) return null;
  return { key, value: decodeText(rows[0].columns[0]), expiresAt: decodeInteger(rows[0].columns[1]) };
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
      type: "query",
      stmt: {
        sql: `SELECT "key" FROM ${TURSO_TABLE} WHERE substr("key", 1, length(?)) = ? LIMIT ${limit}`,
        args: [textArg(prefix), textArg(prefix)],
      },
    },
  ]);
  const rows = results[0]?.response?.rows as Array<{ columns: unknown[] }> | undefined;
  return (rows ?? []).map((row) => decodeText(row.columns[0]));
}

async function tursoSelectForSweep(cfg: TursoConfig, limit: number): Promise<TursoRow[]> {
  await ensureSchema(cfg);
  const results = await tursoRequest(cfg, [
    {
      type: "query",
      stmt: {
        sql: `SELECT "key", "value", "expires_at" FROM ${TURSO_TABLE} ORDER BY "updated_at" LIMIT ${limit}`,
        args: [],
      },
    },
  ]);
  const rows = results[0]?.response?.rows as Array<{ columns: unknown[] }> | undefined;
  return (rows ?? []).map((row) => ({
    key: decodeText(row.columns[0]),
    value: decodeText(row.columns[1]),
    expiresAt: decodeInteger(row.columns[2]),
  }));
}

async function tursoCount(cfg: TursoConfig): Promise<number | null> {
  try {
    await ensureSchema(cfg);
    const results = await tursoRequest(cfg, [
      { type: "query", stmt: { sql: `SELECT COUNT(*) FROM ${TURSO_TABLE}`, args: [] } },
    ]);
    const rows = results[0]?.response?.rows as Array<{ columns: unknown[] }> | undefined;
    return rows && rows.length ? decodeInteger(rows[0].columns[0]) : 0;
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

  let kvValue: string | null = null;
  let kvError: unknown = null;
  try {
    kvValue = await env.STATE_KV.get(key);
  } catch (err) {
    kvError = err;
  }
  if (kvValue !== null && kvValue !== undefined) return kvValue;

  let row: TursoRow | null = null;
  try {
    row = await tursoGet(cfg, key);
  } catch (err) {
    console.error(`kvStore: Turso read failed for ${key}`, err);
  }
  if (kvError) {
    if (row) return row.value; // KV itself is erroring; the fallback copy is the best durable truth we have
    throw kvError;
  }
  if (!row) return null;
  const ttl = remainingTtlSeconds(row.expiresAt);
  if (ttl !== null && ttl <= 0) {
    // Expired fallback row: drop it and report a miss, matching KV's own TTL semantics.
    await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: failed to drop expired fallback row ${key}`, err));
    return null;
  }
  // Opportunistic repair: KV missed but has quota again (or never had this key), so
  // restore the value into KV and clear the shadow, making this a one-time Turso read.
  try {
    await env.STATE_KV.put(key, row.value, ttl !== null ? { expirationTtl: Math.max(ttl, 60) } : undefined);
  } catch (err) {
    console.error(`kvStore: KV repair write failed for ${key}`, err);
    return row.value; // the shadow row stays -- it is still the only durable copy
  }
  await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: repaired shadow delete failed for ${key}`, err));
  return row.value;
}

export async function kvPut(env: Env, key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
  const cfg = tursoConfig(env);
  if (!cfg || !isFallbackEligible(key)) return env.STATE_KV.put(key, value, opts);

  let kvError: unknown = null;
  if (!circuitIsOpen()) {
    try {
      await env.STATE_KV.put(key, value, opts);
      circuitNoteSuccess();
      // Clear any stale shadow so a later sweep can never overwrite this fresher value.
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
    await tursoUpsert(cfg, key, value, expiresAt);
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
    // then surface the KV failure exactly as the pre-§5B code did.
    await tursoDelete(cfg, key).catch((tursoErr) => console.error(`kvStore: fallback delete failed for ${key}`, tursoErr));
    throw err;
  }
  await tursoDelete(cfg, key).catch((err) => console.error(`kvStore: shadow delete failed for ${key}`, err));
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
  remaining: boolean;
}

export async function sweepKvFallback(env: Env, limit = SWEEP_DEFAULT_LIMIT): Promise<SweepResult> {
  const result: SweepResult = { swept: 0, expired: 0, remaining: false };
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
    const ttl = remainingTtlSeconds(row.expiresAt);
    if (ttl !== null && ttl <= 60) {
      // Expired (or expiring inside KV's 60-second TTL floor): the value's life is over.
      await tursoDelete(cfg, row.key).catch((err) => console.error(`kvStore: sweep drop failed for ${row.key}`, err));
      result.expired += 1;
      continue;
    }
    try {
      await env.STATE_KV.put(row.key, row.value, ttl !== null ? { expirationTtl: Math.max(ttl, 60) } : undefined);
    } catch (err) {
      console.error(`kvStore: sweep KV write failed at ${row.key}; remaining rows held for a later pass`, err);
      break;
    }
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
