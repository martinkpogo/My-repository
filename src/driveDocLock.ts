import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import {
  tryAcquireDriveDocLock,
  releaseDriveDocLock,
  inspectDriveDocLock,
  requestDriveDocPass,
  runDriveDocAlarm,
  DRIVE_DOC_LOCK_TTL_MS,
  DRIVE_DOC_COOLDOWN_MS,
  type DriveDocClaim,
} from "./driveDocLockState";
import { runDriveDocPassBody } from "./googleDriveWatch";

/**
 * The per-Doc lock for the Drive comment-notification path.
 *
 * Instances are addressed by `idFromName(documentId)`, so every notification
 * naming the same document reaches the SAME instance and therefore the same
 * storage. Notifications for DIFFERENT documents reach different instances and
 * never contend at all -- which is exactly the required behaviour: duplicates
 * serialize, separate docs proceed independently.
 *
 * TWO JOBS. (1) The bounded per-Doc claim the polling safety net takes
 * (tryAcquire/release). (2) Running NOTIFICATION passes from this object's
 * alarm (requestPass -> alarm), under that same claim. The notification
 * receiver only asks for a pass and answers Drive at once; the pass itself
 * runs here, where an alarm handler may run for up to 15 minutes -- unlike
 * ctx.waitUntil, which Cloudflare stops ~30s after the response and which
 * could leave a killed pass's claim held until its TTL.
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

  /**
   * Asks for one complete comment pass over `documentId`. Returns at once;
   * the pass runs from alarm(). Duplicate requests collapse into the pending
   * alarm or one catch-up pass (see requestDriveDocPass).
   */
  async requestPass(documentId: string): Promise<"scheduled" | "coalesced"> {
    return requestDriveDocPass(this.ctx.storage, this.ctx.storage, documentId);
  }

  /** Runs the requested pass under this document's claim, always releasing it. See runDriveDocAlarm. */
  async alarm(): Promise<void> {
    await runDriveDocAlarm(
      this.ctx.storage,
      this.ctx.storage,
      async (documentId) => {
        await runDriveDocPassBody(this.env, documentId);
      },
      DRIVE_DOC_LOCK_TTL_MS,
      DRIVE_DOC_COOLDOWN_MS,
    );
  }

  /** Diagnostic only: is the lock held, and until when? */
  async inspect(): Promise<{ heldUntil: number | null; lastStartedAt: number | null }> {
    return inspectDriveDocLock(this.ctx.storage);
  }
}
