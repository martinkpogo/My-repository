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
