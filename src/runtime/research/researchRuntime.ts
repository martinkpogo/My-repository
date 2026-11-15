import type { Env } from "../../types";
import { generate, type GeneratePromptParts } from "../../ai";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import type { AccessContext } from "../../access";
import { applyEvidenceSourceValidationGate } from "../evidence/validation";
import type { ResearchProtocolId } from "./protocols";
import { RESEARCH_PROTOCOL_REGISTRY, nameToProtocolId, researchProtocolDetail, researchProtocolSummaryList } from "./protocols";
import { applyProtocolSelectionGuardrails } from "./protocolGuardrails";
import { generateResearchPlan } from "./researchPlan";
import { extractAuthorizedContextSummary, isValidSafeContext } from "./safeContext";
import {
  assessDimensionCoverage,
  formatDimensionEvidenceForContext,
  formatFailedSearchesWarning,
  formatUncoveredDimensionsWarning,
  readCachedSearch,
  searchDimension,
  type DimensionEvidence,
} from "./webSearch";
import { hashContent } from "../../contentHash";
import { lightSearchSection } from "./lightSearchSkill";
import { resolveRuntimeSkill } from "../actionSkills";
import { DEEP_RESEARCH_LIMITS, runSkillRounds, type EvidenceNote } from "./skillRounds";
import type { ResearchPlanDimension } from "./researchPlan";
import type {
  ResearchBlockCode,
  ResearchCheckpoint,
  ResearchCheckpointStore,
  ResearchExecutionInput,
  ResearchOperationStatus,
  ResearchOutcome,
  ResearchSynthesis,
} from "./types";

/**
 * Research runtime executor -- non-organizational execution infrastructure.
 *
 * `runResearchSkill` is one pipeline, resumable when its caller supplies a
 * checkpoint store (BD-15: the OWNING Work's durable storage -- see
 * ResearchExecutionInput.checkpoints). The checkpoint carries the
 * interpretation, the approved plan and each search's status with a
 * reference to its saved results; a resumed job repeats no completed
 * operation, and an interrupted search stops the job as `interrupted`
 * rather than being synthesized around (until RESEARCH_PAUSE_LIMIT_MS):
 *   1. Validate the authorized/safe context          (requireSafeContext)
 *   2-3. Interpret the question and select protocol(s), in ONE light
 *        AI call                                     (interpretAndSelectProtocols)
 *   4. Apply deterministic selection guardrails      (applyProtocolSelectionGuardrails)
 *   5. Generate the research plan                    (generateResearchPlan)
 *   6. Gather evidence                               (gatherDimensionEvidence -- Access-checked egress)
 *   7. Assess coverage                               (assessDimensionCoverage)
 *   8. Synthesize                                    (research.synthesis)
 *   9. Apply evidence & source validation            (src/runtime/evidence/validation.ts -- mandatory)
 *
 * and returns a ResearchOutcome. It deliberately does NOT own, and so
 * never touches: Work or WorkState, which Unit/Hat/Action invoked it, the
 * Workspace stream or any Telegram message, Handoffs, Activity logging,
 * approvals, or downstream routing. Those belong to whichever owning
 * Action composes this executor through the ordinary runtime path
 * (resolved Action -> declared Skill(s) -> Access -> permitted Data/Tools
 * -> Worker execution -> Result). Authorization for the outbound search is
 * the caller's `access` context, evaluated by Access at the point of
 * egress -- the executor cannot grant itself one.
 *
 * Methodology vs execution: reusable research methodology is a Skill
 * (`research_signal`), resolved by the caller and passed in as
 * `input.skillContent`; protocols (protocols.ts) are data descriptors this
 * executor reads. Neither executes anything.
 *
 * Every stop is a `blocked` outcome with a stable code, never a thrown
 * error or a lower-confidence result delivered anyway.
 */

// Canonical Notion governance source for the research role/authority
// contract the synthesis stage runs under (explicit page ID, not title
// search). This is governance retrieval, NOT protocol retrieval: the six
// protocol definitions are repo-native (protocols.ts) and are never
// fetched from Notion during an execution. Since 2026-11-09 this is
// "Research Runtime -- Role & Authority Contract" (ENIG HQ / 0. Kernel),
// Martin-approved, replacing the deleted R&I Analyst contract: it governs
// the research step an owning Hat's Action runs, not a Unit or Hat.
const RESEARCH_ROLE_CONTRACT_PAGE_ID = "413cb004-e583-817d-bdca-ede843a85033";

// Canonical governance source for the abstracted consultancy category the
// research runtime is authorized to reason from -- see safeContext.ts.
// Established after the first live ENIG market-research test showed the
// runtime had no grounding at all for what kind of consultancy it was
// researching for (see Notion Activity & Decision Log entry LOG-325).
// Since 2026-11-09 this is the Martin-approved replacement page (ENIG HQ /
// Business-Wide Operating Models), an anonymised derivation of the ENIG
// Consultancy Profile; the original was deleted.
const RESEARCH_SAFE_CONTEXT_PAGE_ID = "413cb004-e583-81aa-8dc0-d1e1576022db";

