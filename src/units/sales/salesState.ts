import type { WorkState } from "../../types";

/**
 * Sales's slice of a Work's saved state, kept under `WorkState.sales`
 * instead of as loose top-level fields, so the Sales Unit can change
 * its state without touching the shared Work shape. Moved verbatim from the
 * loose fields in src/types.ts (2026-10-13); only the names lost their
 * Unit prefix.
 */
export interface SalesWorkState {
  /**
   * The canonical, token-safe Runtime Sales Proposal produced from a
   * Finance -> Sales Handoff (see units/sales/tokenSafeProposal.ts). The
   * Notion Proposals record is the system of record; this mirrors it so an
   * approval callback can be checked against the exact Proposal ID + Version
   * Martin was shown. Every version's full content is kept here (and as a
   * snapshot in the Proposal page body), so an approved version's substance
   * survives a later revision.
   */
  proposal?: import("./tokenSafeProposal").RuntimeSalesProposal;

  /**
   * Set when Martin asked for changes to a specific Proposal ID + Version
   * and the runtime is waiting for his change text. Bound to that exact
   * version: a revision request for a superseded version is refused.
   */
  pendingProposalRevision?: { proposalNumber: number; fromVersion: number };

  /**
   * Set when a comment on a Proposal's Google Doc could not be classified
   * (ambiguous, mixed, malformed or failed classification) and Martin was
   * asked which it was. Bound to that exact comment, document, Proposal and
   * version, and to the comment's own text: the clarification continues the
   * SAME request rather than starting an unrelated one, and the comment is
   * NOT marked processed while this is outstanding, so a transient failure
   * can never lose it. Cleared when the clarification resolves (the routed
   * handler runs) or when the bindings no longer hold (answered honestly,
   * never silently).
   */
  pendingProposalDocClarification?: { commentId: string; documentId: string; proposalNumber: number; version: number; text: string };

  /**
   * The open approval cycle a substantive comment on the Proposal's canonical
   * Google Doc starts (see units/sales/tokenSafeProposal.ts). It lives on the
   * Work (Durable Object storage), never on the Proposal database -- that
   * schema is frozen, so the cycle's own bookkeeping (which comments are
   * actionable, each one's outcome, and the last observed resolution state)
   * belongs to the Work that owns the Proposal.
   *
   * A new actionable comment OPENS or REOPENS it (clearing any prior Approved
   * Version binding immediately, before any revised Version can be released);
   * it is satisfied only when every actionable comment in it is applied AND
   * verified AND every one of them is observed resolved AND the canonical Doc
   * matches the exact current Version. Resolution alone never approves.
   */
  proposalApprovalCycle?: import("./tokenSafeProposal").ProposalApprovalCycle;


  /**
   * An evidence-backed opportunity finding (from either scheduled or
   * on-demand Lead Generation Specialist discovery), awaiting Martin's
   * explicit approval before it becomes a Lead -- per the governance
   * requirement that no discovery source may create a Lead automatically.
   */
  pendingLeadOpportunity?: import("./leadGenerationDiscovery").PendingLeadOpportunity;
}

/** The Sales slice of a Work, created on first write. Reads use `state.sales?.field` and never create it. */
export function salesOf(state: WorkState): SalesWorkState {
  state.sales ??= {};
  return state.sales;
}

/**
 * Rewrites a Work saved BEFORE the Sales slice existed (loose top-level
 * fields) into the slice, and removes the loose fields. Run on every load of
 * a saved Work (see src/workStateMigration.ts), so an in-flight Work converts
 * itself and is saved in the new shape the next time it is saved. Idempotent:
 * a Work already in the new shape is untouched, and a value already in the
 * slice is never overwritten by a stale loose one.
 */
export function migrateLegacySalesState(raw: Record<string, unknown>): void {
  const legacy: [string, keyof SalesWorkState][] = [
    ["salesProposal", "proposal"],
    ["pendingSalesProposalRevision", "pendingProposalRevision"],
    ["pendingProposalDocClarification", "pendingProposalDocClarification"],
    ["proposalApprovalCycle", "proposalApprovalCycle"],
    ["pendingLeadOpportunity", "pendingLeadOpportunity"],
  ];
  for (const [oldKey, newKey] of legacy) {
    if (!(oldKey in raw)) continue;
    const value = raw[oldKey];
    delete raw[oldKey];
    if (value === undefined || value === null) continue;
    const slice = (raw.sales ??= {}) as Record<string, unknown>;
    if (slice[newKey] === undefined) slice[newKey] = value;
  }
}
