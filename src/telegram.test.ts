import test from "node:test";
import assert from "node:assert";
import { editHatMessage, editMessageText, editWorkspaceHatMessage, redactTelegramProviderError, sendHatMessage, sendMessage, sendMessageWithOutcome, sendWorkspaceHatMessage, sendWorkspaceHatMessageWithOutcome, withWorkspaceTypingIndicator } from "./telegram";
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

test("editMessageText retries as plain text when Telegram rejects the Markdown -- an identifier with an underscore still reaches the chat", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // Telegram's real reply to an unpaired `_` under parse_mode Markdown.
    if (body.parse_mode === "Markdown") {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 102" }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  }) as typeof fetch;

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await editMessageText(fakeEnv, 1, 4242, "🧭 Running Strategy Skills (business_strategy, communication_strategy)...");
    assert.strictEqual(bodies.length, 2, "one Markdown attempt, then one plain-text retry");
    assert.strictEqual(bodies[1].parse_mode, undefined, "the retry carries no parse_mode");
    assert.strictEqual(bodies[1].text, bodies[0].text, "the same text is sent unchanged");
    assert.strictEqual(bodies[1].message_id, 4242);
    assert.deepStrictEqual(errors, [], "a successful plain-text retry logs no failure");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
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
    await editHatMessage(fakeEnv, { chatId: 1, hat: "Strategy Analyst" }, 4242, "Gathering evidence...");
    assert.strictEqual(calledBody.text, "Hat: Strategy Analyst.\n\nGathering evidence...");
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

test("withWorkspaceTypingIndicator sends ONE typing action however long the work runs -- every Telegram call is a Worker subrequest", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (url: string) => {
    methods.push(String(url).split("/").pop()!);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_CHAT_ID: "-100", WORKSPACE_TOPIC_ID: "7" } as any;
    const result = await withWorkspaceTypingIndicator(env, () => new Promise((resolve) => setTimeout(() => resolve("done"), 60)));
    assert.strictEqual(result, "done");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual(methods, ["sendChatAction"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Structured delivery outcome (LOG-1071/LOG-1072 reporting defect): the send
// path must distinguish confirmed delivery from total failure, per attempt,
// with safely bounded/redacted provider detail -- without changing the
// message-id contract any current caller relies on.
// ---------------------------------------------------------------------------

const TELEGRAM_TOKEN_LIKE = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1h7Q";
const telegramReject = (description: string, status = 400) =>
  new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
const telegramAccept = (messageId = 77) =>
  new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });

test("total delivery failure: both the Markdown attempt and the plain-text retry are recorded as failed, redacted, and bounded -- delivered is false", async () => {
  const originalFetch = globalThis.fetch;
  // The live rejection shape, plus a token-bearing URL stuffed into the
  // description to prove credentials can never ride along in diagnostics.
  const verbose = `Bad Request: BUTTON_DATA_INVALID (see https://api.telegram.org/bot${TELEGRAM_TOKEN_LIKE}/sendMessage) ${"x".repeat(500)}`;
  globalThis.fetch = (async () => telegramReject(verbose)) as typeof fetch;

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const result = await sendMessageWithOutcome(fakeEnv, 1, "Secret picker payload for马丁", undefined, 10);

    assert.strictEqual(result.delivered, false, "total rejection must be reported as failure, never as delivery");
    assert.strictEqual(result.messageId, undefined);
    assert.strictEqual(result.attempts.length, 2, "exactly one Markdown attempt and one plain-text retry");
    assert.deepStrictEqual(
      result.attempts.map((a) => ({ parseMode: a.parseMode, ok: a.ok, httpStatus: a.httpStatus, chunk: a.chunk })),
      [
        { parseMode: "Markdown", ok: false, httpStatus: 400, chunk: 0 },
        { parseMode: "plain", ok: false, httpStatus: 400, chunk: 0 },
      ],
    );
    for (const attempt of result.attempts) {
      assert.ok(attempt.error, "each failed attempt must carry its provider detail");
      assert.ok(attempt.error.includes("BUTTON_DATA_INVALID"), "the actionable provider detail must survive redaction");
      assert.ok(!attempt.error.includes(TELEGRAM_TOKEN_LIKE), "the bot token must never survive into diagnostics");
      assert.ok(attempt.error.includes("bot[redacted]"), "the token position must be visibly redacted, not silently truncated");
      assert.ok(attempt.error.length <= 201, `diagnostics must be bounded (got ${attempt.error.length} chars)`);
      assert.ok(!attempt.error.includes("Secret picker payload"), "provider diagnostics must never echo message content");
    }
    assert.strictEqual(errors.length, 1, "one failure log per fully failed chunk");
    assert.ok(errors[0].includes("telegram sendMessage failed"), "the established log marker is preserved");
    assert.ok(!errors.some((e) => e.includes(TELEGRAM_TOKEN_LIKE)), "even the log line must be redacted");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("a failed Markdown attempt rescued by the plain-text retry IS delivery: delivered true, the retry's id, and no failure logged", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.parse_mode === "Markdown") {
      return telegramReject("Bad Request: can't parse entities: Can't find end of the entity");
    }
    return telegramAccept(77);
  }) as typeof fetch;

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const result = await sendMessageWithOutcome(fakeEnv, 1, "hello", undefined, 10);

    assert.strictEqual(result.delivered, true, "a successful retry is delivery, not failure");
    assert.strictEqual(result.messageId, 77);
    assert.deepStrictEqual(
      result.attempts.map((a) => ({ parseMode: a.parseMode, ok: a.ok, httpStatus: a.httpStatus })),
      [
        { parseMode: "Markdown", ok: false, httpStatus: 400 },
        { parseMode: "plain", ok: true, httpStatus: 200 },
      ],
    );
    assert.strictEqual(bodies.length, 2, "one Markdown attempt, then one plain retry");
    assert.strictEqual(bodies[1].parse_mode, undefined, "the retry carries no parse_mode");
    assert.deepStrictEqual(errors, [], "a rescued delivery must not log a failure");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("an immediately accepted Markdown send makes NO retry and reports single-attempt delivery", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return telegramAccept(4242);
  }) as typeof fetch;

  try {
    const result = await sendMessageWithOutcome(fakeEnv, 1, "hello", undefined, 10);
    assert.strictEqual(result.delivered, true);
    assert.strictEqual(result.messageId, 4242);
    assert.strictEqual(calls, 1, "no unnecessary plain-text retry");
    assert.deepStrictEqual(
      result.attempts.map((a) => ({ parseMode: a.parseMode, ok: a.ok, httpStatus: a.httpStatus })),
      [{ parseMode: "Markdown", ok: true, httpStatus: 200 }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the message-id contract parity: sendWorkspaceHatMessage still returns the delivered id through the same send path the outcome form uses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.parse_mode === "Markdown") return telegramReject("Bad Request: can't parse entities");
    return telegramAccept(99);
  }) as typeof fetch;

  try {
    const msgId = await sendWorkspaceHatMessage(fakeWorkspaceEnv, { chatId: 999999, hat: "Sales Executive" }, "picker");
    assert.strictEqual(msgId, 99, "existing callers keep the plain message-id return");

    const outcome = await sendWorkspaceHatMessageWithOutcome(fakeWorkspaceEnv, { chatId: 999999, hat: "Sales Executive" }, "picker");
    assert.strictEqual(outcome.delivered, true, "the structured form agrees with the message-id form");
    assert.strictEqual(outcome.messageId, 99);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unconfigured Workspace stream reports an explicit unconfigured failure in the outcome form and keeps returning undefined in the message-id form", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return telegramAccept();
  }) as typeof fetch;

  try {
    const outcome = await sendWorkspaceHatMessageWithOutcome(fakeEnv, { chatId: 1, hat: "Sales Executive" }, "picker");
    assert.strictEqual(outcome.delivered, false);
    assert.strictEqual(outcome.unconfiguredStream, true, "the caller can tell 'never attempted' apart from 'rejected'");
    assert.deepStrictEqual(outcome.attempts, []);

    const msgId = await sendWorkspaceHatMessage(fakeEnv, { chatId: 1, hat: "Sales Executive" }, "picker");
    assert.strictEqual(msgId, undefined, "the established fail-closed contract is unchanged");
    assert.strictEqual(fetched, false, "no request may be attempted with no resolved target");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redactTelegramProviderError strips token and authorization material and bounds the text", () => {
  const tokenish = `fetch failed: Post "https://api.telegram.org/bot${TELEGRAM_TOKEN_LIKE}/sendMessage": dial tcp`;
  const redacted = redactTelegramProviderError(tokenish);
  assert.ok(!redacted.includes(TELEGRAM_TOKEN_LIKE));
  assert.ok(redacted.includes("bot[redacted]"));

  assert.ok(!redactTelegramProviderError("authorization: Bearer abc123def456ghi789").includes("abc123def456ghi789"));
  assert.ok(!redactTelegramProviderError("headers: {\"Authorization\":\"Bearer abc123def456ghi789\"}").includes("abc123def456ghi789"));

  const bounded = redactTelegramProviderError("y".repeat(1000));
  assert.strictEqual(bounded.length, 201, "200 chars plus the truncation marker");
  assert.ok(bounded.endsWith("…"));
});
