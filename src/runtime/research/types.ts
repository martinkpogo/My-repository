import type { EvidenceSynthesis } from "../evidence/validation";
import type { ResearchProtocolId } from "./protocols";
import type { ResearchPlanDimension } from "./researchPlan";
import type { OperationMetadata } from "../../runtime/activityReporter";

/**
 * A research synthesis: the shared Evidence -> Finding -> Implication ->
 * Limitation -> Source structure (src/runtime/evidence/validation.ts) plus
 * the record of which research protocol(s) produced it.
 */
export interface ResearchSynthesis extends EvidenceSynthesis {
  protocolsUsed: ResearchProtocolId[];
}

/** What the caller supplies. The research runtime owns nothing about WHY the research is needed. */
export interface ResearchExecutionInput {
  /** The research question, already stripped of real client identity by the caller. */
  question: string;
  /** Sanitized supplied context/evidence the question arrives with (may be empty). */
  context: string;
  /**
   * Reusable methodology the caller's own Action declared, already resolved
   * through the Skill Registry (src/platform/skillRegistry.ts). The research
   * runtime only passes it into synthesis; it never selects, resolves or
   * grants a Skill itself.
   */
  skillContent?: string;
  /** Optional status hook for the caller to surface stage progress; never able to affect the result. */
  onProgress?: (stageText: string) => Promise<void> | void;
  /**
   * Durable checkpoint storage for this job, supplied by the OWNING Work
   * (WorkSession owns the durable lifecycle; research execution owns the
   * checkpoint's content -- canonical Search spec, research_continuation).
   * Absent outside a Work: research then runs as one pass, and an
   * interruption is still reported as `interrupted`, never as completed.
   */
  checkpoints?: ResearchCheckpointStore;
  /**
   * Optional activity-reporting metadata (holder/run/label) for live
   * Work-status operations. Reporting only -- never authorization evidence,
   * never used by Access, and never stored in durable operation records.
   */
  operationMetadata?: OperationMetadata;
}

/** One planned search operation's progress (completed_operation_statuses). */
export type ResearchOperationStatus = "pending" | "completed_with_results" | "completed_no_results" | "failed" | "interrupted";

export interface ResearchOperationCheckpoint {
  /** Index into the approved plan. */
  dimension: number;
  status: ResearchOperationStatus;
  /** The search outcome kind that produced this status, kept so a resumed run reports it exactly as before. */
  search_outcome?: string;
  /**
   * Reference into the existing approved evidence storage (the Search Tool's
   * 7-day result cache) -- never the evidence payload itself
   * (store_full_evidence_payloads_in_checkpoint: false).
   */
  evidence_ref?: string;
}

/**
 * The compact research checkpoint (canonical Search spec,
 * research_continuation.checkpoint). Holds what is needed to continue the
 * SAME approved job and nothing more: no conversation history, no evidence
 * payloads.
 */
export interface ResearchCheckpoint {
  /** research_job_identity: a SHA-256 over the profile, question and supplied context -- never the text. */
  job_id: string;
  /** original_approved_question */
  question: string;
  created_at: string;
  updated_at: string;
  status: "in_progress" | "interrupted" | "completed" | "blocked";
  /** The interpretation and protocols the plan was built from. */
  relevance?: string;
  protocols?: ResearchProtocolId[];
  /** approved_plan_and_dimensions */
  plan?: ResearchPlanDimension[];
  /** completed_operation_statuses + evidence_references */
  operations: ResearchOperationCheckpoint[];
  /** current_interrupted_operation (dimension index), when interrupted. */
  current_interrupted_operation?: number;
  /** remaining_operations (dimension indexes not yet completed). */
  remaining_operations: number[];
  /** No sooner than this may an interrupted job usefully resume (the earliest provider cooldown end). */
  retry_at?: string;
  synthesis_status: "pending" | "failed" | "completed";
  validation_status: "pending" | "failed" | "passed";
  /**
   * Skill-guided rounds (deep_research): each round's operation batch,
   * recorded BEFORE it is dispatched, and the next round to dispatch. On
   * resume the completed rounds are replayed from the Search / Web page read
   * caches (no provider call, no allowance) and the interrupted batch is
   * dispatched again; no AI step is repeated. Notes live in the 7-day notes
   * cache under `notes_ref` -- never in the checkpoint.
   */
  rounds?: {
    operations: Array<Array<{ type: "search"; query: string } | { type: "read_page"; url: string }>>;
    next_round: number;
    notes_ref: string;
  };
}

/** A research job waiting for providers, which the owning Work resumes on its own alarm (option B, Martin 15 Nov 2026). */
export interface PendingResearch {
  question: string;
  mode: "light_search" | "deep_research";
  /** Supplied context the job was started with (Martin's research brief answers); part of the job's identity, so a resume finds the same checkpoint. */
  context?: string;
  /** No sooner than this; absent means "as soon as the alarm can run". */
  retryAt?: string;
}

/** The port WorkSession supplies: load and durably save one job's checkpoint. Saving must be durable on return. */
export interface ResearchCheckpointStore {
  load(jobId: string): Promise<ResearchCheckpoint | undefined>;
  save(checkpoint: ResearchCheckpoint): Promise<void>;
  /**
   * Arms the owning Work's alarm to resume this research job in the
   * background (WorkSession owns the lifecycle and scheduling). Absent where
   * no Work can resume it.
   */
  scheduleResume?(pending: PendingResearch): Promise<void>;
}

/**
 * Why a research execution did not produce a result. A blocked outcome is
 * a stop, never a lower-confidence result delivered anyway.
 */
export type ResearchBlockCode =
  | "SAFE_CONTEXT_UNAVAILABLE"
  | "RELEVANCE_DERIVATION_FAILED"
  | "PROTOCOL_SELECTION_FAILED"
  | "AMBIGUOUS_PROTOCOL_SELECTION"
  | "GOVERNANCE_UNAVAILABLE"
  | "PLAN_GENERATION_FAILED"
  | "SYNTHESIS_FAILED"
  | "SYNTHESIS_INVALID"
  | "UNVERIFIABLE_SOURCES"
  /** A Skill-guided research step answered in an unusable shape (deep_research). */
  | "RESEARCH_STEP_FAILED";

export type ResearchOutcome =
  | {
      status: "completed";
      synthesis: ResearchSynthesis;
      /** What the question means in relation to the authorized safe-context category. */
      relevance: string;
    }
  | { status: "blocked"; code: ResearchBlockCode; reason: string }
  /**
   * Search providers could not complete one or more planned searches right
   * now (every eligible provider rate-limited, down or cooling). Nothing is
   * synthesized from the partial evidence: the job stays visibly incomplete
   * and, inside a Work, resumes from its checkpoint
   * (incomplete_research_must_not_be_presented_as_complete).
   */
  | {
      status: "interrupted";
      reason: string;
      /** The earliest time a provider is expected to be available again, when known. */
      retryAt?: string;
      completedOperations: number;
      totalOperations: number;
    };
