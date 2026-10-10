/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  MATTER_CURRENT_WORK_PREFIX,
  continueMatterWork,
  ensureMatterIdentity,
  isTerminalWorkStage,
  matterCurrentWorkKey,
  parseMatterArgument,
  resumeMatterWork,
  resolveMatterCurrentWork,
  syncMatterContinuationPointer,
} from "./matterContinuation";
import { continueExistingWork, resumeNotice } from "./workContinuation";
import { getActiveWorkId, setActiveWorkId } from "./sessionRouting";
import { routeIncomingText } from "./router";
import { runWithAdoptedOwnership } from "./handoffOwnership";
import type { Env, Unit, WorkState } from "./types";

/**
 * Covers the Matter continuation contract (src/matterContinuation.ts,
 * docs/enig-operating-model.md "Matter is the continuation anchor"):
 *
 *  Matter -> matter_current_work:<matterId> -> existing workId ->
 *  existing WorkSession / WorkState.
 *
 * Work stays the one execution identity (id, session, state, Handoffs all
 * unchanged -- PR #251's same-Work Handoff continuity is asserted here,
 * not redesigned); Matter is only the pointer a person resumes through;
 * `active:<chatId>:<threadId>` stays the interaction-local pointer and
 * converges on the same Work; every ambiguity fails closed with a reason.
 */

const MATTER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MATTER_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FINANCE_HAT = "Value-Based Pricing Assessor";
const STRATEGY_HAT = "Strategy Analyst";
const SALES_HAT = "Sales Executive";

type WorkStore = Map<string, WorkState>;

interface FakeWorld {
  env: Env;
  works: WorkStore;
  kv: Map<string, string>;
  /** Replies the existing WorkSession routing machinery consumed (its handleTextReply). */
  textReplies: Array<{ workId: string; text: string }>;
}

function fakeWorld(): FakeWorld {
  const kv = new Map<string, string>();
  const works: WorkStore = new Map();
  const textReplies: Array<{ workId: string; text: string }> = [];
  const env = {
    STATE_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, String(value));
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    },
    WORK_SESSION: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        getState: async () => works.get(id),
        // The Work's own resume/routing entry -- this is the machinery
        // routeIncomingText's association blocks, /sessions switching and
        // Matter Continue all hand the workId to (workContinuation.ts).
        handleTextReply: async (text: string) => {
          textReplies.push({ workId: id, text });
          return works.get(id);
        },
      }),
    },
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    NOTION_TOKEN: "test-notion-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
    AI: {},
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
  } as unknown as Env;
  return { env, works, kv, textReplies };
}

async function readIndex(env: Env): Promise<Array<Record<string, unknown>>> {
  const raw = await env.STATE_KV.get("sessions_index");
  return raw ? JSON.parse(raw) : [];
}

/**
 * Mirrors WorkSession.save -> updateRegistry's exact ordering (derive
 * Matter identity, persist, write sessions_index, then sync the pointer) so
 * the lifecycle rules are exercised the way production drives them. The
 * production wiring itself is pinned separately by the source-contract test
 * at the bottom of this file -- session.ts cannot be imported under the
 * node test runner because of its `cloudflare:workers` import.
 */
async function simulateWorkSave(world: FakeWorld, state: WorkState): Promise<void> {
  await ensureMatterIdentity(world.env, state);
  world.works.set(state.workId, state);
  const isTerminal = isTerminalWorkStage(state.stage);
  const index = await readIndex(world.env);
  const withoutSelf = index.filter((s) => s.workId !== state.workId);
  const summary = {
    workId: state.workId,
    unit: state.unit,
    hat: state.hat,
    stage: state.stage,
    label: state.workId,
    updatedAt: state.updatedAt,
    matterId: state.matterId,
  };
  const combined = isTerminal ? withoutSelf : [...withoutSelf, summary];
  await world.env.STATE_KV.put("sessions_index", JSON.stringify(combined));
  await syncMatterContinuationPointer(world.env, state, isTerminal);
}

function workState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: `work-${Math.random().toString(36).slice(2, 10)}`,
    chatId: 9999,
    threadId: 100,
    unit: "Sales",
    hat: SALES_HAT,
    actionName: "new_enquiry",
    stage: "in_progress",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  } as WorkState;
}

