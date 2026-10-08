import type { Env, WorkState, ValueAtStake } from "../../types";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import { getPage, plainText, richText, richTextLong, select, title } from "../../notion";
import { generate, type GeneratePromptParts } from "../../ai";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage, withWorkspaceTypingIndicator } from "../../telegram";
import { advanceWorkStatus, continueWorkStatus, finishWorkStatus, startWorkStatus, workStatusHeader } from "../../runtime/workStatus";
import { setActiveWorkId } from "../../sessionRouting";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import { claimPendingHandoff } from "../../handoffLifecycle";
import { createHandoff, updateHandoff } from "../../handoffWriter";
import { STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END, extractLabeledBlock } from "../strategy/strategyAnalyst";
import { parseCommercialValueEvidenceBlock, type CommercialValueEvidenceRecord } from "../sales/commercialValueEvidence";
import { resolveMatterFromText } from "../../identityResolution";
import type { AccessContext } from "../../access";
import { mintApprovalProofForWork, workSessionContext } from "../../access";
import type { ApprovalProof } from "../../types";

/** Opens Finance's own commercial-judgment block within the Finance -> Sales Handoff's combined "Verified Facts & Sources" text -- see handleQuoteApproval. */
export const FINANCE_JUDGMENT_START = "=== FINANCE COMMERCIAL JUDGMENT ===";
/** Closes Finance's commercial-judgment block -- see FINANCE_JUDGMENT_START. */
export const FINANCE_JUDGMENT_END = "=== END FINANCE COMMERCIAL JUDGMENT ===";

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

/**
 * Names the SPECIFIC commercial fact the upstream determination found
 * missing, while keeping the two different gaps apart:
 *
 *   - genuinely MISSING value evidence (no quantified figure exists at all);
 *   - an UNSUPPORTED ASSUMPTION (a figure exists but carries no attribution)
 *     -- a different fact to supply, and never the same request as "no number".
 *
 * Purely a reading of the structured block: no figure is computed, derived,
 * or repaired here, and a budget/willingness-to-pay/investment-tolerance
 * figure is never offered as a substitute (it is context, not evidence).
 */
function describeCommercialValueGap(record: CommercialValueEvidenceRecord): string {
  const figures: ValueAtStake[] = [record.evidence?.valueAtStake, record.evidence?.costOfInaction].filter(
    (f): f is ValueAtStake => f !== undefined,
  );
  const withNumber = figures.filter(
    (f) => typeof f.value === "number" || typeof f.low === "number" || typeof f.high === "number",
  );
  if (withNumber.length === 0) {
    return "a quantified value-at-stake or cost-of-inaction figure is genuinely MISSING from the record (missing evidence, not an unsupported estimate)";
  }
  const attributed = withNumber.find((f) => f.evidenceType && f.evidenceType !== "assumption");
  if (!attributed) {
    return "the only figure on record is an UNSUPPORTED ASSUMPTION -- a number exists but carries no attribution, which is a different gap from having no number at all";
  }
  if (!attributed.source) return "the figure on record has no attributable source";
  if (!attributed.period) return "the figure on record has no applicable time period";
  return "the figure on record does not satisfy the governed value-evidence rules";
}

/**
 * Finance's deterministic hold over the structured upstream Commercial Value
 * Evidence block, applied BEFORE Finance's own AI judgment is even requested.
 *
 * Finance is the sole authority on whether commercial value evidence is
 * sufficient to price, and this is that authority being exercised against
 * the governed upstream determination rather than against the free-text
 * prescription narrative: when the block says the evidence does not satisfy
 * the rule, no amount of narrative wording around it changes that, and a
 * figure cannot be reconstructed from anywhere else. Returns null when the
 * upstream determination IS satisfied (or when there is no structured block
 * to read, e.g. a direct request with no Handoff), in which case the normal
 * judgment + validateFinanceJudgement path decides as before.
 *
 * validateFinanceJudgement itself is unchanged -- this gate does not
 * replace it; a Satisfied determination still has to pass it before any
 * quote exists.
 */
function commercialValueEvidenceHoldReason(record: CommercialValueEvidenceRecord): string | null {
  if (record.determination === "Satisfied") return null;
  const gap = describeCommercialValueGap(record);
  return (
    `The upstream commercial-value determination carried with this request is "${record.determination}": ${record.evidenceText} ` +
    `Specific missing commercial fact: ${gap}. ` +
    `Finance is holding for that specific fact as attributable evidence (source and period stated), not for a budget or willingness-to-pay figure -- those are never the pricing basis. ` +
    `Supply it and the governed evidence will be re-evaluated; the determination will be re-read, never re-derived.`
  );
}

