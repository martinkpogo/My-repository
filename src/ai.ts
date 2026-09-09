import type { Env } from "./types";

export interface AiJsonOptions {
  system: string;
  user: string;
  light?: boolean;
}

/**
 * Calls Workers AI and requires a JSON object response. Returns null on any
 * parse failure so callers can fall back to the Universal Role Contract's
 * ambiguity rule (stop and surface) instead of guessing.
 */
export async function aiJson<T = Record<string, unknown>>(
  env: Env,
  opts: AiJsonOptions,
): Promise<T | null> {
  const model = opts.light ? env.AI_MODEL_LIGHT : env.AI_MODEL_PRIMARY;
  const messages = [
    {
      role: "system",
      content:
        `${opts.system}\n\nRespond with a single valid JSON object only. No prose, no markdown fences, no commentary before or after the JSON.`,
    },
    { role: "user", content: opts.user },
  ];

  let raw: string;
  try {
    const result = await env.AI.run(model as any, { messages, temperature: 0.2 } as any);
    raw = coerceToText(result);
  } catch (err) {
    console.error("Workers AI call failed", err);
    return null;
  }

  const jsonText = extractJson(raw);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

export async function aiText(env: Env, system: string, user: string, light = false): Promise<string> {
  const model = light ? env.AI_MODEL_LIGHT : env.AI_MODEL_PRIMARY;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  try {
    const result = await env.AI.run(model as any, { messages, temperature: 0.4 } as any);
    return coerceToText(result);
  } catch (err) {
    console.error("Workers AI call failed", err);
    return "";
  }
}

/**
 * Workers AI response shapes vary by model: usually a plain string or
 * { response: string }, but some models return { response: {...} } for
 * structured output, or an array of streamed chunks. Always normalize to a
 * single string so callers never have to guard against non-string values.
 */
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

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}
