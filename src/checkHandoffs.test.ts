/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { runCheckHandoffs, maybeAutoContinueCheckHandoffs, discoverPendingSalesHandoffs, discoverPendingStrategyHandoffs } from "./checkHandoffs";
import { ensureMatterIdentity, isTerminalWorkStage, matterCurrentWorkKey, syncMatterContinuationPointer } from "./matterContinuation";
import type { Env, WorkState } from "./types";

/** Canonical Matter page ids the mocks resolve their Handoff's Matter_Token to (32-hex, as real Notion page ids are). */
const SALES_MATTER_PAGE_ID = "cccccccccccccccccccccccccccccccc";
const STRATEGY_MATTER_PAGE_ID = "dddddddddddddddddddddddddddddddd";

/**
 * Answers the canonical MATTERS_DATA_SOURCE_ID query exactly the way
 * `resolveMatterIdFromToken` reads it: unique_id number match -> the Matter
 * page with its required Entity relation, or no results at all.
 */
function mattersQueryResponse(body: string, resolvable: Array<{ number: number; id: string }>): Response {
  const number = JSON.parse(body).filter?.unique_id?.equals;
  const match = resolvable.find((m) => m.number === number);
  if (!match) return new Response(JSON.stringify({ results: [] }), { status: 200 });
  return new Response(
    JSON.stringify({
      results: [
        {
          id: match.id,
          url: `https://notion.so/${match.id}`,
          properties: {
            Matter_ID: { unique_id: { prefix: "MAT", number: match.number } },
            Entity: { relation: [{ id: "entity-page-1" }] },
          },
        },
      ],
    }),
    { status: 200 },
  );
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    // Mirrors real Cloudflare KV's own hard minimum -- confirmed live:
    // "KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL
    // must be at least 60." This mock previously accepted any TTL
    // silently, which is exactly why AUTO_CHECKHANDOFFS_GUARD_TTL_SECONDS
    // being set to 30 was never caught by a test.
    put: async (key: string, val: string, opts?: { expirationTtl?: number }) => {
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error(`KV PUT failed: 400 Invalid expiration_ttl of ${opts.expirationTtl}. Expiration TTL must be at least 60.`);
      }
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string } = {}) => {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true, cursor: undefined } as any;
    },
    store,
  };
}

function fakeEnv(kv = fakeKv()): Env & { STATE_KV: ReturnType<typeof fakeKv> } {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: kv,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
  } as any;
}

/** Mocks Notion (always "no pending Handoffs") + Telegram (always succeeds), and counts calls made to each. */
function mockFetch(t: any): { notionCalls: number; telegramCalls: number } {
  const originalFetch = globalThis.fetch;
  const counts = { notionCalls: 0, telegramCalls: 0 };
  globalThis.fetch = (async (url: string) => {
    const urlStr = String(url);
    if (urlStr.includes("api.notion.com")) {
      counts.notionCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      counts.telegramCalls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return counts;
}

test("runCheckHandoffs (manual, no opts): runs discovery and replies, exactly the existing /checkhandoffs behavior", async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await runCheckHandoffs(env, 12345, undefined);
  assert.ok(counts.notionCalls > 0, "discovery must query Notion");
  assert.ok(counts.telegramCalls > 0, "a reply must be sent");
});

test("runCheckHandoffs (auto:true): runs normally when no other automatic invocation is in flight", async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await runCheckHandoffs(env, 12345, undefined, { source: "runtime_auto" });
  assert.ok(counts.notionCalls > 0, "discovery must still run");
});

test("runCheckHandoffs (auto:true): recursion guard -- a second automatic invocation while one is already in flight is skipped", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  // Simulate an automatic invocation already in flight (the guard key set,
  // as runCheckHandoffs itself would leave it mid-execution).
  await env.STATE_KV.put("checkhandoffs_auto_inflight", "1");

  const counts2 = mockFetch(t); // fresh counter after the guard is seeded
  await runCheckHandoffs(env, 12345, undefined, { source: "runtime_auto" });
  assert.strictEqual(counts2.notionCalls, 0, "a second automatic invocation must not run discovery while one is already in flight");
  assert.strictEqual(counts2.telegramCalls, 0, "a second automatic invocation must not send any reply either");
});