/**
 * Confirmed live: a research question/context that a caller accumulates by
 * appending on every clarification/feedback round had no
 * bound -- and a slow provider response can trigger a Telegram-side
 * webhook retry that reprocesses the same message, appending again. A
 * few rounds of that grew a research question past 28,000 tokens,
 * which every fallback provider then rejected outright (context window)
 * or rate-limited (tokens-per-minute), or simply took too long to
 * process within the per-provider timeout -- turning a slow request
 * into a permanently-stuck one that kept getting slower with each
 * retry. Callers bound every write of these two values through this cap so a
 * bloated stored value also self-heals on the very next write, not
 * just future growth.
 */
export const MAX_RESEARCH_TEXT_LENGTH = 3000;

export function capResearchText(text: string): string {
  return text.length > MAX_RESEARCH_TEXT_LENGTH ? text.slice(-MAX_RESEARCH_TEXT_LENGTH) : text;
}

/**
 * Confirmed live: even after every per-item size fix on the evidence
 * pipeline (snippet length, results-per-query), the synthesis request
 * still landed right at Groq's flat 8000-token ceiling (8247 requested)
 * -- close enough that a single extra protocol or a slightly longer
 * snippet tips it back over. Rather than keep shaving individual caps
 * and hoping their sum stays under budget, this bounds the whole
 * variable-size evidence blob (Martin's/Handoff's own supplied context +
 * gathered web evidence + uncovered-dimension warning) to one fixed
 * budget directly, so total request size no longer depends on how many
 * protocols or dimensions a given request happens to activate. Keeps
 * the head (the request's own supplied context comes first and matters
 * most) and truncates trailing web evidence, which degrades to "less
 * corroborating detail" rather than losing the actual research context.
 */
export const MAX_SUPPLIED_EVIDENCE_LENGTH = 4000;

export function capSuppliedEvidence(text: string): string {
  return text.length > MAX_SUPPLIED_EVIDENCE_LENGTH
    ? `${text.slice(0, MAX_SUPPLIED_EVIDENCE_LENGTH)}\n\n[Additional evidence truncated to keep this request within provider size limits.]`
    : text;
}

interface InterpretationAndSelectionResult {
  relevance?: string;
  protocols?: string[];
  ambiguous?: boolean;
  reason?: string;
}

/**
 * The three AI task ids one research run uses. The data boundary (provider
 * eligibility, payload class, Outbound Data Gate exemptions) is decided per
 * task id, so a profile is exactly a data-boundary choice -- never a caller
 * flag. Two profiles exist, each reachable only through its own export:
 *
 *  - STANDARD (runResearchSkill): research.* -- token-safe. The gate's
 *    company-name detector applies, so a real client name can never reach a
 *    provider. Every Action uses this, Strategy included.
 *  - PUBLIC PROSPECT (runProspectResearchSkill): lead.candidate_research_* --
 *    researching a PUBLIC organisation ENIG has not engaged, found by Lead
 *    Generation's own web search. Exempt from the company-name detector ONLY
 *    (email/phone/person/address detectors still apply), the same narrow
 *    exemption lead.discovery_signal_evaluation has (Martin's decision,
 *    2026-10-12). Only Lead Generation may import it (asserted by test).
 */
interface ResearchTaskProfile {
  selection: "research.protocol_selection" | "lead.candidate_research_protocol_selection";
  plan: "research.plan_generation" | "lead.candidate_research_plan";
  synthesis: "research.synthesis" | "lead.candidate_research_synthesis";
}

const STANDARD_RESEARCH_PROFILE: ResearchTaskProfile = {
  selection: "research.protocol_selection",
  plan: "research.plan_generation",
  synthesis: "research.synthesis",
};

const PUBLIC_PROSPECT_RESEARCH_PROFILE: ResearchTaskProfile = {
  selection: "lead.candidate_research_protocol_selection",
  plan: "lead.candidate_research_plan",
  synthesis: "lead.candidate_research_synthesis",
};

function blocked(code: ResearchBlockCode, reason: string): ResearchOutcome & { status: "blocked" } {
  console.error(`Research execution blocked [${code}]: ${reason}`);
  return { status: "blocked", code, reason };
}

/**
 * Retrieves and structurally validates the canonical Research-Safe
 * Consultancy Context before any research question is interpreted (safe
 * context -> relevance -> protocol selection). Fails closed on missing or
 * malformed context -- a governance/infrastructure failure, never treated
 * as an ambiguous question and never replaced by a generic assumption
 * about what market is being researched. getGovernance's own KV cache
 * keeps repeated calls cheap.
 */
async function requireSafeContext(env: Env): Promise<string | null> {
  const raw = await getGovernance(env, RESEARCH_SAFE_CONTEXT_PAGE_ID, "Research-Safe Consultancy Context");
  return isValidSafeContext(raw) ? raw : null;
}

/**
 * Maps the selection stage's returned protocol names to canonical
 * protocol ids, dropping anything that does not clearly resolve --
 * "couldn't determine" is never guessed into a nearest neighbor. An empty
 * result is what drives the fail-closed AMBIGUOUS_PROTOCOL_SELECTION stop
 * in runResearchSkill; exported so that deterministic filter is testable
 * without standing up the whole pipeline.
 */
export function resolveSelectedProtocols(names: string[]): ResearchProtocolId[] {
  return names.map((name) => nameToProtocolId(name)).filter((id): id is ResearchProtocolId => id !== null);
}

