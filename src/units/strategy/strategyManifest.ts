import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest } from "../unitManifest";
import * as strategy from "./strategyAnalyst";

/**
 * Strategy's Unit Registry manifest (ENIG Operating Model design doc,
 * "The Unit Registry") -- like marketingManifest.ts, deliberately partial
 * by design: it covers only the single chat-triggered entry point
 * (handleDirectRequest), not Strategy's full operating model.
 *
 * Strategy has exactly one Hat (Strategy Analyst -- see
 * hats/registry.ts's STRATEGY_ANALYST), so there is no Stage 1 Hat-
 * ambiguity to preserve (unlike Marketing's 5 Hats). But unlike Marketing,
 * Strategy has no single free-form "decide what to do" call either -- its
 * real pipeline is a fixed sequence (diagnose -> causation-discipline
 * check -> develop a proposal or route the diagnosis elsewhere ->
 * completeness check -> Approve/Refine/Reject), spanning three
 * independently-classified AI calls (strategy.diagnosis,
 * strategy.handoff_routing, strategy.proposal_drafting) plus two
 * deterministic post-checks plus a separate downstream propose-then-
 * approve Handoff gate. There is no "which action" decision Martin's
 * message selects between -- handleDirectRequest is the only entry, every
 * time. So this manifest declares exactly one action, diagnose ("write",
 * requiresApproval: true), whose entryHandler calls
 * strategy.handleDirectRequest UNCHANGED -- the entire diagnosis/
 * proposal/approval chain inside it is untouched, zero behavioral
 * changes, mirroring exactly how marketingManifest.ts wraps
 * runMarketingHat as a single opaque action.
 *
 * Strategy's OTHER entry point, handlePickup (Handoff-originated, called
 * from checkHandoffs.ts's cron discovery via session.ts's
 * runStrategyPickup), is deliberately left OUTSIDE this manifest --
 * unlike Marketing's handleHandoffPickup, which already funneled through
 * the exact same shared runMarketingHat that handleMarketingIntake used
 * (making the substitution trivial), Strategy's handlePickup calls
 * runDiagnosis directly with Handoff-specific context construction
 * (resolveStrategyHandoffContext, claimPendingHandoff) that
 * handleDirectRequest's own Matter-token-from-free-text resolution has no
 * equivalent for. Wrapping handlePickup through this manifest's
 * entryHandler would mean calling handleDirectRequest from a Handoff
 * pickup, which is semantically wrong -- so handlePickup keeps calling
 * into strategyAnalyst.ts directly, entirely independent of dispatch,
 * exactly as before.
 *
 * intakeClassificationTaskId/actionClassificationTaskId reuse
 * strategy.diagnosis purely as a type-satisfying placeholder -- required
 * by UnitManifest's shape, but never actually invoked through this
 * manifest: dispatchCowork's Strategy branch (unchanged) never calls
 * resolveUnitRequest for Strategy at all (mirroring Marketing's own
 * choice), and even if it did, resolveHat's single-Hat shortcut skips
 * Stage 1 entirely. No new SemanticTaskId registration or Architect
 * review needed.
 */
type StrategyAction = "diagnose";

const STRATEGY_ANALYST_HAT_NAME = "Strategy Analyst";
const STRATEGY_ANALYST_SPECIALIZATION = "Strategic Assessment & Synthesis";

const strategyAnalystActions: ActionDefinition<StrategyAction>[] = [
  {
    name: "diagnose",
    consequence: "write",
    requiresApproval: true,
    description:
      "Diagnose a Matter/Entity situation (Symptom -> Problem -> Cause -> Constraint -> Consequence) and either develop a governed intervention proposal or route the diagnosis to the responsible Unit -- always gated on Martin's explicit approval (Approve/Refine/Reject) before any intervention or Handoff is treated as final.",
  },
];

async function strategyEntryHandler(env: Env, state: WorkState, _actionName: StrategyAction, text: string): Promise<WorkState> {
  return strategy.handleDirectRequest(env, state, text);
}

/** Strategy declares no "read" action -- diagnose is always "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function strategyReadHandler(_env: Env, actionName: StrategyAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Strategy Analyst only declares "diagnose" ("write").`);
}

const strategyAnalystHat: HatManifest<StrategyAction> = {
  name: STRATEGY_ANALYST_HAT_NAME,
  specialization: STRATEGY_ANALYST_SPECIALIZATION,
  responsibility:
    "Diagnose Entity/Matter situations for ENIG using a disciplined Symptom -> Problem -> Cause -> Constraint -> Consequence model, develop governed intervention proposals once causation is adequately supported, and route diagnoses that need a different Unit's work rather than an intervention. Never treats an intervention or downstream Handoff as final without Martin's explicit approval.",
  actions: strategyAnalystActions,
  readHandler: strategyReadHandler,
  entryHandler: strategyEntryHandler,
  awaitingHandlers: {},
};

export const strategyManifest: UnitManifest = {
  unit: "Strategy",
  hats: {
    [strategyAnalystHat.name]: strategyAnalystHat,
  },
  intakeClassificationTaskId: "strategy.diagnosis",
  intakeIntroLine: "You route incoming Strategy requests for ENIG, to its Strategy Analyst Hat.",
  actionClassificationTaskId: "strategy.diagnosis",
};

/**
 * The genuine runtime execution point for Strategy's chat-triggered
 * entry point -- session.ts's handleStrategyRequest calls this instead of
 * strategy.handleDirectRequest directly, making the manifest the actual
 * dispatch surface rather than a decorative parallel structure. Strategy
 * has only one Hat/one action, so no Stage 1/2 resolution is needed here.
 */
export async function dispatchStrategyHat(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const hat = strategyManifest.hats[STRATEGY_ANALYST_HAT_NAME];
  return hat.entryHandler(env, state, "diagnose", text);
}
