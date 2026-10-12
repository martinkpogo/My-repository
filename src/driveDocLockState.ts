/**
 * The state machine behind the per-Doc Drive comment lock.
 *
 * Deliberately separated from the Durable Object class that fronts it (see
 * driveDocLock.ts): the DO cannot be imported under the node test runner
 * (`cloudflare:workers` is a Workers-only module), so keeping the actual
 * decision logic here as pure functions over a minimal storage surface means
 * the logic under test IS the logic in production -- not a re-implementation
 * that could drift from it. The DO class holds no behaviour of its own beyond
 * forwarding to these functions.
 *
 * WHY THIS EXISTS AT ALL. Drive delivers `files.watch` notifications
 * at-least-once and duplicates them freely, so two notifications for the same
 * document can arrive close together. Without coordination both would start a
 * full comment pass over the SAME document, racing each other on marker writes
 * and replies. PR #278's marker-before-reply ordering already makes a repeated
 * pass safe in the sense that a comment is never replied to twice, but that is
 * a property worth having as a backstop, not as the primary control. This lock
 * is the primary control: at most one pass per document at a time.
 *
 * BOUNDED BEHAVIOUR, WHICH IS THE PART THAT MUST NOT BE GOT WRONG. A lock a
 * crashed execution never releases would permanently block that document's
 * notification path forever -- the worst possible failure for a mechanism whose
 * whole purpose is promptness. So every claim EXPIRES: `heldUntil` is a
 * timestamp, and once it is in the past the lock is free again whether or not
 * release() ever ran. A pass that dies mid-flight costs at most the TTL, never
 * eternity.
 *
 * THE COOLDOWN. A burst of duplicates is collapsed rather than merely
 * serialized: a claim is also refused when the previous run for this document
 * started less than `cooldownMs` ago. N duplicates arriving within a second
 * therefore become one run plus the natural catch-up, rather than N runs back
 * to back. It is a small spacing, not a debounce window -- it never delays a
 * genuinely later change by anything worth measuring against the poll interval
 * it exists to beat.
 */

import type { Env } from "./types";

/**
 * How long one document's pass may hold its lock before the lock is treated as
 * abandoned. This is the bound that keeps a crashed or hung execution from
 * permanently blocking future processing of that doc: a pass that never
 * releases simply expires, and the next notification or poll proceeds. Chosen
 * generously above any realistic pass duration so a live pass is never stolen
 * out from under itself.
 */
export const DRIVE_DOC_LOCK_TTL_MS = 5 * 60 * 1000;

/** The minimum spacing between two accepted NOTIFICATION passes for the same doc, so a burst of duplicates collapses into one run plus one catch-up. The poller does not apply it (see pollGoogleDocComments). */
export const DRIVE_DOC_COOLDOWN_MS = 3 * 1000;

/**
 * Returns the lock stub for one document, or null when the namespace is not
 * bound. Shared by BOTH entry points that run a document's comment pass -- the
 * Drive notification receiver and the polling safety net -- so they contend on
 * the same per-Doc instance. The cast matches the existing getSessionStub
 * convention in sessionRouting.ts: the RPC surface is defined by the
 * DriveDocLock class, and TypeScript's cross-module DO typing cannot see it
 * from here.
 */
export function driveDocLockStub(env: Env, documentId: string): any | null {
  const ns = env.DRIVE_DOC_LOCK;
  if (!ns) return null;
  return ns.get(ns.idFromName(documentId)) as any;
}

/** The minimal storage surface the lock needs -- DurableObjectStorage satisfies it, and so does a test's Map-backed fake. */
export interface DriveDocLockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** Returns a boolean on DurableObjectStorage and void on a test fake, so both satisfy this. */
  delete(key: string): Promise<unknown>;
}

/** A successful claim: the token MUST be handed back to release(), which is what makes a stale release safe. */
export interface DriveDocClaim {
  token: string;
}

const HELD_UNTIL_KEY = "heldUntil";
const CLAIM_TOKEN_KEY = "claimToken";
const LAST_STARTED_AT_KEY = "lastStartedAt";

/**
 * Attempts to claim this document's lock.
 *
 * Returns a claim token iff the caller now holds the lock and must run the
 * pass, then call releaseDriveDocLock() with that same token. Returns null
 * when another pass is genuinely in flight, or when this document ran too
 * recently to be worth running again -- in both cases the caller must do
 * nothing, which is always safe because the polling safety net still covers
 * the document.
 *
 * The token matters for correctness, not just bookkeeping. A pass that hangs
 * past the TTL can outlive its own claim: another pass may then legitimately
 * acquire the lock, and the original pass's late release must NOT free the
 * successor's claim. The token is what makes that distinction possible --
 * release clears a claim only whose token matches the one it was handed, so a
 * stale release is a no-op rather than an unlock of someone else's lock.
 *
 * `now` is a parameter, not Date.now() inline, so a test can drive the clock
 * directly and prove the TTL and cooldown bounds without waiting in real time.
 */
export async function tryAcquireDriveDocLock(
  storage: DriveDocLockStorage,
  ttlMs: number,
  cooldownMs: number,
  now: number = Date.now(),
): Promise<DriveDocClaim | null> {
  const heldUntil = (await storage.get<number>(HELD_UNTIL_KEY)) ?? 0;
  // Another pass holds the lock right now.
  if (heldUntil > now) return null;

  const lastStartedAt = (await storage.get<number>(LAST_STARTED_AT_KEY)) ?? 0;
  // This document ran too recently; collapse the duplicate.
  if (cooldownMs > 0 && lastStartedAt > 0 && now - lastStartedAt < cooldownMs) return null;

  const token = crypto.randomUUID();
  await storage.put(HELD_UNTIL_KEY, now + ttlMs);
  await storage.put(CLAIM_TOKEN_KEY, token);
  await storage.put(LAST_STARTED_AT_KEY, now);
  return { token };
}

