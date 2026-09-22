import type { InlineButton } from "./telegram";

export interface Env {
  AI: Ai;
  WORK_SESSION: DurableObjectNamespace;
  STATE_KV: KVNamespace;

  NOTION_VERSION: string;
  AI_MODEL_PRIMARY: string;
  AI_MODEL_LIGHT: string;
  ENTITY_DATA_SOURCE_ID: string;
  MATTERS_DATA_SOURCE_ID: string;
  PROPOSALS_DATA_SOURCE_ID: string;
  HANDOFFS_DATA_SOURCE_ID: string;
  ACTIVITY_LOG_DATA_SOURCE_ID: string;
  /**
   * The Leads database -- the pre-Entity acquisition/prospecting record
   * Lead Discovery writes to. A Lead is created here on discovery alone;
   * an Entity is only created/matched once a response or expression of
   * interest demonstrates real engagement (see the canonical Lead
   * Business Object page). Distinct data source from ENTITY_DATA_SOURCE_ID.
   */
  LEADS_DATA_SOURCE_ID: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MARTIN_TELEGRAM_USER_ID: string;
  NOTION_TOKEN: string;
  READAI_WEBHOOK_SECRET?: string;
  READAI_OAUTH_CLIENT_ID?: string;
  READAI_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  /**
   * JSON object mapping Unit name -> Telegram forum topic message_thread_id,
   * e.g. {"Sales": 2, "Finance": 4}. Optional — when unset, the bot behaves
   * as a plain 1:1 chat with no topic awareness (legacy/DM mode).
   */
  UNIT_TOPIC_MAP?: string;

  /** The ENIG HQ Supergroup's chat id (negative number). Required for two-stream architecture. */
  TELEGRAM_GROUP_CHAT_ID?: string;

  /** The Workspace stream topic message_thread_id in ENIG HQ Supergroup. */
  WORKSPACE_TOPIC_ID?: string;

  /** The Operations stream topic message_thread_id in ENIG HQ Supergroup. */
  OPERATIONS_TOPIC_ID?: string;

  /** Shared secret for the Gmail-polling Apps Script -> /email/webhook. */
  EMAIL_WEBHOOK_SECRET?: string;

  /**
   * The Notion webhook subscription's verification token, used as the HMAC
   * key for validating the X-Notion-Signature header on every event
   * delivery to /notion/webhook (see notionWebhook.ts). Notion issues this
   * token during the one-time verification handshake when the subscription
   * is first created in the Notion integration dashboard -- it must be
   * copied from there into this secret (`wrangler secret put
   * NOTION_WEBHOOK_SECRET`) by hand; nothing in this codebase creates,
   * registers, or modifies the actual Notion subscription. Unset means the
   * webhook endpoint fails closed (rejects every event) rather than
   * accepting unverified deliveries.
   */
  NOTION_WEBHOOK_SECRET?: string;

  /**
   * Tavily search API key, used only by Research & Intelligence's live
   * web-search capability (src/units/research/webSearch.ts). Optional --
   * unset means R&I stays closed-book (reasons only over supplied
   * context, same as before this capability existed) rather than
   * failing; never a required secret for the rest of the runtime.
   */
  TAVILY_API_KEY?: string;

  /**
   * Free-tier AI provider fallback keys (src/ai/openaiCompatible.ts),
   * all optional -- added after Cloudflare Workers AI's daily quota
   * exhaustion blocked every AI-driven Hat/Unit at once. Each is a no-op
   * in the provider fallback chain unless its own key is set; none
   * widens what's allowed at client_confidential (see dataBoundary/
   * policy.ts) -- they're fallback for the same business_sensitive-and-
   * below tier Workers AI already serves.
   */
  NVIDIA_NIM_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Cerebras Cloud -- same fallback tier as the other OpenAI-compatible providers above. */
  CEREBRAS_API_KEY?: string;
  /** Google AI Studio (Gemini) -- same fallback tier as the other OpenAI-compatible providers above. */
  GEMINI_API_KEY?: string;
  /** SambaNova Cloud -- same fallback tier as the other OpenAI-compatible providers above. */
  SAMBANOVA_API_KEY?: string;
}

export type Unit =
  | "Sales"
  | "Marketing"
  | "Business Development"
  | "Finance"
  | "Strategy"
  | "Research & Intelligence"
  | "Creative & Design"
  | "Operations";