// Canonical Notion governance source for this Hat, verified live in the
// audit that preceded this change. Explicit page ID, not title search, per
// the Universal Role Contract's evidence rule (a consequential source must
// be attributable, not guessed at by name match).
const FINANCE_HAT_DEFINITION_PAGE_ID = "3cecb004-e583-81f9-a52e-e24872a52eff";
/** The Hat the live work status is labelled with -- the same name every Finance message already uses. */
const FINANCE_HAT_NAME = "Value-Based Pricing Assessor";

/**
 * The Access context for an operation performed on behalf of this Work item's
 * own recorded Action, optionally carrying an ApprovalProof a verified
 * approval callback has just minted by consuming the staged quote approval it
 * corresponds to.
 *
 * The Action is NOT named here -- it is read off the Work by
 * `workSessionContext(state)`, so this helper cannot choose which Action its
 * write is judged by.
 *
 * `price`'s only approval-gated governed effect is the outbound
 * Finance -> Sales Handoff it creates (see financeManifest.ts), so a proof is
 * supplied only at that createHandoff. Lifecycle transitions on the inbound
 * Handoff this work item already owns correctly need none.
 */
function financeAccess(state: WorkState, proof?: ApprovalProof) {
  return workSessionContext(state, proof);
}

function buildFinancePromptParts(hatDefinition: string, universalRoleContract: string): Pick<GeneratePromptParts, "persona" | "behavior" | "skillContent" | "context"> {
  return {
    persona:
      "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for your role, responsibilities, authority limits, and stop conditions — follow them exactly as written.",
    behavior: ["=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===", universalRoleContract, "=== HAT DEFINITION ===", hatDefinition].join("\n\n"),
    skillContent: [
      "=== COMMERCIAL VALUE & PRICING OPERATING MODEL — CANONICAL JUDGMENT SEQUENCE ===",
      "Work through these six steps, in order, using only the value context supplied below. State your reasoning for each briefly in the corresponding JSON field.",
      "1. Evidence quality: assess the attribution and quality of the numerical evidence supplied (directly_measured, client_estimated, derived, or assumption). Never treat an assumption as equivalent to measured or client-estimated evidence.",
      "2. Value-at-stake assessment: establish a value-at-stake range (or a single figure only where the evidence genuinely supports one) with currency, applicable period, evidence type, and source, from the supplied evidence only. Never invent a figure not attributable to the supplied context, and never derive one from an unrelated figure (e.g. general company turnover) without the context itself making that derivation explicit.",
      "3. Intervention/delivery assessment: identify the specific intervention or diagnostic being priced and what it requires to deliver. Diagnosis-first engagements may be priced without a predetermined downstream intervention — price the defined diagnostic itself (its commercial question, expected output, and required effort), not a downstream intervention that hasn't been selected yet.",
      "4. Delivery floor: state the legitimate ENIG delivery/economic floor only if it can genuinely be grounded in actual delivery economics present in the supplied context. If no such delivery-economics data is available to you, say so explicitly rather than inventing a floor number — a floor is never an arbitrary market minimum.",
      "5. Market/commercial modifiers: note any legitimate market, currency, or commercial conditions you are applying, in plain language with rationale — never a fixed percentage of value, PPP multiplier, hard-coded regional floor, or automatic currency conversion presented as pricing authority. No such universal rule is canonical unless separately established and approved.",
      "6. Quote and rationale: produce a quoted price and a brief rationale that traces back to the evidence above, if and only if the evidence above is sufficient to price responsibly. Never use a disclosed budget or willingness-to-pay figure as the price or as a factor in setting it — if the context mentions one, treat it only as a scope/fit signal to note in passing, never as part of the pricing basis or rationale. Quote in the SAME currency the supplied value-at-stake evidence is denominated in (e.g. if the evidence is in Ghanaian cedis, quote in GHS) — never default to USD or any other currency not actually present in the supplied context, and never silently convert between currencies.",
    ].join("\n\n"),
    context: [
      "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
      'Return JSON: {"sufficient": true, "evidence_quality_assessment": "...", "value_at_stake": {"value": n|null, "low": n|null, "high": n|null, "currency": "...", "period": "...", "evidence_type": "directly_measured|client_estimated|derived|assumption", "source": "...", "evidence_quality": "..."}, "intervention_assessment": "...", "delivery_floor_rationale": "...", "market_modifiers_applied": "...", "price": <number>, "currency": "...", "rationale": "..."} only if every step above can be responsibly completed. Otherwise return {"sufficient": false, "reason_if_insufficient": "..."} naming the SPECIFIC missing evidence category (e.g. \'value-at-stake has no applicable time period\', \'value exists only as an unsupported assumption\', \'no evidence source provided\', \'diagnostic purpose is unclear\') — never a generic reason, and never a request for a budget or willingness-to-pay figure as a substitute.',
      "If context is insufficient, state only the missing category of information required, without requesting, naming, or attempting to discover specific sensitive records or client entities.",
    ].join("\n\n"),
  };
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
/**
 * Reads the Handoff this Work item was picked up from, and evaluates whether
 * its recorded tokens/evidence are sufficient to price the Matter at all.
 *
 * Takes the caller's AccessContext rather than building one: the read is
 * judged by the Work that is performing it, and this helper is not itself a
 * registered operation. It is a read, so the Work's recorded Action only has
 * to permit reading -- which is checked, not assumed.
 */
export async function resolveHandoffBusinessContext(
  env: Env,
  handoffId: string,
  access: AccessContext,
): Promise<HandoffContextEvaluationResult> {
  try {
    const handoff = await getPage(env, handoffId, access);
    const verifiedFacts = plainText(handoff.properties["Verified Facts & Sources"]);
    // Required Next Action is where a human naturally writes refinement
    // guidance when returning a Held Handoff to Pending directly in Notion
    // -- see strategyAnalyst.ts's resolveStrategyHandoffContext for the
    // confirmed live incident this mirrors. Always folded in so guidance
    // written there actually reaches the pricing judgment.
    const requiredNextAction = plainText(handoff.properties["Required Next Action"]);
    const judgmentContext = requiredNextAction ? `${verifiedFacts}\n\n=== Required Next Action (from the Handoff record) ===\n${requiredNextAction}` : verifiedFacts;
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

/**
 * Entry point for a fresh Finance quote Martin originates directly in
 * Cowork chat, with no upstream Handoff -- the direct_request origination
 * path (ENIG Operating Model design doc, Migration path Step 4), mirroring
 * strategy.handleDirectRequest exactly. Martin must always name an
 * existing Matter explicitly (its ENIG token, e.g. "MAT-20") -- there is
 * no upstream Unit here to have already established one -- resolved via
 * the same shared resolveMatterFromText Strategy uses, never AI-guessed.
 * Once resolved, joins the identical shared judgeQuote every Handoff
 * pickup already uses -- no parallel pricing implementation.
 *
 * A direct-entry quote completes standalone once approved: it never
 * carries a Strategy boundary representation (there is no upstream
 * Strategy -> Finance Handoff to read one from) and never creates a
 * Finance -> Sales Handoff -- see handleQuoteApproval's own handling of
 * !state.handoffId.
 */
export async function handleDirectRequest(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const resolved = await resolveMatterFromText(env, text);
  if (!resolved) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      "Which Matter is this about? Include its token (e.g. MAT-20) and I'll pick up the pricing assessment from there.",
    );
    state.stage = "finance_blocked";
    state.awaiting = "finance_direct_request_matter";
    return state;
  }

  const evalResult = evaluateHandoffContext(
    {
      entityToken: resolved.entityToken,
      matterToken: resolved.matterToken,
      sanitizedContext: text,
      provenance: "martin:direct_request",
      requiredCategory: "historical business-impact range for value-based pricing",
    },
    "finance.quote_judgment",
  );
  if (!evalResult.success) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Couldn't start this pricing assessment.\n\n${evalResult.insufficientContext.reason}`,
    );
    state.stage = "finance_blocked";
    state.awaiting = "finance_direct_request_matter";
    return state;
  }

  // Token resolution has succeeded at this point -- any further hold
  // inside judgeQuote (insufficient evidence, failed validation) is about
  // evidence sufficiency, not Matter identity, so it must route to
  // handleDirectRequestContext, never back through token resolution.
  state.entryType = "direct_request";
  state.financeJudgmentContext = evalResult.contract.sanitizedContext;

  return judgeQuote(env, state, {
    entityToken: evalResult.contract.entityToken,
    matterToken: evalResult.contract.matterToken ?? "",
    judgmentContext: evalResult.contract.sanitizedContext,
    financeThreadId: state.threadId,
    awaitingOnInsufficient: "finance_direct_request_context",
    activityLabel: "started a pricing assessment directly from chat (no upstream Handoff)",
  });
}

