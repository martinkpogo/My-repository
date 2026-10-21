import type { Unit } from "../../types";
import type { HandoffSourceBoundaryAttestation, KnownIdentityField } from "../../handoffWriter";
import type { WorkState } from "../../types";

/**
 * Strategy's slice of a Work's saved state, kept under `WorkState.strategy`
 * instead of as loose top-level fields, so the Strategy Unit can change
 * its state without touching the shared Work shape. Moved verbatim from the
 * loose fields in src/types.ts (2026-10-13); only the names lost their
 * Unit prefix.
 */
export interface StrategyWorkState {
  /** The strategic question/business situation a Strategy work item is diagnosing -- carried across clarification/feedback loops. */
  question?: string;

  /** Sanitized supplied context (from a Handoff's own record) the diagnosis is grounded in. */
  context?: string;

  /** The most recently delivered structured diagnosis -- preserved so a downstream Handoff proposal can be built/rebuilt from it without re-running the AI call. */
  diagnosis?: import("./strategyAnalyst").StrategyDiagnosisResult;

  /**
   * The bounded Strategy Skill findings this diagnosis's composable-Skills
   * cycle actually invoked (if any) -- observability/testability only;
   * synthesis is folded into strategyContext, never read back out of this
   * field by the diagnosis pipeline itself. Populated whenever the cycle ran;
   * `[]` legitimately means Strategy Analysis genuinely determined no Strategy
   * Skill was required -- see strategySkillCycleUnavailable for why that is a
   * different thing from the cycle not being able to run.
   */
  skillFindings?: import("./strategySkillCycle").StrategySkillFinding[];

  /**
   * Set only when the composable-Skills cycle's own analysis move itself
   * could not be obtained (provider failure, or output that carried no usable
   * decision). `true` means the cycle was unavailable and this diagnosis
   * proceeded without Skill composition as a degraded fallback, NOT because
   * no Skill was genuinely determined necessary. `false` means Strategy
   * Analysis ran and genuinely determined no Strategy Skill was required.
   * `undefined` means the cycle ran and at least one Skill was invoked (see
   * strategySkillFindings for their outcomes). These three states must never
   * be conflated -- a persisted WorkState (or a test) can always tell "no
   * Skill needed" apart from "we don't actually know, the cycle itself
   * couldn't run."
   */
  skillCycleUnavailable?: boolean;

  /**
   * WHY strategySkillCycleUnavailable is `true` -- the AI-call cause code
   * only (`outbound_gate_blocked` | `providers_exhausted` | `unparseable`,
   * never payload content or a human-readable reason string). Set together
   * with `strategySkillCycleUnavailable = true` and cleared together with
   * its other transitions, so the persisted state records not just that the
   * composable-Skills cycle could not run but which class of failure kept
   * it from running. Undefined when the cycle was not unavailable.
   */
  skillCycleUnavailableCause?: import("../../ai/policy").AiFailureCause;

  /**
   * A proposed Strategy -> another-Unit handoff, pending Martin's explicit
   * approval before the Handoff record is created (a preview/approval
   * gate). A recommendation is never treated as authorization to route it onward.
   */
  pendingHandoff?: {
    unit: Unit;
    hat: string;
    handoffTitle: string;
    reason: string;
    requiredNextAction: string;
    expectedOutput: string;
    acceptanceCriteria: string;
    verifiedFactsAndSources: string;
    assumptions: string;
    openQuestions: string;
  };


  /**
   * The complete Strategic Intervention Proposal currently in play for this
   * Strategy work item -- a runtime/work-state artifact, not a Notion
   * database object. Regenerated (new proposalId, proposalVersion + 1) on
   * every Refine; the prior version is pushed onto strategyProposalHistory
   * rather than discarded, so it remains available as historical context.
   */
  proposal?: import("../../handoffContracts/strategyBoundary").StrategyProposal;

  /** Every superseded proposal version for this work item, oldest first -- see strategyProposal's doc comment. */
  proposalHistory?: import("../../handoffContracts/strategyBoundary").StrategyProposal[];

  /**
   * The Strategy Proposal's own approval-lifecycle state, per the canonical
   * commercial flow (Sales -> Strategy -> Finance). This is authoritative
   * for whether an Approve/Refine/Reject callback may act at all --
   * handleInterventionApproval refuses to mutate anything unless this is
   * exactly "AWAITING_INTERVENTION_APPROVAL" and pendingStrategyApproval
   * matches the callback's identity exactly.
   */
  approvalState?: "DRAFT" | "AWAITING_INTERVENTION_APPROVAL" | "REFINEMENT_REQUESTED" | "APPROVED" | "REJECTED";

