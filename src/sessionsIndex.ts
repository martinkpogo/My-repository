import type { Env, SessionSummary } from "./types";
import { kvGet, kvPut } from "./kvStore";

// sessions_index bounded-pool sizes. Pending approvals get a much larger
// reserved allowance than general work items, since losing visibility into
// an unresolved approval is a governance concern, not just clutter -- but
// both pools are hard caps (this KV value must stay bounded).
export const SESSIONS_INDEX_PENDING_CAP = 100;
export const SESSIONS_INDEX_GENERAL_CAP = 50;

/**
 * The ONLY shapes allowed to appear as a token reference in sessions_index,
 * enforced per role. Canonical ENIG tokens are the live Notion unique_id
 * displays: an Entity is `ENT-<n>` and a Matter is `MAT-<n>` (verified
 * against the live Entity/Matter databases, whose Entity_ID/Matter_ID
 * properties read back as e.g. `ENT-28` / `MAT-29`; ENIG's `uniqueId()`
 * in src/notion.ts renders them as `prefix-number`). A token of the wrong
 * role, a Handoff/Call-Notes/Activity id (`HO-`, `CN-`, `LOG-`), a stale
 * prefix (`E-`, `M-`), a name or any other free text is dropped rather
 * than stored or displayed -- the label may only ever name this Work's own
 * Entity/Matter reference.
 */
const ENTITY_TOKEN_PATTERN = /^ENT-\d{1,6}$/;
const MATTER_TOKEN_PATTERN = /^MAT-\d{1,6}$/;

/** Returns the value only when it is a canonical Entity token (`ENT-<n>`); anything else is discarded. */
export function safeEntityTokenRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && ENTITY_TOKEN_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Returns the value only when it is a canonical Matter token (`MAT-<n>`); anything else is discarded. */
export function safeMatterTokenRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && MATTER_TOKEN_PATTERN.test(trimmed) ? trimmed : undefined;
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
  const tokens = [safeEntityTokenRef(summary.entityToken), safeMatterTokenRef(summary.matterToken)].filter((t): t is string => Boolean(t));
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
  const entityToken = safeEntityTokenRef(summary.entityToken);
  const matterToken = safeMatterTokenRef(summary.matterToken);
  return {
    ...summary,
    entityToken,
    matterToken,
    label: deriveSessionLabel({ entityToken, matterToken, hasPendingApproval: summary.hasPendingApproval }),
  };
}

/**
 * Sanitize an entire index in one pass. Applied to the WHOLE array on
 * every sessions_index write (session.ts updateRegistry) AND on every read
 * (loadSessionsIndexForRead), so a single write rewrites every legacy
 * entry and no reader can ever consume an unsanitized one -- after one
 * write, no free-text label can remain anywhere in the stored JSON.
 * A non-object array element is corrupt, not a Work: it is dropped rather
 * than trusted (an unreadable entry is never permission to guess).
 */
export function sanitizeSessionsIndex(index: SessionSummary[]): SessionSummary[] {
  return index.filter((s): s is SessionSummary => Boolean(s) && typeof s === "object").map(sanitizeSessionSummary);
}

/**
 * The ONE sanctioned read path for sessions_index. A stored label is
 * never trusted -- not from KV, not from Turso through kvGet (the seam
 * returns bytes of either provenance): every entry is re-derived by
 * sanitizeSessionsIndex before any caller sees it, so legacy free-text
 * labels written before this contract cannot reach a display or any other
 * consumer. When the stored value still differs from its sanitized form,
 * the sanitized array is rewritten once through the same kvPut seam
 * (bounded migration: after one successful rewrite the next read finds no
 * difference and writes nothing). The migration is best-effort and
 * fail-closed about the truth: a failed write is logged as exactly what it
 * is -- the values served here are sanitized in memory, but the persisted
 * value still holds the legacy labels until a later read or Work save
 * rewrites it. An unparseable stored value is served as empty with NO
 * migration write: corrupt bytes are not permission to overwrite evidence.
 */
export async function loadSessionsIndexForRead(env: Env): Promise<SessionSummary[]> {
  const raw = await kvGet(env, "sessions_index");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("sessionsIndex: stored sessions_index could not be parsed -- serving it as empty, with no migration write", err);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error("sessionsIndex: stored sessions_index is not an array -- serving it as empty, with no migration write");
    return [];
  }
  const sanitized = sanitizeSessionsIndex(parsed as SessionSummary[]);
  if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
    try {
      await kvPut(env, "sessions_index", JSON.stringify(sanitized));
    } catch (err) {
      console.error("sessionsIndex: sanitized sessions_index rewrite failed -- the values served here are sanitized, but the persisted value still holds the legacy labels", err);
    }
  }
  return sanitized;
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

/**
 * /sessions display vocabulary. Work-item stages are internal code states
 * (e.g. "awaiting_qualification_approval") used for control flow, not
 * written for a human reader -- this turns any of them into plain English
 * for display without needing a maintained mapping. Moved here from index.ts
 * so the row template below can be unit-tested (index.ts imports the
 * Workers runtime and cannot be loaded in tests).
 */
export function humanizeStage(stage: string): string {
  return stage.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * The ONE /sessions row template (extracted from index.ts's listSessions so
 * the exact emitted text is unit-testable against hostile stored values).
 * It only ever interpolates unit/hat/label/stage -- and the label reaching
 * here is already the sanitized derivation (loadSessionsIndexForRead), so a
 * legacy name or enquiry excerpt can never appear in this text.
 */
export function sessionRowText(summary: SessionSummary, activeWorkId: string | null | undefined): string {
  return `${summary.workId === activeWorkId ? "• " : ""}${summary.unit}/${summary.hat} — ${summary.label} (${humanizeStage(summary.stage)})`;
}