export type QualificationAssessment = "Satisfied" | "Not Satisfied" | "Insufficient Evidence";

export interface QualificationConditionResult {
  condition:
    | "within_specialization"
    | "allows_diagnosis_first"
    | "commercial_value_evidence"
    | "open_to_ballpark_amount_and_time"
    | "ready_to_commit_required_resources";
  evidence: string;
  assessment: QualificationAssessment;
}

/**
 * Distinguishes how a commercial number was arrived at, per the Commercial
 * Value & Pricing Operating Model's Section 3 (Value-at-Stake Assessment).
 * An assumption is never equivalent to measured or client-estimated
 * evidence -- callers must not treat it as satisfying an evidence
 * requirement on its own.
 */
export type EvidenceType = "directly_measured" | "client_estimated" | "derived" | "assumption";

/**
 * A single commercial-value figure, expressed as a range where precision
 * isn't warranted (per the model's "a value-at-stake range is preferable
 * to false precision"). Used for both value-at-stake and cost-of-inaction
 * figures -- same shape, same evidentiary discipline.
 */
export interface ValueAtStake {
  /** A single point figure, when the evidence supports one rather than a range. */
  value?: number;
  low?: number;
  high?: number;
  currency?: string;
  /** The period this figure applies over, e.g. "annual", "6-12 months". */
  period?: string;
  evidenceType?: EvidenceType;
  /** Who/what this figure is attributable to, e.g. "client-stated (Comfort, call 2026-09-20)". */
  source?: string;
  evidenceQuality?: string;
  assumptions?: string;
  limitations?: string;
}

/**
 * Structured commercial-value evidence captured during Sales discovery, per
 * the Commercial Value & Pricing Operating Model. This is the pricing
 * basis Finance judges against -- investment tolerance is deliberately
 * NOT part of this structure (see WorkState.investmentToleranceContext).
 */
export interface CommercialEvidence {
  /** What the problem is costing, or could cost if unresolved -- free text, may be qualitative. */
  financialConsequence?: string;
  valueAtStake?: ValueAtStake;
  costOfInaction?: ValueAtStake;
  /** The specific revenue stream or opportunity the problem/value connects to. */
  affectedRevenueOrOpportunity?: string;
  desiredMeasurableOutcome?: string;
  /** Any material uncertainty about the evidence as a whole, beyond what's captured per-figure. */
  uncertainty?: string;
}

/**
 * A client's stated investment range or boundary -- per the Commercial
 * Value & Pricing Operating Model Section 7, this is a scope/fit sanity
 * check only. It is NEVER part of CommercialEvidence and must never be
 * used, by Sales or Finance, as the pricing basis or as a substitute for
 * value-at-stake evidence. Carried through the Handoff as context only.
 */
export interface InvestmentToleranceContext {
  low?: number;
  high?: number;
  currency?: string;
  period?: string;
}

/**
 * The commercial baseline preserved once an intervention is approved, per
 * the Commercial Value & Pricing Operating Model Section 8 (Measurement
 * Baseline) -- so the same evidence used to justify the intervention can
 * later support measurement without re-litigating attribution.
 */
export interface MeasurementBaseline {
  baselineMetric?: string;
  baselineValue?: string;
  baselinePeriod?: string;
  source?: string;
  evidenceQuality?: string;
  targetOutcome?: string;
  measurementPeriod?: string;
  assumptions?: string;
  limitations?: string;
}

export interface QualificationResult {
  conditions: QualificationConditionResult[];
  overall: "Qualified" | "Not Qualified" | "More Information Required";
}

export interface Quote {
  price: number;
  /**
   * The currency Finance's own judgment quoted the price in (e.g. "GHS",
   * "USD") -- read verbatim from the AI's structured judgement, never
   * assumed or hardcoded. Optional only for backward compatibility with a
   * quote parsed from a legacy "$<amount>"-formatted Handoff record that
   * predates currency being carried explicitly.
   */
  currency?: string;
  rationale: string;
}

export interface PendingApproval {
  kind:
    | "entity_match"
    | "matter_match"
    | "lead_to_prospect"
    | "proposal_draft"
    | "revision_feedback";
  summary: string;
  payload?: unknown;
}

