import type { Env } from "../../types";
import { aiJson } from "../../ai";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";

/**
 * Strategy's composable specialist-diagnosis model (LOG-845, Notion
 * Activity & Decision Log -- "Strategy specialist diagnosis model
 * established"; canonical architecture: the Strategy Unit page and the
 * Strategy Analyst/Business Strategist/Brand Strategist/Communication
 * Strategist Hat Definitions, all under ENIG HQ / 2. Units & Hats).
 *
 * This file owns ONLY the new composition/orchestration layer: which
 * strategic domains are required (selectRequiredSpecialists), bounded
 * per-domain diagnosis (runSpecialistDiagnosis /
 * runSpecialistDiagnosesConcurrently), and reconciling the resulting
 * findings into a single synthesized context (synthesizeSpecialistFindings).
 * It does NOT touch strategyAnalyst.ts's existing diagnosis/proposal/
 * approval pipeline -- strategyAnalyst.ts's runDiagnosis wrapper calls
 * into this file, folds the synthesis into state.strategyContext, and
 * then calls the original (renamed, otherwise byte-for-byte unchanged)
 * runCoreDiagnosis exactly as before. See strategyAnalyst.ts's own
 * updated doc comment for how the two files fit together.
 *
 * Per the canonical operating_procedure (Strategy Analyst Hat
 * Definition, steps 3-5), this composition step runs BEFORE the existing
 * Symptom -> Problem -> Cause -> Constraint -> Consequence diagnosis
 * (steps 6-7) -- its output is additional, reconciled context for that
 * unchanged diagnosis, never a replacement for it, and never itself the
 * canonical Strategy Proposal (composition_rules: "Specialist Hats
 * return diagnostic findings, not independent Strategy Proposals";
 * "Specialists must not directly modify the canonical Strategy Proposal
 * during concurrent diagnosis" -- neither this file nor any specialist
 * finding ever reads or writes state.strategyProposal).
 *
 * Data boundary: every specialist and the synthesis step receive only
 * the SAME already-sanitized state.strategyContext the existing
 * diagnosis already consumes (itself already governed by
 * evaluateHandoffContext/resolveStrategyHandoffContext under
 * strategy.diagnosis's existing TOKEN_SAFE_RUNTIME outbound policy) --
 * no new raw or identity-bearing input is introduced, and no specialist
 * ever sees another specialist's in-progress state. This satisfies
 * "bounded context" without inventing a second redaction mechanism.
 *
 * Concurrency: implemented at the task/work-item level via Promise.all
 * over the selected specialists' own independent aiJson calls, all
 * within the same Cloudflare Worker invocation and the same parent
 * WorkState/workId -- no separate Worker, no separate WorkSession per
 * specialist, exactly per the canonical architecture's own
 * "Concurrent Diagnosis" section ("does not create multiple independent
 * Strategy workflows or require separate infrastructure").
 */

export type StrategySpecialistDomain = "business" | "brand" | "communication";

const BUSINESS_STRATEGIST_HAT_DEFINITION_PAGE_ID = "3e6cb004-e583-81f9-9584-cf19a7d45395";
const BRAND_STRATEGIST_HAT_DEFINITION_PAGE_ID = "3e6cb004-e583-810d-a6b8-c90e8be2b8cc";
const COMMUNICATION_STRATEGIST_HAT_DEFINITION_PAGE_ID = "3e6cb004-e583-8128-828c-d9da5c168ffe";

interface SpecialistProfile {
  domain: StrategySpecialistDomain;
  hatName: string;
  hatDefinitionPageId: string;
  taskId: "strategy.business_diagnosis" | "strategy.brand_diagnosis" | "strategy.communication_diagnosis";
  diagnosticDomainsSummary: string;
}

const SPECIALIST_PROFILES: Record<StrategySpecialistDomain, SpecialistProfile> = {
  business: {
    domain: "business",
    hatName: "Business Strategist",
    hatDefinitionPageId: BUSINESS_STRATEGIST_HAT_DEFINITION_PAGE_ID,
    taskId: "strategy.business_diagnosis",
    diagnosticDomainsSummary: "business model, growth model, market opportunity, competitive position, commercial direction, business objectives, and material commercial constraints",
  },
  brand: {
    domain: "brand",
    hatName: "Brand Strategist",
    hatDefinitionPageId: BRAND_STRATEGIST_HAT_DEFINITION_PAGE_ID,
    taskId: "strategy.brand_diagnosis",
    diagnosticDomainsSummary: "positioning, differentiation, perception, brand architecture, value proposition, and brand relevance",
  },
  communication: {
    domain: "communication",
    hatName: "Communication Strategist",
    hatDefinitionPageId: COMMUNICATION_STRATEGIST_HAT_DEFINITION_PAGE_ID,
    taskId: "strategy.communication_diagnosis",
    diagnosticDomainsSummary: "messaging, narrative, audience communication, communication hierarchy, communication architecture, and value proposition expression",
  },
};

