import test from "node:test";
import assert from "node:assert";
import { researchManifest, dispatchResearchHat, RESEARCH_HANDOFF_CALLBACK_PREFIX } from "./researchManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers researchManifest.ts's own declared contract -- the thin Unit
 * Registry wiring around Research & Intelligence Analyst's existing,
 * already-tested handleDirectRequest/handleResearchHandoffApproval (see
 * capabilityPackage.test.ts for that capability's own real behavior). This
 * file tests only what researchManifest.ts itself contributes: the
 * manifest/Hat shape, that entryHandler correctly delegates to its
 * wrapped implementation, and the callback-dispatch mechanism
 * (HatManifest.callbackHandlers, introduced by PRs #203-211) -- that
 * Research & Intelligence Analyst declares researchhandoff, and that
 * findCallbackHandler's resolved handler genuinely reaches
 * handleResearchHandoffApproval's real logic.
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
    unit: "Research & Intelligence",
    hat: "Research & Intelligence Analyst",
    ...overrides,
  } as WorkState;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in researchManifest test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

// Telegram-only + failing Notion fetch -- drives handleDirectRequest into
// requireSafeContext's own fail-closed path (Research-Safe Consultancy
// Context retrieval failure), the cheapest way to prove entryHandler
// genuinely reaches the real function without re-testing its full
// protocol-selection/synthesis pipeline (already covered by
// capabilityPackage.test.ts).
function mockTelegramAndFailingNotionFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ object: "error", status: 404 }), { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("researchManifest: declares exactly R&I's Research & Intelligence Analyst Hat", () => {
  assert.strictEqual(researchManifest.unit, "Research & Intelligence");
  assert.deepStrictEqual(Object.keys(researchManifest.hats), ["Research & Intelligence Analyst"]);
});

test("researchManifest: Research & Intelligence Analyst declares exactly one action, research, as 'write' requiring approval", () => {
  const hat = researchManifest.hats["Research & Intelligence Analyst"];
  assert.strictEqual(hat.actions.length, 1);
  assert.strictEqual(hat.actions[0].name, "research");
  assert.strictEqual(hat.actions[0].consequence, "write");
  assert.strictEqual(hat.actions[0].requiresApproval, true);
});

test("researchManifest: readHandler fails closed -- no read action is declared", async () => {
  const hat = researchManifest.hats["Research & Intelligence Analyst"];
  await assert.rejects(
    () => hat.readHandler(fakeEnv(), "research", "text"),
    /not a read action -- Research & Intelligence Analyst only declares "research"/,
  );
});

test("researchManifest: awaitingHandlers is empty -- R&I's own continuation states stay hardcoded in session.ts", () => {
  const hat = researchManifest.hats["Research & Intelligence Analyst"];
  assert.deepStrictEqual(hat.awaitingHandlers, {});
});

test("researchManifest: declares exactly researchhandoff in callbackHandlers", () => {
  const hat = researchManifest.hats["Research & Intelligence Analyst"];
  assert.deepStrictEqual(Object.keys(hat.callbackHandlers ?? {}), [RESEARCH_HANDOFF_CALLBACK_PREFIX]);
});

test("findCallbackHandler resolves researchhandoff on Research & Intelligence Analyst and genuinely delegates to handleResearchHandoffApproval -- rejecting a pending handoff clears it and replies, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    pendingResearchHandoff: { unit: "Sales", hat: "Sales Executive", reason: "Test reason", handoffTitle: "Test handoff", verifiedFactsAndSources: "Test facts" },
  });

  const hat = researchManifest.hats["Research & Intelligence Analyst"];
  const handler = findCallbackHandler(RESEARCH_HANDOFF_CALLBACK_PREFIX, hat);
  assert.ok(handler, "researchhandoff must resolve on Research & Intelligence Analyst's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.pendingResearchHandoff, undefined);
});

test("researchManifest: entryHandler/dispatchResearchHat genuinely delegates to capabilityPackage.ts's handleDirectRequest -- sets researchQuestion/researchContext from the real text and fails closed when governance retrieval fails, proving real delegation", async (t) => {
  mockTelegramAndFailingNotionFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState();

  const hat = researchManifest.hats["Research & Intelligence Analyst"];
  const result = await hat.entryHandler(env, state, "research", "What's the competitive landscape for Acme's positioning?");

  assert.strictEqual(result.researchQuestion, "What's the competitive landscape for Acme's positioning?");
  assert.strictEqual(result.stage, "research_blocked");

  const viaDispatch = await dispatchResearchHat(env, fakeWorkState(), "Another research question");
  assert.strictEqual(viaDispatch.stage, "research_blocked");
});
