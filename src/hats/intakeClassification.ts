import type { Env } from "../types";
import type { SemanticTaskId } from "../dataBoundary/types";
import { aiJson } from "../ai";

/**
 * Generic Stage 1 candidate-Hat classification -- the reusable shape of
 * what was Marketing-only logic (executionEngine.ts's handleMarketingIntake
 * Stage 1 block, now built on this). Reads raw request text against a
 * Unit's own declared Hat list and identifies genuinely plausible
 * candidates, plus whether the request is establishing foundational
 * direction from scratch vs. executing against already-established
 * direction -- the same two-part signal Stage 2 (resolveCandidateRelationships,
 * see relationships.ts) needs to resolve conditional relationships.
 *
 * A second Unit registers here by supplying its own taskId (a distinct
 * SemanticTaskId -- Data Boundary sensitivity/outbound policy are resolved
 * per task, so a Unit must never reuse marketing.intake_classification for
 * its own classification call) and its own hatSummaryList/introLine, not
 * by reimplementing this aiJson call and prompt shape.
 */
export interface Stage1IntakeClassification<H extends string = string> {
  candidates?: H[];
  establishing?: boolean;
  reason?: string;
}

export interface ClassifyCandidateHatsOptions {
  /** The Unit's own registered SemanticTaskId for this classification call -- never shared across Units. */
  taskId: SemanticTaskId;
  /**
   * One sentence naming the Unit/specialization and what's being routed --
   * e.g. "You route incoming Marketing-specialization tasks for ENIG,
   * within the Sales, Marketing & Business Development Unit."
   */
  introLine: string;
  /** Short, flat "- Hat name: purpose" list for every Hat this Unit's classification may choose among -- never the full per-Hat detail. */
  hatSummaryList: string;
  /** Whether to use the light/cheaper model tier for this classification call. */
  light?: boolean;
}

/** Pure prompt-construction, exported for direct testability without needing to mock the AI provider chain. */
export function buildStage1SystemPrompt(introLine: string, hatSummaryList: string): string {
  return `${introLine} Below are the Hats and their purposes. Identify ALL genuinely plausible candidate Hats for the incoming request, and whether establishing foundational strategy/briefs/guidance is required.

${hatSummaryList}

Return JSON:
{
  "candidates": ["<exact Hat name 1>", ...],
  "establishing": true | false,
  "reason": "<brief rationale>"
}
- candidates: list 1 or more Hats that are genuinely plausible candidates for this request.
- establishing: set true if creating/establishing strategy, guidance, or briefs from scratch; set false if managing or executing against already-established direction.`;
}

export async function classifyCandidateHats<H extends string = string>(
  env: Env,
  options: ClassifyCandidateHatsOptions,
  text: string,
): Promise<Stage1IntakeClassification<H> | null> {
  return aiJson<Stage1IntakeClassification<H>>(env, {
    taskId: options.taskId,
    system: buildStage1SystemPrompt(options.introLine, options.hatSummaryList),
    user: text,
    light: options.light,
  });
}
