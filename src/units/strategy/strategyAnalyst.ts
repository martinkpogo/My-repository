import type { Env, Unit, WorkState } from "../../types";
import { getPage, plainText, richText, select, title } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { editHatMessage, sendWorkspaceHatMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import { claimPendingHandoff, closeHandoffIfOpen } from "../../handoffLifecycle";
import { createHandoff, updateHandoff } from "../../handoffWriter";

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
 * The complete Strategic Intervention Proposal Martin reviews for
 * Approve/Refine/Reject -- a runtime/work-state artifact (see
 * WorkState.strategyProposal), not a Notion database object or a new
 * Business Object. Developed from an already causation-disciplined
 * StrategyDiagnosisResult via developStrategyProposal, never generated in
 * place of the diagnosis step. Detailed enough for Martin to evaluate what
 * ENIG proposes to do, and specified enough for Finance to price without
 * having to redesign the intervention -- see formatApprovedProposalForFinance.
 */
export interface StrategyProposal {
  proposalId: string;
  proposalVersion: number;

  executiveSummary: {
    businessSituation: string;
    strategicProblem: string;
    recommendedDirection: string;
    proposedIntervention: string;
    expectedBusinessEffect: string;
    decisionRequired: string;
  };

  businessContext: {
    entityContext: string;
    businessObjectives: string;
    relevantMarketContext: string;
    relevantAudienceOrCustomerContext: string;
    currentState: string;
    engagementTrigger: string;
    relevantCommercialContext: string;
    evidence: string[];
  };

  strategicChallenge: {
    businessObjective: string;
    observedSituation: string;
    strategicQuestion: string;
    whyItMatters: string;
  };

  diagnosis: {
    symptom: string;
    problem: string;
    causes: string[];
    constraints: string[];
    consequences: string[];
    evidence: string[];
    diagnosticConclusion: string;
  };

  strategicOpportunity: {
    opportunity: string;
    basis: string;
    relevanceToBusinessObjective: string;
    opportunityConditions: string[];
  };

  strategicObjective: {
    objective: string;
    intendedChange: string;
    businessAlignment: string;
    measurementDirection: string;
  };

  recommendedDirection: {
    direction: string;
    rationale: string;
    strategicLogic: string;
    alternativesConsidered: string[];
    selectionBasis: string;
  };

  proposedIntervention: {
    interventionName: string;
    interventionSummary: string;
    workstreams: Array<{
      name: string;
      objective: string;
      activities: string[];
      output: string;
      dependencies: string[];
      acceptanceCriteria: string[];
    }>;
  };

  deliverables: Array<{
    name: string;
    description: string;
    format: string;
    acceptanceCriteria: string[];
  }>;

  timeline: {
    status: "Indicative" | "Confirmed";
    totalDuration: string;
    phases: Array<{
      name: string;
      duration: string;
      activities: string[];
      outputs: string[];
      dependencies: string[];
      reviewPoint: string;
    }>;
  };

  entityInputs: {
    requiredInformation: string[];
    requiredDocuments: string[];
    requiredAccess: string[];
    requiredStakeholderParticipation: string[];
    requiredDecisions: string[];
  };

  assumptions: Array<{
    assumption: string;
    basis: string;
    materiality: string;
  }>;

  dependencies: Array<{
    dependency: string;
    owner: string;
    impactIfUnavailable: string;
  }>;

  risksAndConstraints: {
    risks: Array<{
      risk: string;
      potentialEffect: string;
      mitigationOrResponse: string;
    }>;
    constraints: Array<{
      constraint: string;
      implication: string;
    }>;
  };

  expectedBusinessEffect: {
    intendedEffects: string[];
    measurableEffects: string[];
    effectsRequiringBaseline: string[];
    limitations: string[];
  };

  successCriteria: Array<{
    criterion: string;
    measurement: string;
    evidenceRequired: string;
  }>;

  commercialScope: {
    included: string[];
    excluded: string[];
    expectedResources: string[];
    expectedDuration: string;
    clientResponsibilities: string[];
    downstreamUnitResponsibilities: string[];
  };

  strategicRecommendation: {
    recommendation: string;
    rationale: string;
    evidenceBasis: string[];
    conditionsOfApproval: string[];
  };
}

/** Everything in StrategyProposal except the two identifiers this module assigns itself (proposalId, proposalVersion). */
type RawStrategyProposal = Omit<StrategyProposal, "proposalId" | "proposalVersion">;

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
    const verifiedFacts = plainText(handoff.properties["Verified Facts & Sources"]) || plainText(handoff.properties.Reason);
    // Required Next Action is where a human naturally writes refinement
    // guidance when returning a Held Handoff to Pending directly in Notion
    // (rather than through the bot's own Telegram reply flow, which
    // appends to Verified Facts & Sources instead -- see
    // handleStrategyClarification) -- confirmed live: a detailed
    // evidence-bounded reframing written there was silently never read,
    // so re-diagnosis saw only the unchanged original evidence and
    // reproduced the identical Held outcome. Always folded in here so
    // guidance reaches the diagnosis regardless of which path supplied it.
    const requiredNextAction = plainText(handoff.properties["Required Next Action"]);
    const sanitizedContext = requiredNextAction ? `${verifiedFacts}\n\n=== Required Next Action (from the Handoff record) ===\n${requiredNextAction}` : verifiedFacts;
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
    await updateHandoff(env, state.handoffId!, {
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

  state.entityToken = evalResult.contract.entityToken;
  state.matterToken = evalResult.contract.matterToken ?? "";
  state.strategyQuestion = evalResult.contract.sanitizedContext;
  state.strategyContext = evalResult.contract.sanitizedContext;

  await logActivity(env, {
    entry: `Strategy picked up request: ${state.matterToken || state.entityToken || state.workId}`,
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
      await updateHandoff(env, state.handoffId, {
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
    await updateHandoff(env, state.handoffId, {
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
      entry: `Strategy intervention proposed: ${state.matterToken || state.entityToken || state.workId}`,
      type: "Decision",
      area: "Strategy",
      decisions: `Proposed: ${result.recommendedDirection}`,
      decisionRationale: result.recommendationRationale ?? "",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, formatDiagnosisForTelegram(result));
    return developStrategyProposal(env, state, result);
  }

  if (state.handoffId) {
    await updateHandoff(env, state.handoffId, {
      Status: select("Closed"),
      "Work Completed": richText(formatDiagnosisForHandoff(result).slice(0, 1900)),
    });
  }
  await logActivity(env, {
    entry: `Strategy diagnosis completed: ${state.matterToken || state.entityToken || state.workId}`,
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
    const handoff = await createHandoff(
      env,
      {
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
        Entity_Token: richText(state.entityToken ?? ""),
        Matter_Token: richText(state.matterToken ?? ""),
        Assumptions: richText(pending.assumptions.slice(0, 1900)),
        "Open Questions": richText(pending.openQuestions.slice(0, 1900)),
        "Verified Facts & Sources": richText(pending.verifiedFactsAndSources),
      },
      { entityToken: state.entityToken ?? "", matterToken: state.matterToken ?? "" },
    );
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

function buildProposalDraftingSystemPrompt(hatDefinition: string, universalRoleContract: string, diagnosis: StrategyDiagnosisResult): string {
  return [
    "You are executing the Strategy Analyst Hat, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for role, authority limits, boundaries, and stop conditions -- follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution mechanics -- not part of the governance above) ===",
    "A causation-disciplined diagnosis (below, already validated) has concluded a recommended direction is defensible. Expand it into the COMPLETE Strategic Intervention Proposal Martin will review to decide whether ENIG should do this work -- not a generic diagnosis report. It must be detailed enough for Martin to evaluate exactly what is being proposed, and specified enough for Finance to price the approved intervention later WITHOUT having to redesign it.",
    "=== VALIDATED DIAGNOSIS (already produced -- expand this, do not re-diagnose or contradict it) ===",
    JSON.stringify(diagnosis),
    "=== DISCIPLINE (do not weaken) ===",
    "Distinguish verified facts from interpretation; distinguish evidence from assumptions; never assert a causal claim beyond what the diagnosis already supports; never invent a numerical outcome; identify evidence limitations; surface conflicting evidence if any exists. If an exact timeline duration cannot be reliably supported by the evidence, set timeline.status to \"Indicative\" (never \"Confirmed\" merely to look complete) and let totalDuration/phase durations reflect that (e.g. \"approximately 6-8 weeks, indicative\").",
    "You MAY design the strategic intervention itself (positioning, strategic messaging, audience considerations, communication strategy, customer journey strategy, strategic workstreams, required downstream outputs, implementation principles, strategic measurement, timelines, dependencies). You must NOT perform another Unit's execution responsibility -- e.g. if a marketing strategy is required, specify the strategic marketing intervention, but do not treat this as authorization to route the case to Marketing Strategist (that remains a separate, Martin-gated decision, never automatic).",
    "=== RESPONSE FORMAT (execution mechanics -- not part of the governance above) ===",
    `Return JSON exactly matching this shape (all string fields are prose, all array fields are lists of strings unless the array holds objects as shown; use "" or [] only where the diagnosis genuinely gives nothing to say, never as a placeholder for something you didn't bother filling in):
{
  "executiveSummary": {"businessSituation":"...","strategicProblem":"...","recommendedDirection":"...","proposedIntervention":"...","expectedBusinessEffect":"...","decisionRequired":"..."},
  "businessContext": {"entityContext":"...","businessObjectives":"...","relevantMarketContext":"...","relevantAudienceOrCustomerContext":"...","currentState":"...","engagementTrigger":"...","relevantCommercialContext":"...","evidence":["..."]},
  "strategicChallenge": {"businessObjective":"...","observedSituation":"...","strategicQuestion":"...","whyItMatters":"..."},
  "diagnosis": {"symptom":"...","problem":"...","causes":["..."],"constraints":["..."],"consequences":["..."],"evidence":["..."],"diagnosticConclusion":"..."},
  "strategicOpportunity": {"opportunity":"...","basis":"...","relevanceToBusinessObjective":"...","opportunityConditions":["..."]},
  "strategicObjective": {"objective":"...","intendedChange":"...","businessAlignment":"...","measurementDirection":"..."},
  "recommendedDirection": {"direction":"...","rationale":"...","strategicLogic":"...","alternativesConsidered":["..."],"selectionBasis":"..."},
  "proposedIntervention": {"interventionName":"...","interventionSummary":"...","workstreams":[{"name":"...","objective":"...","activities":["..."],"output":"...","dependencies":["..."],"acceptanceCriteria":["..."]}]},
  "deliverables": [{"name":"...","description":"...","format":"...","acceptanceCriteria":["..."]}],
  "timeline": {"status":"Indicative"|"Confirmed","totalDuration":"...","phases":[{"name":"...","duration":"...","activities":["..."],"outputs":["..."],"dependencies":["..."],"reviewPoint":"..."}]},
  "entityInputs": {"requiredInformation":["..."],"requiredDocuments":["..."],"requiredAccess":["..."],"requiredStakeholderParticipation":["..."],"requiredDecisions":["..."]},
  "assumptions": [{"assumption":"...","basis":"...","materiality":"..."}],
  "dependencies": [{"dependency":"...","owner":"...","impactIfUnavailable":"..."}],
  "risksAndConstraints": {"risks":[{"risk":"...","potentialEffect":"...","mitigationOrResponse":"..."}],"constraints":[{"constraint":"...","implication":"..."}]},
  "expectedBusinessEffect": {"intendedEffects":["..."],"measurableEffects":["..."],"effectsRequiringBaseline":["..."],"limitations":["..."]},
  "successCriteria": [{"criterion":"...","measurement":"...","evidenceRequired":"..."}],
  "commercialScope": {"included":["..."],"excluded":["..."],"expectedResources":["..."],"expectedDuration":"...","clientResponsibilities":["..."],"downstreamUnitResponsibilities":["..."]},
  "strategicRecommendation": {"recommendation":"...","rationale":"...","evidenceBasis":["..."],"conditionsOfApproval":["..."]}
}`,
  ].join("\n\n");
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Normalizes the AI's raw proposal JSON into a fully-shaped StrategyProposal
 * -- every field is guaranteed present (empty string/array where the model
 * gave nothing usable) so downstream formatting/preview code never has to
 * guard against undefined. timeline.status is forced to "Indicative" unless
 * the model explicitly and validly returned "Confirmed" -- never manufactures
 * false precision by defaulting the other way.
 */
function normalizeStrategyProposal(raw: Partial<RawStrategyProposal> | null, proposalId: string, proposalVersion: number): StrategyProposal {
  const r = raw ?? ({} as Partial<RawStrategyProposal>);
  return {
    proposalId,
    proposalVersion,
    executiveSummary: {
      businessSituation: str(r.executiveSummary?.businessSituation),
      strategicProblem: str(r.executiveSummary?.strategicProblem),
      recommendedDirection: str(r.executiveSummary?.recommendedDirection),
      proposedIntervention: str(r.executiveSummary?.proposedIntervention),
      expectedBusinessEffect: str(r.executiveSummary?.expectedBusinessEffect),
      decisionRequired: str(r.executiveSummary?.decisionRequired, "Approve, refine, or reject this proposed intervention."),
    },
    businessContext: {
      entityContext: str(r.businessContext?.entityContext),
      businessObjectives: str(r.businessContext?.businessObjectives),
      relevantMarketContext: str(r.businessContext?.relevantMarketContext),
      relevantAudienceOrCustomerContext: str(r.businessContext?.relevantAudienceOrCustomerContext),
      currentState: str(r.businessContext?.currentState),
      engagementTrigger: str(r.businessContext?.engagementTrigger),
      relevantCommercialContext: str(r.businessContext?.relevantCommercialContext),
      evidence: arr(r.businessContext?.evidence),
    },
    strategicChallenge: {
      businessObjective: str(r.strategicChallenge?.businessObjective),
      observedSituation: str(r.strategicChallenge?.observedSituation),
      strategicQuestion: str(r.strategicChallenge?.strategicQuestion),
      whyItMatters: str(r.strategicChallenge?.whyItMatters),
    },
    diagnosis: {
      symptom: str(r.diagnosis?.symptom),
      problem: str(r.diagnosis?.problem),
      causes: arr(r.diagnosis?.causes),
      constraints: arr(r.diagnosis?.constraints),
      consequences: arr(r.diagnosis?.consequences),
      evidence: arr(r.diagnosis?.evidence),
      diagnosticConclusion: str(r.diagnosis?.diagnosticConclusion),
    },
    strategicOpportunity: {
      opportunity: str(r.strategicOpportunity?.opportunity),
      basis: str(r.strategicOpportunity?.basis),
      relevanceToBusinessObjective: str(r.strategicOpportunity?.relevanceToBusinessObjective),
      opportunityConditions: arr(r.strategicOpportunity?.opportunityConditions),
    },
    strategicObjective: {
      objective: str(r.strategicObjective?.objective),
      intendedChange: str(r.strategicObjective?.intendedChange),
      businessAlignment: str(r.strategicObjective?.businessAlignment),
      measurementDirection: str(r.strategicObjective?.measurementDirection),
    },
    recommendedDirection: {
      direction: str(r.recommendedDirection?.direction),
      rationale: str(r.recommendedDirection?.rationale),
      strategicLogic: str(r.recommendedDirection?.strategicLogic),
      alternativesConsidered: arr(r.recommendedDirection?.alternativesConsidered),
      selectionBasis: str(r.recommendedDirection?.selectionBasis),
    },
    proposedIntervention: {
      interventionName: str(r.proposedIntervention?.interventionName),
      interventionSummary: str(r.proposedIntervention?.interventionSummary),
      workstreams: Array.isArray(r.proposedIntervention?.workstreams)
        ? r.proposedIntervention!.workstreams.map((w) => ({
            name: str(w?.name),
            objective: str(w?.objective),
            activities: arr(w?.activities),
            output: str(w?.output),
            dependencies: arr(w?.dependencies),
            acceptanceCriteria: arr(w?.acceptanceCriteria),
          }))
        : [],
    },
    deliverables: Array.isArray(r.deliverables)
      ? r.deliverables.map((d) => ({ name: str(d?.name), description: str(d?.description), format: str(d?.format), acceptanceCriteria: arr(d?.acceptanceCriteria) }))
      : [],
    timeline: {
      status: r.timeline?.status === "Confirmed" ? "Confirmed" : "Indicative",
      totalDuration: str(r.timeline?.totalDuration, "Not yet reliably established."),
      phases: Array.isArray(r.timeline?.phases)
        ? r.timeline!.phases.map((p) => ({
            name: str(p?.name),
            duration: str(p?.duration),
            activities: arr(p?.activities),
            outputs: arr(p?.outputs),
            dependencies: arr(p?.dependencies),
            reviewPoint: str(p?.reviewPoint),
          }))
        : [],
    },
    entityInputs: {
      requiredInformation: arr(r.entityInputs?.requiredInformation),
      requiredDocuments: arr(r.entityInputs?.requiredDocuments),
      requiredAccess: arr(r.entityInputs?.requiredAccess),
      requiredStakeholderParticipation: arr(r.entityInputs?.requiredStakeholderParticipation),
      requiredDecisions: arr(r.entityInputs?.requiredDecisions),
    },
    assumptions: Array.isArray(r.assumptions) ? r.assumptions.map((a) => ({ assumption: str(a?.assumption), basis: str(a?.basis), materiality: str(a?.materiality) })) : [],
    dependencies: Array.isArray(r.dependencies)
      ? r.dependencies.map((d) => ({ dependency: str(d?.dependency), owner: str(d?.owner), impactIfUnavailable: str(d?.impactIfUnavailable) }))
      : [],
    risksAndConstraints: {
      risks: Array.isArray(r.risksAndConstraints?.risks)
        ? r.risksAndConstraints!.risks.map((x) => ({ risk: str(x?.risk), potentialEffect: str(x?.potentialEffect), mitigationOrResponse: str(x?.mitigationOrResponse) }))
        : [],
      constraints: Array.isArray(r.risksAndConstraints?.constraints)
        ? r.risksAndConstraints!.constraints.map((x) => ({ constraint: str(x?.constraint), implication: str(x?.implication) }))
        : [],
    },
    expectedBusinessEffect: {
      intendedEffects: arr(r.expectedBusinessEffect?.intendedEffects),
      measurableEffects: arr(r.expectedBusinessEffect?.measurableEffects),
      effectsRequiringBaseline: arr(r.expectedBusinessEffect?.effectsRequiringBaseline),
      limitations: arr(r.expectedBusinessEffect?.limitations),
    },
    successCriteria: Array.isArray(r.successCriteria)
      ? r.successCriteria.map((s) => ({ criterion: str(s?.criterion), measurement: str(s?.measurement), evidenceRequired: str(s?.evidenceRequired) }))
      : [],
    commercialScope: {
      included: arr(r.commercialScope?.included),
      excluded: arr(r.commercialScope?.excluded),
      expectedResources: arr(r.commercialScope?.expectedResources),
      expectedDuration: str(r.commercialScope?.expectedDuration),
      clientResponsibilities: arr(r.commercialScope?.clientResponsibilities),
      downstreamUnitResponsibilities: arr(r.commercialScope?.downstreamUnitResponsibilities),
    },
    strategicRecommendation: {
      recommendation: str(r.strategicRecommendation?.recommendation, str(r.executiveSummary?.recommendedDirection)),
      rationale: str(r.strategicRecommendation?.rationale),
      evidenceBasis: arr(r.strategicRecommendation?.evidenceBasis),
      conditionsOfApproval: arr(r.strategicRecommendation?.conditionsOfApproval),
    },
  };
}

/** Concise proposal preview per the canonical commercial flow's "Strategy Proposal Ready for Review" gate -- the full structured proposal remains available to the approval flow via state.strategyProposal itself, this is only the Telegram-facing summary. */
function formatProposalPreview(state: WorkState, proposal: StrategyProposal): string {
  const lines = [
    `*Strategy Proposal Ready for Review* (v${proposal.proposalVersion})`,
    `Entity: ${state.matterToken || state.entityToken || state.workId}`,
    `\n*Strategic problem:* ${proposal.executiveSummary.strategicProblem}`,
    `\n*Recommended direction:* ${proposal.recommendedDirection.direction || proposal.executiveSummary.recommendedDirection}`,
    `\n*Proposed intervention:* ${proposal.proposedIntervention.interventionName} -- ${proposal.proposedIntervention.interventionSummary}`,
    proposal.commercialScope.included.length ? `\n*Scope (included):* ${proposal.commercialScope.included.join("; ")}` : null,
    proposal.deliverables.length ? `\n*Deliverables:* ${proposal.deliverables.map((d) => d.name).join("; ")}` : null,
    `\n*Timeline (${proposal.timeline.status}):* ${proposal.timeline.totalDuration}`,
    `\n*Expected business effect:* ${proposal.executiveSummary.expectedBusinessEffect}`,
    proposal.assumptions.length ? `\n*Key assumptions:* ${proposal.assumptions.map((a) => a.assumption).join("; ")}` : null,
    proposal.risksAndConstraints.risks.length || proposal.risksAndConstraints.constraints.length
      ? `\n*Key risks/constraints:* ${[...proposal.risksAndConstraints.risks.map((r) => r.risk), ...proposal.risksAndConstraints.constraints.map((c) => c.constraint)].join("; ")}`
      : null,
    `\n*Decision required:* ${proposal.executiveSummary.decisionRequired}\n\nThis is a recommendation, not yet an approved decision.`,
  ].filter(Boolean);
  return lines.join("\n").slice(0, 3900);
}

/**
 * Deterministic post-check on the AI-drafted proposal -- mirrors
 * evaluateCausationDiscipline's role for the diagnosis step: the AI's own
 * output is never taken on trust merely because it parsed as valid JSON. A
 * proposal missing any section Martin needs to actually evaluate what's
 * being proposed (or Finance needs to price it without redesigning it) is
 * never presented for approval as-is -- developStrategyProposal instead
 * treats this the same as any other blocked/insufficient outcome (Held,
 * with the specific missing sections named, recoverable via the existing
 * Held -> Pending retry path).
 */
export function evaluateProposalCompleteness(proposal: StrategyProposal): { valid: true } | { valid: false; reason: string } {
  const missing: string[] = [];
  if (!proposal.executiveSummary.businessSituation) missing.push("executive summary: business situation");
  if (!proposal.executiveSummary.strategicProblem) missing.push("executive summary: strategic problem");
  if (!proposal.executiveSummary.recommendedDirection) missing.push("executive summary: recommended direction");
  if (!proposal.executiveSummary.proposedIntervention) missing.push("executive summary: proposed intervention");
  if (!proposal.executiveSummary.expectedBusinessEffect) missing.push("executive summary: expected business effect");
  if (!proposal.strategicObjective.objective) missing.push("strategic objective");
  if (!proposal.recommendedDirection.direction) missing.push("recommended direction");
  if (!proposal.proposedIntervention.interventionName) missing.push("proposed intervention name");
  if (proposal.proposedIntervention.workstreams.length === 0) missing.push("intervention workstreams");
  if (proposal.deliverables.length === 0) missing.push("deliverables");
  if (proposal.timeline.phases.length === 0) missing.push("timeline phases");
  if (proposal.commercialScope.included.length === 0) missing.push("commercial scope (included)");
  if (proposal.assumptions.length === 0) missing.push("assumptions");
  if (proposal.risksAndConstraints.risks.length === 0 && proposal.risksAndConstraints.constraints.length === 0) missing.push("risks/constraints");
  if (proposal.expectedBusinessEffect.intendedEffects.length === 0) missing.push("expected business effect (intended effects)");
  if (proposal.successCriteria.length === 0) missing.push("success criteria");

  if (missing.length > 0) {
    return { valid: false, reason: `The drafted proposal is missing required section(s): ${missing.join("; ")}.` };
  }
  return { valid: true };
}

/**
 * Develops the complete Strategic Intervention Proposal from a validated
 * diagnosis and presents it for Martin's explicit Approve/Refine/Reject
 * decision -- the canonical commercial flow's gate before any Strategy ->
 * Finance Handoff may be created. A fresh proposalId + incremented
 * proposalVersion is minted every time this runs (initial proposal, or a
 * revised one after Refine); the prior version (if any) is preserved in
 * strategyProposalHistory, never discarded. The exact identity (workId +
 * proposalId + proposalVersion) is embedded in both pendingStrategyApproval
 * and the callback_data (as "<proposalId>.<version>.<decision>", joined with
 * "." rather than ":" so it survives the router's plain data.split(":")
 * unchanged) -- handleInterventionApproval checks all three against
 * pendingStrategyApproval exactly, so a stale button from an earlier or
 * superseded proposal can never approve a different/later one.
 */
async function developStrategyProposal(env: Env, state: WorkState, diagnosis: StrategyDiagnosisResult): Promise<WorkState> {
  const governance = await getStrategyGovernance(env);
  if (!governance) {
    return handleBlocked(env, state, "Could not retrieve canonical Strategy Analyst Hat Definition and/or Universal Role Contract from Notion while developing the proposal. Refusing to proceed without it.");
  }

  await advanceStrategyProgress(env, state, "Developing the full Strategic Intervention Proposal...");

  const raw = await aiJson<RawStrategyProposal>(env, {
    taskId: "strategy.proposal_drafting",
    system: buildProposalDraftingSystemPrompt(governance.hatDefinition, governance.universalRoleContract, diagnosis),
    user: state.strategyContext ?? "",
    maxTokens: 4000,
  });
  if (!raw) {
    return handleBlocked(env, state, "Could not generate a complete Strategic Intervention Proposal from the validated diagnosis -- the drafting call returned no usable output.");
  }

  const nextVersion = (state.strategyProposal?.proposalVersion ?? 0) + 1;
  const proposalId = crypto.randomUUID();
  const proposal = normalizeStrategyProposal(raw, proposalId, nextVersion);

  const completeness = evaluateProposalCompleteness(proposal);
  if (!completeness.valid) {
    console.error(`Strategy developStrategyProposal: proposal failed completeness check for work ${state.workId}: ${completeness.reason}`);
    // Nothing is mutated on this path -- the prior proposal (if any) and
    // its approval state are left exactly as they were, so a retry (via
    // the existing Held -> Pending path) re-drafts cleanly rather than
    // leaving a half-adopted revision in place.
    return handleBlocked(env, state, `${completeness.reason} Not presenting this as-is for approval.`);
  }

  const previousVersion = state.strategyProposal;
  if (previousVersion) {
    state.strategyProposalHistory = [...(state.strategyProposalHistory ?? []), previousVersion];
  }
  const proposalVersion = nextVersion;
  state.strategyProposal = proposal;

  await logActivity(env, {
    entry: `Strategy Proposal ${previousVersion ? "revised (v" + proposalVersion + ")" : "created"}: ${state.matterToken || state.entityToken || state.workId}`,
    type: "Decision",
    area: "Strategy",
    decisions: proposal.recommendedDirection.direction,
    decisionRationale: proposal.recommendedDirection.rationale,
    outcome: "Blocked",
  });

  const message = formatProposalPreview(state, proposal);
  // Telegram's callback_data has a hard 64-byte limit. workId alone is a
  // 36-char UUID (required so index.ts's data.split(":") can resolve the
  // right WorkSession), so the value portion here must be tiny -- a single
  // decision letter plus the integer proposalVersion is enough: version is
  // already a strictly-incrementing per-work-item counter, so it alone
  // (checked against pendingStrategyApproval.proposalVersion) gives the
  // same stale/superseded-proposal protection a full proposalId would,
  // without needing the UUID to round-trip through Telegram at all -- the
  // UUID itself is still kept in state.strategyProposal.proposalId for
  // internal bookkeeping/logging.
  const buttons = [
    [
      { text: "✅ Approve", callback_data: `sprop:${state.workId}:${proposalVersion}.a` },
      { text: "🔁 Refine", callback_data: `sprop:${state.workId}:${proposalVersion}.r` },
    ],
    [{ text: "❌ Reject", callback_data: `sprop:${state.workId}:${proposalVersion}.j` }],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, message, buttons);

  state.pendingStrategyApproval = {
    kind: "strategy_intervention",
    strategyWorkSessionId: state.workId,
    proposalId,
    proposalVersion,
    decisionOptions: ["approve", "refine", "reject"],
  };
  state.pendingActionSummary = {
    label: `Strategy Proposal v${proposalVersion}: ${state.matterToken || state.entityToken || state.workId}`,
    message,
    buttons,
    createdAt: new Date().toISOString(),
  };
  await logActivity(env, {
    entry: `Strategy approval request sent to Martin: ${state.matterToken || state.entityToken || state.workId}`,
    type: "Activity",
    area: "Strategy",
    activity: `Proposal v${proposalVersion} (${proposalId}) awaiting Approve/Refine/Reject.`,
    outcome: "Active",
  });

  state.strategyApprovalState = "AWAITING_INTERVENTION_APPROVAL";
  state.stage = "awaiting_intervention_approval";
  state.awaiting = undefined;
  return state;
}

/**
 * Serializes the APPROVED Strategic Intervention Proposal for the Strategy
 * -> Finance Handoff's "Work Completed" field -- the complete commercially
 * relevant proposal (business situation, strategic problem, diagnosis,
 * strategic objective, recommended direction, approved intervention,
 * workstreams, deliverables, timeline, commercial scope, expected business
 * effect, success criteria, dependencies, assumptions, risks/constraints),
 * never merely proposedIntervention, per the canonical commercial flow.
 */
function formatApprovedProposalForFinance(proposal: StrategyProposal): string {
  const lines: string[] = [
    `Business situation: ${proposal.executiveSummary.businessSituation}`,
    `Strategic problem: ${proposal.executiveSummary.strategicProblem}`,
    `Diagnosis: ${proposal.diagnosis.diagnosticConclusion} (symptom: ${proposal.diagnosis.symptom}; problem: ${proposal.diagnosis.problem}; causes: ${proposal.diagnosis.causes.join("; ")}; constraints: ${proposal.diagnosis.constraints.join("; ")}; consequences: ${proposal.diagnosis.consequences.join("; ")})`,
    `Strategic objective: ${proposal.strategicObjective.objective} -- ${proposal.strategicObjective.intendedChange}`,
    `Approved recommended direction: ${proposal.recommendedDirection.direction}\nRationale: ${proposal.recommendedDirection.rationale}`,
    `Approved intervention: ${proposal.proposedIntervention.interventionName} -- ${proposal.proposedIntervention.interventionSummary}`,
    `Workstreams: ${proposal.proposedIntervention.workstreams.map((w) => `${w.name} (${w.objective}; output: ${w.output})`).join(" | ") || "(none specified)"}`,
    `Deliverables: ${proposal.deliverables.map((d) => `${d.name}: ${d.description} [${d.format}]`).join(" | ") || "(none specified)"}`,
    `Timeline (${proposal.timeline.status}): ${proposal.timeline.totalDuration} -- ${proposal.timeline.phases.map((p) => `${p.name} (${p.duration})`).join(" | ") || "(no phases specified)"}`,
    `Commercial scope: included -- ${proposal.commercialScope.included.join("; ") || "(none specified)"}; excluded -- ${proposal.commercialScope.excluded.join("; ") || "(none specified)"}`,
    `Expected business effect: ${proposal.executiveSummary.expectedBusinessEffect}. Intended: ${proposal.expectedBusinessEffect.intendedEffects.join("; ")}. Measurable: ${proposal.expectedBusinessEffect.measurableEffects.join("; ")}. Limitations: ${proposal.expectedBusinessEffect.limitations.join("; ")}`,
    `Success criteria: ${proposal.successCriteria.map((s) => `${s.criterion} (measured by: ${s.measurement})`).join("; ") || "(none specified)"}`,
    `Relevant dependencies: ${proposal.dependencies.map((d) => `${d.dependency} (owner: ${d.owner})`).join("; ") || "(none specified)"}`,
    `Relevant assumptions: ${proposal.assumptions.map((a) => `${a.assumption} (${a.materiality})`).join("; ") || "(none specified)"}`,
    `Relevant risks/constraints: ${[...proposal.risksAndConstraints.risks.map((r) => r.risk), ...proposal.risksAndConstraints.constraints.map((c) => c.constraint)].join("; ") || "(none specified)"}`,
  ];
  return lines.join("\n\n");
}

/**
 * Martin's Approve/Refine/Reject decision on the current Strategy Proposal.
 * Verifies, before mutating anything: strategyApprovalState is exactly
 * AWAITING_INTERVENTION_APPROVAL, pendingStrategyApproval exists, and its
 * strategyWorkSessionId/proposalId/proposalVersion all match the callback
 * exactly -- a callback for a stale/superseded proposal version, or for a
 * different/completed WorkSession, is a logged no-op, never a mutation, per
 * the existing fail-closed stage-guard pattern used by every other approval
 * gate in this Worker (e.g. Finance's handleQuoteApproval). Reuses the
 * existing generic Telegram-callback/approval infrastructure -- no new
 * callback/approval mechanism was introduced.
 */
export async function handleInterventionApproval(
  env: Env,
  state: WorkState,
  proposalVersion: number,
  decision: "approve" | "refine" | "reject",
): Promise<WorkState> {
  // Note: only proposalVersion travels through the Telegram callback (see
  // developStrategyProposal's button construction -- callback_data has a
  // hard 64-byte limit, too small to also carry the full-UUID proposalId
  // alongside the required workId). proposalVersion is a strictly-
  // incrementing per-work-item counter, so matching it against
  // pendingStrategyApproval/state.strategyProposal gives the same
  // stale/superseded-proposal protection a proposalId match would.
  const pending = state.pendingStrategyApproval;
  const proposal = state.strategyProposal;
  const identityMatches =
    state.strategyApprovalState === "AWAITING_INTERVENTION_APPROVAL" &&
    !!pending &&
    pending.strategyWorkSessionId === state.workId &&
    pending.proposalVersion === proposalVersion &&
    !!proposal &&
    proposal.proposalVersion === proposalVersion &&
    proposal.proposalId === pending.proposalId;

  if (!identityMatches) {
    console.error(`Strategy handleInterventionApproval: stale/mismatched callback for work ${state.workId} (version ${proposalVersion})`);
    await logActivity(env, {
      entry: `Strategy proposal approval callback ignored — stale or superseded`,
      type: "Blocker",
      area: "Strategy",
      decisionRationale: `Callback v${proposalVersion} did not match the current pending approval (state: ${state.strategyApprovalState ?? "none"}). Treated as a no-op.`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "This proposal has already been resolved or superseded -- nothing to do.");
    return state;
  }

  if (decision === "refine") {
    state.pendingStrategyApproval = undefined;
    state.pendingActionSummary = undefined;
    state.strategyApprovalState = "REFINEMENT_REQUESTED";
    await logActivity(env, {
      entry: `Strategy proposal refinement requested: ${state.matterToken || state.entityToken || state.workId}`,
      type: "Decision",
      area: "Strategy",
      decisionRationale: "Martin requested changes to the proposal. A refinement is not an approval -- no Finance Handoff created; the prior version is retained as historical context.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "Got it -- what should change about this proposal? Tell me what's off or what to take into account, and I'll produce a revised version.");
    state.stage = "strategy_refining";
    state.awaiting = "strategy_refinement_reason";
    return state;
  }

  if (decision === "reject") {
    state.pendingStrategyApproval = undefined;
    state.pendingActionSummary = undefined;
    state.strategyApprovalState = "REJECTED";
    if (state.handoffId) {
      await closeHandoffIfOpen(
        env,
        state.handoffId,
        "Strategy Proposal rejected by Martin with no further direction -- a materially new strategic attempt requires a new Handoff.",
      ).catch((err) => console.error(`Strategy: failed to close originating Handoff ${state.handoffId} on rejection`, err));
    }
    await logActivity(env, {
      entry: `Strategy proposal rejected by Martin: ${state.matterToken || state.entityToken || state.workId}`,
      type: "Decision",
      area: "Strategy",
      decisionRationale: "Martin rejected the proposal outright, with no further direction. No Finance Handoff created; the current strategic attempt is closed and will not be reopened automatically.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, `Understood -- this proposal for *${state.matterToken || state.entityToken}* has been rejected and closed. A new attempt would need a new Handoff.`);
    state.stage = "strategy_rejected";
    state.awaiting = undefined;
    return state;
  }

  // decision === "approve"
  try {
    const handoff = await createHandoff(
      env,
      {
        Handoff: title(`Value-based quote request — ${state.matterToken || state.entityToken || state.workId}`),
        "From Unit": select("Strategy"),
        "From Hat": richText(HAT_NAME),
        "To Unit": select("Finance"),
        "To Hat": richText("Value-Based Pricing Assessor"),
        Type: select("Work"),
        Status: select("Pending"),
        Reason: richText(`Martin-approved Strategic Intervention Proposal (v${proposal!.proposalVersion}) ready for value-based pricing: ${proposal!.proposedIntervention.interventionName}`.slice(0, 1900)),
        "Required Next Action": richText(
          "Conduct value-based pricing assessment of the approved Strategy intervention without redesigning, substituting, removing, or materially altering it. Do not treat any disclosed budget or willingness-to-pay as the pricing basis -- price the approved intervention's value, or hold and state what's missing.",
        ),
        "Expected Output": richText(
          "An authoritative quote, currency, priced scope, pricing rationale, timing considered, pricing assumptions, and quote validity for the approved intervention -- or an explicit Held status naming the specific missing evidence.",
        ),
        "Acceptance Criteria": richText(
          "Approved intervention preserved; approved scope preserved; approved timeline considered; value-based pricing applied; budget/WTP not used as pricing basis; no strategic redesign; no material substitution; pricing assumptions explicit; currency correct.",
        ),
        Entity_Token: richText(state.entityToken ?? ""),
        Matter_Token: richText(state.matterToken ?? ""),
        Assumptions: richText(proposal!.assumptions.map((a) => `${a.assumption} (${a.basis}; materiality: ${a.materiality})`).join("\n").slice(0, 1900)),
        "Open Questions": richText(proposal!.expectedBusinessEffect.limitations.join("\n").slice(0, 1900)),
        "Verified Facts & Sources": richText(formatApprovedProposalForFinance(proposal!).slice(0, 1900)),
      },
      { entityToken: state.entityToken ?? "", matterToken: state.matterToken ?? "" },
    );

    // Close the Sales -> Strategy Handoff only now that the approved
    // proposal has been successfully transferred onward -- per the
    // canonical flow, this is deferred until here (not at proposal-
    // development time), and only after the Finance Handoff actually exists.
    if (state.handoffId) {
      await updateHandoff(env, state.handoffId, {
        Status: select("Closed"),
        "Work Completed": richText(`Proposal v${proposal!.proposalVersion} approved by Martin and handed off to Finance (Handoff ${handoff.id}): ${proposal!.proposedIntervention.interventionName}`.slice(0, 1900)),
      }).catch((err) => console.error(`Strategy: failed to close originating Handoff ${state.handoffId}`, err));
    }

    await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, state.workId);
    state.handoffId = handoff.id;
    state.pendingStrategyApproval = undefined;
    state.pendingActionSummary = undefined;
    state.strategyApprovalState = "APPROVED";

    await logActivity(env, {
      entry: `Martin approved Strategy Proposal -- Strategy -> Finance Handoff created`,
      type: "Decision",
      area: "Strategy",
      decisions: `Approved: ${proposal!.proposedIntervention.interventionName}`,
      decisionRationale: `Handoff ${handoff.id} created for Finance to price the approved intervention (proposal v${proposal!.proposalVersion}).`,
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
    // Leave pendingStrategyApproval/strategyApprovalState intact so
    // approving again actually retries, rather than silently having
    // nothing left to act on.
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT_NAME }, "Couldn't create the Handoff to Finance -- please try approving again.");
  }

  return state;
}

/** Revision loop after Refine: re-runs the diagnosis with Martin's reasoning, then develops and re-presents a fresh proposal version for approval. */
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

  await updateHandoff(env, state.handoffId, {
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
