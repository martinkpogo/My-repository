import type { EvidenceSynthesis } from "../evidence/validation";
import type { ResearchProtocolId } from "./protocols";

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
  | "UNVERIFIABLE_SOURCES";

export type ResearchOutcome =
  | {
      status: "completed";
      synthesis: ResearchSynthesis;
      /** What the question means in relation to the authorized safe-context category. */
      relevance: string;
    }
  | { status: "blocked"; code: ResearchBlockCode; reason: string };
