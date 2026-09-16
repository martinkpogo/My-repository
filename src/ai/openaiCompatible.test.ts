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
