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
import { assessDimensionCoverage, formatDimensionEvidenceForContext, formatFailedSearchesWarning, formatUncoveredDimensionsWarning, gatherDimensionEvidence } from "./webSearch";
import type { ResearchBlockCode, ResearchExecutionInput, ResearchOutcome, ResearchSynthesis } from "./types";

/**
 * Research runtime executor -- non-organizational execution infrastructure.
 *
 * `executeResearch` is one stateless pipeline:
 *   1. Validate the authorized/safe context          (requireSafeContext)
 *   2. Derive research relevance                     (deriveResearchRelevance)
 *   3. Select applicable protocol(s)                 (selectProtocols)
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
// fetched from Notion during an execution.
const RESEARCH_ROLE_CONTRACT_PAGE_ID = "3ddcb004-e583-8161-96ba-cdec357c5b5b";

// Canonical governance source for the abstracted consultancy category the
// research runtime is authorized to reason from -- see safeContext.ts.
// Established after the first live ENIG market-research test showed the
// runtime had no grounding at all for what kind of consultancy it was
// researching for (see Notion Activity & Decision Log entry LOG-325).
const RESEARCH_SAFE_CONTEXT_PAGE_ID = "3ddcb004-e583-81e5-b30a-db8cba543823";

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

interface ProtocolSelectionResult {
  protocols?: string[];
  ambiguous?: boolean;
  reason?: string;
}

interface RelevanceResult {
  relevance?: string;
}

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
 * Semantic stage between the raw research question and protocol
 * selection: Research Question -> Safe Consultancy Context -> Research
 * Relevance -> Protocol Selection. Establishes what the question means in
 * relation to the authorized category only -- never a strategic,
 * positioning, marketing, sales, finance, creative, or operational
 * decision. Feeding this (rather than the bare question) into protocol
 * selection is what fixes the earlier failure mode where losing business
 * meaning caused selection to default to the wrong protocol.
 */
async function deriveResearchRelevance(env: Env, categorySummary: string, question: string): Promise<string | null> {
  const result = await generate<RelevanceResult>(env, {
    taskId: "research.context_relevance",
    mode: "json",
    parts: {
      persona: `Below is the ONLY authorized description of the consultancy this research concerns -- an abstracted category, not the consultancy's real identity. Never assume, infer, or introduce any specific company name, person name, proprietary detail, or information beyond what's written here.

${categorySummary}

Given a research question, state in 1-3 plain sentences what the question means in relation to this authorized category (business category, service domains, client type, problem domain, geography) -- i.e. reframe it as a research need for this type of consultancy. This stage only establishes what is being asked and why it matters for research purposes -- it must NOT perform strategic diagnosis or make a positioning, marketing, sales, finance, creative, or operational decision or recommendation of any kind.

Return JSON: {"relevance": "<1-3 sentence reframing>"}`,
      situation: question,
    },
    light: true,
  });
  const relevance = result?.relevance?.trim();
  return relevance && relevance.length > 0 ? relevance : null;
}

/**
 * Maps the selection stage's returned protocol names to canonical
 * protocol ids, dropping anything that does not clearly resolve --
 * "couldn't determine" is never guessed into a nearest neighbor. An empty
 * result is what drives the fail-closed AMBIGUOUS_PROTOCOL_SELECTION stop
 * in executeResearch; exported so that deterministic filter is testable
 * without standing up the whole pipeline.
 */
export function resolveSelectedProtocols(names: string[]): ResearchProtocolId[] {
  return names.map((name) => nameToProtocolId(name)).filter((id): id is ResearchProtocolId => id !== null);
}

/**
 * Stage 1: question-driven protocol selection. Selection is based on the
 * actual research question, not keywords, and stops and surfaces
 * ambiguity rather than guessing when the choice materially affects the
 * research. Multiple protocols may be active at once.
 */