/**
 * Continuation once a direct request was held for a missing/unresolved
 * Matter token -- re-attempts resolution against Martin's follow-up text
 * exactly as handleDirectRequest does on first entry, rather than a
 * separate, drifting implementation.
 */
export async function handleDirectRequestClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  return handleDirectRequest(env, state, text);
}

/**
 * Continuation once a direct request's Matter was resolved but judgeQuote
 * held for insufficient evidence -- appends Martin's follow-up to the
 * context already established (state.financeJudgmentContext, this work
 * item's own source of truth, since there is no Handoff record to
 * re-read it from) and re-runs judgeQuote, mirroring handleQuoteRedoReason's
 * augmentation pattern for the Handoff-based path.
 */
export async function handleDirectRequestContext(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const augmentedContext = `${state.financeJudgmentContext ?? ""}\n\nAdditional value context: ${text}`;
  state.financeJudgmentContext = augmentedContext;

  return judgeQuote(env, state, {
    entityToken: state.entityToken ?? "",
    matterToken: state.matterToken ?? "",
    judgmentContext: augmentedContext,
    financeThreadId: state.financeThreadId ?? state.threadId,
    awaitingOnInsufficient: "finance_direct_request_context",
    activityLabel: "resumed a directly-requested pricing assessment following Martin's additional context",
  });
}

