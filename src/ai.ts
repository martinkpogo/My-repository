import type { Env } from "./types";
import type {
  AICompletionRequest,
  AICompletionResult,
  AIProviderAdapter,
  AITask,
  ChatTurn,
  ProviderSpec,
} from "./ai/types";
import { TASK_POLICIES } from "./ai/policy";
import { WorkersAiAdapter } from "./ai/providers/workersAi";

export type { ChatTurn } from "./ai/types";

export interface AiJsonOptions {
  system: string;
  user: string;
  light?: boolean;
  maxTokens?: number;
  task?: AITask;
}

export interface AiTextOptions {
  light?: boolean;
  maxTokens?: number;
  task?: AITask;
}

const PROVIDER_ADAPTERS: Record<string, AIProviderAdapter> = {
  "workers-ai": new WorkersAiAdapter(),
};

function resolveModelName(env: Env, spec: ProviderSpec, lightFallback?: boolean): string {
  if (spec.modelKey === "AI_MODEL_LIGHT") {
    return env.AI_MODEL_LIGHT;
  }
  if (spec.modelKey === "AI_MODEL_PRIMARY") {
    return env.AI_MODEL_PRIMARY;
  }
  if ((env as any)[spec.modelKey]) {
    return (env as any)[spec.modelKey];
  }
  return lightFallback ? env.AI_MODEL_LIGHT : env.AI_MODEL_PRIMARY;
}

async function executeCompletionWithPolicy(
  env: Env,
  request: AICompletionRequest,
  lightOption?: boolean,
): Promise<AICompletionResult> {
  const policy = TASK_POLICIES[request.task];
  const specs = policy ? [policy.primary, ...(policy.fallbacks ?? [])] : [];

  if (specs.length === 0) {
    const defaultSpec: ProviderSpec = {
      provider: "workers-ai",
      modelKey: lightOption ? "AI_MODEL_LIGHT" : "AI_MODEL_PRIMARY",
    };
    specs.push(defaultSpec);
  }

  let lastResult: AICompletionResult | null = null;

  for (const spec of specs) {
    const adapter = PROVIDER_ADAPTERS[spec.provider];
    if (!adapter) {
      console.error(`AI Provider adapter not found: ${spec.provider}`);
      continue;
    }

    const modelName = resolveModelName(env, spec, lightOption);
    const result = await adapter.complete(env, modelName, request);

    if (result.success) {
      return result;
    }

    // Provider infrastructure failure (quota, 4006, timeout, 5xx): log and attempt fallback provider if configured
    console.error(`AI Provider [${spec.provider}] failed (${result.error.kind}): ${result.error.message}`);
    lastResult = result;
  }

  return (
    lastResult ?? {
      success: false,
      error: {
        kind: "service_unavailable",
        provider: "multi-provider",
        message: "All provider completions failed.",
      },
    }
  );
}

/**
 * Calls AI via task policy and requires a JSON object response. Returns null
 * on any provider failure or JSON parse failure so callers can fall back to
 * governance stop conditions instead of guessing.
 */
export async function aiJson<T = Record<string, unknown>>(
  env: Env,
  opts: AiJsonOptions,
): Promise<T | null> {
  const task: AITask = opts.task ?? (opts.light ? "specialization_classification" : "marketing_hat_decision");

  const completionRequest: AICompletionRequest = {
    task,
    systemPrompt: opts.system,
    userPrompt: opts.user,
    temperature: 0.2,
    maxTokens: opts.maxTokens ?? 1024,
    requireJson: true,
  };

  const completion = await executeCompletionWithPolicy(env, completionRequest, opts.light);
  if (!completion.success) {
    return null;
  }

  const jsonText = extractJson(completion.rawText);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

export async function aiText(
  env: Env,
  system: string,
  user: string,
  options: AiTextOptions = {},
): Promise<string> {
  const task: AITask = options.task ?? (options.light ? "specialization_classification" : "sales_call_prep");

  const completionRequest: AICompletionRequest = {
    task,
    systemPrompt: system,
    userPrompt: user,
    temperature: 0.4,
    maxTokens: options.maxTokens ?? 1536,
    requireJson: false,
  };

  const completion = await executeCompletionWithPolicy(env, completionRequest, options.light);
  return completion.success ? completion.rawText : "";
}

/** Like aiText, but carries prior conversation turns as real message history. */
export async function aiChat(
  env: Env,
  system: string,
  history: ChatTurn[],
  userMessage: string,
  maxTokens = 800,
  task: AITask = "general_chat",
): Promise<string> {
  const completionRequest: AICompletionRequest = {
    task,
    systemPrompt: system,
    userPrompt: userMessage,
    history,
    temperature: 0.6,
    maxTokens,
    requireJson: false,
  };

  const completion = await executeCompletionWithPolicy(env, completionRequest, false);
  return completion.success ? completion.rawText : "";
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}