async function selectProtocols(
  env: Env,
  categorySummary: string,
  relevance: string,
  question: string,
): Promise<{ protocols: ResearchProtocolId[] } | { stop: ResearchOutcome }> {
  const stage1 = await generate<ProtocolSelectionResult>(env, {
    taskId: "research.protocol_selection",
    mode: "json",
    parts: {
      persona: `You select research protocol(s) for a strategy-led consultancy's research needs. Below is the authorized research category this consultancy operates in -- use ONLY this, never any information about the consultancy beyond what's stated here:

${categorySummary}

This research question has been interpreted, in relation to that authorized category, as:
"${relevance}"

Below are the six available protocols and what each investigates:

${researchProtocolSummaryList()}

Select protocol(s) based on what the question genuinely requires, using the interpretation above for grounding -- never based on keyword matching alone. A broad question about the size, demand, growth, or structure of the market/industry for the consultancy's own authorized service domains and geography should select Market / Industry Research as the PRIMARY protocol -- do not default to Competitive Research for a broad market question; only add Competitive Research when the question specifically concerns named or observable competitors, substitutes, or positioning relative to others. A research question may require one protocol, several protocols, or Evidence & Source Validation alongside another -- do not force a mixed question into a single category merely to simplify selection.

If the question is ambiguous and protocol selection would materially change what research is done, set ambiguous true and explain what's unclear rather than guessing.

Return JSON:
{
  "protocols": ["<exact protocol name from the list above>", ...],
  "ambiguous": true | false,
  "reason": "<brief rationale, or what's ambiguous>"
}`,
      situation: question,
    },
    light: true,
  });

  if (!stage1 || !stage1.protocols) {
    return { stop: blocked("PROTOCOL_SELECTION_FAILED", "Couldn't determine which research protocol(s) this question needs — classification failed.") };
  }

  const selected = resolveSelectedProtocols(stage1.protocols);
  if (stage1.ambiguous || selected.length === 0) {
    return {
      stop: blocked(
        "AMBIGUOUS_PROTOCOL_SELECTION",
        stage1.reason ?? "The research question could plausibly require more than one protocol, or none of the available protocols clearly apply.",
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
  return { protocols: guarded };
}

/**
 * Runs the whole research pipeline for one question and returns the
 * outcome. Nothing is returned as a result before the mandatory evidence
 * & source validation gate passes; a synthesis that fails it is a blocked
 * outcome, never a lower-confidence result.
 */
export async function executeResearch(env: Env, input: ResearchExecutionInput, access: AccessContext): Promise<ResearchOutcome> {
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

  const relevance = await deriveResearchRelevance(env, categorySummary, question);
  if (!relevance) {
    return blocked("RELEVANCE_DERIVATION_FAILED", "Couldn't interpret what this research question means for the authorized consultancy category — classification failed.");
  }

  const selection = await selectProtocols(env, categorySummary, relevance, question);
  if ("stop" in selection) return selection.stop;
  const protocols = selection.protocols;

  await progress(`Using: ${protocols.map((id) => RESEARCH_PROTOCOL_REGISTRY[id].name).join(", ")} -- building a research plan and gathering evidence...`);

  const [researchRoleContract, universalRoleContract] = await Promise.all([
    getGovernance(env, RESEARCH_ROLE_CONTRACT_PAGE_ID, "research role & authority contract"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);
  if (!researchRoleContract || !universalRoleContract) {
    const missing = [!researchRoleContract ? "research role contract" : null, !universalRoleContract ? "Universal Role Contract" : null].filter(Boolean).join(" and ");
    return blocked("GOVERNANCE_UNAVAILABLE", `Couldn't retrieve canonical governance from Notion (${missing}). Refusing to execute without it.`);
  }

  // Protocol-specific research plan: turns each selected protocol into a
  // bounded set of concrete, searchable sub-questions grounded in that
  // protocol's own registered method/evidenceRequirements. Load-bearing --
  // without it there's nothing to search beyond the bare question, so a
  // failure here fails the whole request closed.
  const plan = await generateResearchPlan(env, categorySummary, relevance, question, protocols);
  if (!plan || plan.length === 0) {
    return blocked("PLAN_GENERATION_FAILED", "Couldn't generate a research plan for the selected protocol(s) — planning failed.");
  }

  // Evidence gathering executes the plan -- one search per dimension, not
  // per protocol. Each dimension carries its own search outcome: an
  // unconfigured or failing provider degrades to a FAILED search per
  // dimension (reported as a search limitation), never to silent empty
  // results. Real fetched URLs/snippets become part of the supplied
  // evidence below, so findUnverifiableSources naturally extends to verify
  // against them.
  const dimensionEvidence = await gatherDimensionEvidence(env, plan, access);
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
    taskId: "research.synthesis",
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
    return blocked("SYNTHESIS_FAILED", "The research couldn't be completed — synthesis generation failed.");
  }
  const result: ResearchSynthesis = { ...synthesis, protocolsUsed: protocols };

  // Mandatory evidence & source validation gate. Provenance half: the only
  // facts the model could honestly have are what is in the supplied
  // context (including the search results fetched for it), so a source
  // that doesn't appear there could not have been obtained honestly and is
  // treated as fabricated regardless of how well-formed the rest of the
  // output is (see findUnverifiableSources).
  const gate = applyEvidenceSourceValidationGate(result, effectiveResearchContext);
  if (!gate.valid && gate.failure === "invalid_synthesis") {
    return blocked("SYNTHESIS_INVALID", `The research output didn't meet the evidence bar and was not delivered: ${gate.reason}`);
  }
  if (!gate.valid && gate.failure === "unverifiable_sources") {
    return blocked(
      "UNVERIFIABLE_SOURCES",
      `The research returned source(s) not present in the supplied context (${gate.unverifiableSources.map((s) => s.source).join(", ")}), which would have been fabricated. Not delivered. Only sources actually supplied or fetched can be cited.`,
    );
  }

  return { status: "completed", synthesis: result, relevance };
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
      "Separate Evidence, Finding, Implication, and Limitation explicitly. Every Finding MUST cite at least one Evidence item id it is drawn from — never state a conclusion as a finding without evidence backing it; that is an unsupported inference, not a finding. Every Evidence item MUST cite at least one Source id. Every Finding MUST have its own unique \"id\" (e.g. \"f1\", \"f2\"), and every Implication MUST reference the Finding id(s) it is based on via \"basedOnFindingIds\" — never a positional index, and never a Finding id that isn't actually present in \"findings\". If evidence is insufficient, contradictory, or materially ambiguous, still return your best synthesis but record this explicitly as a Limitation rather than omitting the gap or filling it with unsupported inference. Provide intelligence only: this research makes no downstream strategic, financial, marketing, sales, creative, or operational decision — those remain with the Responsibility that requested it.",
      "=== HARD RULE: EVIDENCE MUST ACTUALLY ANSWER THE RESEARCH DIMENSION IT'S CITED FOR ===",
      "Confirmed live as a real failure: a source about how to conduct competitor analysis (a methodology article) was cited as if it were evidence that a specific market is growing -- it was not; a generic \"businesses should analyze their competitors\" statement is not a Finding or Implication of THIS research, it is filler. A source counts as evidence for a dimension only if its content actually addresses that dimension's specific subject matter (e.g. real market/demand data for a market-size question, a named real organisation's observable offer for a competitor question) -- a company merely appearing in a search result does not by itself establish it is a relevant competitor, and a generic industry statement does not become geography-specific evidence merely because the search query included that geography. Never produce generic business advice (e.g. \"businesses should conduct regular competitor analysis\") as a Finding or Implication -- state only what the gathered evidence actually establishes about the specific situation asked about. If the \"SUPPLIED CONTEXT/EVIDENCE\" section below flags a research dimension with no search evidence, or the evidence you do have is off-topic/generic for that dimension, report it as a Limitation -- never as a Finding.",
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

