import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { trimSessionsIndex, shouldAlertPendingApprovalBacklog, deriveSessionLabel, safeTokenRef, sanitizeSessionSummary, sanitizeSessionsIndex } from "./sessionsIndex";
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

// ---------------------------------------------------------------------------
// sessions_index value-level data boundary: the stored label may only ever
// be a canonical token reference or fixed generic metadata (the value this
// key carries may fall back to Turso, so identity/content must not be in it).
// ---------------------------------------------------------------------------

test("safeTokenRef accepts only the canonical ENT-/MAT- token shape -- names and free text are discarded", () => {
  assert.equal(safeTokenRef("ENT-7"), "ENT-7");
  assert.equal(safeTokenRef("MAT-20"), "MAT-20");
  assert.equal(safeTokenRef(" HO-64 "), "HO-64"); // handoff-style token, trimmed
  assert.equal(safeTokenRef("Acme Corporation"), undefined);
  assert.equal(safeTokenRef("John Smith"), undefined);
  assert.equal(safeTokenRef("New Entity: ACME"), undefined);
  assert.equal(safeTokenRef(""), undefined);
  assert.equal(safeTokenRef(undefined), undefined);
  assert.equal(safeTokenRef("mat-20"), undefined); // case matters -- non-canonical shapes are dropped
});

test("deriveSessionLabel: token references when present, otherwise fixed generic metadata only", () => {
  assert.equal(deriveSessionLabel({ entityToken: "ENT-7", matterToken: "MAT-20" }), "ENT-7 · MAT-20");
  assert.equal(deriveSessionLabel({ matterToken: "MAT-20" }), "MAT-20");
  assert.equal(deriveSessionLabel({ hasPendingApproval: true }), "pending approval");
  assert.equal(deriveSessionLabel({ hasPendingApproval: false }), "(new)");
  assert.equal(deriveSessionLabel({}), "(new)");
  // A malformed "token" cannot smuggle text into the label vocabulary.
  assert.equal(deriveSessionLabel({ entityToken: "Acme Corp" }), "(new)");
});

test("sessions_index leak-proof: sanitizing a hostile legacy index leaves no names, enquiry text or approval labels in the stored JSON", () => {
  const hostile: SessionSummary[] = [
    {
      workId: "w-1",
      unit: "Sales",
      hat: "Lead Generation Specialist",
      stage: "awaiting_entity_creation_approval",
      // Pre-contract label: raw enquiry slice + AI-extracted name
      label: "New Entity: John Smith for ACME Corp -- renewal enquiry",
      updatedAt: new Date().toISOString(),
      hasPendingApproval: true,
      matterId: "matter-page-1",
    },
    {
      workId: "w-2",
      unit: "Sales",
      hat: "Account Executive",
      stage: "awaiting_qualification_approval",
      label: "Lead→Prospect: ACME Corp",
      updatedAt: new Date().toISOString(),
      hasPendingApproval: true,
    },
    {
      workId: "w-3",
      stage: "new",
      label: "Opportunity: Globex Ltd -- inbound pricing question",
      updatedAt: new Date().toISOString(),
    },
  ];

  const sanitized = sanitizeSessionsIndex(hostile);
  const stored = JSON.stringify(sanitized);

  // The stored value (the exact bytes a kvPut of sessions_index would send)
  // must not contain any identity or content term from the legacy labels.
  for (const leak of ["John Smith", "ACME", "renewal enquiry", "Globex", "pricing question", "Lead→Prospect", "New Entity"]) {
    assert.equal(stored.includes(leak), false, `sessions_index must never store: ${leak}`);
  }

  // Entries survive (works without tokens -- e.g. no-token Matter work --
  // keep their slot in the index with generic metadata).
  assert.equal(sanitized.length, 3);
  assert.equal(sanitized[0].workId, "w-1");
  assert.equal(sanitized[0].matterId, "matter-page-1", "matterId resolution fields are preserved");
  assert.equal(sanitized[0].label, "pending approval");
  assert.equal(sanitized[1].label, "pending approval");
  assert.equal(sanitized[2].label, "(new)");

  // Token-carrying entries keep their safe reference as the label.
  const withTokens = sanitizeSessionSummary({ ...hostile[1], entityToken: "ENT-42", matterToken: "MAT-7" });
  assert.equal(withTokens.label, "ENT-42 · MAT-7");
  assert.equal(JSON.stringify(withTokens).includes("ENT-42"), true);

  // A non-canonical token field is dropped, never stored as-is.
  const poisoned = sanitizeSessionSummary({ ...hostile[2], entityToken: "John Smith" });
  assert.equal(poisoned.entityToken, undefined);
  assert.equal(poisoned.label, "(new)");
});

test("wiring contract: session.ts derives and sanitizes EVERY sessions_index save through sessionsIndex.ts (source scan)", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "session.ts"), "utf8");
  assert.match(source, /deriveSessionLabel\(/, "updateRegistry must derive the label through deriveSessionLabel");
  assert.match(source, /safeTokenRef\(state\.entityToken\)/, "the entity token must pass through safeTokenRef");
  assert.match(source, /sanitizeSessionsIndex\(combined\)/, "the WHOLE index (not just this Work's entry) must be sanitized on every save");
  assert.equal(
    /label:\s*state\.pendingActionSummary\?\.label/.test(source),
    false,
    "the free-text pendingActionSummary label must never be stored again",
  );
});
