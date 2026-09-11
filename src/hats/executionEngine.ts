import type { Env, WorkState } from "../types";
import { aiJson } from "../ai";
import { logActivity } from "../log";
import { sendMessage } from "../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../governance";
import type { MarketingHatDefinition, MarketingHatName } from "./types";
import { MARKETING_HAT_REGISTRY, isMarketingHat, marketingHatSummaryList } from "./registry";
import {
  resolveMarketingCandidateRelationships,
  selectMarketingAmbiguityReasonCode,
} from "./relationships";

/**
 * Shared Marketing execution mechanics only — not a Hat registry, and not
 * a Hat-definition file. Each Marketing Hat remains independently defined
 * in its own file under src/units/smbd/marketing/ (purpose, owns,
 * doesNotOwn, routesTo); src/hats/registry.ts remains the one canonical
 * place every Hat is registered. This file contains only the runtime
 * lifecycle every one of the five Marketing Hats shares identically —
 * classify intake, then draft within ownership / propose a transition /
 * ask for clarification, always gated on Martin's explicit approval — the
 * same role governance.ts/ai.ts already play for every other Hat: shared
 * infrastructure a Hat's own file is called from, never a duplicate
 * authority system or a second source of Hat responsibilities.
 */

interface Stage1IntakeClassification {
  candidates?: MarketingHatName[];
  establishing?: boolean;
  reason?: string;
}

interface HatActionDecision {
  action: "draft" | "route" | "clarify";
  draft?: string;
  target_hat?: string;
  reason?: string;
  involves_spend?: boolean;
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
  const stage1 = await aiJson<Stage1IntakeClassification>(env, {
    system: `You route incoming Marketing-specialization tasks for ENIG, within the Sales, Marketing & Business Development Unit. Below are the five Marketing Hats and their purposes. Identify ALL genuinely plausible candidate Hats for the incoming request, and whether establishing foundational strategy/briefs/guidance is required.

${marketingHatSummaryList()}

Return JSON:
{
  "candidates": ["<exact Hat name 1>", ...],
  "establishing": true | false,
  "reason": "<brief rationale>"
}
- candidates: list 1 or more Marketing Hats that are genuinely plausible candidates for this request.
- establishing: set true if creating/establishing strategy, guidance, or briefs from scratch; set false if managing or executing against already-established direction.`,
    user: text,
    light: true,
  });

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
    await sendMessage(
      env,
      state.chatId,
      "Couldn't determine which Marketing Hat this belongs to — classification failed. Please resend or rephrase.",
      undefined,
      state.threadId,
    );
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
    await sendMessage(
      env,
      state.chatId,
      `I'm not sure which Marketing Hat this belongs to — ${reasonText}. Can you clarify what's needed?`,
      undefined,
      state.threadId,
    );
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

  return runMarketingHat(env, state);
}