test("runCheckHandoffs (auto:true): clears its own in-flight guard once finished, so the next automatic invocation can run", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  await runCheckHandoffs(env, 12345, undefined, { source: "runtime_auto" });
  const stillSet = await env.STATE_KV.get("checkhandoffs_auto_inflight");
  assert.strictEqual(stillSet, null, "the guard must be cleared after the automatic run completes");
});

test("runCheckHandoffs (auto:true / notion_webhook): the in-flight guard's own KV write uses a TTL Cloudflare KV actually accepts (>= 60s) -- regression for a live failure where every guarded run threw before discovery ever ran", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(
    () => runCheckHandoffs(env, 12345, undefined, { source: "runtime_auto" }),
    "the guard KV write must never throw due to an invalid TTL",
  );
  await assert.doesNotReject(
    () => runCheckHandoffs(env, Number(env.MARTIN_TELEGRAM_USER_ID), undefined, { source: "notion_webhook" }),
    "the guard KV write must never throw due to an invalid TTL",
  );
});

test("runCheckHandoffs (manual, no auto): ignores the automatic-invocation guard entirely -- Martin can always run the command directly", async (t) => {
  const env = fakeEnv();
  await env.STATE_KV.put("checkhandoffs_auto_inflight", "1");
  const counts = mockFetch(t);
  await runCheckHandoffs(env, 12345, undefined); // no opts.auto
  assert.ok(counts.notionCalls > 0, "a manual invocation must never be blocked by the automatic-invocation guard");
});

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-1",
    chatId: 12345,
    stage: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("maybeAutoContinueCheckHandoffs: no-op when pendingHandoffAutoCheck is unset -- the overwhelming majority of calls", async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await maybeAutoContinueCheckHandoffs(env, 12345, undefined, fakeState());
  assert.strictEqual(counts.notionCalls, 0, "no discovery must run when the flag isn't set");
  assert.strictEqual(counts.telegramCalls, 0);
});

test("maybeAutoContinueCheckHandoffs: no-op when state is null/undefined (e.g. work item no longer exists)", async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await maybeAutoContinueCheckHandoffs(env, 12345, undefined, undefined);
  await maybeAutoContinueCheckHandoffs(env, 12345, undefined, null);
  assert.strictEqual(counts.notionCalls, 0);
});

test("maybeAutoContinueCheckHandoffs: triggers the checkhandoffs continuation when pendingHandoffAutoCheck is true -- successful Handoff creation automatically invokes the existing /checkhandoffs path", async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await maybeAutoContinueCheckHandoffs(env, 12345, undefined, fakeState({ pendingHandoffAutoCheck: true }));
  assert.ok(counts.notionCalls > 0, "discovery must run once the flag is set");
});

test("maybeAutoContinueCheckHandoffs: uses the exact chatId/threadId passed in -- same WorkSession/conversation context as the Handoff that was just created", async (t) => {
  const originalFetch = globalThis.fetch;
  let telegramChatId: number | undefined;
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes("api.notion.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      telegramChatId = body.chat_id;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (init?.method === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // threadId undefined resolves to the "dm" stream, whose existing
  // /checkhandoffs behavior is to reply via the cross-Unit Operations
  // summary rather than back to chatId directly -- give it a thread mapped
  // to a real Unit (Finance) instead, so the per-Unit reply-in-thread
  // branch (which does reply to chatId) is exercised.
  const env = fakeEnv();
  (env as any).UNIT_TOPIC_MAP = JSON.stringify({ Finance: 42 });
  await maybeAutoContinueCheckHandoffs(env, 777888, 42, fakeState({ pendingHandoffAutoCheck: true }));
  assert.strictEqual(telegramChatId, 777888, "the reply must go to the exact same chat the Handoff confirmation was sent to");
});

test("maybeAutoContinueCheckHandoffs: does not throw even if the continuation itself fails -- a failure there must never break the caller's own flow", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated Notion outage");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  await assert.doesNotReject(() => maybeAutoContinueCheckHandoffs(env, 12345, undefined, fakeState({ pendingHandoffAutoCheck: true })));
});

// --- source: "notion_webhook" ---------------------------------------------