// ---------------------------------------------------------------------------
// Notion fetch mock: matters queries (token -> id), Handoff page reads and
// Activity-log creates. Nothing real is ever touched -- this task writes to
// Notion only through the pre-existing paths the tests mock out.
// ---------------------------------------------------------------------------

interface NotionMock {
  calls: Array<{ method: string; url: string }>;
  sentMessages: string[];
}

function mockNotion(
  t: any,
  options: {
    /** Matter pages returned by a MATTERS_DATA_SOURCE_ID query, keyed by token number. */
    matters?: Array<{ id: string; token: string; entityId?: string | null }>;
    /** Handoff pages served by GET /v1/pages/<id>. */
    pages?: Record<string, unknown>;
  } = {},
): NotionMock {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string }> = [];
  const sentMessages: string[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    // Telegram sends are the only outbound besides Notion here (the resume
    // notices and routeIncomingText's own replies); record them, never send.
    if (url.includes("api.telegram.org")) {
      calls.push({ method, url });
      try {
        const body = JSON.parse(String(init.body ?? "{}"));
        if (body.text !== undefined) sentMessages.push(String(body.text));
      } catch {
        // ignore malformed bodies
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (!url.includes("api.notion.com")) throw new Error(`Unexpected fetch in test: ${url}`);
    calls.push({ method, url });

    if (method === "POST" && url.includes("/data_sources/matters-ds/query")) {
      const results = (options.matters ?? []).map((m) => ({
        id: m.id,
        url: `https://notion.so/${m.id}`,
        properties: {
          Matter_ID: { unique_id: { prefix: m.token.split("-")[0], number: Number(m.token.split("-")[1]) } },
          ...(m.entityId === null ? {} : { Entity: { relation: [{ id: m.entityId ?? "entity-1" }] } }),
        },
      }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    if (method === "GET" && url.includes("/v1/pages/")) {
      const id = url.split("/v1/pages/")[1].split("?")[0];
      const page = options.pages?.[id];
      if (!page) return new Response(JSON.stringify({ message: "Could not find page." }), { status: 404 });
      return new Response(JSON.stringify(page), { status: 200 });
    }
    if (method === "POST" && url.replace(/\/+$/, "").endsWith("/v1/pages")) {
      return new Response(JSON.stringify({ id: "activity-page", url: "https://notion.so/activity-page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected Notion request in test: ${method} ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { calls, sentMessages };
}

function handoffPage(id: string, toUnit: string, toHat: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
    properties: {
      "To Unit": { select: { name: toUnit } },
      "To Hat": { rich_text: [{ plain_text: toHat }] },
      Reason: { rich_text: [{ plain_text: "Approved work ready for the receiving Unit." }] },
    },
  };
}

// ---------------------------------------------------------------------------
// 1-4: the user flow and the pointers it converges on.
// ---------------------------------------------------------------------------

test("create Work for Matter -> /continue MAT-20 resolves that same Work (token resolved once, stored on the Work)", async (t) => {
  const world = fakeWorld();
  mockNotion(t, { matters: [{ id: MATTER_A, token: "MAT-20" }] });

  // How Strategy/Finance actually learn a Matter: the opaque token only.
  const state = workState({ unit: "Strategy", hat: STRATEGY_HAT, actionName: "diagnose", matterToken: "MAT-20" });
  await simulateWorkSave(world, state);

  assert.strictEqual(state.matterId, MATTER_A, "the token is resolved to its page id and stored on the Work, once");
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), state.workId, "the Matter pointer names this Work");

  const resumed = await resumeMatterWork(world.env, "MAT-20");
  assert.ok(resumed.ok, `expected a resume, got: ${!resumed.ok ? resumed.reason : ""}`);
  assert.strictEqual(resumed.workId, state.workId, "the resumed Work is the Work that was created for the Matter");
  assert.strictEqual(resumed.state, state, "resume returns the existing WorkState, not a new session");
});

test("switch Matter A -> Matter B -> Matter A resumes each Matter's own correct Work", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const workA = workState({ matterId: MATTER_A });
  const workB = workState({ matterId: MATTER_B });
  await simulateWorkSave(world, workA);
  await simulateWorkSave(world, workB);

  for (const [matterId, expected] of [
    [MATTER_A, workA.workId],
    [MATTER_B, workB.workId],
    [MATTER_A, workA.workId],
  ] as const) {
    const resumed = await resumeMatterWork(world.env, matterId);
    assert.ok(resumed.ok, `expected a resume for ${matterId}`);
    assert.strictEqual(resumed.workId, expected, `${matterId} must always resolve its own Work`);
  }
  assert.strictEqual(world.works.size, 2, "two Matters, two Works -- no Work is created or duplicated by resuming");
});

test("Matter continuation works with no active chat/thread pointer at all", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const state = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, state);
  assert.strictEqual(await world.env.STATE_KV.get(`active:9999:100`), null, "no interaction-local pointer exists yet");
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), null);

  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(resumed.ok, `expected a resume: ${!resumed.ok ? resumed.reason : ""}`);
  assert.strictEqual(resumed.workId, state.workId);
});

test("active chat/thread continuation and Matter continuation resolve the same Work", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const state = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, state);
  await setActiveWorkId(world.env, 9999, 100, state.workId);

  const active = await getActiveWorkId(world.env, 9999, 100);
  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(resumed.ok, "expected a resume");
  assert.strictEqual(active, state.workId, "the interaction-local pointer names this Work");
  assert.strictEqual(resumed.workId, active, "both continuation paths converge on ONE Work -- never competing identities");
});

