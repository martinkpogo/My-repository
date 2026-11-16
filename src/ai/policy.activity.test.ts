import test from "node:test";
import assert from "node:assert/strict";
import { AiPolicyExecutor } from "./policy";
import type { Env } from "../types";
import type { WorkStatusHolder } from "../runtime/workStatus";

const wsEnv = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_CHAT_ID: "-100", WORKSPACE_TOPIC_ID: "1" } as unknown as Env;
const task = { taskId: "chat.data_lookup", boundaryContext: { segments: [{ type: "user", content: "hi", provenance: "t", sensitivity: "public" }] }, messages: [{ role: "user", content: "hi" }] } as any;

test("AiPolicyExecutor reports operation start and success outcome on real execution path", async () => {
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
    const executor = new AiPolicyExecutor([{
      id: "workers-ai",
      isEligible: () => true,
      execute: async () => ({ success: true, response: { rawText: "ok", providerId: "workers-ai" } as any }),
    } as any] as any);
    const out = await executor.executeTaskWithOutcome(wsEnv, task, { holder, runId: "r", label: "AI step" } as any);
    assert.equal(out.ok, true);
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "succeeded");
    assert.ok(calls.length >= 1, "start marker published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AiPolicyExecutor maps gate block to denied outcome on real execution path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -100, workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    } as any;
    const gate = { evaluate: () => ({ allowed: false, reasonCategory: "COMPANY_SUFFIX_DETECTED", policy: "p", detectorClassification: "d" }) } as any;
    const ex = new AiPolicyExecutor([{ id: "workers-ai", isEligible: () => true, execute: async () => ({ success: true, response: { rawText: "x", providerId: "workers-ai" } as any }) } as any], undefined, gate);
    const out = await ex.executeTaskWithOutcome(wsEnv, task, { holder } as any);
    assert.equal(out.ok, false);
    assert.equal((out as any).cause, "outbound_gate_blocked");
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "denied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AiPolicyExecutor reporting failure does not change underlying result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("tg down"); }) as typeof fetch;
  try {
    const holder: WorkStatusHolder = {
      chatId: -100, workId: "w",
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: 42,
    } as any;
    const executor = new AiPolicyExecutor([{
      id: "workers-ai",
      isEligible: () => true,
      execute: async () => ({ success: true, response: { rawText: "ok", providerId: "workers-ai" } as any }),
    } as any] as any);
    const out = await executor.executeTaskWithOutcome(wsEnv, task, { holder } as any);
    assert.equal(out.ok, true);
    assert.equal(holder.workStatus?.completed?.[0]?.outcome, "succeeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
