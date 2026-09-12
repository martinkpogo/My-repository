import type { Env } from "../types";

export type AITask =
  | "workspace_routing"
  | "specialization_classification"
  | "marketing_intake_stage1"
  | "marketing_hat_decision"
  | "sales_entity_extraction"
  | "sales_matter_drafting"
  | "sales_call_prep"
  | "sales_qualification"
  | "sales_intervention_proposal"
  | "sales_proposal_drafting"
  | "finance_pricing_judgment"
  | "general_chat";

export type AIProviderErrorKind =
  | "quota_exceeded"
  | "rate_limited"
  | "service_unavailable"
  | "timeout"
  | "auth_error"
  | "network_error";

export interface AIProviderError {
  kind: AIProviderErrorKind;
  provider: string;
  message: string;
  code?: string | number;
  status?: number;
}

export type AICompletionResult =
  | { success: true; rawText: string; provider: string; model: string }
  | { success: false; error: AIProviderError };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AICompletionRequest {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  history?: ChatTurn[];
  temperature?: number;
  maxTokens?: number;
  requireJson?: boolean;
}

export interface AIProviderAdapter {
  id: string;
  complete(env: Env, model: string, request: AICompletionRequest): Promise<AICompletionResult>;
}

export interface ProviderSpec {
  provider: string;
  modelKey: "AI_MODEL_PRIMARY" | "AI_MODEL_LIGHT" | string;
}

export interface TaskPolicy {
  primary: ProviderSpec;
  fallbacks?: ProviderSpec[];
}
