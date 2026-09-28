import test from "node:test";
import assert from "node:assert";
import { salesManifest } from "./salesManifest";
import { findUnitManifest } from "../registry";
import type { Env, WorkState } from "../../types";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    MARTIN_TELEGRAM_USER_ID: "123456",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "604",
    OPERATIONS_TOPIC_ID: "588",
    TELEGRAM_BOT_TOKEN: "test-token",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
    ...overrides,
  } as Env;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  const sent: { chatId: number; threadId?: number; text: string }[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).includes("api.telegram.org")) {
      try {
        const body = JSON.parse(init?.body ?? "{}");
        sent.push({ chatId: body.chat_id, threadId: body.message_thread_id, text: body.text ?? "" });
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return sent;
}

test("salesManifest is registered in UNIT_MANIFESTS and contains both Hats", () => {
  const manifest = findUnitManifest("Sales");
  assert.ok(manifest);
  assert.strictEqual(manifest?.unit, "Sales");
  assert.ok(manifest?.hats["Lead Generation Specialist"]);
  assert.ok(manifest?.hats["Sales Executive"]);
});

test("Lead Generation Specialist declares discover_leads as a read action", () => {
  const lgsHat = salesManifest.hats["Lead Generation Specialist"];
  assert.strictEqual(lgsHat.actions.length, 1);
  assert.strictEqual(lgsHat.actions[0].name, "discover_leads");
  assert.strictEqual(lgsHat.actions[0].consequence, "read");
});

test("Sales Executive entryHandler blocks new_enquiry when SALES_DIRECT_ENTRY_PAUSED is true", async (t) => {
  const sent = mockTelegramFetch(t);
  const seHat = salesManifest.hats["Sales Executive"];
  const env = fakeEnv();
  const initialState: WorkState = {
    workId: "w1",
    chatId: 100,
    threadId: 604,
    unit: "Sales",
    hat: "Sales Executive",
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const newState = await seHat.entryHandler(env, initialState, "new_enquiry", "Hello, we want to engage ENIG.");
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Sales Executive intake is paused here in this runtime by standing policy/);
  assert.strictEqual(newState.stage, "new");
});

test("Sales Executive awaitingHandlers has all required awaiting state keys", () => {
  const seHat = salesManifest.hats["Sales Executive"];
  const keys = Object.keys(seHat.awaitingHandlers);
  const expectedKeys = [
    "call_notes",
    "intervention",
    "value_context_more",
    "proposal_feedback",
    "matter_redo_reason",
    "entity_redo_reason",
    "sales_proposal_revision",
  ];
  for (const k of expectedKeys) {
    assert.ok(keys.includes(k), `Missing awaitingHandler key: ${k}`);
  }
});
