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
    const result = (await env.AI.run(model as any, { messages, temperature: 0.2 } as any)) as any;
    raw = typeof result === "string" ? result : result?.response ?? "";
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
    const result = (await env.AI.run(model as any, { messages, temperature: 0.4 } as any)) as any;
    return typeof result === "string" ? result : result?.response ?? "";
  } catch (err) {
    console.error("Workers AI call failed", err);
    return "";
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
