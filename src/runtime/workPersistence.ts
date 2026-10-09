/**
 * DURABLE OPERATION PERSISTENCE -- the Work-side half of the Tool Registry's
 * durable-recovery contract (src/runtime/toolRegistry.ts).
 *
 * The invocation boundary must persist its execution INTENT before the first
 * protected external effect and its OUTCOME immediately after, in the Work's
 * OWN storage. The established Work persistence mechanism is the WorkSession
 * Durable Object (one DO per Work, single `"state"` WorkState blob, see
 * src/session.ts), and this module is the narrow bridge to it -- deliberately
 * NOT a second source of truth:
 *
 *   - records live ON WorkState (`state.externalOperations`), so the durable
 *     copy is written by the same Durable Object that owns the Work and is
 *     serialized with every other Work mutation (DO input gates + this
 *     module's in-flight guard in the invocation boundary);
 *   - an immediate flush writes only those operation records, leaving
 *     whatever else the in-flight handler has touched to the ordinary
 *     `WorkSession.execute` save path -- a thrown handler still rolls back
 *     its own partial state exactly as before;
 *   - installation is scoped to the Work and to one `execute` call: the
 *     WorkSession installs the adapter before running a handler and releases
 *     it in `finally`, so no other Work (and no later call) can ever write
 *     through the wrong Work's storage.
 *
 * The invocation boundary FAILS CLOSED when no persistence is installed for
 * the Work judging the operation: an external effect that could not be
 * recovered after an interruption must not be initiated at all.
 */
import type { ExternalToolOperationRecord, WorkState } from "../types";

/**
 * The minimal durable-recovery surface the invocation boundary needs.
 * `load` reads this Work's record for one operation identity; `save` writes
 * one and makes it durable immediately (it must not merely mutate memory).
 */
export interface ToolOperationPersistence {
  load(key: string): Promise<ExternalToolOperationRecord | undefined>;
  save(key: string, record: ExternalToolOperationRecord): Promise<void>;
}

/**
 * How many operation records one Work keeps. Evolution only: pruning removes
 * the OLDEST TERMINAL records first, and never removes an `in_progress` one --
 * an unresolved interruption is exactly what must not be forgotten. The cap
 * bounds WorkState growth on a very long-lived Work without ever discarding
 * uncertainty.
 */
export const MAX_EXTERNAL_OPERATION_RECORDS = 12;

/** Keyed by Work id (globally unique), installed for the duration of one WorkSession.execute. */
const INSTALLED = new Map<string, ToolOperationPersistence>();

/**
 * Installs the persistence adapter for one Work and returns its release.
 * Called by WorkSession.execute around a handler; the release is idempotent
 * and removes only THIS installation, so a stale release can never tear down
 * a newer one.
 */
export function installWorkPersistence(workId: string, persistence: ToolOperationPersistence): () => void {
  INSTALLED.set(workId, persistence);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (INSTALLED.get(workId) === persistence) INSTALLED.delete(workId);
  };
}

/**
 * The persistence adapter for the Work whose state is in front of the caller,
 * or null when this Work has none installed. `flush` must make the record
 * durable (WorkSession passes a Durable Object storage write that preserves
 * the pre-handler state except for `externalOperations`).
 */
export function workStatePersistence(state: WorkState, flush: () => Promise<void>): ToolOperationPersistence {
  return {
    async load(key: string): Promise<ExternalToolOperationRecord | undefined> {
      return state.externalOperations?.[key];
    },
    async save(key: string, record: ExternalToolOperationRecord): Promise<void> {
      // The record map is mutated IN PLACE: Work handlers may copy WorkState
      // with a shallow spread, and every copy then shares this same map.
      // Replacing the object instead would let a copy made before the write
      // silently miss the record.
      const records = state.externalOperations ?? (state.externalOperations = {});
      records[key] = record;
      pruneExternalOperationRecords(records);
      await flush();
    },
  };
}

/** Caps the record set by dropping the oldest TERMINAL records first -- never an in_progress one. */
function pruneExternalOperationRecords(records: Record<string, ExternalToolOperationRecord>): void {
  const keys = Object.keys(records);
  if (keys.length <= MAX_EXTERNAL_OPERATION_RECORDS) return;
  const terminalOldestFirst = keys
    .filter((key) => records[key].status !== "in_progress")
    .sort((a, b) => records[a].updatedAt.localeCompare(records[b].updatedAt));
  let excess = keys.length - MAX_EXTERNAL_OPERATION_RECORDS;
  for (const key of terminalOldestFirst) {
    if (excess <= 0) break;
    delete records[key];
    excess -= 1;
  }
}

/**
 * Installs durable operation persistence for one Work over a plain record
 * map, returning that map and the release. Used by tests (and any host that
 * already holds the Work's operation records in memory) to give the
 * invocation boundary the adapter it fails closed without; WorkSession builds
 * the equivalent adapter over this Work's own Durable Object storage (see
 * `execute` in src/session.ts).
 */
export function installStatePersistence(
  workId: string,
  records: Record<string, ExternalToolOperationRecord> = {},
  flush: () => Promise<void> = async () => undefined,
): { records: Record<string, ExternalToolOperationRecord>; release: () => void } {
  const state = { workId, externalOperations: records } as unknown as WorkState;
  const release = installWorkPersistence(workId, workStatePersistence(state, flush));
  return { records, release };
}

/**
 * Looks up the installed persistence for a Work. Returns null (which the
 * invocation boundary turns into a fail-closed denial, never into "proceed
 * without durability") when no adapter is installed -- e.g. a handler reached
 * outside WorkSession.execute, or a unit test that has not installed one.
 */
export function getWorkPersistence(workId: string): ToolOperationPersistence | null {
  if (typeof workId !== "string" || workId.length === 0) return null;
  return INSTALLED.get(workId) ?? null;
}