export interface WorkState {
  workId: string;
  chatId: number;
  threadId?: number;
  unit?: Unit;
  hat?: string;
  stage: string;
  awaiting?:
    | "call_notes"
    | "proposal_feedback"
    | "entity_pick"
    | "matter_pick"
    | "intervention"
    | "value_context_more"
    | "quote_redo_reason"
    | "matter_redo_reason"
    | "entity_redo_reason"
    | "marketing_feedback"
    | "marketing_clarification"
    | "research_clarification"
    | "research_feedback"
    | "strategy_clarification"
    | "strategy_feedback"
    | "strategy_refinement_reason";
  createdAt: string;
  updatedAt: string;

  enquiryText?: string;
  /**
   * How this Sales work item originated -- carried onto the Sales -> Finance
   * Handoff's Reason so Finance has that context, and required (fail-closed,
   * never defaulted) before that Handoff may be created. "inbound_enquiry"
   * is set by handleIncomingEnquiry, the only origination path this Worker
   * currently drives; "outbound_outreach" exists for a work item originating
   * from proactive outreach (e.g. off the back of an approved Lead
   * Opportunity) -- exactly two values, no others.
   */
  entryType?: "inbound_enquiry" | "outbound_outreach";
  /**
   * Structured commercial-value evidence extracted from enquiry text/call
   * notes during discovery, per the Commercial Value & Pricing Operating
   * Model -- the pricing basis carried to Finance via the Handoff. Set by
   * handleCallNotes's extraction step; deterministically validated (never
   * taken on the AI's own say-so) before it can satisfy the
   * commercial_value_evidence qualification condition.
   */
  commercialEvidence?: CommercialEvidence;
  /**
   * Client-stated investment range/boundary -- context only. See
   * InvestmentToleranceContext's doc comment: never the pricing basis,
   * never a substitute for commercialEvidence.
   */
  investmentToleranceContext?: InvestmentToleranceContext;
  /**
   * The commercial baseline preserved once Lead->Prospect is approved, for
   * later measurement per the operating model's Section 8. Set once from
   * commercialEvidence at qualification time and carried onto the Matter
   * record; not re-derived downstream.
   */
  measurementBaseline?: MeasurementBaseline;
  entityId?: string;
  /** Human-readable Entity name -- only ever populated by a Unit that has legitimately resolved the real identity (Sales). Never overload this with a token. */
  entityName?: string;
  matterId?: string;
  /** Human-readable Matter name -- only ever populated by a Unit that has legitimately resolved the real identity (Sales). Never overload this with a token. */
  matterName?: string;
  /**
   * The opaque Entity_Token (e.g. "E-20") this work item operates under.
   * Units that operate on Handoffs only (Strategy, Finance, R&I) never
   * learn a real Entity name at all, per the closed-context contract in
   * dataBoundary/policy.ts -- this is the identity they actually have, and
   * is what must be used in any Handoff field or Telegram message they
   * produce. Distinct from entityName, which some of those Units'
   * discovery code previously (incorrectly) overloaded to hold this same
   * token -- see the centralized Handoff writer (src/handoffWriter.ts).
   */
  entityToken?: string;
  /** The opaque Matter_Token (e.g. "MAT-20") this work item operates under. See entityToken's doc comment -- same semantics, Matter side. */
  matterToken?: string;
  handoffId?: string;
  callNotes?: string;
  qualification?: QualificationResult;
  proposedIntervention?: string;
  quote?: Quote;
  proposalDraft?: string;
  proposalRevisionCount?: number;
  pendingApproval?: PendingApproval;
  candidateEntities?: { id: string; name: string }[];
  candidateMatters?: { id: string; name: string }[];
  blockedReason?: string;

  /**
   * A proposed new Matter's drafted title + stated need, shown to Martin
   * for approval before the record is created — per the Sales AI Project
   * Instructions' Matter identification rule ("pass through the applicable
   * creation authorization gate before creating the Matter record").
   */
  matterDraft?: { name: string; statedNeed: string };

  /**
   * A proposed new Entity's drafted fields, shown to Martin for approval
   * before the record is created — per the same Universal Role Contract
   * rule ("Drafted content...shown in chat for approval before being
   * written to Notion") applied to Matter creation above.
   */
  entityDraft?: { name: string; email: string; phone: string; type: string };

