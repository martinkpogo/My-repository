import type { Env, WorkState } from "../../types";
import { createPage, getPage, plainText, richText, select, title, updatePage } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { sendConversationHatMessage } from "../../telegram";
import { setActiveWorkId } from "../../router";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";

interface PriceJudgement {
  sufficient: boolean;
  price?: number;
  rationale?: string;
  reason_if_insufficient?: string;
}

// Canonical Notion governance source for this Hat, verified live in the
// audit that preceded this change. Explicit page ID, not title search, per
// the Universal Role Contract's evidence rule (a consequential source must
// be attributable, not guessed at by name match).
const FINANCE_HAT_DEFINITION_PAGE_ID = "3cecb004-e583-81f9-a52e-e24872a52eff";

function buildFinanceSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for your role, responsibilities, authority limits, and stop conditions — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    'Return JSON: {"sufficient": true, "price": <number>, "rationale": "..."} if you can judge a value-based price responsibly per the Hat Definition above, or {"sufficient": false, "reason_if_insufficient": "..."} if the Hat Definition\'s own rule for insufficient context applies to this case.',
    "If context is insufficient, state only the missing category of information required (e.g., 'historical business-impact range required for pricing judgment'), without requesting, naming, or attempting to discover specific sensitive records or client entities.",
  ].join("\n\n");
}

/**
 * Reconstructs the business context this Hat needs directly from the
 * Handoff's own canonical Notion record, evaluated through the data boundary
 * closed-context contract.
 *
 * Identity is read as the Entity_Token / Matter_Token the creating Unit
 * embedded directly on the Handoff, never a real Name/title — this Hat
 * never reads the Entity or Matter page (and, per the data-boundary
 * redesign, may not even have Notion access to the Entity database). The
 * real name never enters this Hat's context, an AI prompt, or a Telegram
 * message it sends.
 */
export async function resolveHandoffBusinessContext(
  env: Env,
  handoffId: string,
): Promise<HandoffContextEvaluationResult> {
  try {
    const handoff = await getPage(env, handoffId);
    const judgmentContext = plainText(handoff.properties["Verified Facts & Sources"]);
    const entityToken = plainText(handoff.properties.Entity_Token);
    const matterToken = plainText(handoff.properties.Matter_Token);

    return evaluateHandoffContext(
      {
        handoffId,
        entityToken,
        matterToken,
        sanitizedContext: judgmentContext,
        provenance: `notion:handoff:${handoffId}`,
        requiredCategory: "historical business-impact range for value-based pricing",
      },
      "finance.quote_judgment",
    );
  } catch (err) {
    console.error(`Handoff business-context reconstruction failed for ${handoffId}`, err);
    return {
      success: false,
      insufficientContext: {
        isInsufficient: true,
        category: "handoff record access",
        reason: `Insufficient execution context: unable to access Handoff record ${handoffId}.`,
      },
    };
  }
}

