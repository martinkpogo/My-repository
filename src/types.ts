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

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MARTIN_TELEGRAM_USER_ID: string;
  NOTION_TOKEN: string;
  READAI_WEBHOOK_SECRET?: string;
  READAI_OAUTH_CLIENT_ID?: string;
  READAI_OAUTH_CLIENT_SECRET?: string;

  /**
   * JSON object mapping Unit name -> Telegram forum topic message_thread_id,
   * e.g. {"SM&BD": 2, "Finance": 4}. Optional — when unset, the bot behaves
   * as a plain 1:1 chat with no topic awareness (legacy/DM mode).
   */
  UNIT_TOPIC_MAP?: string;

  /** The ENIG HQ Supergroup's chat id (negative number). Only needed if using Telegram topics. */
  TELEGRAM_GROUP_CHAT_ID?: string;

  /** Shared secret for the Gmail-polling Apps Script -> /email/webhook. */
  EMAIL_WEBHOOK_SECRET?: string;
}

export type Unit = "SM&BD" | "Finance" | "Strategy" | "Research & Intelligence" | "Creative & Design" | "Operations";

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
  unit: Unit;
  hat: string;
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
    | "marketing_clarification";
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
   * for approval before the record is created — per the SM&BD AI Project
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
}

export interface SessionSummary {
  workId: string;
  unit: Unit;
  hat: string;
  stage: string;
  label: string;
  updatedAt: string;
}
