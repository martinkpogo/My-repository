/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { AiPolicyExecutor, DEFAULT_PROVIDER_IDS } from "./policy";
import { aiJson, aiText, aiChat } from "../ai";
import {
  AiProvider,
  AiTask,
  InfrastructureError,
  ProviderAdapterResult,
  ProviderId,
} from "./types";
import type { Env } from "../types";
import { DataBoundaryEvaluator } from "../dataBoundary/policy";

class MockProvider implements AiProvider {
  public attempts = 0;

  constructor(
    public readonly id: ProviderId,
    private readonly handler: (task: AiTask, attempt: number) => ProviderAdapterResult,
    private readonly eligible: boolean = true,
  ) {}

  public isEligible(_env: Env, _task: AiTask): boolean {
    return this.eligible;
  }

  public async execute(_env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    this.attempts++;
    return this.handler(task, this.attempts);
  }
}

const fakeEnv = {} as Env;

// Test boundary evaluator granting eligibility for test providers on public chat tasks
const testBoundaryEvaluator = new DataBoundaryEvaluator({
  taskSensitivities: {
    "chat.general_reply": "public",
  },
  providerEligibility: {
    p1: { providerId: "p1", allowedSensitivities: new Set(["public"]) },
    p2: { providerId: "p2", allowedSensitivities: new Set(["public"]) },
    p3: { providerId: "p3", allowedSensitivities: new Set(["public"]) },
  },
});

test("A. Primary provider succeeds", async () => {
  const primary = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: '{"result": "ok"}' },
  }));
  const secondary = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: '{"result": "secondary"}' },
  }));

  const executor = new AiPolicyExecutor([primary, secondary], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.deepEqual(res, { result: "ok" });
  assert.equal(primary.attempts, 1);
  assert.equal(secondary.attempts, 0);
});

test("B. Primary infrastructure failure + eligible secondary -> secondary attempted", async () => {
  const primary = new MockProvider("p1", () => ({
    success: false,
    error: new InfrastructureError("p1", "Quota exhausted", { statusCode: 429 }),
  }));
  const secondary = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: '{"status": "recovered"}' },
  }));

  const executor = new AiPolicyExecutor([primary, secondary], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.deepEqual(res, { status: "recovered" });
  assert.equal(primary.attempts, 1);
  assert.equal(secondary.attempts, 1);
});

test("C. Primary infrastructure failure + no eligible secondary -> safe failure/hold", async () => {
  const primary = new MockProvider("p1", () => ({
    success: false,
    error: new InfrastructureError("p1", "500 Internal Server Error", { statusCode: 500 }),
  }));
  const secondaryIneligible = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: '{"status": "should_not_run"}' },
  }), false);

  const executor = new AiPolicyExecutor([primary, secondaryIneligible], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.equal(res, null);
  assert.equal(primary.attempts, 1);
  assert.equal(secondaryIneligible.attempts, 0);
});

test("D. Malformed JSON output DOES trigger provider fallback -- a garbled answer is no better than no answer", async () => {
  const primary = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: "INVALID_NOT_JSON" },
  }));
  const secondary = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: '{"valid": "json"}' },
  }));

  const executor = new AiPolicyExecutor([primary, secondary], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.deepEqual(res, { valid: "json" });
  assert.equal(primary.attempts, 1);
  assert.equal(secondary.attempts, 1, "Secondary provider must be attempted after primary's malformed output");
});

test("D2. Every eligible provider returning malformed JSON -> safe failure/hold, no infinite loop", async () => {
  const primary = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: "INVALID_NOT_JSON" },
  }));
  const secondary = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: "also not json" },
  }));

  const executor = new AiPolicyExecutor([primary, secondary], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.equal(res, null);
  assert.equal(primary.attempts, 1);
  assert.equal(secondary.attempts, 1);
});

