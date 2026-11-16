import test from "node:test";
import assert from "node:assert/strict";
import { startOperation, finishOperation } from "./activityReporter";
import { MAX_INTERMEDIATE_EDITS } from "./workStatus";
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
      const ctx = await startOperation(fakeWorkspaceEnv, holder, "op", "Op");
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
    const ctx = await startOperation(fakeWorkspaceEnv, holder, "op", "Op");
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
    const ctx = await startOperation(fakeWorkspaceEnv, holder, "op", "Op");
    await finishOperation(fakeWorkspaceEnv, ctx, "denied");
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "denied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startOperation publishes start marker in-place (same message) when budget allows", async () => {
  const originalFetch = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (_url: string, init?: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -1004435157576,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "step", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    };
    await startOperation(fakeWorkspaceEnv, holder, "op1", "First op");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message_id, 42);
    assert.match(calls[0].text, /First op/);
    assert.match(calls[0].text, /started/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent starts show all running markers and finishes record outcomes in completion order", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -1004435157576,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "step", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    };
    const [a, b] = await Promise.all([
      startOperation(fakeWorkspaceEnv, holder, "a", "Op A"),
      startOperation(fakeWorkspaceEnv, holder, "b", "Op B"),
    ]);
    assert.equal(holder.workStatus?.running?.length, 2);
    await finishOperation(fakeWorkspaceEnv, b, "failed");
    await finishOperation(fakeWorkspaceEnv, a, "succeeded");
    assert.deepStrictEqual(holder.workStatus?.completed?.map(c => [c.operationId, c.outcome]), [["b", "failed"], ["a", "succeeded"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all five outcomes are recorded", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })) as typeof fetch;
  try {
    const outcomes = ["succeeded", "failed", "partially_completed", "unverified", "denied"] as const;
    for (const outcome of outcomes) {
      const holder: WorkStatusHolder = {
        chatId: -1004435157576,
        workId: "w",
        workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
        workStatusMessageId: 42,
      };
      const ctx = await startOperation(fakeWorkspaceEnv, holder, "op", "Op");
      await finishOperation(fakeWorkspaceEnv, ctx, outcome);
      assert.equal(holder.workStatus?.completed?.[0]?.outcome, outcome);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("start/finish respect edit budget and reporting failure isolation", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("boom"); }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -1004435157576,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: MAX_INTERMEDIATE_EDITS },
      workStatusMessageId: 42,
    };
    const ctx = await startOperation(fakeWorkspaceEnv, holder, "op", "Op");
    await assert.doesNotReject(finishOperation(fakeWorkspaceEnv, ctx, "succeeded"));
    assert.equal(calls, 0, "no edits attempted once budget exhausted");
    assert.equal(holder.workStatus?.running?.length, 0);
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "succeeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
