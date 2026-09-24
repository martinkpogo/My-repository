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
  OutboundDataPolicy,
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
 *
 * sales.commercial_evidence_extraction_handoff and sales.call_qualification_
 * handoff apply the same business_sensitive reasoning to only ONE of two
 * call sites that would otherwise share a single taskId: they're distinct
 * SemanticTaskIds from sales.commercial_evidence_extraction/sales.
 * call_qualification specifically so re-rating the token-safe Handoff-
 * pickup path (handleCallNotesHandoffPickup) never widens provider
 * eligibility for the still-raw live-chat path (handleCallNotes), which
 * keeps the original two client_confidential.
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
  "sales.commercial_evidence_extraction": "client_confidential",
  "sales.call_qualification": "client_confidential",
  // Split from their sales.commercial_evidence_extraction/sales.
  // call_qualification siblings specifically because those two are still
  // reachable from handleCallNotes's live-chat path (raw, pre-tokenization
  // enquiry/call-notes text) -- re-rating the shared taskId would have
  // made that raw path eligible for a real provider too. These _handoff
  // variants are used only by handleCallNotesHandoffPickup, fed
  // exclusively by the isolated Sales Executive project's already
  // de-identified call notes (Section 6A) -- same rationale as
  // finance.quote_judgment: the Entity_Token/Matter_Token data-boundary
  // redesign makes this call's context provably identity-free.
  "sales.commercial_evidence_extraction_handoff": "business_sensitive",
  "sales.call_qualification_handoff": "business_sensitive",
  "sales.proposal_drafting": "client_confidential",
  "sales.proposal_revision": "client_confidential",
  "finance.quote_judgment": "business_sensitive",
  // Same rationale as finance.quote_judgment -- Strategy operates on
  // Entity_Token/Matter_Token and the Handoff's own sanitized text, never
  // a real client identity.
  "strategy.diagnosis": "business_sensitive",
  "strategy.handoff_routing": "business_sensitive",
  // Same rationale -- operates only on the diagnosis already produced by
  // strategy.diagnosis (Entity_Token/Matter_Token + sanitized text), never
  // a real client identity.
  "strategy.proposal_drafting": "business_sensitive",
  // public_sourced, not business_sensitive -- Lead Discovery's evidence
  // originates from the open web, not from ENIG's own internal
  // operations. Never sees the discovered identity/contact itself (see
  // leadDiscovery.ts's redaction step): only a sanitized description of
  // the signal, plus its public source, reaches this call.
  "lead.discovery_classification": "public_sourced",
  // Same rationale as lead.discovery_classification -- the search results
  // this evaluates are all attributed to a real, public source URL.
  "lead.discovery_signal_evaluation": "public_sourced",
  "action.google_doc_intake": "business_sensitive",
  "action.google_doc_comment_edit": "business_sensitive",
  "action.google_sheet_intake": "business_sensitive",
  "action.google_sheet_comment_edit": "business_sensitive",
  "lead.discovery_ondemand_intake": "business_sensitive",
  "lead.discovery_ondemand_query_generation": "business_sensitive",
  // Architect-reviewed: classified on the actual payload each classifier
  // receives (Martin's direct Workspace request text + static Hat/action
  // summaries built from responsibility/description strings), never a
  // Handoff, Entity, or contact field -- structurally identical to
  // marketing.intake_classification/marketing.hat_action_decision, which
  // carry the same rationale. The fact that a BD Hat may later develop a
  // commercially sensitive opportunity does not itself raise this
  // classification -- these two tasks decide where/how ENIG routes the
  // request, they never process the underlying opportunity content.
  "business_development.intake_classification": "business_sensitive",
  "business_development.hat_action_decision": "business_sensitive",
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
const FALLBACK_PROVIDER_SENSITIVITIES = new Set<SensitivityLevel>([
  "public",
  "internal",
  "business_sensitive",
  "public_sourced",
]);

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

