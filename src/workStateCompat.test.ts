import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkState } from "./types";
import { findCallbackPrefixOwner, findUnitManifest } from "./units/registry";
import { findCallbackHandler } from "./units/unitManifest";
import { resolveAwaitingHandler } from "./units/awaitingDispatch";
import { workSessionContext } from "./access";
import { isTerminalWorkStage } from "./matterContinuation";
import { deriveSessionLabel } from "./sessionsIndex";
import { migrateWorkState } from "./workStateMigration";

/**
 * Saved-Work compatibility contract.
 *
 * A Work is persisted in its Durable Object as a WorkState and can sit at an
 * approval gate for days. Whatever shape it was saved in must still be
 * readable after any later refactor -- a rename or removal would strand
 * every in-flight Work. This file pins that, ahead of the decoupling steps
 * that will reorganize WorkState (per-Unit namespaces): it fails if a
 * persisted field disappears or a Hat stops declaring a continuation or
 * button an in-flight Work could be waiting on. A deliberate migration must
 * keep reading the old shape (and update this contract in the same change).
 */

// Every top-level field WorkState persists today. Removing or renaming one
// fails the first test below; ADDING one is fine (append it here when you do).
//
// Unit-specific state lives in per-Unit slices (`marketing`, `strategy`, `bd`,
// `finance`, `sales`): a DELIBERATE migration (Marketing 2026-10-13, then
// Strategy, Business Development, Finance and Sales the same day), not a
// stranding -- each Unit's migrateWorkState hook reads a Work saved with the
// old loose fields into its slice on load (see LEGACY_FIELDS and the "Legacy
// shape" tests below), so this list tracks the CURRENT shape and the hooks are
// what keep every old shape readable. Sales's retired qualification-flow
// fields (callNotes, qualification, proposedIntervention, enquiryText,
// commercialEvidence, ...) stay loose until that retired path is removed.
const PERSISTED_FIELDS = [
  "actionName", "awaiting", "bd", "blockedReason", "callNotes", "candidateEntities", "candidateMatters", "chatId", "commercialEvidence",
  "createdAt", "enquiryText", "entityDraft", "entityId", "entityName", "entityToken", "entryType", "externalOperations", "finance",
  "handoffId", "hat", "investmentToleranceContext", "marketing", "matterDraft", "matterId", "matterIdUnresolved", "matterName",
  "matterToken", "measurementBaseline", "pendingActionSummary", "pendingApproval", "pendingGoogleAction", "pendingHandoffAutoCheck",
  "pendingSmokeSelection", "proposalDraft", "proposalRevisionCount", "proposedIntervention", "qualification", "sales", "stage",
  "strategy", "threadId", "unit", "updatedAt", "workId", "workStatus", "workStatusMessageId",
];

// Every loose field that USED to be persisted, and the slice field it is read
// into now. A Work saved before the move still carries the old name; the
// Unit's migration hook must keep turning it into the new one.
const LEGACY_FIELDS: Record<string, string> = {
  marketingTaskText: "marketing.taskText", marketingDraft: "marketing.draft", pendingTransition: "marketing.pendingTransition",
  pendingPaidMediaAction: "marketing.pendingPaidMediaAction",
  strategyQuestion: "strategy.question", strategyContext: "strategy.context", strategyDiagnosis: "strategy.diagnosis",
  strategySkillFindings: "strategy.skillFindings", strategySkillCycleUnavailable: "strategy.skillCycleUnavailable",
  strategySkillCycleUnavailableCause: "strategy.skillCycleUnavailableCause", pendingStrategyHandoff: "strategy.pendingHandoff",
  strategyProposal: "strategy.proposal", strategyProposalHistory: "strategy.proposalHistory", strategyApprovalState: "strategy.approvalState",
  pendingStrategyApproval: "strategy.pendingApproval", strategySourceBoundaryAttestation: "strategy.sourceBoundaryAttestation",
  strategyProposalTokenSafety: "strategy.proposalTokenSafety", pendingStrategyRefinement: "strategy.pendingRefinement",
  strategyDiscussion: "strategy.discussion", commercialValueEvidenceBlock: "strategy.commercialValueEvidenceBlock",
  commercialValueEvidenceError: "strategy.commercialValueEvidenceError",
  bdOpportunity: "bd.opportunity", pendingBDHandoff: "bd.pendingHandoff", pendingBDDevelop: "bd.pendingDevelop", pendingBDNextMove: "bd.pendingNextMove",
  financeThreadId: "finance.threadId", financeJudgmentContext: "finance.judgmentContext",
  valueEvidenceFactSupplied: "finance.valueEvidenceFactSupplied", quote: "finance.quote",
  salesProposal: "sales.proposal", pendingSalesProposalRevision: "sales.pendingProposalRevision",
  pendingProposalDocClarification: "sales.pendingProposalDocClarification", proposalApprovalCycle: "sales.proposalApprovalCycle",
  pendingLeadOpportunity: "sales.pendingLeadOpportunity",
};

