import type { Env } from "../types";
import type { BoundaryContext, SemanticTaskId } from "../dataBoundary/types";

export type ProviderId = string;

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiTask {
  taskId: SemanticTaskId;
  boundaryContext: BoundaryContext;
  type: "json" | "text" | "chat";
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  light?: boolean;
  /**
   * True when this call runs on a Work's alarm rather than inside a
   * Telegram webhook (deep research and the research runtime). The
   * executor may then wait out a provider's per-minute rate limit and
   * retry that provider instead of moving straight on, and the call may
   * take longer than a webhook-time reply can afford. Absent: webhook
   * time, today's behaviour unchanged.
   */
  /**
   * True for a call that must not start web research even though its task
   * is eligible (Martin, 2026-11-18): a Hat's deciding pass while it may
   * still ask Martin questions. Research runs on the pass that drafts.
   */
  noWebResearch?: boolean;
  resumable?: boolean;
  /**
   * Per-call provider timeout, overriding the provider's default. Research
   * steps get a longer one than chat replies (they run on the alarm); the
   * default stays the provider's own (12 s for the OpenAI-compatible
   * fallbacks), so chat and every other webhook-time step are unchanged.
   */
  timeoutMs?: number;
  /**
   * Optional response-shape check, independent of provider infrastructure
   * health. When set and a provider's response fails it (e.g. aiJson's
   * requested-but-unparsable JSON), the executor treats that provider as
   * exhausted for this task and tries the next eligible one, the same as
   * an infrastructure failure -- a provider that answered with garbage is
   * no more useful than one that didn't answer at all.
   */
  validateResponse?: (rawText: string) => boolean;
}

export interface CommonAiResponse {
  rawText: string;
}

export class InfrastructureError extends Error {
  public readonly providerId: ProviderId;
  public readonly statusCode?: number;
  public readonly code?: string;
  /**
   * A rate-limited provider's own stated wait before the same request would
   * succeed, in ms -- set only when the provider named one and the call was
   * not (or could not be) waited out inside the provider. Metadata only.
   */
  public retryAfterMs?: number;

  constructor(providerId: ProviderId, message: string, options?: { statusCode?: number; code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = "InfrastructureError";
    this.providerId = providerId;
    this.statusCode = options?.statusCode;
    this.code = options?.code;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export type ProviderAdapterResult =
  | { success: true; response: CommonAiResponse }
  | { success: false; error: InfrastructureError };

export interface AiProvider {
  id: ProviderId;
  isEligible(env: Env, task: AiTask): boolean;
  execute(env: Env, task: AiTask): Promise<ProviderAdapterResult>;
}