// ---------------------------------------------------------------------------
// 5-6: PR #251's same-Work Handoff behaviour is preserved.
// ---------------------------------------------------------------------------

test("Work crosses Sales -> Strategy -> Finance -> Sales and the Matter still resolves the same Work", async (t) => {
  const world = fakeWorld();
  mockNotion(t, {
    pages: {
      "hs-strategy": handoffPage("hs-strategy", "Strategy", STRATEGY_HAT),
      "hs-finance": handoffPage("hs-finance", "Finance", FINANCE_HAT),
      "hs-sales": handoffPage("hs-sales", "Sales", SALES_HAT),
    },
  });

  const state = workState({ matterId: MATTER_A, handoffId: "hs-strategy" });
  await simulateWorkSave(world, state);
  const originWorkId = state.workId;

  const route: Array<{ unit: Unit; handoffId: string }> = [
    { unit: "Strategy", handoffId: "hs-strategy" },
    { unit: "Finance", handoffId: "hs-finance" },
    { unit: "Sales", handoffId: "hs-sales" },
  ];
  for (const hop of route) {
    state.handoffId = hop.handoffId;
    await runWithAdoptedOwnership(world.env, state, hop.unit, async (adopted) => adopted);
    // Production saves after every adoption (WorkSession.execute -> save).
    await simulateWorkSave(world, state);
    assert.strictEqual(state.workId, originWorkId, `workId must never change at a Unit boundary (${hop.unit})`);

    // F. Matter Continue at EVERY stage of the chain: MAT-26 -> WORK-26
    // holds while the receiving Unit changes inside the same WorkSession.
    const stage = await continueMatterWork(world.env, 9999, 100, MATTER_A);
    assert.ok(stage.ok, `Matter Continue must still resolve after ${state.unit} picked up (${!stage.ok ? stage.reason : ""})`);
    assert.strictEqual(stage.workId, originWorkId, `Matter Continue resolves the SAME Work while ${hop.unit} owns it`);
    assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), originWorkId, "the Matter pointer was never re-keyed by the Handoff");
  }

  assert.strictEqual(`${state.unit}/${state.hat}`, `Sales/${SALES_HAT}`, "ownership travelled the full chain and back");
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), originWorkId, "the Matter pointer was never moved by a Handoff");
  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(resumed.ok, `expected a resume: ${!resumed.ok ? resumed.reason : ""}`);
  assert.strictEqual(resumed.workId, originWorkId, "the Matter resolves the same Work the chain ran on");
  assert.strictEqual(world.works.size, 1, "the chain never produced a second Work");
});