/**
 * Releases this document's lock early, so the next notification does not have
 * to wait out the TTL.
 *
 * Clears the claim ONLY when the token still matches the one this caller was
 * given. A release from a pass whose claim already expired is a no-op (time
 * already freed it), and a release from a pass that outlived its TTL cannot
 * unlock a successor's claim, because the successor minted a different token.
 * Without this check a hung pass finishing late would silently unlock the
 * document under a pass that is still running -- exactly the overlap the lock
 * exists to prevent.
 */
export async function releaseDriveDocLock(storage: DriveDocLockStorage, token: string): Promise<void> {
  const storedToken = await storage.get<string>(CLAIM_TOKEN_KEY);
  if (storedToken !== token) return; // stale or foreign release -- never clears another pass's claim
  await storage.delete(HELD_UNTIL_KEY);
  await storage.delete(CLAIM_TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Notification passes run from this Durable Object's ALARM, not from the
// notifying request's ctx.waitUntil. Cloudflare stops waitUntil work ~30s
// after the response; a pass killed there never reaches its `finally`, so its
// claim stayed held until the TTL and the polling safety net (which honours
// the same lock) skipped the document for up to DRIVE_DOC_LOCK_TTL_MS. An
// alarm handler has a 15-minute limit, so a pass always completes and
// releases. Same pattern as Handoff pickups (session.ts WorkSession.alarm).
// ---------------------------------------------------------------------------

/** The DO alarm surface the scheduler needs -- DurableObjectStorage satisfies it, and so does a test fake. */
export interface DriveDocAlarmControl {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

const PENDING_DOCUMENT_KEY = "pendingDocumentId";
const RERUN_REQUESTED_KEY = "rerunRequested";

/** How long the alarm waits before retrying when the poller holds the document's lock. */
export const DRIVE_DOC_DEFER_MS = 15 * 1000;

/**
 * Records that this document needs a (re-)read and arms the alarm if none is
 * pending. Duplicate and out-of-order notifications therefore collapse: while
 * an alarm is pending or a pass is running, a notification only sets the
 * "run again" flag, and the running pass re-arms the alarm once it ends so the
 * change it may have missed is picked up by exactly one catch-up pass --
 * never dropped, never run concurrently.
 */
export async function requestDriveDocPass(
  storage: DriveDocLockStorage,
  alarm: DriveDocAlarmControl,
  documentId: string,
  now: number = Date.now(),
): Promise<"scheduled" | "coalesced"> {
  await storage.put(PENDING_DOCUMENT_KEY, documentId);
  await storage.put(RERUN_REQUESTED_KEY, true);
  if ((await alarm.getAlarm()) !== null) return "coalesced";
  await alarm.setAlarm(now);
  return "scheduled";
}

/**
 * The alarm body. Claims the document's lock (no cooldown: the "run again"
 * flag is what collapses bursts), runs ONE complete pass, and always releases
 * the claim in `finally`. If the poller currently holds the lock, the run is
 * deferred rather than overlapped. `runPass` must not throw for an ordinary
 * pass failure (it reports its own); if it does, the claim is still released
 * and the "run again" flag is restored so Cloudflare's alarm retry re-runs it.
 */
export async function runDriveDocAlarm(
  storage: DriveDocLockStorage,
  alarm: DriveDocAlarmControl,
  runPass: (documentId: string) => Promise<void>,
  ttlMs: number,
  cooldownMs: number,
  now: () => number = Date.now,
): Promise<"ran" | "deferred" | "idle"> {
  const documentId = await storage.get<string>(PENDING_DOCUMENT_KEY);
  const rerun = await storage.get<boolean>(RERUN_REQUESTED_KEY);
  if (!documentId || !rerun) return "idle";

  const claim = await tryAcquireDriveDocLock(storage, ttlMs, 0, now());
  if (!claim) {
    await alarm.setAlarm(now() + DRIVE_DOC_DEFER_MS);
    return "deferred";
  }

  // Cleared BEFORE the pass reads anything, so a notification that lands
  // while the pass runs sets it again and earns a catch-up pass.
  await storage.put(RERUN_REQUESTED_KEY, false);
  let completed = false;
  try {
    await runPass(documentId);
    completed = true;
  } finally {
    if (!completed) await storage.put(RERUN_REQUESTED_KEY, true);
    await releaseDriveDocLock(storage, claim.token);
    if (completed && (await storage.get<boolean>(RERUN_REQUESTED_KEY))) {
      await alarm.setAlarm(now() + cooldownMs);
    }
  }
  return "ran";
}

/** Diagnostic: is this document's lock currently held, and until when? Never on a request path. */
export async function inspectDriveDocLock(storage: DriveDocLockStorage, now: number = Date.now()): Promise<{ heldUntil: number | null; lastStartedAt: number | null }> {
  const heldUntil = (await storage.get<number>(HELD_UNTIL_KEY)) ?? null;
  const lastStartedAt = (await storage.get<number>(LAST_STARTED_AT_KEY)) ?? null;
  return { heldUntil: heldUntil && heldUntil > now ? heldUntil : null, lastStartedAt: lastStartedAt || null };
}