/**
 * Interpretation and protocol selection in ONE light AI call (Martin's
 * decision 2026-11-14, free-tier option D -- it was two calls, the second
 * fed the first's answer). Two parts, both kept from the separate stages:
 *
 *  - Relevance: what the question means in relation to the authorized
 *    category only -- never a strategic, positioning, marketing, sales,
 *    finance, creative or operational decision. Grounding selection in
 *    this (not the bare question) is what fixed the earlier failure where
 *    selection defaulted to the wrong protocol.
 *  - Selection: question-driven, never keyword matching; it stops and
 *    surfaces ambiguity rather than guessing when the choice materially
 *    affects the research. Several protocols may be active at once.
 *
 * The stops are unchanged: no usable interpretation is
 * RELEVANCE_DERIVATION_FAILED, no protocol list is
 * PROTOCOL_SELECTION_FAILED, and an ambiguous or unresolvable choice is
 * AMBIGUOUS_PROTOCOL_SELECTION. Runs under the selection task id, which
 * carries the same data-boundary class as the relevance id it replaces.
 */
async function interpretAndSelectProtocols(
  env: Env,
  categorySummary: string,
  question: string,
  taskId: ResearchTaskProfile["selection"],
): Promise<{ relevance: string; protocols: ResearchProtocolId[] } | { stop: ResearchOutcome }> {
  const result = await generate<InterpretationAndSelectionResult>(env, {
    taskId,
    mode: "json",
    parts: {
      persona: `You interpret a research question and select research protocol(s) for a strategy-led consultancy's research needs. Below is the ONLY authorized description of the consultancy this research concerns -- an abstracted category, not the consultancy's real identity. Never assume, infer, or introduce any specific company name, person name, proprietary detail, or information beyond what's written here:

${categorySummary}

${lightSearchSection("interpretation-relevance")}

Step 2 -- protocol selection, grounded in your Step 1 interpretation. Below are the six available protocols and what each investigates:

${researchProtocolSummaryList()}

${lightSearchSection("interpretation-selection")}

Return JSON:
{
  "relevance": "<1-3 sentence reframing>",
  "protocols": ["<exact protocol name from the list above>", ...],
  "ambiguous": true | false,
  "reason": "<brief rationale, or what's ambiguous>"
}`,
      situation: question,
    },
    light: true,
  });

  const relevance = result?.relevance?.trim();
  if (!result || !relevance) {
    return { stop: blocked("RELEVANCE_DERIVATION_FAILED", "Couldn't interpret what this research question means for the authorized consultancy category — classification failed.") };
  }
  if (!Array.isArray(result.protocols)) {
    return { stop: blocked("PROTOCOL_SELECTION_FAILED", "Couldn't determine which research protocol(s) this question needs — classification failed.") };
  }

  const selected = resolveSelectedProtocols(result.protocols);
  if (result.ambiguous || selected.length === 0) {
    return {
      stop: blocked(
        "AMBIGUOUS_PROTOCOL_SELECTION",
        result.reason ?? "The research question could plausibly require more than one protocol, or none of the available protocols clearly apply.",
      ),
    };
  }

  // Deterministic insurance against the diagnosed failure mode: the AI
  // selection is only corrected once it's non-ambiguous, and only ever
  // additively (see protocolGuardrails.ts) -- never overriding a genuine
  // ambiguity call, never removing a protocol the AI legitimately picked.
  const guarded = applyProtocolSelectionGuardrails(question, selected);
  if (guarded.length !== selected.length || guarded[0] !== selected[0]) {
    console.log(`Research protocol-selection guardrail adjusted selection: [${selected.join(", ")}] -> [${guarded.join(", ")}]`);
  }
  return { relevance, protocols: guarded };
}

/**
 * Runs the whole research pipeline for one question and returns the
 * outcome. Nothing is returned as a result before the mandatory evidence
 * & source validation gate passes; a synthesis that fails it is a blocked
 * outcome, never a lower-confidence result.
 */
export async function runResearchSkill(env: Env, input: ResearchExecutionInput, access: AccessContext): Promise<ResearchOutcome> {
  return runResearch(env, input, access, STANDARD_RESEARCH_PROFILE);
}

/**
 * The same pipeline for researching a PUBLIC prospect organisation by name
 * (Lead Generation only -- see PUBLIC_PROSPECT_RESEARCH_PROFILE). Never use
 * it for anything concerning an engaged client: client identity stays
 * token-only through runResearchSkill.
 */
export async function runProspectResearchSkill(env: Env, input: ResearchExecutionInput, access: AccessContext): Promise<ResearchOutcome> {
  return runResearch(env, input, access, PUBLIC_PROSPECT_RESEARCH_PROFILE);
}

/**
 * Research continuation limits (Martin's decisions, 14 Nov 2026):
 *  - an interrupted job waits for providers at most 24 hours from when it
 *    started; after that it is synthesized from what was gathered, with the
 *    searches that never completed reported as limitations;
 *  - a checkpoint older than 7 days is not resumed (its evidence may be
 *    stale), and the job starts again.
 */