  /**
   * Set when Finance (or another picked-up Unit) has posted a blocker to its
   * OWN topic and is awaiting a reply there, rather than in the topic the
   * enquiry originated from. Lets a reply typed in that topic resume this
   * session, and lets terminal cleanup clear that topic's active pointer too.
   */
  financeThreadId?: number;

  /** Original task text for a Marketing work item — carried across redo/clarification loops. */
  marketingTaskText?: string;
  /** The current Marketing Hat's drafted output, shown to Martin for approval before anything is treated as done. */
  marketingDraft?: string;
  /** A proposed transition to another Marketing Hat (routing or escalation), pending Martin's confirmation. */
  pendingTransition?: { toHat: string; reason: string };
  /** A proposed paid-media/spend action, pending Martin's explicit budget/spend approval. */
  pendingPaidMediaAction?: { description: string };

  /** The research question a R&I work item is answering -- carried across clarification/feedback loops. */
  researchQuestion?: string;
  /** Sanitized supplied context (from a Handoff's own record, or Martin's direct chat request). */
  researchContext?: string;
  /** Preserved per the protocol-selection execution record requirement -- which protocol(s) this work item activated. */
  selectedResearchProtocols?: import("./units/research/protocols").ResearchProtocolId[];
  /** The canonical Research-Safe Consultancy Context, cached per work item once retrieved+validated so it isn't re-fetched on every clarification/feedback turn. */
  researchSafeContext?: string;
  /** What the current research question means in relation to the authorized safe-context category -- re-derived whenever the question changes. */
  researchRelevance?: string;
  /** The Telegram message id of the "researching this now" acknowledgment, edited in place at each pipeline stage rather than sending a new message per stage. */
  researchProgressMessageId?: number;
  /**
   * A proposed R&I -> consuming-Hat handoff, pending Martin's explicit
   * approval before the Handoff record is created -- per Martin's
   * request for a preview/approval gate rather than the fully automatic
   * routing this originally shipped with.
   */
  pendingResearchHandoff?: {
    unit: Unit;
    hat: string;
    reason: string;
    handoffTitle: string;
    verifiedFactsAndSources: string;
  };

  /** The strategic question/business situation a Strategy work item is diagnosing -- carried across clarification/feedback loops. */
  strategyQuestion?: string;
  /** Sanitized supplied context (from a Handoff's own record) the diagnosis is grounded in. */
  strategyContext?: string;
  /** The Telegram message id of the "diagnosing this now" acknowledgment, edited in place per stage -- mirrors researchProgressMessageId. */
  strategyProgressMessageId?: number;
  /** The most recently delivered structured diagnosis -- preserved so a downstream Handoff proposal can be built/rebuilt from it without re-running the AI call. */
  strategyDiagnosis?: import("./units/strategy/strategyAnalyst").StrategyDiagnosisResult;
  /**
   * A proposed Strategy -> another-Unit handoff, pending Martin's explicit
   * approval before the Handoff record is created -- mirrors
   * pendingResearchHandoff's own preview/approval gate exactly. A
   * recommendation is never treated as authorization to route it onward.
   */
  pendingStrategyHandoff?: {
    unit: Unit;
    hat: string;
    handoffTitle: string;
    reason: string;
    requiredNextAction: string;
    expectedOutput: string;
    acceptanceCriteria: string;
    verifiedFactsAndSources: string;
    assumptions: string;
    openQuestions: string;
  };