/**
 * Architect-authorized Outbound Data Gate policy -- see OutboundDataPolicy's
 * doc comment (dataBoundary/types.ts) for what each value means and the
 * fail-closed rule for a taskId absent from this map. This is the single
 * per-task outbound-policy governance table the Outbound Data Gate
 * (src/ai/outboundGate.ts) consults; it is deliberately kept here, next to
 * PRODUCTION_TASK_SENSITIVITY, rather than in a separate configuration
 * system, and does not duplicate SEMANTIC_TASK_REGISTRY.
 *
 * Every one of the 32 registered SemanticTaskIds is accounted for below --
 * either given a resolved policy, or named in the "deliberately unresolved"
 * comment block explaining why it has none. A task's outbound policy is
 * independent of its PRODUCTION_TASK_SENSITIVITY entry (that governs
 * provider *eligibility*; this governs outbound *content*), though the two
 * are drawn from the same underlying architecture and usually agree.
 *
 * -- TOKEN_SAFE_RUNTIME --
 * sales.commercial_evidence_extraction_handoff / sales.call_qualification_
 * handoff: used only by handleCallNotesHandoffPickup -- the isolated Sales
 * Executive project's already de-identified call notes (Section 6A),
 * carrying only Entity_Token/Matter_Token and sanitized narrative text.
 * Their raw-text siblings (sales.commercial_evidence_extraction / sales.
 * call_qualification, still used by handleCallNotes's live-chat path)
 * remain client_confidential and unresolved below -- see that entry.
 *
 * strategy.diagnosis / strategy.handoff_routing / strategy.proposal_drafting,
 * finance.quote_judgment, sales.proposal_drafting / sales.proposal_revision:
 * per the Entity_Token/Matter_Token data-boundary redesign, these operate
 * on opaque tokens and sanitized Handoff/Proposal text, never a real client
 * identity -- the current expected posture for this Outbound Data Gate
 * task. NOTE: sales.proposal_drafting/sales.proposal_revision's own current
 * runtime prompt construction (salesExecutive.ts's legacy handleQuoteReceived/
 * handleProposalFeedback -- the path used only for a non-Finance-origin
 * Sales Handoff while SALES_EXECUTIVE_PAUSED is false) still interpolates
 * state.entityName and raw state.enquiryText/callNotes directly into the
 * prompt, which the gate's own content detectors will correctly BLOCK if
 * that path is ever exercised with real identity present. That is an
 * existing gap in salesExecutive.ts, exposed rather than fixed by this
 * table -- fixing the prompt itself is out of this task's scope.
 *
 * research.context_relevance / research.protocol_selection /
 * research.plan_generation / research.synthesis / research.handoff_routing:
 * R&I operates on Entity_Token/Matter_Token, Martin's own direct chat
 * requests, or already-sanitized supplied context -- never a real client
 * identity (no existing governance rule requires otherwise for any of the
 * five).
 *
 * lead.discovery_classification: leadDiscovery.ts's own
 * redactSignalForClassification strips the discovered name/contact before
 * this task's prompt is ever built -- the classifier only ever sees
 * sanitized evidence text.
 *
 * lead.discovery_signal_evaluation: deliberately exempted from this gate's
 * company-name detector specifically (see OUTBOUND_POLICY_PUBLIC_SOURCE_
 * EXEMPT_TASKS below) -- this task's whole job is evaluating attributed
 * public web-search results, which legitimately and by design name a real,
 * publicly-discoverable organisation (that's what "organisation": "<name
 * if identifiable>" in its own response schema means). This is a real
 * organisation name, but not ENIG's own confidential client/contact
 * identity -- the Entity_Token/Matter_Token boundary this gate otherwise
 * protects has no token for a company ENIG hasn't engaged. Email/phone/
 * address/person-name detectors still apply in full -- a discovered
 * person's direct contact detail is never let through.
 *
 * lead.discovery_ondemand_intake / lead.discovery_ondemand_query_generation:
 * operate only on Martin's own request text -- per their own registry
 * descriptions, never a company name, decision-maker, or contact.
 *
 * marketing.intake_classification / marketing.hat_action_decision: operate
 * only on Martin's own internal Marketing-task text, about ENIG's own
 * internal operations -- no Unit other than Sales can be handed a real
 * client identity to begin with (Entity/Matters/Proposals access is
 * exclusively the isolated Sales Executive project's now).
 *
 * action.google_doc_intake / action.google_doc_comment_edit /
 * action.google_sheet_intake / action.google_sheet_comment_edit: operate on
 * Martin's own request text or his own Google Doc/Sheet content for
 * internal operational documents (e.g. a content calendar) -- not a
 * channel real client identity flows through today. Content-level
 * detectors still apply as defense-in-depth.
 *
 * chat.general_reply: TOKEN_SAFE_RUNTIME as the task-level default, safe
 * specifically because the one genuinely risky case -- the Sales Unit
 * persona, where Martin could paste real enquiry text -- is already,
 * separately blocked upstream by this task's own client_confidential
 * PRODUCTION_TASK_SENSITIVITY default (chatSensitivityForUnit in chat.ts
 * passes no override for Sales, and no provider is eligible for
 * client_confidential) before a Sales-Unit call ever reaches this gate.
 * Every other Unit's chat persona is architecturally never handed a real
 * client identity (see the marketing.* rationale above) -- for those the
 * TOKEN_SAFE_RUNTIME default is both correct and, per the same
 * architectural guarantee, safe.
 *
 * -- IDENTITY_AUTHORIZED --
 * sales.enquiry_extraction: inspected, not assumed. Its one and only job
 * (salesExecutive.ts's handleIncomingEnquiry/handleEntityRedoReason) is to
 * extract the sender's name/organisation/email/phone FROM the raw incoming
 * enquiry text -- the identity is already present in the outbound prompt by
 * construction; a TOKEN_SAFE_RUNTIME classification would permanently and
 * incorrectly block this task's only legitimate use. This is NOT the
 * identity/artifact execution environment IDENTITY_AUTHORIZED is otherwise
 * reserved for -- it is a narrow, explicit exception for one existing task
 * whose current, unchanged workflow genuinely requires identity-bearing
 * input, made explicitly here rather than assumed. It is not inferred from
 * this being a Sales task, from provider trust, or from anything else this
 * type's doc comment rules out: sales.enquiry_extraction is
 * PRODUCTION_TASK_SENSITIVITY's own "pii_restricted" entry, and no
 * provider is eligible for pii_restricted today -- this Outbound Data Gate
 * entry does not change that; it only establishes the policy this gate
 * itself would apply if that separate, unrelated restriction were ever
 * lifted.
 *
 * -- Deliberately unresolved (no entry below; the gate blocks these) --
 * routing.enquiry_classification / routing.marketing_specialization_check /
 * routing.research_specialization_check: each sends the raw,
 * not-yet-classified incoming Workspace message text -- exactly the text
 * that, when it IS a client enquiry (the case these classifiers exist to
 * detect), is expected to describe the prospect's business/situation and
 * may well name it. Workspace Chat/Cowork mode routing and responsibility
 * resolution no longer use an AI classifier at all (see workspaceRouter.ts
 * -- mode is Martin's own explicit choice and responsibility resolution is
 * deterministic structural matching against the finite Unit/Hat registry),
 * so these three classifiers are unreachable in production for the same
 * reason they always were: client_confidential has no eligible provider in
 * PRODUCTION_PROVIDER_ELIGIBILITY above. This is a deliberate, existing
 * governance boundary, not a defect introduced here -- left genuinely
 * unresolved rather than given a TOKEN_SAFE_RUNTIME label the content
 * doesn't support, so a future change to provider eligibility doesn't
 * silently start sending identity-bearing raw Workspace text through this
 * gate under a mislabeled policy.
 *
 * sales.matter_summary_drafting / sales.call_prep_briefing /
 * sales.commercial_evidence_extraction / sales.call_qualification: operate
 * on raw, pre-tokenization enquiry text and/or call notes -- call_prep_
 * briefing's own prompt construction includes state.entityName directly.
 * Same rationale as the routing.* classifiers above: client_confidential,
 * already unreachable, deliberately left unresolved rather than mislabeled.
 * The last two have a token-safe _handoff sibling (see TOKEN_SAFE_RUNTIME
 * above) for the one call site that is provably identity-free; these
 * entries themselves stay unresolved because handleCallNotes's live-chat
 * path still is not.
 */
