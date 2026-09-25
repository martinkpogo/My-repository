import test from "node:test";
import assert from "node:assert";
import { editHatMessage, editMessageText, editWorkspaceHatMessage, sendHatMessage, sendMessage, sendWorkspaceHatMessage } from "./telegram";
import type { Env } from "./types";

const fakeEnv = { TELEGRAM_BOT_TOKEN: "test-token" } as Env;
const fakeWorkspaceEnv = { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_GROUP_CHAT_ID: "-1004435157576", WORKSPACE_TOPIC_ID: "100" } as Env;

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

/**
 * Regression coverage for a live-production bug (confirmed via Worker logs
 * -- "editMessageText failed... message to edit not found"): a message
 * sent via sendWorkspaceHatMessage always lands in the configured
 * Workspace stream's own chat, overriding the caller's target.chatId. A
 * caller that later edits that same message via plain editHatMessage
 * (target.chatId) targets the WRONG chat whenever target.chatId differs
 * from the Workspace stream's chat -- exactly the case for a work item
 * picked up via a Unit's own "no prior session" discovery fallback
 * (checkHandoffs.ts), whose chatId is set to Martin's DM while its
 * progress ack was actually sent to the Workspace group.
 */
test("editWorkspaceHatMessage targets the Workspace stream's own chat, not target.chatId -- the correct counterpart to sendWorkspaceHatMessage's own override", async () => {
  const originalFetch = globalThis.fetch;
  let calledBody: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    calledBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  }) as typeof fetch;

  try {
    // target.chatId (999999, e.g. Martin's DM) deliberately differs from
    // the configured Workspace stream's chat (-1004435157576) -- exactly
    // the mismatch that caused the live failure.
    await editWorkspaceHatMessage(fakeWorkspaceEnv, { chatId: 999999, hat: "Strategy Analyst" }, 4242, "Running specialist diagnosis (business, brand)...");
    assert.strictEqual(calledBody.chat_id, -1004435157576, "must edit the Workspace stream's own chat, never target.chatId");
    assert.strictEqual(calledBody.message_id, 4242);
    assert.strictEqual(calledBody.text, "Hat: Strategy Analyst.\n\nRunning specialist diagnosis (business, brand)...");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editWorkspaceHatMessage targets the exact same chat sendWorkspaceHatMessage actually sent the original message to", async () => {
  const originalFetch = globalThis.fetch;
  const calledBodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    calledBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  }) as typeof fetch;

  try {
    const sentMessageId = await sendWorkspaceHatMessage(fakeWorkspaceEnv, { chatId: 999999, hat: "Strategy Analyst" }, "Diagnosing this now...");
    await editWorkspaceHatMessage(fakeWorkspaceEnv, { chatId: 999999, hat: "Strategy Analyst" }, sentMessageId!, "Establishing the situation and running the diagnosis...");

    assert.strictEqual(calledBodies.length, 2);
    assert.strictEqual(calledBodies[0].chat_id, calledBodies[1].chat_id, "the edit must target the exact same chat the send actually used");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editWorkspaceHatMessage fails closed (logs, never throws) when the Workspace stream is unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;

  try {
    await assert.doesNotReject(editWorkspaceHatMessage(fakeEnv, { chatId: 1, hat: "Strategy Analyst" }, 4242, "progress"));
    assert.strictEqual(fetchCalled, false, "must never attempt an edit with no resolved chat -- fail closed, not against a guessed chat_id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
