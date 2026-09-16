import test from "node:test";
import assert from "node:assert";
import { editHatMessage, editMessageText, sendHatMessage, sendMessage } from "./telegram";
import type { Env } from "./types";

const fakeEnv = { TELEGRAM_BOT_TOKEN: "test-token" } as Env;

test("sendMessage returns the sent message's message_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 })) as typeof fetch;

  try {
    const messageId = await sendMessage(fakeEnv, 1, "hello");
    assert.strictEqual(messageId, 4242);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage returns undefined when every send attempt fails, without throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;

  try {
    const messageId = await sendMessage(fakeEnv, 1, "hello");
    assert.strictEqual(messageId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editMessageText posts to Telegram's editMessageText method with the given chat/message id and text", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledBody: any;
  globalThis.fetch = (async (url: string, init: any) => {
    calledUrl = String(url);
    calledBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  }) as typeof fetch;

  try {
    await editMessageText(fakeEnv, 1, 4242, "updated status");
    assert.ok(calledUrl.endsWith("/editMessageText"));
    assert.strictEqual(calledBody.chat_id, 1);
    assert.strictEqual(calledBody.message_id, 4242);
    assert.strictEqual(calledBody.text, "updated status");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editMessageText fails silently (logged, not thrown) when Telegram rejects the edit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("message not found", { status: 400 })) as typeof fetch;

  try {
    await assert.doesNotReject(editMessageText(fakeEnv, 1, 4242, "updated status"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendHatMessage labels the message with the Hat name before the content", async () => {
  const originalFetch = globalThis.fetch;
  let calledBody: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    calledBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  }) as typeof fetch;

  try {
    await sendHatMessage(fakeEnv, { chatId: 1, threadId: 10, hat: "Marketing Strategist" }, "The market is growing.");
    assert.strictEqual(calledBody.text, "Hat: Marketing Strategist.\n\nThe market is growing.");
    assert.strictEqual(calledBody.message_thread_id, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editHatMessage re-applies the same Hat label an edited bubble started with", async () => {
  const originalFetch = globalThis.fetch;
  let calledBody: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    calledBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  }) as typeof fetch;

  try {
    await editHatMessage(fakeEnv, { chatId: 1, hat: "Research & Intelligence Analyst" }, 4242, "Gathering evidence...");
    assert.strictEqual(calledBody.text, "Hat: Research & Intelligence Analyst.\n\nGathering evidence...");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
