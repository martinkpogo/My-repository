import type { SessionSummary } from "./types";

// sessions_index bounded-pool sizes. Pending approvals get a much larger
// reserved allowance than general work items, since losing visibility into
// an unresolved approval is a governance concern, not just clutter -- but
// both pools are hard caps (this KV value must stay bounded).
export const SESSIONS_INDEX_PENDING_CAP = 100;
export const SESSIONS_INDEX_GENERAL_CAP = 50;

/**
 * The ONLY shape allowed to appear as a token reference in
 * sessions_index: identityResolution.ts's canonical token shape
 * (`ENT-<n>` / `MAT-<n>`). Anything else -- names, free text, malformed
 * values -- is dropped rather than stored or displayed.
 */
const TOKEN_REF_PATTERN = /^[A-Z]{1,6}-\d{1,6}$/;

/** Returns the value only when it is a canonical token reference; anything else is discarded. */
export function safeTokenRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && TOKEN_REF_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * The ONE label vocabulary for sessions_index: token references when the
 * Work has them, otherwise fixed generic metadata. This is the value-level
 * data boundary for the index -- no human-readable name, enquiry text or
 * free-text approval label can ever be produced here, so nothing that
 * enters Turso through this key carries identity or content.
 * (Architect ruling: the summary label holds only safe token references or
 * generic metadata; workId stays the execution reference.)
 */
export function deriveSessionLabel(summary: { entityToken?: string; matterToken?: string; hasPendingApproval?: boolean }): string {
  const tokens = [safeTokenRef(summary.entityToken), safeTokenRef(summary.matterToken)].filter((t): t is string => Boolean(t));
  if (tokens.length > 0) return tokens.join(" · ");
  return summary.hasPendingApproval ? "pending approval" : "(new)";
}

/**
 * Rebuild one summary so its stored label (and token fields) are the safe
 * representation. Legacy entries written before this contract carried
 * free-text labels (`New Entity: <name>`, `Opportunity: <org>`, enquiry
 * slices); those labels are discarded, not trusted, because the label is
 * DERIVED from the token fields -- never read back from storage.
 */
export function sanitizeSessionSummary(summary: SessionSummary): SessionSummary {
  const entityToken = safeTokenRef(summary.entityToken);
  const matterToken = safeTokenRef(summary.matterToken);
  return {
    ...summary,
    entityToken,
    matterToken,
    label: deriveSessionLabel({ entityToken, matterToken, hasPendingApproval: summary.hasPendingApproval }),
  };
}

/**
 * Sanitize an entire index in one pass. Applied to the WHOLE array on
 * every sessions_index write (session.ts updateRegistry), so a single save
 * rewrites every legacy entry -- after one write, no free-text label can
 * remain anywhere in the stored JSON.
 */
export function sanitizeSessionsIndex(index: SessionSummary[]): SessionSummary[] {
  return index.map(sanitizeSessionSummary);
}

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
