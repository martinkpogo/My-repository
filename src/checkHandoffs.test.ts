/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheckHandoffs, maybeAutoContinueCheckHandoffs, discoverPendingSalesHandoffs } from "./checkHandoffs";
import type { Env, WorkState } from "./types";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
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
  const calls: { init: any[][]; runProposalDrafting: number; runTokenSafeProposal: number } = { init: [], runProposalDrafting: 0, runTokenSafeProposal: 0 };
  const stub = {
    init: async (...args: any[]) => {
      calls.init.push(args);
    },
    runProposalDrafting: async () => {
      calls.runProposalDrafting++;
    },
    runTokenSafeProposal: async () => {
      calls.runTokenSafeProposal++;
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
  const salesHandoff = {
    id: "handoff-sales-1",
    url: "https://notion.so/handoff-sales-1",
    properties: {
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
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      if (body.text) operationsMessages.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { operationsMessages };
}

test("11. Externally-created Sales Handoff without handoff_workitem is detected instead of skipped", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t);

  const pickedUp = await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.init.length, 1, "a WorkSession must be registered for the externally-created Sales Handoff");
  const mapped = await env.STATE_KV.get("handoff_workitem:handoff-sales-1");
  assert.ok(mapped, "handoff_workitem mapping must be recorded so the Handoff is discoverable next time too");
  assert.strictEqual(pickedUp, 0, "detection/registration is not counted as a pickup -- no identity-sensitive execution happened");
});

test("12. External Sales detection does not execute identity-sensitive Sales work automatically", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t);

  await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.runProposalDrafting, 0, "Sales Executive's own AI-driven work must never run automatically from detection alone");
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

  const pickedUp = await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.runTokenSafeProposal, 0, "the token-safe Proposal flow must not run while Sales is paused");
  assert.strictEqual(calls.runProposalDrafting, 0);
  assert.strictEqual(pickedUp, 0);
  assert.ok(operationsMessages.some((m) => m.includes("SALES HANDOFF READY")), "the existing paused notification is sent");
  // The mocked fetch throws on anything but the discovery query and Telegram,
  // so reaching here also proves no Handoff status write (it stays Pending).
});

test("Not paused: a Finance -> Sales Handoff runs the token-safe Proposal flow instead of the old drafting path", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t, FINANCE_ORIGIN);

  const pickedUp = await discoverPendingSalesHandoffs(env, false);

  assert.strictEqual(calls.runTokenSafeProposal, 1);
  assert.strictEqual(calls.runProposalDrafting, 0);
  assert.strictEqual(pickedUp, 1);
  assert.ok(!operationsMessages.some((m) => m.includes("SALES HANDOFF READY")));
});

test("Not paused: a non-Finance Sales Handoff still uses the existing drafting path", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  mockSalesHandoffFetch(t, { "From Unit": { select: { name: "Strategy" } }, "From Hat": { rich_text: [{ plain_text: "Strategy Analyst" }] } });

  await discoverPendingSalesHandoffs(env, false);

  assert.strictEqual(calls.runTokenSafeProposal, 0);
  assert.strictEqual(calls.runProposalDrafting, 1);
});

test("A non-Finance Sales Handoff keeps the existing paused behaviour (detect + notify only)", async (t) => {
  const { workSession, calls } = createMockWorkSession();
  const env = fakeEnv();
  (env as any).WORK_SESSION = workSession;
  const { operationsMessages } = mockSalesHandoffFetch(t, { "From Unit": { select: { name: "Strategy" } }, "From Hat": { rich_text: [{ plain_text: "Strategy Analyst" }] } });

  await discoverPendingSalesHandoffs(env, true);

  assert.strictEqual(calls.runTokenSafeProposal, 0);
  assert.strictEqual(calls.runProposalDrafting, 0);
  assert.ok(operationsMessages.some((m) => m.includes("SALES HANDOFF READY")));
});
