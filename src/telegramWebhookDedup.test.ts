import test from "node:test";
import assert from "node:assert";
import { claimTelegramUpdate } from "./telegramDedup";
import type { Env } from "./types";

/**
 * Telegram redelivers an update when the webhook answers too slowly -- and a
 * run that researches online can be that slow. A redelivered update must
 * never run twice (2026-11-13: one Confirm tap produced two drafts).
 */
function env(store = new Map<string, string>(), failGet = false): Env {
  return {
    STATE_KV: {
      get: async (k: string) => {
        if (failGet) throw new Error("kv down");
        return store.get(k) ?? null;
      },
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async () => {},
    },
  } as unknown as Env;
}

test("claimTelegramUpdate: the first delivery is processed, a redelivery of the same update_id is not", async () => {
  const e = env();
  assert.strictEqual(await claimTelegramUpdate(e, 4242), true);
  assert.strictEqual(await claimTelegramUpdate(e, 4242), false);
  assert.strictEqual(await claimTelegramUpdate(e, 4243), true, "a different update is unaffected");
});

test("claimTelegramUpdate: never drops an update -- no update_id, or KV unreadable, means process it", async () => {
  assert.strictEqual(await claimTelegramUpdate(env(), undefined), true);
  assert.strictEqual(await claimTelegramUpdate(env(new Map(), true), 7), true);
});