test("Handoff pickup does not create a second Work: handoff_workitem stays the Handoff association, the Matter pointer stays the continuation", async (t) => {
  const world = fakeWorld();
  mockNotion(t, { pages: { "handoff-1": handoffPage("handoff-1", "Finance", FINANCE_HAT) } });

  const state = workState({ matterId: MATTER_A, handoffId: "handoff-1" });
  await simulateWorkSave(world, state);
  // Exactly what the creating Unit and the discovery loop record.
  await world.env.STATE_KV.put("handoff_workitem:handoff-1", state.workId);

  await runWithAdoptedOwnership(world.env, state, "Finance", async (adopted) => adopted);
  await simulateWorkSave(world, state);

  assert.strictEqual(world.works.size, 1, "a pickup runs on the existing WorkSession");
  assert.strictEqual(await world.env.STATE_KV.get("handoff_workitem:handoff-1"), state.workId, "the Handoff association is untouched and separate");
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), state.workId, "the Matter pointer still names the same Work");

  // G. Matter Continue through the pickup: the two mappings solve different
  // problems and neither creates a Work.
  const continued = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(continued.ok, `expected a continuation: ${!continued.ok ? continued.reason : ""}`);
  assert.strictEqual(continued.workId, state.workId, "handoff_workitem and matter_current_work both resolve the SAME Work");
  assert.strictEqual(world.works.size, 1, "a pickup plus a continuation still means one Work");

  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(resumed.ok, "expected a resume");
  assert.strictEqual(resumed.workId, state.workId);
});

// ---------------------------------------------------------------------------
// 7-10: fail closed.
// ---------------------------------------------------------------------------

test("terminal Work is not returned as current: completing it removes the pointer and /continue refuses", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const state = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, state);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), state.workId);

  state.stage = "complete";
  await simulateWorkSave(world, state);

  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), undefined, "a terminal Work drops out of the pointer");
  assert.strictEqual((await readIndex(world.env)).length, 0, "and out of the sessions index, as before");
  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(!resumed.ok, "a completed Work must never be resumed");
  assert.match(resumed.reason, /no current Work/);
});

test("missing Matter pointer fails cleanly (Matter with no Work at all)", async (t) => {
  const world = fakeWorld();
  mockNotion(t, { matters: [{ id: MATTER_B, token: "MAT-99" }] });

  const resolved = await resolveMatterCurrentWork(world.env, MATTER_B);
  assert.ok(!resolved.ok, "a Matter with no Work must not resolve anything");
  assert.match(resolved.reason, /no current Work/);

  const resumed = await resumeMatterWork(world.env, "MAT-99");
  assert.ok(!resumed.ok, "…and /continue must refuse rather than start something");
  assert.match(resumed.reason, /no current Work/);

  const noSuchMatter = await resumeMatterWork(world.env, "MAT-404");
  assert.ok(!noSuchMatter.ok, "an unknown token fails before any pointer is consulted");
  assert.match(noSuchMatter.reason, /does not resolve to an existing Matter/);
});

test("hostile legacy labels in sessions_index never break Matter continuation (read path sanitizes, continuation fields survive)", async () => {
  const world = fakeWorld();
  // A pre-contract index value seeded straight at the storage seam: a
  // free-text label carrying a name and an enquiry excerpt, plus poisoned
  // token fields. readSessionsIndex sanitizes every entry before any field
  // is consumed here.
  world.kv.set(
    "sessions_index",
    JSON.stringify([
      {
        workId: "w-hostile",
        unit: "Sales",
        hat: "Sales Executive",
        stage: "awaiting_strategy_handoff",
        label: "New Entity: John Smith for ACME Corp -- renewal enquiry",
        updatedAt: new Date().toISOString(),
        matterId: MATTER_A,
        entityToken: "John Smith",
        matterToken: "HO-64",
      },
    ]),
  );

  const resolved = await resolveMatterCurrentWork(world.env, MATTER_A);
  assert.deepStrictEqual(
    resolved,
    { ok: true, workId: "w-hostile" },
    "sanitization preserves every continuation field (workId/matterId/stage) -- the legacy label is discarded, the Work is not",
  );
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), "w-hostile", "the unique-candidate pointer is re-established exactly as before");
});

test("stale pointer fails cleanly: one to a missing Work, one to a terminal Work", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  // (a) pointer names a Work whose state no longer exists
  world.kv.set(matterCurrentWorkKey(MATTER_A), "ghost-work");
  const missing = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(!missing.ok, "a pointer to nothing must not resolve");
  assert.match(missing.reason, /no longer exists/);

  // (b) pointer names a Work that has since completed
  const completed = workState({ matterId: MATTER_A, stage: "complete" });
  world.works.set(completed.workId, completed);
  world.kv.set(matterCurrentWorkKey(MATTER_A), completed.workId);
  const terminal = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(!terminal.ok, "a pointer to terminal Work must not resolve");
  assert.match(terminal.reason, /already complete/);

  // (c) identity inconsistency: the pointed Work belongs to another Matter
  const otherMatter = workState({ matterId: MATTER_B });
  world.works.set(otherMatter.workId, otherMatter);
  world.kv.set(matterCurrentWorkKey(MATTER_A), otherMatter.workId);
  const inconsistent = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(!inconsistent.ok, "an inconsistent Matter/Work identity must be refused");
  assert.match(inconsistent.reason, /different Matter/);
});

