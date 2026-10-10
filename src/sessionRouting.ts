import type { Env, Unit } from "./types";
import { kvDelete, kvGet, kvPut } from "./kvStore";

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

// Sales Executive/Business Development DIRECT ENTRY -- a real person typing
// a raw enquiry straight into Telegram/Workspace chat, handled by
// salesExecutive.ts's own handleIncomingEnquiry chain (real Entity/Matter
// creation, real names/emails/phones, all in this Worker) -- is paused by
// deliberate, standing policy, not as a temporary state pending a rebuild.
// Real client identity is confirmed-sensitive data that this Worker's AI
// provider (Cloudflare Workers AI) is not approved to process -- Workers
// AI's training-data policy for personal information hasn't been confirmed
// acceptable, the same reason chat.general_reply is gated in
// dataBoundary/policy.ts. Every enquiry, whether it originates by email or
// by someone manually entering it, now goes through the isolated Sales
// Executive Claude project instead -- its own Notion (Entity/Matters/
// Proposals) and Gmail access, with Martin reviewing and approving every
// client-facing action directly. This code is intentionally left in place,
// not removed, for when a paid AI provider with an acceptable
// personal-data/no-training policy becomes available -- flip this back to
// false to re-enable it then, not before.
export const SALES_DIRECT_ENTRY_PAUSED = true;

// Gates the Sales Handoff PICKUP mechanism only (checkHandoffs.ts's
// discoverPendingSalesHandoffs -- runTokenSafeProposal/runCallNotesPickup).
// Unlike SALES_DIRECT_ENTRY_PAUSED above, this never
// touches real client identity -- it only ever processes what's already
// de-identified on a Handoff record (Entity_Token/Matter_Token, sanitized
// context) -- so the AI-provider personal-data concern that keeps direct
// entry paused does not apply here. Kept false (active) independently of
// direct entry's pause state.
export const SALES_EXECUTIVE_PAUSED = false;

export function newWorkId(): string {
  return crypto.randomUUID();
}

export async function getActiveWorkId(env: Env, chatId: number, threadId?: number): Promise<string | null> {
  return kvGet(env, `active:${chatId}:${threadId ?? "dm"}`);
}

export async function setActiveWorkId(env: Env, chatId: number, threadId: number | undefined, workId: string): Promise<void> {
  await kvPut(env, `active:${chatId}:${threadId ?? "dm"}`, workId);
}

/**
 * Clears a stream's active-work pointer ONLY when it still names `workId`
 * -- the same compare-then-delete WorkSession.updateRegistry applies at
 * terminal cleanup, so releasing a pointer can never wipe one another
 * Work has since taken.
 */
export async function clearActiveWorkIdIfMatches(env: Env, chatId: number, threadId: number | undefined, workId: string): Promise<void> {
  const key = `active:${chatId}:${threadId ?? "dm"}`;
  if ((await kvGet(env, key)) === workId) await kvDelete(env, key);
}

export async function setReplyMessageWorkId(env: Env, messageId: number, workId: string): Promise<void> {
  await kvPut(env, `reply_msg:${messageId}`, workId, { expirationTtl: 60 * 60 * 24 * 7 });
}

export async function getReplyMessageWorkId(env: Env, messageId: number): Promise<string | null> {
  return kvGet(env, `reply_msg:${messageId}`);
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
    const raw = await kvGet(env, `mode:${chatId}:${threadId ?? "dm"}`);
    return raw === "cowork" ? "cowork" : "chat";
  } catch (err) {
    console.error(`getWorkspaceMode: KV read failed for chat ${chatId} thread ${threadId} -- defaulting to chat`, err);
    return "chat";
  }
}

export async function setWorkspaceMode(env: Env, chatId: number, threadId: number | undefined, mode: WorkspaceMode): Promise<void> {
  await kvPut(env, `mode:${chatId}:${threadId ?? "dm"}`, mode);
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
    return (await kvGet(env, `cowork_pending:${chatId}:${threadId ?? "dm"}`)) === "1";
  } catch (err) {
    console.error(`isCoworkClarificationPending: KV read failed for chat ${chatId} thread ${threadId} -- defaulting to not pending`, err);
    return false;
  }
}

export async function setCoworkClarificationPending(env: Env, chatId: number, threadId: number | undefined, pending: boolean): Promise<void> {
  const key = `cowork_pending:${chatId}:${threadId ?? "dm"}`;
  if (pending) {
    await kvPut(env, key, "1");
  } else {
    await kvDelete(env, key);
  }
}

