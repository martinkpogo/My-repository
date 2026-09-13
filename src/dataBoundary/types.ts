import type { ProviderId } from "../ai/types";

export type SemanticTaskId =
  | "routing.enquiry_classification"
  | "routing.marketing_specialization_check"
  | "chat.general_reply"
  | "marketing.intake_classification"
  | "marketing.hat_action_decision"
  | "sales.enquiry_extraction"
  | "sales.matter_summary_drafting"
  | "sales.call_prep_briefing"
  | "sales.call_qualification"
  | "sales.proposal_drafting"
  | "sales.proposal_revision"
  | "finance.quote_judgment";

export type SensitivityLevel =
  | "public"
  | "internal"
  | "business_sensitive"
  | "client_confidential"
  | "pii_restricted";

export interface ContextSegment {
  type: "system" | "user" | "history" | "governance";
  content: string;
  provenance: string;
  sensitivity?: SensitivityLevel;
}

export interface BoundaryContext {
  segments: ContextSegment[];
  taskSensitivity?: SensitivityLevel;
}

export type TransformationResult =
  | { success: true; transformedSegment: ContextSegment }
  | { success: false; reason: string };

export interface DataTransformation {
  id: string;
  canTransform(segment: ContextSegment, targetProvider: ProviderId): boolean;
  transform(segment: ContextSegment, targetProvider: ProviderId): TransformationResult;
}

export interface ProviderEligibilityRule {
  providerId: ProviderId;
  allowedSensitivities: ReadonlySet<SensitivityLevel>;
}

export interface BoundaryEvaluationResult {
  allowed: boolean;
  reasonCode: string;
  reason: string;
  transformedContext?: BoundaryContext;
}

export interface BoundaryAuditEntry {
  timestamp: string;
  taskId: SemanticTaskId;
  providerId: ProviderId;
  event: "BOUNDARY_EVALUATION" | "MATERIAL_PROVIDER_FAILURE";
  allowed?: boolean;
  reasonCode: string;
  segmentMetadata: Array<{
    type: string;
    provenance: string;
    sensitivity?: SensitivityLevel;
    charCount: number;
  }>;
  errorDetails?: {
    statusCode?: number;
    errorCode?: string;
    message: string;
  };
}
