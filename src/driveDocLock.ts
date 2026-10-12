import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import {
  tryAcquireDriveDocLock,
  releaseDriveDocLock,
  inspectDriveDocLock,
  type DriveDocClaim,
} from "./driveDocLockState";

/**
 * The per-Doc lock for the Drive comment-notification path.
 *
 * Instances are addressed by `idFromName(documentId)`, so every notification
 * naming the same document reaches the SAME instance and therefore the same
 * storage. Notifications for DIFFERENT documents reach different instances and
 * never contend at all -- which is exactly the required behaviour: duplicates
 * serialize, separate docs proceed independently.
 *
 * WHY THE PASS RUNS OUTSIDE THIS CLASS. This class records who holds the lock
 * and nothing more. The actual comment pass runs in the calling Worker's
 * background (ctx.waitUntil), so a slow pass never occupies a Durable Object
 * request. The DO's job is a bounded claim and an honest answer.
 *
 * All decision logic lives in driveDocLockState.ts. That split is deliberate:
 * `cloudflare:workers` cannot be imported under the node test runner, so
 * putting the real logic in a pure module means the tests exercise the
 * production code path itself rather than a re-implementation that could drift
 * from it. This class is a forwarder with no behaviour of its own.
 */
export class DriveDocLock extends DurableObject<Env> {
  /**
   * Attempts to claim this document's lock. See tryAcquireDriveDocLock for the
   * full contract, including why the returned token is load-bearing.
   *
   * Durable Objects execute one request at a time (input gates), so two
   * near-simultaneous calls here are serialized and the second sees the first
   * one's claim -- there is no window in which both can succeed.
   */
  async tryAcquire(ttlMs: number, cooldownMs: number): Promise<DriveDocClaim | null> {
    return tryAcquireDriveDocLock(this.ctx.storage, ttlMs, cooldownMs);
  }

  /** Releases this document's lock early. A stale or foreign token is a no-op. */
  async release(token: string): Promise<void> {
    return releaseDriveDocLock(this.ctx.storage, token);
  }

  /** Diagnostic only: is the lock held, and until when? */
  async inspect(): Promise<{ heldUntil: number | null; lastStartedAt: number | null }> {
    return inspectDriveDocLock(this.ctx.storage);
  }
}
