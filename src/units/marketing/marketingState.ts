import type { WorkState } from "../../types";

/**
 * Marketing's slice of a Work's saved state -- everything the Marketing Hats
 * carry on a Work between turns, kept under `WorkState.marketing` instead of
 * as loose top-level fields, so the Marketing Unit can change its state
 * without touching the shared Work shape.
 */
export interface MarketingWorkState {
  /** Original task text for a Marketing work item -- carried across redo/clarification loops. */
  taskText?: string;
  /** The current Marketing Hat's drafted output, shown to Martin for approval before anything is treated as done. */
  draft?: string;
  /** A proposed transition to another Marketing Hat (routing or escalation), pending Martin's confirmation. */
  pendingTransition?: { toHat: string; reason: string };
  /**
   * A missing prerequisite owned by another Hat (the Hat returned
   * `action: "prerequisite"`). Martin then chooses: do it first, carry on with
   * stated assumptions, or hand the whole request over. Cleared on his choice.
   */
  pendingPrerequisite?: { hat: string; reason: string };
  /**
   * The next step the Hat proposed for its own approved output, offered to
   * Martin only after he approves the draft (Yes / Not now). Never automatic.
   * `approvedOutput` is attached at approval time; `fromHat` is the Hat whose
   * output this continues from.
   */
  pendingNextStep?: { toHat: string; forWhat: string; fromHat?: string; approvedOutput?: string };
  /** A proposed paid-media/spend action, pending Martin's explicit budget/spend approval. */
  pendingPaidMediaAction?: { description: string };
  /** The clarifying question the Hat asked Martin, plus suggested tap answers and the question number. Set when the Hat returns clarify; cleared when Martin answers. */
  pendingClarification?: { question: string; suggestedAnswers: string[]; questionCount: number };
  /** How many clarifying questions this Hat has asked on this Work; from the sixth, each question also offers "That's enough". Reset on redo/feedback. */
  clarificationCount?: number;
  /** Martin tapped "✋ That's enough" or typed "enough" -- the Hat must not ask another question. Reset on redo/feedback. */
  enoughSaid?: boolean;
}

/** The Marketing slice of a Work, created on first write. Reads use `state.marketing?.field` and never create it. */
export function marketingOf(state: WorkState): MarketingWorkState {
  state.marketing ??= {};
  return state.marketing;
}

/**
 * Rewrites a Work saved BEFORE the Marketing slice existed (loose top-level
 * `marketingTaskText`, `marketingDraft`, `pendingTransition`,
 * `pendingPaidMediaAction`) into the slice, and removes the loose fields. Run
 * on every load of a saved Work (see src/workStateMigration.ts), so an
 * in-flight Work converts itself and is saved in the new shape the next time
 * it is saved. Idempotent: a Work already in the new shape is untouched, and
 * a value already in the slice is never overwritten by a stale loose one.
 */
export function migrateLegacyMarketingState(raw: Record<string, unknown>): void {
  const legacy: [string, keyof MarketingWorkState][] = [
    ["marketingTaskText", "taskText"],
    ["marketingDraft", "draft"],
    ["pendingTransition", "pendingTransition"],
    ["pendingPaidMediaAction", "pendingPaidMediaAction"],
  ];
  for (const [oldKey, newKey] of legacy) {
    if (!(oldKey in raw)) continue;
    const value = raw[oldKey];
    delete raw[oldKey];
    if (value === undefined || value === null) continue;
    const slice = (raw.marketing ??= {}) as Record<string, unknown>;
    if (slice[newKey] === undefined) slice[newKey] = value;
  }
}
