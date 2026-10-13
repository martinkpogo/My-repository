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
  /** A proposed paid-media/spend action, pending Martin's explicit budget/spend approval. */
  pendingPaidMediaAction?: { description: string };
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
