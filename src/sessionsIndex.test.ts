import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  trimSessionsIndex,
  shouldAlertPendingApprovalBacklog,
  deriveSessionLabel,
  safeEntityTokenRef,
  safeMatterTokenRef,
  sanitizeSessionSummary,
  sanitizeSessionsIndex,
  loadSessionsIndexForRead,
  humanizeStage,
  sessionRowText,
} from "./sessionsIndex";
import { __resetKvStoreStateForTests, __setTursoFetchForTests } from "./kvStore";
import type { Env, SessionSummary } from "./types";

// ---------------------------------------------------------------------------
// The /sessions READ path against hostile legacy values arriving through the
// real storage seam (kvGet/kvPut): served sanitized, rewritten once, and
// emitted rows that can never carry the legacy identity or enquiry text.
// ---------------------------------------------------------------------------

/** Every identity/content term the hostile legacy bytes below contain. */
const LEGACY_LEAKS = ["John Smith", "ACME", "renewal enquiry", "Globex", "pricing question", "Lead→Prospect", "New Entity", "E-20", "M-12"];

/**
 * A realistic pre-contract sessions_index value as it can sit in KV (or be
 * served from a Turso fallback row): free-text labels, plus stale-prefix
 * token fields from the pre-rename era and one still-valid token pair.
 */
function hostileIndexBytes(): string {
  return JSON.stringify([
    {
      workId: "w-1",
      unit: "Sales",
      hat: "Lead Generation Specialist",
      stage: "awaiting_entity_creation_approval",
      label: "New Entity: John Smith for ACME Corp -- renewal enquiry",
      updatedAt: "2026-10-09T08:00:00.000Z",
      hasPendingApproval: true,
      matterId: "matter-page-1",
    },
    {
      workId: "w-2",
      unit: "Sales",
      hat: "Account Executive",
      stage: "awaiting_qualification_approval",
      label: "Lead→Prospect: ACME Corp",
      updatedAt: "2026-10-09T08:05:00.000Z",
      hasPendingApproval: true,
      entityToken: "E-20",
      matterToken: "M-12",
    },
    {
      workId: "w-3",
      unit: "Strategy",
      hat: "Strategy Analyst",
      stage: "new",
      label: "Opportunity: Globex Ltd -- inbound pricing question",
      updatedAt: "2026-10-09T08:10:00.000Z",
      entityToken: "ENT-9",
      matterToken: "MAT-3",
    },
  ]);
}

function makeKvEnv(): { env: Env; store: Map<string, string>; putCalls: string[]; failPut: () => void } {
  const store = new Map<string, string>();
  const putCalls: string[] = [];
  let failPut = false;
  const env = {
    STATE_KV: {
      get: async (key: string) => (store.has(key) ? store.get(key)! : null),
      put: async (key: string, value: string) => {
        if (failPut) throw new Error("kv put boom");
        putCalls.push(key);
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true }),
    },
  } as unknown as Env;
  return { env, store, putCalls, failPut: () => (failPut = true) };
}

/** Minimal in-process fake of Turso's /v2/pipeline API (the full one lives in kvStore.test.ts). */
function makeSlimTurso(): { rows: Map<string, { value: string; expires_at: number | null; updated_at: number }>; fetch: typeof fetch } {
  const rows = new Map<string, { value: string; expires_at: number | null; updated_at: number }>();
  const argValue = (a: unknown): string | number | null => (a === null || a === undefined ? null : typeof a === "object" ? (a as { value: string | number }).value : (a as string | number));
  const executed = (resultRows: Array<Array<{ type: string; value: string } | null>>): Record<string, unknown> => ({
    type: "ok",
    response: { type: "execute", result: { cols: [], rows: resultRows, affected_row_count: resultRows.length, last_insert_rowid: null } },
  });
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    const requests = (JSON.parse((init as { body: string }).body) as { requests: Array<{ type: string; stmt?: { sql: string; args?: unknown[] } }> }).requests;
    const results = requests.map((request) => {
      const sql = request.stmt?.sql ?? "";
      const args = (request.stmt?.args ?? []).map(argValue);
      if (request.type === "close") return { type: "ok", response: { type: "close" } };
      if (sql.startsWith("CREATE TABLE")) return executed([]);
      if (sql.startsWith("INSERT INTO")) {
        const [key, value, expiresAt, updatedAt] = args as [string, string, string | null, string];
        rows.set(key, { value, expires_at: expiresAt === null ? null : Number(expiresAt), updated_at: Number(updatedAt) });
        return executed([]);
      }
      if (sql.startsWith("DELETE FROM")) {
        rows.delete(args[0] as string);
        return executed([]);
      }
      if (sql.startsWith('SELECT "value"')) {
        const row = rows.get(args[0] as string);
        return executed(row ? [[{ type: "text", value: row.value }, row.expires_at === null ? null : { type: "integer", value: String(row.expires_at) }, { type: "integer", value: String(row.updated_at) }]] : []);
      }
      throw new Error(`slim Turso fake got unexpected SQL: ${sql}`);
    });
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { rows, fetch: fetchImpl };
}

