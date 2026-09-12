import type { Env } from "../../types";
import type {
  AICompletionRequest,
  AICompletionResult,
  AIProviderAdapter,
  AIProviderErrorKind,
} from "../types";

export class WorkersAiAdapter implements AIProviderAdapter {
  readonly id = "workers-ai";

  async complete(env: Env, modelName: string, request: AICompletionRequest): Promise<AICompletionResult> {
    const messages = [
      {
        role: "system",
        content: request.requireJson
          ? `${request.systemPrompt}\n\nRespond with a single valid JSON object only. No prose, no markdown fences, no commentary before or after the JSON.`
          : request.systemPrompt,
      },
      ...(request.history?.map((t) => ({ role: t.role, content: t.content })) ?? []),
      { role: "user", content: request.userPrompt },
    ];

    try {
      const result = await env.AI.run(
        modelName as any,
        {
          messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 1024,
        } as any,
      );

      const rawText = coerceToText(result);
      return {
        success: true,
        rawText,
        provider: this.id,
        model: modelName,
      };
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      const kind = parseErrorKind(errorMsg, err?.code || err?.status);

      return {
        success: false,
        error: {
          kind,
          provider: this.id,
          message: errorMsg,
          code: err?.code,
          status: err?.status,
        },
      };
    }
  }
}

function parseErrorKind(msg: string, code?: string | number): AIProviderErrorKind {
  const lower = msg.toLowerCase();
  if (lower.includes("4006") || lower.includes("free-neuron limit") || lower.includes("quota")) {
    return "quota_exceeded";
  }
  if (lower.includes("429") || lower.includes("rate limit") || code === 429) {
    return "rate_limited";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "timeout";
  }
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("service unavailable")
  ) {
    return "service_unavailable";
  }
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return "auth_error";
  }
  return "network_error";
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
