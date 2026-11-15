import test from "node:test";
import assert from "node:assert";
import { AiPolicyExecutor, aiCooldownKey } from "./policy";
import { cooldownUntil } from "../runtime/research/searchProviders";

// Resumable AI calls (Martin's decision, 15 Nov 2026): cooling AI providers
// are skipped, and an all-busy chain reports when one is expected back.

function kv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
}

function provider(id: string, behaviour: () => any, calls: string[]) {
  return {
    id,
    isEligible: () => true,
    execute: async () => {
      calls.push(id);
      return behaviour();
    },
  } as any;
}

const allow = { evaluate: () => ({ allowed: true }) } as any;
const gate = { evaluate: () => ({ allowed: true }) } as any;
const task = { taskId: "research.skill_step", type: "json", messages: [{ role: "user", content: "q" }], boundaryContext: { segments: [] } } as any;
const fail = (statusCode: number) => () => ({ success: false, error: { message: "busy", statusCode } });
const ok = () => ({ success: true, response: { rawText: "{}" } });

test("a rate-limited AI provider cools down and is skipped on the next call", async () => {
  const env = { STATE_KV: kv() } as any;
  const calls: string[] = [];
  const exec = new AiPolicyExecutor([provider("a", fail(429), calls), provider("b", ok, calls)], allow, gate);
  assert.strictEqual((await exec.executeTaskWithOutcome(env, task)).ok, true);
  assert.ok((await cooldownUntil(env, aiCooldownKey("a"))) !== null);
  calls.length = 0;
  await exec.executeTaskWithOutcome(env, task);
  assert.deepStrictEqual(calls, ["b"], "the cooling provider is not asked again");
});

test("when every eligible provider is busy, the outcome carries the earliest time one is expected back", async () => {
  const env = { STATE_KV: kv() } as any;
  const calls: string[] = [];
  const exec = new AiPolicyExecutor([provider("a", fail(503), calls), provider("b", fail(429), calls)], allow, gate);
  const outcome = await exec.executeTaskWithOutcome(env, task);
  assert.strictEqual(outcome.ok, false);
  if (!outcome.ok) {
    assert.strictEqual(outcome.cause, "providers_exhausted");
    assert.ok(outcome.retryAt && Date.parse(outcome.retryAt) > Date.now());
  }
  calls.length = 0;
  const again = await exec.executeTaskWithOutcome(env, task);
  assert.deepStrictEqual(calls, [], "both are cooling: no provider is called");
  if (!again.ok) assert.ok(again.retryAt);
});

test("a refused request (4xx other than 429/408) does not start a cooldown", async () => {
  const env = { STATE_KV: kv() } as any;
  const exec = new AiPolicyExecutor([provider("a", fail(400), []), provider("b", ok, [])], allow, gate);
  await exec.executeTaskWithOutcome(env, task);
  assert.strictEqual(await cooldownUntil(env, aiCooldownKey("a")), null);
});
