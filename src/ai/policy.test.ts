/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { AiPolicyExecutor } from "./policy";
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

test("D & Additional: Malformed JSON output does NOT trigger provider fallback", async () => {
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

  assert.equal(res, null);
  assert.equal(primary.attempts, 1);
  assert.equal(secondary.attempts, 0, "Secondary provider must NOT be attempted on malformed output");
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
  const resChat = await aiChat(fakeEnv, "chat.general_reply", "s", [], "u", 800, executor);

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
