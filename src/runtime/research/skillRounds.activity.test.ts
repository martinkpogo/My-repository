import test from "node:test";
import assert from "node:assert/strict";
import { dispatchOperations } from "./skillRounds";
import type { WorkStatusHolder } from "../workStatus";
import type { Env } from "../../types";

test("dispatchOperations reports search start and terminal outcome on real execution path", async () => {
  const originalFetch = globalThis.fetch;
  const tgCalls: any[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      tgCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }
    // Tavily search success
    if (u.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.com/a", content: "snippet" }] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -100,
      workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    } as any;
    const env = { TAVILY_API_KEY: "k", STATE_KV: { get: async () => null, put: async () => {} }, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_CHAT_ID: "-100", WORKSPACE_TOPIC_ID: "1" } as unknown as Env;
    const access = { kind: "operator_research" } as any;
    const results = await dispatchOperations(env, [{ type: "search", query: "test query" }] as any, access, { maxResultChars: 1000, maxSearchesPerRound: 3, maxPagesPerRound: 3 } as any, { holder, runId: "r" } as any);
    assert.equal(results[0].outcome, "success_with_results");
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "succeeded");
    assert.ok(tgCalls.length >= 1, "search start marker published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