  /**
   * The exact proposal identity currently awaiting Martin's decision --
   * workId + proposalId + proposalVersion must all match a callback before
   * it may mutate state, so a stale callback from an earlier proposal
   * version, or one addressed to a different/superseded WorkSession, is a
   * logged no-op rather than a mutation. Reuses the existing generic
   * approval-callback infrastructure (Telegram inline buttons ->
   * handleCallback -> this Hat's own handler) -- no new callback/approval
   * mechanism was introduced.
   */
  pendingApproval?: {
    kind: "strategy_intervention";
    strategyWorkSessionId: string;
    proposalId: string;
    proposalVersion: number;
    decisionOptions: ("approve" | "refine" | "reject")[];
  };

  /**
   * The result of the Sales-side source-boundary check performed when the
   * Sales -> Strategy Handoff was created (createHandoff already runs
   * assertOperationalReference + findViolation against the authoritative
   * identity Sales supplied -- see handoffWriter.ts's HandoffSourceBoundaryAttestation
   * for the explicit `result` (Passed/Failed) and the five named checks).
   * This records WHICH known-identity fields were actually available and
   * checked at that moment -- never the values themselves -- so a later
   * Strategy Proposal-content check can honestly say its known-identity set
   * matches what the source boundary was already checked against.
   *
   * DURABLE TRANSPORT: the authoritative, fail-closed copy of this evidence
   * is the attestation marker createHandoff writes INTO the Handoff record
   * itself at creation (the marker channel in handoffWriter.ts) -- that is
   * what a fresh Strategy session reads and consumes at pickup (see
   * strategyAnalyst.ts's readSourceBoundaryEvidence). This WorkState copy
   * is a same-session convenience/audit copy only: it is set once,
   * immediately after the Handoff write succeeds (a throw there means it is
   * never set, consistent with fail-closed), and pickup re-seeds this field
   * from the durable record so a missing/Failed/unbound marker can never be
   * masked by a stale session copy. See salesExecutive.ts's
   * handleInterventionText.
   */
  sourceBoundaryAttestation?: HandoffSourceBoundaryAttestation;

  /**
   * The upstream Commercial Value Evidence block exactly as it is written in
   * the Sales -> Strategy Handoff's "Verified Facts & Sources" (markers
   * included), read and structurally parsed at pickup -- see
   * handoffContracts/commercialValueEvidence.ts. This is PROVENANCE, not a new
   * evidence model: the determination inside it was produced upstream by
   * Sales's deterministic `evaluateCommercialValueEvidence`, and Strategy
   * copies this block byte-for-byte into the Strategy -> Finance Handoff so
   * Finance judges against the same determination it was handed.
   *
   * Absent (with `commercialValueEvidenceError` saying why) whenever the
   * block could not be read or could not be parsed deterministically --
   * presentStrategyProposalForApproval treats that as a fail-closed provenance
   * failure and never as a reason to doubt the determination itself: an
   * `Insufficient Evidence` determination still sits here fully valid.
   */
  commercialValueEvidenceBlock?: string;

  /** Why `commercialValueEvidenceBlock` is absent (markers absent, not JSON, malformed field...). Carried only so a fail-closed gate can name the exact provenance gap. */
  commercialValueEvidenceError?: string;

  /**
   * The bounded, deterministic known-identity safety attestation for the
   * EXACT Strategy Proposal (proposalId, proposalVersion) currently
   * approved/in-flight -- see verifyStrategyProposalTokenSafety and
   * checkStrategyProposalForKnownIdentity (strategyAnalyst.ts). This is a
   * narrow claim: the Sales-authored Sales -> Strategy source Handoff was
   * checked against Sales's known identity, AND the complete assembled
   * Strategy Proposal for this exact version was independently checked
   * against that same known-identity set -- neither found a match. It is
   * NOT a claim that the Proposal is free of arbitrary/unknown identity;
   * see checkStrategyProposalForKnownIdentity's own doc comment. Every
   * distinct proposalVersion (including every refinement) requires its own
   * independent proposalContent check -- never inherited from a prior
   * version, per verifyStrategyProposalTokenSafety's exact-match discipline.
   * Never carries the identity values themselves, only which fields were
   * checked. Replaces the prior unconstrained `basis: string` shape, which
   * could not honestly represent which checks had actually run. The field
   * lists are evidence of what each check compared, not a required set: an
   * Entity/Matter name is always its own token, so the proposal check
   * records only contactName/email/phone when known -- often none.
   */
  proposalTokenSafety?: {
    proposalId: string;
    proposalVersion: number;
    sourceBoundary: { checked: true; identityFieldsChecked: KnownIdentityField[] };
    proposalContent: { checked: true; identityFieldsChecked: KnownIdentityField[] };
  };

