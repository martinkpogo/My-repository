import test from "node:test";
import assert from "node:assert";
import { generate } from "./primitives";
import type { Env } from "../types";

/**
 * `generate` is the sole surviving primitive from the retired six-primitive
 * Action Catalog model (see primitives.ts's own doc comment) -- the other
 * five (readRecord, fetchSkill, search, requestApproval, writeRecord) had
 * zero production callers and were removed outright as part of the
 * 2026-09-28 Kernel/Applications/Capabilities/Runtime Services migration.
 * This file now only covers generate's own prompt-assembly contract.
 */

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ...overrides,
  } as Env;
}

test("generate: json mode assembles persona+behavior+skillContent+context into the system prompt and returns parsed JSON", async () => {
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = opts.messages[0].content;
        return { response: JSON.stringify({ ok: true }) };
      },
    } as any,
  });
  const result = await generate<{ ok: boolean }>(env, {
    taskId: "chat.data_lookup",
    mode: "json",
    parts: {
      persona: "You are the Toy Hat.",
      behavior: "Never invent facts.",
      skillContent: "Format proposals as bullet points.",
      context: "Matter MAT-20 is Qualified.",
      situation: "Draft a proposal.",
    },
  });
  assert.deepStrictEqual(result, { ok: true });
  assert.match(capturedSystem, /You are the Toy Hat\./);
  assert.match(capturedSystem, /Never invent facts\./);
  assert.match(capturedSystem, /Format proposals as bullet points\./);
  assert.match(capturedSystem, /Matter MAT-20 is Qualified\./);
});

test("generate: text mode returns the raw model text, not parsed JSON", async () => {
  const env = fakeEnv({
    AI: { run: async () => ({ response: "Here is your draft proposal." }) } as any,
  });
  const result = await generate(env, {
    taskId: "chat.data_lookup",
    mode: "text",
    parts: { persona: "You are the Toy Hat.", situation: "Draft a proposal." },
  });
  assert.strictEqual(result, "Here is your draft proposal.");
});

test("generate: omitting optional prompt parts (no behavior/skillContent/context) still assembles a valid prompt", async () => {
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = opts.messages[0].content;
        return { response: "ok" };
      },
    } as any,
  });
  await generate(env, { taskId: "chat.data_lookup", mode: "text", parts: { persona: "You are the Toy Hat.", situation: "Hello" } });
  assert.strictEqual(capturedSystem.trim(), "You are the Toy Hat.");
});
