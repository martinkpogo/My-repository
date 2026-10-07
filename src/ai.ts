import type { Env } from "./types";
import { defaultPolicyExecutor, AiPolicyExecutor, type AiFailureCause } from "./ai/policy";
import type { AiTask } from "./ai/types";
import type { SemanticTaskId, ContextSegment, SensitivityLevel } from "./dataBoundary/types";

export type { AiFailureCause };

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
/**
 * Builds the exact JSON-mode AiTask both `aiJson` and `generateWithOutcome`
 * send -- one definition so the two can never drift apart in prompt suffix,
 * boundary segments, temperature, token budget or validation seam.
 */
function buildJsonTask(opts: AiJsonOptions): AiTask {
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

  return task;
}

export async function aiJson<T = Record<string, unknown>>(
  env: Env,
  opts: AiJsonOptions,
  executor: AiPolicyExecutor = defaultPolicyExecutor,
): Promise<T | null> {
  const response = await executor.executeTask(env, buildJsonTask(opts));
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

/**
 * The pieces `generate` assembles into one prompt automatically, so no
 * pipeline hand-writes a full role+context+instruction+behavior+
 * situation+example prompt itself:
 *   - persona    -> Role: the Hat's own voice/authority framing
 *   - behavior   -> Behavior: cross-cutting rules for every persona
 *     (typically the Universal Role Contract's own content, fetched once by
 *     the caller via getGovernance so pipelines control their own
 *     caching/reuse -- generate() does not fetch it again itself)
 *   - skillContent -> Instruction (+ Example, if the Skill's own content
 *     includes worked examples)
 *   - context    -> Context: whatever this pipeline actually pulled in for
 *     this task
 *   - situation  -> Situation: the actual request/task text
 */
export interface GeneratePromptParts {
  persona: string;
  behavior?: string;
  skillContent?: string;
  context?: string;
  situation: string;
}

interface BaseGenerateOptions {
  /** This use's own registered SemanticTaskId -- resolved per actual call. */
  taskId: SemanticTaskId;
  parts: GeneratePromptParts;
  history?: ChatTurn[];
  sensitivity?: SensitivityLevel;
  light?: boolean;
  maxTokens?: number;
}

function assembleSystemPrompt(parts: GeneratePromptParts): string {
  return [parts.persona, parts.behavior, parts.skillContent, parts.context].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

/**
 * generate -- call the model with an assembled prompt, get output back. A
 * convenience wrapper around aiJson/aiChat/aiText for callers that want
 * persona/behavior/skillContent/context/situation assembled into one system
 * prompt rather than building that string by hand -- not a distinct
 * boundary of its own: every call still runs through the same
 * AiPolicyExecutor.executeTask as a direct aiJson/aiChat/aiText call would.
 * One function regardless of output shape (json classification vs.
 * free-text draft) -- both get identical Data Boundary/Outbound Gate
 * treatment, so TypeScript overloads keep this one exported function name
 * while still typing each call site's return correctly.
 */
export async function generate<T = Record<string, unknown>>(env: Env, options: BaseGenerateOptions & { mode: "json" }): Promise<T | null>;
export async function generate(env: Env, options: BaseGenerateOptions & { mode: "text" }): Promise<string>;
export async function generate(env: Env, options: BaseGenerateOptions & { mode: "json" | "text" }): Promise<unknown> {
  const system = assembleSystemPrompt(options.parts);
  const situation = options.parts.situation;
  if (options.mode === "json") {
    return aiJson(env, { taskId: options.taskId, system, user: situation, light: options.light, maxTokens: options.maxTokens });
  }
  if (options.history) {
    return aiChat(env, options.taskId, system, options.history, situation, options.maxTokens ?? 800, options.sensitivity);
  }
  return aiText(env, options.taskId, system, situation, { light: options.light, maxTokens: options.maxTokens });
}

/**
 * The outcome of a json-mode `generateWithOutcome` call: either the parsed
 * JSON, or WHY nothing usable came back (`AiFailureCause` codes only --
 * gateReasons carries the Outbound Data Gate's distinct reasonCategory
 * CODES, never payload content).
 */
export type AiJsonOutcome<T> =
  | { ok: true; json: T }
  | { ok: false; cause: AiFailureCause; gateReasons: string[] };

/**
 * generateWithOutcome -- json mode only: byte-identical to
 * `generate(env, { ..., mode: "json" })` in prompt, boundary treatment,
 * gate, validation and provider fallback, but instead of collapsing every
 * failure into `null` it reports the CAUSE (via the executor's
 * executeTaskWithOutcome) so a caller can tell an Outbound Data Gate
 * refusal -- a policy judgement about the payload, rewordable by a human
 * -- apart from an infrastructure failure or unparseable output, which no
 * rewording will fix. A provider whose response doesn't parse still falls
 * through to the next eligible provider exactly as before; `unparseable`
 * is only ever returned once every eligible provider is done. Callers that
 * only need "did it work" keep using generate/aiJson unchanged.
 */
export async function generateWithOutcome<T = Record<string, unknown>>(
  env: Env,
  options: BaseGenerateOptions,
  executor: AiPolicyExecutor = defaultPolicyExecutor,
): Promise<AiJsonOutcome<T>> {
  const system = assembleSystemPrompt(options.parts);
  const outcome = await executor.executeTaskWithOutcome(env, buildJsonTask({
    taskId: options.taskId,
    system,
    user: options.parts.situation,
    light: options.light,
    maxTokens: options.maxTokens,
  }));
  if (!outcome.ok) {
    return { ok: false, cause: outcome.cause, gateReasons: outcome.gateReasons };
  }

  const jsonText = extractJson(outcome.response.rawText);
  if (!jsonText) {
    return { ok: false, cause: "unparseable", gateReasons: [] };
  }
  try {
    return { ok: true, json: JSON.parse(jsonText) as T };
  } catch {
    return { ok: false, cause: "unparseable", gateReasons: [] };
  }
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
