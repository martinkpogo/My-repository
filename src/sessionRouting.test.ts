import test from "node:test";
import assert from "node:assert";
import { getReplyMessageWorkId, routeIncomingText, setReplyMessageWorkId } from "./router";
import { getWorkspaceTarget, getOperationsTarget, sendHatMessage, sendOperationsMessage } from "./telegram";
import type { Env } from "./types";

function createMockKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => { store.set(key, val); },
    delete: async (key: string) => { store.delete(key); },
    list: async ({ prefix }: { prefix?: string }) => {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
    store,
  };
}

import { resolveStreamForThread } from "./router";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  const kv = createMockKv();
  return {
    MARTIN_TELEGRAM_USER_ID: "123456",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "604",
    OPERATIONS_TOPIC_ID: "588",
    TELEGRAM_BOT_TOKEN: "test-token",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    STATE_KV: kv as any,
    ...overrides,
  } as Env;
}

test("1. Stream target helpers resolve correct Workspace (604) and Operations (588) targets", () => {
  const env = fakeEnv();
  const workspace = getWorkspaceTarget(env);
  assert.ok(workspace !== null);
  assert.strictEqual(workspace.chatId, -1004435157576);
  assert.strictEqual(workspace.threadId, 604);

  const ops = getOperationsTarget(env);
  assert.ok(ops !== null);
  assert.strictEqual(ops.chatId, -1004435157576);
  assert.strictEqual(ops.threadId, 588);
});

test("1b. Stream target helpers fail closed when configuration is missing without cross-stream or topic 14 fallback", async () => {
  const unconfiguredEnv = fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576", WORKSPACE_TOPIC_ID: undefined, OPERATIONS_TOPIC_ID: undefined });

  assert.strictEqual(getWorkspaceTarget(unconfiguredEnv), null);
  assert.strictEqual(getOperationsTarget(unconfiguredEnv), null, "missing Operations configuration must fail closed and return null rather than defaulting to 14");

  const opsResult = await sendOperationsMessage(unconfiguredEnv, "test telemetry");
  assert.strictEqual(opsResult, undefined, "unconfigured operations stream must fail closed returning undefined");
});

test("1c. resolveStreamForThread strictly resolves 604 -> workspace, 588 -> operations, and legacy/other IDs -> unmapped", () => {
  const env = fakeEnv();

  assert.strictEqual(resolveStreamForThread(env, 604), "workspace");
  assert.strictEqual(resolveStreamForThread(env, 588), "operations");
  assert.strictEqual(resolveStreamForThread(env, 14), "unmapped", "legacy topic 14 must resolve to unmapped");
  assert.strictEqual(resolveStreamForThread(env, 393), "unmapped", "legacy topic 393 must resolve to unmapped");
  assert.strictEqual(resolveStreamForThread(env, 399), "unmapped", "legacy topic 399 must resolve to unmapped");
  assert.strictEqual(resolveStreamForThread(env, 999), "unmapped");
});

test("1d. Supergroup main chat (undefined message_thread_id) and private DMs do NOT trigger Hat execution", async () => {
  const env = fakeEnv();
  let hatTriggered = false;

  (env as any).WORK_SESSION = {
    idFromName: (id: string) => id,
    get: (_id: string) => ({
      getState: async () => null,
      handleMarketingRequest: async () => { hatTriggered = true; },
      handleIncomingEnquiry: async () => { hatTriggered = true; },
    }),
  };

  // 1. Supergroup General/main chat (chatId === groupChatId, threadId === undefined)
  await routeIncomingText(env, -1004435157576, "We are a bakery chain needing marketing strategy", undefined);
  assert.strictEqual(hatTriggered, false, "General supergroup chat must NOT trigger Hat execution");

  // 2. Private DM (chatId !== groupChatId, threadId === undefined)
  await routeIncomingText(env, 123456, "Define our Q2 marketing objectives", undefined);
  assert.strictEqual(hatTriggered, false, "Private DM must NOT trigger Hat execution");
});

test("2. reply_msg KV helper sets and retrieves reply message workId mappings", async () => {
  const env = fakeEnv();
  await setReplyMessageWorkId(env, 98765, "work-uuid-123");
  const retrieved = await getReplyMessageWorkId(env, 98765);
  assert.strictEqual(retrieved, "work-uuid-123");
});

