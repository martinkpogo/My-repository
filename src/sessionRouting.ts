import type { Env, Unit } from "./types";

/**
 * Foundational WorkSession/routing primitives with no dependency on the
 * rest of the runtime (AI classification, Telegram sending, governance
 * retrieval) -- deliberately kept dependency-free so both router.ts (the
 * higher-level routing/classification logic) and checkHandoffs.ts (Handoff
 * discovery, including the automatic post-confirmation continuation a Hat
 * triggers after queuing a Handoff) can depend on this module without
 * depending on each other. router.ts re-exports everything here for
 * existing callers that import these from "./router" -- this split changes
 * nothing about where a caller imports these from, only removes the
 * circular dependency checkHandoffs.ts -> router.ts -> checkHandoffs.ts
 * would otherwise create (router.ts needs to trigger the automatic
 * /checkhandoffs continuation after a text-reply call; checkHandoffs.ts
 * needs getSessionStub/newWorkId/resolveUnitForThread to run discovery).
 */

// Sales Executive/Business Development intake is paused by deliberate,
// standing policy, not as a temporary state pending a rebuild. Real client
// identity (Entity/Matter, names, contact details) is confirmed-sensitive
// data that this Worker's AI provider (Cloudflare Workers AI) is not
// approved to process -- Workers AI's training-data policy for personal
// information hasn't been confirmed acceptable, the same reason
// chat.general_reply is gated in dataBoundary/policy.ts. That work now
// lives entirely in an isolated Sales Executive Claude project with its own
// Notion (Entity/Matters/Proposals) and Gmail access, where Martin reviews
// and approves every client-facing action (e.g. an email) directly -- it is
// live and working, exchanging only opaque Entity_Token/Matter_Token values
// with this Worker via the shared Handoffs database.
//
// Currently set to false: Sales runtime execution is enabled for the
// controlled MAT-20 live validation, per Martin's explicit approval. This is
// a deliberate, scoped exception to the standing pause described above, not
// a reversal of the underlying policy -- the AI-provider personal-data/
// training-policy concern this flag exists for has not been resolved. The
// gate can be restored to true after MAT-20 validation if separately
// decided.
export const SALES_EXECUTIVE_PAUSED = false;

export function newWorkId(): string {
  return crypto.randomUUID();
}

export async function getActiveWorkId(env: Env, chatId: number, threadId?: number): Promise<string | null> {
  return env.STATE_KV.get(`active:${chatId}:${threadId ?? "dm"}`);
}

export async function setActiveWorkId(env: Env, chatId: number, threadId: number | undefined, workId: string): Promise<void> {
  await env.STATE_KV.put(`active:${chatId}:${threadId ?? "dm"}`, workId);
}

export async function setReplyMessageWorkId(env: Env, messageId: number, workId: string): Promise<void> {
  await env.STATE_KV.put(`reply_msg:${messageId}`, workId, { expirationTtl: 60 * 60 * 24 * 7 });
}

export async function getReplyMessageWorkId(env: Env, messageId: number): Promise<string | null> {
  return env.STATE_KV.get(`reply_msg:${messageId}`);
}

/**
 * Workspace interaction mode (Chat/Cowork) -- thread-scoped conversational
 * state, deliberately separate from WorkState (a WorkSession is governed
 * work state; mode is interaction state -- see workspaceRouter.ts's own
 * doc comment for why these must never be merged). Absent/unreadable KV
 * defaults to "chat" -- the safe, inert default; a read failure must never
 * be interpreted as "cowork."
 */
export type WorkspaceMode = "chat" | "cowork";

export async function getWorkspaceMode(env: Env, chatId: number, threadId: number | undefined): Promise<WorkspaceMode> {
  try {
    const raw = await env.STATE_KV.get(`mode:${chatId}:${threadId ?? "dm"}`);
    return raw === "cowork" ? "cowork" : "chat";
  } catch (err) {
    console.error(`getWorkspaceMode: KV read failed for chat ${chatId} thread ${threadId} -- defaulting to chat`, err);
    return "chat";
  }
}

export async function setWorkspaceMode(env: Env, chatId: number, threadId: number | undefined, mode: WorkspaceMode): Promise<void> {
  await env.STATE_KV.put(`mode:${chatId}:${threadId ?? "dm"}`, mode);
}

/**
 * Marks that this thread is currently waiting on Martin's answer to a
 * responsibility-clarification question ("Who should own this work?").
 * While pending, the NEXT message in this thread is interpreted as the
 * answer (parsed against the same finite Unit/Hat registry), not as a
 * fresh message needing its own resolution. Cleared the instant it
 * resolves or Martin switches back to Chat. Deliberately just a marker --
 * no separate "resolved responsibility" is ever stored here; once
 * resolved, WorkState.unit/hat (set at WorkSession.init time) is the only
 * authoritative responsibility record, per the explicit decision not to
 * create a second authority that could drift from it.
 */
export async function isCoworkClarificationPending(env: Env, chatId: number, threadId: number | undefined): Promise<boolean> {
  try {
    return (await env.STATE_KV.get(`cowork_pending:${chatId}:${threadId ?? "dm"}`)) === "1";
  } catch (err) {
    console.error(`isCoworkClarificationPending: KV read failed for chat ${chatId} thread ${threadId} -- defaulting to not pending`, err);
    return false;
  }
}

export async function setCoworkClarificationPending(env: Env, chatId: number, threadId: number | undefined, pending: boolean): Promise<void> {
  const key = `cowork_pending:${chatId}:${threadId ?? "dm"}`;
  if (pending) {
    await env.STATE_KV.put(key, "1");
  } else {
    await env.STATE_KV.delete(key);
  }
}

export function getSessionStub(env: Env, workId: string) {
  const id = env.WORK_SESSION.idFromName(workId);
  return env.WORK_SESSION.get(id) as any;
}

export type StreamType = "workspace" | "operations" | "dm" | "unmapped";

/**
 * Resolves a Telegram message_thread_id to its Telegram Stream ("workspace" | "operations" | "dm" | "unmapped").
 * Thread IDs indicate Telegram stream identity only, never Unit ownership.
 */
export function resolveStreamForThread(env: Env, threadId?: number): StreamType {
  if (threadId === undefined) return "dm";

  if (env.WORKSPACE_TOPIC_ID && threadId === Number(env.WORKSPACE_TOPIC_ID)) {
    return "workspace";
  }
  if (env.OPERATIONS_TOPIC_ID && threadId === Number(env.OPERATIONS_TOPIC_ID)) {
    return "operations";
  }

  return "unmapped";
}

export function resolveUnitForThread(env: Env, threadId?: number): Unit | "unmapped" | "dm" {
  if (threadId === undefined) return "dm";
  if (env.UNIT_TOPIC_MAP) {
    try {
      const map: Record<string, number> = JSON.parse(env.UNIT_TOPIC_MAP);
      const entry = Object.entries(map).find(([, id]) => Number(id) === threadId);
      if (entry && entry[0] !== "Conversation" && entry[0] !== "Operations") {
        return entry[0] as Unit;
      }
    } catch {
      // JSON parse error
    }
  }
  return "dm";
}

export function threadIdForUnit(_env: Env, _unit: Unit): number | undefined {
  return undefined;
}