export function getSessionStub(env: Env, workId: string) {
  const id = env.WORK_SESSION.idFromName(workId);
  return env.WORK_SESSION.get(id) as any;
}

// ---------------------------------------------------------------------------
// Alarm-scheduled Handoff pickup (checkHandoffs.ts's discovery loops).
//
// Discovery (Notion webhook wake-up, cron, /checkhandoffs) must never AWAIT
// a Unit's pickup: a webhook's ctx.waitUntil window is cancelled by
// Cloudflare ~30 s after the response, which cut short exactly the long AI
// pickups (Strategy's diagnosis) and could leave the AUTO_CHECKHANDOFFS
// guard set on a cancelled run. Discovery therefore only RECORDS which
// pickup kind this WorkSession should run and arms a Durable Object alarm;
// the pickup itself runs later from WorkSession.alarm() (src/session.ts),
// reusing the existing run*Pickup methods unchanged. Duplicate protection
// stays where it was (claimPendingHandoff): scheduling twice is harmless
// because the claim makes a second pickup a no-op -- deliberately no second
// dedupe mechanism here.
//
// This logic lives in this dependency-free module rather than on
// WorkSession itself only so it is testable: tests cannot import
// src/session.ts, because its `cloudflare:workers` Durable Object import is
// not resolvable under the node test runner.
// ---------------------------------------------------------------------------

/** Which existing WorkSession pickup runner a discovery loop scheduled. */
export type PickupKind = "strategy" | "finance" | "sales_call_notes" | "sales_proposal" | "marketing";

const PICKUP_KINDS: readonly string[] = ["strategy", "finance", "sales_call_notes", "sales_proposal", "marketing"];

/** Storage key on the WorkSession DO's own storage -- never the "state" key. */
export const PENDING_PICKUP_KIND_KEY = "pending_pickup_kind";

/**
 * The minimal storage surface these helpers need. DurableObjectStorage
 * satisfies it structurally; test fakes implement it directly.
 */
export interface PickupAlarmStorage {
  get<T = unknown>(key: string): Promise<T | undefined | null>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  setAlarm(timestamp: number | Date): Promise<void>;
}

/**
 * Records the pending pickup kind on the WorkSession's own storage and arms
 * its alarm to fire immediately. Discovery calls this INSTEAD of awaiting
 * the pickup itself.
 */
export async function schedulePickupAlarm(storage: PickupAlarmStorage, kind: PickupKind): Promise<void> {
  await storage.put(PENDING_PICKUP_KIND_KEY, kind);
  await storage.setAlarm(Date.now());
}

/**
 * Reads and CLEARS the pending pickup kind. Clearing before the pickup runs
 * is what makes an alarm single-shot: a duplicate or re-fired alarm can
 * never run the same scheduled pickup twice (a genuinely new schedule
 * writes the key again). Returns undefined when nothing is pending; an
 * unrecognized stored value is discarded fail-closed rather than dispatched.
 */
export async function takePendingPickupKind(storage: PickupAlarmStorage): Promise<PickupKind | undefined> {
  const raw = await storage.get<string>(PENDING_PICKUP_KIND_KEY);
  if (raw === undefined || raw === null) return undefined;
  await storage.delete(PENDING_PICKUP_KIND_KEY);
  return PICKUP_KINDS.includes(raw) ? (raw as PickupKind) : undefined;
}

/**
 * The alarm-side dispatch: consume the pending kind, then run EXACTLY the
 * one runner discovery scheduled for it. The runners are the WorkSession's
 * existing pickup methods, passed in bound by alarm() -- no pickup logic
 * lives here. Re-throws a runner failure; WorkSession.alarm() catches it
 * and reports through notifyMartinOfDiscoveryFailure, matching each
 * discovery loop's own catch-and-notify behaviour (the Handoff stays
 * Pending and the next cycle retries). Returns the kind that ran, or
 * undefined when nothing was pending.
 */
export async function dispatchScheduledPickup(
  storage: PickupAlarmStorage,
  runners: Record<PickupKind, () => Promise<unknown>>,
): Promise<PickupKind | undefined> {
  const kind = await takePendingPickupKind(storage);
  if (!kind) return undefined;
  await runners[kind]();
  return kind;
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
