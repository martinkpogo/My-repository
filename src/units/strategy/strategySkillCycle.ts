import type { Env } from "../../types";
import { generate, generateWithOutcome, type AiFailureCause } from "../../ai";
import type { SemanticTaskId } from "../../dataBoundary/types";
import type { ResolvedActionSkillSet, SkillId } from "../../platform/skillRegistry";

/**
 * Strategy's composable-Skills diagnosis: plan once, run in parallel,
 * synthesize once (ENIG Core Structure v3.0).
 *
 * **What replaced what.** The specialist domains are **Skills** -- bounded
 * methodology the Strategy Analyst itself follows -- not Hats (LOG-845's
 * Brand/Business/Communication Strategist Hats are retired; no Hat Definition
 * is fetched here and nothing in this file can switch Hats). This module
 * replaces the earlier sequential cycle, in which Strategy Analysis chose one
 * Skill per move and re-read the findings before choosing again. That loop
 * needed an invocation cap and a retry rule to stop a model that would not
 * conclude, and in live use (HO-86, 2026-10-06) it spent most of its moves
 * re-running Skills instead of synthesizing. The plan below has no loop, so it
 * needs neither.
 *
 * **The shape.** Strategy remains ONE organizational Hat (Strategy Analyst)
 * performing ONE Responsibility (`own_strategic_diagnosis`). Its `diagnose`
 * Action declares a set of Skills; the Registry resolves and
 * integrity-verifies them, and this module only ever consumes the
 * `ResolvedActionSkillSet` it is handed -- it never looks a Skill up.
 *
 * ```
 * Strategy Analysis  ->  one plan: up to MAX_PLANNED_STRATEGY_SKILLS declared
 *                        domain Skills, each with its own specific question
 *                        (an empty plan is a complete answer)
 *   ->  the planned Skills run in parallel, each once, against the same evidence
 *   ->  synthesize once  ->  the unchanged core diagnosis gate
 * ```
 *
 * Declaring a Skill makes it available, never obligatory: the plan names only
 * the methods the open questions need. No Skill runs twice, and no Skill's
 * question depends on another Skill's output.
 *
 * **What this module never decides.** A domain Skill returns findings,
 * evidence limitations and implications -- never whether the Strategy Work is
 * blocked, never a proposal, never a routing. Proposal and approval stay
 * where they already were: `runCoreDiagnosis`'s existing diagnosis gate
 * (including LOG-976's problem/causation/direction discipline),
 * `handleBlocked`, `developStrategyProposal`, and Martin's Approve/Refine/
 * Reject gate. This module adds context in front of those gates and bypasses
 * none of them.
 *
 * **Governance is unchanged, not relocated.** The module does not fetch its
 * own Hat Definition: the canonical Strategy Analyst governance is still
 * retrieved and enforced by `runCoreDiagnosis`.
 *
 * **Outcomes, deliberately asymmetric.**
 * - No usable plan could be obtained (provider failure, null or malformed
 *   output, more than MAX_PLANNED_STRATEGY_SKILLS entries, a duplicate, an
 *   entry without its own question). The composition layer is NEW work in
 *   front of an already-approved diagnosis pipeline, so an inability to run it
 *   must never silently disable that pipeline: it degrades to the unchanged
 *   core diagnosis, is logged, and is persisted on WorkState.
 * - A plan naming something that is not a Strategy domain Skill, or a Skill
 *   this Action did not declare, is refused at the point of use and holds,
 *   mirroring `ResolvedActionSkillSet.get`'s own rule.
 * - Every planned Skill failed: there is nothing to reconcile, so it holds.
 * - Otherwise synthesis runs once over every finding, failed ones included as
 *   explicitly UNAVAILABLE. It judges whether the evidence supports a
 *   diagnosis -- not whether everything is known -- and holds only when a
 *   specific, obtainable missing fact would change the problem definition or
 *   the direction. Known unknowns go forward as stated uncertainty.
 * Every hold fails closed through the existing `handleBlocked`.
 *
 * **Data boundary.** Every call receives only the already-sanitized
 * `state.strategyContext` -- the same input the existing `strategy.diagnosis`
 * call already consumes under its approved TOKEN_SAFE_RUNTIME policy. No new
 * raw or identity-bearing input is introduced, and no new SemanticTaskId is
 * registered: each step reuses an already-classified Strategy taskId whose
 * payload category is identical.
 */

