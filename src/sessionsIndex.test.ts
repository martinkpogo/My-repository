import { test } from "node:test";
import assert from "node:assert/strict";
import { trimSessionsIndex, shouldAlertPendingApprovalBacklog } from "./sessionsIndex";
import type { SessionSummary } from "./types";

function summary(workId: string, hasPendingApproval: boolean): SessionSummary {
  return {
    workId,
    unit: "Sales",
    hat: "Lead Generation Specialist",
    stage: "new",
    label: workId,
    updatedAt: new Date().toISOString(),
    hasPendingApproval,
  };
}

test("trimSessionsIndex keeps all entries when both pools are under their caps", () => {
  const combined = [summary("g1", false), summary("g2", false), summary("p1", true), summary("p2", true)];
  const kept = trimSessionsIndex(combined);
  assert.strictEqual(kept.length, 4);
  assert.ok(kept.some((s) => s.workId === "p1"));
  assert.ok(kept.some((s) => s.workId === "p2"));
});

test("trimSessionsIndex caps the general pool at 50 without touching pending entries", () => {
  const general = Array.from({ length: 60 }, (_, i) => summary(`g${i}`, false));
  const pending = [summary("p1", true)];
  const kept = trimSessionsIndex([...general, ...pending]);

  const keptGeneral = kept.filter((s) => !s.hasPendingApproval);
  const keptPending = kept.filter((s) => s.hasPendingApproval);
  assert.strictEqual(keptGeneral.length, 50, "general pool must be capped at 50");
  assert.strictEqual(keptPending.length, 1, "the single pending entry must never be evicted by general-pool churn");
  assert.ok(keptPending[0].workId === "p1");
  // The oldest general entries (g0..g9) should have been trimmed, keeping the most recent 50.
  assert.ok(!keptGeneral.some((s) => s.workId === "g0"));
  assert.ok(keptGeneral.some((s) => s.workId === "g59"));
});

test("trimSessionsIndex caps the pending pool at 100 -- bounded, not 'never evict'", () => {
  const pending = Array.from({ length: 110 }, (_, i) => summary(`p${i}`, true));
  const kept = trimSessionsIndex(pending);
  assert.strictEqual(kept.length, 100, "pending pool must be bounded, even though its allowance is much larger than the general pool");
  // Oldest pending entries fall out first; most recent are retained.
  assert.ok(!kept.some((s) => s.workId === "p0"));
  assert.ok(kept.some((s) => s.workId === "p109"));
});

test("trimSessionsIndex total size never exceeds pending cap + general cap regardless of input size", () => {
  const huge = Array.from({ length: 500 }, (_, i) => summary(`x${i}`, i % 3 === 0));
  const kept = trimSessionsIndex(huge);
  assert.ok(kept.length <= 150, `expected bounded output, got ${kept.length}`);
});

test("shouldAlertPendingApprovalBacklog stays silent below the pending cap", () => {
  assert.strictEqual(shouldAlertPendingApprovalBacklog(99, null, Date.now()), false);
});

test("shouldAlertPendingApprovalBacklog fires the first time the cap is reached (no prior alert)", () => {
  assert.strictEqual(shouldAlertPendingApprovalBacklog(100, null, Date.now()), true);
});

test("shouldAlertPendingApprovalBacklog is rate-limited -- stays silent within the cooldown window", () => {
  const now = Date.now();
  const fiveMinutesAgo = String(now - 5 * 60 * 1000);
  assert.strictEqual(shouldAlertPendingApprovalBacklog(120, fiveMinutesAgo, now), false);
});

test("shouldAlertPendingApprovalBacklog fires again once the cooldown window has elapsed", () => {
  const now = Date.now();
  const overThirtyMinutesAgo = String(now - 31 * 60 * 1000);
  assert.strictEqual(shouldAlertPendingApprovalBacklog(120, overThirtyMinutesAgo, now), true);
});
