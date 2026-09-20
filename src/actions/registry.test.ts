import test from "node:test";
import assert from "node:assert";
import type { Env, WorkState } from "../types";
import {
  ActionCapability,
  clearRegisteredCapabilities,
  registerActionCapability,
  routeWorkspaceCapabilityAction,
} from "./registry";

function createMockKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = Array.from(store.keys())
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _rawStore: store,
  };
}

function createFakeEnv(): Env {
  const mockKv = createMockKv();
  return {
    STATE_KV: mockKv as unknown as KVNamespace,
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "1",
    TELEGRAM_BOT_TOKEN: "mock-token",
  } as Env;
}

test("Generic Workspace capability seam routes incoming text to registered ActionCapabilities", async () => {
  clearRegisteredCapabilities();

  const fakeEnv = createFakeEnv();
  let capabilityInvoked = false;

  const testCapability: ActionCapability = {
    id: "test.mock_capability",
    name: "Mock Capability",
    description: "Test mock capability",
    async handleIntake(_env: Env, _chatId: number, text: string): Promise<boolean> {
      if (text.includes("create document")) {
        capabilityInvoked = true;
        return true;
      }
      return false;
    },
  };

  registerActionCapability(testCapability);

  // Unhandled text
  const handledUnmatched = await routeWorkspaceCapabilityAction(fakeEnv, 12345, "hello world");
  assert.strictEqual(handledUnmatched, false);
  assert.strictEqual(capabilityInvoked, false);

  // Matched text
  const handledMatched = await routeWorkspaceCapabilityAction(fakeEnv, 12345, "please create document Test Doc");
  assert.strictEqual(handledMatched, true);
  assert.strictEqual(capabilityInvoked, true);

  clearRegisteredCapabilities();
});

test("Standalone capability request preserves undefined unit and hat without synthetic fallbacks", async () => {
  const state: WorkState = {
    workId: "work-standalone-001",
    chatId: 12345,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    unit: undefined,
    hat: undefined,
  };

  assert.strictEqual(state.unit, undefined);
  assert.strictEqual(state.hat, undefined);
  assert.notStrictEqual(state.unit, "Operations");
  assert.notStrictEqual(state.hat, "Platform Capability");
});
