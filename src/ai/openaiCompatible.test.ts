import test from "node:test";
import assert from "node:assert";
import { CEREBRAS_PROVIDER, GROQ_PROVIDER, NVIDIA_NIM_PROVIDER, OPENROUTER_PROVIDER, OpenAiCompatibleProvider } from "./openaiCompatible";
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
});

test("each fallback provider becomes eligible once its own API key is set -- unrelated providers stay ineligible", () => {
  assert.strictEqual(NVIDIA_NIM_PROVIDER.isEligible({ NVIDIA_NIM_API_KEY: "key" } as any, dummyTask), true);
  assert.strictEqual(GROQ_PROVIDER.isEligible({ NVIDIA_NIM_API_KEY: "key" } as any, dummyTask), false);
  assert.strictEqual(GROQ_PROVIDER.isEligible({ GROQ_API_KEY: "key" } as any, dummyTask), true);
  assert.strictEqual(CEREBRAS_PROVIDER.isEligible({ GROQ_API_KEY: "key" } as any, dummyTask), false);
  assert.strictEqual(CEREBRAS_PROVIDER.isEligible({ CEREBRAS_API_KEY: "key" } as any, dummyTask), true);
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