test('runCheckHandoffs source "notion_webhook": runs discovery but sends no synthetic Telegram summary reply', async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await runCheckHandoffs(env, Number(env.MARTIN_TELEGRAM_USER_ID), undefined, { source: "notion_webhook" });
  assert.ok(counts.notionCalls > 0, "discovery must still run for a webhook-triggered sweep");
  assert.strictEqual(counts.telegramCalls, 0, "no /checkhandoffs summary message may be sent for a webhook-triggered sweep");
});

test('runCheckHandoffs source "notion_webhook": shares the recursion guard with runtime_auto -- an overlapping webhook sweep is skipped', async (t) => {
  const env = fakeEnv();
  await env.STATE_KV.put("checkhandoffs_auto_inflight", "1");
  const counts = mockFetch(t);
  await runCheckHandoffs(env, Number(env.MARTIN_TELEGRAM_USER_ID), undefined, { source: "notion_webhook" });
  assert.strictEqual(counts.notionCalls, 0, "a webhook sweep must not run discovery while a background sweep is already in flight");
});

test('runCheckHandoffs source "notion_webhook": failures are logged, never turned into a synthetic Telegram message', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.notion.com")) throw new Error("simulated Notion outage");
    if (url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = fakeEnv();
  await assert.doesNotReject(() => runCheckHandoffs(env, Number(env.MARTIN_TELEGRAM_USER_ID), undefined, { source: "notion_webhook" }));
});

test("17. Manual /checkhandoffs behavior remains unchanged (default source)", async (t) => {
  const counts = mockFetch(t);
  const env = fakeEnv();
  await runCheckHandoffs(env, 12345, undefined);
  assert.ok(counts.notionCalls > 0);
  assert.ok(counts.telegramCalls > 0, "manual invocation still replies, exactly as before this task");
});

// --- Sales external-Handoff detection (items 11-13) -----------------------

function createMockWorkSession() {
  const calls: { init: any[][]; schedulePickup: string[]; runTokenSafeProposal: number; runCallNotesPickup: number } = {
    init: [],
    schedulePickup: [],
    runTokenSafeProposal: 0,
    runCallNotesPickup: 0,
  };
  const stub = {
    init: async (...args: any[]) => {
      calls.init.push(args);
    },
    // Discovery must only ever RECORD the pickup kind here -- the actual
    // runner methods below stay as tripwires: any call to them directly
    // (the pre-alarm inline shape) fails the test.
    schedulePickup: async (kind: string) => {
      calls.schedulePickup.push(kind);
    },
    runTokenSafeProposal: async () => {
      calls.runTokenSafeProposal++;
    },
    runCallNotesPickup: async () => {
      calls.runCallNotesPickup++;
    },
  };
  return {
    calls,
    workSession: {
      idFromName: (name: string) => name,
      get: (_id: any) => stub,
    },
  };
}