/**
 * The bounded domain methods a plan may name. `strategy_analysis` is the
 * planning and synthesis methodology and is never itself a domain method.
 *
 * Membership here means "a Strategy domain method exists with this id" -- it
 * does NOT make a Skill available. Availability is the Action's own declared
 * Skill set: a Skill outside `skills.declared` is refused at the point of use.
 */
export type StrategyDomainSkillId = "brand_strategy" | "business_strategy" | "communication_strategy";

export const STRATEGY_DOMAIN_SKILL_IDS: readonly StrategyDomainSkillId[] = ["brand_strategy", "business_strategy", "communication_strategy"];

/**
 * Most domain Skills one plan may name. A plan is one decision made before
 * any Skill runs, so this bounds the whole composition at one planning call,
 * this many Skill calls and one synthesis call.
 */
export const MAX_PLANNED_STRATEGY_SKILLS = 3;

interface DomainProfile {
  /**
   * The already-classified Strategy taskId whose payload category matches this
   * step: sanitized, token-bound situation text, exactly as the existing
   * `strategy.diagnosis` family. Reusing an approved id rather than
   * registering a new SemanticTaskId keeps this change free of any new Data
   * Boundary classification decision.
   */
  taskId: SemanticTaskId;
  /** The domain of judgment this method owns -- echoed into its own prompt and the plan's list of methods. */
  scope: string;
}

const DOMAIN_PROFILES: Record<StrategyDomainSkillId, DomainProfile> = {
  brand_strategy: {
    taskId: "strategy.brand_diagnosis",
    scope: "brand positioning, differentiation, perception, identity, relevance, and brand architecture",
  },
  business_strategy: {
    taskId: "strategy.business_diagnosis",
    scope: "business model, growth model, commercial opportunity, competitive position, business objectives, and material commercial constraints",
  },
  communication_strategy: {
    taskId: "strategy.communication_diagnosis",
    scope: "messaging, narrative, audience communication, and the implications a change has for the communication system as a whole",
  },
};

/**
 * One bounded Skill's returned contribution to the diagnosis: the finding, the
 * evidence limitation attached to it, and what it implies for the question it
 * was asked. Never a proposal, and never a blocked/allowed decision about the
 * Strategy Work.
 */
export interface StrategySkillFinding {
  skillId: StrategyDomainSkillId;
  status: "completed" | "failed";
  /** Only when status is "failed" -- synthesis must know a requested finding is unavailable rather than have another method's assumptions silently stand in for it. */
  failureReason?: string;
  /** What this domain established from the evidence given. */
  finding?: string;
  /** What it could NOT establish -- always carried with the finding, never omitted to make it read stronger. */
  evidenceLimitation?: string;
  /** What the finding implies for the question it was asked. */
  implication?: string;
  /** The specific question this method leaves open, when it leaves one. */
  unresolvedQuestion?: string;
}

/** One planned Skill: which method, and the specific question it must answer. */
export interface StrategySkillPlanEntry {
  skillId: string;
  question: string;
}

/** The reconciled context folded in front of the unchanged core diagnosis. */
export interface StrategySynthesisResult {
  sufficient: boolean;
  insufficiencyReason?: string;
  synthesizedContext?: string;
  agreements?: string;
  disagreements?: string;
  crossDomainRelationships?: string;
  materialUncertainty?: string;
}

export type StrategySkillCycleOutcome =
  /** No usable plan -- degrade to the unchanged core diagnosis (the pre-existing exception). */
  | { status: "unavailable"; reason: string; findings: StrategySkillFinding[]; cause?: AiFailureCause }
  /** The composition's own methodology says stop -- fail closed through handleBlocked. */
  | { status: "hold"; reason: string; findings: StrategySkillFinding[] }
  /** Finished. `synthesizedContext` is present only when at least one Skill ran. */
  | { status: "ok"; findings: StrategySkillFinding[]; synthesizedContext?: string };

export interface StrategySkillCycleParams {
  env: Env;
  strategyQuestion: string;
  strategyContext: string;
  /** The resolved, integrity-verified Skill set this Work's recorded Action declared. This module consumes it and never resolves a Skill itself. */
  skills: ResolvedActionSkillSet;
  /** Progress narration for the in-progress message, if the caller wants one. */
  onProgress?: (message: string) => Promise<void>;
}

