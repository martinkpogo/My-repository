import test from "node:test";
import assert from "node:assert";

import { resolveAwaitingHandler } from "./awaitingDispatch";
import * as sales from "./sales/salesExecutive";
import * as salesProposal from "./sales/tokenSafeProposal";
import * as finance from "./finance/valueBasedPricingAssessor";
import * as strategy from "./strategy/strategyAnalyst";
import { marketingManifest, handleMarketingFeedback, handleMarketingClarification } from "./marketing/marketingManifest";
import type { WorkState } from "../types";

type AwaitedState = Pick<WorkState, "unit" | "hat" | "awaiting">;

/**
 * Covers WP6's dispatch contract: handleTextReply no longer holds a
 * hardcoded `switch (state.awaiting)` -- every continuation state is
 * declared on the owning Hat's awaitingHandlers in its Unit's manifest, and
 * resolveAwaitingHandler is the one lookup. For each awaiting state this
 * file proves (a) a reply reaches the EXACT handler function the old switch
 * case called (identity -- same body, same arguments), (b) the Skill-set
 * shape is unchanged: Skill-aware handlers keep their 4th skills parameter,
 * handlers that never took skills keep their exact 3-param signature and
 * simply ignore the argument the shared runUnderRecordedSkills wrapper
 * passes, and (c) states no Hat declares fail closed to undefined, which is
 * handleTextReply's unchanged "This work item isn't awaiting a reply right
 * now. Use /sessions to switch context." signal.
 */

const SALES_HAT = "Sales Executive";
const FINANCE_HAT = "Value-Based Pricing Assessor";
const STRATEGY_HAT = "Strategy Analyst";
const BD_GAP_STATE = "bd_opportunity_evidence_gap";

interface Resolution {
  label: string;
  state: AwaitedState;
  /** Expected handler identity -- the exact function the old switch case called. */
  handler: (...args: never[]) => Promise<WorkState>;
  /** Number of declared parameters: 4 = Skill-aware (takes skills), 3 = ignores the wrapper's skills argument. */
  arity: 3 | 4;
}

const RESOLUTIONS: Resolution[] = [
  // --- Sales (formerly five switch cases) ---
  { label: "Sales/call_notes", state: { unit: "Sales", hat: SALES_HAT, awaiting: "call_notes" }, handler: sales.handleCallNotes, arity: 3 },
  { label: "Sales/intervention", state: { unit: "Sales", hat: SALES_HAT, awaiting: "intervention" }, handler: sales.handleInterventionText, arity: 3 },
  { label: "Sales/matter_redo_reason", state: { unit: "Sales", hat: SALES_HAT, awaiting: "matter_redo_reason" }, handler: sales.handleMatterRedoReason, arity: 3 },
  { label: "Sales/entity_redo_reason", state: { unit: "Sales", hat: SALES_HAT, awaiting: "entity_redo_reason" }, handler: sales.handleEntityRedoReason, arity: 3 },
  { label: "Sales/sales_proposal_revision", state: { unit: "Sales", hat: SALES_HAT, awaiting: "sales_proposal_revision" }, handler: salesProposal.handleSalesProposalRevisionText, arity: 3 },

  // --- Finance (formerly four switch cases) ---
  { label: "Finance/value_context_more", state: { unit: "Finance", hat: FINANCE_HAT, awaiting: "value_context_more" }, handler: finance.handleValueContextClarification, arity: 3 },
  { label: "Finance/quote_redo_reason", state: { unit: "Finance", hat: FINANCE_HAT, awaiting: "quote_redo_reason" }, handler: finance.handleQuoteRedoReason, arity: 3 },
  { label: "Finance/finance_direct_request_matter", state: { unit: "Finance", hat: FINANCE_HAT, awaiting: "finance_direct_request_matter" }, handler: finance.handleDirectRequestClarification, arity: 3 },
  { label: "Finance/finance_direct_request_context", state: { unit: "Finance", hat: FINANCE_HAT, awaiting: "finance_direct_request_context" }, handler: finance.handleDirectRequestContext, arity: 3 },

  // --- Strategy (formerly four switch cases; the three Skill-aware cases
  //     were already wrapped in runUnderRecordedSkills, exactly as the
  //     generic path wraps them today) ---
  { label: "Strategy/strategy_clarification", state: { unit: "Strategy", hat: STRATEGY_HAT, awaiting: "strategy_clarification" }, handler: strategy.handleStrategyClarification, arity: 4 },
  { label: "Strategy/strategy_direct_request_matter", state: { unit: "Strategy", hat: STRATEGY_HAT, awaiting: "strategy_direct_request_matter" }, handler: strategy.handleDirectRequestClarification, arity: 4 },
  { label: "Strategy/strategy_feedback", state: { unit: "Strategy", hat: STRATEGY_HAT, awaiting: "strategy_feedback" }, handler: strategy.handleStrategyFeedback, arity: 4 },
  { label: "Strategy/strategy_refinement_reason", state: { unit: "Strategy", hat: STRATEGY_HAT, awaiting: "strategy_refinement_reason" }, handler: strategy.handleStrategyRefinement, arity: 3 },
];

