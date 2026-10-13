import type { Unit } from "../../types";
import type { WorkState } from "../../types";

/**
 * Business Development's slice of a Work's saved state, kept under `WorkState.bd`
 * instead of as loose top-level fields, so the Business Development Unit can change
 * its state without touching the shared Work shape. Moved verbatim from the
 * loose fields in src/types.ts (2026-10-13); only the names lost their
 * Unit prefix.
 */
export interface BusinessDevelopmentWorkState {
  /** Business Development's in-flight opportunity state -- see BDOpportunityState's doc comment. Execution state (persisted for pause/resume across a qualify_* hold), not governed business state. */
  opportunity?: import("./types").BDOpportunityState;

  /**
   * A proposed BD -> Sales/Strategy opportunity handoff, pending Martin's
   * explicit approval before the Handoff record is created -- mirrors
   * pendingStrategyHandoff's own preview/approval
   * gate exactly (see handleBDOpportunityHandoffApproval). A recommendation
   * is never treated as authorization to route it onward.
   */
  pendingHandoff?: {
    unit: Unit;
    hat: string;
    handoffTitle: string;
    reason: string;
    opportunitySummary: string;
  };

  /**
   * A drafted BD opportunity development (stakeholders, value hypothesis,
   * route, dependencies, risks, next step), pending Martin's explicit
   * approval before it's recorded into bdOpportunity.developedState --
   * mirrors pendingBDHandoff's own preview/approval gate exactly (see
   * handleBDOpportunityDevelopApproval). A draft is never treated as
   * authorization to commit it.
   */
  pendingDevelop?: {
    draftSummary: string;
  };

  /**
   * A drafted next-move recommendation for an active BD opportunity,
   * pending Martin's explicit approval before it's recorded into
   * bdOpportunity.nextMove -- mirrors pendingBDDevelop's own preview/
   * approval gate exactly (see handleBDOpportunityNextMoveApproval). A
   * recommendation is never treated as authorization to commit it.
   */
  pendingNextMove?: {
    nextMoveSummary: string;
  };
}

/** The Business Development slice of a Work, created on first write. Reads use `state.bd?.field` and never create it. */
export function bdOf(state: WorkState): BusinessDevelopmentWorkState {
  state.bd ??= {};
  return state.bd;
}

/**
 * Rewrites a Work saved BEFORE the Business Development slice existed (loose top-level
 * fields) into the slice, and removes the loose fields. Run on every load of
 * a saved Work (see src/workStateMigration.ts), so an in-flight Work converts
 * itself and is saved in the new shape the next time it is saved. Idempotent:
 * a Work already in the new shape is untouched, and a value already in the
 * slice is never overwritten by a stale loose one.
 */
export function migrateLegacyBusinessDevelopmentState(raw: Record<string, unknown>): void {
  const legacy: [string, keyof BusinessDevelopmentWorkState][] = [
    ["bdOpportunity", "opportunity"],
    ["pendingBDHandoff", "pendingHandoff"],
    ["pendingBDDevelop", "pendingDevelop"],
    ["pendingBDNextMove", "pendingNextMove"],
  ];
  for (const [oldKey, newKey] of legacy) {
    if (!(oldKey in raw)) continue;
    const value = raw[oldKey];
    delete raw[oldKey];
    if (value === undefined || value === null) continue;
    const slice = (raw.bd ??= {}) as Record<string, unknown>;
    if (slice[newKey] === undefined) slice[newKey] = value;
  }
}
