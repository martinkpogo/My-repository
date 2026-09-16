import type { Env, Unit, WorkState } from "../../types";
import { createPage, getPage, plainText, richText, select, title, updatePage } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { sendMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import type { ResearchProtocolId } from "./protocols";
import { RESEARCH_PROTOCOL_REGISTRY, nameToProtocolId, researchProtocolDetail, researchProtocolSummaryList } from "./protocols";
import type { ResearchSynthesis } from "./evidence";
import { findUnverifiableSources, validateSynthesis } from "./evidence";
import { extractAuthorizedContextSummary, isValidSafeContext } from "./safeContext";
import { applyProtocolSelectionGuardrails } from "./protocolGuardrails";
import { generateResearchPlan } from "./researchPlan";
import { assessDimensionCoverage, formatDimensionEvidenceForContext, formatUncoveredDimensionsWarning, gatherDimensionEvidence } from "./webSearch";

/**
 * R&I execution mechanics -- one dedicated runtime for the single active
 * Research & Intelligence Analyst Hat, per the Unit's own Notion contract
 * ("one dedicated AI Workspace... a specialization-aware execution
 * environment rather than... a separate runtime, Telegram topic, agent, or
 * workspace for each research specialization"). Research types are
 * protocols (see protocols.ts), selected per request, never separate Hats.
 */

// Canonical Notion governance source for this Hat, matching the pattern
// FINANCE_HAT_DEFINITION_PAGE_ID already established for Value-Based
// Pricing Assessor -- explicit page ID, not title search.
const RESEARCH_HAT_DEFINITION_PAGE_ID = "3ddcb004-e583-8161-96ba-cdec357c5b5b";

// Canonical governance source for the abstracted consultancy category R&I
// is authorized to reason from -- see safeContext.ts. Established after
// the first live ENIG market-research test showed the runtime had no
// grounding at all for what kind of consultancy it was researching for
// (see Notion Activity & Decision Log entry LOG-325).
const RESEARCH_SAFE_CONTEXT_PAGE_ID = "3ddcb004-e583-81e5-b30a-db8cba543823";

interface ProtocolSelectionResult {
  protocols?: string[];
  ambiguous?: boolean;
  reason?: string;
}

interface RelevanceResult {
  relevance?: string;
}

/**
 * Reconstructs the research question and supplied context directly from
 * the Handoff's own canonical Notion record, evaluated through the same
 * closed-context contract Finance uses. Identity is read as the
 * Entity_Token / Matter_Token the creating Unit embedded on the Handoff,
 * never a real Name -- this Hat never resolves those tokens by traversing
 * or discovering unrelated records, per the R&I Unit's own closed-context
 * rule.
 */
export async function resolveResearchHandoffContext(env: Env, handoffId: string): Promise<HandoffContextEvaluationResult> {
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
        requiredCategory: "research question and supplied evidence/context",
      },
      "research.synthesis",
    );
  } catch (err) {
    console.error(`Research Handoff context reconstruction failed for ${handoffId}`, err);
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
 * Retrieves and structurally validates the canonical Research-Safe
 * Consultancy Context before R&I interprets any research question, per
 * the governing Notion contract's required execution order (safe context
 * -> relevance -> protocol selection). Fails closed on missing or
 * malformed context -- this is a governance/infrastructure failure, not
 * something Martin can resolve by clarifying in chat, so it is never
 * treated as an ambiguous question and never falls back to a generic
 * assumption about what market is being researched. Cached on WorkState
 * once resolved so a clarification/feedback loop doesn't re-fetch it on
 * every turn (getGovernance's own KV cache makes this cheap regardless,
 * but the validated text is what stays stable for a given work item).
 */
