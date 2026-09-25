import type { Env, WorkState } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { HatManifest, UnitManifest } from "../unitManifest";
import type { MarketingHatDefinition, MarketingHatName } from "../../hats/types";
import { MARKETING_HAT_REGISTRY, isMarketingHat } from "../../hats/registry";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";

/**
 * Marketing's Unit Registry manifest (ENIG Operating Model design doc,
 * "The Unit Registry") -- deliberately partial, by design, not by
 * oversight. Unlike Business Development (built from scratch on this
 * pattern) or Sales's Lead Generation Specialist (a single existing
 * action wrapped as-is), Marketing already has real, live, actively-used
 * Stage 1/2 routing logic in src/hats/executionEngine.ts:
 * classifyCandidateHats (Stage 1: which Hat) + resolveMarketingCandidateRelationships
 * (Stage 2: deterministic relationship-based tie-breaking across multiple
 * valid candidates, backed by 5 registered relationship IDs -- see
 * relationships.ts/relationships.test.ts).
 *
 * That Stage 2 has no equivalent in the generic manifest dispatch
 * (unitManifest.ts's resolveHat only supports "exactly one candidate, or
 * ambiguous" -- it cannot express relationship-based tie-breaking across
 * several valid candidates). Forcing Marketing's real routing onto the
 * generic resolver would silently replace deterministic relationship
 * resolution with weaker ambiguity-by-default behavior for an
 * already-live, actively-used Unit with zero existing test coverage of
 * its actual decision logic -- a real regression risk, not merely a
 * cosmetic one. Per Architect/Martin's explicit direction: "manifest-based
 * should standardize the contract, not require every Unit to have
 * identical routing semantics."
 *
 * So this manifest covers ONLY what happens once Marketing's own Stage
 * 1/2 (executionEngine.ts's handleMarketingIntake) has already resolved
 * which Hat owns the work -- the per-Hat execution step (decide to draft/
 * route/clarify), not Hat resolution itself. executionEngine.ts calls
 * dispatchMarketingHat (exported below) wherever it used to call the
 * internal runMarketingHat function directly -- every call site
 * (handleHandoffPickup, handleMarketingIntake's success path,
 * handleTransitionApproval, handleMarketingFeedback,
 * handleMarketingClarification) is now routed through this manifest's
 * entryHandler, making it the genuine runtime execution point rather than
 * a decorative parallel structure. The actual decision logic below is
 * relocated from executionEngine.ts UNCHANGED, byte-for-byte -- this
 * migration makes zero behavioral changes to draft/route/clarify
 * decisions, the paid-media spend gate, or the routing allow-list checks.
 *
 * Each of the 5 Hats declares exactly one action, handle_request
 * ("write", requiresApproval: true) -- there is no existing declared
 * multi-verb action list to reuse (unlike BD/Sales), since Marketing's
 * real behavior is a single free-form AI decision (draft | route |
 * clarify) per invocation, not a Stage-2-classified choice among several
 * Unit-declared verbs. Declaring one action here is documentation of that
 * shape, not a claim that Stage 2 action classification runs for
 * Marketing -- it doesn't; dispatchMarketingHat calls straight into
 * entryHandler, bypassing dispatchAction/resolveUnitRequest entirely,
 * exactly as Marketing's own Stage 1 stays outside resolveUnitRequest too.
 *
 * intakeClassificationTaskId/actionClassificationTaskId reuse the existing,
 * already-classified marketing.intake_classification/hat_action_decision
 * SemanticTaskIds (business_sensitive, TOKEN_SAFE_RUNTIME) -- required by
 * UnitManifest's shape, but never actually invoked through this manifest;
 * Marketing's own Stage 1/2 in executionEngine.ts already calls
 * classifyCandidateHats with these same taskIds directly.
 */
type MarketingAction = "handle_request";

interface HatActionDecision {
  action: "draft" | "route" | "clarify";
  draft?: string;
  target_hat?: string;
  reason?: string;
  involves_spend?: boolean;
}

