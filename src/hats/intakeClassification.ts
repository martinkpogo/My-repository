import type { Env } from "../types";
import type { SemanticTaskId } from "../dataBoundary/types";
import type { ActionDefinition } from "./actionRegistry";
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

/**
 * Generic Stage 2 action classification -- the Action Registry's own
 * "reads the message against that Unit's own declared action list and
 * picks one, or asks a clarifying question if none fit" step (ENIG
 * Operating Model design doc, "The Action Registry"). Unit-agnostic: any
 * Unit built on the Unit Registry manifest pattern supplies its own
 * taskId (a distinct SemanticTaskId, same "never share across Units"
 * rule classifyCandidateHats' doc comment states) and the resolved Hat's
 * own ActionDefinition list, rather than reimplementing this prompt shape.
 */
export interface ActionClassification<A extends string = string> {
  action?: A | null;
  reason?: string;
}

export interface ClassifyActionOptions {
  /** The Unit's own registered SemanticTaskId for this classification call -- never shared across Units. */
  taskId: SemanticTaskId;
  /** One sentence naming the Unit/Hat whose action list this call picks from -- e.g. "You decide which action this request needs, within Business Development's Opportunity Development Hat." */
  introLine: string;
  light?: boolean;
}

/** Pure prompt-construction, exported for direct testability without needing to mock the AI provider chain. */
export function buildActionClassificationSystemPrompt<A extends string>(introLine: string, actions: ActionDefinition<A>[]): string {
  const actionList = actions.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return `${introLine} Below are the only actions you may choose from. Pick exactly one that genuinely matches the request, or null if none fit.

${actionList}

Return JSON:
{"action": "<exact action name>" | null, "reason": "<brief rationale>"}
- action: exactly one of the action names above, verbatim -- never invent a new action name. null if none genuinely fit; never guess.`;
}

export async function classifyAction<A extends string = string>(
  env: Env,
  options: ClassifyActionOptions,
  actions: ActionDefinition<A>[],
  text: string,
): Promise<ActionClassification<A> | null> {
  return aiJson<ActionClassification<A>>(env, {
    taskId: options.taskId,
    system: buildActionClassificationSystemPrompt(options.introLine, actions),
    user: text,
    light: options.light,
  });
}
