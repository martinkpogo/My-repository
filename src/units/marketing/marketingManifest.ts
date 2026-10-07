import type { Env, WorkState } from "../../types";
import { resolveRecordedActionSkills } from "../../runtime/actionSkills";
import type { ActionDefinition } from "../../hats/actionRegistry";
import { workSessionContext } from "../../access";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
import type { MarketingHatDefinition, MarketingHatName } from "../../hats/types";
import { MARKETING_HAT_REGISTRY, isMarketingHat, marketingHatSummaryList } from "../../hats/registry";
import { classifyCandidateHats } from "../../hats/intakeClassification";
import { resolveMarketingCandidateRelationships, selectMarketingAmbiguityReasonCode } from "../../hats/relationships";
import { generate, type GeneratePromptParts } from "../../ai";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { richText, select } from "../../notion";
import { updateHandoff } from "../../handoffWriter";

/**
 * Marketing's Unit Registry manifest (ENIG Operating Model design doc,
 * "The Unit Registry") -- deliberately partial, by design, not by
 * oversight. Unlike Business Development (built from scratch on this
 * pattern) or Sales's Lead Generation Specialist (a single existing
 * action wrapped as-is), Marketing already has real, live, actively-used
 * Stage 1/2 routing logic in handleMarketingIntake (below -- relocated
 * from src/hats/executionEngine.ts):
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
 * 1/2 (handleMarketingIntake below, relocated from executionEngine.ts)
 * has already resolved which Hat owns the work -- the per-Hat execution
 * step (decide to draft/route/clarify), not Hat resolution itself.
 * Every call site (executionEngine.ts's handleHandoffPickup, and this
 * file's handleMarketingIntake success path, handleMarketingFeedback,
 * handleMarketingClarification) is now routed through this manifest's
 * entryHandler -- dispatchMarketingHat (exported below) where those call
 * sites used to call the internal runMarketingHat function directly --
 * making it the genuine runtime execution point rather than
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
 * Marketing's own Stage 1/2 (handleMarketingIntake above) already calls
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

function buildHatPromptParts(hat: MarketingHatDefinition, universalRoleContract: string): Pick<GeneratePromptParts, "persona" | "behavior" | "skillContent" | "context"> {
  return {
    persona: `You are executing the ${hat.name} Hat for ENIG's Marketing specialization (within the Sales, Marketing & Business Development Unit), retrieved from ENIG's canonical governance. The Universal Role Contract is authoritative for ambiguity handling, authority, and stop conditions — follow it exactly.`,
    behavior: ["=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===", universalRoleContract].join("\n\n"),
    skillContent: [
      `=== HAT DEFINITION: ${hat.name} ===`,
      `Purpose: ${hat.purpose}`,
      `Owns:\n${hat.owns.map((o) => `- ${o}`).join("\n")}`,
      `Does NOT own (route/escalate instead of doing this work yourself):\n${hat.doesNotOwn.map((o) => `- ${o}`).join("\n")}`,
      `Authorized routing targets from this Hat: ${hat.routesTo.length ? hat.routesTo.join(", ") : "none — if this isn't yours, ask for clarification instead."}`,
    ].join("\n\n"),
    context: [
      "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
      'If this task is within what this Hat owns, return {"action":"draft","draft":"...", "involves_spend": true|false}. Set involves_spend true only if this Hat is Digital Marketer and the action involves paid advertising or committing spend — spend always requires explicit human approval regardless of whether it is tactical or strategic. If this task belongs to a responsibility this Hat does NOT own, return {"action":"route","target_hat":"<name from the authorized routing targets>","reason":"..."} — never do the other Hat\'s work yourself. If you cannot determine ownership or the task lacks the information needed to proceed, return {"action":"clarify","reason":"..."}. Never guess past missing information or invent authority you don\'t have.',
    ].join("\n\n"),
  };
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

  const decision = await generate<HatActionDecision>(env, {
    taskId: "marketing.hat_action_decision",
    mode: "json",
    parts: { ...buildHatPromptParts(hat, universalRoleContract), situation: state.marketingTaskText ?? "" },
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

/**
 * Entry point for a new Marketing work item, analogous to
 * sales.handleIncomingEnquiry. Uses a two-stage deterministic routing model:
 * - Stage 1 identifies genuinely plausible candidate Hats and whether establishing is needed.
 * - Stage 2 evaluates specific registered sequential relationships between candidates deterministically.
 */