/**
 * The bounded diagnostic finding a specialist returns to Strategy Analyst
 * -- never a Strategy Proposal. Shape matches the canonical architecture's
 * own required fields exactly (Strategy Unit page, "Specialist findings
 * must preserve"): strategic domain, problem/issue examined, supporting
 * evidence, diagnosis, strategic implication, intervention implication
 * (only if justified -- a specialist may conclude its domain does not
 * justify an intervention), uncertainty/limitations, unresolved
 * questions.
 */
export interface SpecialistFinding {
  domain: StrategySpecialistDomain;
  status: "completed" | "failed";
  /** Only present when status is "failed" -- Strategy Analyst must know a required finding is unavailable, never silently substitute another specialist's assumptions for it. */
  failureReason?: string;
  domainExamined?: string;
  problemOrIssue?: string;
  supportingEvidence?: string;
  diagnosis?: string;
  strategicImplication?: string;
  /** Only present if the specialist judged an intervention in its domain is actually justified -- never assumed merely because the specialist was selected. */
  interventionImplication?: string;
  uncertaintyAndLimitations?: string;
  unresolvedQuestions?: string;
}

export interface SpecialistSelectionResult {
  /** Empty array is a valid, expected outcome ("No specialist when the Strategy Analyst can responsibly resolve the question from the available evidence"). */
  domains: StrategySpecialistDomain[];
  reasoning: string;
}

const VALID_DOMAINS: StrategySpecialistDomain[] = ["business", "brand", "communication"];

/**
 * Step 3 of the canonical operating procedure: determine which strategic
 * domains require specialist diagnosis. Explicitly instructed never to
 * assume a domain's mere relevance means it IS the intervention (per the
 * Hat Definition's own rule: "Select specialist Hats because the
 * situation requires their domain of judgment, not because their domain
 * is presumed to be the intervention"). Returns null on failure --
 * callers must fail closed, never silently proceed as if "no specialist"
 * were a genuine determination when the classifier itself simply failed.
 */
export async function selectRequiredSpecialists(env: Env, strategyQuestion: string, strategyContext: string): Promise<SpecialistSelectionResult | null> {
  const result = await aiJson<{ domains?: string[]; reasoning?: string }>(env, {
    taskId: "strategy.specialist_selection",
    system: [
      "You are executing the Strategy Analyst Hat's specialist-selection responsibility (step 3 of its canonical operating procedure), retrieved from ENIG's canonical Notion governance for the Strategy Unit's composable specialist-diagnosis model.",
      "Three specialist Hats are available:",
      "- \"business\" (Business Strategist): business model, growth model, market opportunity, competitive position, commercial direction, business objectives, material commercial constraints.",
      "- \"brand\" (Brand Strategist): positioning, differentiation, perception, brand architecture, value proposition, brand relevance.",
      "- \"communication\" (Communication Strategist): messaging, narrative, audience communication, communication hierarchy, communication architecture, value proposition expression.",
      "Select a specialist because the situation genuinely requires that domain of judgment to responsibly diagnose the strategic question -- NEVER because a symptom merely touches that domain. For example, a situation may present a brand symptom (e.g. inconsistent visual identity) while the underlying problem is actually commercial (e.g. a business-model mismatch) -- in that case select \"business\", not \"brand\", or both if genuinely both domains of judgment are needed to resolve the question.",
      "Valid outcomes: zero specialists (the Strategy Analyst can responsibly resolve the question directly from the available evidence and established strategic reasoning -- this is a normal, expected outcome, not a fallback), one specialist, or multiple specialists (when the situation has materially independent strategic dimensions).",
      "Never select a specialist merely to be thorough, and never select all three by default.",
      'Return JSON: {"domains": ["business" | "brand" | "communication", ...] (empty array if none are required), "reasoning": "..."}',
    ].join("\n\n"),
    user: `Strategic question: ${strategyQuestion}\n\nSituation/context:\n${strategyContext}`,
    light: true,
  });

  if (!result || !Array.isArray(result.domains)) return null;

  const domains = result.domains.filter((d): d is StrategySpecialistDomain => VALID_DOMAINS.includes(d as StrategySpecialistDomain));
  // Dedupe -- the classifier should never repeat a domain, but never trust that structurally.
  const uniqueDomains = Array.from(new Set(domains));
  return { domains: uniqueDomains, reasoning: result.reasoning ?? "" };
}

