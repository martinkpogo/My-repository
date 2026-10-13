import test from "node:test";
import assert from "node:assert";
import type { Env, WorkState } from "../types";
import { runUnitOperationOnWork } from "./unitOperations";
import { findUnitManifest } from "./registry";
import { SALES_OPERATION } from "./sales/salesOperationNames";
import {
  handleProposalDocComment,
  handleProposalDocFormatting,
  requestProposalDocClarificationOnWork,
  syncProposalDocApprovalCycle,
} from "./sales/salesOperations";

const ENV = {} as Env;
const WORK = { workId: "w-1", chatId: 1, stage: "proposal_pending_approval", unit: "Sales", createdAt: "t", updatedAt: "t" } as WorkState;

/** Mirrors WorkSession.execute: runs fn on the Work, saves what it returns, and on a throw reports and SWALLOWS it (returning the pre-error state). */
function fakeExecute(state: WorkState) {
  const saved: WorkState[] = [];
  const reported: unknown[] = [];
  const execute = async (fn: (s: WorkState) => Promise<WorkState>): Promise<WorkState> => {
    try {
      const next = await fn(state);
      saved.push(next);
      return next;
    } catch (err) {
      reported.push(err);
      return state;
    }
  };
  return { execute, saved, reported };
}

test("Sales declares every operation callers use, each with the honest 'failed' answer the old WorkSession method gave", () => {
  const ops = findUnitManifest("Sales")?.operations;
  assert.deepStrictEqual(Object.keys(ops ?? {}).sort(), Object.values(SALES_OPERATION).sort());
  assert.deepStrictEqual(ops![SALES_OPERATION.handleProposalDocComment].failed, { kind: "refused", detail: "the change could not be applied; Martin was notified." });
  assert.deepStrictEqual(ops![SALES_OPERATION.handleProposalDocFormatting].failed, { kind: "refused", detail: "the Doc could not be formatted; Martin was notified." });
  assert.deepStrictEqual(ops![SALES_OPERATION.requestProposalDocClarification].failed, { ok: false, detail: "the clarification could not be recorded; Martin was notified.", retryable: false });
  assert.deepStrictEqual(ops![SALES_OPERATION.syncProposalDocApprovalCycle].failed, { kind: "no_cycle" });
  assert.strictEqual(ops![SALES_OPERATION.proposeLeadOpportunity].failed, undefined);
});

test("runUnitOperation runs the declared operation inside the Work's execute cycle and returns its result", async () => {
  // A Work with no Proposal: the real Sales operation answers 'stale' rather than touching anything.
  const { execute, saved } = fakeExecute(WORK);
  const result = await runUnitOperationOnWork(ENV, "Sales", SALES_OPERATION.handleProposalDocComment, { proposalNumber: 6, version: 1, text: "change it" }, execute);
  assert.deepStrictEqual(result, { kind: "stale", detail: "this Doc does not belong to the Proposal on this work item." });
  assert.strictEqual(saved.length, 1, "the operation's state is saved through the execute cycle");
});

test("when the operation throws, the caller gets the declared 'failed' answer -- never an exception", async () => {
  // A Work whose Sales slice cannot be read: the operation throws on its first line.
  const broken = { ...WORK } as WorkState;
  Object.defineProperty(broken, "sales", { get: () => { throw new Error("boom"); } });
  const { execute, reported, saved } = fakeExecute(broken);

  const result = await runUnitOperationOnWork(ENV, "Sales", SALES_OPERATION.handleProposalDocFormatting, { proposalNumber: 6, version: 1 }, execute);

  assert.deepStrictEqual(result, { kind: "refused", detail: "the Doc could not be formatted; Martin was notified." });
  assert.strictEqual(reported.length, 1, "the failure was reported by the execute cycle, not rethrown to the caller");
  assert.strictEqual(saved.length, 0, "nothing from the failed run was saved");
});

test("an operation no Unit declares is refused, never silently skipped", async () => {
  const { execute } = fakeExecute(WORK);
  await assert.rejects(() => runUnitOperationOnWork(ENV, "Sales", "no_such_operation", {}, execute), /declares no operation "no_such_operation"/);
  await assert.rejects(() => runUnitOperationOnWork(ENV, "Finance", SALES_OPERATION.handleProposalDocComment, {}, execute), /Finance declares no operation/);
});

test("the typed Sales callers reach the Work through the ONE generic entry, naming Sales and the operation", async () => {
  const seen: [string, string, unknown][] = [];
  const env = {
    WORK_SESSION: {
      idFromName: (n: string) => n,
      get: () => ({ runUnitOperation: async (unit: string, name: string, input: unknown) => { seen.push([unit, name, input]); return { ok: true }; } }),
    },
  } as unknown as Env;
  await handleProposalDocComment(env, "w", { proposalNumber: 1, version: 2, text: "t" });
  await handleProposalDocFormatting(env, "w", { proposalNumber: 1, version: 2 });
  await requestProposalDocClarificationOnWork(env, "w", { proposalNumber: 1, version: 2, commentId: "c", documentId: "d", text: "t" });
  await syncProposalDocApprovalCycle(env, "w", { documentId: "d", observations: [] });
  assert.deepStrictEqual(
    seen.map(([unit, name]) => [unit, name]),
    [
      ["Sales", SALES_OPERATION.handleProposalDocComment],
      ["Sales", SALES_OPERATION.handleProposalDocFormatting],
      ["Sales", SALES_OPERATION.requestProposalDocClarification],
      ["Sales", SALES_OPERATION.syncProposalDocApprovalCycle],
    ],
  );
});