export async function handlePickup(env: Env, state: WorkState, _skills: ResolvedActionSkillSet): Promise<WorkState> {
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
  const claim = await claimPendingHandoff(env, state.handoffId!, workSessionContext(state));
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
  await startWorkStatus(env, state, FINANCE_HAT_NAME, workStatusHeader(FINANCE_HAT_NAME, state, "picking up a quote request"), "Reading the Strategy -> Finance Handoff");
  const evalResult = await resolveHandoffBusinessContext(env, state.handoffId!, financeAccess(state));
  if (!evalResult.success) {
    console.error(`Finance handlePickup: context evaluation failed for handoff ${state.handoffId}: ${evalResult.insufficientContext.reason}`);
    await finishWorkStatus(env, state, "⛔ Couldn't pick this up -- the reason is below.", "failed");
    await logActivity(env, {
      entry: `Finance pickup blocked [Insufficient Context] — ${evalResult.insufficientContext.category}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    // Already claimed (Picked-up) above -- move to Held rather than leaving
    // it stuck at Picked-up, so Finance's own clarification loop
    // (handleValueContextClarification, the awaiting "value_context_more"
    // continuation) can re-evaluate it exactly once the missing context is
    // supplied.
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(evalResult.insufficientContext.reason.slice(0, 1900)),
    }, workSessionContext(state)).catch((err) => console.error(`Finance: failed to mark Handoff ${state.handoffId} Held`, err));
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
  state.entityToken = entityToken;
  state.matterToken = matterToken;

  // Continues the pickup's status run, or starts one for a redo/direct
  // request/clarification re-run, which reach this judgment on their own.
  await continueWorkStatus(env, state, FINANCE_HAT_NAME, workStatusHeader(FINANCE_HAT_NAME, state, "quote"), "Loading the Value-Based Pricing Assessor's governance from Notion");
  if (state.workStatus) state.workStatus.header = workStatusHeader(FINANCE_HAT_NAME, state, "quote");
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
    await finishWorkStatus(env, state, "⛔ Couldn't load the governance -- the reason is below.", "failed");
    await logActivity(env, {
      entry: `Finance quote judgment blocked — governance retrieval failed: ${matterToken}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: `Could not retrieve canonical governance from Notion (${missing}). Refusing to execute without it.`,
      outcome: "Blocked",
    });
    // On the fresh-pickup path the Handoff was already claimed (Picked-up)
    // by handlePickup's idempotency guard before this ever ran -- move it
    // to Held rather than leaving it stuck at Picked-up, so Finance's own
    // clarification loop (handleValueContextClarification, the awaiting
    // "value_context_more" continuation) can re-evaluate it once the missing
    // detail is supplied. The redo path (awaitingOnInsufficient
    // "quote_redo_reason") started at Held and never left it, so it's
    // already in a recoverable state and needs no extra transition here.
    if (awaitingOnInsufficient === "value_context_more") {
      await updateHandoff(env, state.handoffId!, {
        Status: select("Held"),
        "Open Questions": richText(`Governance retrieval failed (${missing}).`),
      }, financeAccess(state)).catch((err) => console.error(`Finance: failed to mark Handoff ${state.handoffId} Held`, err));
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

  if (state.handoffId) {
    await updateHandoff(env, state.handoffId, { Status: select("Picked-up") }, financeAccess(state));
  }
  await logActivity(env, {
    entry: `Finance ${activityLabel}: ${matterToken}`,
    type: "Activity",
    area: "Finance",
    activity: `Value-Based Pricing Assessor ${activityLabel}.`,
    outcome: "Active",
  });

  // Structured upstream Commercial Value Evidence, parsed BEFORE any
  // reliance on the free-text prescription content: Finance must not have to
  // hunt for value evidence in narrative prose. When the block is present
  // it is presented to the judgment ONCE, as a labelled structured fact, and
  // removed from the narrative below so the same bytes are not also floating
  // around as prose. When it is absent (a direct request with no Handoff, or
  // a legacy Handoff created before this contract) nothing changes: the
  // existing free-text judgment path decides exactly as it did before.
  await advanceWorkStatus(env, state, "Reading the upstream Commercial Value Evidence block");
  const valueEvidence = parseCommercialValueEvidenceBlock(judgmentContext);
  const structuredValueSection = valueEvidence.ok
    ? [
        "=== UPSTREAM COMMERCIAL VALUE EVIDENCE (structured -- carried verbatim Sales -> Strategy -> Finance) ===",
        valueEvidence.block,
        `Determination: ${valueEvidence.record.determination} -- ${valueEvidence.record.evidenceText}`,
        "This block is the governed upstream determination of the commercial value evidence. Treat it as the structured fact for value: never re-derive, re-estimate, paraphrase, or replace it, and never lift a value figure out of the narrative below when it names what is missing. A disclosed budget or willingness-to-pay figure, investment tolerance, a geographic adjustment, or a currency conversion is never the pricing basis, and no figure is reconstructed from the Measurement Baseline.",
        "=== END UPSTREAM COMMERCIAL VALUE EVIDENCE ===",
      ].join("\n")
    : "";
  const narrativeContext = valueEvidence.ok ? judgmentContext.split(valueEvidence.block).join("") : judgmentContext;
  const situation = [
    `Entity: ${entityToken}`,
    structuredValueSection,
    `Proposed intervention and value context:\n${narrativeContext.trim()}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

  // Deterministic pre-check against the structured block (see
  // commercialValueEvidenceHoldReason): an upstream "Insufficient Evidence"
  // holds here, naming the specific missing commercial fact, WITHOUT the AI
  // being asked to price something the governed evidence says is not
  // established. No structured block (direct request / legacy Handoff) ->
  // null -> the judgment and validateFinanceJudgement below decide as always.
  //
  // Once Martin has actually supplied the fact that was asked for
  // (state.valueEvidenceFactSupplied), the block is no longer the whole
  // picture -- its bytes are upstream-authored and cannot be edited here --
  // so the hold steps aside and the EXISTING path re-evaluates the combined
  // evidence: the structured block (still naming what was missing) plus the
  // supplied fact, gated by the unchanged validateFinanceJudgement. That is
  // how a hold closes without any new pricing authority being created.
  const structuredHoldReason =
    valueEvidence.ok && !state.valueEvidenceFactSupplied ? commercialValueEvidenceHoldReason(valueEvidence.record) : null;
  if (valueEvidence.ok) {
    console.log(
      `Finance judgeQuote: structured Commercial Value Evidence parsed for work ${state.workId} (determination: ${valueEvidence.record.determination})`,
    );
  }

  let judgement: PriceJudgement | null = null;
  let holdReason: string | null = structuredHoldReason;
  if (holdReason === null) {
    await advanceWorkStatus(env, state, "Judging the value-based price");
    judgement = await withWorkspaceTypingIndicator(env, () =>
      generate<PriceJudgement>(env, {
        taskId: "finance.quote_judgment",
        mode: "json",
        parts: { ...buildFinancePromptParts(hatDefinition, universalRoleContract), situation },
      }),
    );
    await advanceWorkStatus(env, state, "Validating the price judgment");

    // The AI's own "sufficient: true" is never taken as final authority --
    // per the Commercial Value & Pricing Operating Model, a structured
    // judgment must also pass deterministic validation before it's allowed
    // to become a quote. A judgment the AI marked insufficient is held on
    // its own stated reason; one it marked sufficient is held anyway, on the
    // deterministic reason, if validation fails. The AI cannot override this.
    if (!judgement || judgement.sufficient !== true) {
      holdReason = judgement?.reason_if_insufficient ?? "Value context insufficient to price responsibly.";
    } else {
      const validation = validateFinanceJudgement(judgement);
      if (!validation.valid) holdReason = validation.reason;
    }
  }

  if (holdReason !== null) {
    const reason = holdReason;
    await finishWorkStatus(env, state, "⛔ Held -- the reason is below.", "failed");
    if (state.handoffId) {
      await updateHandoff(env, state.handoffId, {
        Status: select("Held"),
        "Open Questions": richText(reason),
      }, financeAccess(state));
    }
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
      `*Finance has held the quote request* for *${entityToken}*.\n\n${reason}\n\n(A disclosed budget or willingness-to-pay figure on its own can never be used as the pricing basis — if that's the gap, share the expected business impact instead: revenue growth, cost savings, efficiency gains, or customer acquisition.)\n\nSend the missing detail and I'll reassess.`,
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

  if (state.handoffId) {
    await updateHandoff(env, state.handoffId, {
      Status: select("Closed"),
      "Work Completed": richText(
        `Quoted price: ${currency} ${price}. Rationale: ${rationale}\n\nEvidence quality: ${judgement!.evidence_quality_assessment ?? ""}\nIntervention assessed: ${judgement!.intervention_assessment ?? ""}\nDelivery floor: ${judgement!.delivery_floor_rationale ?? ""}\nMarket modifiers: ${judgement!.market_modifiers_applied ?? ""}`.slice(
          0,
          1900,
        ),
      ),
    }, financeAccess(state));
  }
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
  // A direct-entry quote (no upstream Handoff) has no Redo loop yet -- see
  // handleQuoteApproval's own doc comment on its "!approved" branch -- and
  // never routes to Sales on approval, so its message/buttons say so
  // rather than promising either.
  const quoteMessage = state.handoffId
    ? `*Finance quote ready* for *${entityToken}*: ${currency} ${price}\n\nRationale: ${rationale}\n\nApprove this quote to send it to Sales for the Draft Proposal?`
    : `*Finance quote ready* for *${entityToken}*: ${currency} ${price}\n\nRationale: ${rationale}\n\nApprove this quote?`;
  const quoteButtons = state.handoffId
    ? [
        [
          { text: "✅ Approve quote", callback_data: `quote:${state.workId}:approve` },
          { text: "🔁 Redo", callback_data: `quote:${state.workId}:redo` },
        ],
      ]
    : [[{ text: "✅ Approve quote", callback_data: `quote:${state.workId}:approve` }]];
  await finishWorkStatus(env, state, "✅ Quote ready below -- awaiting your approval.", "succeeded");
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
 * judgment, not supplying business facts another Unit owns — so it acts
 * immediately rather than requeuing the Handoff Pending for cron discovery
 * to re-pick-up asynchronously; no Unit boundary is being crossed. The
 * Handoff's own "Verified Facts & Sources" is rewritten with the augmented
 * context via richTextLong (never a 1,900-char truncation), so the Strategy
 * Boundary Representation and Commercial Value Evidence blocks inside it
 * survive a redo intact.
 */
export async function handleQuoteRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const financeThreadId = state.financeThreadId ?? state.threadId;

  const evalResult = await resolveHandoffBusinessContext(env, state.handoffId!, financeAccess(state));
  if (!evalResult.success) {
    console.error(`Finance redo blocked — context evaluation failed for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Finance redo blocked — insufficient business context: ${state.entityToken}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Couldn't read the Handoff record for *${state.entityToken}* to apply your reasoning: ${evalResult.insufficientContext.reason}`,
    );
    return state;
  }

  const augmentedContext = `${evalResult.contract.sanitizedContext}\n\nMartin's redo reasoning: ${reasonText}`;
  await updateHandoff(env, state.handoffId!, {
    "Verified Facts & Sources": richTextLong(augmentedContext),
  }, financeAccess(state));

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
 * Finance's own clarification loop for Finance's own governed evidence gate
 * (`awaiting: "value_context_more"`), replacing the Sales-side handler this
 * state used to dispatch to (which overwrote the Handoff's
 * "Verified Facts & Sources" -- destroying the Strategy Boundary
 * Representation and Commercial Value Evidence blocks -- from a Work item
 * that never had `state.proposedIntervention` populated).
 *
 * Finance owns the hold, so Finance owns the request: Martin replies with
 * the exact commercial fact the hold named, and this handler
 *
 *   1. re-reads the Handoff (never a Sales-side reconstruction),
 *   2. appends Martin's fact to the IN-MEMORY judgment context ONLY -- the
 *      record's blocks are never rewritten, so both survive untouched,
 *   3. re-runs the SAME judgeQuote, whose structured-block parsing re-reads
 *      the upstream determination and whose validateFinanceJudgement is
 *      unchanged. No new pricing authority is created by a clarification:
 *      the supplied fact still has to satisfy the existing gate.
 *
 * The same cross-Unit discipline as handleQuoteRedoReason: acts
 * in-session, no new workflow mechanism, no requeue.
 */
export async function handleValueContextClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const financeThreadId = state.financeThreadId ?? state.threadId;
  const suppliedFact = text.trim();

  if (!suppliedFact) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      "What specific commercial fact should I re-evaluate? Name the value, what it attaches to, where it came from, and the period it covers -- I won't price on a budget or willingness-to-pay figure.",
    );
    state.stage = "handoff_held";
    state.awaiting = "value_context_more";
    return state;
  }

  const evalResult = await resolveHandoffBusinessContext(env, state.handoffId!, financeAccess(state));
  if (!evalResult.success) {
    console.error(`Finance value-context clarification blocked — context evaluation failed for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Finance value-context clarification blocked — insufficient business context: ${state.entityToken}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Couldn't re-read the Handoff record for *${state.entityToken}* to apply the fact you supplied: ${evalResult.insufficientContext.reason}\n\nThe request stays held and nothing on the record was changed.`,
    );
    state.stage = "handoff_held";
    state.awaiting = "value_context_more";
    return state;
  }

  // The supplied fact joins the IN-MEMORY context only. The Handoff's
  // "Verified Facts & Sources" -- carrying the approved Strategy Boundary
  // Representation and the upstream Commercial Value Evidence block -- is
  // deliberately NOT written here, so no clarification can destroy the
  // blocks Finance's judgment is grounded in.
  const augmentedContext = `${evalResult.contract.sanitizedContext}\n\nCommercial fact supplied by Martin in clarification: ${suppliedFact}`;
  state.valueEvidenceFactSupplied = true;

  return judgeQuote(env, state, {
    entityToken: evalResult.contract.entityToken,
    matterToken: evalResult.contract.matterToken ?? "",
    judgmentContext: augmentedContext,
    financeThreadId,
    awaitingOnInsufficient: "value_context_more",
    activityLabel: "re-evaluated the governed value evidence after Martin supplied the missing commercial fact",
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
    // A direct-entry quote (no upstream Handoff) has no Redo loop yet --
    // its own quoteButtons omit this button, so this only fires on a
    // stale callback. Fail closed with a clear message rather than
    // crashing on the unconditional updateHandoff below, which assumes a
    // Handoff exists.
    if (!state.handoffId) {
      await sendWorkspaceHatMessage(
        env,
        { ...state, hat: "Value-Based Pricing Assessor" },
        `Redo isn't yet supported for a directly-requested quote -- send a new direct request with the additional context and I'll reassess from scratch.`,
      );
      return state;
    }

    await updateHandoff(env, state.handoffId, {
      Status: select("Held"),
      "Open Questions": richText("Martin requested a redo of the quote. Awaiting his reasoning before reassessing."),
    }, financeAccess(state));
    await logActivity(env, {
      entry: `Finance quote redo requested: ${state.matterToken ?? state.entityToken}`,
      type: "Decision",
      area: "Finance",
      decisionRationale: "Martin requested a redo of the computed quote.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Got it — why are you requesting a redo for *${state.entityToken}*? Tell me what's off or what to take into account, and I'll reassess and get you a new quote to review.`,
    );
    state.stage = "quote_redo_requested";
    state.awaiting = "quote_redo_reason";
    return state;
  }

  if (!state.handoffId) {
    // Direct-entry quote (no upstream Strategy -> Finance Handoff):
    // completes standalone. There is no Strategy boundary representation
    // to carry forward and, per the decision behind this path, no
    // Finance -> Sales Handoff is created -- a direct-entry quote was
    // never part of that chain. Any Sales involvement is a separate,
    // later action Martin takes himself.
    await logActivity(env, {
      entry: `Finance quote approved (direct request): ${state.matterToken ?? state.entityToken}`,
      type: "Decision",
      area: "Finance",
      decisions: `Approved quote: ${state.quote?.currency ?? ""} ${state.quote?.price ?? ""}`,
      decisionRationale: state.quote?.rationale ?? "",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Quote approved: ${state.quote?.currency ?? ""} ${state.quote?.price ?? ""} for *${state.entityToken}*.`,
    );
    state.stage = "quote_approved";
    state.awaiting = undefined;
    return state;
  }

  if (!state.matterToken && state.handoffId) {
    // state.matterToken was cached from the Handoff's Matter_Token at pickup
    // time and may simply have been unset then (a data gap on the source
    // Handoff, not something this Hat can invent) -- re-read the live
    // record once before giving up, so correcting it in Notion and
    // re-approving actually is the working retry path the blocked message
    // below describes, rather than a permanent dead end.
    const live = await getPage(env, state.handoffId, workSessionContext(state)).catch((err) => {
      console.error(`Finance handleQuoteApproval: re-fetch of Handoff ${state.handoffId} failed`, err);
      return null;
    });
    const liveMatterToken = live ? plainText(live.properties.Matter_Token) : "";
    if (liveMatterToken) {
      state.matterToken = liveMatterToken;
      await logActivity(env, {
        entry: `Matter_Token recovered on retry: ${state.entityToken ?? state.handoffId}`,
        type: "Decision",
        area: "Finance",
        decisionRationale: "Matter_Token was missing at pickup time but present on the Handoff's live record now -- recovered without re-deriving it.",
        outcome: "Active",
      });
    }
  }

  if (!state.matterToken) {
    console.error(`Finance handleQuoteApproval: state.matterToken missing for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Quote approval blocked — no Matter_Token on record: ${state.entityToken ?? state.handoffId}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: "This work item has no Matter_Token, so the Finance -> Sales follow-up Handoff can't identify which Matter it's for.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Quote approved, but I can't route it to Sales — this work item has no Matter_Token on record. Please check the Handoff for *${state.entityToken ?? state.handoffId}*, add the correct Matter_Token there, then retry (Approve again).`,
    );
    return state;
  }

  // Retrieve the ORIGINAL Strategy -> Finance Handoff (state.handoffId still
  // refers to it -- reassigned below only once the Finance -> Sales Handoff
  // exists) and carry its Strategy boundary block forward VERBATIM. Finance
  // never parses, re-derives, or reformats the Strategy-authored content --
  // it locates the exact substring Strategy already wrote and re-embeds it,
  // unchanged, inside the same start/end markers Strategy itself used. This
  // is the routing change per the Strategy -> Finance -> Sales boundary
  // inspection: Sales's upstream source of Strategy facts becomes this
  // Handoff, never state.strategyProposal.
  const sourceHandoffId = state.handoffId;
  let strategyBoundaryBlock: string | null = null;
  if (sourceHandoffId) {
    const sourceHandoff = await getPage(env, sourceHandoffId, workSessionContext(state)).catch((err) => {
      console.error(`Finance handleQuoteApproval: could not re-read source Strategy Handoff ${sourceHandoffId}`, err);
      return null;
    });
    if (sourceHandoff) {
      const sourceText = plainText(sourceHandoff.properties["Verified Facts & Sources"]);
      strategyBoundaryBlock = extractLabeledBlock(sourceText, STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END);
    }
  }

  if (!strategyBoundaryBlock) {
    console.error(`Finance handleQuoteApproval: no Strategy boundary representation found on source Handoff ${sourceHandoffId} for work ${state.workId}`);
    await logActivity(env, {
      entry: `Quote approval blocked — no Strategy boundary representation on source Handoff: ${state.matterToken ?? state.entityToken}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: `The original Strategy -> Finance Handoff (${sourceHandoffId ?? "unknown"}) does not carry a Strategy boundary representation Finance can pass through -- refusing to create the Finance -> Sales Handoff without it, rather than routing Sales an incomplete boundary.`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Value-Based Pricing Assessor" },
      `Quote approved, but I can't route it to Sales — the original Strategy Handoff for *${state.entityToken}* doesn't carry a Strategy boundary representation I can pass through. Please check Handoff ${sourceHandoffId ?? "(unknown)"}, then retry (Approve again).`,
    );
    return state;
  }

  const combinedVerifiedFactsAndSources = [
    `${STRATEGY_BOUNDARY_START}\n${strategyBoundaryBlock}\n${STRATEGY_BOUNDARY_END}`,
    `${FINANCE_JUDGMENT_START}\nAuthoritative quote: ${state.quote?.currency ?? ""} ${state.quote?.price}\nRationale: ${state.quote?.rationale ?? ""}\n${FINANCE_JUDGMENT_END}`,
  ].join("\n\n");

  const { page: followUp } = await createHandoff(
    env,
    {
      Handoff: title(`Draft Proposal — ${state.matterToken}`),
      "From Unit": select("Finance"),
      "From Hat": richText("Value-Based Pricing Assessor"),
      "To Unit": select("Sales"),
      "To Hat": richText("Sales Executive"),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(`Value-based quote approved by Martin for ${state.matterToken}; ready for Draft Proposal preparation.`),
      "Expected Output": richText("Complete Draft Proposal presented to Martin for review and authorization."),
      Entity_Token: richText(state.entityToken ?? ""),
      Matter_Token: richText(state.matterToken ?? ""),
      "Verified Facts & Sources": richTextLong(combinedVerifiedFactsAndSources),
    },
    { entityToken: state.entityToken ?? "", matterToken: state.matterToken ?? "" },
    // The Finance -> Sales Handoff is the governed effect Martin's quote
    // approval authorizes, so consuming the staged approval here is what
    // mints the proof that permits this create. The callback's own guard
    // has already rejected a replayed Approve by the time this runs.
    financeAccess(
      state,
      mintApprovalProofForWork(state, env.HANDOFFS_DATA_SOURCE_ID),
    ),
  );
  state.handoffId = followUp.id;
  await env.STATE_KV.put(`handoff_workitem:${followUp.id}`, state.workId);

  await logActivity(env, {
    entry: `Quote approved — routed to Sales for Draft Proposal: ${state.matterToken}`,
    type: "Activity",
    area: "Finance",
    activity: `Handoff ${followUp.id} — quote approved and queued for Sales.`,
    nextActions: "Sales to pick up and prepare the Draft Proposal.",
    outcome: "Complete",
  });
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Value-Based Pricing Assessor" },
    `Quote approved — queued for Sales to prepare the Draft Proposal for *${state.entityToken}*.`,
  );
  // See WorkState.pendingHandoffAutoCheck's doc comment.
  state.pendingHandoffAutoCheck = true;

  state.stage = "quote_approved";
  state.awaiting = undefined;
  return state;
}

// Exported for unit testing only -- the deterministic validation gate that
// sits between Finance's structured AI judgment and an actual quote. No
// other module imports this; judgeQuote remains the only production call
// site.
export { validateFinanceJudgement };
