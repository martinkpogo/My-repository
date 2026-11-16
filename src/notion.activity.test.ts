import test from "node:test";
import assert from "node:assert/strict";
import { queryDataSource } from "./notion";
import type { Env } from "./types";
import type { WorkStatusHolder } from "./runtime/workStatus";
import { workSessionReadContext } from "./access";

test("Notion queryDataSource reports denied before network when Access denies and holder metadata provided", async () => {
  const originalFetch = globalThis.fetch;
  let notionCalls = 0;
  const tgCalls: any[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      tgCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }
    if (u.includes("api.notion.com")) {
      notionCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -100,
      workId: "work-1",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    } as any;
    const env = { NOTION_TOKEN: "t", NOTION_VERSION: "2025-09-03", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_CHAT_ID: "-100", WORKSPACE_TOPIC_ID: "1" } as unknown as Env;
    // workSessionReadContext carries no action/unit/hat; Access denies governed data-source operations fail-closed.
    const access = workSessionReadContext("work-1");
    await assert.rejects(() => queryDataSource(env, "ds-1", access, undefined, undefined, { holder, runId: "r", label: "Notion query" } as any));
    assert.equal(notionCalls, 0, "Access denial must occur before any Notion network request");
    assert.equal(holder.workStatus?.completed?.at(-1)?.outcome, "denied");
    assert.ok(tgCalls.length >= 1, "start/finish reported to in-place status");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
