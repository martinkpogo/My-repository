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

// Every field WorkState persists today. Removing or renaming one fails the
// first test below; ADDING one is fine (append it here when you do).
const PERSISTED_FIELDS = [
  "actionName", "awaiting", "bdOpportunity", "blockedReason", "callNotes", "candidateEntities", "candidateMatters", "chatId",
  "commercialEvidence", "commercialValueEvidenceBlock", "commercialValueEvidenceError", "createdAt", "enquiryText", "entityDraft",
  "entityId", "entityName", "entityToken", "entryType", "externalOperations", "financeJudgmentContext", "financeThreadId", "handoffId",
  "hat", "investmentToleranceContext", "marketingDraft", "marketingTaskText", "matterDraft", "matterId", "matterIdUnresolved",
  "matterName", "matterToken", "measurementBaseline", "pendingActionSummary", "pendingApproval", "pendingBDDevelop", "pendingBDHandoff",
  "pendingBDNextMove", "pendingGoogleAction", "pendingHandoffAutoCheck", "pendingLeadOpportunity", "pendingPaidMediaAction",
  "pendingProposalDocClarification", "pendingSalesProposalRevision", "pendingSmokeSelection", "pendingStrategyApproval",
  "pendingStrategyHandoff", "pendingStrategyRefinement", "pendingTransition", "proposalApprovalCycle", "proposalDraft",
  "proposalRevisionCount", "proposedIntervention", "qualification", "quote", "salesProposal", "stage", "strategyApprovalState",
  "strategyContext", "strategyDiagnosis", "strategyDiscussion", "strategyProposal", "strategyProposalHistory",
  "strategyProposalTokenSafety", "strategyQuestion", "strategySkillCycleUnavailable", "strategySkillCycleUnavailableCause",
  "strategySkillFindings", "strategySourceBoundaryAttestation", "threadId", "unit", "updatedAt", "valueEvidenceFactSupplied", "workId",
  "workStatus", "workStatusMessageId",
];

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
    workId: "w-strategy-1", chatId: 1, unit: "Strategy", hat: "Strategy Analyst", actionName: "diagnose", stage: "strategy_proposal_review",
    awaiting: "strategy_feedback", entityToken: "E-30", matterToken: "MAT-30", matterId: "m-30", handoffId: "h-1",
    strategyQuestion: "q", strategyContext: "c", strategyApprovalState: "pending", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z",
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
    workId: "w-lead-1", chatId: 1, unit: "Sales", hat: "Lead Generation Specialist", actionName: "record_lead", stage: "awaiting_lead_approval",
    pendingLeadOpportunity: { organisation: "Acme", evidence: "e", reason: "r", sourceUrl: "https://example.com" },
    pendingActionSummary: { label: "Opportunity: Acme", message: "m", buttons: [], createdAt: "2026-10-12T10:00:00.000Z" },
    createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z",
  },
  "Marketing parked on draft feedback": {
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