test("E. Secondary infrastructure failure -> safe failure/hold, no infinite loop", async () => {
  const primary = new MockProvider("p1", () => ({
    success: false,
    error: new InfrastructureError("p1", "Timeout", { statusCode: 504 }),
  }));
  const secondary = new MockProvider("p2", () => ({
    success: false,
    error: new InfrastructureError("p2", "Connection reset", { statusCode: 502 }),
  }));

  const executor = new AiPolicyExecutor([primary, secondary], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.equal(res, null);
  assert.equal(primary.attempts, 1);
  assert.equal(secondary.attempts, 1);
});

test("F. No eligible provider -> fail closed", async () => {
  const primary = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: "ok" },
  }), false);

  const executor = new AiPolicyExecutor([primary], testBoundaryEvaluator);
  const resJson = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);
  const resText = await aiText(fakeEnv, "chat.general_reply", "s", "u", {}, executor);
  const resChat = await aiChat(fakeEnv, "chat.general_reply", "s", [], "u", 800, undefined, executor);

  assert.equal(resJson, null);
  assert.equal(resText, "");
  assert.equal(resChat, "");
  assert.equal(primary.attempts, 0);
});

test("Additional: Fallback attempts each eligible provider at most once", async () => {
  const p1 = new MockProvider("p1", () => ({
    success: false,
    error: new InfrastructureError("p1", "Failed"),
  }));
  const p2 = new MockProvider("p2", () => ({
    success: false,
    error: new InfrastructureError("p2", "Failed"),
  }));

  // Duplicate provider instances in array to test at-most-once execution
  const executor = new AiPolicyExecutor([p1, p1, p2, p2], testBoundaryEvaluator);
  const res = await aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);

  assert.equal(res, null);
  assert.equal(p1.attempts, 1);
  assert.equal(p2.attempts, 1);
});

test("Additional: Provider ordering is deterministic", async () => {
  const executionOrder: string[] = [];

  const p1 = new MockProvider("p1", () => {
    executionOrder.push("p1");
    return { success: false, error: new InfrastructureError("p1", "Fail") };
  });
  const p2 = new MockProvider("p2", () => {
    executionOrder.push("p2");
    return { success: false, error: new InfrastructureError("p2", "Fail") };
  });
  const p3 = new MockProvider("p3", () => {
    executionOrder.push("p3");
    return { success: true, response: { rawText: "hello" } };
  });

  const executor = new AiPolicyExecutor([p1, p2, p3], testBoundaryEvaluator);
  const res = await aiText(fakeEnv, "chat.general_reply", "s", "u", {}, executor);

  assert.equal(res, "hello");
  assert.deepEqual(executionOrder, ["p1", "p2", "p3"]);
});

test("Additional: Empty text result caused by provider infrastructure failure fails closed to empty string", async () => {
  const primary = new MockProvider("p1", () => ({
    success: false,
    error: new InfrastructureError("p1", "Infrastructure failure 500"),
  }));

  const executor = new AiPolicyExecutor([primary], testBoundaryEvaluator);
  const resText = await aiText(fakeEnv, "chat.general_reply", "system", "user", {}, executor);

  assert.equal(resText, "");
});

// --- WP3: executeTaskWithOutcome reports WHY a call produced nothing --------

/** A json-mode chat.general_reply task, built exactly like aiJson builds one. */
function wp3JsonTask(user: string): AiTask {
  const systemContent = "s\n\nRespond with a single valid JSON object only. No prose, no markdown fences, no commentary before or after the JSON.";
  return {
    taskId: "chat.general_reply",
    boundaryContext: {
      segments: [
        { type: "system", content: systemContent, provenance: "chat.general_reply:system" },
        { type: "user", content: user, provenance: "chat.general_reply:user" },
      ],
    },
    type: "json",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: 2048,
    validateResponse: (raw: string) => {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end < start) return false;
      try {
        JSON.parse(raw.slice(start, end + 1));
        return true;
      } catch {
        return false;
      }
    },
  };
}