function buildSpecialistSystemPrompt(profile: SpecialistProfile, hatDefinition: string, universalRoleContract: string): string {
  return [
    `You are executing the ${profile.hatName} Hat, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for role, authority limits, boundaries, and stop conditions -- follow them exactly as written.`,
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution mechanics -- not part of the governance above) ===",
    `Diagnose the ${profile.domain} dimensions of the strategic situation below -- ${profile.diagnosticDomainsSummary}. You were selected because the situation was judged to require this domain of judgment; this does NOT mean your domain is necessarily the required intervention -- you may conclude your domain does not justify one. Distinguish evidence from interpretation, inference, and recommendation throughout. Never assert causation without sufficient support. Never treat information supplied in the context as established fact merely because it was supplied.`,
    "You do not produce the canonical Strategy Proposal, and you must not modify it -- only the Strategy Analyst does that, after reconciling every specialist's bounded finding.",
    "=== RESPONSE FORMAT (execution mechanics -- not part of the governance above) ===",
    `Return JSON exactly matching this shape:
{
  "sufficient": true | false,
  "blockedReason": "..." (only if sufficient=false -- state exactly what is missing/ambiguous, per your Hat's own stop conditions),
  "domainExamined": "...",
  "problemOrIssue": "...",
  "supportingEvidence": "...",
  "diagnosis": "...",
  "strategicImplication": "...",
  "interventionImplication": "..." (OMIT this field entirely if your domain does not justify an intervention -- never fill it in just because the field exists),
  "uncertaintyAndLimitations": "...",
  "unresolvedQuestions": "..."
}
Only include domainExamined/problemOrIssue/supportingEvidence/diagnosis/strategicImplication/uncertaintyAndLimitations/unresolvedQuestions if sufficient=true.`,
  ].join("\n\n");
}

/**
 * Runs one specialist's bounded diagnosis. Never throws -- any governance/
 * AI-call failure becomes a `status: "failed"` finding instead, so a
 * single specialist's failure can never crash the concurrent batch (see
 * runSpecialistDiagnosesConcurrently) and Strategy Analyst always
 * explicitly knows when a required finding is unavailable, rather than
 * that unavailability silently vanishing.
 */