function mockSalesHandoffFetch(t: any, extraProperties: Record<string, any> = {}) {
  const originalFetch = globalThis.fetch;
  const operationsMessages: string[] = [];
  const mattersQueries: string[] = [];
  const salesHandoff = {
    id: "handoff-sales-1",
    url: "https://notion.so/handoff-sales-1",
    properties: {
      // Destination facts every producer writes (valueBasedPricingAssessor
      // writes To Unit "Sales" + To Hat "Sales Executive") -- Organization
      // resolution consumes them rather than a hardcoded Hat.
      "To Unit": { select: { name: "Sales" } },
      "To Hat": { rich_text: [{ plain_text: "Sales Executive" }] },
      Matter_Token: { rich_text: [{ plain_text: "MAT-20" }] },
      Entity_Token: { rich_text: [{ plain_text: "E-20" }] },
      ...extraProperties,
    },
    archived: false,
  };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/data_sources/handoffs-ds/query")) {
      const body = JSON.parse(init.body);
      const toUnit = body.filter?.and?.find((f: any) => f.property === "To Unit")?.select?.equals;
      if (toUnit === "Sales") {
        return new Response(JSON.stringify({ results: [salesHandoff] }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("/data_sources/matters-ds/query")) {
      // The canonical Matter lookup behind resolveHandoffMatterIdentity:
      // MAT-20 resolves to SALES_MATTER_PAGE_ID, anything else does not.
      mattersQueries.push(urlStr);
      return mattersQueryResponse(String(init.body), [{ number: 20, id: SALES_MATTER_PAGE_ID }]);
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      if (body.text) operationsMessages.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (init?.method === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { operationsMessages, mattersQueries };
}

/** Modelled on mockSalesHandoffFetch, keyed to the Strategy discovery query. */
function mockStrategyHandoffFetch(t: any) {
  const originalFetch = globalThis.fetch;
  const strategyHandoff = {
    id: "handoff-strategy-1",
    url: "https://notion.so/handoff-strategy-1",
    properties: {
      "To Unit": { select: { name: "Strategy" } },
      "To Hat": { rich_text: [{ plain_text: "Strategy Analyst" }] },
      Matter_Token: { rich_text: [{ plain_text: "MAT-30" }] },
      Entity_Token: { rich_text: [{ plain_text: "E-30" }] },
    },
    archived: false,
  };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/data_sources/handoffs-ds/query")) {
      const body = JSON.parse(init.body);
      const toUnit = body.filter?.and?.find((f: any) => f.property === "To Unit")?.select?.equals;
      if (toUnit === "Strategy") {
        return new Response(JSON.stringify({ results: [strategyHandoff] }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("/data_sources/matters-ds/query")) {
      // MAT-30 resolves to STRATEGY_MATTER_PAGE_ID.
      return mattersQueryResponse(String(init.body), [{ number: 30, id: STRATEGY_MATTER_PAGE_ID }]);
    }
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (init?.method === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("11. Externally-created Sales Handoff without handoff_workitem is detected instead of skipped", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t);

  const scheduled = await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.init.length, 1, "a WorkSession must be registered for the externally-created Sales Handoff");
  // The Work's identity came from the Handoff's own destination FACTS
  // ("To Unit"/"To Hat") through Organization + Action Resolution -- not a
  // hardcoded Hat: Sales owns two Hats and none was supplied by code.
  const [, , initUnit, initHat, , initExtra] = calls.init[0];
  assert.strictEqual(initUnit, "Sales");
  assert.strictEqual(initHat, "Sales Executive", "the destination To Hat fact resolved the Hat");
  assert.strictEqual(initExtra?.actionName, "proposal_draft", "Action Resolution picked the pickup Action by declared applicability");
  const mapped = await env.STATE_KV.get("handoff_workitem:handoff-sales-1");
  assert.ok(mapped, "handoff_workitem mapping must be recorded so the Handoff is discoverable next time too");
  assert.strictEqual(scheduled, 0, "detection/registration is not counted as a scheduled pickup -- no pickup was scheduled and no identity-sensitive execution happened");
});

test("12. External Sales detection does not execute identity-sensitive Sales work automatically", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.runTokenSafeProposal, 0, "Sales Executive's own AI-driven work must never run automatically from detection alone");
  assert.strictEqual(calls.runCallNotesPickup, 0, "Sales Executive's own AI-driven work must never run automatically from detection alone");
});

test("13. Operations notification is generated for a newly detected Sales Handoff", async (t) => {
  const { workSession } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);

  const readyMessage = operationsMessages.find((m) => m.includes("SALES HANDOFF READY"));
  assert.ok(readyMessage, "an Operations notification must be sent for a newly detected Sales Handoff");
  assert.match(readyMessage!, /MAT-20/);
  assert.match(readyMessage!, /Open the Sales Executive workspace/i);
});

test("20. Sales Handoff ready notification never contains real Entity identity -- only the opaque Matter_Token/Handoff id", async (t) => {
  const { workSession } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);

  const readyMessage = operationsMessages.find((m) => m.includes("SALES HANDOFF READY"))!;
  assert.ok(readyMessage);
  assert.ok(!readyMessage.includes("@"), "no email-shaped content should ever appear in this notification");
  assert.match(readyMessage, /MAT-20/, "only the opaque Matter_Token identifies the Matter");
});

test("Sales Handoff ready notification is sent once per Handoff, not on every discovery tick (dedup)", async (t) => {
  const { workSession } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);
  await discoverPendingSalesHandoffs(env, true);

  const readyMessages = operationsMessages.filter((m) => m.includes("SALES HANDOFF READY"));
  assert.strictEqual(readyMessages.length, 1, "the same pending Sales Handoff must not re-notify Operations on every tick");
});

