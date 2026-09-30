import test from "node:test";
import assert from "node:assert";
import {
  marketingManifest,
  handleTransitionApproval,
  handleDraftApproval,
  handlePaidMediaApproval,
  MARKET_TRANSITION_CALLBACK_PREFIX,
  MARKET_DRAFT_CALLBACK_PREFIX,
  MARKET_PAID_CALLBACK_PREFIX,
} from "./marketingManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers marketingManifest.ts's own declared contract that marketingManifest.ts
 * itself contributes on top of the relocated, already-live behaviour
 * (runMarketingHat/handleTransitionApproval's decision/routing logic is
 * unchanged, relocated verbatim from executionEngine.ts -- no existing
 * coverage of that logic exists yet, and re-testing it here is out of
 * scope for this file). This file tests only the manifest/Hat shape and
 * the callback-dispatch mechanism (HatManifest.callbackHandlers,
 * introduced by PRs #203-206) -- that every Marketing Hat declares
 * markettransition/marketdraft/marketpaid, and that findCallbackHandler's
 * resolved handler genuinely reaches handleTransitionApproval's/
 * handleDraftApproval's/handlePaidMediaApproval's real logic.
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
    unit: "Marketing",
    hat: "Marketing Strategist",
    ...overrides,
  } as WorkState;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in marketingManifest test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("marketingManifest: declares all five Marketing Hats", () => {
  assert.strictEqual(marketingManifest.unit, "Marketing");
  assert.deepStrictEqual(
    new Set(Object.keys(marketingManifest.hats)),
    new Set(["Marketing Strategist", "Brand & Communications Strategist", "Content Strategist", "Content Manager", "Digital Marketer"]),
  );
});

test("marketingManifest: every Hat declares exactly markettransition, marketdraft, and marketpaid in callbackHandlers, all pointing to their shared handlers", () => {
  for (const hat of Object.values(marketingManifest.hats)) {
    assert.deepStrictEqual(
      new Set(Object.keys(hat.callbackHandlers ?? {})),
      new Set([MARKET_TRANSITION_CALLBACK_PREFIX, MARKET_DRAFT_CALLBACK_PREFIX, MARKET_PAID_CALLBACK_PREFIX]),
    );
    assert.strictEqual(hat.callbackHandlers?.[MARKET_TRANSITION_CALLBACK_PREFIX], handleTransitionApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_DRAFT_CALLBACK_PREFIX], handleDraftApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_PAID_CALLBACK_PREFIX], handlePaidMediaApproval);
  }
});

test("findCallbackHandler resolves markettransition on Marketing Strategist and genuinely delegates to handleTransitionApproval -- rejecting a pending transition discards it and holds on marketing_feedback, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    pendingTransition: { toHat: "Digital Marketer", reason: "Needs paid media expertise" },
  });

  const hat = marketingManifest.hats["Marketing Strategist"];
  const handler = findCallbackHandler(MARKET_TRANSITION_CALLBACK_PREFIX, hat);
  assert.ok(handler, "markettransition must resolve on Marketing Strategist's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingTransition, undefined);
  assert.strictEqual(result.awaiting, "marketing_feedback");
  assert.strictEqual(result.hat, "Marketing Strategist", "must not commit the Hat transition on rejection");
});

test("findCallbackHandler resolves marketdraft on Marketing Strategist and genuinely delegates to handleDraftApproval -- rejecting a pending draft holds on marketing_feedback without closing the stage, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    stage: "awaiting_marketing_draft_approval",
    marketingDraft: "Some drafted output",
  });

  const hat = marketingManifest.hats["Marketing Strategist"];
  const handler = findCallbackHandler(MARKET_DRAFT_CALLBACK_PREFIX, hat);
  assert.ok(handler, "marketdraft must resolve on Marketing Strategist's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.awaiting, "marketing_feedback");
  assert.strictEqual(result.stage, "awaiting_marketing_draft_approval", "must not advance to complete on rejection");
  assert.strictEqual(result.marketingDraft, "Some drafted output", "must not discard the draft on rejection -- only on approval");
});

test("findCallbackHandler resolves marketpaid on Digital Marketer and genuinely delegates to handlePaidMediaApproval -- rejecting a pending spend action discards it and holds on marketing_feedback without closing the stage, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    hat: "Digital Marketer",
    stage: "awaiting_paid_media_approval",
    pendingPaidMediaAction: { description: "Boost a Facebook post, $200 budget" },
  });

  const hat = marketingManifest.hats["Digital Marketer"];
  const handler = findCallbackHandler(MARKET_PAID_CALLBACK_PREFIX, hat);
  assert.ok(handler, "marketpaid must resolve on Digital Marketer's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingPaidMediaAction, undefined);
  assert.strictEqual(result.awaiting, "marketing_feedback");
  assert.strictEqual(result.stage, "awaiting_paid_media_approval", "must not advance to complete on rejection");
});

test("marketingManifest: awaitingHandlers is empty for every Hat -- Marketing's own continuation states stay in executionEngine.ts's handleTextReply cases", () => {
  for (const hat of Object.values(marketingManifest.hats)) {
    assert.deepStrictEqual(hat.awaitingHandlers, {});
  }
});
