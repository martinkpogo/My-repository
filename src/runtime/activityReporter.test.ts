import test from "node:test";
import assert from "node:assert/strict";
import { startOperation, finishOperation } from "./activityReporter";
import type { WorkStatusHolder } from "./workStatus";
import type { Env } from "../types";

const fakeWorkspaceEnv = { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_GROUP_CHAT_ID: "-1004435157576", WORKSPACE_TOPIC_ID: "100" } as Env;

test("invalid message ids trigger no Telegram edit", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); }) as typeof fetch;
  try {
    for (const id of [undefined, 0, -1, NaN, Infinity]) {
      const holder: WorkStatusHolder = {
        chatId: -1004435157576,
        workId: "w",
        workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
        workStatusMessageId: id as any,
      };
      const ctx = startOperation(fakeWorkspaceEnv, holder, "op", "Op");
      await finishOperation(fakeWorkspaceEnv, ctx, "succeeded");
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reporting failure does not change underlying outcome", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -1004435157576,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    };
    const ctx = startOperation(fakeWorkspaceEnv, holder, "op", "Op");
    await assert.doesNotReject(finishOperation(fakeWorkspaceEnv, ctx, "failed"));
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finishOperation records actual outcome", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -1004435157576,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    };
    const ctx = startOperation(fakeWorkspaceEnv, holder, "op", "Op");
    await finishOperation(fakeWorkspaceEnv, ctx, "denied");
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "denied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
