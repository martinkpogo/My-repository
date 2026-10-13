import type { Quote } from "../../types";
import type { WorkState } from "../../types";

/**
 * Finance's slice of a Work's saved state, kept under `WorkState.finance`
 * instead of as loose top-level fields, so the Finance Unit can change
 * its state without touching the shared Work shape. Moved verbatim from the
 * loose fields in src/types.ts (2026-10-13); only the names lost their
 * Unit prefix.
 */
export interface FinanceWorkState {
  quote?: Quote;


  /**
   * Set when Finance (or another picked-up Unit) has posted a blocker to its
   * OWN topic and is awaiting a reply there, rather than in the topic the
   * enquiry originated from. Lets a reply typed in that topic resume this
   * session, and lets terminal cleanup clear that topic's active pointer too.
   */
  threadId?: number;

  /**
   * Sanitized value context a direct-entry (no upstream Handoff) Finance
   * quote is grounded in -- carried across the finance_direct_request_context
   * continuation loop so an insufficient-evidence hold can be re-augmented
   * from Martin's own follow-up without a Handoff record to re-read it
   * from (contrast the Handoff-pickup path, whose source of truth stays
   * the Handoff's own Verified Facts & Sources). Mirrors strategyContext.
   */
  judgmentContext?: string;

  /**
   * Set when Martin has supplied the specific commercial fact Finance named
   * in its value-evidence hold (see valueBasedPricingAssessor.ts's
   * handleValueContextClarification). While the block's upstream
   * `Insufficient Evidence` determination is the whole picture, Finance
   * holds deterministically and asks; once a fact has actually been
   * supplied, that fact must be re-evaluated through Finance's EXISTING
   * judgment + validateFinanceJudgement path, because the block's own
   * bytes are upstream-authored and cannot be edited from here. The flag
   * only ever selects which of those two governed paths runs -- it is never
   * a pricing authority, and never overrides validateFinanceJudgement.
   */
  valueEvidenceFactSupplied?: boolean;
}

/** The Finance slice of a Work, created on first write. Reads use `state.finance?.field` and never create it. */
export function financeOf(state: WorkState): FinanceWorkState {
  state.finance ??= {};
  return state.finance;
}

/**
 * Rewrites a Work saved BEFORE the Finance slice existed (loose top-level
 * fields) into the slice, and removes the loose fields. Run on every load of
 * a saved Work (see src/workStateMigration.ts), so an in-flight Work converts
 * itself and is saved in the new shape the next time it is saved. Idempotent:
 * a Work already in the new shape is untouched, and a value already in the
 * slice is never overwritten by a stale loose one.
 */
export function migrateLegacyFinanceState(raw: Record<string, unknown>): void {
  const legacy: [string, keyof FinanceWorkState][] = [
    ["financeThreadId", "threadId"],
    ["financeJudgmentContext", "judgmentContext"],
    ["valueEvidenceFactSupplied", "valueEvidenceFactSupplied"],
    ["quote", "quote"],
  ];
  for (const [oldKey, newKey] of legacy) {
    if (!(oldKey in raw)) continue;
    const value = raw[oldKey];
    delete raw[oldKey];
    if (value === undefined || value === null) continue;
    const slice = (raw.finance ??= {}) as Record<string, unknown>;
    if (slice[newKey] === undefined) slice[newKey] = value;
  }
}
