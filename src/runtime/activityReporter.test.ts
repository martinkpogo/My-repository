import test from "node:test";
import assert from "node:assert/strict";
import { startOperation, finishOperation } from "./activityReporter";
import type { WorkStatusHolder } from "./workStatus";

test("finishOperation records outcome without marking unrelated activity successful", async () => {
  const holder: WorkStatusHolder = {
    chatId: 1,
    workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
    workStatusMessageId: 0,
  };
  const ctx = startOperation({} as any, holder, "op1", "Op 1");
  await finishOperation({} as any, ctx, "failed");
  assert.equal(holder.workStatus?.completed?.[0]?.outcome, "failed");
  assert.equal(holder.workStatus?.running?.length, 0);
});

test("invalid message ids do not trigger edit", async () => {
  for (const id of [undefined, 0, -1, NaN, Infinity]) {
    const holder: WorkStatusHolder = {
      chatId: 1,
      workStatus: { hat: "H", header: "h", done: [], current: "x", running: [], completed: [], edits: 0 },
      workStatusMessageId: id as any,
    };
    const ctx = startOperation({} as any, holder, "op2", "Op 2");
    await finishOperation({} as any, ctx, "succeeded");
    assert.equal(holder.workStatus?.completed?.length, 1);
  }
});
