import type { Env, WorkState } from "../types";
import { editWorkspaceHatMessage, sendWorkspaceHatMessage } from "../telegram";
import { resolvePendingStep, yieldLiveStatusToHat, type LiveStatusDetailSink, type LiveStatusOutcome, type LiveStatusTarget } from "./liveStatus";

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
  /**
   * What the universal live status (liveStatus.ts) saw happen during the
   * running step -- "Planning the searches", "Searching the web -- nca.org.gh".
   * Only the latest entry is shown: it replaces the step's own wording on its
   * line while the step runs (Martin, 2026-11-13). Fixed labels only.
   */
  trail?: string[];
  /** When the last intermediate edit was made (ms), for the live detail's throttle. */
  lastEditAt?: number;
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

/** Bounds what a busy step stores; only the latest entry is ever shown. */
const MAX_TRAIL = 12;

/** Adds a live step to the trail, merging a repeat of the same step ("Searching the web" ×n). */
function addToTrail(trail: string[], label: string): void {
  const base = (s: string) => s.replace(/ ×\d+$/, "");
  if (trail.length && base(trail[trail.length - 1]) === base(label)) trail[trail.length - 1] = label;
  else trail.push(label);
  if (trail.length > MAX_TRAIL) trail.splice(0, trail.length - MAX_TRAIL);
}

export function renderWorkStatus(status: WorkStatus, ending?: { line: string; currentFailed: boolean }): string {
  const step = (text: string) => text.replace(/(\.\.\.|…)$/, "");
  const lines = [`🧭 ${status.header}`, ...status.done.map((d) => `✓ ${step(d)}`)];
  if (status.current) {
    // One line per Hat step, edited in place (Martin, 2026-11-13): while the
    // step runs the line shows what is happening inside it right now; a step
    // that ends well goes back to its own wording with ✓; one that fails
    // stays on the inner step that was running, marked ✗, so it shows where
    // it broke.
    const inner = status.trail?.length ? status.trail[status.trail.length - 1] : undefined;
    const failed = ending?.currentFailed === true;
    const text = !ending || failed ? (inner ?? status.current) : status.current;
    lines.push(`${ending ? (failed ? "✗" : "✓") : "⏳"} ${step(text)}`);
  }
  if (ending) lines.push(ending.line);
  return lines.join("\n");
}

/** Sends a fresh status message for a new run, with `firstStep` running. */
export async function startWorkStatus(env: Env, holder: WorkStatusHolder, hat: string, header: string, firstStep: string): Promise<void> {
  // One message per run: a universal live-status message already shown for
  // this run gives way to the Hat's own named steps.
  yieldLiveStatusToHat();
  holder.workStatus = { hat, header, done: [], current: firstStep, edits: 0, lastEditAt: Date.now() };
  holder.workStatusMessageId = await sendWorkspaceHatMessage(env, { chatId: holder.chatId, hat, workId: holder.workId }, escapeTelegramMarkdown(renderWorkStatus(holder.workStatus)));
}

/** Marks the running step done and shows `step` as running. A no-op when no run is being reported. */
export async function advanceWorkStatus(env: Env, holder: WorkStatusHolder, step: string): Promise<void> {
  const status = holder.workStatus;
  if (holder.workStatusMessageId === undefined || !status) return;
  if (status.current) status.done.push(status.current);
  status.current = step;
  status.trail = undefined;
  if ((status.edits ?? 0) >= MAX_INTERMEDIATE_EDITS) return;
  status.edits = (status.edits ?? 0) + 1;
  status.lastEditAt = Date.now();
  await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, holder.workStatusMessageId, escapeTelegramMarkdown(renderWorkStatus(status)));
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

/** Minimum gap between two detail-only edits of a Hat's status message. */
const DETAIL_EDIT_INTERVAL_MS = 3000;

/**
 * Shows the live detail line on the Hat's open status message -- a
 * detail-only edit, throttled and inside the same MAX_INTERMEDIATE_EDITS
 * budget as the Hat's own steps, so the budget rule is unchanged.
 */
export async function refreshWorkStatus(env: Env, holder: WorkStatusHolder): Promise<void> {
  const status = holder.workStatus;
  if (holder.workStatusMessageId === undefined || !status) return;
  if ((status.edits ?? 0) >= MAX_INTERMEDIATE_EDITS) return;
  if (Date.now() - (status.lastEditAt ?? 0) < DETAIL_EDIT_INTERVAL_MS) return;
  status.edits = (status.edits ?? 0) + 1;
  status.lastEditAt = Date.now();
  await editWorkspaceHatMessage(env, { chatId: holder.chatId, hat: status.hat }, holder.workStatusMessageId, escapeTelegramMarkdown(renderWorkStatus(status)));
}

/** The universal live status's handle onto a Work's own named status (see liveStatus.ts). */
export function workStatusLiveSink(env: Env, holder: WorkStatusHolder): LiveStatusDetailSink {
  return {
    hatStatusOpen: () => holder.workStatusMessageId !== undefined && holder.workStatus !== undefined,
    // A step the live run saw is added to the running Hat step's trail; the
    // live run ending (undefined) leaves the trail as it is.
    setDetail: (detail) => {
      if (holder.workStatus && detail) addToTrail((holder.workStatus.trail ??= []), detail);
    },
    resolveDetail: (pending, final) => {
      if (!holder.workStatus) return;
      const steps = (holder.workStatus.trail ??= []).map((t) => {
        const m = / ×(\d+)$/.exec(t);
        return { label: m ? t.slice(0, m.index) : t, count: m ? Number(m[1]) : 1 };
      });
      resolvePendingStep(steps, pending, final);
      holder.workStatus.trail = steps.map((st) => (st.count > 1 ? `${st.label} ×${st.count}` : st.label));
    },
    refresh: () => refreshWorkStatus(env, holder),
  };
}

/** Where a Work's universal live status appears, and its identity-free header. */
export function workLiveStatusTarget(state: Pick<WorkState, "chatId" | "threadId" | "hat" | "unit" | "actionName" | "matterToken" | "entityToken">): LiveStatusTarget {
  const who = state.hat || state.unit || "Work";
  return { chatId: state.chatId, threadId: state.threadId, header: workStatusHeader(who, state, state.actionName ? state.actionName.replace(/_/g, " ") : "work") };
}

/** A Work run that stops to ask Martin is "waiting" (its status stays); anything else that returns is "succeeded" (its status is deleted). */
export function workLiveOutcome(state: Pick<WorkState, "stage" | "awaiting" | "pendingActionSummary">): LiveStatusOutcome {
  if (state.pendingActionSummary || state.awaiting || /^awaiting/.test(String(state.stage ?? ""))) return "waiting";
  return "succeeded";
}