test("ambiguous resumable Work candidates fail closed instead of guessing", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const first = workState({ matterId: MATTER_A });
  const second = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, first);
  await simulateWorkSave(world, second);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), first.workId, "the second Work did NOT steal a live pointer");

  // The pointer itself is lost while both Works are still resumable.
  world.kv.delete(matterCurrentWorkKey(MATTER_A));
  const resolved = await resolveMatterCurrentWork(world.env, MATTER_A);
  assert.ok(!resolved.ok, "two candidates and no pointer is a guess, and guesses are refused");
  assert.match(resolved.reason, /2 resumable Works.*refusing to guess/);
  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(!resumed.ok, "…so /continue refuses too");
  assert.match(resumed.reason, /refusing to guess/);

  // With the pointer present, it decides -- that is what a pointer is for.
  world.kv.set(matterCurrentWorkKey(MATTER_A), second.workId);
  const pointed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(pointed.ok, "a present pointer resolves without ambiguity");
  assert.strictEqual(pointed.workId, second.workId);
});

// ---------------------------------------------------------------------------
// 11-12: explicit lifecycle semantics.
// ---------------------------------------------------------------------------

test("a new Work becomes current only according to explicit lifecycle semantics", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const first = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, first);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), first.workId, "no current Work -> this Work becomes current");

  await simulateWorkSave(world, first);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), first.workId, "already current -> no-op");

  const second = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, second);
  assert.strictEqual(
    world.kv.get(matterCurrentWorkKey(MATTER_A)),
    first.workId,
    "another Work containing the same matterId does NOT become current while the holder is resumable",
  );

  first.stage = "complete";
  await simulateWorkSave(world, first);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), second.workId, "the holder terminated -> the pointer advances to the one resumable candidate");
});

test("completing/replacing the current Work updates the pointer correctly (remove, then a later Work becomes current)", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  const first = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, first);
  first.stage = "closed_not_qualified";
  await simulateWorkSave(world, first);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), undefined, "with no other candidate, the pointer is removed -- no Work is invented to fill it");

  const replacement = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, replacement);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), replacement.workId, "a later Work for the same Matter becomes current");

  const resumed = await resumeMatterWork(world.env, MATTER_A);
  assert.ok(resumed.ok, "expected a resume");
  assert.strictEqual(resumed.workId, replacement.workId);
});

test("a Work with no resolvable Matter identity gets no pointer (and its dead token is not re-queried)", async (t) => {
  const world = fakeWorld();
  const mock = mockNotion(t, { matters: [] });

  const state = workState({ matterToken: "M-UNBOUND" });
  await simulateWorkSave(world, state);
  assert.strictEqual(state.matterId, undefined, "an unresolvable token never becomes a Matter identity");
  assert.strictEqual(state.matterIdUnresolved, true, "the miss is remembered");
  assert.strictEqual(world.kv.get(`${MATTER_CURRENT_WORK_PREFIX}M-UNBOUND`), undefined, "no key is ever built from a token");

  const before = mock.calls.filter((c) => c.url.includes("/data_sources/matters-ds/query")).length;
  await simulateWorkSave(world, state);
  const after = mock.calls.filter((c) => c.url.includes("/data_sources/matters-ds/query")).length;
  assert.strictEqual(after, before, "a permanently unresolvable token is queried once, never on every save");
});

