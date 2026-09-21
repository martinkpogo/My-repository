import type { SessionSummary } from "./types";

// sessions_index bounded-pool sizes. Pending approvals get a much larger
// reserved allowance than general work items, since losing visibility into
// an unresolved approval is a governance concern, not just clutter -- but
// both pools are hard caps (this KV value must stay bounded).
export const SESSIONS_INDEX_PENDING_CAP = 100;
export const SESSIONS_INDEX_GENERAL_CAP = 50;

// Mirrors the existing WATCHDOG_ALERT_MIN_INTERVAL_MS pattern in index.ts --
// once the pending pool is at capacity, re-alert at most this often rather
// than on every single save while the backlog persists.
export const PENDING_APPROVAL_BACKLOG_ALERT_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Pure bounded-retention logic for sessions_index -- kept dependency-free
 * (no Durable Object / Workers-runtime imports) so it's directly
 * unit-testable. sessions_index is an enumeration aid, not a second source
 * of truth: both pools are hard caps, never "keep everything." Pending
 * approvals get their own much larger reserved allowance than general
 * work items, but even that allowance is bounded -- see
 * shouldAlertPendingApprovalBacklog for what happens once it's reached.
 */
export function trimSessionsIndex(combined: SessionSummary[]): SessionSummary[] {
  const pending = combined.filter((s) => s.hasPendingApproval);
  const general = combined.filter((s) => !s.hasPendingApproval);
  const keptPending = pending.slice(-SESSIONS_INDEX_PENDING_CAP);
  const keptGeneral = general.slice(-SESSIONS_INDEX_GENERAL_CAP);
  return [...keptGeneral, ...keptPending];
}

/**
 * Pure rate-limit predicate for the pending-approval backlog alert -- mirrors
 * the existing WATCHDOG_ALERT_MIN_INTERVAL_MS pattern in index.ts.
 */
export function shouldAlertPendingApprovalBacklog(pendingCount: number, lastAlertTimestamp: string | null, now: number): boolean {
  if (pendingCount < SESSIONS_INDEX_PENDING_CAP) return false;
  if (!lastAlertTimestamp) return true;
  return now - Number(lastAlertTimestamp) >= PENDING_APPROVAL_BACKLOG_ALERT_MIN_INTERVAL_MS;
}
