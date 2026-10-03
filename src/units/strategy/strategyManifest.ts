import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
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
 * time. That entry point is therefore declared as ONE action, `diagnose`
 * ("write", requiresApproval: false), whose entryHandler calls
 * strategy.handleDirectRequest UNCHANGED, mirroring exactly how
 * marketingManifest.ts wraps runMarketingHat as a single opaque action.
 *
 * A SECOND action, `commit_diagnosis`, is declared alongside it to carry the
 * single gated effect Strategy performs -- creating the outbound Work Handoff
 * that commits an approved decision on another Unit's behalf. Both are
 * dispatched through this manifest and both resolve to the same
 * strategyAnalyst.ts entry point; they differ only in the authority their
 * governed writes are judged under. See the strategyAnalystActions doc
 * comment below for why that authority difference is load-bearing rather than
 * tidiness. Architect-approved.
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
 *
 * strategyAnalystHat.callbackHandlers declares strategyhandoff (the
 * outbound-Handoff approve/reject callback strategy.ts's own routing
 * branch sends) -- approval-callback dispatch mechanism (PRs #203-209),
 * migrated off session.ts's hardcoded switch case onto the generic
 * manifest lookup. handleStrategyHandoffApproval itself is unchanged.
 */
type StrategyAction = "diagnose" | "commit_diagnosis";

const STRATEGY_ANALYST_HAT_NAME = "Strategy Analyst";
const STRATEGY_ANALYST_SPECIALIZATION = "Strategic Assessment & Synthesis";

/**
 * Strategy declares TWO Actions, and the split is load-bearing rather than
 * tidiness.
 *
 * `diagnose` is the operation of diagnosing: reading the situation, advancing
 * the Matter's operational status to Commercial Development, and advancing the
 * inbound Handoff's own Pending -> Picked-up -> Held -> Closed progression. It
 * is UN-GATED, and that is a deliberate statement rather than an omission.
 * Those are execution bookkeeping on records this Work already owns; they are
 * not Martin's decisions, and they must not be made to wait on one. Gating
 * them would also be wrong in a way nothing would report: the Matter advance is
 * best-effort and its failure is swallowed with a logged error, so a
 * wrongly-gated pickup would quietly stop advancing Matter status while
 * appearing to succeed.
 *
 * `commit_diagnosis` is the operation that commits on Martin's behalf --
 * creating the outbound Work Handoff to Finance after an approved intervention
 * proposal, or to the responsible Unit after an approved diagnosis routing.
 * That is the only Strategy effect that creates something another Unit will
 * act on, and it is the only one gated by Martin's explicit approval.
 *
 * They are separate Actions rather than one Action with a per-target narrowing
 * because `requiresApproval` is action-level: an Action performing un-gated
 * bookkeeping alongside a privileged effect has to be split into the operation
 * that IS its privileged effect. (Both call sites were already reached only
 * after an approval callback had fired and consumed its staged approval, so
 * this changes the authority under which the write is judged, not the
 * conditions under which it happens.)
 */
const strategyAnalystActions: ActionDefinition<StrategyAction>[] = [
  {
    name: "diagnose",
    responsibility: "own_strategic_diagnosis",
    consequence: "write",
    requiresApproval: false,
    // Structural entry, exactly like Finance's `price`: Strategy's entry Action is resolved from the Work's
    // origin (a direct request or a Handoff addressed to this Unit) --
    // the former dispatchCowork Strategy branch hardcoded the same name.
    applicability: {
      mode: "any",
      conditions: [
        { source: "work", field: "origin", operator: "in", value: ["direct_request", "handoff_pickup"] },
        { source: "work", field: "requested_action", operator: "equals", value: "diagnose" },
      ],
    },
    description:
      "Diagnose a Matter/Entity situation (Symptom -> Problem -> Cause -> Constraint -> Consequence) and either develop a governed intervention proposal or route the diagnosis to the responsible Unit. Performs the Matter operational-status advance and the inbound Handoff's own lifecycle progression; commits nothing on another Unit's behalf.",
  },
  {
    name: "commit_diagnosis",
    responsibility: "own_strategic_diagnosis",
    consequence: "write",
    requiresApproval: true,
    // Performed only as this Work's lifecycle advances (after an approval
    // callback has staged the decision) -- never resolved as the Action a
    // Work is entered with, so an entry context resolves `diagnose` only
    // and never the gated one.
    applicability: {
      mode: "all",
      conditions: [{ source: "work", field: "origin", operator: "equals", value: "lifecycle_transition" }],
    },
    description:
      "Commit an approved Strategy decision as an outbound Work Handoff -- to Finance after an approved intervention proposal, or to the responsible Unit after an approved diagnosis routing. Martin's explicit approval is required: an approved diagnosis is not a routed diagnosis until this Action records it.",
  },
];

async function strategyEntryHandler(env: Env, state: WorkState, _actionName: StrategyAction, text: string): Promise<WorkState> {
  return strategy.handleDirectRequest(env, state, text);
}

/** Strategy declares no "read" action -- both its Actions are "write" (a WorkSession always exists by the time this manifest is consulted). Fails closed rather than silently no-opping. */
async function strategyReadHandler(_env: Env, actionName: StrategyAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- Strategy Analyst only declares "diagnose" and "commit_diagnosis" (both "write").`);
}

// The callback_data prefix strategy.ts's own outbound-handoff proposal
// buttons are built with (see the "strategyhandoff:<workId>:approve"
// literal in strategyAnalyst.ts). Migrates onto HatManifest.callbackHandlers
// same as Business Development's/Sales's/Marketing's prefixes
// (PRs #203-209) -- no relocation needed here, unlike Marketing: this
// manifest already imports the whole strategyAnalyst.ts namespace
// (`* as strategy`), and strategyAnalyst.ts never imports back from this
// file, so there's no circular-import risk to design around.
export const STRATEGY_HANDOFF_CALLBACK_PREFIX = "strategyhandoff" as const;

const strategyAnalystCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [STRATEGY_HANDOFF_CALLBACK_PREFIX]: strategy.handleStrategyHandoffApproval,
};

const strategyAnalystHat: HatManifest<StrategyAction> = {
  name: STRATEGY_ANALYST_HAT_NAME,
  specialization: STRATEGY_ANALYST_SPECIALIZATION,
  responsibility:
    "Diagnose Entity/Matter situations for ENIG using a disciplined Symptom -> Problem -> Cause -> Constraint -> Consequence model, develop governed intervention proposals once causation is adequately supported, and route diagnoses that need a different Unit's work rather than an intervention. Never treats an intervention or downstream Handoff as final without Martin's explicit approval.",
  actions: strategyAnalystActions,
  responsibilityId: "own_strategic_diagnosis",
  readHandler: strategyReadHandler,
  entryHandler: strategyEntryHandler,
  awaitingHandlers: {},
  callbackHandlers: strategyAnalystCallbackHandlers,
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
 * Strategy's manifest-level dispatch helper for its chat-triggered entry
 * point: routes through the manifest instead of calling
 * strategy.handleDirectRequest directly, making the manifest the actual
 * dispatch surface rather than a decorative parallel structure. Strategy
 * has only one Hat, so no Hat interpretation is needed here; it declares
 * two Actions, but both resolve to this one entry point, so the dispatch
 * below names the un-gated one.
 */
export async function dispatchStrategyHat(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const hat = strategyManifest.hats[STRATEGY_ANALYST_HAT_NAME];
  return hat.entryHandler(env, state, "diagnose", text);
}
