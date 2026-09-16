import type { Env, WorkState } from "../../types";
import { getPage, plainText, richText, select, updatePage } from "../../notion";
import { aiJson } from "../../ai";
import { logActivity } from "../../log";
import { sendMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import type { ResearchProtocolId } from "./protocols";
import { isResearchProtocolId, researchProtocolDetail, researchProtocolSummaryList } from "./protocols";
import type { ResearchSynthesis } from "./evidence";
import { validateSynthesis } from "./evidence";

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

interface ProtocolSelectionResult {
  protocols?: string[];
  ambiguous?: boolean;
  reason?: string;
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
  const question = state.researchQuestion ?? "";

  const stage1 = await aiJson<ProtocolSelectionResult>(env, {
    taskId: "research.protocol_selection",
    system: `You select research protocol(s) for ENIG's Research & Intelligence Unit. Below are the six available protocols and what each investigates:

${researchProtocolSummaryList()}

A research question may require one protocol, several protocols, or Evidence & Source Validation alongside another protocol. Select ALL genuinely applicable protocols -- do not force a mixed question into a single category merely to simplify selection, and do not select based on keyword matching alone; consider what the question actually requires.

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

  state.selectedResearchProtocols = selected;
  await logActivity(env, {
    entry: `R&I protocol(s) selected: ${selected.map((id) => id).join(", ")}`,
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

const PROTOCOL_CANONICAL_NAMES: Record<ResearchProtocolId, string> = {
  business_company: "Business / Company Intelligence",
  market_industry: "Market / Industry Intelligence",
  competitive: "Competitive Intelligence",
  customer_audience: "Customer / Audience Intelligence",
  environmental_regulatory: "Environmental / Regulatory Intelligence",
  evidence_validation: "Evidence & Source Validation",
};

/**
 * Maps a model-returned protocol name back to its canonical id, tolerant
 * of minor phrasing variance (case, partial match) since the model is
 * asked to return the protocol's display name, not its internal id.
 * Returns null for anything that doesn't clearly match one of the six
 * registered protocols -- callers must treat that as "couldn't
 * determine," never guess a nearest neighbor. Exported for direct testing
 * (this is the one piece of protocol-selection genuinely testable as pure
 * logic; the AI classification call itself is exercised live, the same as
 * every other Hat's aiJson-driven decision in this codebase).
 */
function normalizeProtocolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function nameToProtocolId(name: string): ResearchProtocolId | null {
  const normalized = normalizeProtocolName(name);
  if (!normalized) return null;
  const match = (Object.keys(PROTOCOL_CANONICAL_NAMES) as ResearchProtocolId[]).find((id) => {
    const canonical = normalizeProtocolName(PROTOCOL_CANONICAL_NAMES[id]);
    // Substring containment is only trusted once the normalized name is
    // long enough to be a real match rather than a trivial/empty-string
    // false positive (every string "contains" "").
    return canonical === normalized || (normalized.length >= 8 && (canonical.includes(normalized) || normalized.includes(canonical)));
  });
  return match && isResearchProtocolId(match) ? match : null;
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
  const protocols = state.selectedResearchProtocols ?? [];
  const question = state.researchQuestion ?? "";
  const context = state.researchContext ?? "";

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

  const synthesis = await aiJson<ResearchSynthesis>(env, {
    taskId: "research.synthesis",
    system: buildSynthesisSystemPrompt(hatDefinition, universalRoleContract, protocols),
    user: `Research question: ${question}\n\nSupplied context:\n${context}`,
    maxTokens: 2048,
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

function buildSynthesisSystemPrompt(hatDefinition: string, universalRoleContract: string, protocols: ResearchProtocolId[]): string {
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
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    `Return JSON exactly matching this shape:
{
  "sources": [{"id": "s1", "source": "...", "sourceType": "...", "url": "...", "publicationDate": "...", "retrievalDate": "...", "passage": "...", "claimSupported": "...", "limitations": "...", "validationStatus": "validated" | "unvalidated" | "contradicted"}],
  "evidence": [{"id": "e1", "statement": "...", "sourceIds": ["s1"]}],
  "findings": [{"statement": "...", "evidenceIds": ["e1"]}],
  "implications": [{"statement": "...", "basedOnFindingIndexes": [0]}],
  "limitations": [{"statement": "...", "relatedTo": "..."}]
}
If you have no real sources available to you (no live browsing/search access), state this plainly as a Limitation and keep evidence/findings/implications empty rather than fabricating sources — an empty, honest result is correct; a fabricated one is not.`,
  ].join("\n\n");
}

function formatSynthesisForTelegram(synthesis: ResearchSynthesis): string {
  const lines: string[] = [];
  lines.push(`*Protocol(s) used*: ${synthesis.protocolsUsed.map((id) => PROTOCOL_CANONICAL_NAMES[id]).join(", ")}`);
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

  state.stage = "delivered";
  state.awaiting = "research_feedback";
  return state;
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
 * intelligence, it doesn't gate on approval" design. Re-runs synthesis
 * with the already-selected protocol(s) plus Martin's follow-up appended;
 * a follow-up that clearly needs a different protocol still gets caught by
 * the next runSynthesis call's own governance-grounded reasoning.
 */
export async function handleResearchFeedback(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.researchContext = `${state.researchContext ?? ""}\n\nMartin's follow-up: ${text}`;
  if (!state.selectedResearchProtocols || state.selectedResearchProtocols.length === 0) {
    state.researchQuestion = `${state.researchQuestion ?? ""}\n\nMartin's follow-up: ${text}`;
    return selectProtocolsAndRun(env, state);
  }
  return runSynthesis(env, state);
}
