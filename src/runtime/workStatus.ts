import type { Env, WorkState } from "../types";
import { editWorkspaceHatMessage, sendWorkspaceHatMessage, editHatMessage, sendHatMessage } from "../telegram";
import type { HatMessageTarget } from "../telegram";

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
  /** Intermediate Telegram edits made so far this run -- see MAX_INTERMEDIATE_EDITS. */
  edits?: number;
}

/**
 * Every send and edit is a Worker subrequest, and one invocation -- a whole
 * Handoff pickup runs inside one Durable Object alarm -- has a hard
 * subrequest budget shared with every Notion and AI-provider call. A run
 * therefore makes at most this many intermediate edits; later steps are
 * still recorded and appear in the next permitted edit or the final one,
 * which is always made. Worst case per run: 1 send + this many edits + 1
 * final edit.
 */
export const MAX_INTERMEDIATE_EDITS = 6;

/**
 * Escapes the characters Telegram's Markdown parse mode treats as entity
 * markers, so a step naming e.g. `business_strategy` is accepted on the
 * first call instead of being rejected and retried as plain text (two
 * subrequests instead of one).
 */
function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
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
  holder.workStatus = { hat, header, done: [], current: firstStep, edits: 0 };
  holder.workStatusMessageId = await sendWorkspaceHatMessage(env, { chatId: holder.chatId, hat, workId: holder.workId }, escapeTelegramMarkdown(renderWorkStatus(holder.workStatus)));
}

/**
 * Like startWorkStatus, but the status bubble is sent to an explicit target
 * instead of the Workspace stream -- used for ordinary chat, where the
 * progress ack belongs in the conversation that started it.
 */
export async function startWorkStatusAt(
  env: Env,
  target: HatMessageTarget,
  hat: string,
  header: string,
  firstStep: string,
): Promise<number | undefined> {
  const status: WorkStatus = { hat, header, done: [], current: firstStep, edits: 0 };
  return sendHatMessage(env, target, escapeTelegramMarkdown(renderWorkStatus(status)));
}

/** Marks the running step done and shows `step` as running. A no-op when no run is being reported. */
export async function advanceWorkStatus(env: Env, holder: WorkStatusHolder, step: string): Promise<void> {
  const status = holder.workStatus;
  if (holder.workStatusMessageId === undefined || !status) return;
  if (status.current) status.done.push(status.current);
  status.current = step;
  if ((status.edits ?? 0) >= MAX_INTERMEDIATE_EDITS) return;
  status.edits = (status.edits ?? 0) + 1;
  await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, holder.workStatusMessageId, escapeTelegramMarkdown(renderWorkStatus(status)));
}

/**
 * Like advanceWorkStatus, but edits a status message at an explicit target.
 * Carries the same status object so the caller can keep one holder across
 * start/advance/finish regardless of which chat the bubble lives in.
 */
export async function advanceWorkStatusAt(
  env: Env,
  target: HatMessageTarget,
  status: WorkStatus,
  messageId: number | undefined,
  step: string,
): Promise<void> {
  if (messageId === undefined || !Number.isFinite(messageId) || messageId <= 0) return;
  if (status.current) status.done.push(status.current);
  status.current = step;
  if ((status.edits ?? 0) >= MAX_INTERMEDIATE_EDITS) return;
  status.edits = (status.edits ?? 0) + 1;
  await editHatMessage(env, target, messageId, escapeTelegramMarkdown(renderWorkStatus(status)));
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
  await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, messageId, escapeTelegramMarkdown(renderWorkStatus(status, { line, currentFailed: outcome === "failed" })));
}

/**
 * Like finishWorkStatus, but edits a status message at an explicit target.
 * Clears the status object so a later run never edits a finished message.
 *
 * A missing or invalid messageId is a no-op, never an edit of message 0: a
 * failed status send must not turn into a spurious Telegram edit, and it
 * must never block the Action or reply that the status was reporting on.
 */
export async function finishWorkStatusAt(
  env: Env,
  target: HatMessageTarget,
  status: WorkStatus,
  messageId: number | undefined,
  line: string,
  outcome: "succeeded" | "failed",
): Promise<void> {
  if (messageId === undefined || !Number.isFinite(messageId) || messageId <= 0) return;
  await editHatMessage(env, target, messageId, escapeTelegramMarkdown(renderWorkStatus(status, { line, currentFailed: outcome === "failed" })));
}
