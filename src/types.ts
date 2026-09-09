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
    | "value_context_more";
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
}

export interface SessionSummary {
  workId: string;
  unit: Unit;
  hat: string;
  stage: string;
  label: string;
  updatedAt: string;
}