test("WP3. Every eligible provider gate-blocked -> outbound_gate_blocked carrying the gate's distinct reason CODES only; legacy executeTask still returns null", async () => {
  const primary = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: '{"result": "ok"}' },
  }));
  const executor = new AiPolicyExecutor([primary], testBoundaryEvaluator);
  const gateTask = () => wp3JsonTask("The situation concerns Hotel Group pricing strategy for a subscription business.");

  const outcome = await executor.executeTaskWithOutcome(fakeEnv, gateTask());

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.cause, "outbound_gate_blocked", "every provider the call processed was refused by the Outbound Data Gate");
    assert.deepEqual(outcome.gateReasons, ["COMPANY_SUFFIX_DETECTED"], "codes only -- the distinct reasonCategory, never payload content");
  }
  assert.equal(primary.attempts, 0, "the gate blocks before any provider executes");

  // The existing null-returning method is unchanged for every other caller.
  const legacy = await executor.executeTask(fakeEnv, gateTask());
  assert.equal(legacy, null);
  assert.equal(primary.attempts, 0, "executeTask behaves identically on the same gate refusal");
});

test("WP3. Mixed infra + malformed failures -> providers_exhausted; all-malformed -> unparseable", async () => {
  const infra = new MockProvider("p1", () => ({
    success: false,
    error: new InfrastructureError("p1", "Quota exhausted", { statusCode: 429 }),
  }));
  const malformed = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: "INVALID_NOT_JSON" },
  }));
  const mixedExecutor = new AiPolicyExecutor([infra, malformed], testBoundaryEvaluator);

  const mixed = await mixedExecutor.executeTaskWithOutcome(fakeEnv, wp3JsonTask("plain situation text"));
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.equal(mixed.cause, "providers_exhausted", "an infrastructure failure anywhere in the call dominates: nothing points a human at rewording");
    assert.deepEqual(mixed.gateReasons, [], "the gate never blocked anything");
  }

  const q1 = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: "INVALID_NOT_JSON" },
  }));
  const q2 = new MockProvider("p2", () => ({
    success: true,
    response: { rawText: "also not json" },
  }));
  const allMalformedExecutor = new AiPolicyExecutor([q1, q2], testBoundaryEvaluator);

  const allMalformed = await allMalformedExecutor.executeTaskWithOutcome(fakeEnv, wp3JsonTask("plain situation text"));
  assert.equal(allMalformed.ok, false);
  if (!allMalformed.ok) {
    assert.equal(allMalformed.cause, "unparseable", "every provider answered but none produced parseable output");
  }
});

test("WP3. Success outcome is unchanged -- ok plus the very response executeTask returns", async () => {
  const p1 = new MockProvider("p1", () => ({
    success: true,
    response: { rawText: '{"result": "ok"}' },
  }));
  const executor = new AiPolicyExecutor([p1], testBoundaryEvaluator);

  const outcome = await executor.executeTaskWithOutcome(fakeEnv, wp3JsonTask("plain situation text"));
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.response.rawText, '{"result": "ok"}');
  }

  const legacy = await executor.executeTask(fakeEnv, wp3JsonTask("plain situation text"));
  assert.equal(legacy?.rawText, '{"result": "ok"}', "executeTask returns the identical response on success");
  assert.equal(p1.attempts, 2, "both methods ran the same provider loop");
});


/** Advances mock timers in small steps, letting promise chains between timers run (the countdown waits in 5s ticks). */
async function advance(t: any, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 100) {
    t.mock.timers.tick(Math.min(100, ms - done));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
}

test("Last resort (Martin, 2026-11-13, A): every provider failed but one named a short wait -> wait it out and try that provider once more", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const limited = new MockProvider("p1", (_task, attempt) =>
    attempt === 1
      ? { success: false, error: new InfrastructureError("p1", "429 try again in 25s", { statusCode: 429, retryAfterMs: 25_000 }) }
      : { success: true, response: { rawText: '{"result": "after the wait"}' } },
  );
  const broken = new MockProvider("p2", () => ({ success: false, error: new InfrastructureError("p2", "402 payment required", { statusCode: 402 }) }));
  const executor = new AiPolicyExecutor([limited, broken], testBoundaryEvaluator);
  const pending = aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(limited.attempts, 1, "waiting, not yet retried");
  await advance(t, 25_000);
  assert.equal(limited.attempts, 1, "still inside the 0.5s margin");
  await advance(t, 600);
  assert.deepEqual(await pending, { result: "after the wait" });
  assert.equal(limited.attempts, 2);
  assert.equal(broken.attempts, 1, "the other provider is not tried again");
});

