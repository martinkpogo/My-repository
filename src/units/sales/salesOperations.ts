import type { Env } from "../../types";
import type { UnitOperation } from "../unitManifest";
import { getSessionStub } from "../../sessionRouting";
import { SALES_OPERATION } from "./salesOperationNames";
import { proposeLeadOpportunity, type PendingLeadOpportunity } from "./leadGenerationDiscovery";
import {
  applyProposalDocComment,
  applyProposalDocFormatting,
  evaluateProposalApprovalCycle,
  requestProposalDocClarification,
  type ProposalDocClarificationResult,
  type ProposalDocCommentResult,
  type ProposalDocFormattingResult,
} from "./tokenSafeProposal";

/**
 * What Sales lets a caller do to a Work it owns, reached only through the
 * Work's Durable Object stub (the Google Doc comment poller, the Drive
 * notification path, a Lead discovery run). Each used to be a named method on
 * WorkSession; they are Sales's own behaviour, so they live here and are
 * declared on Sales's manifest (UnitManifest.operations), reached through the
 * ONE generic WorkSession.runUnitOperation. The logic is unchanged -- only its
 * home moved -- and each `failed` is the answer the old method returned when
 * its run threw (the execute cycle reports and swallows the failure).
 */

type DocCommentInput = { proposalNumber: number; version: number; text: string; commentId?: string; documentId?: string };
type DocFormattingInput = { proposalNumber: number; version: number };
type DocClarificationInput = { proposalNumber: number; version: number; commentId: string; documentId: string; text: string };
type ApprovalCycleInput = { documentId: string; observations: { commentId: string; resolved: boolean; modifiedTime?: string }[] };
type ApprovalCycleResult = { kind: string; approvedVersion?: number; reasons?: string[] };

export const SALES_OPERATIONS: Record<string, UnitOperation> = {
  /**
   * Presents an evidence-backed opportunity finding to Martin for explicit
   * approval before it may become a Lead -- run on a freshly created Work with
   * no live chat behind it (see leadGenerationDiscovery.presentScreenedCandidate).
   */
  [SALES_OPERATION.proposeLeadOpportunity]: {
    run: async (env, state, opportunity: PendingLeadOpportunity) => ({ state: await proposeLeadOpportunity(env, state, opportunity), result: undefined }),
    failed: undefined,
  } satisfies UnitOperation<PendingLeadOpportunity, undefined>,

  /**
   * A change request arriving as a comment on a Runtime Sales Proposal's
   * Google Doc (googleDocComments.ts). Runs the Proposal's ordinary revision
   * path on this Work -- nothing here edits the Doc or the approved version --
   * and reports how it ended so the poller can answer the comment.
   */
  [SALES_OPERATION.handleProposalDocComment]: {
    run: (env, state, input: DocCommentInput) => applyProposalDocComment(env, state, input),
    failed: { kind: "refused", detail: "the change could not be applied; Martin was notified." },
  } satisfies UnitOperation<DocCommentInput, ProposalDocCommentResult>,

  /**
   * Feeds the resolution state observed on this Proposal's Doc back into the
   * Work's approval cycle and evaluates whether that cycle may complete.
   * Resolution is a SEPARATE signal from comment processing: a resolved
   * comment is never confused with an applied one, and only when BOTH are
   * satisfied (plus the Doc read back as the exact current Version) does the
   * cycle complete and approve through the shared approval write. The
   * document the pass read them from travels with the observations and is
   * checked against the cycle's own canonical Doc before anything runs.
   */
  [SALES_OPERATION.syncProposalDocApprovalCycle]: {
    run: async (env, state, input: ApprovalCycleInput) => ({ state, result: await evaluateProposalApprovalCycle(env, state, input.documentId, input.observations) }),
    failed: { kind: "no_cycle" },
  } satisfies UnitOperation<ApprovalCycleInput, ApprovalCycleResult>,

  /**
   * A presentation-only request arriving as a comment on a Proposal's own
   * Doc. Applies the canonical layout styling to that exact Doc and reports how
   * it ended. Creates no Version and changes no content, hash, approval state
   * or Action -- only the Doc's presentation, verified text-identical before
   * and after.
   */
  [SALES_OPERATION.handleProposalDocFormatting]: {
    run: (env, state, input: DocFormattingInput) => applyProposalDocFormatting(env, state, input),
    failed: { kind: "refused", detail: "the Doc could not be formatted; Martin was notified." },
  } satisfies UnitOperation<DocFormattingInput, ProposalDocFormattingResult>,

  /**
   * Records that a comment on this Proposal's Doc could not be classified, and
   * moves the Work onto `state.awaiting` for Martin's clarification of that
   * exact comment. The comment itself is deliberately NOT marked processed
   * here: it stays recoverable until a route actually handles it.
   */
  [SALES_OPERATION.requestProposalDocClarification]: {
    run: (env, state, input: DocClarificationInput) => requestProposalDocClarification(env, state, input),
    failed: { ok: false, detail: "the clarification could not be recorded; Martin was notified.", retryable: false },
  } satisfies UnitOperation<DocClarificationInput, ProposalDocClarificationResult>,
};

// ---------------------------------------------------------------------------
// Typed callers. Each reaches a specific Work through its stub and runs one of
// the operations above, so no caller spells an operation name or knows the
// Durable Object's method surface.
// ---------------------------------------------------------------------------

function call<R>(env: Env, workId: string, name: string, input: unknown): Promise<R> {
  return getSessionStub(env, workId).runUnitOperation("Sales", name, input) as Promise<R>;
}

export const handleProposalDocComment = (env: Env, workId: string, input: DocCommentInput) =>
  call<ProposalDocCommentResult>(env, workId, SALES_OPERATION.handleProposalDocComment, input);

export const handleProposalDocFormatting = (env: Env, workId: string, input: DocFormattingInput) =>
  call<ProposalDocFormattingResult>(env, workId, SALES_OPERATION.handleProposalDocFormatting, input);

export const requestProposalDocClarificationOnWork = (env: Env, workId: string, input: DocClarificationInput) =>
  call<ProposalDocClarificationResult>(env, workId, SALES_OPERATION.requestProposalDocClarification, input);

export const syncProposalDocApprovalCycle = (env: Env, workId: string, input: ApprovalCycleInput) =>
  call<ApprovalCycleResult>(env, workId, SALES_OPERATION.syncProposalDocApprovalCycle, input);