/**
 * Shared per-Hat execution, used by every one of the five Marketing Hats.
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
    await sendMessage(
      env,
      state.chatId,
      `Couldn't process this ${hatName} task — couldn't retrieve canonical governance from Notion. Please try again once resolved.`,
      undefined,
      state.threadId,
    );
    return state;
  }

  const decision = await aiJson<HatActionDecision>(env, {
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
    await sendMessage(
      env,
      state.chatId,
      `Couldn't determine how ${hatName} should handle this. Please try again or rephrase.`,
      undefined,
      state.threadId,
    );
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
    await sendMessage(
      env,
      state.chatId,
      `*${hatName}*: ${decision.reason ?? "I need more information before I can proceed."}`,
      undefined,
      state.threadId,
    );
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
      await sendMessage(
        env,
        state.chatId,
        `*${hatName}* couldn't determine a valid next step for this — please clarify what's needed.`,
        undefined,
        state.threadId,
      );
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
    await sendMessage(
      env,
      state.chatId,
      `*${hatName}*: this needs to ${verb} *${target}* — ${decision.reason ?? "outside this Hat's ownership."}\n\nConfirm the transition?`,
      [
        [
          { text: "✅ Confirm", callback_data: `markettransition:${state.workId}:approve` },
          { text: "🔁 Redo", callback_data: `markettransition:${state.workId}:redo` },
        ],
      ],
      state.threadId,
    );
    state.stage = "awaiting_marketing_transition";
    state.awaiting = undefined;
    return state;
  }

  // action === "draft"
  const isPaidMedia = hatName === "Digital Marketer" && decision.involves_spend === true;
  state.marketingDraft = decision.draft ?? "";

  if (isPaidMedia) {
    state.pendingPaidMediaAction = { description: decision.draft ?? "" };
    await sendMessage(
      env,
      state.chatId,
      `*Digital Marketer — paid media action*\n\n${decision.draft}\n\nThis involves spend and requires your explicit approval before anything runs. Approve this budget/spend?`,
      [
        [
          { text: "✅ Approve spend", callback_data: `marketpaid:${state.workId}:approve` },
          { text: "🔁 Redo", callback_data: `marketpaid:${state.workId}:redo` },
        ],
      ],
      state.threadId,
    );
    state.stage = "awaiting_paid_media_approval";
    state.awaiting = undefined;
    return state;
  }

  await sendMessage(
    env,
    state.chatId,
    `*${hatName}*\n\n${decision.draft}\n\nApprove this?`,
    [
      [
        { text: "✅ Approve", callback_data: `marketdraft:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `marketdraft:${state.workId}:redo` },
      ],
    ],
    state.threadId,
  );
  state.stage = "awaiting_marketing_draft_approval";
  state.awaiting = undefined;
  return state;
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

export async function handleTransitionApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingTransition;
  if (!approved || !pending) {
    await sendMessage(
      env,
      state.chatId,
      "Got it — what should change? Tell me what to reconsider and I'll take another look.",
      undefined,
      state.threadId,
    );
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
  await sendMessage(env, state.chatId, `Routed to *${pending.toHat}*.`, undefined, state.threadId);

  return runMarketingHat(env, state);
}

export async function handleDraftApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(
      env,
      state.chatId,
      "Got it — what should change? Tell me what's off or what to take into account, and I'll redo it.",
      undefined,
      state.threadId,
    );
    state.awaiting = "marketing_feedback";
    return state;
  }

  await logActivity(env, {
    entry: `${state.hat} output approved`,
    type: "Decision",
    area: "Marketing",
    decisions: state.marketingDraft?.slice(0, 500) ?? "",
    decisionRationale: "Approved by Martin.",
    outcome: "Complete",
  });
  await sendMessage(env, state.chatId, `Approved.`, undefined, state.threadId);
  state.marketingDraft = undefined;
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

export async function handlePaidMediaApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(
      env,
      state.chatId,
      "Got it — what should change about this spend/action? Tell me what to reconsider and I'll redo it.",
      undefined,
      state.threadId,
    );
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
  await sendMessage(env, state.chatId, `Spend approved.`, undefined, state.threadId);
  state.pendingPaidMediaAction = undefined;
  state.marketingDraft = undefined;
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

/** Redo loop: append Martin's reasoning to the task text and re-run the current Hat's decision from scratch. */
export async function handleMarketingFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.marketingTaskText = `${state.marketingTaskText ?? ""}\n\nMartin's feedback: ${text}`;
  return runMarketingHat(env, state);
}

/** Clarification loop: re-runs intake classification if no Hat is assigned yet, otherwise re-runs the current Hat. */
export async function handleMarketingClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const augmented = `${state.marketingTaskText ?? ""}\n\nAdditional detail: ${text}`;
  if (isMarketingHat(state.hat)) {
    state.marketingTaskText = augmented;
    return runMarketingHat(env, state);
  }
  return handleMarketingIntake(env, state, augmented);
}
