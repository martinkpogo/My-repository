import type { Env } from "../types";
import type { WorkStatusHolder } from "./workStatus";
import {
  MAX_INTERMEDIATE_EDITS,
  renderWorkStatus,
  escapeTelegramMarkdown,
} from "./workStatus";
import { editWorkspaceHatMessage } from "../telegram";

export type OperationOutcome = "succeeded" | "failed" | "partially_completed" | "unverified" | "denied";

export interface OperationContext {
  runId: string;
  holder: WorkStatusHolder;
  operationId: string;
  label: string;
  startedAt: number;
  parentOperationId?: string;
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

async function tryEdit(holder: WorkStatusHolder, env: Env): Promise<void> {
  const status = holder.workStatus;
  const messageId = holder.workStatusMessageId;
  if (!status || messageId === undefined) return;
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  if ((status.edits ?? 0) >= MAX_INTERMEDIATE_EDITS) return;
  try {
    status.edits = (status.edits ?? 0) + 1;
    await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, messageId, escapeTelegramMarkdown(renderWorkStatus(status)));
  } catch {
    // reporting failures must not change underlying result
  }
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
  await tryEdit(ctx.holder, env);
}

export async function reportOperationOutcome(
  env: Env,
  ctx: OperationContext,
  outcome: OperationOutcome,
): Promise<void> {
  await finishOperation(env, ctx, outcome);
}
