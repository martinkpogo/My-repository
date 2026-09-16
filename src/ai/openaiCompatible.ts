import type { Env } from "../types";
import { AiProvider, AiTask, InfrastructureError, ProviderAdapterResult, ProviderId } from "./types";

/**
 * Generic adapter for any provider exposing an OpenAI-compatible
 * /chat/completions endpoint -- covers most free-tier inference
 * providers (NVIDIA NIM, Groq, OpenRouter, Cerebras, Gemini, SambaNova, and others) without a
 * bespoke class per provider. Added as fallback options behind
 * Workers AI so a daily quota exhaustion on one provider doesn't block
 * every AI-driven Hat/Unit at once -- confirmed live as a real failure
 * mode (Cloudflare's free-tier 10,000 neuron/day cap).
 *
 * Scope: registered only for tasks already eligible for Workers AI
 * (business_sensitive and below) -- this does NOT touch or unblock the
 * client_confidential/pii_restricted gate the Sales Executive pause
 * depends on. Each provider's own training-data/retention policy for
 * this sensitivity tier has not been independently verified beyond "free
 * tier, OpenAI-compatible API" -- treat these as infrastructure fallback
 * for ENIG's own internal-operations tasks, the same tier Workers AI
 * already serves, not as a basis for widening what's allowed at
 * client_confidential.
 */
