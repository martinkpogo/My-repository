import test from "node:test";
import assert from "node:assert";
import { financeManifest, dispatchFinanceHat, QUOTE_CALLBACK_PREFIX } from "./financeManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers financeManifest.ts's own declared contract -- the thin Unit
 * Registry wiring around Value-Based Pricing Assessor's existing,
 * already-tested handleDirectRequest/handleQuoteApproval (see
 * valueBasedPricingAssessor.test.ts for that capability's own real
 * behavior). This file tests only what financeManifest.ts itself
 * contributes: the manifest/Hat shape, that entryHandler correctly
 * delegates to its wrapped implementation, and the callback-dispatch
 * mechanism (HatManifest.callbackHandlers, introduced by PRs #203-211)
 * -- that Value-Based Pricing Assessor declares quote, and that
 * findCallbackHandler's resolved handler genuinely reaches
 * handleQuoteApproval's real logic.
 */

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    MARTIN_TELEGRAM_USER_ID: "9999",
    STATE_KV: {
      get: async () => null,
      put: async () => {},
    } as any,
    ...overrides,
  } as Env;
}

function fakeWorkState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-1",
    chatId: 12345,
    threadId: 777,
    unit: "Finance",
    hat: "Value-Based Pricing Assessor",
    ...overrides,
  } as WorkState;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in financeManifest test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("financeManifest: declares exactly Finance's Value-Based Pricing Assessor Hat", () => {
  assert.strictEqual(financeManifest.unit, "Finance");
  assert.deepStrictEqual(Object.keys(financeManifest.hats), ["Value-Based Pricing Assessor"]);
});

test("financeManifest: Value-Based Pricing Assessor declares exactly one action, price, as 'write' requiring approval", () => {
  const hat = financeManifest.hats["Value-Based Pricing Assessor"];
  assert.strictEqual(hat.actions.length, 1);
  assert.strictEqual(hat.actions[0].name, "price");
  assert.strictEqual(hat.actions[0].consequence, "write");
  assert.strictEqual(hat.actions[0].requiresApproval, true);
});

test("financeManifest: readHandler fails closed -- no read action is declared", async () => {
  const hat = financeManifest.hats["Value-Based Pricing Assessor"];
  await assert.rejects(
    () => hat.readHandler(fakeEnv(), "price", "text"),
    /not a read action -- Value-Based Pricing Assessor only declares "price"/,
  );
});

test("financeManifest: awaitingHandlers is empty -- Finance's own continuation states stay hardcoded in session.ts", () => {
  const hat = financeManifest.hats["Value-Based Pricing Assessor"];
  assert.deepStrictEqual(hat.awaitingHandlers, {});
});

test("financeManifest: declares exactly quote in callbackHandlers", () => {
  const hat = financeManifest.hats["Value-Based Pricing Assessor"];
  assert.deepStrictEqual(Object.keys(hat.callbackHandlers ?? {}), [QUOTE_CALLBACK_PREFIX]);
});

test("findCallbackHandler resolves quote on Value-Based Pricing Assessor and genuinely delegates to handleQuoteApproval -- rejecting a direct-entry quote (no upstream Handoff) fails closed with a clear message, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({ stage: "awaiting_quote_approval" });

  const hat = financeManifest.hats["Value-Based Pricing Assessor"];
  const handler = findCallbackHandler(QUOTE_CALLBACK_PREFIX, hat);
  assert.ok(handler, "quote must resolve on Value-Based Pricing Assessor's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.stage, "awaiting_quote_approval", "no Redo loop for a direct-entry quote -- must not silently advance");
});

test("financeManifest: entryHandler/dispatchFinanceHat genuinely delegates to valueBasedPricingAssessor.ts's handleDirectRequest -- text with no Matter token fails closed and holds on finance_direct_request_matter, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState();

  const hat = financeManifest.hats["Value-Based Pricing Assessor"];
  const result = await hat.entryHandler(env, state, "price", "no Matter token anywhere in this message");

  assert.strictEqual(result.stage, "finance_blocked");
  assert.strictEqual(result.awaiting, "finance_direct_request_matter");

  const viaDispatch = await dispatchFinanceHat(env, fakeWorkState(), "another message with no token");
  assert.strictEqual(viaDispatch.stage, "finance_blocked");
});
