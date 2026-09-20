import type { ProviderId } from "../ai/types";

export type SemanticTaskId =
  | "routing.enquiry_classification"
  | "routing.marketing_specialization_check"
  | "chat.general_reply"
  | "marketing.intake_classification"
  | "marketing.hat_action_decision"
  | "routing.research_specialization_check"
  | "research.context_relevance"
  | "research.protocol_selection"
  | "research.plan_generation"
  | "research.synthesis"
  | "research.handoff_routing"
  | "sales.enquiry_extraction"
  | "sales.matter_summary_drafting"
  | "sales.call_prep_briefing"
  | "sales.call_qualification"
  | "sales.proposal_drafting"
  | "sales.proposal_revision"
  | "finance.quote_judgment"
  | "lead.discovery_classification"
  | "lead.discovery_signal_evaluation"
  | "action.google_doc_intake"
  | "action.google_doc_comment_edit"
  | "action.google_sheet_intake"
  | "action.google_sheet_comment_edit";

/**
 * public_sourced marks data Lead Discovery can attribute to a genuinely
 * public source (a live URL, a public listing) -- distinct from
 * client_confidential, which is reserved for anything disclosed to ENIG in
 * confidence (an enquiry, call notes, negotiation). It sits alongside
 * business_sensitive in provider eligibility (see FALLBACK_PROVIDER_
 * SENSITIVITIES in dataBoundary/policy.ts): the risk of feeding a
 * provider without a confirmed training-data policy is real even for
 * already-public identity, but materially lower than for information a
 * client specifically kept off the internet -- which is what
 * client_confidential exists to protect and stays fully gated for.
 */
export type SensitivityLevel =
  | "public"
  | "internal"
  | "business_sensitive"
  | "public_sourced"
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

/**
 * Canonical closed-context Handoff Context Contract representing the sanitized
 * context explicitly supplied by the controlled environment for runtime execution.
 * Opaque tokens (entityToken, matterToken, proposalToken) are reference identifiers only
 * and must NEVER be treated as lookup keys into controlled databases.
 */
export interface HandoffContextContract {
  /** Internal opaque token / reference metadata for session tracking */
  handoffId: string;
  workId?: string;
  entityToken: string;
  matterToken?: string;
  proposalToken?: string;

  /** Sanitized business context explicitly authorized for execution */
  sanitizedContext: string;
  provenance: string;
  sensitivity?: SensitivityLevel;

  /** Category of required execution context expected for task completion */
  requiredCategory?: string;
}

export interface InsufficientContextResult {
  isInsufficient: true;
  category: string;
  reason: string;
}

export type HandoffContextEvaluationResult =
  | { success: true; contract: HandoffContextContract; boundaryContext: BoundaryContext }
  | { success: false; insufficientContext: InsufficientContextResult };
