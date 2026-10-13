import type { WorkState } from "./types";
import { getUnitManifests } from "./units/registry";

/**
 * Brings a saved Work up to the current WorkState shape.
 *
 * A Work is persisted as a WorkState and can wait days at an approval gate,
 * so the shape it was saved in must stay readable after the shape moves on.
 * Each Unit that has moved its state into its own slice declares how to read
 * the old shape (UnitManifest.migrateWorkState); this applies them all. Run
 * wherever a saved Work is loaded (WorkSession.getState, and the
 * mid-execution flush), so every reader sees the current shape and the next
 * save persists it -- the Work is rewritten on its next save, with no
 * separate migration job.
 *
 * It runs for EVERY Unit's hook regardless of which Unit owns the Work: a
 * Handoff chain carries one Work across Units, so a Sales-owned Work can hold
 * Strategy's state. Each hook is idempotent. Returns the same object.
 */
export function migrateWorkState<T extends object>(saved: T): T {
  for (const manifest of Object.values(getUnitManifests())) {
    manifest?.migrateWorkState?.(saved as Record<string, unknown>);
  }
  return saved;
}

/** Convenience for a possibly-absent saved Work. */
export function migrateSavedWork(saved: WorkState | undefined): WorkState | undefined {
  return saved ? migrateWorkState(saved) : saved;
}
