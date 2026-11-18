import type { Env, WorkState } from "./types";
import { getSessionStub, newWorkId, setActiveWorkId } from "./sessionRouting";

/**
 * Starts the follow-on Work Martin asked for on a finished Work (the
 * post-approval "Next: hand this to <Hat>?" Yes, 2026-11-18): a NEW Work for
 * that Hat, in the same chat/thread, started exactly as a Hat he confirms on
 * ENIG's offer is started (router.ts dispatchCowork, confirmedHat) -- never by
 * reopening the finished Work, whose Result review stays its own. Marketing is
 * the one Unit with a next-step offer today, and handleConfirmedMarketingRequest
 * is its documented entry; any other Unit's follow-on is not started.
 * Returns the new Work's id, or undefined when nothing was started.
 */
export async function startFollowOnWork(env: Env, finished: Pick<WorkState, "unit" | "chatId" | "threadId" | "followOnWork">): Promise<string | undefined> {
  const followOn = finished.followOnWork;
  if (!followOn || finished.unit !== "Marketing") return undefined;
  const workId = newWorkId();
  const stub = getSessionStub(env, workId);
  await stub.init(workId, finished.chatId, "Marketing", followOn.hat, finished.threadId);
  await setActiveWorkId(env, finished.chatId, finished.threadId, workId);
  await stub.handleConfirmedMarketingRequest(followOn.text);
  return workId;
}
