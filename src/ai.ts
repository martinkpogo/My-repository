import type { Env } from "./types";
import { defaultPolicyExecutor, AiPolicyExecutor } from "./ai/policy";
import type { AiTask } from "./ai/types";
import type { SemanticTaskId, ContextSegment, SensitivityLevel } from "./dataBoundary/types";

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
 * Calls AI via policy executor and requires a JSON object response. Returns
 * null only once every eligible provider has either failed infrastructurally
 * or returned unparsable output -- a provider whose response doesn't parse
 * as JSON is treated the same as one that errored, and the executor moves on
 * to the next eligible provider rather than failing the whole call.
 * Mandates explicit SemanticTaskId and constructs structured BoundaryContext.
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
    // Confirmed live: several fallback providers' free-tier models
    // (the gpt-oss family on groq/nvidia-nim, among others) are
    // "reasoning" models that spend part of their output budget on an
    // invisible chain-of-thought field before emitting the requested
    // JSON in "content" -- too tight a budget lets the reasoning eat
    // the whole allowance and leaves content empty, which then reports
    // as a malformed response and burns a fallback attempt for nothing.
    // 1024 was too tight for this class of model; raised as a shared
    // safety margin for every aiJson caller, not a license to request
    // more than a JSON object actually needs.
    maxTokens: opts.maxTokens ?? 2048,
    light: opts.light,
    validateResponse: isParsableJson,
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

/**
 * Like aiText, but carries prior conversation turns as real message history.
 *
 * `sensitivity`, when given, is stamped onto every segment built here,
 * overriding chat.general_reply's default client_confidential
 * classification for this specific call -- e.g. a Unit chat persona with no
 * access to any client-identity-bearing database (Entity/Matters/Proposals
 * are exclusively the isolated Sales Executive project's now) has no way to
 * actually be discussing real client identity, so it can correctly be
 * classified business_sensitive instead and run on workers-ai like any
 * other internal-operations task.
 */
export async function aiChat(
  env: Env,
  taskId: SemanticTaskId,
  system: string,
  history: ChatTurn[],
  userMessage: string,
  maxTokens = 800,
  sensitivity?: SensitivityLevel,
  executor: AiPolicyExecutor = defaultPolicyExecutor,
): Promise<string> {
  const segments: ContextSegment[] = [
    { type: "system", content: system, provenance: `${taskId}:system`, sensitivity },
    ...history.map((t, idx) => ({
      type: (t.role === "user" ? "user" : "system") as ContextSegment["type"],
      content: t.content,
      provenance: `${taskId}:history:${idx}`,
      sensitivity,
    })),
    { type: "user", content: userMessage, provenance: `${taskId}:user_input`, sensitivity },
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

function isParsableJson(rawText: string): boolean {
  const jsonText = extractJson(rawText);
  if (!jsonText) return false;
  try {
    JSON.parse(jsonText);
    return true;
  } catch {
    return false;
  }
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
