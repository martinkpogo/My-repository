import test from "node:test";
import assert from "node:assert/strict";
import { invokeTool } from "./toolRegistry";
import type { WorkStatusHolder } from "./workStatus";
import type { Env } from "../types";

const wsEnv = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_CHAT_ID: "-100", WORKSPACE_TOPIC_ID: "1" } as unknown as Env;

test("invokeTool reports denied outcome for unknown operation when activity holder provided", async () => {
  const originalFetch = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (_url: string, init?: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -100,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    } as any;
    const out = await invokeTool(wsEnv, { tool_id: "nope", operation_id: "nope.op", input: {} } as any, { kind: "system" } as any, { activity: { holder, runId: "r", label: "tool" } as any });
    assert.equal(out.state, "denied");
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "denied");
    assert.ok(calls.length >= 1, "start marker published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
