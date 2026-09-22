import type { Env, WorkState } from "../../types";
import { createPage, getPage, plainText, richText, select, title, updatePage } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage } from "../../telegram";
import { setActiveWorkId } from "../../router";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import { claimPendingHandoff } from "../../handoffLifecycle";

interface RawValueAtStakeJudgement {
  value?: number;
  low?: number;
  high?: number;
  currency?: string;
  period?: string;
  evidence_type?: string;
  source?: string;
  evidence_quality?: string;
}

interface PriceJudgement {
  sufficient: boolean;
  evidence_quality_assessment?: string;
  value_at_stake?: RawValueAtStakeJudgement;
  intervention_assessment?: string;
  delivery_floor_rationale?: string;
  market_modifiers_applied?: string;
  price?: number;
  currency?: string;
  rationale?: string;
  reason_if_insufficient?: string;
}

const VALID_EVIDENCE_TYPES = ["directly_measured", "client_estimated", "derived", "assumption"];

/**
 * Patterns that mark a pricing rationale as relying on something the
 * Commercial Value & Pricing Operating Model explicitly excludes (Section
 * 5, Section 10). These are checked deterministically -- see
 * validateFinanceJudgement -- because the model's prohibition on inventing
 * a universal multiplier must hold even if the AI's own reasoning drifts
 * toward one; the AI is not trusted as the sole authority here.
 */
const FORBIDDEN_PRICING_BASIS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /purchasing power parity|ppp[\s-]?(multiplier|adjustment|adjusted|discount)/i, reason: "a purchasing power parity (PPP) multiplier" },
  { pattern: /\d{1,3}(\.\d+)?%\s*(of\s+(the\s+)?)?(value|revenue)(\s*(at stake|captur\w*))?/i, reason: "a fixed/universal percentage of value" },
  { pattern: /universal\s+(percentage|rate|multiplier|discount)/i, reason: "a universal percentage/multiplier" },
  { pattern: /ghana\s+(price\s+)?floor|hard[\s-]?coded\s+(ghana|minimum)\s+price/i, reason: "a hard-coded Ghana price floor" },
  {
    pattern: /convert(ed|ing)?\s+(the\s+)?currency.{0,40}(price|quote|basis)|currency\s+conversion(\s+rate)?\s+as\s+(the\s+)?(pricing|price)\s+(authority|basis)/i,
    reason: "currency conversion used as pricing authority",
  },
  {
    pattern: /(client'?s?\s+)?(disclosed\s+)?budget\s+(as|is|was|used as)\s+(the\s+)?(price|pricing|quote)|willingness[\s-]?to[\s-]?pay\s+(as|is|was|used as)\s+(the\s+)?(price|pricing|quote|basis)/i,
    reason: "budget or willingness-to-pay used as the pricing basis",
  },
];

/**
 * Deterministic validation of Finance's structured AI judgment, per the
 * Commercial Value & Pricing Operating Model's requirement that AI output
 * is not authority on its own. This is the sole gate on whether a
 * "sufficient: true" judgment is actually allowed to become a quote -- a
 * judgment that fails any of these checks is forced to Held regardless of
 * what the AI itself claimed. The AI cannot override this.
 */