export async function handlePickup(env: Env, state: WorkState): Promise<WorkState> {
  // Follows wherever this session's home chat/thread already is (Martin's
  // DM by default -- see discoverPendingFinanceHandoffs) rather than
  // forcing Finance's own topic, so every Unit/Hat's work reaches him in
  // one place if that's where he's working from.
  const financeThreadId = state.threadId;

  // Business context is reconstructed BEFORE the Handoff is marked
  // Picked-up, so a Notion outage leaves it Pending and it's retried
  // automatically on the next discovery cycle, rather than stuck in a
  // Picked-up limbo needing manual recovery.
  const evalResult = await resolveHandoffBusinessContext(env, state.handoffId!);
  if (!evalResult.success) {
    console.error(`Finance handlePickup: context evaluation failed for handoff ${state.handoffId}: ${evalResult.insufficientContext.reason}`);
    await logActivity(env, {
      entry: `Finance pickup blocked [Insufficient Context] — ${evalResult.insufficientContext.category}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendConversationHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `*Finance couldn't pick up a quote request* (Handoff ${state.handoffId}).\n\n${evalResult.insufficientContext.reason}\n\nNot proceeding without required sanitized context — will retry automatically once supplied.`,
    );
    return state;
  }

  return judgeQuote(env, state, {
    entityToken: evalResult.contract.entityToken,
    matterToken: evalResult.contract.matterToken ?? "",
    judgmentContext: evalResult.contract.sanitizedContext,
    financeThreadId,
    awaitingOnInsufficient: "value_context_more",
    activityLabel: "picked up the quote request",
  });
}

/**
 * The Martin <-> Finance conversation that produces a price judgment,
 * shared by the initial pickup and by a redo (handleQuoteRedoReason) —
 * same governance retrieval, same AI judgment call, same Held/Closed
 * branching. Governance is checked BEFORE the Handoff is marked Picked-up,
 * so a transient failure leaves its prior status intact rather than stuck.
 */
async function judgeQuote(
  env: Env,
  state: WorkState,
  input: {
    entityToken: string;
    matterToken: string;
    judgmentContext: string;
    financeThreadId: number | undefined;
    awaitingOnInsufficient: NonNullable<WorkState["awaiting"]>;
    activityLabel: string;
  },
): Promise<WorkState> {
  const { entityToken, matterToken, judgmentContext, financeThreadId, awaitingOnInsufficient, activityLabel } = input;

  // Finance operates on identity tokens only, never the real Entity/Matter
  // name — overwrite WorkState's copy too, so any later Finance-side
  // reference (e.g. handleQuoteApproval's own messages, below) also stays
  // token-only rather than falling back to whatever Sales originally set.
  state.entityName = entityToken;
  state.matterName = matterToken;

  const [hatDefinition, universalRoleContract] = await Promise.all([
    getGovernance(env, FINANCE_HAT_DEFINITION_PAGE_ID, "Finance Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);

  if (!hatDefinition || !universalRoleContract) {
    const missing = [
      !hatDefinition ? "Finance Hat Definition" : null,
      !universalRoleContract ? "Universal Role Contract" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    console.error(`Finance judgeQuote: governance retrieval failed (${missing}) for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Finance quote judgment blocked — governance retrieval failed: ${matterToken}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: `Could not retrieve canonical governance from Notion (${missing}). Refusing to execute without it.`,
      outcome: "Blocked",
    });
    await sendConversationHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Couldn't assess the quote for *${entityToken}* — couldn't retrieve canonical governance from Notion (${missing}). Please try again once resolved.`,
    );
    return state;
  }

  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });
  await logActivity(env, {
    entry: `Finance ${activityLabel}: ${matterToken}`,
    type: "Activity",
    area: "Finance",
    activity: `Value-Based Pricing Assessor ${activityLabel}.`,
    outcome: "Active",
  });

  const judgement = await aiJson<PriceJudgement>(env, {
    taskId: "finance.quote_judgment",
    system: buildFinanceSystemPrompt(hatDefinition, universalRoleContract),
    user: `Entity: ${entityToken}\nProposed intervention and value context:\n${judgmentContext}`,
  });

  if (!judgement || judgement.sufficient !== true || typeof judgement.price !== "number") {
    const reason = judgement?.reason_if_insufficient ?? "Value context insufficient to price responsibly.";
    await updatePage(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(reason),
    });
    await logActivity(env, {
      entry: `Handoff held — insufficient value context: ${matterToken}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: reason,
      outcome: "Blocked",
    });
    await sendConversationHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `*Finance has held the quote request* for *${entityToken}*.\n\nThe information provided isn't enough to work out a value-based price — a disclosed budget or willingness-to-pay figure on its own can't be used as the pricing basis.\n\nPlease share more about the expected business impact — for example revenue growth, cost savings, efficiency gains, or customer acquisition — and we'll reassess.`,
    );
    state.stage = "handoff_held";
    state.awaiting = awaitingOnInsufficient;
    state.financeThreadId = financeThreadId;
    if (financeThreadId !== undefined) {
      await setActiveWorkId(env, state.chatId, financeThreadId, state.workId);
    }
    return state;
  }

  await updatePage(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText(`Quoted price: $${judgement.price}. Rationale: ${judgement.rationale ?? ""}`.slice(0, 1900)),
  });
  await logActivity(env, {
    entry: `Quote judged: $${judgement.price} — ${matterToken}`,
    type: "Decision",
    area: "Finance",
    decisions: `Value-based quote: $${judgement.price}`,
    decisionRationale: judgement.rationale ?? "",
    outcome: "Complete",
  });

  // The quote is a judgment call, not final authority (per the Finance Hat
  // Definition's authority_limits) — it goes to Martin for review before it
  // becomes the authoritative quote Sales is allowed to build a proposal on.
  state.quote = { price: judgement.price, rationale: judgement.rationale ?? "" };
  state.stage = "awaiting_quote_approval";
  state.awaiting = undefined;
  state.financeThreadId = financeThreadId;
  if (financeThreadId !== undefined) {
    await setActiveWorkId(env, state.chatId, financeThreadId, state.workId);
  }
  await sendConversationHatMessage(
    env,
    { ...state, hat: "Value-Based Pricing Assessor" },
    `*Finance quote ready* for *${entityToken}*: $${judgement.price}\n\nRationale: ${judgement.rationale}\n\nApprove this quote to send it to Sales for the Draft Proposal?`,
    [
      [
        { text: "✅ Approve quote", callback_data: `quote:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `quote:${state.workId}:redo` },
      ],
    ],
  );
  return state;
}

/**
 * Handles Martin's reasoning after he clicks Redo on a computed quote.
 * This stays entirely within Finance — Martin is critiquing Finance's own
 * judgment, not supplying business facts Sales owns (contrast
 * sales.handleMoreValueContext, used for the latter) — so it acts
 * immediately rather than requeuing the Handoff Pending for cron discovery
 * to re-pick-up asynchronously; no Unit boundary is being crossed.
 */
export async function handleQuoteRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const financeThreadId = state.financeThreadId ?? state.threadId;

  const evalResult = await resolveHandoffBusinessContext(env, state.handoffId!);
  if (!evalResult.success) {
    console.error(`Finance redo blocked — context evaluation failed for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Finance redo blocked — insufficient business context: ${state.entityName}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendConversationHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Couldn't read the Handoff record for *${state.entityName}* to apply your reasoning: ${evalResult.insufficientContext.reason}`,
    );
    return state;
  }

  const augmentedContext = `${evalResult.contract.sanitizedContext}\n\nMartin's redo reasoning: ${reasonText}`;
  await updatePage(env, state.handoffId!, {
    "Verified Facts & Sources": richText(augmentedContext.slice(0, 1900)),
  });

  return judgeQuote(env, state, {
    entityToken: evalResult.contract.entityToken,
    matterToken: evalResult.contract.matterToken ?? "",
    judgmentContext: augmentedContext,
    financeThreadId,
    awaitingOnInsufficient: "quote_redo_reason",
    activityLabel: "resumed reassessment following Martin's redo reasoning",
  });
}

/**
 * Martin's approval gate on the quote itself, distinct from the Draft
 * Proposal review gate later — per the Finance Hat Definition's
 * authority_limits ("The quote is a judgment call, not final authority —
 * subject to Martin's direct authorization"). Approval does NOT hand off
 * in-process to Sales (that would repeat the same in-process cross-Unit
 * call the Sales -> Finance boundary was corrected away from): it creates a
 * new Handoff, Finance -> Sales, and returns. Sales's own independent
 * discovery (discoverPendingSalesHandoffs in index.ts) picks it up, the same
 * way Finance discovers Handoffs addressed to it.
 */
export async function handleQuoteApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const financeThreadId = state.financeThreadId ?? state.threadId;

  if (!approved) {
    await updatePage(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText("Martin requested a redo of the quote. Awaiting his reasoning before reassessing."),
    });
    await logActivity(env, {
      entry: `Finance quote redo requested: ${state.matterName ?? state.entityName}`,
      type: "Decision",
      area: "Finance",
      decisionRationale: "Martin requested a redo of the computed quote.",
      outcome: "Blocked",
    });
    await sendConversationHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Got it — why are you requesting a redo for *${state.entityName}*? Tell me what's off or what to take into account, and I'll reassess and get you a new quote to review.`,
    );
    state.stage = "quote_redo_requested";
    state.awaiting = "quote_redo_reason";
    return state;
  }

  if (!state.matterName) {
    console.error(`Finance handleQuoteApproval: state.matterName missing for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Quote approval blocked — no Matter_Token on record: ${state.entityName ?? state.handoffId}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: "This work item has no Matter_Token, so the Finance -> Sales follow-up Handoff can't identify which Matter it's for.",
      outcome: "Blocked",
    });
    await sendConversationHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Quote approved, but I can't route it to Sales — this work item has no Matter_Token on record. Please check the Handoff for *${state.entityName ?? state.handoffId}*, then retry.`,
    );
    return state;
  }

  const followUp = await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, {
    Handoff: title(`Draft Proposal — ${state.matterName}`),
    "From Unit": select("Finance"),
    "From Hat": richText("Value-Based Pricing Assessor"),
    "To Unit": select("Sales"),
    "To Hat": richText("Sales Executive"),
    Type: select("Work"),
    Status: select("Pending"),
    Reason: richText(`Value-based quote approved by Martin for ${state.matterName}; ready for Draft Proposal preparation.`),
    "Expected Output": richText("Complete Draft Proposal presented to Martin for review and authorization."),
    Entity_Token: richText(state.entityName ?? ""),
    Matter_Token: richText(state.matterName ?? ""),
    "Verified Facts & Sources": richText(
      `Authoritative quote: $${state.quote?.price}\nRationale: ${state.quote?.rationale ?? ""}`.slice(0, 1900),
    ),
  });
  state.handoffId = followUp.id;
  await env.STATE_KV.put(`handoff_workitem:${followUp.id}`, state.workId);

  await logActivity(env, {
    entry: `Quote approved — routed to Sales for Draft Proposal: ${state.matterName}`,
    type: "Activity",
    area: "Finance",
    activity: `Handoff ${followUp.id} — quote approved and queued for Sales.`,
    nextActions: "Sales to pick up and prepare the Draft Proposal.",
    outcome: "Complete",
  });
  await sendConversationHatMessage(
    env,
    { ...state, hat: "Value-Based Pricing Assessor" },
    `Quote approved — queued for Sales to prepare the Draft Proposal for *${state.entityName}*.`,
  );

  state.stage = "quote_approved";
  state.awaiting = undefined;
  return state;
}