const FINANCE_ORIGIN = {
  "From Unit": { select: { name: "Finance" } },
  "From Hat": { rich_text: [{ plain_text: "Value-Based Pricing Assessor" }] },
};

test("Paused: a Finance -> Sales Handoff follows the existing paused behaviour -- registered, Operations notified, left Pending, no Proposal flow", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t, FINANCE_ORIGIN);

  const scheduled = await discoverPendingSalesHandoffs(env, true);

  assert.deepStrictEqual(calls.schedulePickup, [], "no pickup kind may be scheduled while Sales is paused");
  assert.strictEqual(calls.runTokenSafeProposal, 0, "the token-safe Proposal flow must not run inline while Sales is paused");
  assert.strictEqual(scheduled, 0);
  assert.ok(operationsMessages.some((m) => m.includes("SALES HANDOFF READY")), "the existing paused notification is sent");
  // The mocked fetch throws on anything but the discovery query and Telegram,
  // so reaching here also proves no Handoff status write (it stays Pending).
});

test("Not paused: a Finance -> Sales Handoff runs the token-safe Proposal flow instead of the old drafting path", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t, FINANCE_ORIGIN);

  const scheduled = await discoverPendingSalesHandoffs(env, false);

  assert.deepStrictEqual(calls.schedulePickup, ["sales_proposal"], "discovery must schedule the Proposal pickup, not run it inline");
  assert.strictEqual(calls.runTokenSafeProposal, 0, "the runner itself is invoked only by the DO alarm, never by discovery");
  assert.strictEqual(scheduled, 1);
  assert.ok(!operationsMessages.some((m) => m.includes("SALES HANDOFF READY")));
});

test("Not paused: a non-Finance Sales Handoff routes to the token-safe Proposal flow", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t, { "From Unit": { select: { name: "Strategy" } }, "From Hat": { rich_text: [{ plain_text: "Strategy Analyst" }] } });

  await discoverPendingSalesHandoffs(env, false);

  assert.deepStrictEqual(calls.schedulePickup, ["sales_proposal"]);
  assert.strictEqual(calls.runTokenSafeProposal, 0, "the runner itself is invoked only by the DO alarm, never by discovery");
});

test("A non-Finance Sales Handoff keeps the existing paused behaviour (detect + notify only)", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t, { "From Unit": { select: { name: "Strategy" } }, "From Hat": { rich_text: [{ plain_text: "Strategy Analyst" }] } });

  await discoverPendingSalesHandoffs(env, true);

  assert.deepStrictEqual(calls.schedulePickup, [], "nothing may be scheduled while Sales is paused");
  assert.strictEqual(calls.runTokenSafeProposal, 0);
  assert.ok(operationsMessages.some((m) => m.includes("SALES HANDOFF READY")));
});

// --- Call-notes Handoff detection (isCallNotesHandoff) --------------------
//
// Reason is free text a Claude session composes itself -- HO-69, a real
// Handoff created by the isolated Sales Executive project, opened with
// "requiredCategory: call_notes. De-identified call notes bundle..."
// rather than the literal example phrase Section 6A's instructions gave.
// These tests pin detection to the requiredCategory marker itself, not to
// any particular surrounding wording, so this doesn't silently regress
// again.

test("Not paused: a call-notes Handoff (requiredCategory: call_notes) runs the call-notes pickup flow, not the old drafting path", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t, {
    Reason: {
      rich_text: [{ plain_text: "Call Notes (Matter: MAT-20). requiredCategory: call_notes. De-identified call notes bundle prepared per Section 6A." }],
    },
  });

  const scheduled = await discoverPendingSalesHandoffs(env, false);

  assert.deepStrictEqual(calls.schedulePickup, ["sales_call_notes"], "discovery must schedule the call-notes pickup, not run it inline");
  assert.strictEqual(calls.runCallNotesPickup, 0, "the runner itself is invoked only by the DO alarm, never by discovery");
  assert.strictEqual(calls.runTokenSafeProposal, 0);
  assert.strictEqual(scheduled, 1);
});

