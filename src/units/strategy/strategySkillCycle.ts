import type { Env } from "../../types";
import { generate } from "../../ai";
import type { SemanticTaskId } from "../../dataBoundary/types";
import type { ResolvedActionSkillSet, SkillId } from "../../platform/skillRegistry";

/**
 * Strategy's composable-Skills diagnostic cycle (ENIG Core Structure v3.0).
 *
 * **What replaced what.** This module supersedes `strategySpecialists.ts`,
 * which selected specialist *domains* and ran them as concurrent specialist
 * **Hat Definitions** fetched live from Notion (LOG-845). That model is gone:
 * Brand/Business/Communication Strategist are no longer Hats, no Hat
 * Definition is fetched here, and nothing in this file can switch Hats. The
 * specialist domains are now **Skills** -- bounded methodology the Strategy
 * Analyst itself follows, one move at a time.
 *
 * **The shape of the cycle.** Strategy remains ONE organizational Hat
 * (Strategy Analyst) performing ONE Responsibility (`own_strategic_diagnosis`).
 * Its `diagnose` Action declares a set of Skills; the Registry resolves and
 * integrity-verifies them, and this module only ever consumes the
 * `ResolvedActionSkillSet` it is handed -- it never looks a Skill up.
 *
 * ```
 * Strategy Analysis  ->  decide the one next methodological move
 *   ->  invoke exactly one declared Strategy Skill  ->  findings
 *   ->  Strategy Analysis again (reads the accumulated findings)
 *   ->  ... repeat, skip, or stop ...
 *   ->  synthesize  ->  the unchanged core diagnosis gate
 * ```
 *
 * The runtime can use one Skill and finish, use several sequentially, skip
 * what is not needed, choose a later Skill from an earlier Skill's findings,
 * and return to Strategy Analysis after every Skill. It never blindly invokes
 * every declared Skill: `strategy_analysis`'s own methodology requires a move
 * to be chosen because the open diagnostic question needs that domain of
 * judgment, never because the method exists.
 *
 * A Skill that already returned UNAVAILABLE in this cycle is not an ordinary
 * still-untried option either. Selection stays Strategy Analysis's own
 * responsibility -- the runtime never picks a different specialist -- but a
 * repeat of a failed Skill must carry a concrete retry justification and ask
 * a question that differs from the failed attempt. Without both, the move is
 * refused rather than spent, and the cycle reconciles any completed findings
 * instead of discarding them (see the failure modes below).
 *
 * **What this module never decides.** A domain Skill returns findings,
 * evidence limitations and implications -- never whether the Strategy Work is
 * blocked, never a proposal, never a routing. Insufficiency, hold, proposal
 * and approval all stay where they already were: `runCoreDiagnosis`'s existing
 * diagnosis gate (including LOG-976's problem/causation/direction discipline),
 * `handleBlocked`, `developStrategyProposal`, and Martin's Approve/Refine/
 * Reject gate. This module adds context in front of those gates and bypasses
 * none of them.
 *
 * **Governance is unchanged, not relocated.** The cycle does not fetch its own
 * Hat Definition: the canonical Strategy Analyst governance is still retrieved
 * and enforced by `runCoreDiagnosis`, exactly as before this module existed.
 * The two new failure modes below are therefore additive context, never a
 * second governance path.
 *
 * **Failure modes, deliberately asymmetric.**
 * - The cycle could not be started or continued because an analysis step
 *   returned no usable decision (provider failure, null/unparseable output).
 *   This is the pre-existing, documented exception: the composition layer is
 *   NEW work sitting in front of an already-approved diagnosis pipeline, so
 *   an inability to run it must never silently disable that pipeline. It
 *   degrades to the unchanged core diagnosis, is logged, and is persisted on
 *   WorkState.
 * - The cycle ran and its own methodology says stop (every invoked Skill
 *   failed; a synthesized judgment is insufficient). This is a hold and fails
 *   closed through the existing `handleBlocked`.
 * - The cycle reached the invocation cap. Nothing further is invoked. If at
 *   least one Skill has completed, the cycle goes to synthesis with the
 *   findings recorded so far (synthesis and the core diagnosis gate still
 *   judge sufficiency); with no completed finding it holds.
 * - A move naming a Skill this Action did not declare is refused at the point
 *   of use, mirroring `ResolvedActionSkillSet.get`'s own rule: execution may
 *   only follow the Skills its Action requires.
 * - A move asking to re-run a Skill that already returned UNAVAILABLE in this
 *   cycle, without the retry justification that repeat requires -- a concrete
 *   `retryRationale`, plus a focus or diagnostic question that differs from
 *   the failed attempt -- is refused, and the cycle invokes nothing further.
 *   If at least one Skill has already completed, the refusal goes to
 *   synthesis with the findings recorded so far (synthesis and the core
 *   diagnosis gate still judge sufficiency); with no completed finding it
 *   holds. The runtime never substitutes a different specialist for the
 *   refused repeat, and never spends another invocation on an unqualified
 *   one.
 *
 * **Data boundary.** Every call receives only the already-sanitized
 * `state.strategyContext` (and, between moves, this module's own bounded
 * findings over it) -- the same input the existing `strategy.diagnosis` call
 * already consumes under its approved TOKEN_SAFE_RUNTIME policy. No new raw or
 * identity-bearing input is introduced, and no new SemanticTaskId is
 * registered: each step reuses an already-classified Strategy taskId whose
 * payload category is identical.
 */

