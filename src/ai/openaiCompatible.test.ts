import test from "node:test";
import assert from "node:assert";
import {
  CEREBRAS_PROVIDER,
  GEMINI_PROVIDER,
  GROQ_PROVIDER,
  NVIDIA_NIM_PROVIDER,
  OPENROUTER_PROVIDER,
  OpenAiCompatibleProvider,
  SAMBANOVA_PROVIDER,
} from "./openaiCompatible";
import type { AiTask } from "./types";

const dummyTask: AiTask = {
  taskId: "chat.general_reply",
  boundaryContext: { segments: [] },
  type: "text",
  messages: [{ role: "user", content: "hello" }],
};

test("each fallback provider is ineligible when its own API key isn't configured", () => {
  assert.strictEqual(NVIDIA_NIM_PROVIDER.isEligible({} as any, dummyTask), false);
  assert.strictEqual(GROQ_PROVIDER.isEligible({} as any, dummyTask), false);
  assert.strictEqual(OPENROUTER_PROVIDER.isEligible({} as any, dummyTask), false);
  assert.strictEqual(CEREBRAS_PROVIDER.isEligible({} as any, dummyTask), false);
  assert.strictEqual(GEMINI_PROVIDER.isEligible({} as any, dummyTask), false);
  assert.strictEqual(SAMBANOVA_PROVIDER.isEligible({} as any, dummyTask), false);
});

test("each fallback provider becomes eligible once its own API key is set -- unrelated providers stay ineligible", () => {
  assert.strictEqual(NVIDIA_NIM_PROVIDER.isEligible({ NVIDIA_NIM_API_KEY: "key" } as any, dummyTask), true);
  assert.strictEqual(GROQ_PROVIDER.isEligible({ NVIDIA_NIM_API_KEY: "key" } as any, dummyTask), false);
  assert.strictEqual(GROQ_PROVIDER.isEligible({ GROQ_API_KEY: "key" } as any, dummyTask), true);
  assert.strictEqual(CEREBRAS_PROVIDER.isEligible({ GROQ_API_KEY: "key" } as any, dummyTask), false);
  assert.strictEqual(CEREBRAS_PROVIDER.isEligible({ CEREBRAS_API_KEY: "key" } as any, dummyTask), true);
  assert.strictEqual(GEMINI_PROVIDER.isEligible({ CEREBRAS_API_KEY: "key" } as any, dummyTask), false);
  assert.strictEqual(GEMINI_PROVIDER.isEligible({ GEMINI_API_KEY: "key" } as any, dummyTask), true);
  assert.strictEqual(SAMBANOVA_PROVIDER.isEligible({ GEMINI_API_KEY: "key" } as any, dummyTask), false);
  assert.strictEqual(SAMBANOVA_PROVIDER.isEligible({ SAMBANOVA_API_KEY: "key" } as any, dummyTask), true);
});

test("a custom OpenAiCompatibleProvider carries the configured provider id", () => {
  const provider = new OpenAiCompatibleProvider({
    id: "custom-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
  });
  assert.strictEqual(provider.id, "custom-provider");
});

test("a provider whose fetch is aborted (slow/hung upstream) reports a clear timeout error, not a raw AbortError", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleProvider({
    id: "slow-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
    timeoutMs: 5,
  });

  const result = await provider.execute({ GROQ_API_KEY: "key" } as any, dummyTask);

  assert.strictEqual(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /timed out after \d+ms/);
  }
});

test("a 429 naming a short wait via the standard Retry-After header is retried once and succeeds if the retry does", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0.01" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleProvider({
    id: "flaky-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
  });

  const result = await provider.execute({ GROQ_API_KEY: "key" } as any, dummyTask);

  assert.strictEqual(callCount, 2, "must retry exactly once after the named wait");
  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.strictEqual(result.response.rawText, "ok");
  }
});

test("a 429 naming its wait in the body text (Groq/Gemini style, no Retry-After header) is also retried once", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return new Response('{"error":{"message":"Please try again in 0.01s"}}', { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleProvider({
    id: "flaky-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
  });

  const result = await provider.execute({ GROQ_API_KEY: "key" } as any, dummyTask);

  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.success, true);
});

test("a 429 with no parseable retry-after info fails immediately -- no second attempt", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response('{"error":{"message":"rate limited, no timing info"}}', { status: 429 });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleProvider({
    id: "always-limited-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
  });

  const result = await provider.execute({ GROQ_API_KEY: "key" } as any, dummyTask);

  assert.strictEqual(callCount, 1, "must not retry without a parseable wait");
  assert.strictEqual(result.success, false);
});

test("a second consecutive 429 (even with a parseable wait) is not retried again -- at most one retry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response('{"error":{"message":"Please try again in 0.01s"}}', { status: 429 });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleProvider({
    id: "always-limited-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
  });

  const result = await provider.execute({ GROQ_API_KEY: "key" } as any, dummyTask);

  assert.strictEqual(callCount, 2, "exactly one retry, never an unbounded loop");
  assert.strictEqual(result.success, false);
});

test("a non-429 failure is never retried, even with rate-limit-shaped body text", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response('{"error":{"message":"Please try again in 0.01s"}}', { status: 500 });
  }) as typeof fetch;

  const provider = new OpenAiCompatibleProvider({
    id: "server-error-provider",
    baseUrl: "https://example.com/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    model: "some-model",
  });

  const result = await provider.execute({ GROQ_API_KEY: "key" } as any, dummyTask);

  assert.strictEqual(callCount, 1, "retry-after handling is scoped to 429 only");
  assert.strictEqual(result.success, false);
});