test("resolveAwaitingHandler: every awaiting state resolves to the exact handler the old switch case called", () => {
  assert.strictEqual(RESOLUTIONS.length, 13, "13 non-Marketing awaiting states migrated (5 Sales + 4 Finance + 4 Strategy)");
  for (const { label, state, handler, arity } of RESOLUTIONS) {
    const resolved = resolveAwaitingHandler(state);
    assert.strictEqual(resolved, handler, `${label}: must resolve to the same handler function, byte-identical arguments`);
    assert.strictEqual(resolved?.length, arity, `${label}: signature preserved (${arity === 4 ? "Skill-aware, takes skills" : "never took skills -- ignores the wrapper's skills argument exactly as the old direct call did"})`);
  }
});

test("resolveAwaitingHandler: Marketing's two continuation states resolve on ALL five Hats (the old switch never consulted state.hat)", () => {
  const hatNames = Object.keys(marketingManifest.hats);
  assert.strictEqual(hatNames.length, 5, "Marketing registers its awaiting states uniformly across its five Hats");
  for (const hatName of hatNames) {
    assert.strictEqual(
      resolveAwaitingHandler({ unit: "Marketing", hat: hatName, awaiting: "marketing_feedback" }),
      handleMarketingFeedback,
      `${hatName}/marketing_feedback identity`,
    );
    assert.strictEqual(
      resolveAwaitingHandler({ unit: "Marketing", hat: hatName, awaiting: "marketing_clarification" }),
      handleMarketingClarification,
      `${hatName}/marketing_clarification identity`,
    );
  }
});

test("resolveAwaitingHandler: Business Development's evidence-gap state still resolves on all three BD Hats (pre-existing manifest entries, unchanged by WP6)", () => {
  for (const hatName of ["Business Development Manager", "Partnerships Manager", "Growth & Market Development Manager"]) {
    const resolved = resolveAwaitingHandler({ unit: "Business Development", hat: hatName, awaiting: BD_GAP_STATE });
    assert.strictEqual(typeof resolved, "function", `${hatName}/${BD_GAP_STATE} must keep resolving to its resume handler`);
    assert.strictEqual(resolved?.length, 4, `${hatName}: BD resume handlers are Skill-aware`);
  }
});

test("resolveAwaitingHandler: states no Hat declares fail closed to undefined -- the unchanged 'not awaiting' fallback signal", () => {
  // Declared awaiting values with no handler anywhere (behavior unchanged:
  // these already fell through to the fallback message before WP6).
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: SALES_HAT, awaiting: "matter_pick" }), undefined, "matter_pick has never had a handler -- falls to the fallback message, not a silent no-op");
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: SALES_HAT, awaiting: "entity_pick" }), undefined, "entity_pick has never had a handler");
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: SALES_HAT, awaiting: "proposal_feedback" }), undefined, "proposal_feedback has never had a handler");
  // A state that exists, looked up under a Hat that never declared it.
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: "Lead Generation Specialist", awaiting: "call_notes" }), undefined, "Lead Generation Specialist deliberately has no awaiting flow");
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: FINANCE_HAT, awaiting: "quote_redo_reason" }), undefined, "a Hat of a different Unit must not resolve");
  // Marketing's placeholder direct-entry WorkState.hat (router's `decision.hat ?? "Marketing"`): the path fails closed at recordWorkAction
  // before any awaiting state can be set, and if it were ever observed here it must fall to the fallback, never a wrong handler.
  assert.strictEqual(resolveAwaitingHandler({ unit: "Marketing", hat: "Marketing", awaiting: "marketing_clarification" }), undefined, "the placeholder 'Marketing' hat is not a registered Hat");
  // Unregistered Unit, missing fields.
  assert.strictEqual(resolveAwaitingHandler({ unit: "Creative & Design", hat: "whatever", awaiting: "call_notes" }), undefined, "a Unit with no manifest resolves nothing");
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: SALES_HAT, awaiting: undefined }), undefined, "not awaiting anything");
  assert.strictEqual(resolveAwaitingHandler({ unit: "Sales", hat: undefined, awaiting: "call_notes" }), undefined, "no Hat resolved");
  assert.strictEqual(resolveAwaitingHandler({ unit: undefined, hat: undefined, awaiting: undefined }), undefined, "empty state");
});