test("Matter argument parsing accepts a token or a page id and refuses anything else", () => {
  assert.deepStrictEqual(parseMatterArgument(" mat-20 "), { kind: "token", token: "MAT-20" });
  assert.deepStrictEqual(parseMatterArgument(MATTER_A), { kind: "page_id", matterId: MATTER_A });
  assert.deepStrictEqual(parseMatterArgument("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), { kind: "page_id", matterId: "aaaaaaaabbbbccccddddeeeeeeeeeeee" });
  assert.strictEqual(parseMatterArgument("").kind, "invalid");
  assert.strictEqual(parseMatterArgument("Acme Co").kind, "invalid");
  assert.strictEqual(parseMatterArgument("/sessions").kind, "invalid");
});

// ---------------------------------------------------------------------------
// Convergence: Matter Continue enters the EXISTING Work resume/routing
// path (src/workContinuation.ts, used by routeIncomingText's association
// blocks and /sessions switching) -- not a Matter-specific engine.
// ---------------------------------------------------------------------------

test("A. Matter Continue: MAT-A -> WORK-A -> the existing resume/routing machinery", async (t) => {
  const world = fakeWorld();
  mockNotion(t);
  const state = workState({ matterId: MATTER_A, awaiting: "proposal_feedback" });
  await simulateWorkSave(world, state);

  const continued = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(continued.ok, `expected a continuation: ${!continued.ok ? continued.reason : ""}`);
  assert.strictEqual(continued.workId, state.workId, "the Matter resolved exactly the Work that exists for it");
  assert.strictEqual(continued.state, world.works.get(state.workId), "the WorkSession's own WorkState -- the same object, not a copy and not a new session");
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), state.workId, "this interaction's local pointer now names that Work");

  // The next typed reply is taken by routeIncomingText's pre-existing
  // association step and routed into the Work's own awaiting handler --
  // exactly what an active-pointer or reply-to-message continuation does.
  await routeIncomingText(world.env, 9999, "yes, go ahead", 100);
  assert.deepStrictEqual(world.textReplies, [{ workId: state.workId, text: "yes, go ahead" }], "the reply reached the Work's own handler");
  assert.strictEqual(world.works.size, 1, "continuing never creates a second Work");
});

test("B. no active pointer required: Matter A continues WORK-A when active:<chat>:<thread> does not exist", async (t) => {
  const world = fakeWorld();
  mockNotion(t);
  const state = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, state);
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), null, "nothing points at this Work yet");

  const continued = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(continued.ok, `active: must not be a precondition: ${!continued.ok ? continued.reason : ""}`);
  assert.strictEqual(continued.workId, state.workId);
});

test("C. Matter switching: A -> B -> A continues each Matter's own Work, and A's target never changed", async (t) => {
  const world = fakeWorld();
  mockNotion(t);
  const workA = workState({ matterId: MATTER_A });
  const workB = workState({ matterId: MATTER_B });
  await simulateWorkSave(world, workA);
  await simulateWorkSave(world, workB);

  for (const [matter, workId] of [
    [MATTER_A, workA.workId],
    [MATTER_B, workB.workId],
    [MATTER_A, workA.workId],
  ] as const) {
    const continued = await continueMatterWork(world.env, 9999, 100, matter);
    assert.ok(continued.ok, `${matter}: ${!continued.ok ? continued.reason : ""}`);
    assert.strictEqual(continued.workId, workId, `${matter} must always continue its own Work`);
    assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), workId, "the interaction pointer follows the choice; it does not decide it");
  }
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), workA.workId, "selecting Matter B did not change Matter A's continuation target");
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_B)), workB.workId);
  assert.strictEqual(world.works.size, 2, "no Work is created by switching");
});

test("D. pointer independence: active: names WORK-B, selecting Matter A still continues WORK-A", async (t) => {
  const world = fakeWorld();
  mockNotion(t);
  const workA = workState({ matterId: MATTER_A });
  const workB = workState({ matterId: MATTER_B });
  await simulateWorkSave(world, workA);
  await simulateWorkSave(world, workB);
  await setActiveWorkId(world.env, 9999, 100, workB.workId);
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), workB.workId, "the interaction-local pointer names another Work");

  const continued = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(continued.ok, `expected a continuation: ${!continued.ok ? continued.reason : ""}`);
  assert.strictEqual(continued.workId, workA.workId, "matter_current_work decides; active: is never consulted and never overrides it");
});

