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
  | "sales.commercial_evidence_extraction"
  | "sales.call_qualification"
  | "sales.commercial_evidence_extraction_handoff"
  | "sales.call_qualification_handoff"
  | "sales.proposal_drafting"
  | "sales.proposal_revision"
  | "finance.quote_judgment"
  | "strategy.diagnosis"
  | "strategy.handoff_routing"
  | "strategy.proposal_drafting"
  | "lead.discovery_classification"
  | "lead.discovery_signal_evaluation"
  | "action.google_doc_intake"
  | "action.google_doc_comment_edit"
  | "action.google_sheet_intake"
  | "action.google_sheet_comment_edit"
  | "lead.discovery_ondemand_intake"
  | "lead.discovery_ondemand_query_generation"
  // Business Development's Stage 1 (which of its 3 Hats) / Stage 2 (which
  // of that Hat's declared actions) classification -- the first real use
  // of the generic Action Registry's action-resolution step. Sensitivity
  // classification pending Architect review; UNCLASSIFIED in
  // PRODUCTION_TASK_SENSITIVITY until then, which fails closed
  // (UNRESOLVED_POLICY_HOLD) per DataBoundaryEvaluator.evaluate -- these
  // are registered (so the type/registry are internally consistent) but
  // not yet runnable in production.
  | "business_development.intake_classification"
  | "business_development.hat_action_decision"
  // qualify_opportunity's real evidence-sufficiency judgment (and its
  // Partnership/Growth equivalents once built) -- payload is the
  // accumulated evidence text Martin has typed across turns, same
  // category as the two Stage 1/2 tasks above. Sensitivity classification
  // pending Architect review; UNCLASSIFIED in PRODUCTION_TASK_SENSITIVITY
  // until then (fails closed).
  | "business_development.opportunity_qualification"
  // discover_opportunity's real signal-identification reasoning -- payload
  // is Martin's raw Workspace message only, same category as every other
  // BD task above. Sensitivity classification pending Architect review;
  // UNCLASSIFIED in PRODUCTION_TASK_SENSITIVITY until then (fails closed).
  | "business_development.discover_opportunity"
  // research_opportunity's real evidence-organization reasoning -- payload
  // is Martin's raw Workspace message only, same category as every other
  // BD task above. Sensitivity classification pending Architect review;
  // UNCLASSIFIED in PRODUCTION_TASK_SENSITIVITY until then (fails closed).
  | "business_development.research_opportunity"
  // assess_opportunity's real strategic/commercial-relevance judgment --
  // payload is Martin's raw Workspace message only, same category as
  // every other BD task above. Sensitivity classification pending
  // Architect review; UNCLASSIFIED in PRODUCTION_TASK_SENSITIVITY until
  // then (fails closed).
  | "business_development.assess_opportunity"
  // develop_opportunity's real drafting reasoning -- payload is the
  // opportunity's signal + gathered evidence + qualification rationale,
  // same shape as qualify_opportunity's payload, all Martin-typed text.
  // Sensitivity classification pending Architect review; UNCLASSIFIED in
  // PRODUCTION_TASK_SENSITIVITY until then (fails closed).
  | "business_development.develop_opportunity"
  // determine_next_move's real next-action reasoning -- payload is the
  // opportunity's signal + evidence + qualification + developed state,
  // all Martin-derived text, same category as every other BD task.
  // Sensitivity classification pending Architect review; UNCLASSIFIED in
  // PRODUCTION_TASK_SENSITIVITY until then (fails closed).
  | "business_development.determine_next_move"
  // Partnership Development's discover/research/assess/qualify/develop
  // reasoning -- same payload shape as their Opportunity Development
  // counterparts (Martin-derived text: request text, or the
  // partnership's signal/evidence/qualification), partnership-flavored
  // wording rather than reused generic prompts, per Notion's Hat
  // Definition treating Partnership Development as its own specialized
  // Hat, not an alias of Opportunity Development. determine_next_move
  // and the two handoff_to_* actions reuse the existing Hat-agnostic
  // business_development.determine_next_move task and the
  // SemanticTaskId-free preview/approval Handoff pattern respectively --
  // no new registration needed for those three. Sensitivity
  // classification pending Architect review; UNCLASSIFIED in
  // PRODUCTION_TASK_SENSITIVITY until then (fails closed).
  | "business_development.discover_partner"
  | "business_development.research_partner"
  | "business_development.assess_partnership"
  | "business_development.qualify_partnership"
  | "business_development.develop_partnership"
  // Growth & Market Development's discover/research/assess/qualify/develop
  // reasoning -- same payload shape as their Opportunity/Partnership
  // Development counterparts (Martin-derived text: request text, or the
  // growth opportunity's signal/evidence/qualification), growth/market-
  // flavored wording per Notion's Hat Definition treating Growth & Market
  // Development as its own specialized Hat. determine_next_move and the
  // two handoff_to_* actions reuse the existing Hat-agnostic
  // business_development.determine_next_move task and the
  // SemanticTaskId-free preview/approval Handoff pattern respectively --
  // no new registration needed for those three. Sensitivity
  // classification pending Architect review; UNCLASSIFIED in
  // PRODUCTION_TASK_SENSITIVITY until then (fails closed).
  | "business_development.discover_growth_opportunity"
  | "business_development.research_market"
  | "business_development.assess_market_opportunity"
  | "business_development.qualify_growth_opportunity"
  | "business_development.develop_growth_opportunity";

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

/**
 * Outbound Data Gate policy -- the destination/task-aware classification the
 * gate (src/ai/outboundGate.ts) resolves for a SemanticTaskId before any
 * provider.execute() call, per Architect-authorized Outbound Data Gate
 * policy in dataBoundary/policy.ts's PRODUCTION_OUTBOUND_POLICY.
 *
 * TOKEN_SAFE_RUNTIME: the task's outbound payload must contain only
 * Entity_Token/Matter_Token-shaped opaque identifiers, sanitized business
 * context, and ordinary business language -- never a real organisation/
 * person name, email, phone, physical address, or other direct identity/
 * contact information. The gate inspects the actual payload for this; a
 * task-level TOKEN_SAFE_RUNTIME classification is necessary but not
 * sufficient -- content the gate cannot establish as safe still blocks.
 *
 * IDENTITY_AUTHORIZED: the task is explicitly authorized to carry
 * identity-bearing content outbound. Reserved for a specifically authorized
 * identity/artifact execution environment -- never inferred from provider
 * trust, AI confidence, task success, approval state, Handoff existence,
 * urgency, caller identity, or a task merely being Sales-related. No
 * current production task is IDENTITY_AUTHORIZED merely because it exists;
 * see PRODUCTION_OUTBOUND_POLICY's own doc comment for the one task
 * (sales.enquiry_extraction) whose existing, unchanged workflow already
 * requires identity-bearing AI processing by design, and why.
 *
 * A SemanticTaskId absent from PRODUCTION_OUTBOUND_POLICY has no resolved
 * outbound policy at all -- the gate blocks it outright (fail closed), the
 * same "unresolved policy hold" discipline DataBoundaryEvaluator already
 * applies to sensitivity/provider-eligibility resolution.
 */
export type OutboundDataPolicy = "TOKEN_SAFE_RUNTIME" | "IDENTITY_AUTHORIZED";

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