/** Decode a stored envelope back to its raw value (copy of kvStore.test.ts's unwrap). */
function unwrapEnvelope(raw: string | undefined): string {
  if (raw === undefined) return "";
  try {
    const parsed = JSON.parse(raw) as { __enig_kv?: number; val?: string };
    if (parsed && parsed.__enig_kv === 1 && typeof parsed.val === "string") return parsed.val;
  } catch {
    /* legacy plain value */
  }
  return raw;
}

function captureConsoleErrors(): { messages: string[]; restore: () => void } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

test("loadSessionsIndexForRead: a hostile legacy value at the KV seam is served sanitized AND rewritten once (bounded)", async () => {
  const { env, store, putCalls } = makeKvEnv();
  store.set("sessions_index", hostileIndexBytes());

  const served = await loadSessionsIndexForRead(env);
  const servedBytes = JSON.stringify(served);
  for (const leak of LEGACY_LEAKS) {
    assert.equal(servedBytes.includes(leak), false, `the served index must never carry: ${leak}`);
  }
  // Continuation-critical fields survive sanitization untouched.
  assert.equal(served.length, 3);
  assert.equal(served[0].workId, "w-1");
  assert.equal(served[0].matterId, "matter-page-1");
  assert.equal(served[0].label, "pending approval");
  assert.equal(served[0].hasPendingApproval, true);
  assert.equal(served[1].entityToken, undefined, "stale-prefix tokens are dropped, not served as references");
  assert.equal(served[1].matterToken, undefined);
  assert.equal(served[2].label, "ENT-9 · MAT-3", "a still-valid token pair keeps its safe reference");

  // Bounded migration: exactly one rewrite, and the stored bytes are the
  // sanitized array (nothing lost, nothing added).
  assert.deepEqual(putCalls, ["sessions_index"]);
  const stored = store.get("sessions_index")!;
  for (const leak of LEGACY_LEAKS) {
    assert.equal(stored.includes(leak), false, `the persisted rewrite must never carry: ${leak}`);
  }
  assert.equal(JSON.parse(stored).length, 3, "the rewrite must not drop entries");

  // Second read: stored == sanitized now, so the loader stops writing.
  await loadSessionsIndexForRead(env);
  assert.deepEqual(putCalls, ["sessions_index"], "the migration is bounded -- once clean, reads never write again");
});

test("loadSessionsIndexForRead: a failed rewrite still serves sanitized values and truthfully leaves the persisted legacy value in place", async () => {
  const { env, store, failPut } = makeKvEnv();
  store.set("sessions_index", hostileIndexBytes());
  failPut();

  const capture = captureConsoleErrors();
  try {
    const served = await loadSessionsIndexForRead(env);
    // Display-side truth: what callers consume IS sanitized (in memory).
    for (const leak of LEGACY_LEAKS) {
      assert.equal(JSON.stringify(served).includes(leak), false, `served values must be sanitized even when the rewrite fails`);
    }
    // Persistence-side truth: the stored bytes are untouched -- nothing
    // anywhere claims the persisted value was sanitized.
    assert.equal(store.get("sessions_index"), hostileIndexBytes(), "a failed rewrite must leave the persisted value exactly as it was");
    assert.ok(capture.messages.some((m) => m.includes("still holds the legacy labels")), "the failure must be logged truthfully");
  } finally {
    capture.restore();
  }
});

