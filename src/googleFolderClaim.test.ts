import test from "node:test";
import assert from "node:assert/strict";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  claimFolderOptionOnStorage,
  resolveFolderClaimOnStorage,
  getFolderClaimStatusOnStorage,
  type FolderClaimRecord,
} from "./googleFolderClaim";

/**
 * A DurableObjectStorage mock that genuinely serializes competing
 * transactions. Each call to transaction() appends to a promise chain so
 * that only one transaction's closure runs at a time. Writes are immediately
 * visible to subsequent transactions. This is NOT a mock that merely buffers
 * writes while allowing both transactions to read an absent record -- the
 * mutex ensures true serializability.
 */
interface MockTxn {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  list: () => Promise<Map<string, unknown>>;
  rollback: () => void;
}

function createMockDurableObjectStorage() {
  const store = new Map<string, unknown>();
  let currentTransaction: Promise<unknown> = Promise.resolve();

  const txn: MockTxn = {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
    list: async (): Promise<Map<string, unknown>> => new Map(),
    rollback: (): void => {
      // no-op for mock
    },
  };

  return {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
    list: async (): Promise<Map<string, unknown>> => new Map(),
    transaction: async <T = unknown>(
      closure: (txn: MockTxn) => Promise<T>,
    ): Promise<unknown> => {
      const previous = currentTransaction;
      currentTransaction = (async () => {
        await previous; // Serialize: wait for prior transaction to complete
        return await closure(txn);
      })();
      return currentTransaction;
    },
  };
}

async function claimTwiceConcurrently(
  storage: ReturnType<typeof createMockDurableObjectStorage>,
  opaqueId: string,
): Promise<Array<{ status: "fulfilled" | "rejected"; value?: boolean }>> {
  const results = await Promise.allSettled([
    claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, opaqueId),
    claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, opaqueId),
  ]);
  return results.map((r) => ({
    status: r.status,
    value: r.status === "fulfilled" ? r.value : undefined,
  }));
}

test("googleFolderClaim: first claim succeeds", async () => {
  const storage = createMockDurableObjectStorage();
  const result = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-abc123");
  assert.strictEqual(result, true, "first claim should be granted");
});

test("googleFolderClaim: second claim is rejected", async () => {
  const storage = createMockDurableObjectStorage();
  await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-abc123");
  const result = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-abc123");
  assert.strictEqual(result, false, "second claim should be rejected");
});

test("googleFolderClaim: two overlapping transactions cannot both succeed", async () => {
  const storage = createMockDurableObjectStorage();
  const results = await claimTwiceConcurrently(storage, "opaque-concurrent");
  const successes = results.filter((r) => r.status === "fulfilled" && r.value === true);
  const failures = results.filter((r) => r.status === "fulfilled" && r.value === false);
  const rejections = results.filter((r) => r.status === "rejected");
  assert.strictEqual(
    successes.length,
    1,
    "exactly one concurrent claim should succeed",
  );
  assert.strictEqual(
    failures.length,
    1,
    "the losing claim should return false (not reject)",
  );
  assert.strictEqual(rejections.length, 0, "no claim should throw");
});

test("googleFolderClaim: completed claim remains unavailable during retention", async () => {
  const storage = createMockDurableObjectStorage();
  await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-completed");
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-completed", "completed");

  // Status read should return "completed"
  const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-completed");
  assert.strictEqual(status, "completed");

  // A new claim should still be rejected (completed blocks re-claim)
  const claimAgain = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-completed");
  assert.strictEqual(claimAgain, false, "completed claim blocks re-claim");
});

test("googleFolderClaim: failed claim remains unavailable during retention", async () => {
  const storage = createMockDurableObjectStorage();
  await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-failed");
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-failed", "failed");

  const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-failed");
  assert.strictEqual(status, "failed");

  const claimAgain = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-failed");
  assert.strictEqual(claimAgain, false, "failed claim blocks re-claim");
});

test("googleFolderClaim: expired completed record can be reclaimed via claim directly", async () => {
  const storage = createMockDurableObjectStorage();
  const originalNow = Date.now;
  try {
    Date.now = () => 0 as unknown as number;

    await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-complete");
    await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-complete", "completed");

    // Advance clock past retention (24h + 1ms). Do NOT call getFolderClaimStatusOnStorage first.
    Date.now = () => (24 * 60 * 60 * 1000 + 1) as unknown as number;

    // claimFolderOptionOnStorage must handle expiry internally and replace the marker.
    const claimAgain = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-complete");
    assert.strictEqual(claimAgain, true, "expired completed record can be reclaimed via claim directly");

    // Verify the record is now claimed (not completed).
    const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-complete");
    assert.strictEqual(status, "claimed", "record should now be claimed");
  } finally {
    Date.now = originalNow;
  }
});