test("E. convergence: Matter Continue, active: continuation and /sessions switching share one resume implementation", async (t) => {
  const world = fakeWorld();
  mockNotion(t);
  const state = workState({ matterId: MATTER_A, awaiting: "proposal_feedback" });
  await simulateWorkSave(world, state);

  // 1. Matter Continue enters the shared path and claims this interaction.
  const continued = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(continued.ok, `expected a continuation: ${!continued.ok ? continued.reason : ""}`);
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), state.workId);

  // 2. The exact call routeIncomingText's active-pointer/reply association
  //    makes takes the reply into the Work's own handler...
  const viaShared = await continueExistingWork(world.env, 9999, 100, state.workId, "that works for me");
  assert.strictEqual(viaShared.kind, "continued", "the shared path routes an awaiting Work's reply");
  assert.deepStrictEqual(world.textReplies, [{ workId: state.workId, text: "that works for me" }]);

  // 3. ...and the resume announcement is one shared helper, so switching
  //    and Matter Continue can never diverge in resume behaviour.
  const pendingState: WorkState = {
    ...state,
    pendingActionSummary: {
      label: "Opportunity: Acme Co",
      message: "Approve this quote?",
      createdAt: state.createdAt,
      buttons: [[{ text: "Approve", callback_data: "quote:abc:approve" }]],
    },
  };
  const notice = resumeNotice(pendingState, `Switched active context to work item ${state.workId}.`);
  assert.strictEqual(notice.text, "Re-sending pending approval:\n\nApprove this quote?", "the exact original approval text is re-sent");
  assert.deepStrictEqual(notice.buttons, pendingState.pendingActionSummary!.buttons, "with its original buttons");
  assert.strictEqual(resumeNotice(state, `Switched active context to work item ${state.workId}.`).text, `Switched active context to work item ${state.workId}.`);
});

test("H. terminal/stale Matter pointer refuses cleanly through Matter Continue and manufactures no Work", async (t) => {
  const world = fakeWorld();
  mockNotion(t);

  // Pointer references a Work that no longer exists.
  world.kv.set(matterCurrentWorkKey(MATTER_A), "ghost-work");
  const missing = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(!missing.ok, "a stale pointer must refuse");
  assert.match(missing.reason, /no longer exists/);
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), null, "a refused continuation claims nothing for the interaction");
  assert.strictEqual(world.works.size, 0, "no replacement Work is manufactured");

  // Pointer references a terminal Work.
  const completed = workState({ matterId: MATTER_A, stage: "complete" });
  world.works.set(completed.workId, completed);
  world.kv.set(matterCurrentWorkKey(MATTER_A), completed.workId);
  const terminal = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(!terminal.ok, "a terminal Work must refuse");
  assert.match(terminal.reason, /already complete/);
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), null, "still claims nothing");
  assert.strictEqual(world.works.size, 1, "nothing was created to satisfy the pointer");

  // Identity inconsistency: the pointed Work records another Matter.
  const otherMatter = workState({ matterId: MATTER_B });
  world.works.set(otherMatter.workId, otherMatter);
  world.kv.set(matterCurrentWorkKey(MATTER_A), otherMatter.workId);
  const inconsistent = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(!inconsistent.ok, "an inconsistent identity must refuse");
  assert.match(inconsistent.reason, /different Matter/);
});

test("I. ambiguous resumable Works fail closed through Matter Continue -- never newest, oldest or first", async (t) => {
  const world = fakeWorld();
  mockNotion(t);
  const first = workState({ matterId: MATTER_A });
  const second = workState({ matterId: MATTER_A });
  await simulateWorkSave(world, first);
  await simulateWorkSave(world, second);
  world.kv.delete(matterCurrentWorkKey(MATTER_A)); // the pointer itself is lost while both stay resumable

  const refused = await continueMatterWork(world.env, 9999, 100, MATTER_A);
  assert.ok(!refused.ok, "several candidates with no lifecycle rule is a guess, and guesses are refused");
  assert.match(refused.reason, /2 resumable Works.*refusing to guess/);
  assert.strictEqual(world.kv.get(matterCurrentWorkKey(MATTER_A)), undefined, "the refusal does not pick one and write it down");
  assert.strictEqual(await getActiveWorkId(world.env, 9999, 100), null, "and claims no interaction");
  assert.strictEqual(world.works.size, 2, "nothing was created");
});

// ---------------------------------------------------------------------------
// Source contracts: production wiring that tests cannot import (session.ts's
// Durable Object) and the user entry point (index.ts), asserted the same way
// actionSkills.test.ts pins the pickup wiring.
// ---------------------------------------------------------------------------