test("loadSessionsIndexForRead: an unparseable or non-array stored value is served empty with NO migration write", async () => {
  const { env, store, putCalls } = makeKvEnv();
  store.set("sessions_index", "{not json");
  const capture = captureConsoleErrors();
  try {
    assert.deepEqual(await loadSessionsIndexForRead(env), []);
    assert.deepEqual(putCalls, [], "corrupt bytes must never be silently overwritten");
    assert.equal(store.get("sessions_index"), "{not json", "the evidence stays exactly as stored");
    assert.ok(capture.messages.some((m) => m.includes("could not be parsed")));

    store.set("sessions_index", JSON.stringify({ not: "an array" }));
    assert.deepEqual(await loadSessionsIndexForRead(env), []);
    assert.deepEqual(putCalls, [], "a non-array value is corrupt too -- still no write");
    assert.ok(capture.messages.some((m) => m.includes("not an array")));
  } finally {
    capture.restore();
  }
});

test("loadSessionsIndexForRead: a hostile legacy value served from Turso through kvGet is sanitized, and both stores converge to the sanitized value", async () => {
  const { env, store } = makeKvEnv();
  const turso = makeSlimTurso();
  (env as unknown as Record<string, unknown>).TURSO_DATABASE_URL = "libsql://enig-fallback-test.turso.io";
  (env as unknown as Record<string, unknown>).TURSO_AUTH_TOKEN = "test-turso-token";
  // The legacy bytes live ONLY in the fallback row -- KV is empty, so kvGet
  // repairs KV from the row and hands the hostile value to the loader.
  turso.rows.set("sessions_index", { value: hostileIndexBytes(), expires_at: null, updated_at: Date.now() });
  __setTursoFetchForTests(turso.fetch);
  __resetKvStoreStateForTests();
  try {
    const served = await loadSessionsIndexForRead(env);
    for (const leak of LEGACY_LEAKS) {
      assert.equal(JSON.stringify(served).includes(leak), false, `a Turso-served value must be sanitized before any caller sees it: ${leak}`);
    }
    // The seam repaired KV (envelope-wrapped), then the bounded rewrite
    // re-sanitized it -- the live KV copy holds the sanitized array.
    const kvValue = unwrapEnvelope(store.get("sessions_index"));
    for (const leak of LEGACY_LEAKS) {
      assert.equal(kvValue.includes(leak), false, `the repaired KV copy must converge to the sanitized value: ${leak}`);
    }
    assert.equal(JSON.parse(kvValue).length, 3, "no entry is lost through the Turso path");
    // The shadow row is gone: nothing left that could resurrect the bytes.
    assert.equal(turso.rows.size, 0, "the legacy fallback row must be cleared, not left as a resurrection candidate");
  } finally {
    __setTursoFetchForTests(undefined);
    __resetKvStoreStateForTests();
  }
});

test("/sessions emission: rows rendered from a hostile seam value never contain the legacy name or enquiry excerpt", async () => {
  const { env, store } = makeKvEnv();
  store.set("sessions_index", hostileIndexBytes());

  // Exactly listSessions' read + filter + row template (the wiring contract
  // test below pins index.ts to these same two functions).
  const index = await loadSessionsIndexForRead(env);
  const open = index.filter((s) => s.stage !== "complete" && s.stage !== "closed_not_qualified");
  const rows = open.map((s) => sessionRowText(s, "w-2"));
  const rendered = rows.join("\n");
  for (const leak of LEGACY_LEAKS) {
    assert.equal(rendered.includes(leak), false, `/sessions must never emit: ${leak}`);
  }
  // The safe vocabulary that survives: fixed generics, the active bullet,
  // the humanized stage and the canonical token reference.
  assert.equal(rows[0], "Sales/Lead Generation Specialist — pending approval (Awaiting entity creation approval)");
  assert.equal(rows[1].startsWith("• ") && rows[1].includes("Sales/Account Executive — pending approval"), true, "the active work keeps its bullet and generic label");
  assert.ok(rows[2].includes("Strategy/Strategy Analyst — ENT-9 · MAT-3 (New)"));
  assert.equal(humanizeStage("closed_not_qualified"), "Closed not qualified");
});