export const RESEARCH_PAUSE_LIMIT_MS = 24 * 60 * 60 * 1000;
export const RESEARCH_CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** research_job_identity: a SHA-256 over the profile, the question and the supplied context -- never the text itself. */
export async function researchJobId(profile: ResearchTaskProfile, question: string, context: string): Promise<string> {
  return hashContent(JSON.stringify({ profile: profile.synthesis, question: question.trim(), context: (context ?? "").trim() }));
}

function freshCheckpoint(jobId: string, question: string, now: string): ResearchCheckpoint {
  return {
    job_id: jobId,
    question,
    created_at: now,
    updated_at: now,
    status: "in_progress",
    operations: [],
    remaining_operations: [],
    synthesis_status: "pending",
    validation_status: "pending",
  };
}

/**
 * The checkpoint to continue, or a fresh one. A completed job is not
 * resumed (the 24-hour research cache already answers a repeat); a
 * checkpoint past RESEARCH_CHECKPOINT_MAX_AGE_MS, unreadable, or for a
 * different job is not resumed either.
 */
async function loadResumableCheckpoint(
  store: ResearchCheckpointStore | undefined,
  jobId: string,
  question: string,
  nowMs: number,
): Promise<{ checkpoint: ResearchCheckpoint; resumed: boolean }> {
  const fresh = { checkpoint: freshCheckpoint(jobId, question, new Date(nowMs).toISOString()), resumed: false };
  if (!store) return fresh;
  let saved: ResearchCheckpoint | undefined;
  try {
    saved = await store.load(jobId);
  } catch (err) {
    console.error("Research checkpoint unreadable -- starting the job afresh", err instanceof Error ? err.message : err);
    return fresh;
  }
  if (!saved || saved.job_id !== jobId || saved.status === "completed") return fresh;
  const age = nowMs - Date.parse(saved.created_at);
  if (!Number.isFinite(age) || age > RESEARCH_CHECKPOINT_MAX_AGE_MS) return fresh;
  return { checkpoint: saved, resumed: true };
}

function statusForSearchOutcome(kind: DimensionEvidence["searchOutcome"]): ResearchOperationStatus {
  if (kind === "success_with_results") return "completed_with_results";
  if (kind === "success_no_results") return "completed_no_results";
  if (kind === "interrupted") return "interrupted";
  return "failed";
}

function isCompletedOperation(status: ResearchOperationStatus): boolean {
  return status === "completed_with_results" || status === "completed_no_results";
}

/**
 * Gathers evidence for the plan, one search per dimension, continuing from
 * the checkpoint: a dimension already completed is NOT searched again
 * (preserve_completed_operations) -- its saved results are read back from
 * the Search Tool's cache by reference, and a completed empty search stays
 * empty. Everything else (pending, interrupted, or failed last time) is
 * searched now. The checkpoint is saved after each completed search.
 */
async function gatherCheckpointedEvidence(
  env: Env,
  plan: ResearchPlanDimension[],
  access: AccessContext,
  checkpoint: ResearchCheckpoint,
  persist: () => Promise<void>,
): Promise<{ evidence: DimensionEvidence[]; retryAt?: string }> {
  let earliestRetry: string | undefined;
  const evidence = await Promise.all(
    plan.map(async (dimension, index): Promise<DimensionEvidence> => {
      const op = checkpoint.operations[index] ?? (checkpoint.operations[index] = { dimension: index, status: "pending" });
      if (op.status === "completed_no_results") return { ...dimension, searchOutcome: "success_no_results", results: [] };
      if (op.status === "completed_with_results" && op.evidence_ref) {
        const saved = await readCachedSearch(env, op.evidence_ref);
        if (saved && saved.kind === "success_with_results") return { ...dimension, searchOutcome: "success_with_results", results: saved.results };
        // The saved results are gone from evidence storage (evicted early):
        // the only way to have evidence is to search again, and the log says so.
        console.error(`Research checkpoint ${checkpoint.job_id.slice(0, 12)}: saved results for dimension ${index} are no longer stored -- searching again`);
      }
      const searched = await searchDimension(env, dimension, access);
      op.status = statusForSearchOutcome(searched.evidence.searchOutcome);
      op.search_outcome = searched.evidence.searchOutcome;
      if (searched.evidenceRef) op.evidence_ref = searched.evidenceRef;
      else delete op.evidence_ref;
      if (searched.retryAt && (!earliestRetry || searched.retryAt < earliestRetry)) earliestRetry = searched.retryAt;
      if (isCompletedOperation(op.status)) await persist();
      return searched.evidence;
    }),
  );
  return { evidence, ...(earliestRetry ? { retryAt: earliestRetry } : {}) };
}

