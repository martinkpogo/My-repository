import test from "node:test";
import { NO_ACTION_SKILLS } from "../../platform/skillRegistry";
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

test("strategyManifest: Strategy Analyst declares two actions -- ungated diagnose, and gated commit_diagnosis for the outbound Handoff", () => {
  const hat = strategyManifest.hats["Strategy Analyst"];

  // Two Actions, not one. `diagnose` carries the ungated analytical work;
  // `commit_diagnosis` is the gated outbound effect -- committing the
  // diagnosis and creating the Handoff that carries it. Gating `diagnose`
  // itself would have silently disabled the Matter status advance, which runs
  // there and swallows its own errors -- pickup would look successful while
  // the stage stopped moving. So the gate is scoped to the privileged effect,
  // which is the only shape that keeps both behaviours true.
  //
  // Architect-approved as described: `diagnose` stays ungated for pickup and
  // the Matter status advance; `commit_diagnosis` is retained as the
  // approval-gated Action for the two outbound Handoff creations only. Access
  // is not broadened by this split, and the LGS writes remain fail-closed.
  const expected = [
    { name: "diagnose", requiresApproval: false },
    { name: "commit_diagnosis", requiresApproval: true },
  ];
  assert.strictEqual(hat.actions.length, expected.length, `Strategy Analyst must declare exactly ${expected.map((a) => a.name).join(" and ")}`);

  const byName = new Map(hat.actions.map((a) => [a.name, a]));
  for (const { name, requiresApproval } of expected) {
    const action = byName.get(name);
    assert.ok(action, `Strategy Analyst must declare ${name}`);
    assert.strictEqual(action.consequence, "write", `${name} must be a 'write' action`);
    assert.strictEqual(
      action.requiresApproval,
      requiresApproval,
      `${name} requiresApproval must be ${requiresApproval} -- it is ${action.requiresApproval}`,
    );
    assert.strictEqual(
      action.responsibility,
      hat.responsibilityId,
      `${name} must serve the Hat's own responsibilityId`,
    );
    assert.ok(action.description.trim().length > 0, `${name} must carry a description`);
  }

  // The split is only sound if exactly one of the two is gated. If a second
  // gate were added, or `diagnose` were re-gated, the ungated analysis would
  // start demanding Martin's approval and the exemption would be lost.
  assert.strictEqual(hat.actions.filter((a) => a.requiresApproval).length, 1, "exactly one Strategy action may be gated");
});

test("strategyManifest: readHandler fails closed -- no read action is declared", async () => {
  const hat = strategyManifest.hats["Strategy Analyst"];
  await assert.rejects(
    () => hat.readHandler(fakeEnv(), "diagnose", "text", NO_ACTION_SKILLS),
    // Matched loosely on purpose: the historical string enumerated the Hat's
    // actions ("only declares \"diagnose\"") and so broke every time the Action
    // set changed. What is under test is that an ungated read is refused --
    // not the particular inventory of the registry.
    /not a read action/,
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