function summary(workId: string, hasPendingApproval: boolean): SessionSummary {
  return {
    workId,
    unit: "Sales",
    hat: "Lead Generation Specialist",
    stage: "new",
    label: workId,
    updatedAt: new Date().toISOString(),
    hasPendingApproval,
  };
}

test("trimSessionsIndex keeps all entries when both pools are under their caps", () => {
  const combined = [summary("g1", false), summary("g2", false), summary("p1", true), summary("p2", true)];
  const kept = trimSessionsIndex(combined);
  assert.strictEqual(kept.length, 4);
  assert.ok(kept.some((s) => s.workId === "p1"));
  assert.ok(kept.some((s) => s.workId === "p2"));
});

test("trimSessionsIndex caps the general pool at 50 without touching pending entries", () => {
  const general = Array.from({ length: 60 }, (_, i) => summary(`g${i}`, false));
  const pending = [summary("p1", true)];
  const kept = trimSessionsIndex([...general, ...pending]);

  const keptGeneral = kept.filter((s) => !s.hasPendingApproval);
  const keptPending = kept.filter((s) => s.hasPendingApproval);
  assert.strictEqual(keptGeneral.length, 50, "general pool must be capped at 50");
  assert.strictEqual(keptPending.length, 1, "the single pending entry must never be evicted by general-pool churn");
  assert.ok(keptPending[0].workId === "p1");
  // The oldest general entries (g0..g9) should have been trimmed, keeping the most recent 50.
  assert.ok(!keptGeneral.some((s) => s.workId === "g0"));
  assert.ok(keptGeneral.some((s) => s.workId === "g59"));
});

test("trimSessionsIndex caps the pending pool at 100 -- bounded, not 'never evict'", () => {
  const pending = Array.from({ length: 110 }, (_, i) => summary(`p${i}`, true));
  const kept = trimSessionsIndex(pending);
  assert.strictEqual(kept.length, 100, "pending pool must be bounded, even though its allowance is much larger than the general pool");
  // Oldest pending entries fall out first; most recent are retained.
  assert.ok(!kept.some((s) => s.workId === "p0"));
  assert.ok(kept.some((s) => s.workId === "p109"));
});

test("trimSessionsIndex total size never exceeds pending cap + general cap regardless of input size", () => {
  const huge = Array.from({ length: 500 }, (_, i) => summary(`x${i}`, i % 3 === 0));
  const kept = trimSessionsIndex(huge);
  assert.ok(kept.length <= 150, `expected bounded output, got ${kept.length}`);
});

test("shouldAlertPendingApprovalBacklog stays silent below the pending cap", () => {
  assert.strictEqual(shouldAlertPendingApprovalBacklog(99, null, Date.now()), false);
});

test("shouldAlertPendingApprovalBacklog fires the first time the cap is reached (no prior alert)", () => {
  assert.strictEqual(shouldAlertPendingApprovalBacklog(100, null, Date.now()), true);
});

test("shouldAlertPendingApprovalBacklog is rate-limited -- stays silent within the cooldown window", () => {
  const now = Date.now();
  const fiveMinutesAgo = String(now - 5 * 60 * 1000);
  assert.strictEqual(shouldAlertPendingApprovalBacklog(120, fiveMinutesAgo, now), false);
});

test("shouldAlertPendingApprovalBacklog fires again once the cooldown window has elapsed", () => {
  const now = Date.now();
  const overThirtyMinutesAgo = String(now - 31 * 60 * 1000);
  assert.strictEqual(shouldAlertPendingApprovalBacklog(120, overThirtyMinutesAgo, now), true);
});

// ---------------------------------------------------------------------------
// sessions_index value-level data boundary: the stored label may only ever
// be a canonical token reference or fixed generic metadata (the value this
// key carries may fall back to Turso, so identity/content must not be in it).
// ---------------------------------------------------------------------------