test("Detection matches on free-text Reason wording, not just the literal opening phrase -- regression test for HO-69's actual wording", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t, {
    Reason: {
      rich_text: [
        {
          plain_text:
            "requiredCategory: call_notes. De-identified call notes bundle for MAT-20, prepared per Section 6A. Source: user-supplied transcript in place of a Read.ai connector pull.",
        },
      ],
    },
  });

  await discoverPendingSalesHandoffs(env, false);

  assert.deepStrictEqual(calls.schedulePickup, ["sales_call_notes"], "must still schedule call-notes pickup even without the literal 'Call Notes (Matter:' opening phrase");
  assert.strictEqual(calls.runCallNotesPickup, 0, "the runner itself is invoked only by the DO alarm, never by discovery");
});

test("Detection matches the marker in the Handoff title when Reason doesn't carry it -- regression test for HO-73's actual shape (marker only in the title, Reason free of it entirely)", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t, {
    Handoff: { title: [{ plain_text: "Call notes: ENT-21 / MAT-21 for qualification review [requiredCategory: call_notes]" }] },
    Reason: {
      rich_text: [
        { plain_text: "Sales call completed with the client for MAT-21. Delegating commercial qualification reasoning to Runtime Sales Executive per the Sales/Runtime split, since this isolated environment does not perform qualification reasoning." },
      ],
    },
  });

  await discoverPendingSalesHandoffs(env, false);

  assert.deepStrictEqual(calls.schedulePickup, ["sales_call_notes"], "must schedule call-notes pickup when the marker is only in the title, not Reason");
  assert.strictEqual(calls.runCallNotesPickup, 0, "the runner itself is invoked only by the DO alarm, never by discovery");
});

test("Paused: a call-notes Handoff follows the existing paused behaviour (detect + notify only, no pickup)", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t, {
    Reason: { rich_text: [{ plain_text: "Call Notes (Matter: MAT-20). requiredCategory: call_notes." }] },
  });

  const scheduled = await discoverPendingSalesHandoffs(env, true);

  assert.deepStrictEqual(calls.schedulePickup, [], "no call-notes pickup may be scheduled automatically while Sales is paused");
  assert.strictEqual(calls.runCallNotesPickup, 0, "call-notes pickup must not run automatically while Sales is paused");
  assert.strictEqual(scheduled, 0);
  assert.ok(operationsMessages.some((m) => m.includes("SALES HANDOFF READY")));
});

// --- Alarm-scheduled pickup -------------------------------------------------
//
// Discovery never awaits a Unit's pickup inline anymore: it RECORDS the
// pickup kind on the WorkSession and arms its Durable Object alarm (the
// webhook's ctx.waitUntil window is cancelled ~30 s after the response and
// used to cut short exactly the long AI pickups). The runner methods live
// on WorkSession, which tests cannot import (`cloudflare:workers` is not
// resolvable under the node test runner), so the mock stub below simply
// provides NO runner methods at all: any regression back to an inline call
// would throw a TypeError inside discovery and these assertions would fail.

test("discoverPendingStrategyHandoffs schedules pickup on the WorkSession alarm instead of running runStrategyPickup inline", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockStrategyHandoffFetch(t);

  const scheduled = await discoverPendingStrategyHandoffs(env);

  assert.strictEqual(calls.init.length, 1, "a WorkSession must be created for the externally-created Strategy Handoff");
  // Same new-Work Matter boundary as the other Units: the Handoff's own
  // Matter_Token (MAT-30) is resolved to its canonical page id first.
  assert.strictEqual(calls.init[0][5]?.matterToken, "MAT-30");
  assert.strictEqual(calls.init[0][5]?.matterId, STRATEGY_MATTER_PAGE_ID, "the new Strategy Work is born with the canonical Matter identity");
  assert.deepStrictEqual(calls.schedulePickup, ["strategy"], "discovery must record exactly one scheduled strategy pickup kind");
  assert.strictEqual(scheduled, 1, "a successfully scheduled pickup counts exactly as before -- once per Handoff");
  const mapped = await env.STATE_KV.get("handoff_workitem:handoff-strategy-1");
  assert.ok(mapped, "handoff_workitem mapping must be recorded before scheduling, exactly as before");
});

// ---------------------------------------------------------------------------
// Matter identity at the ONE boundary that creates a Work from a Handoff:
//
//   Handoff.Matter_Token -> resolveMatterIdFromToken (canonical, existing)
//   -> WorkSession.init(matterId, matterToken) -> WorkState
//   -> sessions_index -> existing syncMatterContinuationPointer
//      -> matter_current_work:<matterPageId>
//
// plus the two things this boundary must NOT touch: Work creation from any
// other source, and same-Work Handoff pickup.
// ---------------------------------------------------------------------------

