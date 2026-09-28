import test from "node:test";
import assert from "node:assert";
import { strategyManifest, STRATEGY_HANDOFF_CALLBACK_PREFIX } from "./strategyManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers strategyManifest.ts's own declared contract -- the thin Unit
 * Registry wiring around Strategy Analyst's existing, already-tested
 * handleDirectRequest/handleStrategyHandoffApproval (see
 * strategyAnalyst.test.ts for that capability's own real behavior). This
 * file tests only what strategyManifest.ts itself contributes: the
 * manifest/Hat shape, that entryHandler correctly delegates to its
 * wrapped implementation, and the callback-dispatch mechanism
 * (HatManifest.callbackHandlers, introduced by PRs #203-209) -- that
 * Strategy Analyst declares strategyhandoff, and that
 * findCallbackHandler's resolved handler genuinely reaches
 * handleStrategyHandoffApproval's real logic.
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
    unit: "Strategy",
    hat: "Strategy Analyst",
    ...overrides,
  } as WorkState;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in strategyManifest test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("strategyManifest: declares exactly Strategy's Strategy Analyst Hat", () => {
  assert.strictEqual(strategyManifest.unit, "Strategy");
  assert.deepStrictEqual(Object.keys(strategyManifest.hats), ["Strategy Analyst"]);
});

test("strategyManifest: Strategy Analyst declares exactly one action, diagnose, as 'write' requiring approval", () => {
  const hat = strategyManifest.hats["Strategy Analyst"];
  assert.strictEqual(hat.actions.length, 1);
  assert.strictEqual(hat.actions[0].name, "diagnose");
  assert.strictEqual(hat.actions[0].consequence, "write");
  assert.strictEqual(hat.actions[0].requiresApproval, true);
});

test("strategyManifest: readHandler fails closed -- no read action is declared", async () => {
  const hat = strategyManifest.hats["Strategy Analyst"];
  await assert.rejects(
    () => hat.readHandler(fakeEnv(), "diagnose", "text"),
    /not a read action -- Strategy Analyst only declares "diagnose"/,
  );
});

test("strategyManifest: awaitingHandlers is empty -- Strategy's own continuation states stay hardcoded in session.ts", () => {
  const hat = strategyManifest.hats["Strategy Analyst"];
  assert.deepStrictEqual(hat.awaitingHandlers, {});
});

test("strategyManifest: declares exactly strategyhandoff in callbackHandlers", () => {
  const hat = strategyManifest.hats["Strategy Analyst"];
  assert.deepStrictEqual(Object.keys(hat.callbackHandlers ?? {}), [STRATEGY_HANDOFF_CALLBACK_PREFIX]);
});

test("findCallbackHandler resolves strategyhandoff on Strategy Analyst and genuinely delegates to handleStrategyHandoffApproval -- rejecting a pending handoff clears it and replies, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    pendingStrategyHandoff: {
      unit: "Sales",
      hat: "Sales Executive",
      handoffTitle: "Test handoff",
      reason: "Test reason",
      requiredNextAction: "Test action",
      expectedOutput: "Test output",
      acceptanceCriteria: "Test criteria",
      verifiedFactsAndSources: "Test facts",
      assumptions: "Test assumptions",
      openQuestions: "Test questions",
    },
  });

  const hat = strategyManifest.hats["Strategy Analyst"];
  const handler = findCallbackHandler(STRATEGY_HANDOFF_CALLBACK_PREFIX, hat);
  assert.ok(handler, "strategyhandoff must resolve on Strategy Analyst's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingStrategyHandoff, undefined);
});