test("3. reply-to-message routing in DM routes to the specific WorkSession matched in KV", async () => {
  const env = fakeEnv();
  await setReplyMessageWorkId(env, 555, "session-abc");

  let handledReplyWorkId: string | null = null;
  (env as any).WORK_SESSION = {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      getState: async () => ({ workId: id, awaiting: "call_notes", stage: "awaiting_call_notes" }),
      handleTextReply: async (_text: string) => {
        handledReplyWorkId = id;
        return { workId: id, stage: "completed" };
      },
    }),
  };

  await routeIncomingText(env, 123456, "Here are the call notes...", undefined, { replyToMessageId: 555 });
  assert.strictEqual(handledReplyWorkId, "session-abc", "text should route directly to session-abc from reply-to-message ID");
});

test("4. Ordinary DM conversation without reply-to-message is NEVER hijacked by an awaiting session", async (t) => {
  const env = fakeEnv();
  // Existing session active pointer exists in KV
  await env.STATE_KV.put("active:123456:dm", "session-xyz");

  let interceptedByWorkSession = false;
  (env as any).WORK_SESSION = {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      getState: async () => ({ workId: id, awaiting: "proposal_feedback", stage: "awaiting_feedback" }),
      handleTextReply: async () => {
        interceptedByWorkSession = true;
      },
    }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes("routing.marketing_specialization_check") || url.includes("routing.enquiry_classification")) {
      return new Response(JSON.stringify({ specialization: "not_marketing", route: "out_of_scope" }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Hello Martin! How can I help?" } }] }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Martin sends an unassociated general message in DM
  await routeIncomingText(env, 123456, "How is the business performing this week?", undefined);

  assert.strictEqual(interceptedByWorkSession, false, "Ordinary DM message must NEVER be hijacked by an awaiting WorkSession");
});

test("5. Multi-session concurrency: two simultaneous awaiting WorkSessions in DM route independently via reply_to_message", async () => {
  const env = fakeEnv();
  await setReplyMessageWorkId(env, 101, "work-session-1");
  await setReplyMessageWorkId(env, 102, "work-session-2");

  const routedSessions: string[] = [];
  (env as any).WORK_SESSION = {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      getState: async () => ({ workId: id, awaiting: "marketing_feedback" }),
      handleTextReply: async () => {
        routedSessions.push(id);
      },
    }),
  };

  // Reply to session 2 prompt
  await routeIncomingText(env, 123456, "Feedback for session 2", undefined, { replyToMessageId: 102 });
  assert.strictEqual(routedSessions[0], "work-session-2");

  // Reply to session 1 prompt
  await routeIncomingText(env, 123456, "Feedback for session 1", undefined, { replyToMessageId: 101 });
  assert.strictEqual(routedSessions[1], "work-session-1");
});

test("6. Unmapped topics (e.g. legacy topics 393, 14) block Hat execution and inform user", async (t) => {
  const env = fakeEnv();
  const sentPayloads: any[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    if (init?.body) sentPayloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Message sent in legacy topic thread 393
  await routeIncomingText(env, -1004435157576, "Marketing feedback in legacy topic", 393);

  assert.strictEqual(sentPayloads.length, 1);
  assert.strictEqual(sentPayloads[0].text, "This topic isn't mapped to a Stream yet.");
});

test("7. Operations stream messages emit to Operations topic 588 without touching DM or workspace active pointers", async (t) => {
  const env = fakeEnv();
  const sentPayloads: any[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    if (init?.body) sentPayloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await sendOperationsMessage(env, "Background execution report: 5 jobs completed.");

  assert.strictEqual(sentPayloads.length, 1);
  assert.strictEqual(sentPayloads[0].chat_id, -1004435157576, "must route to Operations group chat ID");
  assert.strictEqual(sentPayloads[0].message_thread_id, 588, "must route to Operations thread ID (588)");
});

test("8. sendHatMessage automatically registers reply_msg mapping in KV when target has workId", async (t) => {
  const env = fakeEnv();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const target = { chatId: 123456, hat: "Sales Executive", workId: "work-uuid-777" };
  const msgId = await sendHatMessage(env, target, "Please approve the proposal draft.");

  assert.strictEqual(msgId, 777);
  const registeredWorkId = await getReplyMessageWorkId(env, 777);
  assert.strictEqual(registeredWorkId, "work-uuid-777", "sendHatMessage must automatically register reply_msg:777 in KV");
});