function buildHatSystemPrompt(hat: MarketingHatDefinition, universalRoleContract: string): string {
  return [
    `You are executing the ${hat.name} Hat for ENIG's Marketing specialization (within the Sales, Marketing & Business Development Unit), retrieved from ENIG's canonical governance. The Universal Role Contract is authoritative for ambiguity handling, authority, and stop conditions — follow it exactly.`,
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    `=== HAT DEFINITION: ${hat.name} ===`,
    `Purpose: ${hat.purpose}`,
    `Owns:\n${hat.owns.map((o) => `- ${o}`).join("\n")}`,
    `Does NOT own (route/escalate instead of doing this work yourself):\n${hat.doesNotOwn.map((o) => `- ${o}`).join("\n")}`,
    `Authorized routing targets from this Hat: ${hat.routesTo.length ? hat.routesTo.join(", ") : "none — if this isn't yours, ask for clarification instead."}`,
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    'If this task is within what this Hat owns, return {"action":"draft","draft":"...", "involves_spend": true|false}. Set involves_spend true only if this Hat is Digital Marketer and the action involves paid advertising or committing spend — spend always requires explicit human approval regardless of whether it is tactical or strategic. If this task belongs to a responsibility this Hat does NOT own, return {"action":"route","target_hat":"<name from the authorized routing targets>","reason":"..."} — never do the other Hat\'s work yourself. If you cannot determine ownership or the task lacks the information needed to proceed, return {"action":"clarify","reason":"..."}. Never guess past missing information or invent authority you don\'t have.',
  ].join("\n\n");
}

/**
 * Shared per-Hat execution, used by every one of the five Marketing Hats
 * -- relocated unchanged from executionEngine.ts's former runMarketingHat.
 * Loads only the current Hat's own full definition (never the other
 * four's) plus the Universal Role Contract. Asks the model to decide:
 * draft an output within this Hat's own ownership, propose a transition
 * to another Hat, or stop and ask for clarification. None of these is
 * itself authorization — each branch still requires Martin's explicit
 * approval before anything is treated as done.
 */