/**
 * Mirrors WorkSession.save -> updateRegistry's exact ordering (derive Matter
 * identity, persist, write the summary, then sync the pointer) so the
 * production save path is exercised the way it drives this seeded identity.
 * session.ts cannot be imported under the node test runner (its
 * `cloudflare:workers` import), so its wiring is pinned separately by the
 * source contract at the bottom of this file -- same convention as
 * matterContinuation.test.ts's simulateWorkSave.
 */
async function saveLikeProduction(env: Env, state: WorkState): Promise<void> {
  await ensureMatterIdentity(env, state);
  const isTerminal = isTerminalWorkStage(state.stage);
  const raw = await env.STATE_KV.get("sessions_index");
  const index = raw ? JSON.parse(raw) : [];
  const summary = {
    workId: state.workId,
    unit: state.unit,
    hat: state.hat,
    stage: state.stage,
    label: state.workId,
    updatedAt: state.updatedAt,
    matterId: state.matterId,
  };
  const withoutSelf = index.filter((s: any) => s.workId !== state.workId);
  await env.STATE_KV.put("sessions_index", JSON.stringify(isTerminal ? withoutSelf : [...withoutSelf, summary]));
  await syncMatterContinuationPointer(env, state, isTerminal);
}

function pointerKeys(env: ReturnType<typeof fakeEnv>): string[] {
  return Array.from(env.STATE_KV.store.keys()).filter((k) => k.startsWith("matter_current_work:"));
}

test("A. a Handoff's Matter_Token resolves to its canonical Matter page id and seeds the new Work at init", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.init.length, 1, "one Work is created for the externally-created Handoff");
  const [, , initUnit, initHat, , initExtra] = calls.init[0];
  assert.strictEqual(initUnit, "Sales");
  assert.strictEqual(initHat, "Sales Executive");
  assert.strictEqual(initExtra?.handoffId, "handoff-sales-1");
  assert.strictEqual(initExtra?.matterToken, "MAT-20", "the identity comes from the Handoff's own Matter_Token fact");
  assert.strictEqual(
    initExtra?.matterId,
    SALES_MATTER_PAGE_ID,
    "resolved to the canonical page id by the existing unique_id + Entity-relation lookup -- never inferred from a label, title, Entity data or Handoff ordering",
  );
});

test("B+C. the seeded identity reaches sessions_index and the existing save path establishes matter_current_work", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { mattersQueries } = mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);
  const [, , unit, hat, , initExtra] = calls.init[0];

  // Exactly the WorkState WorkSession.init builds from that extra and hands
  // straight to save() -- the state this Work exists with from its first save.
  const state = {
    workId: `work-${initExtra.handoffId}`,
    chatId: Number(env.MARTIN_TELEGRAM_USER_ID),
    unit,
    hat,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: initExtra.handoffId,
    matterId: initExtra.matterId,
    matterToken: initExtra.matterToken,
    actionName: initExtra.actionName,
  } as WorkState;

  const before = mattersQueries.length;
  await saveLikeProduction(env, state);

  const raw = await env.STATE_KV.get("sessions_index");
  assert.ok(raw, "the Work is registered in sessions_index");
  const index = JSON.parse(raw);
  assert.strictEqual(index.length, 1);
  assert.strictEqual(index[0].matterId, SALES_MATTER_PAGE_ID, "the Work summary carries the Matter id, so resumability is readable from the index");
  assert.strictEqual(
    await env.STATE_KV.get(matterCurrentWorkKey(SALES_MATTER_PAGE_ID)),
    state.workId,
    "and therefore the existing syncMatterContinuationPointer establishes the Matter -> current Work pointer -- no new write path",
  );
  assert.strictEqual(state.matterId, SALES_MATTER_PAGE_ID, "identity was seeded at creation, so save has nothing left to derive");
  assert.strictEqual(mattersQueries.length, before, "no second Matter lookup was needed");
});

