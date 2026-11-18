import type { Env } from "../types";
import {
  AiProvider,
  AiTask,
  InfrastructureError,
  ProviderAdapterResult,
  ProviderId,
} from "./types";
import { EMPTY_REPLY_RETRY_MS } from "./openaiCompatible";

export class WorkersAiProvider implements AiProvider {
  public readonly id: ProviderId = "workers-ai";

  public isEligible(env: Env, _task: AiTask): boolean {
    return Boolean(env && env.AI);
  }

  public async execute(env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    const resumable = task.resumable === true;
    const timeoutMs = task.timeoutMs;
    let attempt = 0;
    while (attempt < (resumable ? MAX_WORKERS_AI_ATTEMPTS : 1)) {
      attempt++;
      const result = await this.call(env, task, timeoutMs);
      if (result.success) return result;
      // A research step treats an empty reply as a failed attempt, not an
      // answer: some Workers AI models spend their reply allowance on an
      // invisible chain-of-thought field, so a too-tight token budget leaves
      // the content empty and the step reports "no usable answer". The step
      // retries it (with a raised reply allowance -- see ai.ts) instead of
      // moving on. Chat and every other webhook-time step keep today's
      // behaviour: they pass no resumable flag, so this branch is never
      // reached for them.
      if (resumable && result.error.code === "EMPTY_REPLY") {
        await new Promise((resolve) => setTimeout(resolve, EMPTY_REPLY_RETRY_MS));
        continue;
      }
      return result;
    }
    return {
      success: false,
      error: new InfrastructureError(this.id, "Workers AI execution failed after retries", { code: "MAX_ATTEMPTS" }),
    };
  }

  private async call(env: Env, task: AiTask, timeoutMs?: number): Promise<ProviderAdapterResult> {
    const model = task.light ? env.AI_MODEL_LIGHT : env.AI_MODEL_PRIMARY;
    const startedAt = Date.now();
    if (typeof env.AI?.run !== "function") {
      console.error("Workers AI call failed: env.AI.run is not a function");
      return {
        success: false,
        error: new InfrastructureError(this.id, "Workers AI binding is not callable", { code: "NO_RUN_BINDING" }),
      };
    }
    try {
      const result: unknown =
        timeoutMs && timeoutMs > 0
          ? await this.withTimeout(env.AI.run(model as any, {
              messages: task.messages,
              temperature: task.temperature ?? 0.2,
              max_tokens: task.maxTokens ?? 1024,
            } as any), timeoutMs)
          : await env.AI.run(model as any, {
              messages: task.messages,
              temperature: task.temperature ?? 0.2,
              max_tokens: task.maxTokens ?? 1024,
            } as any);
      const rawText = coerceToText(result);
      console.log(`AI provider call: workers-ai ${model} ${task.taskId} answered (${rawText.length} chars) after ${Date.now() - startedAt}ms`);
      if (rawText.trim() === "") {
        return {
          success: false,
          error: new InfrastructureError(this.id, "Workers AI answered with an empty reply (reasoning consumed the reply allowance)", { code: "EMPTY_REPLY" }),
        };
      }
      return { success: true, response: { rawText } };
    } catch (err: any) {
      console.error("Workers AI call failed", err);
      const timedOut = err?.name === "AbortError" || /timed out/i.test(err?.message || "");
      return {
        success: false,
        error: new InfrastructureError(
          this.id,
          timedOut ? `timed out after ${timeoutMs ?? 0}ms` : err?.message || "Workers AI execution failed",
          { statusCode: extractStatusCode(err), code: err?.code || (err?.name !== "Error" ? err?.name : undefined) },
        ),
      };
    }
  }

  private async withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** How many times a research step retries Workers AI after an empty reply. Bounded: never a loop. */
const MAX_WORKERS_AI_ATTEMPTS = 3;

function coerceToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  const response = (result as { response?: unknown }).response;
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((chunk) => (typeof chunk === "string" ? chunk : coerceToText(chunk)))
      .join("");
  }
  if (response != null) return JSON.stringify(response);
  return JSON.stringify(result);
}

function extractStatusCode(err: any): number | undefined {
  if (typeof err?.status === "number") return err.status;
  if (typeof err?.statusCode === "number") return err.statusCode;
  const match = String(err?.message || "").match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  return match ? parseInt(match[1], 10) : undefined;
}