export async function runSpecialistDiagnosis(env: Env, domain: StrategySpecialistDomain, strategyContext: string): Promise<SpecialistFinding> {
  const profile = SPECIALIST_PROFILES[domain];
  try {
    const [hatDefinition, universalRoleContract] = await Promise.all([
      getGovernance(env, profile.hatDefinitionPageId, `${profile.hatName} Hat Definition`),
      getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
    ]);
    if (!hatDefinition || !universalRoleContract) {
      return { domain, status: "failed", failureReason: `Could not retrieve canonical ${profile.hatName} Hat Definition and/or Universal Role Contract from Notion.` };
    }

    const result = await aiJson<{
      sufficient?: boolean;
      blockedReason?: string;
      domainExamined?: string;
      problemOrIssue?: string;
      supportingEvidence?: string;
      diagnosis?: string;
      strategicImplication?: string;
      interventionImplication?: string;
      uncertaintyAndLimitations?: string;
      unresolvedQuestions?: string;
    }>(env, {
      taskId: profile.taskId,
      system: buildSpecialistSystemPrompt(profile, hatDefinition, universalRoleContract),
      user: strategyContext,
      light: true,
    });

    if (!result || result.sufficient !== true) {
      return { domain, status: "failed", failureReason: result?.blockedReason ?? "Could not complete a defensible diagnosis from the supplied context." };
    }

    return {
      domain,
      status: "completed",
      domainExamined: result.domainExamined ?? "",
      problemOrIssue: result.problemOrIssue ?? "",
      supportingEvidence: result.supportingEvidence ?? "",
      diagnosis: result.diagnosis ?? "",
      strategicImplication: result.strategicImplication ?? "",
      interventionImplication: result.interventionImplication,
      uncertaintyAndLimitations: result.uncertaintyAndLimitations ?? "",
      unresolvedQuestions: result.unresolvedQuestions ?? "",
    };
  } catch (err) {
    console.error(`Strategy specialist diagnosis (${domain}) threw unexpectedly`, err);
    return { domain, status: "failed", failureReason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs every selected specialist's diagnosis concurrently (Promise.all --
 * runSpecialistDiagnosis itself never rejects, so this never short-
 * circuits on one failure) under the same parent WorkState/workId,
 * exactly per the canonical architecture's own "run sufficiently
 * independent specialist diagnoses concurrently where the runtime
 * supports it." No separate Worker or WorkSession is created -- this is
 * concurrency at the task/work-item level within one Worker invocation.
 */
export async function runSpecialistDiagnosesConcurrently(env: Env, domains: StrategySpecialistDomain[], strategyContext: string): Promise<SpecialistFinding[]> {
  return Promise.all(domains.map((domain) => runSpecialistDiagnosis(env, domain, strategyContext)));
}

export interface SpecialistSynthesisResult {
  /** false means the specialist findings (available ones, plus any explicit unavailability) do not yet provide a sufficient basis to proceed -- Strategy Analyst must not represent the synthesis as complete. */
  sufficient: boolean;
  insufficiencyReason?: string;
  /** Reconciled narrative folded into state.strategyContext as additional input to the unchanged core diagnosis -- never a replacement for it. */
  synthesizedContext?: string;
  agreements?: string;
  disagreements?: string;
  crossDomainRelationships?: string;
  materialUncertainty?: string;
}

/**
 * Step 5 of the canonical operating procedure: reconcile specialist
 * findings. Distinguishes evidence from inference, identifies agreement/
 * disagreement and cross-domain relationships, and -- critically --
 * explicitly judges whether the available findings (including any
 * explicitly failed/unavailable ones) are sufficient to proceed, rather
 * than silently treating a partial result as complete. A failed
 * specialist's unavailability is passed in explicitly (never omitted, and
 * never backfilled with another specialist's assumptions) so the model
 * can weigh whether its absence is material.
 */
export async function synthesizeSpecialistFindings(env: Env, strategyQuestion: string, findings: SpecialistFinding[]): Promise<SpecialistSynthesisResult | null> {
  const findingsText = findings
    .map((f) => {
      if (f.status === "failed") {
        return `[${f.domain}] UNAVAILABLE -- ${f.failureReason ?? "diagnosis could not be completed"}.`;
      }
      return [
        `[${f.domain}] Domain examined: ${f.domainExamined}`,
        `Problem/issue: ${f.problemOrIssue}`,
        `Supporting evidence: ${f.supportingEvidence}`,
        `Diagnosis: ${f.diagnosis}`,
        `Strategic implication: ${f.strategicImplication}`,
        f.interventionImplication ? `Intervention implication: ${f.interventionImplication}` : `Intervention implication: (this specialist concluded its domain does not justify an intervention)`,
        `Uncertainty/limitations: ${f.uncertaintyAndLimitations}`,
        `Unresolved questions: ${f.unresolvedQuestions}`,
      ].join("\n");
    })
    .join("\n\n");

  const result = await aiJson<SpecialistSynthesisResult>(env, {
    taskId: "strategy.specialist_synthesis",
    system: [
      "You are executing the Strategy Analyst Hat's synthesis responsibility (step 5 of its canonical operating procedure) -- the sole synthesis authority for the Strategy Unit, reconciling bounded specialist findings before the unchanged Symptom -> Problem -> Cause -> Constraint -> Consequence diagnosis proceeds.",
      "You are given one or more specialist findings below. Some may be marked UNAVAILABLE -- a specialist whose diagnosis could not be completed. Never substitute another specialist's assumptions for an unavailable one, and never treat an unavailable finding as if it were a negative/neutral result -- it is simply missing.",
      "Reconcile the available findings: distinguish evidence from interpretation/inference, identify where findings agree, identify where findings materially disagree and whether that disagreement can be reconciled, identify cross-domain relationships (e.g. a business-model finding that explains a brand-perception finding), and identify material uncertainty across the findings as a whole.",
      "Set sufficient=false if: a required specialist's finding is unavailable and its absence is material to responsibly proceeding, OR findings materially conflict and cannot be reconciled from what's given. Do not set sufficient=true merely because some findings are available -- judge whether what's available is actually enough.",
      "synthesizedContext should be a plain-prose narrative (not the raw findings restated) that the strategic diagnosis step can use as additional grounded context -- state what the specialists established, what remains uncertain, and any cross-domain relationships, without asserting a diagnosis or recommendation yourself (that remains the diagnosis step's own responsibility).",
      'Return JSON: {"sufficient": true|false, "insufficiencyReason": "..." (only if sufficient=false), "synthesizedContext": "..." (only if sufficient=true), "agreements": "...", "disagreements": "...", "crossDomainRelationships": "...", "materialUncertainty": "..."}',
    ].join("\n\n"),
    user: `Strategic question: ${strategyQuestion}\n\nSpecialist findings:\n${findingsText}`,
    light: true,
    maxTokens: 2000,
  });

  return result ?? null;
}
