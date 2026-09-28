import test from "node:test";
import assert from "node:assert";
import { salesManifest } from "./salesManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers salesManifest.ts's own declared contract -- the thin Unit
 * Registry wiring around Lead Generation Specialist's existing,
 * already-tested discoverLeadsReadHandler (see
 * leadGenerationDiscovery.test.ts for that capability's own real
 * behavior). This file tests only what salesManifest.ts itself
 * contributes: the manifest/Hat shape, that readHandler correctly
 * delegates to discoverLeadsReadHandler, and that entryHandler fails
 * closed since no internal/write action is declared -- mirroring the
 * level of coverage strategyManifest.ts/marketingManifest.ts's own thin
 * wrappers rely on their wrapped implementation's tests for, rather than
 * re-testing LeadOpportunityDiscoveryCapability's own logic here.
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
    unit: "Sales",
    hat: "Lead Generation Specialist",
    ...overrides,
  } as WorkState;
}

test("salesManifest: declares exactly Sales's Lead Generation Specialist Hat, not Sales Executive", () => {
  assert.strictEqual(salesManifest.unit, "Sales");
  assert.deepStrictEqual(Object.keys(salesManifest.hats), ["Lead Generation Specialist"]);
});

test("salesManifest: Lead Generation Specialist declares exactly one action, discover_leads, as 'read'", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.strictEqual(hat.actions.length, 1);
  assert.strictEqual(hat.actions[0].name, "discover_leads");
  assert.strictEqual(hat.actions[0].consequence, "read");
  assert.ok(hat.actions[0].description.trim().length > 0);
});

test("salesManifest: Lead Generation Specialist's responsibility statement is a real, non-empty description", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.ok(hat.responsibility.trim().length > 0);
});

test("salesManifest: readHandler delegates discover_leads to discoverLeadsReadHandler -- classified as a discovery request sends its own message and returns empty", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const body = String(init?.body ?? "");
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (body.includes("on-demand discovery capability")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isDiscoveryRequest: false }) } }] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in salesManifest readHandler test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const hat = salesManifest.hats["Lead Generation Specialist"];
  const reply = await hat.readHandler(fakeEnv({ GROQ_API_KEY: "key" } as any), "discover_leads", "How's it going?");

  assert.match(reply, /didn't look like a discovery request to Lead Generation Specialist/);
});

test("salesManifest: entryHandler fails closed -- no internal/write action is declared on Lead Generation Specialist", async () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  await assert.rejects(
    () => hat.entryHandler(fakeEnv(), fakeWorkState(), "discover_leads", "text"),
    /not an internal\/write action on Lead Generation Specialist/,
  );
});

test("salesManifest: awaitingHandlers is empty -- Lead Generation Specialist has no multi-turn hold/resume flow", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.deepStrictEqual(hat.awaitingHandlers, {});
});

test("salesManifest: registers Stage 1/2 SemanticTaskIds required by UnitManifest's shape", () => {
  assert.strictEqual(salesManifest.intakeClassificationTaskId, "sales.intake_classification");
  assert.strictEqual(salesManifest.actionClassificationTaskId, "sales.hat_action_decision");
  assert.ok(salesManifest.intakeIntroLine.trim().length > 0);
});