test("token refs are role-exact: only ENT-<n> names an Entity and MAT-<n> a Matter (the live unique_id shapes)", () => {
  // Canonical shapes: the live Notion Entity_ID / Matter_ID unique_id
  // properties read back as e.g. ENT-28 / MAT-29.
  assert.equal(safeEntityTokenRef("ENT-7"), "ENT-7");
  assert.equal(safeMatterTokenRef("MAT-20"), "MAT-20");
  assert.equal(safeEntityTokenRef(" ENT-7 "), "ENT-7"); // trimmed

  // Wrong role in the slot: a token of the other role is not a reference
  // to THIS field's entity.
  assert.equal(safeEntityTokenRef("MAT-20"), undefined);
  assert.equal(safeMatterTokenRef("ENT-7"), undefined);

  // Other canonical-but-wrong-kind ENIG ids are not Entity/Matter refs.
  assert.equal(safeEntityTokenRef("HO-64"), undefined); // Handoff id
  assert.equal(safeMatterTokenRef("HO-64"), undefined);
  assert.equal(safeEntityTokenRef("CN-12"), undefined); // Call Notes id
  assert.equal(safeEntityTokenRef("LOG-976"), undefined); // Activity Log id

  // Stale prefixes (pre-rename era) are not the live shape -- they are
  // dropped, never displayed as if they were current references.
  assert.equal(safeEntityTokenRef("E-20"), undefined);
  assert.equal(safeMatterTokenRef("M-12"), undefined);

  // Names, free text, malformed values: all discarded.
  assert.equal(safeEntityTokenRef("Acme Corporation"), undefined);
  assert.equal(safeEntityTokenRef("John Smith"), undefined);
  assert.equal(safeEntityTokenRef("New Entity: ACME"), undefined);
  assert.equal(safeEntityTokenRef(""), undefined);
  assert.equal(safeEntityTokenRef(undefined), undefined);
  assert.equal(safeMatterTokenRef(undefined), undefined);
  assert.equal(safeEntityTokenRef("ent-7"), undefined); // case matters -- non-canonical shapes are dropped
  assert.equal(safeEntityTokenRef("ENT-7-extra"), undefined);
  assert.equal(safeEntityTokenRef("ENT-"), undefined);
});

test("deriveSessionLabel: token references when present, otherwise fixed generic metadata only", () => {
  assert.equal(deriveSessionLabel({ entityToken: "ENT-7", matterToken: "MAT-20" }), "ENT-7 · MAT-20");
  assert.equal(deriveSessionLabel({ matterToken: "MAT-20" }), "MAT-20");
  assert.equal(deriveSessionLabel({ hasPendingApproval: true }), "pending approval");
  assert.equal(deriveSessionLabel({ hasPendingApproval: false }), "(new)");
  assert.equal(deriveSessionLabel({}), "(new)");
  // A malformed "token" cannot smuggle text into the label vocabulary.
  assert.equal(deriveSessionLabel({ entityToken: "Acme Corp" }), "(new)");
  // Nor can a wrong-role or stale-prefix token.
  assert.equal(deriveSessionLabel({ entityToken: "MAT-20" }), "(new)");
  assert.equal(deriveSessionLabel({ entityToken: "HO-64" }), "(new)");
  assert.equal(deriveSessionLabel({ entityToken: "E-20" }), "(new)");
});