  /**
   * The exact Strategy Proposal identity (proposalId + proposalVersion)
   * Martin is refining -- set when he taps Refine, bound to the proposal
   * that was actually on screen at that moment. handleStrategyRefinement
   * verifies this matches state.strategyProposal exactly before applying
   * anything; a mismatch (the proposal moved on in the meantime) is a
   * fail-closed no-op, same discipline as pendingStrategyApproval/
   * pendingSalesProposalRevision. This exists so Martin's free-text
   * refinement reply can be bound to a specific artifact rather than
   * "whatever the current proposal happens to be" -- it never becomes part
   * of state.strategyContext and is never persisted to the Handoff; it is
   * transient control input for exactly one revision.
   */
  pendingRefinement?: { proposalId: string; proposalVersion: number };

  /**
   * An open Discuss conversation about the CURRENT Strategy Proposal, bound
   * to the exact proposal identity it was opened on. Every question
   * re-verifies that binding against state.strategyProposal and the
   * pending approval before anything runs, so a stale question can never
   * act on a newer version. Discussion is read-only with respect to the
   * proposal, diagnosis, strategyContext and the Handoff: it never creates a
   * version, never reaches Notion, and the turns are never fed into Revise
   * (the existing Refine path takes Martin's own instruction only). Only a
   * successful turn is saved; an answer the Outbound Data Gate's own
   * detector would refuse is saved withheld, so saved turns can never
   * block a later question.
   */
  discussion?: {
    proposalId: string;
    proposalVersion: number;
    turns: { question: string; answer: string }[];
  };
}

/** The Strategy slice of a Work, created on first write. Reads use `state.strategy?.field` and never create it. */
export function strategyOf(state: WorkState): StrategyWorkState {
  state.strategy ??= {};
  return state.strategy;
}

/**
 * Rewrites a Work saved BEFORE the Strategy slice existed (loose top-level
 * fields) into the slice, and removes the loose fields. Run on every load of
 * a saved Work (see src/workStateMigration.ts), so an in-flight Work converts
 * itself and is saved in the new shape the next time it is saved. Idempotent:
 * a Work already in the new shape is untouched, and a value already in the
 * slice is never overwritten by a stale loose one.
 */
export function migrateLegacyStrategyState(raw: Record<string, unknown>): void {
  const legacy: [string, keyof StrategyWorkState][] = [
    ["strategyQuestion", "question"],
    ["strategyContext", "context"],
    ["strategyDiagnosis", "diagnosis"],
    ["strategySkillFindings", "skillFindings"],
    ["strategySkillCycleUnavailable", "skillCycleUnavailable"],
    ["strategySkillCycleUnavailableCause", "skillCycleUnavailableCause"],
    ["pendingStrategyHandoff", "pendingHandoff"],
    ["strategyProposal", "proposal"],
    ["strategyProposalHistory", "proposalHistory"],
    ["strategyApprovalState", "approvalState"],
    ["pendingStrategyApproval", "pendingApproval"],
    ["strategySourceBoundaryAttestation", "sourceBoundaryAttestation"],
    ["strategyProposalTokenSafety", "proposalTokenSafety"],
    ["pendingStrategyRefinement", "pendingRefinement"],
    ["strategyDiscussion", "discussion"],
    ["commercialValueEvidenceBlock", "commercialValueEvidenceBlock"],
    ["commercialValueEvidenceError", "commercialValueEvidenceError"],
  ];
  for (const [oldKey, newKey] of legacy) {
    if (!(oldKey in raw)) continue;
    const value = raw[oldKey];
    delete raw[oldKey];
    if (value === undefined || value === null) continue;
    const slice = (raw.strategy ??= {}) as Record<string, unknown>;
    if (slice[newKey] === undefined) slice[newKey] = value;
  }
}