function currentWorkStateFields(): string[] {
  const text = readFileSync(join(__dirname, "types.ts"), "utf8");
  const start = text.indexOf("export interface WorkState");
  const end = text.indexOf("\n}\n", start);
  return [...text.slice(start, end).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

test("Every field a saved WorkState can carry is still declared -- none removed or renamed without a migration", () => {
  const current = new Set(currentWorkStateFields());
  const missing = PERSISTED_FIELDS.filter((f) => !current.has(f));
  assert.deepStrictEqual(missing, [], `persisted WorkState field(s) gone: ${missing.join(", ")} -- in-flight Works saved with them would be stranded; keep reading the old shape`);
});

// Every continuation a Work can be parked on, and every button it can be
// waiting for a tap on, as (Unit, Hat, key). Removing one strands a Work.
const AWAITING: [string, string, string][] = [
  ["Business Development", "Business Development Manager", "bd_opportunity_evidence_gap"],
  ["Business Development", "Partnerships Manager", "bd_opportunity_evidence_gap"],
  ["Business Development", "Growth & Market Development Manager", "bd_opportunity_evidence_gap"],
  ["Sales", "Sales Executive", "call_notes"],
  ["Sales", "Sales Executive", "intervention"],
  ["Sales", "Sales Executive", "matter_redo_reason"],
  ["Sales", "Sales Executive", "entity_redo_reason"],
  ["Sales", "Sales Executive", "sales_proposal_revision"],
  ["Sales", "Sales Executive", "proposal_doc_clarification"],
  ["Marketing", "Marketing Strategist", "marketing_feedback"],
  ["Marketing", "Marketing Strategist", "marketing_clarification"],
  ["Strategy", "Strategy Analyst", "strategy_clarification"],
  ["Strategy", "Strategy Analyst", "strategy_direct_request_matter"],
  ["Strategy", "Strategy Analyst", "strategy_feedback"],
  ["Strategy", "Strategy Analyst", "strategy_refinement_reason"],
  ["Strategy", "Strategy Analyst", "strategy_discussion"],
  ["Finance", "Value-Based Pricing Assessor", "value_context_more"],
  ["Finance", "Value-Based Pricing Assessor", "quote_redo_reason"],
  ["Finance", "Value-Based Pricing Assessor", "finance_direct_request_matter"],
  ["Finance", "Value-Based Pricing Assessor", "finance_direct_request_context"],
];

const CALLBACKS: [string, string, string][] = [
  ["Business Development", "Business Development Manager", "bdopportunityhandoff"],
  ["Business Development", "Business Development Manager", "bddevelop"],
  ["Business Development", "Business Development Manager", "bdnextmove"],
  ["Sales", "Lead Generation Specialist", "leadopportunity"],
  ["Sales", "Sales Executive", "entitynew"],
  ["Sales", "Sales Executive", "matternew"],
  ["Sales", "Sales Executive", "qualify"],
  ["Sales", "Sales Executive", "entity"],
  ["Sales", "Sales Executive", "matter"],
  ["Sales", "Sales Executive", "salesprop"],
  ["Marketing", "Content Manager", "markettransition"],
  ["Marketing", "Content Manager", "marketdraft"],
  ["Marketing", "Content Manager", "marketpaid"],
  ["Strategy", "Strategy Analyst", "strategyhandoff"],
  ["Strategy", "Strategy Analyst", "sprop"],
  ["Finance", "Value-Based Pricing Assessor", "quote"],
];

test("Every continuation an in-flight Work can be parked on is still declared by its Hat", () => {
  for (const [unit, hat, awaiting] of AWAITING) {
    const handler = resolveAwaitingHandler({ unit: unit as WorkState["unit"], hat, awaiting: awaiting as WorkState["awaiting"] });
    assert.strictEqual(typeof handler, "function", `${unit}/${hat} no longer declares the "${awaiting}" continuation -- a Work parked on it could not be resumed`);
  }
});

test("Every approval button an in-flight Work can be waiting on still resolves to its owning Hat", () => {
  for (const [unit, hat, prefix] of CALLBACKS) {
    const manifest = findUnitManifest(unit as WorkState["unit"] & string);
    const declared = manifest?.hats[hat];
    assert.ok(declared, `${unit}/${hat} is no longer registered`);
    assert.strictEqual(typeof findCallbackHandler(prefix, declared), "function", `${unit}/${hat} no longer handles the "${prefix}" button -- a tap on an existing card would do nothing`);
    assert.strictEqual(findCallbackPrefixOwner(prefix)?.unit, unit, `"${prefix}" must still be owned by ${unit} (a stale button must never act on another Unit)`);
  }
});

// What storage actually holds: plain JSON (dates are strings, undefined
// fields are absent), shaped as each Unit writes it today.
const SAVED: Record<string, Record<string, unknown>> = {
  "Strategy parked on feedback to a proposal": {
    workId: "w-strategy-1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "strategy_proposal_review",
    awaiting: "strategy_feedback",
    entityToken: "E-30",
    matterToken: "MAT-30",
    matterId: "m-30",
    handoffId: "h-1",
    strategy: { question: "q", context: "c", approvalState: "pending" },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
  },
  "Finance parked on a quote redo reason": {
    workId: "w-fin-1", chatId: 1, unit: "Finance", hat: "Value-Based Pricing Assessor", actionName: "price", stage: "quote_pending_approval",
    awaiting: "quote_redo_reason", entityToken: "E-30", matterToken: "MAT-30", createdAt: "2026-10-03T10:00:00.000Z", updatedAt: "2026-10-03T11:00:00.000Z",
  },
  "Sales proposal waiting on a Doc clarification": {
    workId: "w-sales-1", chatId: 1, unit: "Sales", hat: "Sales Executive", actionName: "proposal_draft", stage: "proposal_pending_approval",
    awaiting: "proposal_doc_clarification", entityToken: "E-30", matterToken: "MAT-30", createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T11:00:00.000Z",
  },
  "Lead card waiting for a tap": {
    workId: "w-lead-1",
    chatId: 1,
    unit: "Sales",
    hat: "Lead Generation Specialist",
    actionName: "record_lead",
    stage: "awaiting_lead_approval",
    sales: { pendingLeadOpportunity: { organisation: "Acme", evidence: "e", reason: "r", sourceUrl: "https://example.com" } },
    pendingActionSummary: { label: "Opportunity: Acme", message: "m", buttons: [], createdAt: "2026-10-12T10:00:00.000Z" },
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
  },
  // Deliberately in the OLD (pre-2026-10-13) shape -- loose marketingTaskText/
  // marketingDraft, no `marketing` slice -- so this fixture also exercises
  // migrateWorkState below, not just today's shape.
  "Marketing parked on draft feedback (old saved shape)": {
    workId: "w-mkt-1", chatId: 1, unit: "Marketing", hat: "Content Manager", actionName: "handle_request", stage: "marketing_draft_review",
    awaiting: "marketing_feedback", marketingTaskText: "t", marketingDraft: "d", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T11:00:00.000Z",
  },
  "Business Development parked on an evidence gap": {
    workId: "w-bd-1", chatId: 1, unit: "Business Development", hat: "Business Development Manager", stage: "bd_evidence_gap",
    awaiting: "bd_opportunity_evidence_gap", createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T11:00:00.000Z",
  },
};

test("A Work saved in today's shape still reads through every generic path after a JSON round trip", () => {
  for (const [name, saved] of Object.entries(SAVED)) {
    const state = JSON.parse(JSON.stringify(saved)) as WorkState;
    // Dispatch: its continuation (if parked) still resolves to a handler.
    if (state.awaiting) assert.strictEqual(typeof resolveAwaitingHandler(state), "function", `${name}: its continuation must resolve`);
    // Access builds its context from the saved identity and recorded Action.
    const ctx = workSessionContext(state);
    assert.strictEqual(ctx.workId, state.workId, `${name}: Access context carries the Work id`);
    assert.strictEqual(ctx.unit, state.unit, `${name}: Access context carries the owning Unit`);
    if (state.actionName) assert.strictEqual(ctx.actionName, state.actionName, `${name}: Access context carries the recorded Action`);
    // Lifecycle: none of these in-flight stages is mistaken for terminal.
    assert.strictEqual(isTerminalWorkStage(state.stage), false, `${name}: an in-flight stage is not terminal`);
    // The sessions index label is derived from tokens or generic metadata only.
    assert.ok(deriveSessionLabel({ entityToken: state.entityToken, matterToken: state.matterToken, hasPendingApproval: !!state.pendingActionSummary }).length > 0);
    // The Hat that owns it is still registered.
    assert.ok(findUnitManifest(state.unit as NonNullable<WorkState["unit"]>)?.hats[state.hat as string], `${name}: its Hat is still registered`);
  }
});

test("Legacy shape: a Marketing Work saved before the `marketing` slice existed is migrated on load, and migration is idempotent", () => {
  const saved = JSON.parse(JSON.stringify(SAVED["Marketing parked on draft feedback (old saved shape)"])) as Record<string, unknown>;
  assert.ok(!("marketing" in saved), "fixture must genuinely be in the old shape to prove anything");

  const migrated = migrateWorkState(saved) as unknown as WorkState;
  assert.deepStrictEqual(migrated.marketing, { taskText: "t", draft: "d" }, "the loose fields are read into the slice");
  assert.strictEqual("marketingTaskText" in migrated, false, "the old loose field is removed, not merely shadowed");
  assert.strictEqual("marketingDraft" in migrated, false);
  assert.strictEqual(typeof resolveAwaitingHandler(migrated), "function", "dispatch still resolves its continuation after migration");

  // Running it again (the next load of an already-migrated Work) changes nothing.
  const again = migrateWorkState(JSON.parse(JSON.stringify(migrated)));
  assert.deepStrictEqual(again, JSON.parse(JSON.stringify(migrated)), "migrating an already-current Work is a no-op");
});

test("Legacy shape: EVERY field that used to be a loose WorkState field is still read into its Unit's slice, and none is left loose", () => {
  // A Work that carries every old loose field at once (a Handoff chain carries one Work across Units).
  const saved: Record<string, unknown> = { workId: "w-all", chatId: 1, stage: "strategy_blocked", unit: "Strategy", hat: "Strategy Analyst" };
  for (const oldName of Object.keys(LEGACY_FIELDS)) saved[oldName] = { sentinel: oldName };

  const migrated = migrateWorkState(JSON.parse(JSON.stringify(saved))) as Record<string, unknown>;

  for (const [oldName, target] of Object.entries(LEGACY_FIELDS)) {
    const [slice, field] = target.split(".");
    assert.strictEqual(oldName in migrated, false, `${oldName} must not stay loose after migration`);
    assert.deepStrictEqual(
      (migrated[slice] as Record<string, unknown> | undefined)?.[field],
      { sentinel: oldName },
      `${oldName} must be read into ${target} -- a Work saved with it would otherwise lose that state`,
    );
  }
  // The generic fields are untouched.
  assert.strictEqual(migrated.workId, "w-all");
  assert.strictEqual(migrated.stage, "strategy_blocked");

  // Idempotent: loading an already-migrated Work again changes nothing.
  const again = migrateWorkState(JSON.parse(JSON.stringify(migrated)));
  assert.deepStrictEqual(again, JSON.parse(JSON.stringify(migrated)));
});

test("Legacy shape: a value already in a slice is never overwritten by a stale loose field", () => {
  const saved = { workId: "w-1", strategyContext: "stale loose value", strategy: { context: "current slice value" } };
  const migrated = migrateWorkState(JSON.parse(JSON.stringify(saved))) as unknown as { strategy: { context: string }; strategyContext?: string };
  assert.strictEqual(migrated.strategy.context, "current slice value");
  assert.strictEqual("strategyContext" in migrated, false, "the stale loose copy is dropped, not left behind");
});
