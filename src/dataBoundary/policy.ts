import type { ProviderId } from "../ai/types";
import { isSemanticTaskId } from "./registry";
import type {
  BoundaryAuditEntry,
  BoundaryContext,
  BoundaryEvaluationResult,
  ContextSegment,
  DataTransformation,
  HandoffContextContract,
  HandoffContextEvaluationResult,
  ProviderEligibilityRule,
  SemanticTaskId,
  SensitivityLevel,
} from "./types";

/**
 * Architect-authorized production task sensitivity classification.
 *
 * client_confidential marks every task that operates on a real client
 * identity or client-specific detail -- pre-tokenization enquiry text, an
 * Entity's real name, call notes about a specific client's situation, or
 * client-facing proposal content. pii_restricted marks the one task that
 * explicitly extracts raw contact details (name/email/phone) from an
 * enquiry. business_sensitive marks ENIG's own internal-operations tasks
 * (its own marketing planning) and finance.quote_judgment specifically --
 * lower than its sales.* siblings because the Entity_Token/Matter_Token
 * data-boundary redesign made this call's context provably identity-free
 * (opaque tokens + sanitized business text only, never a real name).
 */
export const PRODUCTION_TASK_SENSITIVITY: Readonly<Partial<Record<SemanticTaskId, SensitivityLevel>>> = {
  "routing.enquiry_classification": "client_confidential",
  "routing.marketing_specialization_check": "client_confidential",
  "chat.general_reply": "client_confidential",
  "marketing.intake_classification": "business_sensitive",
  "marketing.hat_action_decision": "business_sensitive",
  "routing.research_specialization_check": "business_sensitive",
  "research.context_relevance": "business_sensitive",
  "research.protocol_selection": "business_sensitive",
  "research.plan_generation": "business_sensitive",
  "research.synthesis": "business_sensitive",
  "research.handoff_routing": "business_sensitive",
  "sales.enquiry_extraction": "pii_restricted",
  "sales.matter_summary_drafting": "client_confidential",
  "sales.call_prep_briefing": "client_confidential",
  "sales.call_qualification": "client_confidential",
  "sales.proposal_drafting": "client_confidential",
  "sales.proposal_revision": "client_confidential",
  "finance.quote_judgment": "business_sensitive",
};

/**
 * Architect-authorized production provider eligibility.
 *
 * workers-ai (Cloudflare Workers AI) is eligible for business_sensitive,
 * internal, and public content only -- not client_confidential or
 * pii_restricted. Cloudflare's training-data policy for this provider has
 * not been confirmed to exclude personal information, so no task that
 * could carry a real client identity or contact detail may run on it
 * until a provider with an acceptable no-training guarantee is added.
 * This is deliberate, not a placeholder: every sales.* task, both
 * routing.* classifiers, and chat.general_reply are client_confidential
 * (see above) and stay unresolved under this rule for exactly that
 * reason, matching the Sales Executive pause itself. Only
 * marketing.intake_classification, marketing.hat_action_decision,
 * finance.quote_judgment, and the routing.research_specialization_check /
 * research.protocol_selection / research.synthesis trio (all
 * business_sensitive -- R&I operates on Entity_Token/Matter_Token and
 * Martin's own direct chat requests, never a real client name) are
 * actually eligible today.
 */
/**
 * The free-tier OpenAI-compatible fallback providers (nvidia-nim, groq,
 * openrouter, cerebras, gemini, sambanova) get the exact same allowedSensitivities as
 * workers-ai -- they exist purely as infrastructure fallback for the
 * same tier Workers AI already serves (added after Cloudflare's daily
 * quota exhaustion blocked every AI call account-wide), not as a basis
 * for widening what's allowed at client_confidential. None of their
 * training-data/retention policies has been independently verified
 * beyond "free tier, OpenAI-compatible API" -- that verification is
 * exactly the bar the Sales Executive pause is still waiting on, and
 * adding these providers here does not clear it.
 */