export async function handleMarketingIntake(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.marketingTaskText = text;

  // Stage 1: LLM identifies candidate Hats and establishing context
  const stage1 = await classifyCandidateHats<MarketingHatName>(
    env,
    {
      taskId: "marketing.intake_classification",
      introLine: "You route incoming Marketing-specialization tasks for ENIG, within the Sales, Marketing & Business Development Unit.",
      hatSummaryList: marketingHatSummaryList(),
      light: true,
    },
    text,
  );

  if (!stage1 || !stage1.candidates) {
    const reasonCode = selectMarketingAmbiguityReasonCode(null);
    console.error(`Marketing Stage 1 classification failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Marketing intake blocked [${reasonCode}] — classification failed`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: `Could not classify Marketing candidates for this request. Refusing to guess. Reason code: ${reasonCode}`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, "Couldn't determine which Marketing Hat this belongs to — classification failed. Please resend or rephrase.");
    return state;
  }

  const validCandidates = stage1.candidates.filter(isMarketingHat);

  // Stage 2: Deterministic, request-text-free evaluation of registered sequential relationships
  const stage2 = resolveMarketingCandidateRelationships(validCandidates, stage1.establishing);

  if (!stage2.resolved || !stage2.hat) {
    const reasonCode = selectMarketingAmbiguityReasonCode(stage2);
    const reasonText = stage2.reason ?? stage1.reason ?? "Request could plausibly belong to more than one Marketing Hat.";
    await logActivity(env, {
      entry: `Marketing intake ambiguous [${reasonCode}]`,
      type: "Blocker",
      area: "Marketing",
      decisionRationale: `${reasonText} (Reason code: ${reasonCode})`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, state, `I'm not sure which Marketing Hat this belongs to — ${reasonText}. Can you clarify what's needed?`);
    state.stage = "marketing_ambiguous";
    state.awaiting = "marketing_clarification";
    return state;
  }

  state.hat = stage2.hat;
  await logActivity(env, {
    entry: `Marketing task routed to ${stage2.hat}${stage2.relationshipId ? ` via relationship ${stage2.relationshipId}` : ""}`,
    type: "Activity",
    area: "Marketing",
    activity: text,
    outcome: "Active",
  });

  return dispatchMarketingHat(env, state);
}

/** Redo loop: append Martin's reasoning to the task text and re-run the current Hat's decision from scratch. */
export async function handleMarketingFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.marketingTaskText = `${state.marketingTaskText ?? ""}\n\nMartin's feedback: ${text}`;
  return dispatchMarketingHat(env, state);
}

/** Clarification loop: re-runs intake classification if no Hat is assigned yet, otherwise re-runs the current Hat. */
export async function handleMarketingClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const augmented = `${state.marketingTaskText ?? ""}\n\nAdditional detail: ${text}`;
  if (isMarketingHat(state.hat)) {
    state.marketingTaskText = augmented;
    return dispatchMarketingHat(env, state);
  }
  return handleMarketingIntake(env, state, augmented);
}

// The callback_data prefix runMarketingHat's own "route" branch buttons
// are built with (see the "markettransition:<workId>:approve" literal
// above). Migrates onto HatManifest.callbackHandlers same as Business
// Development's three prefixes (PRs #203-205) and Sales's leadopportunity
// (PR #206) -- relocated here (not left in executionEngine.ts, its former
// home) to avoid a circular import, since this function's approval path
// re-enters dispatchMarketingHat, defined in this same file.
export const MARKET_TRANSITION_CALLBACK_PREFIX = "markettransition" as const;

/**
 * Resolves runMarketingHat's "route" branch approve/reject callback --
 * relocated unchanged, byte-for-byte, from executionEngine.ts's former
 * handleTransitionApproval. Rejecting asks Martin what to reconsider and
 * holds on marketing_feedback (still executionEngine.ts's own
 * handleMarketingFeedback, unchanged); approving commits the Hat
 * transition and re-runs dispatchMarketingHat under the new Hat.
 */
export async function handleTransitionApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingTransition;
  if (!pending) {
    await sendWorkspaceHatMessage(env, state, "This transition has already been resolved -- nothing to do.");
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(env, state, "Got it — what should change? Tell me what to reconsider and I'll take another look.");
    state.pendingTransition = undefined;
    state.awaiting = "marketing_feedback";
    return state;
  }

  const fromHat = state.hat;
  state.hat = pending.toHat;
  state.pendingTransition = undefined;
  await logActivity(env, {
    entry: `Marketing work routed: ${fromHat} -> ${pending.toHat}`,
    type: "Decision",
    area: "Marketing",
    decisions: `Confirmed by Martin.`,
    decisionRationale: pending.reason,
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, state, `Routed to *${pending.toHat}*.`);

  return dispatchMarketingHat(env, state);
}

