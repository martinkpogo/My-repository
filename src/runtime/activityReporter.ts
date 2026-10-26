import type { Env } from "../types";
import type { WorkStatusHolder } from "./workStatus";
import { advanceWorkStatus, MAX_INTERMEDIATE_EDITS } from "./workStatus";

export type OperationOutcome = "succeeded" | "failed" | "partially_completed" | "unverified" | "denied";

export interface OperationContext {
  runId: string;
  holder: WorkStatusHolder;
  operationId: string;
  label: string;
  startedAt: number;
  parentOperationId?: string;
}

export interface OperationStartResult {
  context: OperationContext;
}

export function startOperation(
  _env: Env,
  holder: WorkStatusHolder,
  operationId: string,
  label: string,
  parentOperationId?: string,
): OperationContext {
  const ctx: OperationContext = {
    runId: holder.workId ?? "run",
    holder,
    operationId,
    label,
    startedAt: Date.now(),
    parentOperationId,
  };
  const status = holder.workStatus;
  if (status) {
    status.running = status.running ?? [];
    status.running.push({ operationId, label, startedAt: ctx.startedAt });
  }
  return ctx;
}

export async function finishOperation(
  env: Env,
  ctx: OperationContext,
  outcome: OperationOutcome,
): Promise<void> {
  const status = ctx.holder.workStatus;
  if (status) {
    status.running = (status.running ?? []).filter((r) => r.operationId !== ctx.operationId);
    status.completed = status.completed ?? [];
    status.completed.push({ operationId: ctx.operationId, label: ctx.label, startedAt: ctx.startedAt, outcome, completedAt: Date.now() });
  }
  try {
    await advanceWorkStatus(env, ctx.holder, ctx.label);
  } catch {
    // reporting failures must not change underlying result
  }
}

export async function reportOperationOutcome(
  env: Env,
  ctx: OperationContext,
  outcome: OperationOutcome,
): Promise<void> {
  await finishOperation(env, ctx, outcome);
}

export { MAX_INTERMEDIATE_EDITS };