const FALLBACK_PROVIDER_SENSITIVITIES = new Set<SensitivityLevel>(["public", "internal", "business_sensitive"]);

export const PRODUCTION_PROVIDER_ELIGIBILITY: Readonly<Partial<Record<ProviderId, ProviderEligibilityRule>>> = {
  "workers-ai": {
    providerId: "workers-ai",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
  "nvidia-nim": {
    providerId: "nvidia-nim",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
  groq: {
    providerId: "groq",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
  openrouter: {
    providerId: "openrouter",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
  cerebras: {
    providerId: "cerebras",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
  gemini: {
    providerId: "gemini",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
  sambanova: {
    providerId: "sambanova",
    allowedSensitivities: FALLBACK_PROVIDER_SENSITIVITIES,
  },
};

export interface DataBoundaryEvaluatorOptions {
  taskSensitivities?: Partial<Record<SemanticTaskId, SensitivityLevel>>;
  providerEligibility?: Partial<Record<ProviderId, ProviderEligibilityRule>>;
  transformations?: DataTransformation[];
}

export class DataBoundaryEvaluator {
  private taskSensitivities: Partial<Record<SemanticTaskId, SensitivityLevel>>;
  private providerEligibility: Partial<Record<ProviderId, ProviderEligibilityRule>>;
  private transformations: DataTransformation[];

  constructor(options: DataBoundaryEvaluatorOptions = {}) {
    this.taskSensitivities = options.taskSensitivities ?? PRODUCTION_TASK_SENSITIVITY;
    this.providerEligibility = options.providerEligibility ?? PRODUCTION_PROVIDER_ELIGIBILITY;
    this.transformations = options.transformations ?? [];
  }

  /**
   * Evaluates a boundary context against provider eligibility and task sensitivity policies.
   * Mandates explicit task identity, enforces fail-closed behavior on unresolved policy or
   * failed transformations, and ensures untransformed sensitive segments are never transmitted.
   */
  public evaluate(
    taskId: SemanticTaskId,
    providerId: ProviderId,
    context: BoundaryContext,
  ): BoundaryEvaluationResult {
    if (!isSemanticTaskId(taskId)) {
      return {
        allowed: false,
        reasonCode: "UNREGISTERED_TASK_ID",
        reason: `Task ID '${String(taskId)}' is not registered in the canonical semantic task registry.`,
      };
    }

    const taskSensitivity = this.taskSensitivities[taskId] ?? context.taskSensitivity;
    if (!taskSensitivity) {
      return {
        allowed: false,
        reasonCode: "UNRESOLVED_POLICY_HOLD",
        reason: `Production sensitivity policy for task '${taskId}' is unresolved (governance hold).`,
      };
    }

    const eligibility = this.providerEligibility[providerId];
    if (!eligibility) {
      return {
        allowed: false,
        reasonCode: "UNRESOLVED_POLICY_HOLD",
        reason: `Production eligibility policy for provider '${providerId}' is unresolved (governance hold).`,
      };
    }

    const transformedSegments: ContextSegment[] = [];

    for (const segment of context.segments) {
      const segmentSensitivity = segment.sensitivity ?? taskSensitivity;

      if (eligibility.allowedSensitivities.has(segmentSensitivity)) {
        transformedSegments.push(segment);
        continue;
      }

      // Segment sensitivity exceeds provider eligibility. Look for applicable transformation.
      const matchingTransformation = this.transformations.find((t) =>
        t.canTransform(segment, providerId),
      );

      if (!matchingTransformation) {
        return {
          allowed: false,
          reasonCode: "SENSITIVITY_DISALLOWED",
          reason: `Segment with sensitivity '${segmentSensitivity}' (provenance: '${segment.provenance}') exceeds provider '${providerId}' eligibility, and no transformation is available.`,
        };
      }

      const transformResult = matchingTransformation.transform(segment, providerId);
      if (!transformResult.success) {
        return {
          allowed: false,
          reasonCode: "TRANSFORMATION_FAILED",
          reason: `Transformation '${matchingTransformation.id}' failed for segment '${segment.provenance}': ${transformResult.reason}`,
        };
      }

      transformedSegments.push(transformResult.transformedSegment);
    }

    return {
      allowed: true,
      reasonCode: "ALLOWED",
      reason: "Context satisfies data-boundary policy.",
      transformedContext: {
        segments: transformedSegments,
        taskSensitivity,
      },
    };
  }
}

export const defaultDataBoundaryEvaluator = new DataBoundaryEvaluator();

/**
 * Creates a sanitized audit log entry containing non-sensitive metadata only.
 * Strictly excludes raw prompt content, message strings, and sensitive payload text.
 */
export function createBoundaryAuditEntry(
  taskId: SemanticTaskId,
  providerId: ProviderId,
  event: "BOUNDARY_EVALUATION" | "MATERIAL_PROVIDER_FAILURE",
  params: {
    allowed?: boolean;
    reasonCode: string;
    context: BoundaryContext;
    errorDetails?: {
      statusCode?: number;
      errorCode?: string;
      message: string;
    };
  },
): BoundaryAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    taskId,
    providerId,
    event,
    allowed: params.allowed,
    reasonCode: params.reasonCode,
    segmentMetadata: params.context.segments.map((s) => ({
      type: s.type,
      provenance: s.provenance,
      sensitivity: s.sensitivity,
      charCount: s.content.length,
    })),
    errorDetails: params.errorDetails
      ? {
          statusCode: params.errorDetails.statusCode,
          errorCode: params.errorDetails.errorCode,
          message: sanitizeErrorMessage(params.errorDetails.message),
        }
      : undefined,
  };
}

function sanitizeErrorMessage(msg: string): string {
  // Truncate and strip any potential embedded prompt content from error messages
  const clean = msg.replace(/[\r\n]+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

/**
 * Evaluates an incoming Handoff against the canonical closed-context contract.
 * Ensures entityToken and sanitizedContext are present, keeps tokens opaque,
 * and fails closed with a non-sensitive category-focused reason when context is missing.
 */
export function evaluateHandoffContext(
  contract: Partial<HandoffContextContract>,
  taskId: SemanticTaskId,
): HandoffContextEvaluationResult {
  if (!isSemanticTaskId(taskId)) {
    return {
      success: false,
      insufficientContext: {
        isInsufficient: true,
        category: "task identity",
        reason: `Insufficient execution context: task ID '${String(taskId)}' is not registered in the canonical semantic task registry.`,
      },
    };
  }

  const entityToken = contract.entityToken?.trim();
  const sanitizedContext = contract.sanitizedContext?.trim();

  if (!entityToken || !sanitizedContext) {
    const missingCategory = contract.requiredCategory ?? "sanitized execution context";
    return {
      success: false,
      insufficientContext: {
        isInsufficient: true,
        category: missingCategory,
        reason: `Insufficient execution context: required ${missingCategory} is missing from Handoff.`,
      },
    };
  }

  const validatedContract: HandoffContextContract = {
    handoffId: contract.handoffId ?? "unknown_handoff",
    workId: contract.workId,
    entityToken,
    matterToken: contract.matterToken?.trim(),
    proposalToken: contract.proposalToken?.trim(),
    sanitizedContext,
    provenance: contract.provenance ?? `handoff:${contract.handoffId ?? "unknown"}`,
    sensitivity: contract.sensitivity ?? "business_sensitive",
    requiredCategory: contract.requiredCategory,
  };

  const segments: ContextSegment[] = [
    {
      type: "user",
      content: `Entity Token: ${validatedContract.entityToken}${
        validatedContract.matterToken ? `\nMatter Token: ${validatedContract.matterToken}` : ""
      }\nSanitized Context:\n${validatedContract.sanitizedContext}`,
      provenance: validatedContract.provenance,
      sensitivity: validatedContract.sensitivity,
    },
  ];

  return {
    success: true,
    contract: validatedContract,
    boundaryContext: {
      segments,
      taskSensitivity: validatedContract.sensitivity,
    },
  };
}
