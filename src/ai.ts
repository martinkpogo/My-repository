import type { Env } from "./types";
import { defaultPolicyExecutor, AiPolicyExecutor } from "./ai/policy";
import type { AiTask } from "./ai/types";
import type { SemanticTaskId, ContextSegment } from "./dataBoundary/types";

export interface AiJsonOptions {
  taskId: SemanticTaskId;
  system: string;
  user: string;
  light?: boolean;
  maxTokens?: number;
}

export interface AiTextOptions {
  light?: boolean;
  maxTokens?: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Calls AI via policy executor and requires a JSON object response. Returns null
 * on any infrastructure failure (if no provider succeeds) or on JSON parse failure.
 * Mandates explicit SemanticTaskId and constructs structured BoundaryContext.
 * Crucially, malformed model output does NOT trigger provider fallback.
 */
export async function aiJson<T = Record<string, unknown>>(
  env: Env,
  opts: AiJsonOptions,
  executor: AiPolicyExecutor = defaultPolicyExecutor,
): Promise<T | null> {
  const systemContent = `${opts.system}\n\nRespond with a single valid JSON object only. No prose, no markdown fences, no commentary before or after the JSON.`;
  const segments: ContextSegment[] = [
    { type: "system", content: systemContent, provenance: `${opts.taskId}:system` },
    { type: "user", content: opts.user, provenance: `${opts.taskId}:user` },
  ];

  const task: AiTask = {
    taskId: opts.taskId,
    boundaryContext: { segments },
    type: "json",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: opts.user },
    ],
    temperature: 0.2,
    maxTokens: opts.maxTokens ?? 1024,
    light: opts.light,
  };

  const response = await executor.executeTask(env, task);
  if (!response) {
    return null;
  }

  const jsonText = extractJson(response.rawText);
  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

export async function aiText(
  env: Env,
  taskId: SemanticTaskId,
  system: string,
  user: string,
  options: AiTextOptions = {},
  executor: AiPolicyExecutor = defaultPolicyExecutor,
): Promise<string> {
  const segments: ContextSegment[] = [
    { type: "system", content: system, provenance: `${taskId}:system` },
    { type: "user", content: user, provenance: `${taskId}:user` },
  ];

  const task: AiTask = {
    taskId,
    boundaryContext: { segments },
    type: "text",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.4,
    maxTokens: options.maxTokens ?? 1536,
    light: options.light,
  };

  const response = await executor.executeTask(env, task);
  return response ? response.rawText : "";
}

/** Like aiText, but carries prior conversation turns as real message history. */
export async function aiChat(
  env: Env,
  taskId: SemanticTaskId,
  system: string,
  history: ChatTurn[],
  userMessage: string,
  maxTokens = 800,
  executor: AiPolicyExecutor = defaultPolicyExecutor,
): Promise<string> {
  const segments: ContextSegment[] = [
    { type: "system", content: system, provenance: `${taskId}:system` },
    ...history.map((t, idx) => ({
      type: (t.role === "user" ? "user" : "system") as ContextSegment["type"],
      content: t.content,
      provenance: `${taskId}:history:${idx}`,
    })),
    { type: "user", content: userMessage, provenance: `${taskId}:user_input` },
  ];

  const task: AiTask = {
    taskId,
    boundaryContext: { segments },
    type: "chat",
    messages: [
      { role: "system", content: system },
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: userMessage },
    ],
    temperature: 0.6,
    maxTokens,
  };

  const response = await executor.executeTask(env, task);
  return response ? response.rawText : "";
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
