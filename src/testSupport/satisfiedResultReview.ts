import { ensureResultReviewContract, recordCheckerVerdict, stageResultReviewApproval, resolveResultReviewApprovalDecision } from "../resultReview";
import type { WorkState } from "../types";

/**
 * Test fixture: installs a FULLY SATISFIED Result review (BD-8) on the Work --
 * declared contract, independent hash-bound Checker verdict, and Martin's
 * hash-bound Result approval -- through the same three sanctioned recorders
 * production uses, in the same order (contract -> verdict -> staged approval
 * -> recorded decision). Nothing is hand-built on `WorkState.resultReview`.
 *
 * WHY a Unit-level test needs this: a Unit handler closing its own Handoff
 * SUCCESSFULLY routes through `closeHandoffOnResult`, which evaluates the
 * generic Result review gate BEFORE any Notion write. Handler tests call the
 * handler directly (no WorkSession in between to load the contract), and the
 * checker half of the review has no production recorder flow yet, so without
 * this the legit-successful path would be refused -- masking the Unit behaviour
 * under test. Installing the satisfied review is what lets a test still assert
 * "the Handoff closes" while the gate itself is tested fail-closed on its own
 * terms in `resultReview.test.ts` / `handoffLifecycle.test.ts`.
 *
 * The checker identity is deliberately distinct from every performer identity
 * a fixture Work records (Action and Hat), which is the gate's own mechanical
 * independence requirement.
 */
export async function installSatisfiedResultReview(
  state: WorkState,
  contract: { expectedResult: string; completionCriteria: readonly string[] },
  evidenceRefs: readonly { kind: string; ref: string; note?: string }[] = [{ kind: "activity", ref: "ACT-fixture" }],
): Promise<void> {
  ensureResultReviewContract(state, contract);
  const verdict = await recordCheckerVerdict(state, {
    checkerId: "independent-checker",
    outcome: "passed",
    evidenceRefs,
  });
  if (!verdict.ok) throw new Error(`fixture: Checker verdict refused -- ${verdict.reason}`);
  const staged = await stageResultReviewApproval(state);
  if (!staged.ok) throw new Error(`fixture: Result approval staging refused -- ${staged.reason}`);
  const decision = await resolveResultReviewApprovalDecision(state, { approved: true, token: staged.pending.token });
  if (!decision.ok) throw new Error(`fixture: Result approval decision refused -- ${decision.reason}`);
}