  /**
   * The complete Strategic Intervention Proposal currently in play for this
   * Strategy work item -- a runtime/work-state artifact, not a Notion
   * database object. Regenerated (new proposalId, proposalVersion + 1) on
   * every Refine; the prior version is pushed onto strategyProposalHistory
   * rather than discarded, so it remains available as historical context.
   */
  strategyProposal?: import("./units/strategy/strategyAnalyst").StrategyProposal;
  /** Every superseded proposal version for this work item, oldest first -- see strategyProposal's doc comment. */
  strategyProposalHistory?: import("./units/strategy/strategyAnalyst").StrategyProposal[];
  /**
   * The Strategy Proposal's own approval-lifecycle state, per the canonical
   * commercial flow (Sales -> Strategy -> Finance). This is authoritative
   * for whether an Approve/Refine/Reject callback may act at all --
   * handleInterventionApproval refuses to mutate anything unless this is
   * exactly "AWAITING_INTERVENTION_APPROVAL" and pendingStrategyApproval
   * matches the callback's identity exactly.
   */
  strategyApprovalState?: "DRAFT" | "AWAITING_INTERVENTION_APPROVAL" | "REFINEMENT_REQUESTED" | "APPROVED" | "REJECTED";
  /**
   * The exact proposal identity currently awaiting Martin's decision --
   * workId + proposalId + proposalVersion must all match a callback before
   * it may mutate state, so a stale callback from an earlier proposal
   * version, or one addressed to a different/superseded WorkSession, is a
   * logged no-op rather than a mutation. Reuses the existing generic
   * approval-callback infrastructure (Telegram inline buttons ->
   * handleCallback -> this Hat's own handler) -- no new callback/approval
   * mechanism was introduced.
   */
  pendingStrategyApproval?: {
    kind: "strategy_intervention";
    strategyWorkSessionId: string;
    proposalId: string;
    proposalVersion: number;
    decisionOptions: ("approve" | "refine" | "reject")[];
  };

  /**
   * Controlled Google Workspace action proposed by a Hat, awaiting explicit Martin approval.
   */
  pendingGoogleAction?: import("./googleOAuth").PendingGoogleAction;

  /**
   * An evidence-backed opportunity finding (from either scheduled or
   * on-demand Lead Generation Specialist discovery), awaiting Martin's
   * explicit approval before it becomes a Lead -- per the governance
   * requirement that no discovery source may create a Lead automatically.
   */
  pendingLeadOpportunity?: import("./units/sales/leadGenerationDiscovery").PendingLeadOpportunity;

  /**
   * Generic, display-only descriptor of whatever approval-gated action is
   * currently pending on this WorkSession (if any) -- set alongside the
   * domain-specific pending field above (pendingLeadOpportunity,
   * pendingGoogleAction, entityDraft, etc.) by every propose site, so
   * /sessions can show a meaningful label and resurface the exact original
   * message+buttons if Martin's approval message is missed or dismissed.
   *
   * This is NEVER the authority for whether an action may still execute --
   * that remains each domain-specific pending field, checked by its own
   * resolve handler. pendingActionSummary is purely "what to redisplay if
   * asked," not a second source of truth.
   */
  pendingActionSummary?: PendingActionSummary;

  /**
   * Transient one-shot signal, NOT a persistent pending-approval field: set
   * by a Hat handler that just successfully queued a Handoff (createHandoff
   * succeeded and its Telegram confirmation was sent) to tell the caller
   * (router.ts / index.ts, running in the Worker's own isolate, never the
   * WorkSession Durable Object itself -- see checkHandoffs.ts's
   * runCheckHandoffs doc comment for why) to trigger the existing
   * /checkhandoffs continuation immediately, in this same chat/thread,
   * instead of waiting for the next scheduled discovery cycle. Reset to
   * false at the start of every WorkSession.execute() call (session.ts) so
   * a stale true from an earlier, unrelated call can never leak into a
   * later one -- true only ever reflects "the handler that just ran, in
   * this exact call, queued a Handoff."
   */
  pendingHandoffAutoCheck?: boolean;
}

/**
 * Generic descriptor for an approval-gated action awaiting Martin's
 * decision, used to make any pending approval discoverable and
 * re-actionable via /sessions regardless of which Hat/Unit proposed it.
 * See WorkState.pendingActionSummary.
 */
export interface PendingActionSummary {
  /** Short human-readable label for the /sessions list row, e.g. "Opportunity: Acme Co". */
  label: string;
  /** The exact original message text, resent verbatim if this item is resurfaced. */
  message: string;
  /** The exact original inline keyboard, resent verbatim if this item is resurfaced. */
  buttons: InlineButton[][];
  /** When this approval was first proposed -- used for backlog-age reporting only. */
  createdAt: string;
}

export interface SessionSummary {
  workId: string;
  unit?: Unit;
  hat?: string;
  stage: string;
  label: string;
  updatedAt: string;
  /** Whether this work item currently has a pendingActionSummary -- drives sessions_index's bounded pending/general pool split. */
  hasPendingApproval?: boolean;
}
