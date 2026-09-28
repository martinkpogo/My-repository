import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
import * as finance from "./valueBasedPricingAssessor";

/**
 * Finance's Unit Registry manifest (ENIG Operating Model design doc,
 * "The Unit Registry") -- deliberately partial by design, mirroring
 * strategyManifest.ts/researchManifest.ts exactly. Finance has exactly
 * one Hat (Value-Based Pricing Assessor -- see hats/registry.ts's
 * VALUE_BASED_PRICING_ASSESSOR), so there is no Stage 1 Hat-ambiguity to
 * preserve. There is also no "which action" decision Martin's message
 * selects between -- handleDirectRequest is the only chat-triggered
 * entry, every time. So this manifest declares exactly one action, price
 * ("write", requiresApproval: true), whose entryHandler calls
 * finance.handleDirectRequest UNCHANGED -- the entire value-at-stake/
 * price-judgment/quote-approval chain inside it is untouched, zero
 * behavioral changes.
 *
 * Finance's OTHER entry point, handlePickup (Handoff-originated, called
 * from session.ts's own dedicated method), is deliberately left OUTSIDE
 * this manifest -- same reasoning as Strategy's/R&I's own handlePickup:
 * it resolves Handoff-specific business context
 * (resolveHandoffBusinessContext) that handleDirectRequest's own
 * free-text Matter-token resolution has no equivalent for, so wrapping
 * it through this manifest's entryHandler would be semantically wrong.
 *
 * valueBasedPricingAssessorHat.callbackHandlers declares quote (the
 * quote approve/reject callback handleQuoteApproval resolves) --
 * approval-callback dispatch mechanism (PRs #203-211), the first prefix
 * migrated for Finance now that a manifest exists to attach it to.
 *
 * intakeClassificationTaskId/actionClassificationTaskId reuse
 * finance.quote_judgment purely as a type-satisfying placeholder --
 * required by UnitManifest's shape, but never actually invoked through
 * this manifest: dispatchCowork's Finance branch (unchanged) never calls
 * resolveUnitRequest for Finance at all, and even if it did, resolveHat's
 * single-Hat shortcut skips Stage 1 entirely. No new SemanticTaskId
 * registration or Architect review needed.
 */
type FinanceAction = "price";

const VALUE_BASED_PRICING_ASSESSOR_HAT_NAME = "Value-Based Pricing Assessor";

const valueBasedPricingAssessorActions: ActionDefinition<FinanceAction>[] = [
  {
    name: "price",
    consequence: "write",
    requiresApproval: true,
    description:
      "Assess value-at-stake and produce a governed price judgment for a Matter, grounded only in verifiable evidence -- always gated on Martin's explicit approval before any quote is treated as final.",
  },
];

async function financeEntryHandler(env: Env, state: WorkState, _actionName: FinanceAction, text: string): Promise<WorkState> {
  return finance.handleDirectRequest(env, state, text);
}

/** Finance declares no "read" action -- price is always "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function financeReadHandler(_env: Env, actionName: FinanceAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Value-Based Pricing Assessor only declares "price" ("write").`);
}

// The callback_data prefix finance.ts's own quote proposal buttons are
// built with (see the "quote:<workId>:approve" literal in
// valueBasedPricingAssessor.ts). Migrates onto
// HatManifest.callbackHandlers same as every other Unit's prefixes so
// far (PRs #203-211) -- no relocation needed, this manifest already
// imports the whole valueBasedPricingAssessor.ts namespace
// (`* as finance`), and valueBasedPricingAssessor.ts never imports back.
export const QUOTE_CALLBACK_PREFIX = "quote" as const;

const valueBasedPricingAssessorCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [QUOTE_CALLBACK_PREFIX]: finance.handleQuoteApproval,
};

const valueBasedPricingAssessorHat: HatManifest<FinanceAction> = {
  name: VALUE_BASED_PRICING_ASSESSOR_HAT_NAME,
  specialization: "Value-Based Pricing",
  responsibility:
    "Assess the genuine value at stake for a Matter and produce a governed, evidence-grounded price judgment -- never inventing a value figure or evidence source not actually supplied or verifiable. Never treats a quote as final without Martin's explicit approval.",
  actions: valueBasedPricingAssessorActions,
  readHandler: financeReadHandler,
  entryHandler: financeEntryHandler,
  // Every one of Finance's own continuation states (quote_redo_reason,
  // finance_direct_request_matter, finance_direct_request_context, etc.)
  // remains a hardcoded case in session.ts's handleTextReply switch,
  // exactly as before this migration -- matching Strategy's/R&I's own
  // precedent. Only the entry point moves; no multi-turn flow changes.
  awaitingHandlers: {},
  callbackHandlers: valueBasedPricingAssessorCallbackHandlers,
};

export const financeManifest: UnitManifest = {
  unit: "Finance",
  hats: {
    [valueBasedPricingAssessorHat.name]: valueBasedPricingAssessorHat,
  },
  intakeClassificationTaskId: "finance.quote_judgment",
  intakeIntroLine: "You route incoming Finance requests for ENIG, to its Value-Based Pricing Assessor Hat.",
  actionClassificationTaskId: "finance.quote_judgment",
};

/**
 * The genuine runtime execution point for Finance's chat-triggered entry
 * point -- session.ts's handleFinanceRequest calls this instead of
 * finance.handleDirectRequest directly, making the manifest the actual
 * dispatch surface rather than a decorative parallel structure. Finance
 * has only one Hat/one action, so no Stage 1/2 resolution is needed here
 * -- mirrors dispatchStrategyHat/dispatchResearchHat exactly.
 */
export async function dispatchFinanceHat(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const hat = financeManifest.hats[VALUE_BASED_PRICING_ASSESSOR_HAT_NAME];
  return hat.entryHandler(env, state, "price", text);
}