export const PRODUCTION_OUTBOUND_POLICY: Readonly<Partial<Record<SemanticTaskId, OutboundDataPolicy>>> = {
  "chat.general_reply": "TOKEN_SAFE_RUNTIME",
  "marketing.intake_classification": "TOKEN_SAFE_RUNTIME",
  "marketing.hat_action_decision": "TOKEN_SAFE_RUNTIME",
  "research.context_relevance": "TOKEN_SAFE_RUNTIME",
  "research.protocol_selection": "TOKEN_SAFE_RUNTIME",
  "research.plan_generation": "TOKEN_SAFE_RUNTIME",
  "research.synthesis": "TOKEN_SAFE_RUNTIME",
  "research.handoff_routing": "TOKEN_SAFE_RUNTIME",
  "sales.proposal_drafting": "TOKEN_SAFE_RUNTIME",
  "sales.proposal_revision": "TOKEN_SAFE_RUNTIME",
  "sales.commercial_evidence_extraction_handoff": "TOKEN_SAFE_RUNTIME",
  "sales.call_qualification_handoff": "TOKEN_SAFE_RUNTIME",
  "finance.quote_judgment": "TOKEN_SAFE_RUNTIME",
  "strategy.diagnosis": "TOKEN_SAFE_RUNTIME",
  "strategy.handoff_routing": "TOKEN_SAFE_RUNTIME",
  "strategy.proposal_drafting": "TOKEN_SAFE_RUNTIME",
  "lead.discovery_classification": "TOKEN_SAFE_RUNTIME",
  "lead.discovery_signal_evaluation": "TOKEN_SAFE_RUNTIME",
  "lead.discovery_ondemand_intake": "TOKEN_SAFE_RUNTIME",
  "lead.discovery_ondemand_query_generation": "TOKEN_SAFE_RUNTIME",
  "action.google_doc_intake": "TOKEN_SAFE_RUNTIME",
  "action.google_doc_comment_edit": "TOKEN_SAFE_RUNTIME",
  "action.google_sheet_intake": "TOKEN_SAFE_RUNTIME",
  "action.google_sheet_comment_edit": "TOKEN_SAFE_RUNTIME",
  // Explicit, narrow, inspected exception -- see this map's own doc comment.
  "sales.enquiry_extraction": "IDENTITY_AUTHORIZED",
};

/**
 * Tasks exempted from the Outbound Data Gate's company/organisation-name
 * detector specifically (every other detector -- email, phone, address,
 * person-name/title, labeled contact field -- still applies in full). See
 * PRODUCTION_OUTBOUND_POLICY's own doc comment, lead.discovery_signal_
 * evaluation entry, for the rationale: this task's legitimate, by-design
 * subject matter is a real, publicly-discoverable organisation name found
 * via public web search, which is not the same thing as a leak of ENIG's
 * own confidential client/contact identity.
 */
export const OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS: ReadonlySet<SemanticTaskId> = new Set<SemanticTaskId>([
  "lead.discovery_signal_evaluation",
]);

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
