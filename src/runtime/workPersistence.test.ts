import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExternalToolOperationRecord, WorkState } from "../types";
import {
  MAX_EXTERNAL_OPERATION_RECORDS,
  getWorkPersistence,
  installStatePersistence,
  workStatePersistence,
} from "./workPersistence";

/**
 * The Work-side half of the Tool Registry's durable-recovery contract:
 * one adapter per Work, a record map every copy of WorkState shares, a
 * release that can never tear down a newer installation, and a cap that
 * drops only the oldest TERMINAL records -- never an unresolved interruption.
 *
 * No provider is touched here: this module is storage plumbing, and the
 * invocation boundary (src/runtime/toolRegistry.ts) is what refuses to start
 * any effect when none of it is installed.
 */

function record(overrides: Partial<ExternalToolOperationRecord> = {}): ExternalToolOperationRecord {
  return {
    work_id: "work-1",
    tool_id: "google_docs",
    operation_id: "google_docs.create_and_verify",
    version: "1.0",
    target_resource_id: "gdrive:folder:folder-1",
    status: "succeeded",
    outcome: {
      state: "succeeded",
      tool_id: "google_docs",
      operation_id: "google_docs.create_and_verify",
      verified: true,
      remote_resource: { document_id: "doc-1" },
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function emptyState(workId = "work-1"): WorkState {
  return { workId, externalOperations: {} } as unknown as WorkState;
}

test("1. no Work has persistence installed until one is installed for it, and the release removes only that installation", () => {
  assert.equal(getWorkPersistence("work-1"), null, "an uninstalled Work must have none -- the boundary turns that into a fail-closed denial");
  assert.equal(getWorkPersistence(""), null, "an unknown Work id is never answered with another Work's storage");

  const { release } = installStatePersistence("work-1");
  assert.ok(getWorkPersistence("work-1"), "the installed adapter is what the boundary finds");
  assert.equal(getWorkPersistence("work-other"), null, "installing one Work never answers for another");

  release();
  assert.equal(getWorkPersistence("work-1"), null, "the release removes this Work's adapter");
});

test("2. a release is idempotent and can never tear down a NEWER installation for the same Work", () => {
  const first = installStatePersistence("work-1");
  const second = installStatePersistence("work-1");

  first.release();
  assert.ok(getWorkPersistence("work-1"), "the first (already superseded) release must leave the newer installation in place");

  const records = getWorkPersistence("work-1") as unknown as { load: (k: string) => Promise<unknown> };
  assert.ok(records, "the second installation is still the one answering");
  second.release();
  assert.equal(getWorkPersistence("work-1"), null, "the newer release removes it");

  second.release();
  first.release();
  assert.equal(getWorkPersistence("work-1"), null, "a stale repeated release still changes nothing");
});

test("3. the adapter reads and writes the Work's own record map, mutating it IN PLACE so every copy of WorkState shares the record", async () => {
  const state = emptyState();
  const shared = { ...state };
  const adapter = workStatePersistence(state, async () => undefined);

  await adapter.save("google_docs.create_and_verify|gdrive:folder:folder-1|abc", record());
  assert.equal(state.externalOperations!["google_docs.create_and_verify|gdrive:folder:folder-1|abc"]?.status, "succeeded");
  assert.equal(
    shared.externalOperations!["google_docs.create_and_verify|gdrive:folder:folder-1|abc"]?.status,
    "succeeded",
    "a WorkState copy made before the write must see it -- records are never written into a replacement object",
  );
  assert.equal((await adapter.load("google_docs.create_and_verify|gdrive:folder:folder-1|abc"))?.status, "succeeded");
  assert.equal(await adapter.load("nothing"), undefined);
});

test("4. every durable write is flushed, and a flush failure propagates so the boundary can fail closed", async () => {
  const state = emptyState();
  let flushes = 0;
  const adapter = workStatePersistence(state, async () => {
    flushes += 1;
  });
  await adapter.save("k", record());
  assert.equal(flushes, 1, "a save is only durable once the flush ran");

  const failing = workStatePersistence(state, async () => {
    throw new Error("storage unavailable");
  });
  await assert.rejects(() => failing.save("k2", record()), /storage unavailable/);
  assert.equal(state.externalOperations!["k2"]?.status, "succeeded", "the record is held in memory for the next attempt to settle");
});

test("5. the record cap drops the OLDEST TERMINAL records first and never an in_progress one -- an unresolved interruption is never forgotten", async () => {
  const state = emptyState();
  const adapter = workStatePersistence(state, async () => undefined);
  const started = Date.parse("2026-01-01T00:00:00.000Z");

  // One unresolved interruption, deliberately the OLDEST record there is.
  await adapter.save(
    "interrupted",
    record({ status: "in_progress", outcome: undefined, updatedAt: new Date(started).toISOString() }),
  );
  for (let i = 0; i < MAX_EXTERNAL_OPERATION_RECORDS + 2; i++) {
    await adapter.save(`terminal-${i}`, record({ target_resource_id: `gdrive:folder:folder-${i}`, updatedAt: new Date(started + (i + 1) * 1000).toISOString() }));
  }

  const keys = Object.keys(state.externalOperations!);
  assert.ok(keys.includes("interrupted"), "the in_progress record survives the cap");
  assert.ok(keys.length <= MAX_EXTERNAL_OPERATION_RECORDS, `the cap bounds WorkState growth (got ${keys.length})`);
  assert.ok(!keys.includes("terminal-0"), "the OLDEST terminal record is the one dropped");
  assert.ok(!keys.includes("terminal-1"), "then the next oldest terminal record");
  assert.ok(keys.includes(`terminal-${MAX_EXTERNAL_OPERATION_RECORDS + 1}`), "the newest records are kept");
});
