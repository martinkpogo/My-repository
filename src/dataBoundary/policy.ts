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
 * GOVERNANCE HOLD: Production task sensitivities and provider eligibility tables are
 * deliberately empty / unresolved pending explicit Architect authorization.
 *
 * The evaluation engine strictly fails closed for any unresolved policy mapping.
 * No implicit default sensitivity, no automatic public classification, and no
 * default provider authorization exist in production code.
 */
export const PRODUCTION_TASK_SENSITIVITY: Readonly<Partial<Record<SemanticTaskId, SensitivityLevel>>> = {};

export const PRODUCTION_PROVIDER_ELIGIBILITY: Readonly<Partial<Record<ProviderId, ProviderEligibilityRule>>> = {};

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
