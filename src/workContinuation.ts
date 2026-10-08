import type { Env, WorkState } from "./types";
import type { InlineButton } from "./telegram";
import { getSessionStub } from "./sessionRouting";
import { maybeAutoContinueCheckHandoffs } from "./checkHandoffs";

/**
 * The ONE path that picks an already-existing Work back up, whatever
 * discovered its id.
 *
 * Every caller answers only "which workId?" -- an explicit reply to a
 * message (`reply_msg:<messageId>`), this chat's interaction-local
 * `active:<chatId>:<threadId>` pointer, the `/sessions` switch button, or
 * a Matter via `matter_current_work:<matterId>`. This function answers the
 * Work's own question: what is the current execution state, and where does
 * it continue?
 *
 * Everything the Work needs to route itself -- `unit`, `hat`, `actionName`,
 * `stage`, `awaiting`, and the owning Hat's awaiting handler resolved from
 * them -- is read inside the Durable Object (`WorkSession.getState` /
 * `WorkSession.handleTextReply`), so no caller re-implements Unit/Hat/
 * action resolution and no second resume engine exists. Extracted from
 * `routeIncomingText`'s two inline association blocks (an explicit reply
 * and the active pointer) precisely so those blocks and every other
 * workId-discovering entry point share one implementation instead of
 * growing one each.
 *
 * It deliberately does NOT send anything and does NOT write pointers: how
 * a resumed Work is announced is the caller's choice (see `resumeNotice`),
 * and claiming this interaction's `active:` pointer belongs to the entry
 * point that chose this Work, not to the loader.
 */

export type ExistingWorkContinuation =
  /** No WorkSession for that id -- the caller's id is stale. */
  | { kind: "missing"; workId: string }
  /** A text reply was routed into the Work's own awaiting handler and is fully handled. */
  | { kind: "continued"; workId: string; state: WorkState }
  /** The Work exists and is loaded, but there is no reply to route (or it is not awaiting one). */
  | { kind: "resumed"; workId: string; state: WorkState };

/**
 * Resumes/routes an existing Work for an interaction.
 *
 * With `text`, an awaiting Work consumes the reply through its own recorded
 * Action's awaiting handler (exactly as `routeIncomingText` did inline) and
 * the caller must stop processing the message. Without `text` -- an entry
 * point that identified a Work but has no reply to deliver, such as
 * `/sessions` switching or Matter Continue -- the WorkSession is loaded and
 * handed back for the caller to announce; no state is mutated.
 */
export async function continueExistingWork(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  workId: string,
  text?: string,
): Promise<ExistingWorkContinuation> {
  const stub = getSessionStub(env, workId);
  const state = await stub.getState();
  if (!state) return { kind: "missing", workId };
  if (text !== undefined && state.awaiting) {
    const after = await stub.handleTextReply(text);
    await maybeAutoContinueCheckHandoffs(env, chatId, threadId, after);
    return { kind: "continued", workId, state: after ?? state };
  }
  return { kind: "resumed", workId, state };
}

/**
 * The resume announcement, in one place for every workId-discovering entry
 * point: a Work carrying a pending approval re-sends the *exact* original
 * approval message and buttons (the recovery path for a missed or
 * dismissed approval -- the buttons are the same callback_data as the
 * original send, so tapping them still routes through the same resolve
 * handler and its own stale/already-resolved guard), and a Work with
 * nothing pending gets the caller's own confirmation line. Returns the
 * message rather than sending it: sending stays with the caller, which
 * already owns the chat/thread it is replying to.
 */
export function resumeNotice(state: WorkState | undefined, fallback: string): { text: string; buttons?: InlineButton[][] } {
  const pending = state?.pendingActionSummary;
  if (pending) {
    return { text: `Re-sending pending approval:\n\n${pending.message}`, buttons: pending.buttons };
  }
  return { text: fallback };
}
