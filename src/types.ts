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
  condition: "within_specialization" | "allows_diagnosis_first" | "open_to_ballpark_amount_and_time" | "ready_to_commit_required_resources";
  evidence: string;
  assessment: QualificationAssessment;
}

export interface QualificationResult {
  conditions: QualificationConditionResult[];
  overall: "Qualified" | "Not Qualified" | "More Information Required";
}

export interface Quote {
  price: number;
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
    | "research_feedback";
  createdAt: string;
  updatedAt: string;

  enquiryText?: string;
  entityId?: string;
  entityName?: string;
  matterId?: string;
  matterName?: string;
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

  /**
   * Controlled Google Workspace action proposed by a Hat, awaiting explicit Martin approval.
   */
  pendingGoogleAction?: import("./googleOAuth").PendingGoogleAction;
}

export interface SessionSummary {
  workId: string;
  unit?: Unit;
  hat?: string;
  stage: string;
  label: string;
  updatedAt: string;
}