test("googleFolderClaim: expired failed record can be reclaimed via claim directly", async () => {
  const storage = createMockDurableObjectStorage();
  const originalNow = Date.now;
  try {
    Date.now = () => 0 as unknown as number;

    await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-failed");
    await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-failed", "failed");

    // Advance clock past retention (24h + 1ms). Do NOT call getFolderClaimStatusOnStorage first.
    Date.now = () => (24 * 60 * 60 * 1000 + 1) as unknown as number;

    const claimAgain = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-failed");
    assert.strictEqual(claimAgain, true, "expired failed record can be reclaimed via claim directly");

    const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-failed");
    assert.strictEqual(status, "claimed", "record should now be claimed");
  } finally {
    Date.now = originalNow;
  }
});

test("googleFolderClaim: completed marker cannot be overwritten by failed resolution", async () => {
  const storage = createMockDurableObjectStorage();
  await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-complete");
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-complete", "completed");

  // Attempt to transition completed → failed: must be a no-op.
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-complete", "failed");

  const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-complete");
  assert.strictEqual(status, "completed", "completed marker must not be overwritten to failed");
});

test("googleFolderClaim: failed marker cannot be overwritten by completed resolution", async () => {
  const storage = createMockDurableObjectStorage();
  await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-failed");
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-failed", "failed");

  // Attempt to transition failed → completed: must be a no-op.
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-failed", "completed");

  const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-terminal-failed");
  assert.strictEqual(status, "failed", "failed marker must not be overwritten to completed");
});

test("googleFolderClaim: two concurrent attempts to replace an expired marker produce exactly one claimant", async () => {
  const storage = createMockDurableObjectStorage();
  const originalNow = Date.now;
  try {
    Date.now = () => 0 as unknown as number;

    // Seed a completed marker that is past retention.
    await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-race");
    await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-race", "completed");
    Date.now = () => (24 * 60 * 60 * 1000 + 1) as unknown as number;

    const results = await claimTwiceConcurrently(storage, "opaque-exp-race");
    const successes = results.filter((r) => r.status === "fulfilled" && r.value === true);
    const failures = results.filter((r) => r.status === "fulfilled" && r.value === false);
    const rejections = results.filter((r) => r.status === "rejected");

    assert.strictEqual(
      successes.length,
      1,
      "exactly one concurrent replacement claim should succeed",
    );
    assert.strictEqual(
      failures.length,
      1,
      "the losing replacement claim should return false",
    );
    assert.strictEqual(rejections.length, 0, "no claim should throw");

    // Verify the record is claimed (not completed).
    const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-exp-race");
    assert.strictEqual(status, "claimed", "record should be claimed after concurrent replacement");
  } finally {
    Date.now = originalNow;
  }
});

test("googleFolderClaim: claimed record is not automatically released by age", async () => {
  const storage = createMockDurableObjectStorage();
  const originalNow = Date.now;
  try {
    Date.now = () => 0 as unknown as number;

    await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-claimed-stale");

    // Advance clock well past retention
    Date.now = () => (24 * 60 * 60 * 1000 * 365) as unknown as number; // 1 year later

    // Claimed record should still block re-claim (never auto-released)
    const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-claimed-stale");
    assert.strictEqual(status, "claimed", "claimed record never expires on read");

    const claimAgain = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-claimed-stale");
    assert.strictEqual(claimAgain, false, "claimed record blocks re-claim regardless of age");
  } finally {
    Date.now = originalNow;
  }
});

test("googleFolderClaim: different opaqueIds are independent", async () => {
  const storage = createMockDurableObjectStorage();
  const resultA = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-id-a");
  const resultB = await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-id-b");
  assert.strictEqual(resultA, true, "claim for id-a succeeds");
  assert.strictEqual(resultB, true, "claim for id-b also succeeds (different options)");
});

test("googleFolderClaim: resolve on non-existent claim is a no-op", async () => {
  const storage = createMockDurableObjectStorage();
  // Should not throw
  await resolveFolderClaimOnStorage(storage as unknown as DurableObjectStorage, "opaque-nonexistent", "completed");
  const status = await getFolderClaimStatusOnStorage(storage as unknown as DurableObjectStorage, "opaque-nonexistent");
  assert.strictEqual(status, undefined);
});

test("googleFolderClaim: claim record shape is correct", async () => {
  const storage = createMockDurableObjectStorage();
  const originalNow = Date.now;
  try {
    Date.now = () => 1_700_000_000_000 as unknown as number;

    await claimFolderOptionOnStorage(storage as unknown as DurableObjectStorage, "opaque-shape");

    // Read the raw record to verify shape
    const raw = await storage.get<FolderClaimRecord>("googleFolderClaim:opaque-shape");
    assert.ok(raw, "claim record should exist");
    assert.strictEqual(raw.status, "claimed");
    assert.strictEqual(raw.createdAt, 1_700_000_000_000);
    assert.strictEqual(raw.resolvedAt, undefined);
  } finally {
    Date.now = originalNow;
  }
});