function validateFinanceJudgement(judgement: PriceJudgement | null): { valid: true } | { valid: false; reason: string } {
  if (!judgement) return { valid: false, reason: "No structured pricing judgment was returned." };

  const v = judgement.value_at_stake;
  const hasNumber = !!v && (typeof v.value === "number" || (typeof v.low === "number" && typeof v.high === "number"));
  if (!hasNumber) {
    return { valid: false, reason: "No numerical value-at-stake value or range was established." };
  }
  if (!v!.currency) {
    return { valid: false, reason: "Value-at-stake has no currency stated." };
  }
  if (!v!.period) {
    return { valid: false, reason: "Value-at-stake has no applicable time period stated, which is required for responsible pricing judgment." };
  }
  const evidenceType = v!.evidence_type;
  if (!evidenceType || !VALID_EVIDENCE_TYPES.includes(evidenceType)) {
    return { valid: false, reason: "Value-at-stake evidence type was not established as directly_measured, client_estimated, derived, or assumption." };
  }
  if (evidenceType === "assumption") {
    return { valid: false, reason: "The only available value-at-stake figure is an unsupported assumption, which cannot satisfy the pricing evidence requirement on its own." };
  }
  if (!v!.source) {
    return { valid: false, reason: "Value-at-stake has no attributable source." };
  }
  if (!judgement.intervention_assessment?.trim()) {
    return { valid: false, reason: "The intervention or deliverable being priced is not identifiable from the supplied context." };
  }
  if (typeof judgement.price !== "number" || !Number.isFinite(judgement.price) || judgement.price <= 0) {
    return { valid: false, reason: "No valid positive quoted price was produced." };
  }
  if (!judgement.currency?.trim()) {
    return { valid: false, reason: "The quoted price has no currency stated -- the quote's own currency must be explicit, never assumed." };
  }
  if (!judgement.rationale?.trim()) {
    return { valid: false, reason: "No pricing rationale was provided." };
  }
  const scanText = `${judgement.rationale ?? ""} ${judgement.market_modifiers_applied ?? ""} ${v!.source ?? ""}`;
  const forbidden = FORBIDDEN_PRICING_BASIS_PATTERNS.find((f) => f.pattern.test(scanText));
  if (forbidden) {
    return { valid: false, reason: `Pricing rationale appears to rely on ${forbidden.reason}, which is not canonical ENIG pricing policy.` };
  }
  return { valid: true };
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
    "=== COMMERCIAL VALUE & PRICING OPERATING MODEL — CANONICAL JUDGMENT SEQUENCE ===",
    "Work through these six steps, in order, using only the value context supplied below. State your reasoning for each briefly in the corresponding JSON field.",
    "1. Evidence quality: assess the attribution and quality of the numerical evidence supplied (directly_measured, client_estimated, derived, or assumption). Never treat an assumption as equivalent to measured or client-estimated evidence.",
    "2. Value-at-stake assessment: establish a value-at-stake range (or a single figure only where the evidence genuinely supports one) with currency, applicable period, evidence type, and source, from the supplied evidence only. Never invent a figure not attributable to the supplied context, and never derive one from an unrelated figure (e.g. general company turnover) without the context itself making that derivation explicit.",
    "3. Intervention/delivery assessment: identify the specific intervention or diagnostic being priced and what it requires to deliver. Diagnosis-first engagements may be priced without a predetermined downstream intervention — price the defined diagnostic itself (its commercial question, expected output, and required effort), not a downstream intervention that hasn't been selected yet.",
    "4. Delivery floor: state the legitimate ENIG delivery/economic floor only if it can genuinely be grounded in actual delivery economics present in the supplied context. If no such delivery-economics data is available to you, say so explicitly rather than inventing a floor number — a floor is never an arbitrary market minimum.",
    "5. Market/commercial modifiers: note any legitimate market, currency, or commercial conditions you are applying, in plain language with rationale — never a fixed percentage of value, PPP multiplier, hard-coded regional floor, or automatic currency conversion presented as pricing authority. No such universal rule is canonical unless separately established and approved.",
    "6. Quote and rationale: produce a quoted price and a brief rationale that traces back to the evidence above, if and only if the evidence above is sufficient to price responsibly. Never use a disclosed budget or willingness-to-pay figure as the price or as a factor in setting it — if the context mentions one, treat it only as a scope/fit signal to note in passing, never as part of the pricing basis or rationale. Quote in the SAME currency the supplied value-at-stake evidence is denominated in (e.g. if the evidence is in Ghanaian cedis, quote in GHS) — never default to USD or any other currency not actually present in the supplied context, and never silently convert between currencies.",
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    'Return JSON: {"sufficient": true, "evidence_quality_assessment": "...", "value_at_stake": {"value": n|null, "low": n|null, "high": n|null, "currency": "...", "period": "...", "evidence_type": "directly_measured|client_estimated|derived|assumption", "source": "...", "evidence_quality": "..."}, "intervention_assessment": "...", "delivery_floor_rationale": "...", "market_modifiers_applied": "...", "price": <number>, "currency": "...", "rationale": "..."} only if every step above can be responsibly completed. Otherwise return {"sufficient": false, "reason_if_insufficient": "..."} naming the SPECIFIC missing evidence category (e.g. \'value-at-stake has no applicable time period\', \'value exists only as an unsupported assumption\', \'no evidence source provided\', \'diagnostic purpose is unclear\') — never a generic reason, and never a request for a budget or willingness-to-pay figure as a substitute.',
    "If context is insufficient, state only the missing category of information required, without requesting, naming, or attempting to discover specific sensitive records or client entities.",
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

  // Idempotency guard: re-verifies the Handoff's live Status and claims it
  // (Pending -> Picked-up) at the actual processing boundary, not just
  // trusting the discovery query's Pending filter from moments earlier.
  // This is the fresh-pickup entry point only -- handleQuoteRedoReason
  // re-invokes judgeQuote directly against an already Picked-up/Held
  // Handoff from an in-session redo, which correctly bypasses this guard.
  const claim = await claimPendingHandoff(env, state.handoffId!);
  if (!claim.claimed) {
    console.error(`Finance handlePickup: refused -- ${claim.reason}`);
    await logActivity(env, {
      entry: `Finance pickup rejected — invalid Handoff state`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: claim.reason,
      outcome: "Blocked",
    });
    return state;
  }

  // Business context is reconstructed BEFORE judgeQuote's own logic, so a
  // Notion outage during context read fails closed with the Handoff
  // already claimed (Picked-up) rather than reprocessed by a later
  // duplicate trigger while still nominally Pending.
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
    // Already claimed (Picked-up) above -- move to Held rather than leaving
    // it stuck at Picked-up, so the existing Held->Pending retry path
    // (handleMoreValueContext) can bring it back for exactly one more
    // pickup once the missing context is supplied.
    await updatePage(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(evalResult.insufficientContext.reason.slice(0, 1900)),
    }).catch((err) => console.error(`Finance: failed to mark Handoff ${state.handoffId} Held`, err));
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `*Finance couldn't pick up a quote request* (Handoff ${state.handoffId}).\n\n${evalResult.insufficientContext.reason}\n\nNot proceeding without required sanitized context — send the missing detail and I'll retry.`,
    );
    state.stage = "handoff_held";
    state.awaiting = "value_context_more";
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
    // On the fresh-pickup path the Handoff was already claimed (Picked-up)
    // by handlePickup's idempotency guard before this ever ran -- move it
    // to Held rather than leaving it stuck, so the existing Held->Pending
    // retry path can bring it back. The redo path (awaitingOnInsufficient
    // "quote_redo_reason") started at Held and never left it, so it's
    // already in a recoverable state and needs no extra transition here.
    if (awaitingOnInsufficient === "value_context_more") {
      await updatePage(env, state.handoffId!, {
        Status: select("Held"),
        "Open Questions": richText(`Governance retrieval failed (${missing}).`),
      }).catch((err) => console.error(`Finance: failed to mark Handoff ${state.handoffId} Held`, err));
    }
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Couldn't assess the quote for *${entityToken}* — couldn't retrieve canonical governance from Notion (${missing}). Please try again once resolved.`,
    );
    state.stage = "handoff_held";
    state.awaiting = awaitingOnInsufficient;
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

  // The AI's own "sufficient: true" is never taken as final authority --
  // per the Commercial Value & Pricing Operating Model, a structured
  // judgment must also pass deterministic validation before it's allowed
  // to become a quote. A judgment the AI marked insufficient is held on
  // its own stated reason; one it marked sufficient is held anyway, on the
  // deterministic reason, if validation fails. The AI cannot override this.
  let holdReason: string | null = null;
  if (!judgement || judgement.sufficient !== true) {
    holdReason = judgement?.reason_if_insufficient ?? "Value context insufficient to price responsibly.";
  } else {
    const validation = validateFinanceJudgement(judgement);
    if (!validation.valid) holdReason = validation.reason;
  }

  if (holdReason !== null) {
    const reason = holdReason;
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
    await sendWorkspaceHatMessage(
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

  // holdReason === null guarantees judgement is non-null, sufficient===true,
  // and has already passed validateFinanceJudgement above (price/rationale
  // present and valid) -- safe to treat as authoritative from here on.
  const price = judgement!.price!;
  const currency = judgement!.currency!;
  const rationale = judgement!.rationale ?? "";

  await updatePage(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText(
      `Quoted price: ${currency} ${price}. Rationale: ${rationale}\n\nEvidence quality: ${judgement!.evidence_quality_assessment ?? ""}\nIntervention assessed: ${judgement!.intervention_assessment ?? ""}\nDelivery floor: ${judgement!.delivery_floor_rationale ?? ""}\nMarket modifiers: ${judgement!.market_modifiers_applied ?? ""}`.slice(
        0,
        1900,
      ),
    ),
  });
  await logActivity(env, {
    entry: `Quote judged: ${currency} ${price} — ${matterToken}`,
    type: "Decision",
    area: "Finance",
    decisions: `Value-based quote: ${currency} ${price}`,
    decisionRationale: rationale,
    outcome: "Complete",
  });

  // The quote is a judgment call, not final authority (per the Finance Hat
  // Definition's authority_limits) — it goes to Martin for review before it
  // becomes the authoritative quote Sales is allowed to build a proposal on.
  state.quote = { price, currency, rationale };
  state.stage = "awaiting_quote_approval";
  state.awaiting = undefined;
  state.financeThreadId = financeThreadId;
  if (financeThreadId !== undefined) {
    await setActiveWorkId(env, state.chatId, financeThreadId, state.workId);
  }
  const quoteMessage = `*Finance quote ready* for *${entityToken}*: ${currency} ${price}\n\nRationale: ${rationale}\n\nApprove this quote to send it to Sales for the Draft Proposal?`;
  const quoteButtons = [
    [
      { text: "✅ Approve quote", callback_data: `quote:${state.workId}:approve` },
      { text: "🔁 Redo", callback_data: `quote:${state.workId}:redo` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: "Value-Based Pricing Assessor" }, quoteMessage, quoteButtons);
  state.pendingActionSummary = {
    label: `Finance Quote: ${entityToken}`,
    message: quoteMessage,
    buttons: quoteButtons,
    createdAt: new Date().toISOString(),
  };
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
    await sendWorkspaceHatMessage(
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
  if (state.stage !== "awaiting_quote_approval") {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      "This quote approval has already been resolved -- nothing to do.",
    );
    return state;
  }
  state.pendingActionSummary = undefined;

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
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Got it — why are you requesting a redo for *${state.entityName}*? Tell me what's off or what to take into account, and I'll reassess and get you a new quote to review.`,
    );
    state.stage = "quote_redo_requested";
    state.awaiting = "quote_redo_reason";
    return state;
  }

  if (!state.matterName && state.handoffId) {
    // state.matterName was cached from the Handoff's Matter_Token at pickup
    // time and may simply have been unset then (a data gap on the source
    // Handoff, not something this Hat can invent) -- re-read the live
    // record once before giving up, so correcting it in Notion and
    // re-approving actually is the working retry path the blocked message
    // below describes, rather than a permanent dead end.
    const live = await getPage(env, state.handoffId).catch((err) => {
      console.error(`Finance handleQuoteApproval: re-fetch of Handoff ${state.handoffId} failed`, err);
      return null;
    });
    const liveMatterToken = live ? plainText(live.properties.Matter_Token) : "";
    if (liveMatterToken) {
      state.matterName = liveMatterToken;
      await logActivity(env, {
        entry: `Matter_Token recovered on retry: ${state.entityName ?? state.handoffId}`,
        type: "Decision",
        area: "Finance",
        decisionRationale: "Matter_Token was missing at pickup time but present on the Handoff's live record now -- recovered without re-deriving it.",
        outcome: "Active",
      });
    }
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
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Quote approved, but I can't route it to Sales — this work item has no Matter_Token on record. Please check the Handoff for *${state.entityName ?? state.handoffId}*, add the correct Matter_Token there, then retry (Approve again).`,
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
      `Authoritative quote: ${state.quote?.currency ?? ""} ${state.quote?.price}\nRationale: ${state.quote?.rationale ?? ""}`.slice(0, 1900),
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
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Value-Based Pricing Assessor" },
    `Quote approved — queued for Sales to prepare the Draft Proposal for *${state.entityName}*.`,
  );

  state.stage = "quote_approved";
  state.awaiting = undefined;
  return state;
}

// Exported for unit testing only -- the deterministic validation gate that
// sits between Finance's structured AI judgment and an actual quote. No
// other module imports this; judgeQuote remains the only production call
// site.
export { validateFinanceJudgement };