/**
 * The bounded domain methods the cycle may invoke. `strategy_analysis` is the
 * orchestration methodology and is never itself invocable as a domain method.
 *
 * Membership here means "a Strategy domain method exists with this id" -- it
 * does NOT make a Skill available. Availability is the Action's own declared
 * Skill set: a Skill outside `skills.declared` is refused at the point of use.
 */
export type StrategyDomainSkillId = "brand_strategy" | "business_strategy" | "communication_strategy" | "research_signal";

export const STRATEGY_DOMAIN_SKILL_IDS: readonly StrategyDomainSkillId[] = [
  "brand_strategy",
  "business_strategy",
  "communication_strategy",
  "research_signal",
];

/**
 * Hard cap on domain-Skill invocations within one cycle. The analysis step is
 * expected to stop on the evidence; this exists so a model that keeps asking
 * for "one more method" cannot spin a WorkSession forever. Exceeding it is a
 * hold, never a silent truncation.
 */
export const MAX_STRATEGY_SKILL_INVOCATIONS = 6;

/**
 * Minimum substance of the `retryRationale` a move must carry to re-run a
 * Skill that already returned UNAVAILABLE in this cycle. A structural,
 * deterministic floor (not a judgement of the wording): it stops the retry
 * gate from being satisfied by a token such as "retry", while leaving what
 * counts as a good justification to Strategy Analysis -- the runtime never
 * evaluates the merits of a specialist choice, it only requires that the
 * choice be made for a stated, changed reason rather than re-issued.
 */
export const MIN_RETRY_RATIONALE_LENGTH = 20;

interface DomainProfile {
  /**
   * The already-classified Strategy taskId whose payload category matches this
   * step: sanitized, token-bound situation text, exactly as the existing
   * `strategy.diagnosis` family. Reusing an approved id rather than
   * registering a new SemanticTaskId keeps this change free of any new Data
   * Boundary classification decision.
   */
  taskId: SemanticTaskId;
  /** The domain of judgment this method owns -- echoed into its own prompt and nowhere else. */
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
  research_signal: {
    // Already classified with the identical payload category as every other
    // Strategy step above -- sanitized, token-bound situation text.
    taskId: "strategy.diagnosis",
    scope:
      "evidence discipline over one specific piece of supplied evidence -- what it actually supports, what it merely suggests, and where it is silent",
  },
};

/**
 * One bounded Skill's returned contribution to the diagnosis, as Strategy
 * Analysis receives it: the finding, the evidence limitation attached to it,
 * and what it implies for the open diagnostic question. Never a proposal, and
 * never a blocked/allowed decision about the Strategy Work.
 */