async function runResearch(env: Env, input: ResearchExecutionInput, access: AccessContext, profile: ResearchTaskProfile): Promise<ResearchOutcome> {
  const progress = async (text: string): Promise<void> => {
    try {
      await input.onProgress?.(text);
    } catch (err) {
      // A cosmetic status hook must never fail the research it reports on.
      console.error("Research progress hook failed", err);
    }
  };
  const question = input.question;

  const safeContext = await requireSafeContext(env);
  if (!safeContext) {
    return blocked(
      "SAFE_CONTEXT_UNAVAILABLE",
      "Couldn't retrieve or validate the governed Research-Safe Consultancy Context from Notion. Refusing to interpret or research this question without it -- never substituting a generic assumption about the consultancy's market.",
    );
  }
  const categorySummary = extractAuthorizedContextSummary(safeContext);

  // Durable continuation (BD-15, canonical Search spec research_continuation):
  // the checkpoint holds the interpretation, the approved plan and each
  // search's status with a reference to its saved results. Saved after every
  // successful operation, so a resumed job never repeats completed work.
  const startedMs = Date.now();
  const jobId = await researchJobId(profile, question, input.context);
  const { checkpoint, resumed } = await loadResumableCheckpoint(input.checkpoints, jobId, question, startedMs);
  const persist = async (): Promise<void> => {
    if (!input.checkpoints) return;
    checkpoint.updated_at = new Date().toISOString();
    checkpoint.remaining_operations = checkpoint.operations.filter((o) => !isCompletedOperation(o.status)).map((o) => o.dimension);
    try {
      await input.checkpoints.save(checkpoint);
    } catch (err) {
      // Not a failure of the research itself -- but the job can no longer
      // resume from here, so the log says so.
      console.error(`Research checkpoint ${jobId.slice(0, 12)} not saved`, err instanceof Error ? err.message : err);
    }
  };
  const finish = async (status: ResearchCheckpoint["status"], outcome: ResearchOutcome): Promise<ResearchOutcome> => {
    checkpoint.status = status;
    await persist();
    return outcome;
  };

  let relevance: string;
  let protocols: ResearchProtocolId[];
  if (checkpoint.relevance && checkpoint.protocols?.length) {
    relevance = checkpoint.relevance;
    protocols = checkpoint.protocols;
  } else {
    const selection = await interpretAndSelectProtocols(env, categorySummary, question, profile.selection);
    if ("stop" in selection) return finish("blocked", selection.stop);
    ({ relevance, protocols } = selection);
    checkpoint.relevance = relevance;
    checkpoint.protocols = protocols;
    await persist();
  }

  await progress(`Using: ${protocols.map((id) => RESEARCH_PROTOCOL_REGISTRY[id].name).join(", ")} -- building a research plan and gathering evidence...`);

  const [researchRoleContract, universalRoleContract] = await Promise.all([
    getGovernance(env, RESEARCH_ROLE_CONTRACT_PAGE_ID, "research role & authority contract"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);
  if (!researchRoleContract || !universalRoleContract) {
    const missing = [!researchRoleContract ? "research role contract" : null, !universalRoleContract ? "Universal Role Contract" : null].filter(Boolean).join(" and ");
    return finish("blocked", blocked("GOVERNANCE_UNAVAILABLE", `Couldn't retrieve canonical governance from Notion (${missing}). Refusing to execute without it.`));
  }

  // Protocol-specific research plan: turns each selected protocol into a
  // bounded set of concrete, searchable sub-questions grounded in that
  // protocol's own registered method/evidenceRequirements. Load-bearing --
  // without it there's nothing to search beyond the bare question, so a
  // failure here fails the whole request closed. A resumed job keeps its
  // approved plan, so it searches exactly the same dimensions.
  let plan: ResearchPlanDimension[];
  if (checkpoint.plan?.length) {
    plan = checkpoint.plan;
  } else {
    const generated = await generateResearchPlan(env, categorySummary, relevance, question, protocols, profile.plan);
    if (!generated || generated.length === 0) {
      return finish("blocked", blocked("PLAN_GENERATION_FAILED", "Couldn't generate a research plan for the selected protocol(s) — planning failed."));
    }
    plan = generated;
    checkpoint.plan = plan;
    checkpoint.operations = plan.map((_, dimension) => ({ dimension, status: "pending" }));
    await persist();
  }
  if (resumed) {
    const done = checkpoint.operations.filter((o) => isCompletedOperation(o.status)).length;
    await progress(`Resuming research saved earlier: ${done} of ${plan.length} searches already done.`);
  }

  // Evidence gathering executes the plan -- one search per dimension, not
  // per protocol. Each dimension carries its own search outcome: an
  // unconfigured or failing provider degrades to a FAILED search per
  // dimension (reported as a search limitation), never to silent empty
  // results. Real fetched URLs/snippets become part of the supplied
  // evidence below, so findUnverifiableSources naturally extends to verify
  // against them.
  const gathered = await gatherCheckpointedEvidence(env, plan, access, checkpoint, persist);
  const dimensionEvidence = gathered.evidence;

  // Interrupted searches (every eligible provider busy) are NOT synthesized
  // around: the job stays visibly incomplete and resumable, unless it has
  // already waited RESEARCH_PAUSE_LIMIT_MS -- then what was gathered is
  // synthesized, with the unfinished searches reported as limitations.
  const interruptedOps = checkpoint.operations.filter((o) => o.status === "interrupted");
  const pauseExpired = Date.now() - Date.parse(checkpoint.created_at) > RESEARCH_PAUSE_LIMIT_MS;
  if (interruptedOps.length > 0 && !pauseExpired) {
    checkpoint.current_interrupted_operation = interruptedOps[0].dimension;
    if (gathered.retryAt) checkpoint.retry_at = gathered.retryAt;
    else delete checkpoint.retry_at;
    const completedOperations = checkpoint.operations.filter((o) => isCompletedOperation(o.status)).length;
    return finish("interrupted", {
      status: "interrupted",
      reason: `Web search providers are busy (rate-limited or temporarily unavailable), so ${plan.length - completedOperations} of ${plan.length} planned searches are not done yet. Nothing was concluded from the partial evidence.`,
      ...(gathered.retryAt ? { retryAt: gathered.retryAt } : {}),
      completedOperations,
      totalOperations: plan.length,
    });
  }
  delete checkpoint.current_interrupted_operation;
  delete checkpoint.retry_at;

  const { covered, uncovered, failed } = assessDimensionCoverage(dimensionEvidence);
  const webResultCount = covered.reduce((sum, d) => sum + d.results.length, 0);
  const webEvidence = formatDimensionEvidenceForContext(dimensionEvidence);
  const uncoveredWarning = [formatUncoveredDimensionsWarning(uncovered), formatFailedSearchesWarning(failed)].filter(Boolean).join("\n\n");

  await progress(
    webResultCount > 0
      ? `Gathered ${webResultCount} source(s) across ${covered.length}/${plan.length} research dimension(s) -- synthesizing findings now...`
      : failed.length > 0
        ? `Web search was unavailable or failed for ${failed.length}/${plan.length} research dimension(s) -- synthesizing from what's available now; this is a search limitation, not evidence that no information exists.`
        : "No live search results came back -- synthesizing from what's available now...",
  );

  // Research execution boundary: the research-facing content receives only
  // the minimum safe context required (the Authorized Context category
  // summary -- never the full governed page or the role/authority
  // governance) plus the relevance framing, the question, and whatever was
  // actually supplied (the caller's own context, any live web search
  // results grouped by research dimension, and explicit warnings for
  // dimensions that found no evidence and for dimensions whose search
  // itself failed -- reported distinctly, never conflated).
  const suppliedEvidence = capSuppliedEvidence([input.context, webEvidence, uncoveredWarning].filter(Boolean).join("\n\n"));
  const effectiveResearchContext = buildEffectiveResearchContext(categorySummary, relevance, question, suppliedEvidence);

  const synthesis = await generate<Omit<ResearchSynthesis, "protocolsUsed">>(env, {
    taskId: profile.synthesis,
    mode: "json",
    parts: {
      ...buildSynthesisPromptParts(researchRoleContract, universalRoleContract, protocols, webResultCount > 0, input.skillContent),
      situation: effectiveResearchContext,
    },
    // Raised from 2048 after live failures ("synthesis generation
    // failed") that started once evidence breadth grew to up to 8
    // dimensions x 5 results -- the fuller structured JSON output can need
    // more than 2048 tokens to complete, and a truncated response fails to
    // parse entirely rather than degrading gracefully. Paired with an
    // explicit "cite selectively, don't enumerate everything" instruction
    // so this is a safety margin, not a license to pad the response.
    maxTokens: 4096,
  });
  if (!synthesis) {
    // The gathered evidence stays checkpointed: a retry continues from
    // synthesis instead of searching again.
    checkpoint.synthesis_status = "failed";
    return finish("blocked", blocked("SYNTHESIS_FAILED", "The research couldn't be completed — synthesis generation failed."));
  }
  checkpoint.synthesis_status = "completed";
  const result: ResearchSynthesis = { ...synthesis, protocolsUsed: protocols };

  // Mandatory evidence & source validation gate. Provenance half: the only
  // facts the model could honestly have are what is in the supplied
  // context (including the search results fetched for it), so a source
  // that doesn't appear there could not have been obtained honestly and is
  // treated as fabricated regardless of how well-formed the rest of the
  // output is (see findUnverifiableSources).
  const gate = applyEvidenceSourceValidationGate(result, effectiveResearchContext);
  if (!gate.valid && gate.failure === "invalid_synthesis") {
    checkpoint.synthesis_status = "failed";
    checkpoint.validation_status = "failed";
    return finish("blocked", blocked("SYNTHESIS_INVALID", `The research output didn't meet the evidence bar and was not delivered: ${gate.reason}`));
  }
  if (!gate.valid && gate.failure === "unverifiable_sources") {
    checkpoint.synthesis_status = "failed";
    checkpoint.validation_status = "failed";
    return finish(
      "blocked",
      blocked(
        "UNVERIFIABLE_SOURCES",
        `The research returned source(s) not present in the supplied context (${gate.unverifiableSources.map((s) => s.source).join(", ")}), which would have been fabricated. Not delivered. Only sources actually supplied or fetched can be cited.`,
      ),
    );
  }

  checkpoint.validation_status = "passed";
  return finish("completed", { status: "completed", synthesis: result, relevance });
}

/** BD-16: synthesis reads notes only, about 8,000 characters of them. */
export const DEEP_RESEARCH_NOTES_CHARS = 8000;

/** The notes as the only supplied evidence, each with its exact quote and URL, bounded. */
export function formatNotesAsEvidence(notes: readonly EvidenceNote[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const n of notes) {
    const line = `- ${n.fact} — "${n.quote}" (${n.url}) [source: ${(() => {
      try {
        return new URL(n.url).hostname.replace(/^www\./, "");
      } catch {
        return n.url;
      }
    })()}]`;
    if (used + line.length > DEEP_RESEARCH_NOTES_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `[Deep Research] Evidence notes (each quote checked against the retrieved source):\n${lines.join("\n")}` : "";
}

/**
 * Deep Research on the Research Runtime (BD-16; Research Runtime decision,
 * Martin 15 Nov 2026). Explicitly requested only -- never selected
 * automatically. The Worker follows the `deep_research` Skill through
 * Skill-guided rounds (skillRounds.ts) within DEEP_RESEARCH_LIMITS; this
 * runtime supplies the safe context, the governance, the checkpoints, the
 * synthesis from the verified notes only, and the mandatory evidence and
 * source validation gate. Interrupted rounds return `interrupted` and resume
 * from the owning Work's checkpoint.
 */
export async function runDeepResearchSkill(env: Env, input: ResearchExecutionInput, access: AccessContext): Promise<ResearchOutcome> {
  const safeContext = await requireSafeContext(env);
  if (!safeContext) {
    return blocked("SAFE_CONTEXT_UNAVAILABLE", "Couldn't retrieve or validate the governed Research-Safe Consultancy Context from Notion. Refusing to research without it.");
  }
  const categorySummary = extractAuthorizedContextSummary(safeContext);
  const [researchRoleContract, universalRoleContract] = await Promise.all([
    getGovernance(env, RESEARCH_ROLE_CONTRACT_PAGE_ID, "research role & authority contract"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);
  if (!researchRoleContract || !universalRoleContract) {
    return blocked("GOVERNANCE_UNAVAILABLE", "Couldn't retrieve canonical governance from Notion. Refusing to execute without it.");
  }

  const method = resolveRuntimeSkill("deep_research").content;
  const discipline = input.skillContent ?? resolveRuntimeSkill("research_signal").content;
  const jobId = await hashContent(JSON.stringify({ mode: "deep_research", question: input.question.trim(), context: (input.context ?? "").trim() }));
  const rounds = await runSkillRounds(
    env,
    {
      skillContent: `${method}\n\n=== EVIDENCE DISCIPLINE (research_signal) ===\n${discipline}`,
      question: input.question,
      context: categorySummary,
      limits: DEEP_RESEARCH_LIMITS,
      ...(input.checkpoints ? { checkpoint: { store: input.checkpoints, jobId } } : {}),
    },
    access,
  );
  if (rounds.status === "blocked") return blocked("RESEARCH_STEP_FAILED", `A Deep Research step could not be completed: ${rounds.reason}`);
  if (rounds.status === "interrupted") {
    return { status: "interrupted", reason: rounds.reason, ...(rounds.retryAt ? { retryAt: rounds.retryAt } : {}), completedOperations: rounds.rounds, totalOperations: DEEP_RESEARCH_LIMITS.maxRounds };
  }

  const evidence = formatNotesAsEvidence(rounds.notes);
  const supplied = capSuppliedEvidence([input.context, evidence].filter(Boolean).join("\n\n"));
  const effectiveResearchContext = buildEffectiveResearchContext(categorySummary, "Explicitly requested Deep Research.", input.question, supplied);
  const synthesis = await generate<Omit<ResearchSynthesis, "protocolsUsed">>(env, {
    taskId: STANDARD_RESEARCH_PROFILE.synthesis,
    mode: "json",
    parts: { ...buildSynthesisPromptParts(researchRoleContract, universalRoleContract, [], rounds.notes.length > 0, discipline), situation: effectiveResearchContext },
    maxTokens: 4096,
  });
  if (!synthesis) return blocked("SYNTHESIS_FAILED", "The Deep Research synthesis could not be generated.");
  const result: ResearchSynthesis = { ...synthesis, protocolsUsed: [] };
  const gate = applyEvidenceSourceValidationGate(result, effectiveResearchContext);
  if (!gate.valid && gate.failure === "invalid_synthesis") return blocked("SYNTHESIS_INVALID", `The research output didn't meet the evidence bar and was not delivered: ${gate.reason}`);
  if (!gate.valid && gate.failure === "unverifiable_sources") {
    return blocked("UNVERIFIABLE_SOURCES", `The research cited source(s) not in the verified notes (${gate.unverifiableSources.map((x) => x.source).join(", ")}). Not delivered.`);
  }
  return { status: "completed", synthesis: result, relevance: "Explicitly requested Deep Research." };
}

/**
 * The minimal research-facing context per the "Research execution
 * boundary" contract -- the authorized category summary (never the full
 * safe-context page, which also carries meta/policy sections irrelevant
 * to the research itself), the relevance framing, the actual question,
 * and whatever evidence/context was actually supplied. Deliberately does
 * NOT include the research role/authority contract or Universal Role
 * Contract (those stay system-side governance, unchanged) or any
 * unrelated Handoff record.
 */
export function buildEffectiveResearchContext(categorySummary: string, relevance: string, question: string, supplied: string): string {
  return [
    "=== AUTHORIZED RESEARCH CATEGORY (abstracted -- not the consultancy's real identity) ===",
    categorySummary,
    "=== RESEARCH RELEVANCE (what this question means for this category) ===",
    relevance,
    "=== RESEARCH QUESTION ===",
    question,
    "=== SUPPLIED CONTEXT/EVIDENCE ===",
    supplied || "(none supplied)",
  ].join("\n\n");
}

export function buildSynthesisPromptParts(researchRoleDefinition: string, universalRoleContract: string, protocols: ResearchProtocolId[], hasWebResults: boolean, methodologySkillContent?: string): Pick<GeneratePromptParts, "persona" | "behavior" | "skillContent" | "context"> {
  return {
    persona:
      "You are executing ENIG's research runtime — the selected research protocol(s) below — on behalf of the Responsibility that requested this research, under ENIG's canonical Notion governance. The Universal Role Contract and the research role/authority contract below are authoritative for role, authority limits, and stop conditions — follow them exactly.",
    behavior: ["=== UNIVERSAL ROLE CONTRACT (inherited by every role in ENIG) ===", universalRoleContract, "=== RESEARCH ROLE & AUTHORITY CONTRACT (canonical Notion governance) ===", researchRoleDefinition].join("\n\n"),
    skillContent: [
      ...(methodologySkillContent ? ["=== REUSABLE METHODOLOGY (Skill declared by the invoking Action) ===", methodologySkillContent] : []),
      "=== ACTIVE PROTOCOL(S) FOR THIS REQUEST ===",
      researchProtocolDetail(protocols),
      "=== RESEARCH OUTPUT CONTRACT ===",
      lightSearchSection("synthesis-output-contract"),
      "=== HARD RULE: EVIDENCE MUST ACTUALLY ANSWER THE RESEARCH DIMENSION IT'S CITED FOR ===",
      lightSearchSection("synthesis-evidence-rule"),
      hasWebResults
        ? "=== HARD RULE: YOU ONLY HAVE THE LIVE WEB SEARCH RESULTS SUPPLIED BELOW -- NO OTHER BROWSING ACCESS ==="
        : "=== HARD RULE: YOU HAVE NO LIVE BROWSING, SEARCH, OR INTERNET ACCESS ===",
      hasWebResults
        ? "You do not have your own independent browsing beyond what has already been fetched for you below. The ONLY facts you may treat as real are ones that literally appear in the \"SUPPLIED CONTEXT/EVIDENCE\" section (which includes real web search results, each with an exact title, URL, and snippet) or the research question itself. When citing a source, copy its \"url\" field EXACTLY as given below -- never paraphrase, shorten, or invent a URL. The \"AUTHORIZED RESEARCH CATEGORY\" and \"RESEARCH RELEVANCE\" sections tell you what kind of consultancy and market this concerns -- use them for framing only, never as a source of specific facts to cite. A named company, competitor, statistic, or claim that is NOT grounded in the supplied search results is something you are making up, even if it sounds ordinary. If the fetched results don't contain enough to answer the question, return empty sources/evidence/findings/implications arrays and a Limitation stating plainly that the search results available didn't cover this -- never fill the gap with an invented example."
        : "You cannot visit a website, look anything up, or know what a real company's current site/report/pricing page actually says. The ONLY facts you may treat as real are ones that literally appear in the \"SUPPLIED CONTEXT/EVIDENCE\" section below (or the research question itself, if it already states facts). The \"AUTHORIZED RESEARCH CATEGORY\" and \"RESEARCH RELEVANCE\" sections tell you what kind of consultancy and market this concerns -- use them for framing only, never as a source of specific facts to cite. A named company, competitor, website, report, or statistic that is NOT already written in the supplied context is not something you have researched — it is something you are making up, even if it sounds like a completely ordinary, generic example (\"Company A\", \"a market research report\", \"the vendor's website\" are exactly the kind of plausible-sounding fabrication that must never appear). If the supplied context does not already contain enough real source material to answer the question, you MUST return empty sources/evidence/findings/implications arrays and put a single Limitation stating plainly that no supplied source material was available to research this from. An honest empty result is the correct and expected output for most direct chat questions today — never fill the gap with an invented example.",
    ].join("\n\n"),
    context: [
      "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
      `Return JSON exactly matching this shape:
{
  "sources": [{"id": "s1", "source": "...", "sourceType": "...", "url": "...", "publicationDate": "...", "retrievalDate": "...", "passage": "...", "claimSupported": "...", "limitations": "...", "validationStatus": "validated" | "unvalidated" | "contradicted"}],
  "evidence": [{"id": "e1", "statement": "...", "sourceIds": ["s1"]}],
  "findings": [{"id": "f1", "statement": "...", "evidenceIds": ["e1"]}],
  "implications": [{"statement": "...", "basedOnFindingIds": ["f1"]}],
  "limitations": [{"statement": "...", "relatedTo": "..."}]
}
Every "source" and "url" value you return will be checked against the supplied context text and rejected outright if it doesn't literally appear there — so do not invent one, even a plausible-sounding placeholder.
You may be given many search results across several research dimensions -- do NOT include every single one as a Source. Select and cite only the sources that materially support a real Finding; quietly omit redundant, weak, or unused ones. Keep passage/claimSupported/limitations fields concise (one sentence each). This keeps the response focused and, critically, lets it finish completely rather than being cut off mid-generation -- an incomplete/truncated response fails entirely, so a smaller, complete, well-cited synthesis is always better than an exhaustive one that doesn't finish.`,
    ].join("\n\n"),
  };
}