async function requireSafeContext(env: Env, state: WorkState): Promise<string | null> {
  if (state.researchSafeContext) return state.researchSafeContext;

  const raw = await getGovernance(env, RESEARCH_SAFE_CONTEXT_PAGE_ID, "Research-Safe Consultancy Context");
  if (!isValidSafeContext(raw)) {
    console.error(`R&I: Research-Safe Consultancy Context missing or structurally invalid for work ${state.workId}`);
    await logActivity(env, {
      entry: `R&I research blocked — Research-Safe Consultancy Context unavailable or invalid`,
      type: "Blocker",
      area: "Research & Intelligence",
      decisionRationale:
        "Could not retrieve or structurally validate the canonical Research-Safe Consultancy Context from Notion. Refusing to interpret or research this question without it -- never substituting a generic assumption about the consultancy's market.",
      outcome: "Blocked",
    });
    if (state.handoffId) {
      await updatePage(env, state.handoffId, {
        Status: select("Held"),
        "Open Questions": richText("Research-Safe Consultancy Context unavailable or invalid in Notion -- blocked pending resolution."),
      }).catch((err) => console.error(`R&I: failed to mark Handoff ${state.handoffId} Held`, err));
    }
    await sendMessage(
      env,
      state.chatId,
      `*Research & Intelligence*: couldn't retrieve or validate the governed Research-Safe Consultancy Context from Notion. Not proceeding without it — this isn't something to clarify in chat, the Notion page itself needs checking. Will retry automatically once resolved.`,
      undefined,
      state.threadId,
    );
    state.stage = "research_blocked";
    state.awaiting = undefined;
    return null;
  }

  state.researchSafeContext = raw;
  return raw;
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
  const result = await aiJson<RelevanceResult>(env, {
    taskId: "research.context_relevance",
    system: `Below is the ONLY authorized description of the consultancy this research concerns -- an abstracted category, not the consultancy's real identity. Never assume, infer, or introduce any specific company name, person name, proprietary detail, or information beyond what's written here.

${categorySummary}

Given a research question, state in 1-3 plain sentences what the question means in relation to this authorized category (business category, service domains, client type, problem domain, geography) -- i.e. reframe it as a research need for this type of consultancy. This stage only establishes what is being asked and why it matters for research purposes -- it must NOT perform strategic diagnosis or make a positioning, marketing, sales, finance, creative, or operational decision or recommendation of any kind.

Return JSON: {"relevance": "<1-3 sentence reframing>"}`,
    user: question,
    light: true,
  });
  const relevance = result?.relevance?.trim();
  return relevance && relevance.length > 0 ? relevance : null;
}

export async function handlePickup(env: Env, state: WorkState): Promise<WorkState> {
  const evalResult = await resolveResearchHandoffContext(env, state.handoffId!);
  if (!evalResult.success) {
    console.error(`R&I handlePickup: context evaluation failed for handoff ${state.handoffId}: ${evalResult.insufficientContext.reason}`);
    await logActivity(env, {
      entry: `R&I pickup blocked [Insufficient Context] — ${evalResult.insufficientContext.category}`,
      type: "Blocker",
      area: "Research & Intelligence",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `*R&I couldn't pick up a research request* (Handoff ${state.handoffId}).\n\n${evalResult.insufficientContext.reason}\n\nNot proceeding without required sanitized context — will retry automatically once supplied.`,
      undefined,
      state.threadId,
    );
    return state;
  }

  state.entityName = evalResult.contract.entityToken;
  state.matterName = evalResult.contract.matterToken;
  state.researchQuestion = evalResult.contract.sanitizedContext;
  state.researchContext = evalResult.contract.sanitizedContext;

  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });
  await logActivity(env, {
    entry: `R&I picked up research request: ${state.matterName || state.entityName || state.workId}`,
    type: "Activity",
    area: "Research & Intelligence",
    activity: "Research & Intelligence Analyst picked up the request.",
    outcome: "Active",
  });

  return selectProtocolsAndRun(env, state);
}

/**
 * Entry point for a research question that arrives directly from Martin's
 * own chat (the R&I topic, or DM) rather than through a Handoff -- the
 * Notion contract's "other explicitly authorized R&I work context." No
 * Entity/Matter tokens are involved: this is Martin's own direct request,
 * not client-identity-bearing Handoff data.
 */
export async function handleDirectRequest(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.researchQuestion = text;
  state.researchContext = text;
  await logActivity(env, {
    entry: `R&I research request received directly from chat`,
    type: "Activity",
    area: "Research & Intelligence",
    activity: text.slice(0, 500),
    outcome: "Active",
  });
  return selectProtocolsAndRun(env, state);
}

/**
 * Stage 1: question-driven protocol selection. Per the Unit's Notion
 * contract, selection must be based on the actual research question, not
 * keywords, and must stop and surface ambiguity rather than guess when
 * protocol choice materially affects the research. Multiple protocols may
 * be active at once; the selection is preserved on WorkState (the
 * execution record) per that same contract.
 */