export interface StrategySkillFinding {
  skillId: StrategyDomainSkillId;
  status: "completed" | "failed";
  /** Only when status is "failed" -- Strategy Analysis must know a requested finding is unavailable rather than have another method's assumptions silently stand in for it. */
  failureReason?: string;
  /** What this domain established from the evidence given. */
  finding?: string;
  /** What it could NOT establish -- always carried with the finding, never omitted to make it read stronger. */
  evidenceLimitation?: string;
  /** What the finding implies for the diagnostic question under examination. */
  implication?: string;
  /** The specific question this method leaves open, when it leaves one. */
  unresolvedQuestion?: string;
}

/** One Strategy Analysis move. `next` is the whole decision; the rest exists to make it inspectable. */
export interface StrategyAnalysisDecision {
  interpretation?: string;
  diagnosticQuestion?: string;
  next: "invoke" | "synthesize";
  /** Required when next is "invoke": exactly one available domain Skill id. */
  skillId?: string;
  /** The specific question this method should answer -- how a later move depends on earlier findings. */
  focus?: string;
  rationale?: string;
  /**
   * Required by the runtime ONLY when `skillId` names a Skill that already
   * returned a failed finding in this cycle: the concrete reason this retry is
   * worth an invocation now -- the new evidence or the changed question it
   * depends on. Smallest schema addition the repeat rule needs: `rationale`
   * already exists but is the general "why this move", is optional, and
   * carries no signal that a failed Skill is being re-run, while `focus` and
   * `diagnosticQuestion` are the existing fields that must show the question
   * actually changed.
   */
  retryRationale?: string;
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
  /** The cycle could not run -- degrade to the unchanged core diagnosis (the pre-existing exception). */
  | { status: "unavailable"; reason: string; findings: StrategySkillFinding[] }
  /** The cycle ran and its own methodology says stop -- fail closed through handleBlocked. */
  | { status: "hold"; reason: string; findings: StrategySkillFinding[] }
  /** The cycle finished. `synthesizedContext` is present only when at least one Skill produced a finding. */
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
  if (findings.length === 0) return "(none yet -- no Strategy Skill has been invoked)";
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
 * Strategy Analysis's own move. Returns null only when no usable decision could
 * be obtained (provider failure, null output, unparseable or ambiguous
 * `next`/`skillId`) -- the caller decides what null means for this cycle.
 */
async function runStrategyAnalysisStep(
  env: Env,
  input: {
    strategyQuestion: string;
    accumulatedContext: string;
    findings: StrategySkillFinding[];
    availableSkills: readonly StrategyDomainSkillId[];
    strategyAnalysisContent: string;
    round: number;
  },
): Promise<StrategyAnalysisDecision | null> {
  try {
    const result = await generate<{
      interpretation?: string;
      diagnosticQuestion?: string;
      next?: string;
      skillId?: string;
      focus?: string;
      rationale?: string;
      retryRationale?: string;
    }>(env, {
      taskId: "strategy.specialist_selection",
      mode: "json",
      parts: {
        persona: [
          "You are the Strategy Analyst performing its own Strategic Diagnosis & Prescription responsibility. You are the single accountable actor: no one else performs a step, and no other Hat is ever assumed.",
          `This call is one move in a diagnostic cycle (move ${input.round}). You interpret the evidence accumulated so far, name the one question it leaves open, and choose exactly ONE next move.`,
        ].join("\n\n"),
        skillContent: [
          "=== METHOD (the Strategy Analysis methodology -- follow it exactly) ===",
          input.strategyAnalysisContent,
        ].join("\n\n"),
        context: [
          "=== RESPONSE FORMAT (execution mechanics) ===",
          "Return JSON exactly matching this shape:",
          "{",
          '  "interpretation": "... what the evidence accumulated so far actually supports",',
          '  "diagnosticQuestion": "... the one question it leaves open (empty if none)",',
          '  "next": "invoke" | "synthesize",',
          '  "skillId": "brand_strategy" | "business_strategy" | "communication_strategy" | "research_signal"  (REQUIRED when next=\\"invoke\\", and MUST be one of the ids listed as available below; OMIT it entirely when next=\\"synthesize\\") ,',
          '  "focus": "... the specific question this method should answer (required when next=\\"invoke\\")",',
          '  "rationale": "... why this is the one useful next move",',
          '  "retryRationale": "... (REQUIRED ONLY when `skillId` re-invokes a method already marked UNAVAILABLE below: name the specific new evidence or changed question that justifies another invocation -- at least 20 characters. OMIT it for any other move.)"',
          "}",
          "",
          "Rules:",
          '- "invoke" means exactly ONE of the available methods below; never two, never a list, never every available method.',
          '- "synthesize" means no further method is needed and the accumulated findings should be reconciled. With no findings yet, it means the supplied evidence answers the question directly.',
          "- Choose a method because the open question needs that domain of judgment, never because the situation merely touches it.",
          "- A move may depend on any earlier finding -- name that in `focus`.",
          '- A method already marked UNAVAILABLE below is not an ordinary still-untried option: re-invoking it requires BOTH a `retryRationale` naming the new evidence or changed question AND a `focus` (or `diagnosticQuestion`) that differs from the failed attempt. Without both, the runtime refuses the move instead of spending another invocation -- and it never picks a different method for you.',
          '- Anything other than a single well-formed decision is unusable: respond with the exact shape above or not at all.',
        ].join("\n\n"),
        situation: [
          `Strategic question: ${input.strategyQuestion}`,
          "",
          "=== ACCUMULATED SITUATION (already sanitized; the only evidence you may use) ===",
          input.accumulatedContext,
          "",
          "=== FINDINGS FROM STRATEGY SKILLS ALREADY INVOKED ===",
          findingsText(input.findings),
          "",
          `=== AVAILABLE METHODS (this Action declared them; any other id is refused) ===`,
          input.availableSkills.length > 0
            ? input.availableSkills.map((id) => `- ${id}: ${DOMAIN_PROFILES[id].scope}`).join("\n")
            : "(none declared by this Action -- only \"synthesize\" is available)",
          "",
          "=== METHODS ALREADY UNAVAILABLE IN THIS CYCLE (re-invoking one needs a retryRationale AND a changed focus/diagnosticQuestion) ===",
          input.findings.some((f) => f.status === "failed")
            ? [...new Set(input.findings.filter((f) => f.status === "failed").map((f) => f.skillId))]
                .map((id) => `- ${id}`)
                .join("\n")
            : "(none)",
        ].join("\n"),
      },
      light: true,
    });

    if (!result || typeof result !== "object") return null;
    if (result.next !== "invoke" && result.next !== "synthesize") return null;
    if (result.next === "synthesize") {
      return { next: "synthesize", interpretation: result.interpretation, diagnosticQuestion: result.diagnosticQuestion, rationale: result.rationale };
    }
    if (typeof result.skillId !== "string" || !result.skillId) return null;
    return {
      next: "invoke",
      skillId: result.skillId,
      focus: typeof result.focus === "string" ? result.focus : "",
      interpretation: result.interpretation,
      diagnosticQuestion: result.diagnosticQuestion,
      rationale: result.rationale,
      // Carried only to make it assertable by the retry gate below; the gate
      // -- never this parsing step -- decides whether a repeat is qualified.
      retryRationale: typeof result.retryRationale === "string" ? result.retryRationale : undefined,
    };
  } catch (err) {
    console.error(`Strategy Skill cycle: analysis step ${input.round} threw unexpectedly`, err);
    return null;
  }
}

/**
 * Runs one declared domain Skill against the accumulated context. Never
 * throws: a provider failure, a null output, or a response that does not reach
 * `sufficient: true` becomes an explicitly failed finding, so Strategy Analysis
 * always knows a requested finding is missing instead of having it silently
 * vanish or be backfilled.
 */
async function runDomainSkill(
  env: Env,
  skillId: StrategyDomainSkillId,
  focus: string,
  input: { strategyQuestion: string; accumulatedContext: string; findings: StrategySkillFinding[]; skillContent: string },
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
        skillContent: [
          "=== METHOD (follow this methodology exactly) ===",
          input.skillContent,
        ].join("\n\n"),
        context: [
          "=== RESPONSE FORMAT (execution mechanics) ===",
          "Return JSON exactly matching this shape:",
          "{",
          '  "sufficient": true | false,',
          '  "blockedReason": "... (ONLY when sufficient=false: state exactly what is missing or ambiguous -- never a generic request for more background information)",',
          '  "finding": "... (when sufficient=true) what this domain actually establishes from the evidence given",',
          '  "evidenceLimitation": "... (when sufficient=true) what it could NOT establish -- required, never empty if a gap exists",',
          '  "implication": "... (when sufficient=true) what this implies for the diagnostic question",',
          '  "unresolvedQuestion": "... (optional) the specific question this leaves open"',
          "}",
          "",
          "You do not decide whether the overall Strategy Work is blocked, you do not draft or modify a Strategy Proposal, and you do not route anything.",
        ].join("\n\n"),
        situation: [
          `Strategic question: ${input.strategyQuestion}`,
          "",
          "=== SPECIFIC QUESTION THIS METHOD MUST ANSWER ===",
          focus,
          "",
          "=== ACCUMULATED SITUATION (already sanitized; the only evidence you may use) ===",
          input.accumulatedContext,
          "",
          "=== FINDINGS FROM STRATEGY SKILLS ALREADY INVOKED (this move may depend on them) ===",
          findingsText(input.findings),
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
    console.error(`Strategy Skill cycle: \`${skillId}\` threw unexpectedly`, err);
    return { skillId, status: "failed", failureReason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reconciles the accumulated findings. Explicitly judges sufficiency rather
 * than assuming a partial result is complete, and is told about failed
 * findings rather than having them omitted -- a missing finding must never be
 * read as a neutral one.
 */
async function synthesizeStrategyFindings(
  env: Env,
  input: { strategyQuestion: string; findings: StrategySkillFinding[]; strategyAnalysisContent: string },
): Promise<StrategySynthesisResult | null> {
  try {
    const result = await generate<StrategySynthesisResult>(env, {
      taskId: "strategy.specialist_synthesis",
      mode: "json",
      parts: {
        persona: [
          "You are the Strategy Analyst reconciling the bounded Strategy Skill findings below, before the unchanged Symptom -> Problem -> Cause -> Constraint -> Consequence diagnosis proceeds. You remain the single accountable actor; a Skill never decides anything.",
          "Some findings are marked UNAVAILABLE -- a method that could not produce a defensible finding. Never substitute another method's assumptions for an unavailable one, and never read an unavailable finding as a negative or neutral result. It is simply missing.",
        ].join("\n\n"),
        skillContent: [
          "=== METHOD (the Strategy Analysis methodology -- follow it exactly) ===",
          input.strategyAnalysisContent,
        ].join("\n\n"),
        context: [
          "=== RESPONSE FORMAT (execution mechanics) ===",
          'Return JSON: {"sufficient": true|false, "insufficiencyReason": "..." (only if sufficient=false), "synthesizedContext": "..." (only if sufficient=true), "agreements": "...", "disagreements": "...", "crossDomainRelationships": "...", "materialUncertainty": "..."}',
          "",
          "Set sufficient=false when an unavailable finding is material to responsibly proceeding, or when findings materially conflict and cannot be reconciled from what is given. Do not set it true merely because some findings exist.",
          "synthesizedContext must be plain prose the diagnosis step can use as additional grounded context -- state what was established, what remains uncertain, and any cross-domain relationships. Never assert a diagnosis or a recommendation yourself: that remains the diagnosis step's own responsibility.",
          "Where evidence is incomplete, name the specific fact that is missing. Never restate an evidence gap as a request for generic background information.",
        ].join("\n\n"),
        situation: `Strategic question: ${input.strategyQuestion}\n\nStrategy Skill findings:\n${findingsText(input.findings)}`,
      },
      light: true,
      maxTokens: 2000,
    });
    return result ?? null;
  } catch (err) {
    console.error("Strategy Skill cycle: synthesis threw unexpectedly", err);
    return null;
  }
}

/**
 * Runs the whole cycle and returns what the caller should do next. Consumes
 * the Skill set it is handed; it resolves no Skill, decides no approval, and
 * never touches the Strategy Proposal.
 */
export async function runStrategySkillCycle(params: StrategySkillCycleParams): Promise<StrategySkillCycleOutcome> {
  const { env, strategyQuestion, strategyContext, skills, onProgress } = params;

  // Fail closed if the Action declared no `strategy_analysis` methodology --
  // the cycle's first move has no methodology to follow, and substituting
  // improvisation for a Skill the Action required is exactly what the
  // Registry's rule forbids. This throws SkillResolutionError to the caller.
  const strategyAnalysis = skills.get("strategy_analysis");
  const availableSkills = STRATEGY_DOMAIN_SKILL_IDS.filter((id): id is StrategyDomainSkillId => skills.declared.includes(id));

  const findings: StrategySkillFinding[] = [];
  // Per-cycle memory of what a failed attempt actually asked, so a later
  // re-selection of the same Skill can be compared against it deterministically
  // (string equality on the decision's own fields) instead of being judged by
  // the runtime. Entries exist only within this cycle run: each finding's
  // failure is recorded when it is pushed and refreshed on a later failure of
  // the same Skill, so a retry is always measured against the most recent one.
  const priorFailures = new Map<StrategyDomainSkillId, { focus: string; diagnosticQuestion: string }>();
  let accumulated = strategyContext;
  let round = 0;

  // Reconciles the findings recorded so far and judges their sufficiency.
  // Shared by an explicit `synthesize` move and by a refused repeat that
  // already has a completed finding to stand on.
  const synthesize = async (): Promise<StrategySkillCycleOutcome> => {
    await onProgress?.("Reconciling Strategy Skill findings...");
    const synthesis = await synthesizeStrategyFindings(env, { strategyQuestion, findings, strategyAnalysisContent: strategyAnalysis.content });
    if (!synthesis) {
      return { status: "hold", reason: "Could not reconcile the Strategy Skill findings into the strategic diagnosis.", findings };
    }
    if (!synthesis.sufficient) {
      return {
        status: "hold",
        reason: synthesis.insufficiencyReason ?? "The Strategy Skill findings are not sufficient to responsibly proceed with the diagnosis.",
        findings,
      };
    }
    return { status: "ok", findings, synthesizedContext: synthesis.synthesizedContext ?? "" };
  };

  // A refused repeat of a failed Skill, or reaching the invocation cap, stops
  // the cycle from invoking anything further. When at least one Skill already
  // completed, those findings are reconciled rather than discarded --
  // synthesis and the core diagnosis gate still judge whether they suffice.
  // With no completed finding there is nothing to reconcile, so it holds.
  const stopInvoking = async (reason: string): Promise<StrategySkillCycleOutcome> => {
    if (!findings.some((f) => f.status === "completed")) {
      return { status: "hold", reason, findings };
    }
    console.warn(`Strategy Skill cycle: ${reason} Proceeding to synthesis with the ${findings.filter((f) => f.status === "completed").length} completed finding(s).`);
    return synthesize();
  };

  for (;;) {
    round += 1;
    const decision = await runStrategyAnalysisStep(env, {
      strategyQuestion,
      accumulatedContext: accumulated,
      findings,
      availableSkills,
      strategyAnalysisContent: strategyAnalysis.content,
      round,
    });

    if (!decision) {
      return {
        status: "unavailable",
        reason: `Strategy Analysis could not decide the next diagnostic move (move ${round}) -- the analysis call returned no usable decision.`,
        findings,
      };
    }

    if (decision.next === "synthesize") {
      if (findings.length > 0 && findings.every((f) => f.status === "failed")) {
        return {
          status: "hold",
          reason: `Every Strategy Skill invoked for this diagnosis failed to produce a defensible finding (${findings.map((f) => `${f.skillId}: ${f.failureReason ?? "unavailable"}`).join("; ")}).`,
          findings,
        };
      }
      if (findings.length === 0) {
        // No bounded method was needed: nothing to reconcile, and the
        // existing core diagnosis already has the full context. This is a
        // genuine determination, never a degraded one.
        return { status: "ok", findings };
      }

      return synthesize();
    }

    // next === "invoke"
    const skillId = decision.skillId as string;
    if (skillId === "strategy_analysis" || !STRATEGY_DOMAIN_SKILL_IDS.includes(skillId as StrategyDomainSkillId)) {
      return { status: "hold", reason: `Strategy Analysis asked to invoke "${skillId}", which is not a Strategy domain Skill. Refusing to follow an unknown method.`, findings };
    }
    if (!skills.declared.includes(skillId as SkillId)) {
      // Mirrors ResolvedActionSkillSet.get's own rule at the point of use:
      // execution may only follow the Skills this Work's Action declared.
      return {
        status: "hold",
        reason: `Strategy Analysis asked to invoke "${skillId}", which this Action did not declare -- execution may only follow the Skills its Action requires.`,
        findings,
      };
    }
    if (findings.length >= MAX_STRATEGY_SKILL_INVOCATIONS) {
      return stopInvoking(
        `The diagnostic cycle did not converge within ${MAX_STRATEGY_SKILL_INVOCATIONS} Strategy Skill invocations -- refusing to keep invoking methods indefinitely.`,
      );
    }

    // A Skill that already returned UNAVAILABLE in this cycle is not an
    // ordinary still-untried option: a repeat has to earn its invocation.
    // Both checks are deterministic over the decision's own fields -- a
    // minimum-substance retryRationale, and a focus/diagnostic question that
    // differs from what the failed attempt asked -- so the runtime never
    // evaluates the merits of a specialist choice, never picks a different
    // specialist, and never accepts the same retry merely because the id was
    // selected again. Unqualified repeats fail closed WITHOUT spending the
    // invocation. Checked after the cap so a justified retry can never extend
    // a cycle that has already reached the safety limit.
    const priorFailure = priorFailures.get(skillId as StrategyDomainSkillId);
    if (priorFailure) {
      const retryRationale = (decision.retryRationale ?? "").trim();
      if (retryRationale.length < MIN_RETRY_RATIONALE_LENGTH) {
        return stopInvoking(
          `Strategy Analysis asked to invoke "${skillId}" again after that method already failed to return a defensible finding, without the retry justification a repeat requires (a retryRationale of at least ${MIN_RETRY_RATIONALE_LENGTH} characters). Refusing to spend another invocation on an unqualified repeat.`,
        );
      }
      const focus = (decision.focus ?? "").trim();
      const question = (decision.diagnosticQuestion ?? "").trim();
      if (focus === priorFailure.focus && question === priorFailure.diagnosticQuestion) {
        return stopInvoking(
          `Strategy Analysis asked to invoke "${skillId}" again with a retry justification, but the question this repeat would answer is unchanged from the failed attempt. Refusing to spend another invocation on the same retry.`,
        );
      }
    }

    await onProgress?.(`Running Strategy Skill (${skillId})...`);
    const finding = await runDomainSkill(env, skillId as StrategyDomainSkillId, decision.focus ?? "", {
      strategyQuestion,
      accumulatedContext: accumulated,
      findings,
      skillContent: skills.get(skillId as SkillId).content,
    });
    findings.push(finding);
    if (finding.status === "failed") {
      // Remember exactly what this attempt asked, so the next re-selection of
      // this Skill can be measured against it rather than accepted on sight.
      priorFailures.set(skillId as StrategyDomainSkillId, {
        focus: (decision.focus ?? "").trim(),
        diagnosticQuestion: (decision.diagnosticQuestion ?? "").trim(),
      });
    }
    // The accumulated situation gains the bounded contribution this Skill
    // returned, so a later move can be chosen from an earlier finding.
    accumulated = `${accumulated}\n\n=== ${skillId} finding ===\n${finding.status === "failed" ? `UNAVAILABLE -- ${finding.failureReason}` : `${finding.finding}\nEvidence limitation: ${finding.evidenceLimitation}\nImplication: ${finding.implication}`}`;
  }
}
