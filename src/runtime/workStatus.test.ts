import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../types";
import {
  advanceWorkStatus,
  continueWorkStatus,
  finishWorkStatus,
  noteWorkStatus,
  renderWorkStatus,
  startWorkStatus,
  workStatusHeader,
  MAX_INTERMEDIATE_EDITS,
  type WorkStatusHolder,
} from "./workStatus";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_GROUP_CHAT_ID: "-100",
  WORKSPACE_TOPIC_ID: "7",
  STATE_KV: { put: async () => undefined },
} as unknown as Env;

function mockTelegram(t: any): { method: string; body: any }[] {
  const original = globalThis.fetch;
  const calls: { method: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("workStatus: a run is one Workspace message, edited in place, ending on its final line", async (t) => {
  const calls = mockTelegram(t);
  const holder: WorkStatusHolder = { chatId: 1, workId: "w1" };

  await startWorkStatus(env, holder, "Test Hat", "Test Hat — MAT-1", "Reading the Handoff");
  await advanceWorkStatus(env, holder, "Judging the price...");
  await finishWorkStatus(env, holder, "✅ Ready below.", "succeeded");

  assert.deepStrictEqual(calls.map((c) => c.method), ["sendMessage", "editMessageText", "editMessageText"]);
  assert.strictEqual(calls[0].body.chat_id, -100, "status goes to the Workspace stream");
  assert.strictEqual(calls[0].body.message_thread_id, 7);
  assert.strictEqual(calls[1].body.message_id, 42, "later steps edit the same message");
  assert.strictEqual(calls[2].body.text, "Hat: Test Hat.\n\n🧭 Test Hat — MAT-1\n✓ Reading the Handoff\n✓ Judging the price\n✅ Ready below.");
  assert.strictEqual(holder.workStatus, undefined, "a finished run is cleared");
  assert.strictEqual(holder.workStatusMessageId, undefined);
});

test("workStatus: a failed run marks the step it stopped on ✗", () => {
  const text = renderWorkStatus({ hat: "H", header: "H — x", done: ["Read"], current: "Checking" }, { line: "⛔ Held.", currentFailed: true });
  assert.strictEqual(text, "🧭 H — x\n✓ Read\n✗ Checking\n⛔ Held.");
  assert.strictEqual(renderWorkStatus({ hat: "H", header: "H — x", done: [], current: "Running..." }), "🧭 H — x\n⏳ Running", "the running step shows ⏳, trailing dots dropped");
});

test("workStatus: advancing or finishing with no open run sends nothing", async (t) => {
  const calls = mockTelegram(t);
  const holder: WorkStatusHolder = { chatId: 1 };

  await advanceWorkStatus(env, holder, "Step");
  await finishWorkStatus(env, holder, "✅", "succeeded");
  noteWorkStatus(holder, "Step");

  assert.strictEqual(calls.length, 0);
});

test("workStatus: note rewords the running step without an edit; continue starts a run only when none is open", async (t) => {
  const calls = mockTelegram(t);
  const holder: WorkStatusHolder = { chatId: 1 };

  await continueWorkStatus(env, holder, "H", "H — x", "Reading the record");
  noteWorkStatus(holder, "Read record CN-7");
  await continueWorkStatus(env, holder, "H", "H — x", "Judging");

  assert.deepStrictEqual(calls.map((c) => c.method), ["sendMessage", "editMessageText"]);
  assert.strictEqual(calls[1].body.text, "Hat: H.\n\n🧭 H — x\n✓ Read record CN-7\n⏳ Judging");
});

test("workStatus: the header names the Matter, else the Entity, else the fallback", () => {
  assert.strictEqual(workStatusHeader("H", { matterToken: "MAT-2", entityToken: "ENT-1" }, "new"), "H — MAT-2");
  assert.strictEqual(workStatusHeader("H", { entityToken: "ENT-1" }, "new"), "H — ENT-1");
  assert.strictEqual(workStatusHeader("H", {}, "new"), "H — new");
});

test("workStatus: a run makes at most 1 send + MAX_INTERMEDIATE_EDITS edits + 1 final edit, and the final message still lists every step", async (t) => {
  const calls = mockTelegram(t);
  const holder: WorkStatusHolder = { chatId: 1 };

  await startWorkStatus(env, holder, "H", "H — x", "Step 0");
  for (let i = 1; i <= 20; i++) await advanceWorkStatus(env, holder, `Step ${i}`);
  await finishWorkStatus(env, holder, "✅ Done.", "succeeded");

  assert.strictEqual(calls.length, 1 + MAX_INTERMEDIATE_EDITS + 1, "the subrequest cost of a run is bounded whatever its step count");
  const final = calls.at(-1)!.body.text as string;
  for (let i = 0; i <= 20; i++) assert.ok(final.includes(`✓ Step ${i}`), `Step ${i} is still shown`);
});

test("workStatus: Markdown entity characters are escaped, so Telegram accepts each send/edit on the first call", async (t) => {
  const calls = mockTelegram(t);
  const holder: WorkStatusHolder = { chatId: 1 };

  await startWorkStatus(env, holder, "H", "H — x", "Running business_strategy, brand_strategy");

  assert.strictEqual(calls[0].body.text, "Hat: H.\n\n🧭 H — x\n⏳ Running business\\_strategy, brand\\_strategy");
});