test("wiring: one shared Work resume path, Matter contributing only resolution, raw pointer keys confined to matterContinuation.ts", () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), "utf8");
  const session = read("./session.ts");
  assert.ok(session.includes("await ensureMatterIdentity(this.env, state)"), "save() derives the Matter identity before persisting");
  assert.ok(
    session.includes("await syncMatterContinuationPointer(this.env, state, isTerminal)"),
    "updateRegistry syncs the pointer from the index state that save just wrote",
  );
  assert.ok(session.indexOf("await this.ctx.storage.put(\"state\", state)") > session.indexOf("await ensureMatterIdentity(this.env, state)"), "identity is derived before the state is persisted");
  assert.ok(session.includes("matterId: state.matterId"), "sessions_index summaries carry matterId so resumability is readable without opening every WorkSession");

  // ONE resume implementation. Outside the WorkSession itself, the Work's
  // own awaiting handler is invoked from exactly one file -- the shared
  // path every workId-discovering entry point funnels through.
  const sources: Array<{ name: string; full: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sources.push({ name: entry.name, full, text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(import.meta.dirname);

  assert.deepStrictEqual(
    sources.filter((s) => s.text.includes("handleTextReply(")).map((s) => s.name).sort(),
    ["session.ts", "workContinuation.ts"],
    "the Work's resume/routing entry is called only by the shared path",
  );
  assert.ok(read("./workContinuation.ts").includes("stub.handleTextReply(text)"), "…which routes the reply through the Work's own recorded Action");

  // Every entry that discovers a workId -- however it discovered it -- goes
  // through that one path.
  const router = read("./router.ts");
  assert.ok(
    (router.match(/continueExistingWork\(/g) ?? []).length >= 2,
    "routeIncomingText's reply association AND its active-pointer association both go through the shared path",
  );
  const index = read("./index.ts");
  assert.ok(index.includes("await continueExistingWork(env, chatId, threadId, workId)"), "/sessions switching goes through the shared path");
  assert.ok((index.match(/resumeNotice\(/g) ?? []).length >= 2, "switching and Matter Continue share the one resume announcement");
  assert.ok(index.includes("await continueMatterWork(env, chatId, threadId, target)"), "the user-facing /continue command enters through continueMatterWork");
  assert.ok(index.includes("/continue"), "the user-facing entry command exists");
  assert.ok(index.includes("MATTER_CURRENT_WORK_PREFIX"), "/clearsessions still enumerates the pointer keys");

  // Matter stops at the workId: no Unit/Hat/action resolution exists here.
  const matter = read("./matterContinuation.ts");
  assert.ok(
    matter.includes("await continueExistingWork(env, chatId, threadId, resolved.workId)"),
    "Matter resolution hands the resolved workId to the shared Work path and stops",
  );
  assert.ok(matter.includes("await setActiveWorkId(env, chatId, threadId, validated.workId)"), "…after which this interaction's local pointer converges on that Work");
  for (const forbidden of ["resolveAwaitingHandler", "findUnitManifest", "handleTextReply", "handleCallback", "runUnderRecordedSkills"]) {
    assert.ok(!matter.includes(forbidden), `matterContinuation.ts must not re-implement ${forbidden} -- it answers only "which Work?"`);
  }

  // No matter_current_work key is ever *constructed* outside the module --
  // prose mentions of the pointer (comments/docs) are fine, a quoted
  // literal prefix is not.
  // A construction, not a mention: a quoted prefix that opens/closes the
  // string or immediately injects into it (doc code spans like
  // `matter_current_work:<matterId>` are prose and are not matched).
  const rawKey = /[`'"]matter_current_work:(?:\$\{|[`'"])/;
  const offenders = sources
    .filter(
      (s) =>
        s.full !== path.join(import.meta.dirname, "matterContinuation.ts") &&
        // The §5B KV-classification registry (kvStore.ts) names every
        // fallback-eligible key prefix in its allowlist by design --
        // including this pointer's prefix. It never constructs, reads or
        // writes a specific pointer key: it classifies strings by prefix
        // generically, like every other key class in that list.
        s.full !== path.join(import.meta.dirname, "kvStore.ts") &&
        rawKey.test(s.text),
    )
    .map((s) => s.full);
  assert.deepStrictEqual(offenders, [], "the pointer key is constructed only by matterCurrentWorkKey");
});
