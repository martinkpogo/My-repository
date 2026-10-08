import type { Env, WorkState } from "../types";
import { editWorkspaceHatMessage, sendWorkspaceHatMessage } from "../telegram";

/**
 * Live work status -- a Runtime Service any Unit's Hat uses to show Martin
 * what a long-running Work is doing right now: one Workspace message per run,
 * edited in place, listing the steps done (✓), the step running (⏳), and how
 * the run ended (✅ / ⛔, with the step it stopped on marked ✗).
 *
 * Unit-agnostic by design: it knows no Unit, Hat, Action or business rule --
 * the caller names its own Hat and its own steps. Its honesty rule is the
 * caller's to keep and the reason it exists: a step is recorded only at the
 * moment the code actually starts it (never a decorative "thinking..." line),
 * and names only tokens, record IDs, Skill/task names and counts -- never
 * evidence or client text. It grants nothing, decides nothing, and a failed
 * Telegram send or edit never blocks the work it reports on (the underlying
 * send/edit helpers log and return).
 *
 * The holder is a WorkState, or -- for a run with no Work (a scheduled
 * sweep) -- any object carrying the same two fields plus a chatId.
 */
export interface WorkStatus {
  /** The Hat the status bubble is labelled with ("Hat: <name>."). */
  hat: string;
  header: string;
  done: string[];
  current?: string;
}

export type WorkStatusHolder = Pick<WorkState, "chatId" | "workStatus" | "workStatusMessageId"> & { workId?: string };

/** "<Hat> — <Matter/Entity token, or the fallback>". */
export function workStatusHeader(hat: string, state: Partial<Pick<WorkState, "matterToken" | "entityToken">>, fallback: string): string {
  return `${hat} — ${state.matterToken || state.entityToken || fallback}`;
}

export function renderWorkStatus(status: WorkStatus, ending?: { line: string; currentFailed: boolean }): string {
  const step = (text: string) => text.replace(/(\.\.\.|…)$/, "");
  const lines = [`🧭 ${status.header}`, ...status.done.map((d) => `✓ ${step(d)}`)];
  if (status.current) lines.push(`${ending ? (ending.currentFailed ? "✗" : "✓") : "⏳"} ${step(status.current)}`);
  if (ending) lines.push(ending.line);
  return lines.join("\n");
}

/** Sends a fresh status message for a new run, with `firstStep` running. */
export async function startWorkStatus(env: Env, holder: WorkStatusHolder, hat: string, header: string, firstStep: string): Promise<void> {
  holder.workStatus = { hat, header, done: [], current: firstStep };
  holder.workStatusMessageId = await sendWorkspaceHatMessage(env, { chatId: holder.chatId, hat, workId: holder.workId }, renderWorkStatus(holder.workStatus));
}

/** Marks the running step done and shows `step` as running. A no-op when no run is being reported. */
export async function advanceWorkStatus(env: Env, holder: WorkStatusHolder, step: string): Promise<void> {
  const status = holder.workStatus;
  if (holder.workStatusMessageId === undefined || !status) return;
  if (status.current) status.done.push(status.current);
  status.current = step;
  await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, holder.workStatusMessageId, renderWorkStatus(status));
}

/**
 * Continues the open run with `step`, or starts one when none is open -- for
 * a shared step reached both from a fresh run and on its own (e.g. a
 * judgment re-run from a continuation reply).
 */
export async function continueWorkStatus(env: Env, holder: WorkStatusHolder, hat: string, header: string, step: string): Promise<void> {
  if (holder.workStatus && holder.workStatusMessageId !== undefined) return advanceWorkStatus(env, holder, step);
  return startWorkStatus(env, holder, hat, header, step);
}

/**
 * Rewords the running step once its outcome is known (e.g. which record was
 * read), without an extra Telegram edit -- the next advance or the ending
 * shows it.
 */
export function noteWorkStatus(holder: WorkStatusHolder, step: string): void {
  if (holder.workStatus?.current) holder.workStatus.current = step;
}

/**
 * Ends the run's status message with a final line. A failure marks the step
 * that was running ✗, so the message shows exactly where it stopped. Clears
 * the run, so a later run never edits a finished message.
 */
export async function finishWorkStatus(env: Env, holder: WorkStatusHolder, line: string, outcome: "succeeded" | "failed"): Promise<void> {
  const status = holder.workStatus;
  const messageId = holder.workStatusMessageId;
  holder.workStatus = undefined;
  holder.workStatusMessageId = undefined;
  if (messageId === undefined || !status) return;
  await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, messageId, renderWorkStatus(status, { line, currentFailed: outcome === "failed" }));
}