test("D. a Handoff with no Matter_Token fails closed -- no Work, no mapping, no pointer", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages, mattersQueries } = mockSalesHandoffFetch(t, { Matter_Token: { rich_text: [] } });

  const scheduled = await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.init.length, 0, "a Work is never created without a canonical Matter");
  assert.strictEqual(await env.STATE_KV.get("handoff_workitem:handoff-sales-1"), null, "no handoff_workitem mapping claims it either");
  assert.strictEqual(scheduled, 0, "nothing is scheduled for a Handoff that could not be identified");
  assert.deepStrictEqual(pointerKeys(env), [], "no continuation pointer is written without a resolved Matter");
  assert.strictEqual(mattersQueries.length, 0, "an empty token is rejected before any lookup is made");
  assert.ok(
    operationsMessages.some((m) => m.includes("Automated pickup failed for Handoff handoff-sales-1")),
    "the refusal is reported through the existing discovery failure channel and the Handoff stays Pending",
  );
  assert.ok(!operationsMessages.some((m) => m.includes("SALES HANDOFF READY")), "a Handoff with no Matter identity is never announced as ready");
});

test("D2. a Matter_Token that does not resolve fails closed -- no falsely Matter-associated Work is created", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages, mattersQueries } = mockSalesHandoffFetch(t, {
    Matter_Token: { rich_text: [{ plain_text: "MAT-999" }] },
  });

  const scheduled = await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(mattersQueries.length, 1, "the canonical lookup ran");
  assert.strictEqual(calls.init.length, 0, "no result means no Work");
  assert.strictEqual(await env.STATE_KV.get("handoff_workitem:handoff-sales-1"), null, "and no mapping");
  assert.strictEqual(scheduled, 0);
  assert.deepStrictEqual(pointerKeys(env), [], "no pointer is invented for a token that resolves to nothing");
  assert.ok(operationsMessages.some((m) => m.includes("Automated pickup failed for Handoff handoff-sales-1")), "reported through the existing failure channel");
});

test("E. Work creation from any source other than a Handoff does not seed Matter identity -- unchanged by this boundary", () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), "utf8");

  // Direct-request / control-Work creation: untouched by this change.
  const router = read("./router.ts");
  assert.ok(!router.includes("matterId") && !router.includes("matterToken"), "router.ts's Work creation seeds no Matter identity");
  const google = read("./googleOAuth.ts");
  assert.ok(!google.includes("matterId") && !google.includes("matterToken"), "the standalone Google Workspace control Work seeds no Matter identity");

  // Only checkHandoffs' four new-Work sites seed, and all four of them do.
  const check = read("./checkHandoffs.ts");
  assert.strictEqual((check.match(/matterId: matter\.matterId/g) ?? []).length, 4, "Finance, Sales, Marketing and Strategy all seed the resolved Matter id");
  assert.strictEqual((check.match(/await stub\.init\(/g) ?? []).length, 4, "…across exactly the four init call sites this file has");

  // The WorkSession side: it persists what it is handed and derives nothing.
  const session = read("./session.ts");
  assert.ok(session.includes("...(extra?.matterId ? { matterId: extra.matterId } : {})"), "init persists the already-resolved matterId");
  assert.ok(session.includes("...(extra?.matterToken ? { matterToken: extra.matterToken } : {})"), "init persists the token that id was resolved from");
});

test("F. same-Work Handoff pickup is unchanged -- an existing handoff_workitem mapping neither re-creates nor re-identifies the Work", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  await env.STATE_KV.put("handoff_workitem:handoff-sales-1", "existing-work-9");
  const { mattersQueries } = mockSalesHandoffFetch(t);

  const scheduled = await discoverPendingSalesHandoffs(env, false);

  assert.strictEqual(calls.init.length, 0, "the Work already exists -- no second Work is created");
  assert.deepStrictEqual(calls.schedulePickup, ["sales_proposal"], "the pickup is scheduled exactly as before");
  assert.strictEqual(scheduled, 1);
  assert.strictEqual(await env.STATE_KV.get("handoff_workitem:handoff-sales-1"), "existing-work-9", "the Handoff association is untouched");
  assert.strictEqual(mattersQueries.length, 0, "Matter resolution is consulted only where a new Work would be created");
  assert.deepStrictEqual(pointerKeys(env), [], "the boundary writes no pointer for a continuing Work");
});