test("Last resort: a wait over 60s is not waited out; a failed retry is not repeated; the retry is once per call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const tooLong = new MockProvider("p1", () => ({ success: false, error: new InfrastructureError("p1", "429", { statusCode: 429, retryAfterMs: 61_000 }) }));
  const outcome = await new AiPolicyExecutor([tooLong], testBoundaryEvaluator).executeTaskWithOutcome(fakeEnv, {
    taskId: "chat.general_reply",
    type: "json",
    messages: [{ role: "user", content: "u" }],
    boundaryContext: { taskSensitivity: "public", segments: [{ type: "user", content: "u", provenance: "test" }] },
  } as any);
  assert.equal(outcome.ok, false);
  assert.equal(tooLong.attempts, 1, "61s is over the last-resort cap: no wait, no retry");

  const stillLimited = new MockProvider("p1", () => ({ success: false, error: new InfrastructureError("p1", "429", { statusCode: 429, retryAfterMs: 5_000 }) }));
  const pending = new AiPolicyExecutor([stillLimited], testBoundaryEvaluator).executeTaskWithOutcome(fakeEnv, {
    taskId: "chat.general_reply",
    type: "json",
    messages: [{ role: "user", content: "u" }],
    boundaryContext: { taskSensitivity: "public", segments: [{ type: "user", content: "u", provenance: "test" }] },
  } as any);
  await advance(t, 6_000);
  const second = await pending;
  assert.equal(second.ok, false);
  assert.equal(stillLimited.attempts, 2, "exactly one retry -- never a loop");
});

test("Last resort countdown (Martin, 2026-11-13): the wait counts down in place every 5s, then the line returns to the step's own wording", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { withLiveStatus } = await import("../runtime/liveStatus");
  const trail: string[] = [];
  const sink = {
    hatStatusOpen: () => true,
    setDetail: (d: string | undefined) => void (d && trail.push(d)),
    resolveDetail: (from: string, to: string) => {
      const i = trail.lastIndexOf(from);
      if (i >= 0) trail[i] = to;
      else trail.push(to);
    },
    refresh: async () => {},
  };
  const limited = new MockProvider("p1", (_task, attempt) =>
    attempt === 1
      ? { success: false, error: new InfrastructureError("p1", "429", { statusCode: 429, retryAfterMs: 11_000 }) }
      : { success: true, response: { rawText: '{"result": "ok"}' } },
  );
  const executor = new AiPolicyExecutor([limited], testBoundaryEvaluator);
  const seen: string[] = [];
  const pending = withLiveStatus({} as Env, { chatId: -1, header: "H" }, async () => {
    const call = aiJson(fakeEnv, { taskId: "chat.general_reply", system: "s", user: "u" }, executor);
    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    await flush();
    seen.push(trail.at(-1)!);
    for (const ms of [5_000, 5_000, 1_500]) {
      await advance(t, ms);
      await flush();
      seen.push(trail.at(-1)!);
    }
    return call;
  }, () => "succeeded", sink);
  assert.deepEqual(await pending, { result: "ok" });
  assert.deepEqual(seen, [
    "Waiting 12s for an AI provider's rate limit",
    "Waiting 7s for an AI provider's rate limit",
    "Waiting 2s for an AI provider's rate limit",
    "Writing the reply",
  ]);
  assert.equal(trail.filter((l) => l.startsWith("Waiting")).length, 0, "edited in place: no countdown line is left behind");
});

test("Last resort cap is 60s (Martin, 2026-11-14): Groq's 33s wait after a research run is waited out", async () => {
  const { LAST_RESORT_MAX_WAIT_MS } = await import("./policy");
  assert.equal(LAST_RESORT_MAX_WAIT_MS, 60_000);
  assert.ok(33_210 <= LAST_RESORT_MAX_WAIT_MS);
});

test("fallback chain (Martin, 2026-11-14, free-tier option A): Workers AI, Groq, OpenRouter, Gemini, SambaNova -- NVIDIA NIM and Cerebras are out", () => {
  assert.deepEqual([...DEFAULT_PROVIDER_IDS], ["workers-ai", "groq", "openrouter", "gemini", "sambanova"]);
});
