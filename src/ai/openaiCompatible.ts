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

  public async execute(env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    const apiKey = env[this.config.apiKeyEnvVar];
    const model = task.light && this.config.lightModel ? this.config.lightModel : this.config.model;
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
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          success: false,
          error: new InfrastructureError(this.id, `${res.status} ${body}`.slice(0, 500), { statusCode: res.status }),
        };
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const rawText = data.choices?.[0]?.message?.content ?? "";
      return { success: true, response: { rawText } };
    } catch (err: any) {
      return {
        success: false,
        error: new InfrastructureError(this.id, err?.message || `${this.id} execution failed`),
      };
    }
  }
}

// Reasonable free-tier defaults as of this writing -- each provider's
// free model lineup changes over time, so these are the starting point,
// not guaranteed to stay current. Update the model string here if a
// provider retires or renames its free-tier model.
export const NVIDIA_NIM_PROVIDER = new OpenAiCompatibleProvider({
  id: "nvidia-nim",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  apiKeyEnvVar: "NVIDIA_NIM_API_KEY",
  model: "meta/llama-3.3-70b-instruct",
});

export const GROQ_PROVIDER = new OpenAiCompatibleProvider({
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY",
  model: "llama-3.3-70b-versatile",
  lightModel: "llama-3.1-8b-instant",
});

export const OPENROUTER_PROVIDER = new OpenAiCompatibleProvider({
  id: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  model: "meta-llama/llama-3.3-70b-instruct:free",
});

export const CEREBRAS_PROVIDER = new OpenAiCompatibleProvider({
  id: "cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKeyEnvVar: "CEREBRAS_API_KEY",
  model: "llama-3.3-70b",
  lightModel: "llama3.1-8b",
});

export const GEMINI_PROVIDER = new OpenAiCompatibleProvider({
  id: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKeyEnvVar: "GEMINI_API_KEY",
  model: "gemini-2.0-flash",
  lightModel: "gemini-1.5-flash",
});

export const SAMBANOVA_PROVIDER = new OpenAiCompatibleProvider({
  id: "sambanova",
  baseUrl: "https://api.sambanova.ai/v1",
  apiKeyEnvVar: "SAMBANOVA_API_KEY",
  model: "Meta-Llama-3.3-70B-Instruct",
  lightModel: "Meta-Llama-3.1-8B-Instruct",
});