// The callback_data prefix runMarketingHat's own "draft" branch buttons
// are built with (see the "marketdraft:<workId>:approve" literal above).
// Migrates onto HatManifest.callbackHandlers same as markettransition
// above -- relocated here for the same reason: keeping it in
// executionEngine.ts (its former home) would have required
// marketingManifest.ts to import it back from there, since a
// callbackHandlers entry must be defined wherever it's registered.
// Unlike handleTransitionApproval, this one doesn't itself re-enter
// dispatchMarketingHat, but the circular-import risk is about which file
// imports which, not which functions call which -- executionEngine.ts
// already imports dispatchMarketingHat from this file, so any import in
// the reverse direction creates the cycle regardless.
export const MARKET_DRAFT_CALLBACK_PREFIX = "marketdraft" as const;

/**
 * Resolves runMarketingHat's "draft" branch approve/reject callback --
 * relocated unchanged, byte-for-byte, from executionEngine.ts's former
 * handleDraftApproval. Rejecting asks Martin what to reconsider and holds
 * on marketing_feedback; approving closes the originating Handoff (if
 * any) and marks the work item complete.
 */
export async function handleDraftApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (state.stage !== "awaiting_marketing_draft_approval") {
    await sendWorkspaceHatMessage(env, state, "This draft approval has already been resolved -- nothing to do.");
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(env, state, "Got it — what should change? Tell me what's off or what to take into account, and I'll redo it.");
    state.awaiting = "marketing_feedback";
    return state;
  }

  // If this work item arrived via a Handoff (e.g. Strategy's approved
  // routing to Marketing Strategist), close it out as the
  // completion signal -- same pattern Finance/Sales already use.
  if (state.handoffId) {
    // Authorized as a `write`-consequence Action (handle_request), and
    // ungated because closing the Handoff THIS work item was picked up from is
    // execution bookkeeping on a record it already owns -- not the operation
    // handle_request's approval governs (producing Marketing's own output).
    await updateHandoff(
      env,
      state.handoffId,
      {
        Status: select("Closed"),
        "Work Completed": richText((state.marketingDraft ?? "").slice(0, 1900)),
      },
      workSessionContext(state),
    ).catch((err) => console.error(`Marketing: failed to close Handoff ${state.handoffId}`, err));
  }

  await logActivity(env, {
    entry: `${state.hat} output approved`,
    type: "Decision",
    area: "Marketing",
    decisions: state.marketingDraft?.slice(0, 500) ?? "",
    decisionRationale: "Approved by Martin.",
    outcome: "Complete",
  });
  await sendWorkspaceHatMessage(env, state, `Approved.`);
  state.marketingDraft = undefined;
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

// The callback_data prefix runMarketingHat's own paid-media spend gate
// buttons are built with (see the "marketpaid:<workId>:approve" literal
// above). Migrates onto HatManifest.callbackHandlers same as
// markettransition/marketdraft above, for the same reason: relocated
// here (not left in executionEngine.ts, its former home) since a
// callbackHandlers entry must be defined wherever it's registered, and
// executionEngine.ts already imports from this file. Third and final
// Marketing prefix -- no hardcoded Marketing case remains in
// session.ts's handleCallback switch after this.
export const MARKET_PAID_CALLBACK_PREFIX = "marketpaid" as const;

/**
 * Resolves runMarketingHat's paid-media spend gate approve/reject
 * callback -- relocated unchanged, byte-for-byte, from
 * executionEngine.ts's former handlePaidMediaApproval. Only ever reached
 * for Digital Marketer's own involves_spend decisions (see
 * runMarketingHat's isPaidMedia branch). Rejecting asks Martin what to
 * reconsider and holds on marketing_feedback; approving records the
 * spend decision and marks the work item complete.
 */
export async function handlePaidMediaApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (state.stage !== "awaiting_paid_media_approval") {
    await sendWorkspaceHatMessage(env, state, "This spend approval has already been resolved -- nothing to do.");
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(env, state, "Got it — what should change about this spend/action? Tell me what to reconsider and I'll redo it.");
    state.pendingPaidMediaAction = undefined;
    state.awaiting = "marketing_feedback";
    return state;
  }

  await logActivity(env, {
    entry: `Digital Marketer paid media action approved`,
    type: "Decision",
    area: "Marketing",
    decisions: state.pendingPaidMediaAction?.description.slice(0, 500) ?? "",
    decisionRationale: "Budget/spend approved by Martin.",
    outcome: "Complete",
  });
  await sendWorkspaceHatMessage(env, state, `Spend approved.`);
  state.pendingPaidMediaAction = undefined;
  state.marketingDraft = undefined;
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

const marketingCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [MARKET_TRANSITION_CALLBACK_PREFIX]: handleTransitionApproval,
  [MARKET_DRAFT_CALLBACK_PREFIX]: handleDraftApproval,
  [MARKET_PAID_CALLBACK_PREFIX]: handlePaidMediaApproval,
};

async function marketingEntryHandler(env: Env, state: WorkState, _actionName: MarketingAction, _text: string): Promise<WorkState> {
  return runMarketingHat(env, state);
}

/** Marketing declares no "read" action -- handle_request is always "write" (a WorkSession always exists by the time this manifest is consulted; Stage 1 already ran in executionEngine.ts before any Hat, and therefore this manifest, is reached). Fails closed rather than silently no-opping. */
async function marketingReadHandler(_env: Env, actionName: MarketingAction, _text: string): Promise<string> {
  throw new Error(`${actionName}: not a read action -- every Marketing Hat only declares "handle_request" ("write").`);
}

/**
 * The Responsibility id each Marketing Hat owns, keyed by its registered Hat
 * name.
 *
 * Marketing is the one Unit whose Hats are enumerated in a registry rather
 * than written out as separate manifest objects, so the mapping is declared
 * once here instead of being repeated per Hat. Every Hat's single Action
 * associates with exactly the Responsibility its own Hat owns -- the lookup is
 * fail-closed (see buildMarketingHatManifest), so a Hat added to the registry
 * without an entry here is a manifest defect, not an Action with no
 * Responsibility.
 */
const MARKETING_RESPONSIBILITY_IDS: Record<MarketingHatName, string> = {
  "Marketing Strategist": "own_marketing_strategy",
  "Brand & Communications Strategist": "own_brand_and_communications",
  "Content Strategist": "own_content_strategy",
  "Content Manager": "produce_content",
  "Digital Marketer": "own_digital_demand",
};

function buildMarketingHatManifest(def: MarketingHatDefinition): HatManifest<MarketingAction> {
  const responsibilityId = MARKETING_RESPONSIBILITY_IDS[def.name];
  if (!responsibilityId) {
    // Fail closed rather than defaulting: a Marketing Hat with no declared
    // Responsibility id would leave its Action associated with no
    // Responsibility at all, which is exactly the manifest defect
    // validateHatManifest exists to catch. Throwing here means the gap
    // surfaces at first use instead of at some later authorization check.
    throw new Error(`Marketing Hat "${def.name}" declares no Responsibility id -- its Action could not be associated with a Responsibility.`);
  }
  const actions: ActionDefinition<MarketingAction>[] = [
    {
      name: "handle_request",
      responsibility: responsibilityId,
      consequence: "write",
      requiresApproval: true,
      // Every Marketing Hat declares exactly this one Action, so the
      // structural entry rule resolves it from the Work's origin -- the
      // same rule Finance/Strategy use. What Marketing does NOT yet
      // resolve at this boundary is WHICH Hat owns a direct request (its
      // own intake classification inside executionEngine still does that,
      // see Known gaps and drift); the Handoff pickup path, where the
      // destination names the Hat, resolves fully here.
      applicability: {
        mode: "any",
        conditions: [
          { source: "work", field: "origin", operator: "in", value: ["direct_request", "handoff_pickup"] },
          { source: "work", field: "requested_action", operator: "equals", value: "handle_request" },
        ],
      },
      description:
        "Decide whether to draft an output within this Hat's ownership, propose a transition to a better-suited Hat, or ask for clarification -- always gated on Martin's explicit approval (or, for Digital Marketer, explicit spend approval) before anything is treated as done.",
    },
  ];

  return {
    name: def.name,
    specialization: def.specialization,
    responsibility: def.purpose,
    responsibilityId,
    actions,
    readHandler: marketingReadHandler,
    entryHandler: marketingEntryHandler,
    // Marketing's two continuation states, registered on EVERY Hat: the
    // old handleTextReply switch cases never consulted state.hat, so both
    // entries are uniform (state.hat is one of these five Hats whenever
    // either state is set -- the placeholder "Marketing" init path fails
    // closed at recordWorkAction before any awaiting state is reached).
    // Each entry is the exact same handler function the old case called,
    // with the same arguments -- only the lookup moved.
    awaitingHandlers: {
      marketing_feedback: handleMarketingFeedback,
      marketing_clarification: handleMarketingClarification,
    },
    callbackHandlers: marketingCallbackHandlers,
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
 * handleMarketingIntake's own Stage 1/2 (or a Handoff pickup, or an
 * approval/feedback/clarification loop) has already determined state.hat.
 * Replaces every former direct call to executionEngine.ts's internal
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
  return hat.entryHandler(env, state, "handle_request", state.marketingTaskText ?? "", await resolveRecordedActionSkills(hat, "handle_request"));
}