test("sessions_index leak-proof: sanitizing a hostile legacy index leaves no names, enquiry text or approval labels in the stored JSON", () => {
  const hostile: SessionSummary[] = [
    {
      workId: "w-1",
      unit: "Sales",
      hat: "Lead Generation Specialist",
      stage: "awaiting_entity_creation_approval",
      // Pre-contract label: raw enquiry slice + AI-extracted name
      label: "New Entity: John Smith for ACME Corp -- renewal enquiry",
      updatedAt: new Date().toISOString(),
      hasPendingApproval: true,
      matterId: "matter-page-1",
    },
    {
      workId: "w-2",
      unit: "Sales",
      hat: "Account Executive",
      stage: "awaiting_qualification_approval",
      label: "Lead→Prospect: ACME Corp",
      updatedAt: new Date().toISOString(),
      hasPendingApproval: true,
    },
    {
      workId: "w-3",
      stage: "new",
      label: "Opportunity: Globex Ltd -- inbound pricing question",
      updatedAt: new Date().toISOString(),
    },
  ];

  const sanitized = sanitizeSessionsIndex(hostile);
  const stored = JSON.stringify(sanitized);

  // The stored value (the exact bytes a kvPut of sessions_index would send)
  // must not contain any identity or content term from the legacy labels.
  for (const leak of ["John Smith", "ACME", "renewal enquiry", "Globex", "pricing question", "Lead→Prospect", "New Entity"]) {
    assert.equal(stored.includes(leak), false, `sessions_index must never store: ${leak}`);
  }

  // Entries survive (works without tokens -- e.g. no-token Matter work --
  // keep their slot in the index with generic metadata).
  assert.equal(sanitized.length, 3);
  assert.equal(sanitized[0].workId, "w-1");
  assert.equal(sanitized[0].matterId, "matter-page-1", "matterId resolution fields are preserved");
  assert.equal(sanitized[0].label, "pending approval");
  assert.equal(sanitized[1].label, "pending approval");
  assert.equal(sanitized[2].label, "(new)");

  // Token-carrying entries keep their safe reference as the label.
  const withTokens = sanitizeSessionSummary({ ...hostile[1], entityToken: "ENT-42", matterToken: "MAT-7" });
  assert.equal(withTokens.label, "ENT-42 · MAT-7");
  assert.equal(JSON.stringify(withTokens).includes("ENT-42"), true);

  // A non-canonical token field is dropped, never stored as-is.
  const poisoned = sanitizeSessionSummary({ ...hostile[2], entityToken: "John Smith" });
  assert.equal(poisoned.entityToken, undefined);
  assert.equal(poisoned.label, "(new)");

  // A wrong-kind canonical token (handoff id) in the Entity slot is
  // dropped too -- only ENT-<n> may name an Entity here.
  const poisonedKind = sanitizeSessionSummary({ ...hostile[2], entityToken: "HO-64", matterToken: "M-12" });
  assert.equal(poisonedKind.entityToken, undefined);
  assert.equal(poisonedKind.matterToken, undefined);
  assert.equal(poisonedKind.label, "(new)");
});

test("wiring contract: session.ts derives and sanitizes EVERY sessions_index save through sessionsIndex.ts (source scan)", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "session.ts"), "utf8");
  assert.match(source, /deriveSessionLabel\(/, "updateRegistry must derive the label through deriveSessionLabel");
  assert.match(source, /safeEntityTokenRef\(state\.entityToken\)/, "the entity token must pass through safeEntityTokenRef");
  assert.match(source, /safeMatterTokenRef\(state\.matterToken\)/, "the matter token must pass through safeMatterTokenRef");
  assert.match(source, /sanitizeSessionsIndex\(combined\)/, "the WHOLE index (not just this Work's entry) must be sanitized on every save");
  assert.equal(
    /label:\s*state\.pendingActionSummary\?\.label/.test(source),
    false,
    "the free-text pendingActionSummary label must never be stored again",
  );
});

test("wiring contract: index.ts /sessions reads through the sanctioned sanitizing loader and the tested row template (source scan)", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
  const listSessions = source.slice(source.indexOf("async function listSessions"), source.indexOf("async function listSessionKvKeys"));
  assert.match(listSessions, /loadSessionsIndexForRead\(env\)/, "listSessions must read through loadSessionsIndexForRead (sanitize + bounded migration)");
  assert.match(listSessions, /sessionRowText\(s, activeId\)/, "the emitted row text must be sessionRowText -- the exact template under test");
  assert.equal(/JSON\.parse\(raw\)/.test(listSessions), false, "listSessions must never parse the stored index itself");
  assert.equal(/s\.label/.test(listSessions), false, "listSessions must never interpolate a stored label directly");
  assert.match(listSessions, /s\.stage !== "complete" && s\.stage !== "closed_not_qualified"/, "the terminal-Work filtering stays exactly as it was");
});

test("wiring contract: matterContinuation sanitizes the index before consuming it (source scan)", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "matterContinuation.ts"), "utf8");
  const readSessionsIndex = source.slice(source.indexOf("async function readSessionsIndex"), source.indexOf("function resumableCandidates"));
  assert.match(readSessionsIndex, /sanitizeSessionsIndex\(parsed\)/, "readSessionsIndex must sanitize every entry before any field is consumed");
});