async function runMarketingHat(env: Env, state: WorkState): Promise<WorkState> {
  const hatName = state.hat as MarketingHatName;
  const hat = MARKETING_HAT_REGISTRY[hatName];

  const universalRoleContract = await getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract");
  if (!universalRoleContract) {
    console.error(`Marketing (${hatName}) blocked — Universal Role Contract retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Marketing task blocked — governance retrieval failed: ${hatName}`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: "Could not retrieve the Universal Role Contract from Notion. Refusing to execute without it.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, `Couldn't process this task — couldn't retrieve canonical governance from Notion. Please try again once resolved.`);
    return state;
  }

  const decision = await aiJson<HatActionDecision>(env, {
    taskId: "marketing.hat_action_decision",
    system: buildHatSystemPrompt(hat, universalRoleContract),
    user: state.marketingTaskText ?? "",
  });

  if (!decision) {
    console.error(`Marketing (${hatName}) action decision failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Marketing task blocked — action decision failed: ${hatName}`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: "Could not determine how to proceed. Refusing to guess.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, `Couldn't determine how to handle this. Please try again or rephrase.`);
    return state;
  }

  if (decision.action === "clarify") {
    await logActivity(env, {
      entry: `${hatName} needs clarification`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: decision.reason ?? "Insufficient information to proceed.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, decision.reason ?? "I need more information before I can proceed.");
    state.stage = "marketing_ambiguous";
    state.awaiting = "marketing_clarification";
    return state;
  }

  if (decision.action === "route") {
    const target = decision.target_hat as MarketingHatName | undefined;
    if (!target || !isMarketingHat(target) || !hat.routesTo.includes(target)) {
      // The model proposed a transition outside this Hat's authorized
      // routing list (or an invalid/hallucinated target) — code-level
      // gate: never trust it, fail closed rather than route anywhere.
      console.error(`Marketing (${hatName}) proposed an unauthorized transition target: ${decision.target_hat}`);
      await logActivity(env, {
        entry: `${hatName} proposed an unauthorized routing target`,
        type: "Blocker",
        area: "Marketing",
        decisionRationale: `Proposed target "${decision.target_hat}" is not in ${hatName}'s authorized routing list. Refusing to route.`,
        outcome: "Blocked",
      });
      await sendWorkspaceHatMessage(env, state, `Couldn't determine a valid next step for this — please clarify what's needed.`);
      state.stage = "marketing_ambiguous";
      state.awaiting = "marketing_clarification";
      return state;
    }

    state.pendingTransition = { toHat: target, reason: decision.reason ?? "" };
    await logActivity(env, {
      entry: `${hatName} proposed routing to ${target}`,
      type: "Decision",
      area: "Marketing",
      decisionRationale: decision.reason ?? "",
      outcome: "Blocked",
    });
    const verb = target === "Marketing Strategist" ? "escalate to" : "route to";
    const transitionMessage = `This needs to ${verb} *${target}* — ${decision.reason ?? "outside this Hat's ownership."}\n\nConfirm the transition?`;
    const transitionButtons = [
      [
        { text: "✅ Confirm", callback_data: `markettransition:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `markettransition:${state.workId}:redo` },
      ],
    ];
    await sendWorkspaceHatMessage(env, state, transitionMessage, transitionButtons);
    state.pendingActionSummary = {
      label: `Route to ${target}`,
      message: transitionMessage,
      buttons: transitionButtons,
      createdAt: new Date().toISOString(),
    };
    state.stage = "awaiting_marketing_transition";
    state.awaiting = undefined;
    return state;
  }

  // action === "draft"
  const isPaidMedia = hatName === "Digital Marketer" && decision.involves_spend === true;
  state.marketingDraft = decision.draft ?? "";

  if (isPaidMedia) {
    state.pendingPaidMediaAction = { description: decision.draft ?? "" };
    const paidMediaMessage = `*Paid media action*\n\n${decision.draft}\n\nThis involves spend and requires your explicit approval before anything runs. Approve this budget/spend?`;
    const paidMediaButtons = [
      [
        { text: "✅ Approve spend", callback_data: `marketpaid:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `marketpaid:${state.workId}:redo` },
      ],
    ];
    await sendWorkspaceHatMessage(env, state, paidMediaMessage, paidMediaButtons);
    state.pendingActionSummary = {
      label: `Paid media spend: ${state.hat}`,
      message: paidMediaMessage,
      buttons: paidMediaButtons,
      createdAt: new Date().toISOString(),
    };
    state.stage = "awaiting_paid_media_approval";
    state.awaiting = undefined;
    return state;
  }

  const draftMessage = `${decision.draft}\n\nApprove this?`;
  const draftButtons = [
    [
      { text: "✅ Approve", callback_data: `marketdraft:${state.workId}:approve` },
      { text: "🔁 Redo", callback_data: `marketdraft:${state.workId}:redo` },
    ],
  ];
  await sendWorkspaceHatMessage(env, state, draftMessage, draftButtons);
  state.pendingActionSummary = {
    label: `Marketing draft: ${state.hat}`,
    message: draftMessage,
    buttons: draftButtons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_marketing_draft_approval";
  state.awaiting = undefined;
  return state;
}

async function marketingEntryHandler(env: Env, state: WorkState, _actionName: MarketingAction, _text: string): Promise<WorkState> {
  return runMarketingHat(env, state);
}

/** Marketing declares no "read" action -- handle_request is always "write" (a WorkSession always exists by the time this manifest is consulted; Stage 1 already ran in executionEngine.ts before any Hat, and therefore this manifest, is reached). Fails closed rather than silently no-opping. */
async function marketingReadHandler(_env: Env, actionName: MarketingAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- every Marketing Hat only declares "handle_request" ("write").`);
}

function buildMarketingHatManifest(def: MarketingHatDefinition): HatManifest<MarketingAction> {
  const actions: ActionDefinition<MarketingAction>[] = [
    {
      name: "handle_request",
      consequence: "write",
      requiresApproval: true,
      description:
        "Decide whether to draft an output within this Hat's ownership, propose a transition to a better-suited Hat, or ask for clarification -- always gated on Martin's explicit approval (or, for Digital Marketer, explicit spend approval) before anything is treated as done.",
    },
  ];

  return {
    name: def.name,
    specialization: def.specialization,
    responsibility: def.purpose,
    actions,
    readHandler: marketingReadHandler,
    entryHandler: marketingEntryHandler,
    awaitingHandlers: {},
  };
}

export const marketingManifest: UnitManifest = {
  unit: "Marketing",
  hats: Object.fromEntries(Object.values(MARKETING_HAT_REGISTRY).map((def) => [def.name, buildMarketingHatManifest(def)])),
  intakeClassificationTaskId: "marketing.intake_classification",
  intakeIntroLine: "You route incoming Marketing-specialization tasks for ENIG, within the Sales, Marketing & Business Development Unit.",
  actionClassificationTaskId: "marketing.hat_action_decision",
};

/**
 * The genuine runtime execution point for a Marketing Hat, once
 * executionEngine.ts's own Stage 1/2 (or a Handoff pickup, or an approval/
 * feedback/clarification loop) has already determined state.hat. Replaces
 * every former direct call to executionEngine.ts's internal
 * runMarketingHat -- this manifest's entryHandler now runs it.
 */
export async function dispatchMarketingHat(env: Env, state: WorkState): Promise<WorkState> {
  const hatName = state.hat as MarketingHatName;
  const hat = marketingManifest.hats[hatName];
  if (!hat) {
    // Unreachable given executionEngine.ts only ever sets state.hat from
    // isMarketingHat/MARKETING_HAT_REGISTRY -- fail closed rather than
    // silently no-opping if that invariant is ever violated.
    throw new Error(`dispatchMarketingHat: "${hatName}" is not a registered Marketing Hat.`);
  }
  return hat.entryHandler(env, state, "handle_request", state.marketingTaskText ?? "");
}