export interface OpenAiCompatibleConfig {
  id: ProviderId;
  baseUrl: string;
  /** Which optional Env field holds this provider's API key -- eligibility is simply "is it set." */
  apiKeyEnvVar:
    | "NVIDIA_NIM_API_KEY"
    | "GROQ_API_KEY"
    | "OPENROUTER_API_KEY"
    | "CEREBRAS_API_KEY"
    | "GEMINI_API_KEY"
    | "SAMBANOVA_API_KEY";
  model: string;
  lightModel?: string;
  /** Overridable for tests only -- production providers all use DEFAULT_PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

// Confirmed live: nvidia-nim once took long enough to answer that
// Cloudflare's own edge gave up with a 524 before our fetch would have.
// With up to 7 providers in the fallback chain and some call sites
// (e.g. R&I's protocol selection -> plan generation) making more than
// one AI call per user turn, an unbounded per-provider wait can blow
// past what Telegram will wait for on its webhook, making the whole
// reply look like silence rather than a reported failure. Each provider
// gets a hard timeout so a slow one fails over quickly instead of
// stalling the whole chain.
export const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000;

/**
 * Confirmed live: several fallback providers' 429 rate-limit responses
 * name the exact wait before the SAME request would succeed -- Groq:
 * "Please try again in 4.335s"; Gemini: "Please retry in
 * 5.813790504s" -- often just a few seconds, well within reach of one
 * short wait-and-retry, rather than immediately giving up on this
 * provider and falling through to the next one in the chain, which is
 * frequently ALSO rate-limited or exhausted from the same burst of
 * calls (protocol selection, N per-protocol plan calls, and synthesis
 * can all land on the same provider within the same minute). Capped
 * well under DEFAULT_PROVIDER_TIMEOUT_MS so a wait-and-retry can never
 * itself become the reason a request looks stalled.
 */
const MAX_RETRY_AFTER_WAIT_MS = 6_000;

function parseRetryAfterMs(res: Response, bodyText: string): number | undefined {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  // Provider-worded fallback: Groq's "Please try again in 4.335s", Gemini's
  // "Please retry in 5.813790504s" -- no standard Retry-After header, but
  // the same wait is spelled out in the error body text.
  const match = bodyText.match(/(?:try again|retry) in (\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAiCompatibleProvider implements AiProvider {
  public readonly id: ProviderId;
  private readonly config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.id;
    this.config = config;
  }

  public isEligible(env: Env, _task: AiTask): boolean {
    return Boolean(env[this.config.apiKeyEnvVar]);
  }

  /**
   * Makes one attempt, then -- only for a 429 whose body/header names a
   * short, parseable wait -- waits that long (capped) and retries once
   * more before giving up. Every other failure (non-429 errors, a 429
   * with no parseable wait, or a second consecutive failure) returns
   * immediately so the policy executor's own fallback loop can move on
   * to the next eligible provider without delay.
   */
  public async execute(env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    const first = await this.attempt(env, task);
    if (first.result.success || first.retryAfterMs === undefined) return first.result;

    await sleep(Math.min(first.retryAfterMs, MAX_RETRY_AFTER_WAIT_MS));
    return (await this.attempt(env, task)).result;
  }

  private async attempt(env: Env, task: AiTask): Promise<{ result: ProviderAdapterResult; retryAfterMs?: number }> {
    const apiKey = env[this.config.apiKeyEnvVar];
    const model = task.light && this.config.lightModel ? this.config.lightModel : this.config.model;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: task.messages,
          temperature: task.temperature ?? 0.2,
          max_tokens: task.maxTokens ?? 1024,
        }),
        signal: timeoutController.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          result: {
            success: false,
            error: new InfrastructureError(this.id, `${res.status} ${body}`.slice(0, 500), { statusCode: res.status }),
          },
          retryAfterMs: res.status === 429 ? parseRetryAfterMs(res, body) : undefined,
        };
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const rawText = data.choices?.[0]?.message?.content ?? "";
      return { result: { success: true, response: { rawText } } };
    } catch (err: any) {
      const message =
        err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err?.message || `${this.id} execution failed`;
      return { result: { success: false, error: new InfrastructureError(this.id, message) } };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

// Reasonable free-tier defaults as of this writing -- each provider's
// free model lineup changes over time (confirmed live: every model
// below except Gemini's had gone stale -- retired, renamed, or dropped
// from this specific account's access list -- within about a month of
// being set), so these are the starting point, not guaranteed to stay
// current. When a provider starts failing with a 404/410 "model not
// found"/"end of life" error, query that provider's own /models list
// endpoint with the live key to find a currently accessible replacement
// rather than guessing a name.
export const NVIDIA_NIM_PROVIDER = new OpenAiCompatibleProvider({
  id: "nvidia-nim",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  apiKeyEnvVar: "NVIDIA_NIM_API_KEY",
  model: "openai/gpt-oss-20b",
});

export const GROQ_PROVIDER = new OpenAiCompatibleProvider({
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY",
  model: "openai/gpt-oss-120b",
  lightModel: "openai/gpt-oss-20b",
});

export const OPENROUTER_PROVIDER = new OpenAiCompatibleProvider({
  id: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  model: "nvidia/nemotron-3-super-120b-a12b:free",
  lightModel: "liquid/lfm-2.5-2.6b:free",
});

export const CEREBRAS_PROVIDER = new OpenAiCompatibleProvider({
  id: "cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKeyEnvVar: "CEREBRAS_API_KEY",
  model: "gpt-oss-120b",
  lightModel: "qwen-3.8-27b",
});

// Google keeps these two alias names pointed at its current default and
// lite Gemini models, unlike a pinned version string (e.g. gemini-2.0-
// flash) which Google retires outright -- confirmed live as the exact
// failure mode that broke the pinned names below within weeks.
export const GEMINI_PROVIDER = new OpenAiCompatibleProvider({
  id: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKeyEnvVar: "GEMINI_API_KEY",
  model: "gemini-flash-latest",
  lightModel: "gemini-flash-lite-latest",
});

export const SAMBANOVA_PROVIDER = new OpenAiCompatibleProvider({
  id: "sambanova",
  baseUrl: "https://api.sambanova.ai/v1",
  apiKeyEnvVar: "SAMBANOVA_API_KEY",
  model: "Meta-Llama-3.3-70B-Instruct",
  lightModel: "Meta-Llama-3.1-8B-Instruct",
});
