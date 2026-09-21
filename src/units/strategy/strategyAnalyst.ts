import type { Env, Unit, WorkState } from "../../types";
import { createPage, getPage, plainText, richText, select, title, updatePage } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { editHatMessage, sendWorkspaceHatMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import { claimPendingHandoff } from "../../handoffLifecycle";

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
  // Idempotency guard: re-verifies the Handoff's live Status and claims it
  // (Pending -> Picked-up) at the actual processing boundary, not just
  // trusting the discovery query's Pending filter from moments earlier. A
  // duplicate discovery trigger, a retried invocation, or a Handoff that
  // was Held/Closed out from under this call all fail closed here rather
  // than being reprocessed.
  const claim = await claimPendingHandoff(env, state.handoffId!);
  if (!claim.claimed) {
    console.error(`Strategy handlePickup: refused -- ${claim.reason}`);
    await logActivity(env, {
      entry: `Strategy pickup refused — invalid Handoff state`,
      type: "Blocker",
      area: "Strategy",
      decisionRationale: claim.reason,
      outcome: "Blocked",
    });
    return state;
  }

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
    // Already claimed (Picked-up) above -- move to Held rather than leaving
    // it stuck at Picked-up, so the same Held->Pending retry path (see
    // handleStrategyClarification) can bring it back for exactly one more
    // pickup once the missing context is supplied.
    await updatePage(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(evalResult.insufficientContext.reason.slice(0, 1900)),
    }).catch((err) => console.error(`Strategy: failed to mark Handoff ${state.handoffId} Held`, err));
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT_NAME },
      `Couldn't pick up a strategy request (Handoff ${state.handoffId}).\n\n${evalResult.insufficientContext.reason}\n\nNot proceeding without required sanitized context — send the missing detail and I'll retry.`,
    );
    state.stage = "strategy_blocked";
    state.awaiting = "strategy_clarification";
    return state;
  }

  state.entityName = evalResult.contract.entityToken;
  state.matterName = evalResult.contract.matterToken;
  state.strategyQuestion = evalResult.contract.sanitizedContext;
  state.strategyContext = evalResult.contract.sanitizedContext;

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
    if (state.handoffId && state.stage !== "strategy_refining") {
      await updatePage(env, state.handoffId, {
        Status: select("Held"),
        "Open Questions": richText("Could not retrieve canonical Strategy Analyst Hat Definition and/or Universal Role Contract from Notion."),
      }).catch((err) => console.error(`Strategy: failed to mark Handoff ${state.handoffId} Held`, err));
    }
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Couldn't run this diagnosis — couldn't retrieve canonical governance from Notion. Send a message once resolved and I'll retry.`);
    state.stage = "strategy_blocked";
    state.awaiting = "strategy_clarification";
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
 * Delivers the diagnosis. A diagnosis WITH a recommended direction (a
 * proposed intervention) never auto-closes the incoming Handoff or
 * auto-routes anywhere -- per the canonical commercial flow, it enters the
 * explicit awaiting_intervention_approval state (see
 * presentInterventionForApproval) and the incoming Handoff stays Picked-up
 * until Martin approves and the Strategy -> Finance Handoff is actually
 * created. A diagnosis with NO recommendation (informational, or evidence
 * doesn't yet support one) closes the incoming Handoff immediately and may
 * still propose a non-commercial downstream handoff (research/marketing/
 * sales) via routeToUnit -- mirrors researchAnalyst.ts's deliverSynthesis.
 */
async function deliverDiagnosis(env: Env, state: WorkState, result: StrategyDiagnosisResult): Promise<WorkState> {
  if (result.recommendedDirection) {
    await logActivity(env, {
      entry: `Strategy intervention proposed: ${state.matterName || state.entityName || state.workId}`,
      type: "Decision",
      area: "Strategy",
      decisions: `Proposed: ${result.recommendedDirection}`,
      decisionRationale: result.recommendationRationale ?? "",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, formatDiagnosisForTelegram(result));
    return presentInterventionForApproval(env, state, result);
  }

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
    decisions: "No recommendation -- evidence insufficient for one.",
    decisionRationale: result.noRecommendationReason ?? "",
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
 * R&I's routeToConsumingHat: never guesses when unclear. Finance is
 * deliberately NOT a routable destination here -- per the canonical
 * commercial flow, Finance is reached exclusively through the
 * Approve/Refine intervention-approval gate (presentInterventionForApproval/
 * handleInterventionApproval), never through this general classifier, so
 * there is exactly one path to Finance, not two.
 */
const HANDOFF_ROUTES: Partial<Record<string, { unit: Unit; hat: string }>> = {
  research: { unit: "Research & Intelligence", hat: "Research & Intelligence Analyst" },
  marketing: { unit: "Marketing", hat: "Marketing Strategist" },
  sales: { unit: "Sales", hat: "Sales Executive" },
};

interface HandoffRoutingResult {
  target?: string;
  reason?: string;
}

async function classifyHandoffTarget(env: Env, result: StrategyDiagnosisResult): Promise<HandoffRoutingResult> {
  const summary = `Strategic problem: ${result.strategicProblem?.statement ?? ""}\nNo recommendation yet: ${result.noRecommendationReason ?? ""}\nUnresolved questions: ${result.unresolvedQuestions ?? ""}`;
  const classification = await aiJson<HandoffRoutingResult>(env, {
    taskId: "strategy.handoff_routing",
    system: `You decide whether a completed Strategy diagnosis's next responsibility belongs to another Unit, per the Strategy Analyst Hat Definition's own handoff_rules:
- "research": the diagnosis is blocked or weakened by missing evidence/validation that only Research & Intelligence can gather.
- "marketing": the work is specifically marketing strategy/execution (positioning, campaign, content, channel decisions).
- "sales": the next step is commercial progression of an opportunity (owned by Sales, not Strategy).
- "none": the diagnosis is self-contained/informational, or the destination is not clearly one of the above -- never guess.

Never return "finance" -- pricing is reached only through Martin's explicit approval of a recommended intervention, never through this classifier.

Return JSON: {"target": "research" | "marketing" | "sales" | "none", "reason": "..."}`,
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
    route.unit === "Research & Intelligence"
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
    expectedOutput: `${route.hat} to use this diagnosis as direct input to its own work.`,
    acceptanceCriteria: "Work proceeds using the strategic context preserved above without needing to reconstruct it.",
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

/**
 * Presents a recommended intervention for Martin's explicit Approve/Refine
 * decision -- the canonical commercial flow's gate before any Strategy ->
 * Finance Handoff may be created. A fresh proposalId is minted every time
 * this runs (initial proposal or a revised one after Refine), and embedded
 * in the callback_data (as "<proposalId>.<approve|refine>", joined with a
 * "." rather than ":" so it survives the router's plain data.split(":")
 * unchanged). handleInterventionApproval checks this id against
 * state.pendingIntervention exactly -- a stale button from an earlier or
 * superseded proposal can never approve a different/later one.
 */
async function presentInterventionForApproval(env: Env, state: WorkState, result: StrategyDiagnosisResult): Promise<WorkState> {
  const proposalId = crypto.randomUUID();
  const interventionSummary = result.recommendedDirection ?? "";
  state.pendingIntervention = { proposalId, interventionSummary };

  const message = `*Proposed intervention:* ${interventionSummary}\n\n${result.recommendationRationale ?? ""}\n\nThis is a recommendation, not yet an approved decision. Approve to route this to Finance for pricing, or Refine if it needs changes first.`;
  const buttons = [
    [
      { text: "✅ Approve", callback_data: `strategyintervention:${state.workId}:${proposalId}.approve` },
      { text: "🔁 Refine", callback_data: `strategyintervention:${state.workId}:${proposalId}.refine` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, message, buttons);
  state.pendingActionSummary = {
    label: `Intervention approval: ${state.matterName || state.entityName || state.workId}`,
    message,
    buttons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_intervention_approval";
  state.awaiting = undefined;
  return state;
}

/** Plain-text serialization of the APPROVED intervention for the Strategy -> Finance Handoff -- distinguishes every category Finance needs, per the canonical commercial flow. */
function formatApprovedInterventionForFinance(result: StrategyDiagnosisResult): string {
  const lines: string[] = [
    `Approved intervention: ${result.recommendedDirection ?? ""}`,
    `Diagnosis/rationale: ${result.recommendationRationale ?? ""}. Diagnosed cause: ${result.diagnosis?.cause ?? ""} (causation ${result.diagnosis?.causationSupported ? "supported" : "not fully supported"} by evidence). Strategic problem: ${result.strategicProblem?.statement ?? ""}`,
    `Verified evidence: ${result.evidenceSources ?? ""}`,
    `Assumptions: ${result.assumptions ?? ""}`,
    `Unresolved questions: ${result.unresolvedQuestions ?? ""}`,
    `Pricing requirements: Price this approved intervention using value-based judgment. Do not redesign, substitute, or reinterpret it. Do not treat any disclosed budget or willingness-to-pay as the pricing basis.`,
  ];
  return lines.join("\n\n");
}

/**
 * Martin's Approve/Refine decision on a proposed intervention. Verifies,
 * before mutating anything: the WorkSession is actually in
 * awaiting_intervention_approval, a pendingIntervention exists, and its
 * proposalId matches exactly -- a callback for a stale/superseded proposal
 * (or a completed session) is a logged no-op, never a mutation, per the
 * existing fail-closed stage-guard pattern used by every other approval
 * gate in this Worker (e.g. Finance's handleQuoteApproval).
 */
export async function handleInterventionApproval(env: Env, state: WorkState, proposalId: string, decision: "approve" | "refine"): Promise<WorkState> {
  if (state.stage !== "awaiting_intervention_approval" || !state.pendingIntervention || state.pendingIntervention.proposalId !== proposalId) {
    console.error(`Strategy handleInterventionApproval: stale/mismatched callback for work ${state.workId} (proposalId ${proposalId})`);
    await logActivity(env, {
      entry: `Strategy intervention approval callback ignored — stale or superseded`,
      type: "Blocker",
      area: "Strategy",
      decisionRationale: `Callback proposalId ${proposalId} did not match the current pending intervention (stage: ${state.stage}). Treated as a no-op.`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "This intervention proposal has already been resolved or superseded -- nothing to do.");
    return state;
  }

  const diagnosis = state.strategyDiagnosis;

  if (decision === "refine") {
    state.pendingIntervention = undefined;
    state.pendingActionSummary = undefined;
    await logActivity(env, {
      entry: `Strategy intervention refinement requested: ${state.matterName || state.entityName || state.workId}`,
      type: "Decision",
      area: "Strategy",
      decisionRationale: "Martin requested changes to the proposed intervention. A refinement is not an approval -- no Finance Handoff created.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "Got it -- what should change about this intervention? Tell me what's off or what to take into account, and I'll produce a revised proposal.");
    state.stage = "strategy_refining";
    state.awaiting = "strategy_refinement_reason";
    return state;
  }

  // decision === "approve"
  if (!diagnosis || !diagnosis.recommendedDirection) {
    console.error(`Strategy handleInterventionApproval: no diagnosis/recommendation on record for work ${state.workId}`);
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "Couldn't find the diagnosis behind this approval -- please ask me to re-diagnose.");
    return state;
  }

  try {
    const handoff = await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, {
      Handoff: title(`Value-based quote request — ${state.matterName || state.entityName || state.workId}`),
      "From Unit": select("Strategy"),
      "From Hat": richText(HAT_NAME),
      "To Unit": select("Finance"),
      "To Hat": richText("Value-Based Pricing Assessor"),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(`Martin-approved intervention ready for value-based pricing: ${diagnosis.recommendedDirection}`.slice(0, 1900)),
      "Required Next Action": richText(
        "Price the Martin-approved intervention below using value-based judgment. Do not redesign, substitute, or reinterpret it. Do not treat any disclosed budget or willingness-to-pay as the pricing basis -- price the approved intervention's value, or hold and state what's missing.",
      ),
      "Expected Output": richText("A quoted price and value-based pricing rationale for the approved intervention, or an explicit Held status naming the specific missing evidence."),
      "Acceptance Criteria": richText("A quoted price with clear value-based rationale pricing the approved intervention as described, without alteration, or an explicit Held status."),
      Entity_Token: richText(state.entityName ?? ""),
      Matter_Token: richText(state.matterName ?? ""),
      Assumptions: richText((diagnosis.assumptions ?? "").slice(0, 1900)),
      "Open Questions": richText((diagnosis.unresolvedQuestions ?? "").slice(0, 1900)),
      "Verified Facts & Sources": richText(formatApprovedInterventionForFinance(diagnosis).slice(0, 1900)),
    });

    // Close the Sales -> Strategy Handoff now that the approved intervention
    // has been successfully transferred onward -- per the canonical flow,
    // this is deferred until here (not at delivery time) specifically for
    // the has-a-recommendation path.
    if (state.handoffId) {
      await updatePage(env, state.handoffId, {
        Status: select("Closed"),
        "Work Completed": richText(`Intervention approved by Martin and handed off to Finance (Handoff ${handoff.id}): ${diagnosis.recommendedDirection}`.slice(0, 1900)),
      }).catch((err) => console.error(`Strategy: failed to close originating Handoff ${state.handoffId}`, err));
    }

    await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, state.workId);
    state.handoffId = handoff.id;
    state.pendingIntervention = undefined;
    state.pendingActionSummary = undefined;

    await logActivity(env, {
      entry: `Martin approved Strategy intervention -- Strategy -> Finance Handoff created`,
      type: "Decision",
      area: "Strategy",
      decisions: `Approved: ${diagnosis.recommendedDirection}`,
      decisionRationale: `Handoff ${handoff.id} created for Finance to price the approved intervention.`,
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Approved -- routed to Finance for pricing. I'll let you know once Finance responds.`);

    // Strategy's execution on this Handoff ends here -- Finance discovers
    // and picks up the new Handoff independently (see
    // discoverPendingFinanceHandoffs in index.ts), the same cross-Unit
    // execution-boundary pattern every other Handoff in this Worker uses.
    state.stage = "awaiting_finance";
    state.awaiting = undefined;
  } catch (err) {
    console.error(`Strategy: failed to create Strategy -> Finance Handoff for work ${state.workId}`, err);
    // Leave pendingIntervention intact so approving again actually retries,
    // rather than silently having nothing left to act on.
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "Couldn't create the Handoff to Finance -- please try approving again.");
  }

  return state;
}

/** Revision loop after Refine: re-runs the diagnosis with Martin's reasoning, then re-presents a fresh proposal (new proposalId) for approval. */
export async function handleStrategyRefinement(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.strategyContext = `${state.strategyContext ?? ""}\n\nMartin's refinement request: ${text}`;
  await sendStrategyInProgressAck(env, state);
  return runDiagnosis(env, state);
}

/**
 * Ambiguity/Held retry loop. Rather than continuing in-session (which would
 * bypass the pickup-idempotency boundary), this requeues the Handoff:
 * appends the added detail to Verified Facts & Sources and returns Status
 * to Pending, mirroring salesExecutive.ts's handleMoreValueContext exactly.
 * Discovery re-finds it and hands it back through handlePickup's own
 * claim-then-process guard, so it is picked up again exactly once.
 */
export async function handleStrategyClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const augmentedContext = `${state.strategyContext ?? ""}\n\nAdditional detail: ${text}`;
  state.strategyContext = augmentedContext;

  if (!state.handoffId) {
    // No Handoff context to requeue against (shouldn't normally occur) --
    // fall back to direct continuation rather than losing the message.
    await sendStrategyInProgressAck(env, state);
    return runDiagnosis(env, state);
  }

  await updatePage(env, state.handoffId, {
    "Verified Facts & Sources": richText(augmentedContext.slice(0, 1900)),
    Status: select("Pending"),
  });
  await logActivity(env, {
    entry: `Strategy Handoff retry — returned Held to Pending`,
    type: "Decision",
    area: "Strategy",
    decisionRationale: "Martin supplied additional detail resolving the prior blocker; requeued for re-pickup.",
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "Got it -- queued for re-diagnosis with the added detail. I'll follow up here once it's done.");
  state.stage = "strategy_retry_queued";
  state.awaiting = undefined;
  return state;
}

/** Free-text follow-up after a delivered diagnosis -- re-runs with the added context, same discipline as R&I's own follow-up loop. */
export async function handleStrategyFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.strategyContext = `${state.strategyContext ?? ""}\n\nMartin's follow-up: ${text}`;
  await sendStrategyInProgressAck(env, state);
  return runDiagnosis(env, state);
}
