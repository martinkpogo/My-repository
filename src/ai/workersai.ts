import type { Env } from "../types";
import {
  AiProvider,
  AiTask,
  InfrastructureError,
  ProviderAdapterResult,
  ProviderId,
} from "./types";

export class WorkersAiProvider implements AiProvider {
  public readonly id: ProviderId = "workers-ai";

  public isEligible(env: Env, _task: AiTask): boolean {
    return Boolean(env && env.AI);
  }

  public async execute(env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    const model = task.light ? env.AI_MODEL_LIGHT : env.AI_MODEL_PRIMARY;
    try {
      const result = await env.AI.run(
        model as any,
        {
          messages: task.messages,
          temperature: task.temperature ?? 0.2,
          max_tokens: task.maxTokens ?? 1024,
        } as any,
      );
      const rawText = coerceToText(result);
      return { success: true, response: { rawText } };
    } catch (err: any) {
      console.error("Workers AI call failed", err);
      const statusCode = extractStatusCode(err);
      const code = err?.code || (err?.name !== "Error" ? err?.name : undefined);
      return {
        success: false,
        error: new InfrastructureError(
          this.id,
          err?.message || "Workers AI execution failed",
          { statusCode, code },
        ),
      };
    }
  }
}

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
