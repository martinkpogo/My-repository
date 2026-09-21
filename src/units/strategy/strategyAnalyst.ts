import type { Env, Unit, WorkState } from "../../types";
import { createPage, getPage, plainText, richText, select, title, updatePage } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { editHatMessage, sendWorkspaceHatMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";

/**
 * Strategy Analyst execution -- one dedicated runtime for the Strategy
 * Unit's single active Hat, mirroring researchAnalyst.ts's own structure
 * exactly (governance retrieval -> Handoff context reconstruction ->
 * structured AI judgment -> deterministic post-check -> delivery ->
 * optional Martin-approved downstream Handoff). No parallel architecture
 * introduced -- this reuses the same WorkSession/Handoff/closed-context/
 * logging/Telegram mechanisms every other Unit already uses.
 */

// Canonical Notion governance source for this Hat, verified live before
// implementation. Explicit page ID, not title search, per the Universal
// Role Contract's evidence rule.
const STRATEGY_ANALYST_HAT_DEFINITION_PAGE_ID = "3e2cb004-e583-8115-8b1c-e479690a1264";

const HAT_NAME = "Strategy Analyst";

export interface StrategySituation {
  symptoms?: string;
  businessConditions?: string;
  constraints?: string;
  consequences?: string;
  stakeholders?: string;
  objectives?: string;
}

export interface StrategyDiagnosisSteps {
  symptom?: string;
  problem?: string;
  cause?: string;
  /**
   * Whether the stated cause is actually supported by the supplied
   * evidence, per the Hat Definition's "Do not assert causation without
   * sufficient support." This is never taken on trust -- see
   * evaluateCausationDiscipline, which forces the whole result to a
   * blocked/insufficient state if a recommendation rests on causation the
   * model itself did not mark as supported.
   */
  causationSupported?: boolean;
  constraint?: string;
  consequence?: string;
}

export interface StrategicProblemFraming {
  statement?: string;
  whyItMatters?: string;
  keyDrivers?: string;
  strategicTension?: string;
  materialUncertainty?: string;
}

export interface StrategicOption {
  name: string;
  intendedEffect?: string;
  rationale?: string;
  evidenceBasis?: string;
  assumptions?: string;
  constraintsRisks?: string;
  conditionsForSuccess?: string;
}

/**
 * The full structured output of a Strategy diagnosis. `sufficient: false`
 * means Strategy stopped per one of the Hat Definition's own stop
 * conditions -- everything below `blockedReason` is then absent, never
 * partially filled with a guess.
 */
export interface StrategyDiagnosisResult {
  sufficient: boolean;
  blockedCategory?: string;
  blockedReason?: string;
  situation?: StrategySituation;
  diagnosis?: StrategyDiagnosisSteps;
  strategicProblem?: StrategicProblemFraming;
  options?: StrategicOption[];
  recommendedDirection?: string;
  recommendationRationale?: string;
  /** Required whenever sufficient=true but no recommendedDirection is given -- states what must be resolved first, per step 6 of the operating procedure. */
  noRecommendationReason?: string;
  evidenceSources?: string;
  assumptions?: string;
  unresolvedQuestions?: string;
}

/**
 * Reconstructs the strategic question and supplied context directly from
 * the Handoff's own canonical Notion record, evaluated through the same
 * closed-context contract Finance and R&I use. Identity is read as the
 * Entity_Token / Matter_Token the sending Unit embedded on the Handoff,
 * never a real Name -- this Hat never resolves those tokens by traversing
 * or discovering unrelated records.
 */
export async function resolveStrategyHandoffContext(env: Env, handoffId: string): Promise<HandoffContextEvaluationResult> {
  try {
    const handoff = await getPage(env, handoffId);
    const sanitizedContext = plainText(handoff.properties["Verified Facts & Sources"]) || plainText(handoff.properties.Reason);
    const entityToken = plainText(handoff.properties.Entity_Token);
    const matterToken = plainText(handoff.properties.Matter_Token);

    return evaluateHandoffContext(
      {
        handoffId,
        entityToken,
        matterToken,
        sanitizedContext,
        provenance: `notion:handoff:${handoffId}`,
        requiredCategory: "strategic question and supplied business-situation context",
      },
      "strategy.diagnosis",
    );
  } catch (err) {
    console.error(`Strategy Handoff context reconstruction failed for ${handoffId}`, err);
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

async function sendStrategyInProgressAck(env: Env, state: WorkState): Promise<void> {
  state.strategyProgressMessageId = await sendWorkspaceHatMessage(
    env,
    { ...state, hat: HAT_NAME },
    "🧭 Diagnosing this now -- establishing the situation before proposing any direction. I'll follow up here once it's done.",
  );
}

async function advanceStrategyProgress(env: Env, state: WorkState, stageText: string): Promise<void> {
  if (state.strategyProgressMessageId === undefined) return;
  await editHatMessage(env, state, state.strategyProgressMessageId, `🧭 ${stageText}`);
}

interface StrategyGovernance {
  hatDefinition: string;
  universalRoleContract: string;
}

async function getStrategyGovernance(env: Env): Promise<StrategyGovernance | null> {
  const [hatDefinition, universalRoleContract] = await Promise.all([
    getGovernance(env, STRATEGY_ANALYST_HAT_DEFINITION_PAGE_ID, "Strategy Analyst Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);
  if (!hatDefinition || !universalRoleContract) return null;
  return { hatDefinition, universalRoleContract };
}

function buildDiagnosisSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Strategy Analyst Hat, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for role, authority limits, boundaries, and stop conditions -- follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution mechanics -- not part of the governance above) ===",
    "Work through the canonical operating procedure: (1) establish the strategic question -- stop if materially ambiguous; (2) establish the situation (symptoms, business conditions, constraints, consequences, stakeholders, objectives); (3) diagnose using Symptom -> Problem -> Cause -> Constraint -> Consequence, never asserting causation without sufficient support; (4) frame the strategic problem (what it is, why it matters, key drivers, the strategic tension/decision, material uncertainty); (5) develop strategic options only where genuinely warranted -- if only one direction is strategically reasonable, say so rather than manufacturing alternatives; (6) recommend a direction only when the evidence supports one, otherwise state explicitly what must be resolved first.",
    "Information supplied in the context below is NOT automatically established fact merely because it came from another Hat or Unit -- distinguish evidence from interpretation, inference, implication, and recommendation throughout.",
    "You do not own research, evidence validation, commercial progression, pricing, or creative production -- those belong to R&I, Sales, Finance, and Creative respectively. If the work genuinely requires one of those first (e.g. missing evidence a Handoff to R&I should gather), say so as the blocked/insufficient reason rather than inventing the missing material yourself.",
    "Set causationSupported explicitly and honestly for the diagnosed cause -- true only if the supplied context actually supports that causal claim, never merely because it sounds plausible.",
    "=== RESPONSE FORMAT (execution mechanics -- not part of the governance above) ===",
    `Return JSON exactly matching this shape:
{
  "sufficient": true | false,
  "blockedCategory": "ambiguous_question | insufficient_evidence | evidence_interpretation_conflated | unresolved_assumption | wrong_unit | missing_approval | unresolved_interpretations | requires_invention" (only if sufficient=false),
  "blockedReason": "..." (only if sufficient=false -- state exactly what is missing/ambiguous and what would resolve it),
  "situation": {"symptoms":"...","businessConditions":"...","constraints":"...","consequences":"...","stakeholders":"...","objectives":"..."},
  "diagnosis": {"symptom":"...","problem":"...","cause":"...","causationSupported": true|false,"constraint":"...","consequence":"..."},
  "strategicProblem": {"statement":"...","whyItMatters":"...","keyDrivers":"...","strategicTension":"...","materialUncertainty":"..."},
  "options": [{"name":"...","intendedEffect":"...","rationale":"...","evidenceBasis":"...","assumptions":"...","constraintsRisks":"...","conditionsForSuccess":"..."}],
  "recommendedDirection": "..." (omit entirely if evidence doesn't support a recommendation),
  "recommendationRationale": "...",
  "noRecommendationReason": "..." (required if sufficient=true and recommendedDirection is omitted),
  "evidenceSources": "...",
  "assumptions": "...",
  "unresolvedQuestions": "..."
}
Only include situation/diagnosis/strategicProblem/options/recommendation fields if sufficient=true.`,
  ].join("\n\n");
}

/**
 * Deterministic post-check on the AI's own structured output -- per the
 * Hat Definition's "Do not assert causation without sufficient support,"
 * this is never taken on the AI's own say-so. A result claiming a
 * recommended direction while its own diagnosis marks causation as
 * unsupported is downgraded to blocked here, regardless of what
 * "sufficient" the model itself reported. Mirrors validateFinanceJudgement's
 * role in valueBasedPricingAssessor.ts -- the AI cannot override this.
 */
export function evaluateCausationDiscipline(result: StrategyDiagnosisResult | null): { valid: true } | { valid: false; reason: string } {
  if (!result) return { valid: false, reason: "No structured diagnosis was returned." };
  if (result.sufficient !== true) return { valid: true }; // already its own blocked result -- nothing to override
  if (!result.diagnosis?.problem || !result.diagnosis?.cause) {
    return { valid: false, reason: "Diagnosis is incomplete -- problem and cause must both be established before a strategic problem can be framed." };
  }
  if (result.recommendedDirection && result.diagnosis.causationSupported !== true) {
    return {
      valid: false,
      reason: "A recommended direction was produced, but the diagnosed cause is not marked as sufficiently supported by evidence -- a recommendation must not rest on unsupported causation.",
    };
  }
  if (!result.recommendedDirection && !result.noRecommendationReason) {
    return { valid: false, reason: "No recommended direction was given, and no reason was stated for why one isn't yet supported." };
  }
  return { valid: true };
}

export async function handlePickup(env: Env, state: WorkState): Promise<WorkState> {
  const evalResult = await resolveStrategyHandoffContext(env, state.handoffId!);
  if (!evalResult.success) {
    console.error(`Strategy handlePickup: context evaluation failed for handoff ${state.handoffId}: ${evalResult.insufficientContext.reason}`);
    await logActivity(env, {
      entry: `Strategy pickup blocked [Insufficient Context] — ${evalResult.insufficientContext.category}`,
      type: "Blocker",
      area: "Strategy",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT_NAME },
      `Couldn't pick up a strategy request (Handoff ${state.handoffId}).\n\n${evalResult.insufficientContext.reason}\n\nNot proceeding without required sanitized context — will retry automatically once supplied.`,
    );
    return state;
  }

  state.entityName = evalResult.contract.entityToken;
  state.matterName = evalResult.contract.matterToken;
  state.strategyQuestion = evalResult.contract.sanitizedContext;
  state.strategyContext = evalResult.contract.sanitizedContext;

  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });
  await logActivity(env, {
    entry: `Strategy picked up request: ${state.matterName || state.entityName || state.workId}`,
    type: "Activity",
    area: "Strategy",
    activity: "Strategy Analyst picked up the Handoff.",
    outcome: "Active",
  });

  await sendStrategyInProgressAck(env, state);
  return runDiagnosis(env, state);
}

async function runDiagnosis(env: Env, state: WorkState): Promise<WorkState> {
  const governance = await getStrategyGovernance(env);
  if (!governance) {
    console.error(`Strategy runDiagnosis: governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Strategy diagnosis blocked — governance retrieval failed`,
      type: "Blocker",
      area: "Strategy",
      decisionRationale: "Could not retrieve canonical Strategy Analyst Hat Definition and/or Universal Role Contract from Notion. Refusing to execute without it.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Couldn't run this diagnosis — couldn't retrieve canonical governance from Notion. Please try again once resolved.`);
    return state;
  }

  await advanceStrategyProgress(env, state, "Establishing the situation and running the diagnosis...");

  const result = await aiJson<StrategyDiagnosisResult>(env, {
    taskId: "strategy.diagnosis",
    system: buildDiagnosisSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    user: state.strategyContext ?? "",
    maxTokens: 3000,
  });

  const causationCheck = evaluateCausationDiscipline(result);
  if (!result || result.sufficient !== true || !causationCheck.valid) {
    const reason = result?.sufficient !== true ? (result?.blockedReason ?? "Insufficient evidence to complete a defensible diagnosis.") : (causationCheck as { valid: false; reason: string }).reason;
    return handleBlocked(env, state, reason);
  }

  state.strategyDiagnosis = result;
  return deliverDiagnosis(env, state, result);
}

async function handleBlocked(env: Env, state: WorkState, reason: string): Promise<WorkState> {
  await logActivity(env, {
    entry: `Strategy diagnosis blocked`,
    type: "Blocker",
    area: "Strategy",
    decisionRationale: reason,
    outcome: "Blocked",
  });
  if (state.handoffId) {
    await updatePage(env, state.handoffId, {
      Status: select("Held"),
      "Open Questions": richText(reason.slice(0, 1900)),
    }).catch((err) => console.error(`Strategy: failed to mark Handoff ${state.handoffId} Held`, err));
  }
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `*Strategy diagnosis held.*\n\n${reason}\n\nSend the missing information/clarification and I'll re-run the diagnosis.`);
  state.stage = "strategy_blocked";
  state.awaiting = "strategy_clarification";
  return state;
}

function formatDiagnosisForTelegram(result: StrategyDiagnosisResult): string {
  const lines: string[] = [];
  if (result.strategicProblem?.statement) lines.push(`*Strategic problem:* ${result.strategicProblem.statement}`);
  if (result.diagnosis) {
    const causeLine = result.diagnosis.causationSupported
      ? result.diagnosis.cause
      : `${result.diagnosis.cause} ⚠️ _causation not fully established by supplied evidence_`;
    lines.push(`\n*Diagnosis:*\nSymptom: ${result.diagnosis.symptom ?? ""}\nProblem: ${result.diagnosis.problem ?? ""}\nCause: ${causeLine ?? ""}\nConstraint: ${result.diagnosis.constraint ?? ""}\nConsequence: ${result.diagnosis.consequence ?? ""}`);
  }
  if (result.options && result.options.length > 0) {
    lines.push(`\n*Options:*\n${result.options.map((o) => `• *${o.name}* — ${o.intendedEffect ?? ""}`).join("\n")}`);
  }
  if (result.recommendedDirection) {
    lines.push(`\n*Recommended direction (Martin's decision, not yet approved):* ${result.recommendedDirection}\n${result.recommendationRationale ?? ""}`);
  } else if (result.noRecommendationReason) {
    lines.push(`\n*No recommendation yet:* ${result.noRecommendationReason}`);
  }
  if (result.assumptions) lines.push(`\n*Assumptions:* ${result.assumptions}`);
  if (result.unresolvedQuestions) lines.push(`\n*Unresolved questions:* ${result.unresolvedQuestions}`);
  return lines.join("\n").slice(0, 3900);
}

/** Plain-text serialization for a Handoff record -- structure preserved, no Telegram markdown. */
export function formatDiagnosisForHandoff(result: StrategyDiagnosisResult): string {
  const lines: string[] = [];
  if (result.strategicProblem?.statement) lines.push(`Strategic problem: ${result.strategicProblem.statement}\nWhy it matters: ${result.strategicProblem.whyItMatters ?? ""}`);
  if (result.diagnosis) {
    lines.push(
      `Diagnosis (Symptom -> Problem -> Cause -> Constraint -> Consequence):\nSymptom: ${result.diagnosis.symptom ?? ""}\nProblem: ${result.diagnosis.problem ?? ""}\nCause: ${result.diagnosis.cause ?? ""} (causation ${result.diagnosis.causationSupported ? "supported" : "NOT fully supported"} by evidence)\nConstraint: ${result.diagnosis.constraint ?? ""}\nConsequence: ${result.diagnosis.consequence ?? ""}`,
    );
  }
  if (result.recommendedDirection) lines.push(`Recommended direction: ${result.recommendedDirection}\nRationale: ${result.recommendationRationale ?? ""}`);
  else if (result.noRecommendationReason) lines.push(`No recommendation given -- unresolved: ${result.noRecommendationReason}`);
  if (result.evidenceSources) lines.push(`Evidence/sources: ${result.evidenceSources}`);
  if (result.assumptions) lines.push(`Assumptions: ${result.assumptions}`);
  if (result.unresolvedQuestions) lines.push(`Unresolved questions: ${result.unresolvedQuestions}`);
  return lines.join("\n\n");
}

/**
 * Delivers the diagnosis and closes the INCOMING Handoff as complete --
 * mirrors researchAnalyst.ts's deliverSynthesis exactly. The diagnosis
 * itself is informational/recommended, never an approved decision; a
 * SEPARATE downstream-Handoff proposal (routeToUnit) is gated on Martin's
 * explicit approval, independent of delivery.
 */
async function deliverDiagnosis(env: Env, state: WorkState, result: StrategyDiagnosisResult): Promise<WorkState> {
  if (state.handoffId) {
    await updatePage(env, state.handoffId, {
      Status: select("Closed"),
      "Work Completed": richText(formatDiagnosisForHandoff(result).slice(0, 1900)),
    });
  }
  await logActivity(env, {
    entry: `Strategy diagnosis completed: ${state.matterName || state.entityName || state.workId}`,
    type: "Decision",
    area: "Strategy",
    decisions: result.recommendedDirection ? `Recommended: ${result.recommendedDirection}` : "No recommendation -- evidence insufficient for one.",
    decisionRationale: result.recommendationRationale ?? result.noRecommendationReason ?? "",
    outcome: "Complete",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, formatDiagnosisForTelegram(result));

  await routeToUnit(env, state, result);

  state.stage = "delivered";
  state.awaiting = "strategy_feedback";
  return state;
}

/**
 * Where a diagnosis's next responsibility belongs to another Unit, per the
 * Hat Definition's own handoff_rules -- proposes (never auto-creates) a
 * downstream Handoff. "none" (no clear destination, or the diagnosis is
 * self-contained/informational) is a valid, expected outcome -- mirrors
 * R&I's routeToConsumingHat: never guesses when unclear.
 */
const HANDOFF_ROUTES: Partial<Record<string, { unit: Unit; hat: string }>> = {
  research: { unit: "Research & Intelligence", hat: "Research & Intelligence Analyst" },
  marketing: { unit: "Marketing", hat: "Marketing Strategist" },
  sales: { unit: "Sales", hat: "Sales Executive" },
  finance: { unit: "Finance", hat: "Value-Based Pricing Assessor" },
};

interface HandoffRoutingResult {
  target?: string;
  reason?: string;
}

async function classifyHandoffTarget(env: Env, result: StrategyDiagnosisResult): Promise<HandoffRoutingResult> {
  const summary = `Strategic problem: ${result.strategicProblem?.statement ?? ""}\nRecommended direction: ${result.recommendedDirection ?? "(none -- " + (result.noRecommendationReason ?? "") + ")"}\nUnresolved questions: ${result.unresolvedQuestions ?? ""}`;
  const classification = await aiJson<HandoffRoutingResult>(env, {
    taskId: "strategy.handoff_routing",
    system: `You decide whether a completed Strategy diagnosis's next responsibility belongs to another Unit, per the Strategy Analyst Hat Definition's own handoff_rules:
- "research": the diagnosis is blocked or weakened by missing evidence/validation that only Research & Intelligence can gather.
- "marketing": the recommended direction is specifically marketing strategy/execution (positioning, campaign, content, channel decisions).
- "sales": the next step is commercial progression of an opportunity (owned by Sales, not Strategy).
- "finance": the recommended direction is an approved intervention that now needs value-based pricing/a quote (owned by Finance, not Strategy).
- "none": the diagnosis is self-contained/informational, or the destination is not clearly one of the above -- never guess.

Return JSON: {"target": "research" | "marketing" | "sales" | "finance" | "none", "reason": "..."}`,
    user: summary,
    light: true,
  });
  return classification ?? { target: "none" };
}

async function routeToUnit(env: Env, state: WorkState, result: StrategyDiagnosisResult): Promise<void> {
  const routing = await classifyHandoffTarget(env, result);
  const route = routing.target ? HANDOFF_ROUTES[routing.target] : undefined;
  if (!route) return;

  const reason = (routing.reason ?? `Strategy diagnosis completed and judged directly relevant to ${route.hat}'s work.`).slice(0, 1900);
  const verifiedFactsAndSources = formatDiagnosisForHandoff(result).slice(0, 1900);

  const requiredNextAction =
    route.unit === "Finance"
      ? "Price the Martin-approved intervention described above using value-based judgment. Do not treat any disclosed budget or willingness-to-pay as the pricing basis. Do not redesign, substitute, or reinterpret the approved intervention -- price what is described, or hold and state what's missing."
      : route.unit === "Research & Intelligence"
        ? "Gather/validate the additional evidence identified as missing above, per the unresolved questions."
        : route.unit === "Marketing"
          ? "Take the strategic direction above as input to marketing-specific strategy/execution decisions."
          : "Take the strategic direction above as input to commercial progression.";

  state.pendingStrategyHandoff = {
    unit: route.unit,
    hat: route.hat,
    handoffTitle: `Strategy diagnosis for ${route.hat}: ${(state.strategyQuestion ?? state.workId).slice(0, 60)}`,
    reason,
    requiredNextAction,
    expectedOutput: route.unit === "Finance" ? "A quoted price and pricing rationale, or an explicit Held status naming the specific missing evidence." : `${route.hat} to use this diagnosis as direct input to its own work.`,
    acceptanceCriteria:
      route.unit === "Finance"
        ? "A quoted price with clear value-based rationale that prices the intervention described, without alteration, or an explicit Held status."
        : "Work proceeds using the strategic context preserved above without needing to reconstruct it.",
    verifiedFactsAndSources,
    assumptions: result.assumptions ?? "",
    openQuestions: result.unresolvedQuestions ?? "",
  };

  await logActivity(env, {
    entry: `Strategy proposed handoff to ${route.hat} -- pending approval`,
    type: "Decision",
    area: "Strategy",
    decisionRationale: reason,
    outcome: "Blocked",
  });

  const handoffMessage = `This diagnosis looks directly relevant to *${route.hat}*'s work: ${reason}\n\n*Preview of what would be sent:*\n${verifiedFactsAndSources.slice(0, 1200)}\n\nThis is a recommendation, not yet an approved decision. Send this to ${route.hat}?`;
  const handoffButtons = [
    [
      { text: "✅ Send handoff", callback_data: `strategyhandoff:${state.workId}:approve` },
      { text: "🚫 Don't send", callback_data: `strategyhandoff:${state.workId}:reject` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, handoffMessage, handoffButtons);
  state.pendingActionSummary = {
    label: `Strategy handoff to ${route.hat}`,
    message: handoffMessage,
    buttons: handoffButtons,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Creates the actual Handoff record only once Martin approves the preview
 * sent by routeToUnit -- mirrors handleResearchHandoffApproval exactly.
 * Disclosure of the proposed handoff is not permission to send it; only
 * this explicit approval is.
 */
export async function handleStrategyHandoffApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingStrategyHandoff;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "There's no pending handoff to act on.");
    return state;
  }

  if (!approved) {
    state.pendingStrategyHandoff = undefined;
    state.pendingActionSummary = undefined;
    await logActivity(env, {
      entry: `Strategy handoff to ${pending.hat} declined by Martin`,
      type: "Decision",
      area: "Strategy",
      decisionRationale: "Martin chose not to send this diagnosis to the proposed Hat.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Okay -- this diagnosis wasn't sent to *${pending.hat}*.`);
    return state;
  }

  try {
    const handoff = await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, {
      Handoff: title(pending.handoffTitle),
      "From Unit": select("Strategy"),
      "From Hat": richText(HAT_NAME),
      "To Unit": select(pending.unit),
      "To Hat": richText(pending.hat),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(pending.reason),
      "Required Next Action": richText(pending.requiredNextAction),
      "Expected Output": richText(pending.expectedOutput),
      "Acceptance Criteria": richText(pending.acceptanceCriteria),
      Entity_Token: richText(state.entityName ?? ""),
      Matter_Token: richText(state.matterName ?? ""),
      Assumptions: richText(pending.assumptions.slice(0, 1900)),
      "Open Questions": richText(pending.openQuestions.slice(0, 1900)),
      "Verified Facts & Sources": richText(pending.verifiedFactsAndSources),
    });
    state.pendingStrategyHandoff = undefined;
    state.pendingActionSummary = undefined;
    await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, state.workId);
    await logActivity(env, {
      entry: `Strategy diagnosis handed off to ${pending.hat}`,
      type: "Activity",
      area: "Strategy",
      activity: `Handoff ${handoff.id} created for ${pending.unit}/${pending.hat}.`,
      nextActions: `${pending.hat} to pick up and act on this diagnosis.`,
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Sent -- this diagnosis has been handed off to *${pending.hat}*.`);
  } catch (err) {
    console.error(`Strategy: failed to create approved handoff to ${pending.unit}/${pending.hat} for work ${state.workId}`, err);
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Couldn't create the handoff to *${pending.hat}* -- please try approving again.`);
  }

  return state;
}

/** Ambiguity loop: re-runs the diagnosis with the added detail. */
export async function handleStrategyClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.strategyContext = `${state.strategyContext ?? ""}\n\nAdditional detail: ${text}`;
  await sendStrategyInProgressAck(env, state);
  return runDiagnosis(env, state);
}

/** Free-text follow-up after a delivered diagnosis -- re-runs with the added context, same discipline as R&I's own follow-up loop. */
export async function handleStrategyFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.strategyContext = `${state.strategyContext ?? ""}\n\nMartin's follow-up: ${text}`;
  await sendStrategyInProgressAck(env, state);
  return runDiagnosis(env, state);
}