async function selectProtocolsAndRun(env: Env, state: WorkState): Promise<WorkState> {
  const safeContext = await requireSafeContext(env, state);
  if (!safeContext) return state; // already blocked + messaged inside requireSafeContext

  const question = state.researchQuestion ?? "";
  const categorySummary = extractAuthorizedContextSummary(safeContext);

  const relevance = await deriveResearchRelevance(env, categorySummary, question);
  if (!relevance) {
    console.error(`R&I relevance derivation failed for work ${state.workId}`);
    await handleBlockedOrAmbiguous(
      env,
      state,
      "Couldn't interpret what this research question means for the authorized consultancy category — classification failed.",
      "RELEVANCE_DERIVATION_FAILED",
    );
    return state;
  }
  state.researchRelevance = relevance;

  const stage1 = await aiJson<ProtocolSelectionResult>(env, {
    taskId: "research.protocol_selection",
    system: `You select research protocol(s) for a strategy-led consultancy's Research & Intelligence Unit. Below is the authorized research category this consultancy operates in -- use ONLY this, never any information about the consultancy beyond what's stated here:

${categorySummary}

This research question has been interpreted, in relation to that authorized category, as:
"${relevance}"

Below are the six available protocols and what each investigates:

${researchProtocolSummaryList()}

Select protocol(s) based on what the question genuinely requires, using the interpretation above for grounding -- never based on keyword matching alone. A broad question about the size, demand, growth, or structure of the market/industry for the consultancy's own authorized service domains and geography should select Market / Industry Intelligence as the PRIMARY protocol -- do not default to Competitive Intelligence for a broad market question; only add Competitive Intelligence when the question specifically concerns named or observable competitors, substitutes, or positioning relative to others. A research question may require one protocol, several protocols, or Evidence & Source Validation alongside another -- do not force a mixed question into a single category merely to simplify selection.

If the question is ambiguous and protocol selection would materially change what research is done, set ambiguous true and explain what's unclear rather than guessing.

Return JSON:
{
  "protocols": ["<exact protocol name from the list above>", ...],
  "ambiguous": true | false,
  "reason": "<brief rationale, or what's ambiguous>"
}`,
    user: question,
    light: true,
  });

  if (!stage1 || !stage1.protocols) {
    console.error(`R&I Stage 1 protocol selection failed for work ${state.workId}`);
    await handleBlockedOrAmbiguous(env, state, "Couldn't determine which research protocol(s) this question needs — classification failed.", "PROTOCOL_SELECTION_FAILED");
    return state;
  }

  const selected = stage1.protocols
    .map((name) => nameToProtocolId(name))
    .filter((id): id is ResearchProtocolId => id !== null);

  if (stage1.ambiguous || selected.length === 0) {
    const reasonText = stage1.reason ?? "The research question could plausibly require more than one protocol, or none of the available protocols clearly apply.";
    await handleBlockedOrAmbiguous(env, state, reasonText, "AMBIGUOUS_PROTOCOL_SELECTION");
    return state;
  }

  // Deterministic insurance against the diagnosed failure mode: the AI
  // selection is only corrected once it's non-ambiguous, and only ever
  // additively (see protocolGuardrails.ts) -- never overriding a genuine
  // ambiguity call, never removing a protocol the AI legitimately picked.
  const guardedSelected = applyProtocolSelectionGuardrails(question, selected);
  if (guardedSelected.length !== selected.length || guardedSelected[0] !== selected[0]) {
    console.log(`R&I protocol-selection guardrail adjusted selection for work ${state.workId}: [${selected.join(", ")}] -> [${guardedSelected.join(", ")}]`);
  }

  state.selectedResearchProtocols = guardedSelected;
  await logActivity(env, {
    entry: `R&I protocol(s) selected: ${guardedSelected.map((id) => id).join(", ")}`,
    type: "Decision",
    area: "Research & Intelligence",
    decisionRationale: stage1.reason ?? "",
    outcome: "Active",
  });

  return runSynthesis(env, state);
}

async function handleBlockedOrAmbiguous(env: Env, state: WorkState, reasonText: string, reasonCode: string): Promise<void> {
  await logActivity(env, {
    entry: `R&I research blocked [${reasonCode}]`,
    type: "Blocker",
    area: "Research & Intelligence",
    decisionRationale: reasonText,
    outcome: "Blocked",
  });
  if (state.handoffId) {
    await updatePage(env, state.handoffId, {
      Status: select("Held"),
      "Open Questions": richText(reasonText.slice(0, 1900)),
    }).catch((err) => console.error(`R&I: failed to mark Handoff ${state.handoffId} Held`, err));
  }
  await sendMessage(
    env,
    state.chatId,
    `*Research & Intelligence*: ${reasonText}\n\nCan you clarify what's needed?`,
    undefined,
    state.threadId,
  );
  state.stage = "research_ambiguous";
  state.awaiting = "research_clarification";
}

/**
 * Stage 2: executes the selected protocol(s) and synthesizes the result
 * into the Evidence -> Finding -> Implication -> Limitation -> Source
 * structure, validated by validateSynthesis before anything is shown to
 * Martin or written back to a Handoff. A synthesis that fails validation
 * is treated as a failed execution, never a lower-confidence result shown
 * anyway.
 */
