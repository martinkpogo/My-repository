import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "./types";
import { startFollowOnWork } from "./followOnWork";

/**
 * The post-approval "Next: hand this to <Hat>?" Yes (2026-11-18 review): the
 * next Hat's part is a NEW Work, started like a Hat Martin confirms on ENIG's
 * offer -- the finished Work is never reopened under another Hat.
 */
function harness() {
  const calls: { init: unknown[][]; confirmed: string[]; stubIds: string[] } = { init: [], confirmed: [], stubIds: [] };
  const kv = new Map<string, string>();
  const env = {
    STATE_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) },
    WORK_SESSION: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        calls.stubIds.push(id);
        return {
          init: async (...args: unknown[]) => void calls.init.push(args),
          handleConfirmedMarketingRequest: async (text: string) => void calls.confirmed.push(text),
        };
      },
    },
  } as unknown as Env;
  return { env, calls, kv };
}

test("a follow-on starts a NEW Work for the next Hat, in the same chat and thread, with the approved output as its input", async () => {
  const { env, calls, kv } = harness();
  const workId = await startFollowOnWork(env, {
    unit: "Marketing",
    chatId: -100,
    threadId: 604,
    followOnWork: { hat: "Content Strategist", text: "The approved strategy.\n\nNext step: turn it into content themes." },
  });
  assert.ok(workId, "a new Work id is returned");
  assert.deepEqual(calls.stubIds, [workId], "the new Work's own session, not the finished one");
  assert.deepEqual(calls.init, [[workId, -100, "Marketing", "Content Strategist", 604]]);
  assert.deepEqual(calls.confirmed, ["The approved strategy.\n\nNext step: turn it into content themes."]);
  assert.ok([...kv.values()].includes(workId!), "the thread's active Work points at the new Work");
});

test("nothing is started without a follow-on, or for a Unit with no next-step entry", async () => {
  const { env, calls } = harness();
  assert.equal(await startFollowOnWork(env, { unit: "Marketing", chatId: 1, threadId: 2 }), undefined);
  assert.equal(await startFollowOnWork(env, { unit: "Strategy", chatId: 1, threadId: 2, followOnWork: { hat: "Strategy Analyst", text: "x" } }), undefined);
  assert.deepEqual(calls.init, []);
});