test("every provider uses the default 12s wait (the 25s Gemini trial of 2026-11-13 did not help and was reverted)", async () => {
  const mod = await import("./openaiCompatible");
  assert.strictEqual(mod.DEFAULT_PROVIDER_TIMEOUT_MS, 12_000);
  for (const p of [mod.GEMINI_PROVIDER, mod.GROQ_PROVIDER, mod.OPENROUTER_PROVIDER, mod.NVIDIA_NIM_PROVIDER, mod.CEREBRAS_PROVIDER, mod.SAMBANOVA_PROVIDER]) {
    assert.strictEqual((p as any).config.timeoutMs, undefined, (p as any).config.id);
  }
  assert.strictEqual((mod as any).GEMINI_TIMEOUT_MS, undefined);
});

test("provider calls log timing and outcome, never the prompt or the answer", async (t) => {
  const mod = await import("./openaiCompatible");
  const logs: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void logs.push(a.join(" ")));
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "SECRET ANSWER" } }] }), { status: 200 })) as typeof fetch;
  t.after(() => void (globalThis.fetch = original));
  const env = { GEMINI_API_KEY: "k" } as any;
  const task = { taskId: "marketing.hat_action_decision", type: "json", messages: [{ role: "user", content: "SECRET PROMPT" }] } as any;
  const r = await mod.GEMINI_PROVIDER.execute(env, task);
  assert.ok(r.success);
  const line = logs.find((l) => l.startsWith("AI provider call: gemini"))!;
  assert.match(line, /marketing\.hat_action_decision answered \(13 chars\) after \d+ms/);
  assert.ok(!logs.join("\n").includes("SECRET"));
});

test("OpenRouter uses Martin's chosen free models (2026-11-13)", async () => {
  const mod = await import("./openaiCompatible");
  assert.strictEqual((mod.OPENROUTER_PROVIDER as any).config.model, "google/gemma-4-31b-it:free");
  assert.strictEqual((mod.OPENROUTER_PROVIDER as any).config.lightModel, "google/gemma-4-26b-a4b-it:free");
});

test("Gemini is sent reasoning_effort none (Martin, 2026-11-13); a 400 retries once without it", async (t) => {
  const mod = await import("./openaiCompatible");
  const bodies: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ("reasoning_effort" in body) return new Response(JSON.stringify({ error: { message: "unsupported" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = original));
  t.mock.method(console, "log", () => {});
  const task = { taskId: "marketing.hat_action_decision", type: "json", messages: [{ role: "user", content: "x" }] } as any;
  const r = await mod.GEMINI_PROVIDER.execute({ GEMINI_API_KEY: "k" } as any, task);
  assert.ok(r.success, "answered after the retry");
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[0].reasoning_effort, "none");
  assert.ok(!("reasoning_effort" in bodies[1]));
});

test("only Gemini sends extra request settings; no other provider changes", async () => {
  const mod = await import("./openaiCompatible");
  for (const p of [mod.GROQ_PROVIDER, mod.OPENROUTER_PROVIDER, mod.NVIDIA_NIM_PROVIDER, mod.CEREBRAS_PROVIDER, mod.SAMBANOVA_PROVIDER]) {
    assert.strictEqual((p as any).config.extraBody, undefined, (p as any).config.id);
  }
  assert.deepStrictEqual((mod.GEMINI_PROVIDER as any).config.extraBody, { reasoning_effort: "none" });
});

test("a 429 naming a 7.8s wait is waited out in full (cap raised 6s -> 10s, Martin 2026-11-13)", async (t) => {
  const mod = await import("./openaiCompatible");
  assert.strictEqual(mod.MAX_RETRY_AFTER_WAIT_MS, 10_000);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? new Response('{"error":{"message":"Rate limit reached. Please try again in 7.807499999s."}}', { status: 429 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = original));
  t.mock.method(console, "log", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const task = { taskId: "marketing.hat_action_decision", type: "json", messages: [{ role: "user", content: "x" }] } as any;
  const pending = mod.GROQ_PROVIDER.execute({ GROQ_API_KEY: "k" } as any, task);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(6_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.strictEqual(calls, 1, "still waiting at the old 6s cap");
  t.mock.timers.tick(1_900);
  const r = await pending;
  assert.strictEqual(calls, 2, "retried after the full 7.8s");
  assert.ok(r.success);
});

test("a 429 naming a wait over the 10s cap is not slept or retried inside the provider; its stated wait is attached for the executor", async (t) => {
  const mod = await import("./openaiCompatible");
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"error":{"message":"Rate limit reached. Please try again in 25.3725s."}}', { status: 429 });
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = original));
  t.mock.method(console, "log", () => {});
  const task = { taskId: "marketing.hat_action_decision", type: "json", messages: [{ role: "user", content: "x" }] } as any;
  const r = await mod.GROQ_PROVIDER.execute({ GROQ_API_KEY: "k" } as any, task);
  assert.strictEqual(calls, 1, "no pointless wait-and-retry that the provider would refuse again");
  assert.ok(!r.success);
  assert.strictEqual((r as any).error.retryAfterMs, 25_372.5);
});
