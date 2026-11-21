import type { DurableObjectStorage } from "@cloudflare/workers-types";

/**
 * Key prefix for folder-selection claim markers stored in WorkSession DO storage.
 * Each WorkSession DO instance (one per workId) holds claim markers for the
 * folder-selection options it has staged. The actual folder-list payload
 * remains in KV/Turso (google_option: keys); only the claim marker lives here.
 */
export const GOOGLE_FOLDER_CLAIM_KEY_PREFIX = "googleFolderClaim:";
/** Initial retention period for completed and failed claim markers (24 hours). */
export const CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * A claim marker records whether a folder-selection option has been claimed,
 * and whether the subsequent processing completed or failed. Claimed records
 * are never auto-released; completed/failed records are lazily expired on
 * read after CLAIM_RETENTION_MS.
 */
export interface FolderClaimRecord {
  status: "claimed" | "completed" | "failed";
  createdAt: number;
  resolvedAt?: number;
}

export type FolderClaimStatus = "claimed" | "completed" | "failed";

/**
 * Atomically claims a folder-selection option. Returns true if the claim was
 * granted, false if an existing marker still blocks it.
 *
 * Inside one storage.transaction():
 *   - No marker exists → create a claimed marker, return true.
 *   - Marker is completed or failed and older than CLAIM_RETENTION_MS →
 *     replace it with a new claimed marker, return true.
 *   - Marker is still within retention → return false.
 *   - Marker is claimed → return false regardless of age (claimed records
 *     are never auto-released).
 *
 * The expiry check, replacement, and new claim happen within one
 * transaction — no gap between deleting an expired marker and claiming
 * its replacement.
 *
 * Uses storage.transaction() so exactly one caller can succeed even under
 * concurrent delivery: the transaction's check-and-set is atomic within the
 * Durable Object.
 *
 * The folder-list payload itself remains in KV/Turso; this only marks the
 * claim in DO storage.
 */
export async function claimFolderOptionOnStorage(
  storage: DurableObjectStorage,
  opaqueId: string,
): Promise<boolean> {
  const key = `${GOOGLE_FOLDER_CLAIM_KEY_PREFIX}${opaqueId}`;
  const now = Date.now();
  return await storage.transaction(async (txn) => {
    const existing = await txn.get<FolderClaimRecord>(key);
    if (!existing) {
      await txn.put(key, { status: "claimed", createdAt: now });
      return true;
    }
    // A claimed record is never auto-released, regardless of age.
    if (existing.status === "claimed") return false;
    // Completed or failed markers may be reclaimed after retention expires.
    if (
      existing.resolvedAt !== undefined &&
      now - existing.resolvedAt > CLAIM_RETENTION_MS
    ) {
      await txn.put(key, { status: "claimed", createdAt: now });
      return true;
    }
    // Still within retention: block the claim.
    return false;
  });
}

/**
 * Resolves an existing claim marker to completed or failed status.
 * Only transitions from "claimed" to the given terminal status.
 * If the record is already completed or failed, it is not overwritten.
 * No-op if no claim marker exists for this opaqueId.
 */
export async function resolveFolderClaimOnStorage(
  storage: DurableObjectStorage,
  opaqueId: string,
  status: "completed" | "failed",
): Promise<void> {
  const key = `${GOOGLE_FOLDER_CLAIM_KEY_PREFIX}${opaqueId}`;
  await storage.transaction(async (txn) => {
    const existing = await txn.get<FolderClaimRecord>(key);
    if (!existing) return;
    if (existing.status !== "claimed") return;
    await txn.put(key, { ...existing, status, resolvedAt: Date.now() });
  });
}

/**
 * Reads the claim status for an opaqueId. Completed and failed records older
 * than CLAIM_RETENTION_MS are lazily deleted on access. Claimed records are
 * never auto-released regardless of age.
 */
export async function getFolderClaimStatusOnStorage(
  storage: DurableObjectStorage,
  opaqueId: string,
): Promise<FolderClaimStatus | undefined> {
  const key = `${GOOGLE_FOLDER_CLAIM_KEY_PREFIX}${opaqueId}`;
  const record = await storage.get<FolderClaimRecord>(key);
  if (!record) return undefined;

  if (
    (record.status === "completed" || record.status === "failed") &&
    record.resolvedAt !== undefined &&
    Date.now() - record.resolvedAt > CLAIM_RETENTION_MS
  ) {
    await storage.delete(key);
    return undefined;
  }

  return record.status;
}