function findingsText(findings: StrategySkillFinding[]): string {
  return findings
    .map((f) => {
      if (f.status === "failed") {
        return `[${f.skillId}] UNAVAILABLE -- ${f.failureReason ?? "the method could not produce a defensible finding from the supplied evidence"}.`;
      }
      return [
        `[${f.skillId}]`,
        `Finding: ${f.finding ?? ""}`,
        `Evidence limitation: ${f.evidenceLimitation ?? "(none stated)"}`,
        `Implication: ${f.implication ?? ""}`,
        f.unresolvedQuestion ? `Unresolved question: ${f.unresolvedQuestion}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n\n");
}

/**
 * Maps a failed AI call's cause to the caller-facing hold reason -- the
 * one place Strategy phrases an AI failure for a human. Two distinct
 * messages, deliberately: an Outbound Data Gate refusal is a POLICY
 * judgement about the outgoing payload that a human can act on (reword and
 * re-run), while providers_exhausted/unparseable are infrastructure
 * failures no rewording will fix. Codes only, never payload content.
 */
export function describeAiFailure(cause: AiFailureCause, gateReasons: readonly string[]): string {
  if (cause === "outbound_gate_blocked") {
    const codes = gateReasons.length > 0 ? gateReasons.join(", ") : "reason code not recorded";
    return `The AI call was refused by the Outbound Data Gate (${codes}). The Handoff text probably contains a phrase the gate treats as identity, e.g. a capitalised phrase ending in Group/Ltd/Partners/Holdings. Reword it and re-run.`;
  }
  return `No AI provider returned a usable result (${cause}). This is an infrastructure failure, not an evidence judgement.`;
}

/**
 * Strategy Analysis's one planning decision. Returns `{ plan: null, cause }`
 * only when no usable plan could be obtained -- a failed AI call (its
 * `AiFailureCause` recorded for the caller's log/WorkState), null output,
 * or a plan that is not a list of at most MAX_PLANNED_STRATEGY_SKILLS
 * distinct entries each carrying its own question (recorded as
 * "unparseable"). Whether a named id is a declared Strategy Skill is
 * checked by the caller, at the point of use.
 */
async function planStrategySkills(
  env: Env,
  input: {
    strategyQuestion: string;
    strategyContext: string;
    availableSkills: readonly StrategyDomainSkillId[];
    strategyAnalysisContent: string;
  },
): Promise<{ plan: StrategySkillPlanEntry[] | null; cause?: AiFailureCause }> {
  try {
    const outcome = await generateWithOutcome<{ interpretation?: string; plan?: unknown; rationale?: string }>(env, {
      taskId: "strategy.specialist_selection",
      parts: {
        persona: [
          "You are the Strategy Analyst performing its own Strategic Diagnosis & Prescription responsibility. You are the single accountable actor: no one else performs a step, and no other Hat is ever assumed.",
          "This call plans the diagnosis once, before any method runs. You interpret the evidence, name the specific questions it leaves open, and choose which bounded methods -- if any -- those questions need.",
        ].join("\n\n"),
        skillContent: ["=== METHOD (the Strategy Analysis methodology -- follow it exactly) ===", input.strategyAnalysisContent].join("\n\n"),
        context: [
          "=== RESPONSE FORMAT (execution mechanics) ===",
          "Return JSON exactly matching this shape:",
          "{",
          '  "interpretation": "... what the evidence actually supports",',
          `  "plan": [ { "skillId": "<one of the available ids below>", "question": "... the specific question this method must answer" } ]  (0 to ${MAX_PLANNED_STRATEGY_SKILLS} entries, each id at most once),`,
          '  "rationale": "... why these methods and not the others"',
          "}",
          "",
          "Rules:",
          `- At most ${MAX_PLANNED_STRATEGY_SKILLS} entries, each a different method, each with its own non-empty question. An empty plan means the evidence answers the strategic question without a bounded method.`,
          "- Every planned method runs once, independently and at the same time, against the same evidence. A question may not depend on another method's answer.",
          "- Choose a method because an open question needs that domain of judgment, never because the situation merely touches it, and never every method merely because it is available.",
          "- Anything other than a single well-formed plan is unusable: respond with the exact shape above or not at all.",
        ].join("\n\n"),
        situation: [
          `Strategic question: ${input.strategyQuestion}`,
          "",
          "=== SITUATION (already sanitized; the only evidence you may use) ===",
          input.strategyContext,
          "",
          "=== AVAILABLE METHODS (this Action declared them; any other id is refused) ===",
          input.availableSkills.length > 0
            ? input.availableSkills.map((id) => `- ${id}: ${DOMAIN_PROFILES[id].scope}`).join("\n")
            : "(none declared by this Action -- the plan must be empty)",
        ].join("\n"),
      },
      light: true,
    });

    if (!outcome.ok) {
      // The documented degradation is unchanged (the caller proceeds to
      // core diagnosis with strategySkillCycleUnavailable = true); only
      // the CAUSE is additionally recorded for the log and WorkState.
      console.error(`Strategy Skill plan: planning call failed (${outcome.cause}${outcome.gateReasons.length ? ` [${outcome.gateReasons.join(", ")}]` : ""}) -- the cycle degrades to core diagnosis as documented.`);
      return { plan: null, cause: outcome.cause };
    }
    const result = outcome.json;
    if (!result || typeof result !== "object" || !Array.isArray(result.plan)) return { plan: null, cause: "unparseable" };
    if (result.plan.length > MAX_PLANNED_STRATEGY_SKILLS) return { plan: null, cause: "unparseable" };
    const plan: StrategySkillPlanEntry[] = [];
    for (const raw of result.plan) {
      if (!raw || typeof raw !== "object") return { plan: null, cause: "unparseable" };
      const { skillId, question } = raw as { skillId?: unknown; question?: unknown };
      if (typeof skillId !== "string" || !skillId || typeof question !== "string" || !question.trim()) return { plan: null, cause: "unparseable" };
      if (plan.some((p) => p.skillId === skillId)) return { plan: null, cause: "unparseable" };
      plan.push({ skillId, question: question.trim() });
    }
    return { plan };
  } catch (err) {
    console.error("Strategy Skill plan: planning call threw unexpectedly", err);
    return { plan: null, cause: "providers_exhausted" };
  }
}

/**
 * Runs one declared domain Skill against the situation. Never throws: a
 * provider failure, a null output, or a response that does not reach
 * `sufficient: true` becomes an explicitly failed finding, so synthesis
 * always knows a requested finding is missing instead of having it silently
 * vanish or be backfilled.
 */
async function runDomainSkill(
  env: Env,
  skillId: StrategyDomainSkillId,
  question: string,
  input: { strategyQuestion: string; strategyContext: string; skillContent: string },
): Promise<StrategySkillFinding> {
  const profile = DOMAIN_PROFILES[skillId];
  try {
    const result = await generate<{
      sufficient?: boolean;
      blockedReason?: string;
      finding?: string;
      evidenceLimitation?: string;
      implication?: string;
      unresolvedQuestion?: string;
    }>(env, {
      taskId: profile.taskId,
      mode: "json",
      parts: {
        persona: [
          `You are the Strategy Analyst applying one bounded Strategy Skill: \`${skillId}\`. The Strategy Analyst remains the accountable actor throughout -- you are applying methodology, not assuming a role, and no other Hat exists for this work.`,
          `This method owns one domain of judgment only: ${profile.scope}. Work the specific question below inside that domain and return what it supports, what it does not, and what it implies.`,
        ].join("\n\n"),
        skillContent: ["=== METHOD (follow this methodology exactly) ===", input.skillContent].join("\n\n"),
        context: [
          "=== RESPONSE FORMAT (execution mechanics) ===",
          "Return JSON exactly matching this shape:",
          "{",
          '  "sufficient": true | false,',
          '  "blockedReason": "... (ONLY when sufficient=false: state exactly what is missing or ambiguous -- never a generic request for more background information)",',
          '  "finding": "... (when sufficient=true) what this domain actually establishes from the evidence given",',
          '  "evidenceLimitation": "... (when sufficient=true) what it could NOT establish -- required, never empty if a gap exists",',
          '  "implication": "... (when sufficient=true) what this implies for the question",',
          '  "unresolvedQuestion": "... (optional) the specific question this leaves open"',
          "}",
          "",
          "You do not decide whether the overall Strategy Work is blocked, you do not draft or modify a Strategy Proposal, and you do not route anything.",
        ].join("\n\n"),
        situation: [
          `Strategic question: ${input.strategyQuestion}`,
          "",
          "=== SPECIFIC QUESTION THIS METHOD MUST ANSWER ===",
          question,
          "",
          "=== SITUATION (already sanitized; the only evidence you may use) ===",
          input.strategyContext,
        ].join("\n"),
      },
      light: true,
    });

    if (!result || result.sufficient !== true) {
      return { skillId, status: "failed", failureReason: result?.blockedReason ?? "Could not produce a defensible finding from the supplied evidence." };
    }
    return {
      skillId,
      status: "completed",
      finding: result.finding ?? "",
      evidenceLimitation: result.evidenceLimitation ?? "",
      implication: result.implication ?? "",
      unresolvedQuestion: result.unresolvedQuestion,
    };
  } catch (err) {
    console.error(`Strategy Skill plan: \`${skillId}\` threw unexpectedly`, err);
    return { skillId, status: "failed", failureReason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reconciles the findings once and judges whether they support a diagnosis.
 * Is told about failed findings rather than having them omitted -- a missing
 * finding must never be read as a neutral one.
 *
 * The sufficiency question is the diagnosis, not completeness: whether the
 * evidence supports a defensible problem definition, a cause stated as
 * supported or explicitly unproven, and a direction that does not depend on
 * an unproven cause. Facts that cannot be known at this stage -- unknowns the
 * client has declared, and figures the diagnosis or its proposal is meant to
 * produce (scope, budget, price) -- go forward as material uncertainty, never
 * as insufficiency. (HO-86 was held three times running on exactly such facts,
 * each already recorded as unknown.)
 */
async function synthesizeStrategyFindings(
  env: Env,
  input: { strategyQuestion: string; strategyContext: string; findings: StrategySkillFinding[]; strategyAnalysisContent: string },
): Promise<{
  synthesis: StrategySynthesisResult | null;
  aiFailure?: { cause: AiFailureCause; gateReasons: string[] };
}> {
  try {
    const outcome = await generateWithOutcome<StrategySynthesisResult>(env, {
      taskId: "strategy.specialist_synthesis",
      parts: {
        persona: [
          "You are the Strategy Analyst reconciling the bounded Strategy Skill findings below, before the unchanged Symptom -> Problem -> Cause -> Constraint -> Consequence diagnosis proceeds. You remain the single accountable actor; a Skill never decides anything.",
          "Some findings are marked UNAVAILABLE -- a method that could not produce a defensible finding. Never substitute another method's assumptions for an unavailable one, and never read an unavailable finding as a negative or neutral result. It is simply missing.",
        ].join("\n\n"),
        skillContent: ["=== METHOD (the Strategy Analysis methodology -- follow it exactly) ===", input.strategyAnalysisContent].join("\n\n"),
        context: [
          "=== RESPONSE FORMAT (execution mechanics) ===",
          'Return JSON: {"sufficient": true|false, "insufficiencyReason": "..." (only if sufficient=false), "synthesizedContext": "..." (only if sufficient=true), "agreements": "...", "disagreements": "...", "crossDomainRelationships": "...", "materialUncertainty": "..."}',
          "",
          "Judge sufficiency for the DIAGNOSIS, not for completeness. Set sufficient=true when the situation and findings support a defensible problem definition, a cause stated either as supported or as explicitly unproven, and a direction that does not depend on an unproven cause.",
          "Facts that cannot be known at this stage are NOT insufficiency: unknowns the situation already records as unknown, and figures the diagnosis or its proposal is meant to produce (intervention scope, budget, price). State each of them in materialUncertainty and carry them into synthesizedContext as open items.",
          "Set sufficient=false only when (a) a specific fact that could be obtained is missing and would change the problem definition or the direction -- name that fact and why it changes the decision -- or (b) the findings materially conflict and cannot be reconciled from what is given. Do not set it true merely because some findings exist.",
          "synthesizedContext must be plain prose the diagnosis step can use as additional grounded context -- state what was established, what remains uncertain, and any cross-domain relationships. Never assert a diagnosis or a recommendation yourself: that remains the diagnosis step's own responsibility.",
          "Never restate an evidence gap as a request for generic background information.",
        ].join("\n\n"),
        situation: [
          `Strategic question: ${input.strategyQuestion}`,
          "",
          "=== SITUATION (already sanitized) ===",
          input.strategyContext,
          "",
          "=== STRATEGY SKILL FINDINGS ===",
          findingsText(input.findings),
        ].join("\n"),
      },
      light: true,
      maxTokens: 2000,
    });
    if (!outcome.ok) {
      return { synthesis: null, aiFailure: { cause: outcome.cause, gateReasons: outcome.gateReasons } };
    }
    return { synthesis: outcome.json };
  } catch (err) {
    console.error("Strategy Skill plan: synthesis threw unexpectedly", err);
    return { synthesis: null };
  }
}

/**
 * Plans, runs and synthesizes once, and returns what the caller should do
 * next. Consumes the Skill set it is handed; it resolves no Skill, decides no
 * approval, and never touches the Strategy Proposal.
 */
export async function runStrategySkillCycle(params: StrategySkillCycleParams): Promise<StrategySkillCycleOutcome> {
  const { env, strategyQuestion, strategyContext, skills, onProgress } = params;

  // Fail closed if the Action declared no `strategy_analysis` methodology --
  // planning has no methodology to follow, and substituting improvisation for
  // a Skill the Action required is exactly what the Registry's rule forbids.
  // This throws SkillResolutionError to the caller.
  const strategyAnalysis = skills.get("strategy_analysis");
  const availableSkills = STRATEGY_DOMAIN_SKILL_IDS.filter((id) => skills.declared.includes(id));

  const planOutcome = await planStrategySkills(env, { strategyQuestion, strategyContext, availableSkills, strategyAnalysisContent: strategyAnalysis.content });
  if (planOutcome.plan === null) {
    // Unchanged degradation: proceed to core diagnosis, only the CAUSE is
    // additionally carried for the caller's log and WorkState.
    return { status: "unavailable", reason: "Strategy Analysis could not produce a usable Skill plan -- the planning call returned no usable plan.", findings: [], cause: planOutcome.cause };
  }
  const plan = planOutcome.plan;

  for (const { skillId } of plan) {
    if (!STRATEGY_DOMAIN_SKILL_IDS.includes(skillId as StrategyDomainSkillId)) {
      return { status: "hold", reason: `Strategy Analysis planned "${skillId}", which is not a Strategy domain Skill. Refusing to follow an unknown method.`, findings: [] };
    }
    if (!skills.declared.includes(skillId as SkillId)) {
      // Mirrors ResolvedActionSkillSet.get's own rule at the point of use:
      // execution may only follow the Skills its Action requires.
      return {
        status: "hold",
        reason: `Strategy Analysis planned "${skillId}", which this Action did not declare -- execution may only follow the Skills its Action requires.`,
        findings: [],
      };
    }
  }

  // No bounded method needed: nothing to reconcile, and the core diagnosis
  // already has the full context. A genuine determination, never a degraded one.
  if (plan.length === 0) return { status: "ok", findings: [] };

  await onProgress?.(`Running Strategy Skills (${plan.map((p) => p.skillId).join(", ")})...`);
  // Array order is the plan's order, so the recorded invocation order is
  // deterministic even though the calls run concurrently.
  const findings = await Promise.all(
    plan.map(({ skillId, question }) =>
      runDomainSkill(env, skillId as StrategyDomainSkillId, question, {
        strategyQuestion,
        strategyContext,
        skillContent: skills.get(skillId as SkillId).content,
      }),
    ),
  );

  if (findings.every((f) => f.status === "failed")) {
    return {
      status: "hold",
      reason: `Every Strategy Skill invoked for this diagnosis failed to produce a defensible finding (${findings.map((f) => `${f.skillId}: ${f.failureReason ?? "unavailable"}`).join("; ")}).`,
      findings,
    };
  }

  await onProgress?.("Reconciling Strategy Skill findings...");
  const synthesisOutcome = await synthesizeStrategyFindings(env, { strategyQuestion, strategyContext, findings, strategyAnalysisContent: strategyAnalysis.content });
  if (synthesisOutcome.synthesis === null) {
    if (synthesisOutcome.aiFailure) {
      // A failed synthesis call is phrased by cause (gate refusal vs
      // infrastructure), not the generic reconciliation text.
      return { status: "hold", reason: describeAiFailure(synthesisOutcome.aiFailure.cause, synthesisOutcome.aiFailure.gateReasons), findings };
    }
    return { status: "hold", reason: "Could not reconcile the Strategy Skill findings into the strategic diagnosis.", findings };
  }
  const synthesis = synthesisOutcome.synthesis;
  if (!synthesis.sufficient) {
    return {
      status: "hold",
      reason: synthesis.insufficiencyReason ?? "The Strategy Skill findings are not sufficient to responsibly proceed with the diagnosis.",
      findings,
    };
  }
  return { status: "ok", findings, synthesizedContext: synthesis.synthesizedContext ?? "" };
}
