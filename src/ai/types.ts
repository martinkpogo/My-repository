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

  constructor(providerId: ProviderId, message: string, options?: { statusCode?: number; code?: string }) {
    super(message);
    this.name = "InfrastructureError";
    this.providerId = providerId;
    this.statusCode = options?.statusCode;
    this.code = options?.code;
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