async function runSynthesis(env: Env, state: WorkState): Promise<WorkState> {
  const safeContext = await requireSafeContext(env, state);
  if (!safeContext) return state; // already blocked + messaged inside requireSafeContext

  const protocols = state.selectedResearchProtocols ?? [];
  const question = state.researchQuestion ?? "";
  const context = state.researchContext ?? "";
  const relevance = state.researchRelevance ?? "";
  const categorySummary = extractAuthorizedContextSummary(safeContext);

  const [hatDefinition, universalRoleContract] = await Promise.all([
    getGovernance(env, RESEARCH_HAT_DEFINITION_PAGE_ID, "Research & Intelligence Analyst Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);

  if (!hatDefinition || !universalRoleContract) {
    const missing = [!hatDefinition ? "R&I Hat Definition" : null, !universalRoleContract ? "Universal Role Contract" : null].filter(Boolean).join(" and ");
    console.error(`R&I runSynthesis: governance retrieval failed (${missing}) for work ${state.workId}`);
    await logActivity(env, {
      entry: `R&I synthesis blocked — governance retrieval failed`,
      type: "Blocker",
      area: "Research & Intelligence",
      decisionRationale: `Could not retrieve canonical governance from Notion (${missing}). Refusing to execute without it.`,
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `Couldn't run this research — couldn't retrieve canonical governance from Notion (${missing}). Please try again once resolved.`,
      undefined,
      state.threadId,
    );
    return state;
  }

  // Protocol-specific research plan: turns each selected protocol into a
  // bounded set of concrete, searchable sub-questions grounded in that
  // protocol's own registered method/evidenceRequirements -- the layer
  // that was missing entirely before (a protocol used to collapse to one
  // generic search suffix with no real operational consequence). This
  // stage is load-bearing -- without it there's nothing to search beyond
  // the bare question, so a failure here fails the whole request closed.
  const plan = await generateResearchPlan(env, categorySummary, relevance, question, protocols);
  if (!plan || plan.length === 0) {
    console.error(`R&I research plan generation failed for work ${state.workId}`);
    await handleSynthesisFailure(env, state, "Couldn't generate a research plan for the selected protocol(s) — planning failed.");
    return state;
  }

  // Evidence gathering executes the plan -- one search per dimension, not
  // per protocol -- and degrades to empty results per dimension when no
  // search provider is configured, exactly like the old behavior. Real
  // fetched URLs/snippets become part of the supplied evidence below, so
  // findUnverifiableSources naturally extends to verify against them.
  const dimensionEvidence = await gatherDimensionEvidence(env, plan);
  const { covered, uncovered } = assessDimensionCoverage(dimensionEvidence);
  const webResultCount = covered.reduce((sum, d) => sum + d.results.length, 0);
  const webEvidence = formatDimensionEvidenceForContext(dimensionEvidence);
  const uncoveredWarning = formatUncoveredDimensionsWarning(uncovered);

  if (webResultCount > 0) {
    await logActivity(env, {
      entry: `R&I gathered ${webResultCount} live web search result(s) across ${covered.length}/${plan.length} research dimension(s)`,
      type: "Activity",
      area: "Research & Intelligence",
      activity: plan.map((d) => d.subQuestion).join(" | "),
      outcome: "Active",
    });
  }

  // Per the "Research execution boundary" contract: the research-facing
  // content receives only the minimum safe context required (the
  // Authorized Context category summary, never the full governed page or
  // the entire Hat/Universal Role Contract governance) plus the
  // relevance framing, the question, and whatever was actually supplied
  // (Martin's/Handoff's own context, any live web search results grouped
  // by research dimension, and an explicit warning for dimensions that
  // returned no evidence at all).
  const suppliedEvidence = [context, webEvidence, uncoveredWarning].filter(Boolean).join("\n\n");
  const effectiveResearchContext = buildEffectiveResearchContext(categorySummary, relevance, question, suppliedEvidence);

  const synthesis = await aiJson<ResearchSynthesis>(env, {
    taskId: "research.synthesis",
    system: buildSynthesisSystemPrompt(hatDefinition, universalRoleContract, protocols, webResultCount > 0),
    user: effectiveResearchContext,
    // Raised from 2048 after live failures ("synthesis generation
    // failed") that started once evidence breadth grew to up to 8
    // dimensions x 5 results -- the fuller structured JSON output
    // (sources/evidence/findings/implications, one per dimension) can
    // need more than 2048 tokens to complete, and a truncated response
    // fails to parse entirely rather than degrading gracefully. Paired
    // with an explicit "cite selectively, don't enumerate everything"
    // instruction above so this is a safety margin, not a license to
    // pad the response.
    maxTokens: 4096,
  });

  if (!synthesis) {
    await handleSynthesisFailure(env, state, "The research couldn't be completed — synthesis generation failed.");
    return state;
  }

  synthesis.protocolsUsed = protocols;
  const validation = validateSynthesis(synthesis);
  if (!validation.valid) {
    console.error(`R&I synthesis failed validation for work ${state.workId}: ${validation.reason}`);
    await handleSynthesisFailure(env, state, `The research output didn't meet the evidence bar and was not delivered: ${validation.reason}`);
    return state;
  }

  // This Hat has no live browsing/search tool -- the only facts it could
  // honestly have are whatever was in `context` above. A source that
  // doesn't appear there could not have been obtained honestly, so it's
  // treated as fabricated regardless of how well-formed the rest of the
  // output is (see findUnverifiableSources for why this exists).
  const unverifiable = findUnverifiableSources(synthesis, effectiveResearchContext);
  if (unverifiable.length > 0) {
    console.error(`R&I synthesis cited unverifiable source(s) for work ${state.workId}: ${unverifiable.map((s) => s.source).join(", ")}`);
    await handleSynthesisFailure(
      env,
      state,
      `This Hat has no live browsing/search access, so it can only cite sources actually supplied to it — it returned source(s) not present in the supplied context (${unverifiable.map((s) => s.source).join(", ")}), which would have been fabricated. Not delivered. If you have real source material, paste it in and I'll work from that.`,
    );
    return state;
  }

  return deliverSynthesis(env, state, synthesis);
}

async function handleSynthesisFailure(env: Env, state: WorkState, reasonText: string): Promise<void> {
  await logActivity(env, {
    entry: `R&I synthesis blocked`,
    type: "Blocker",
    area: "Research & Intelligence",
    decisionRationale: reasonText,
    outcome: "Blocked",
  });
  if (state.handoffId) {
    await updatePage(env, state.handoffId, {
      Status: select("Held"),
      "Open Questions": richText(reasonText.slice(0, 1900)),
    }).catch((err) => console.error(`R&I: failed to mark Handoff ${state.handoffId} Held`, err));
  }
  await sendMessage(
    env,
    state.chatId,
    `*Research & Intelligence*: ${reasonText}\n\nTell me more about what's needed and I'll try again.`,
    undefined,
    state.threadId,
  );
  state.stage = "research_synthesis_failed";
  state.awaiting = "research_feedback";
}

/**
 * The minimal research-facing context per the "Research execution
 * boundary" contract -- the authorized category summary (never the full
 * safe-context page, which also carries meta/policy sections irrelevant
 * to the research itself), the relevance framing, the actual question,
 * and whatever evidence/context was actually supplied. Deliberately does
 * NOT include the Hat Definition or Universal Role Contract (those stay
 * system-side governance, unchanged) or any unrelated Handoff record.
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

export function buildSynthesisSystemPrompt(hatDefinition: string, universalRoleContract: string, protocols: ResearchProtocolId[], hasWebResults: boolean): string {
  return [
    "You are executing the Research & Intelligence Analyst Hat, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for role, authority limits, and stop conditions — follow them exactly.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== ACTIVE PROTOCOL(S) FOR THIS REQUEST ===",
    researchProtocolDetail(protocols),
    "=== RESEARCH OUTPUT CONTRACT ===",
    "Separate Evidence, Finding, Implication, and Limitation explicitly. Every Finding MUST cite at least one Evidence item id it is drawn from — never state a conclusion as a finding without evidence backing it; that is an unsupported inference, not a finding. Every Evidence item MUST cite at least one Source id. Every Implication MUST reference the Finding index/indexes it is based on. If evidence is insufficient, contradictory, or materially ambiguous, still return your best synthesis but record this explicitly as a Limitation rather than omitting the gap or filling it with unsupported inference. This Hat does not make downstream strategic, financial, marketing, sales, creative, or operational decisions — provide intelligence only.",
    "=== HARD RULE: EVIDENCE MUST ACTUALLY ANSWER THE RESEARCH DIMENSION IT'S CITED FOR ===",
    "Confirmed live as a real failure: a source about how to conduct competitor analysis (a methodology article) was cited as if it were evidence that a specific market is growing -- it was not; a generic \"businesses should analyze their competitors\" statement is not a Finding or Implication of THIS research, it is filler. A source counts as evidence for a dimension only if its content actually addresses that dimension's specific subject matter (e.g. real market/demand data for a market-size question, a named real organisation's observable offer for a competitor question) -- a company merely appearing in a search result does not by itself establish it is a relevant competitor, and a generic industry statement does not become geography-specific evidence merely because the search query included that geography. Never produce generic business advice (e.g. \"businesses should conduct regular competitor analysis\") as a Finding or Implication -- state only what the gathered evidence actually establishes about the specific situation asked about. If the \"SUPPLIED CONTEXT/EVIDENCE\" section below flags a research dimension with no search evidence, or the evidence you do have is off-topic/generic for that dimension, report it as a Limitation -- never as a Finding.",
    hasWebResults
      ? "=== HARD RULE: YOU ONLY HAVE THE LIVE WEB SEARCH RESULTS SUPPLIED BELOW -- NO OTHER BROWSING ACCESS ==="
      : "=== HARD RULE: YOU HAVE NO LIVE BROWSING, SEARCH, OR INTERNET ACCESS ===",
    hasWebResults
      ? "You do not have your own independent browsing beyond what has already been fetched for you below. The ONLY facts you may treat as real are ones that literally appear in the \"SUPPLIED CONTEXT/EVIDENCE\" section (which includes real web search results, each with an exact title, URL, and snippet) or the research question itself. When citing a source, copy its \"url\" field EXACTLY as given below -- never paraphrase, shorten, or invent a URL. The \"AUTHORIZED RESEARCH CATEGORY\" and \"RESEARCH RELEVANCE\" sections tell you what kind of consultancy and market this concerns -- use them for framing only, never as a source of specific facts to cite. A named company, competitor, statistic, or claim that is NOT grounded in the supplied search results is something you are making up, even if it sounds ordinary. If the fetched results don't contain enough to answer the question, return empty sources/evidence/findings/implications arrays and a Limitation stating plainly that the search results available didn't cover this -- never fill the gap with an invented example."
      : "You cannot visit a website, look anything up, or know what a real company's current site/report/pricing page actually says. The ONLY facts you may treat as real are ones that literally appear in the \"SUPPLIED CONTEXT/EVIDENCE\" section below (or the research question itself, if it already states facts). The \"AUTHORIZED RESEARCH CATEGORY\" and \"RESEARCH RELEVANCE\" sections tell you what kind of consultancy and market this concerns -- use them for framing only, never as a source of specific facts to cite. A named company, competitor, website, report, or statistic that is NOT already written in the supplied context is not something you have researched — it is something you are making up, even if it sounds like a completely ordinary, generic example (\"Company A\", \"a market research report\", \"the vendor's website\" are exactly the kind of plausible-sounding fabrication that must never appear). If the supplied context does not already contain enough real source material to answer the question, you MUST return empty sources/evidence/findings/implications arrays and put a single Limitation stating plainly that no supplied source material was available to research this from. An honest empty result is the correct and expected output for most direct chat questions today — never fill the gap with an invented example.",
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    `Return JSON exactly matching this shape:
{
  "sources": [{"id": "s1", "source": "...", "sourceType": "...", "url": "...", "publicationDate": "...", "retrievalDate": "...", "passage": "...", "claimSupported": "...", "limitations": "...", "validationStatus": "validated" | "unvalidated" | "contradicted"}],
  "evidence": [{"id": "e1", "statement": "...", "sourceIds": ["s1"]}],
  "findings": [{"statement": "...", "evidenceIds": ["e1"]}],
  "implications": [{"statement": "...", "basedOnFindingIndexes": [0]}],
  "limitations": [{"statement": "...", "relatedTo": "..."}]
}
Every "source" and "url" value you return will be checked against the supplied context text and rejected outright if it doesn't literally appear there — so do not invent one, even a plausible-sounding placeholder.
You may be given many search results across several research dimensions -- do NOT include every single one as a Source. Select and cite only the sources that materially support a real Finding; quietly omit redundant, weak, or unused ones. Keep passage/claimSupported/limitations fields concise (one sentence each). This keeps the response focused and, critically, lets it finish completely rather than being cut off mid-generation -- an incomplete/truncated response fails entirely, so a smaller, complete, well-cited synthesis is always better than an exhaustive one that doesn't finish.`,
  ].join("\n\n");
}

function formatSynthesisForTelegram(synthesis: ResearchSynthesis): string {
  const lines: string[] = [];
  lines.push(`*Protocol(s) used*: ${synthesis.protocolsUsed.map((id) => RESEARCH_PROTOCOL_REGISTRY[id].name).join(", ")}`);
  if (synthesis.findings.length > 0) {
    lines.push(`\n*Findings*:\n${synthesis.findings.map((f) => `• ${f.statement}`).join("\n")}`);
  }
  if (synthesis.implications.length > 0) {
    lines.push(`\n*Implications*:\n${synthesis.implications.map((i) => `• ${i.statement}`).join("\n")}`);
  }
  if (synthesis.limitations.length > 0) {
    lines.push(`\n*Limitations*:\n${synthesis.limitations.map((l) => `• ${l.statement}`).join("\n")}`);
  }
  if (synthesis.sources.length > 0) {
    lines.push(`\n*Sources*:\n${synthesis.sources.map((s) => `• ${s.source}${s.url ? ` (${s.url})` : ""}`).join("\n")}`);
  }
  return lines.join("\n").slice(0, 3900);
}

/**
 * Delivers the validated synthesis. No approval gate — intelligence is
 * informational, not an action requiring Martin's authorization, per the
 * Unit's own contract ("R&I does not make downstream decisions"). Closes
 * the Handoff (if one exists) as the completion signal, and leaves the
 * work item open for a free-text follow-up rather than a button — Martin
 * can simply reply to dig further, handled by handleResearchFeedback.
 */
async function deliverSynthesis(env: Env, state: WorkState, synthesis: ResearchSynthesis): Promise<WorkState> {
  if (state.handoffId) {
    await updatePage(env, state.handoffId, {
      Status: select("Closed"),
      "Work Completed": richText(JSON.stringify(synthesis).slice(0, 1900)),
    });
  }
  await logActivity(env, {
    entry: `R&I research completed: ${state.matterName || state.entityName || state.workId}`,
    type: "Decision",
    area: "Research & Intelligence",
    decisions: synthesis.findings.map((f) => f.statement).join("; ").slice(0, 500),
    decisionRationale: `Protocol(s): ${synthesis.protocolsUsed.join(", ")}`,
    outcome: "Complete",
  });
  await sendMessage(env, state.chatId, formatSynthesisForTelegram(synthesis), undefined, state.threadId);

  await routeToConsumingHat(env, state, synthesis);

  state.stage = "delivered";
  state.awaiting = "research_feedback";
  return state;
}

/**
 * Auto-hands-off research to whichever Hat actually needs it as direct
 * input to its own work, rather than only reporting it back to Martin --
 * per Martin's own instruction: "research has to find and feed the
 * strategist hat that needs it." Marketing Strategist is currently the
 * only Hat this can target (it already exists and owns marketing
 * direction/positioning/brand/channel decisions -- Strategy remains a
 * zero-Hat Unit). Adding a further target later means adding one entry
 * to HANDOFF_ROUTES and extending the classifier's own instructions, not
 * restructuring this mechanism.
 */
const HANDOFF_ROUTES: Partial<Record<string, { unit: Unit; hat: string }>> = {
  marketing: { unit: "Marketing", hat: "Marketing Strategist" },
};

interface HandoffRoutingResult {
  target?: string;
  reason?: string;
}

async function classifyHandoffTarget(env: Env, relevance: string, synthesis: ResearchSynthesis): Promise<HandoffRoutingResult> {
  const findingsSummary = synthesis.findings.map((f) => f.statement).join("; ");
  const result = await aiJson<HandoffRoutingResult>(env, {
    taskId: "research.handoff_routing",
    system: `You decide whether completed research should be automatically handed off to another team's Hat as direct input to that Hat's own work, or simply reported back with no further routing.

Research relevance: ${relevance}
Key findings: ${findingsSummary || "(none)"}

The only Hat currently able to receive research automatically is Marketing Strategist, which owns marketing direction, positioning, brand, and channel strategy decisions. Return "marketing" ONLY if this research is genuinely direct input to a marketing-direction decision (e.g. market sizing/demand, competitor positioning, audience/customer insight relevant to marketing strategy). Return "none" for research that isn't marketing-relevant, or that's too general/exploratory to hand off to a specific Hat's decision yet.

Return JSON: {"target": "marketing" | "none", "reason": "..."}`,
    user: relevance,
    light: true,
  });
  return result ?? { target: "none" };
}

/** Plain-text serialization of a synthesis for a Handoff record -- structure preserved, no Telegram markdown. */
export function formatSynthesisForHandoff(synthesis: ResearchSynthesis): string {
  const lines: string[] = [];
  if (synthesis.findings.length > 0) lines.push(`Findings:\n${synthesis.findings.map((f) => `- ${f.statement}`).join("\n")}`);
  if (synthesis.implications.length > 0) lines.push(`Implications:\n${synthesis.implications.map((i) => `- ${i.statement}`).join("\n")}`);
  if (synthesis.limitations.length > 0) lines.push(`Limitations:\n${synthesis.limitations.map((l) => `- ${l.statement}`).join("\n")}`);
  if (synthesis.sources.length > 0) lines.push(`Sources:\n${synthesis.sources.map((s) => `- ${s.source}${s.url ? ` (${s.url})` : ""}`).join("\n")}`);
  return lines.join("\n\n");
}

async function routeToConsumingHat(env: Env, state: WorkState, synthesis: ResearchSynthesis): Promise<void> {
  const routing = await classifyHandoffTarget(env, state.researchRelevance ?? "", synthesis);
  const route = routing.target ? HANDOFF_ROUTES[routing.target] : undefined;
  if (!route) return;

  try {
    const handoff = await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, {
      Handoff: title(`R&I research for ${route.hat}: ${(state.researchQuestion ?? state.workId).slice(0, 60)}`),
      "From Unit": select("Research & Intelligence"),
      "From Hat": richText("Research & Intelligence Analyst"),
      "To Unit": select(route.unit),
      "To Hat": richText(route.hat),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText((routing.reason ?? `Research completed and judged directly relevant to ${route.hat}'s work.`).slice(0, 1900)),
      "Expected Output": richText(`${route.hat} to use this research as direct input to its own work.`),
      "Verified Facts & Sources": richText(formatSynthesisForHandoff(synthesis).slice(0, 1900)),
    });
    await logActivity(env, {
      entry: `R&I research handed off to ${route.hat}`,
      type: "Activity",
      area: "Research & Intelligence",
      activity: `Handoff ${handoff.id} created for ${route.unit}/${route.hat}.`,
      nextActions: `${route.hat} to pick up and act on this research.`,
      outcome: "Complete",
    });
    await sendMessage(env, state.chatId, `This research has also been handed off to *${route.hat}* to inform their work.`, undefined, state.threadId);
  } catch (err) {
    // Not fatal to delivering the research itself -- Martin already has
    // the findings; a failed handoff just means it wasn't auto-routed.
    console.error(`R&I: failed to create handoff to ${route.unit}/${route.hat} for work ${state.workId}`, err);
  }
}

/** Ambiguity loop: re-runs protocol selection with the added detail. */
export async function handleResearchClarification(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.researchQuestion = `${state.researchQuestion ?? ""}\n\nAdditional detail: ${text}`;
  state.researchContext = `${state.researchContext ?? ""}\n\nAdditional detail: ${text}`;
  return selectProtocolsAndRun(env, state);
}

/**
 * Free-text follow-up loop, used both after a delivered synthesis (dig
 * further / refine) and after a failed synthesis (redo with more
 * direction) -- no Approve/Redo buttons, per the "R&I provides
 * intelligence, it doesn't gate on approval" design.
 * If a follow-up materially changes the research question, scope, or
 * research need, it re-enters question/scope validation and protocol selection.
 * Minor refinements or clarifications within existing scope continue with the
 * currently selected protocols.
 */
export async function handleResearchFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  if (!state.selectedResearchProtocols || state.selectedResearchProtocols.length === 0) {
    state.researchQuestion = `${state.researchQuestion ?? ""}\n\nMartin's follow-up: ${text}`;
    state.researchContext = `${state.researchContext ?? ""}\n\nMartin's follow-up: ${text}`;
    return selectProtocolsAndRun(env, state);
  }

  const changeCheck = await aiJson<{ materiallyChanged: boolean; reason?: string }>(env, {
    taskId: "research.protocol_selection",
    system: `You evaluate whether a follow-up request materially changes the research question, scope, or research need compared to the original research task.

Original Question: ${state.researchQuestion ?? ""}
Active Protocols: ${state.selectedResearchProtocols.join(", ")}

Evaluate the follow-up text:
- Set materiallyChanged to true if the follow-up introduces a fundamentally new entity, market, competitor, regulatory domain, or materially alters the research question/scope such that protocol selection must be re-evaluated.
- Set materiallyChanged to false if the follow-up is a minor refinement, clarification, or continuation within the existing research scope and active protocols.

Return JSON: {"materiallyChanged": true | false, "reason": "..."}`,
    user: text,
    light: true,
  });

  if (changeCheck?.materiallyChanged) {
    await logActivity(env, {
      entry: `R&I follow-up materially changed research scope/question — re-entering protocol selection`,
      type: "Activity",
      area: "Research & Intelligence",
      decisionRationale: changeCheck.reason ?? "Follow-up materially alters research scope or question.",
      outcome: "Active",
    });
    state.researchQuestion = `${state.researchQuestion ?? ""}\n\nMaterially changed follow-up: ${text}`;
    state.researchContext = `${state.researchContext ?? ""}\n\nFollow-up: ${text}`;
    state.selectedResearchProtocols = undefined;
    return selectProtocolsAndRun(env, state);
  }

  state.researchContext = `${state.researchContext ?? ""}\n\nMartin's follow-up: ${text}`;
  return runSynthesis(env, state);
}
