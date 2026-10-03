import test from "node:test";
import assert from "node:assert";
import {
  MAX_RESEARCH_TEXT_LENGTH,
  MAX_SUPPLIED_EVIDENCE_LENGTH,
  buildEffectiveResearchContext,
  buildSynthesisPromptParts,
  capResearchText,
  capSuppliedEvidence,
  executeResearch,
  resolveSelectedProtocols,
} from "./executor";
import { discoveryCronContext } from "../../access";
import type { Env } from "../../types";
import { RESEARCH_PROTOCOL_REGISTRY, RESEARCH_PROTOCOL_IDS, researchProtocolDetail, isResearchProtocolId, nameToProtocolId } from "./protocols";
import type { ResearchProtocolId } from "./protocols";
import type { ResearchSynthesis } from "./types";
import { applyEvidenceSourceValidationGate, findUnverifiableSources, validateSynthesis } from "../evidence/validation";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import { extractAuthorizedContextSummary, isValidSafeContext } from "./safeContext";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { applyProtocolSelectionGuardrails } from "./protocolGuardrails";
import { buildResearchPlanPromptParts, capResearchPlan } from "./researchPlan";
import { assessDimensionCoverage, formatDimensionEvidenceForContext, formatUncoveredDimensionsWarning } from "./webSearch";
import type { DimensionEvidence } from "./webSearch";

/** Reconstructs the same assembled string generate() would send as the system prompt, from buildSynthesisPromptParts's own parts -- mirrors ai.ts's assembleSystemPrompt exactly. */
function buildSynthesisSystemPrompt(roleDefinition: string, universalRoleContract: string, protocols: ResearchProtocolId[], hasWebResults: boolean, skillContent?: string): string {
  const parts = buildSynthesisPromptParts(roleDefinition, universalRoleContract, protocols, hasWebResults, skillContent);
  return [parts.persona, parts.behavior, parts.skillContent, parts.context].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

test("1. Protocol Coverage: resolves all six approved protocol names to internal IDs", () => {
  for (const id of RESEARCH_PROTOCOL_IDS) {
    const reg = RESEARCH_PROTOCOL_REGISTRY[id];
    assert.ok(reg.evidenceRequirements, `Protocol ${id} must specify evidence requirements`);
    assert.strictEqual(nameToProtocolId(reg.name), id);
    assert.strictEqual(isResearchProtocolId(id), true);
  }
});

test("2. Multi-protocol request: multiple distinct protocol names resolve independently and can be detailed together", () => {
  const p1 = nameToProtocolId("Competitive Research");
  const p2 = nameToProtocolId("Evidence & Source Validation");
  assert.strictEqual(p1, "competitive");
  assert.strictEqual(p2, "evidence_validation");

  const detail = researchProtocolDetail(["competitive", "evidence_validation"]);
  assert.ok(detail.includes("Competitive Research"));
  assert.ok(detail.includes("Evidence & Source Validation"));
});

test("3. Ambiguous request → stops, does not guess nearest neighbor", () => {
  assert.strictEqual(nameToProtocolId("Unknown Unregistered Specialization"), null);
  assert.strictEqual(nameToProtocolId("Random Keyword"), null);
  assert.strictEqual(nameToProtocolId(""), null);
});

test("4. Insufficient context → fails closed", () => {
  const res = evaluateHandoffContext(
    {
      handoffId: "handoff_test_1",
      entityToken: "ENT-100",
      sanitizedContext: "   ", // empty sanitized context
    },
    "research.synthesis",
  );

  assert.strictEqual(res.success, false);
  if (!res.success) {
    assert.strictEqual(res.insufficientContext.isInsufficient, true);
    assert.ok(res.insufficientContext.reason.includes("sanitized execution context"));
  }
});

test("5. Conflicting evidence → surfaced in limitations, not silently resolved", () => {
  const synthesis: ResearchSynthesis = {
    protocolsUsed: ["competitive", "evidence_validation"],
    sources: [
      { id: "s1", source: "Official Site", sourceType: "primary", passage: "Claims $100/mo", claimSupported: "pricing", validationStatus: "validated" },
      { id: "s2", source: "Market Review", sourceType: "secondary", passage: "Reports $150/mo", claimSupported: "pricing", validationStatus: "contradicted" },
    ],
    evidence: [{ id: "e1", statement: "Conflicting price reports ($100 vs $150)", sourceIds: ["s1", "s2"] }],
    findings: [{ id: "f1", statement: "Competitor pricing has conflicting source data", evidenceIds: ["e1"] }],
    implications: [{ statement: "Pricing tier remains unconfirmed", basedOnFindingIds: ["f1"] }],
    limitations: [{ statement: "Source conflict on pricing; requires primary verification." }],
  };

  const validation = validateSynthesis(synthesis);
  assert.strictEqual(validation.valid, true);
  assert.strictEqual(synthesis.sources[1].validationStatus, "contradicted");
});

test("6. Unsupported claim → rejected by validateSynthesis", () => {
  const synthesis: ResearchSynthesis = {
    protocolsUsed: ["business_company"],
    sources: [{ id: "s1", source: "Press release", sourceType: "primary", passage: "New launch", claimSupported: "launch", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "Company launched product X", sourceIds: ["s1"] }],
    findings: [
      { id: "f1", statement: "Company will double revenue next year", evidenceIds: [] }, // UNSUPPORTED CLAIM
    ],
    implications: [],
    limitations: [],
  };

  const validation = validateSynthesis(synthesis);
  assert.strictEqual(validation.valid, false);
  assert.ok(validation.reason?.includes("cites no evidence"));
});

test("7. Closed-context violation → no traversal beyond authorized Handoff context", () => {
  const res = evaluateHandoffContext(
    {
      handoffId: "handoff_closed_1",
      entityToken: "ENTITY_TOKEN_OPAQUE_99",
      matterToken: "MATTER_TOKEN_OPAQUE_88",
      sanitizedContext: "Test research request context (Sanitized, no PII)",
      provenance: "notion:handoff:handoff_closed_1",
    },
    "research.synthesis",
  );

  assert.strictEqual(res.success, true);
  if (res.success) {
    assert.strictEqual(res.contract.entityToken, "ENTITY_TOKEN_OPAQUE_99");
    assert.strictEqual(res.contract.matterToken, "MATTER_TOKEN_OPAQUE_88");
    // Ensure opaque tokens contain no URL/Database traversal paths
    assert.strictEqual(res.contract.entityToken.includes("notion.so"), false);
    assert.strictEqual(res.contract.entityToken.includes("http"), false);
  }
});

test("8. Malformed Handoff → fails closed", () => {
  const res = evaluateHandoffContext(
    {
      // Missing entityToken and sanitizedContext
      handoffId: "handoff_malformed",
    },
    "research.synthesis",
  );

  assert.strictEqual(res.success, false);
  if (!res.success) {
    assert.strictEqual(res.insufficientContext.isInsufficient, true);
  }
});

test("10. Complete valid supplied context → structured source-linked result", () => {
  const res = evaluateHandoffContext(
    {
      handoffId: "handoff_valid_1",
      entityToken: "ENT_REF_001",
      matterToken: "MAT_REF_002",
      sanitizedContext: "Investigate market expansion feasibility in APAC.",
      provenance: "notion:handoff:handoff_valid_1",
    },
    "research.synthesis",
  );

  assert.strictEqual(res.success, true);
  if (res.success) {
    const validSynthesis: ResearchSynthesis = {
      protocolsUsed: ["market_industry"],
      sources: [{ id: "s1", source: "APAC Market Study 2024", sourceType: "secondary", passage: "APAC market growing 12% YoY", claimSupported: "growth rate", validationStatus: "validated" }],
      evidence: [{ id: "e1", statement: "APAC market exhibits 12% YoY growth", sourceIds: ["s1"] }],
      findings: [{ id: "f1", statement: "APAC region represents strong growth potential", evidenceIds: ["e1"] }],
      implications: [{ statement: "Feasibility study warrants further detailed entry modeling", basedOnFindingIds: ["f1"] }],
      limitations: [],
    };
    const val = validateSynthesis(validSynthesis);
    assert.strictEqual(val.valid, true);
  }
});

// --- Research-Safe Consultancy Context: retrieval, grounding, and privacy enforcement ---

const REAL_SAFE_CONTEXT_PAGE = `## Purpose
A controlled, sanitized description of the consultancy.
## Authorized Context
### Business Category
- Strategy-led consultancy.
### Service Domains
- Business strategy
- Positioning
- Brand
- Communications
### General Client Type
- Organisations
- Businesses
### Problem Domain
- Perception
- Positioning
### Geographic Context
- Primary: Ghana
- Secondary: Africa
## Identity Protection
The research runtime must not be given or infer from this context:
- Consultancy name: ENIG
- Founder name: Martin
- Client identities
- Proprietary methodologies
## External Research Boundary
- Do not include the organization's identity in external research queries.
## Governance Boundary
This page is the canonical source.`;

test("13. Safe-context retrieval: canonical safe context validates successfully", () => {
  assert.strictEqual(isValidSafeContext(REAL_SAFE_CONTEXT_PAGE), true);
});

test("14. Safe-context retrieval: malformed/missing safe context fails closed (no generic-assumption fallback exists to fall back to)", () => {
  assert.strictEqual(isValidSafeContext(null), false);
  assert.strictEqual(isValidSafeContext("some unrelated short text"), false);
});

test("15. Context grounding: a broad market-research question is interpreted against the strategy-led consultancy category", () => {
  const categorySummary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT_PAGE);
  assert.ok(categorySummary.includes("Strategy-led consultancy"));
  assert.ok(categorySummary.includes("Ghana"));
  const relevance = "This asks about the size and structure of the market for strategy, brand, and communications consulting in Ghana/Africa.";
  const effectiveContext = buildEffectiveResearchContext(categorySummary, relevance, "What is the market for strategy consulting like?", "");
  assert.ok(effectiveContext.includes("Strategy-led consultancy"));
  assert.ok(effectiveContext.includes(relevance));
});

test("16. Privacy enforcement: consultancy identity and founder name are absent from the authorized category summary reaching the research prompt", () => {
  const categorySummary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT_PAGE);
  // The Identity Protection section (which even names what must stay
  // excluded) is itself excluded from the extracted summary -- the
  // literal strings "ENIG" and "Martin" only appear in that excluded
  // section of the fixture, never in Authorized Context.
  assert.ok(!categorySummary.includes("ENIG"));
  assert.ok(!categorySummary.includes("Martin"));
});

test("17. Privacy enforcement: excluded fields cannot be reconstructed from the effective research context object", () => {
  const categorySummary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT_PAGE);
  const effectiveContext = buildEffectiveResearchContext(categorySummary, "A relevance statement.", "A question.", "Supplied evidence.");
  assert.ok(!effectiveContext.includes("ENIG"));
  assert.ok(!effectiveContext.includes("Martin"));
  assert.ok(!effectiveContext.includes("Proprietary methodologies"));
});

test("18. Privacy enforcement: even if identity leaked into the effective context, the universal redaction gate (applied to every provider call) still strips it before reaching a provider", () => {
  const leaked = "Research ENIG's own market position; Martin wants a quick answer.";
  const redacted = redactIdentityTerms(leaked);
  assert.ok(!redacted.includes("ENIG"));
  assert.ok(!redacted.includes("Martin"));
});

test("19. Research quality: the previously-failed live case (fabricated competitors/report/URLs with no supplied context) is now rejected by findUnverifiableSources", () => {
  const categorySummary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT_PAGE);
  const effectiveContext = buildEffectiveResearchContext(
    categorySummary,
    "This asks about competitors in the strategy/brand/communications consulting market.",
    "Who are our main competitors and how do they position?",
    "",
  );
  const fabricatedSynthesis: ResearchSynthesis = {
    protocolsUsed: ["competitive"],
    sources: [
      { id: "s1", source: "Company A Website", sourceType: "primary", url: "https://www.companya.com", passage: "...", claimSupported: "positioning", validationStatus: "unvalidated" },
      { id: "s2", source: "Market Research Report", sourceType: "secondary", passage: "...", claimSupported: "market sizing", validationStatus: "unvalidated" },
    ],
    evidence: [{ id: "e1", statement: "Competitor A positions as premium", sourceIds: ["s1", "s2"] }],
    findings: [{ id: "f1", statement: "Main competitors are Company A, B, and C", evidenceIds: ["e1"] }],
    implications: [{ statement: "Consider differentiating from Company A", basedOnFindingIds: ["f1"] }],
    limitations: [],
  };
  const unverifiable = findUnverifiableSources(fabricatedSynthesis, effectiveContext);
  assert.strictEqual(unverifiable.length, 2);
});

// --- Architectural correction: protocol-specific research planning, not "protocol -> generic search suffix -> synthesis" ---

test("20. Research quality: an honest result grounded in real supplied evidence is accepted", () => {
  const categorySummary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT_PAGE);
  const supplied = "Client-shared note: GhanaStrategyWatch (https://ghanastrategywatch.example/report) reports 8% YoY growth in demand for brand/communications consulting in Accra.";
  const effectiveContext = buildEffectiveResearchContext(
    categorySummary,
    "This asks about market growth for the consultancy's own service category in Ghana.",
    "What does the market for our services look like in Ghana?",
    supplied,
  );
  const honestSynthesis: ResearchSynthesis = {
    protocolsUsed: ["market_industry"],
    sources: [{ id: "s1", source: "GhanaStrategyWatch", sourceType: "secondary", url: "https://ghanastrategywatch.example/report", passage: "8% YoY growth", claimSupported: "market growth", validationStatus: "unvalidated" }],
    evidence: [{ id: "e1", statement: "Demand for brand/communications consulting in Accra grew 8% YoY", sourceIds: ["s1"] }],
    findings: [{ id: "f1", statement: "The Accra market for this service category is growing", evidenceIds: ["e1"] }],
    implications: [{ statement: "Growing demand may warrant continued investment in this category", basedOnFindingIds: ["f1"] }],
    limitations: [{ statement: "Single source, not independently cross-checked." }],
  };
  assert.strictEqual(validateSynthesis(honestSynthesis).valid, true);
  assert.strictEqual(findUnverifiableSources(honestSynthesis, effectiveContext).length, 0);
});


test("21. buildSynthesisSystemPrompt forbids generic business advice as a Finding/Implication -- the exact bad live output ('businesses should conduct regular competitor analysis')", () => {
  const prompt = buildSynthesisSystemPrompt("Hat definition text.", "Universal Role Contract text.", ["market_industry"], true);
  assert.ok(prompt.includes("businesses should conduct regular competitor analysis"));
  assert.ok(prompt.toLowerCase().includes("never produce generic business advice"));
});

test("22. buildSynthesisSystemPrompt requires evidence to actually address the dimension it's cited for -- a methodology article does not become market evidence", () => {
  const prompt = buildSynthesisSystemPrompt("Hat definition text.", "Universal Role Contract text.", ["market_industry"], true);
  assert.ok(prompt.includes("how to conduct competitor analysis"));
  assert.ok(prompt.toLowerCase().includes("does not by itself establish"));
});

test("22b. buildSynthesisSystemPrompt instructs citing selectively rather than enumerating every fetched result -- fixes the 'synthesis generation failed' truncation regression from wider search breadth", () => {
  const prompt = buildSynthesisSystemPrompt("Hat definition text.", "Universal Role Contract text.", ["market_industry"], true);
  assert.ok(prompt.toLowerCase().includes("do not include every single one as a source"));
  assert.ok(prompt.toLowerCase().includes("cut off mid-generation"));
});

test("23. Regression -- the representative failed live request: a Ghana market/industry question with a competitor and audience component", () => {
  const question =
    "What is the market structure, demand, size, and growth for strategy, brand, and communications consulting in Ghana and Africa, including named competitors, their positioning, public pricing, and what buyers/customers actually need?";

  // Stage: AI protocol selection reproduced the live bug -- Market / Industry omitted entirely.
  const aiSelected: ("competitive" | "customer_audience")[] = ["competitive", "customer_audience"];
  const corrected = applyProtocolSelectionGuardrails(question, [...aiSelected]);
  assert.strictEqual(corrected[0], "market_industry", "Market / Industry Research must be primary, not omitted");
  assert.ok(corrected.includes("competitive"));
  assert.ok(corrected.includes("customer_audience"));

  // Stage: research plan must be protocol-specific and bounded, not one generic phrase per protocol.
  const plan = [
    { protocol: "market_industry" as const, subQuestion: "What is the size and growth rate of the strategy/brand consulting market in Ghana?" },
    { protocol: "market_industry" as const, subQuestion: "What are the demand conditions for communications consulting services in Accra?" },
    { protocol: "competitive" as const, subQuestion: "Which named firms offer strategy or brand consulting services in Ghana?" },
    { protocol: "customer_audience" as const, subQuestion: "What do businesses in Ghana say they need from a strategy consultancy?" },
  ];
  const capped = capResearchPlan(plan);
  assert.strictEqual(capped.length, 4);
  assert.ok(capped.some((d) => d.protocol === "market_industry" && d.subQuestion.includes("Ghana")));

  // Stage: a dimension with zero search results must surface as an explicit
  // limitation signal, not silently vanish -- and the generic-methodology-
  // article case (the actual live failure) must never be treated as
  // adequate evidence for a market-growth dimension.
  const dimensionEvidence: DimensionEvidence[] = [
    { ...plan[0], results: [] }, // no real market data found -- the actual live outcome
    { ...plan[1], results: [] },
    {
      ...plan[2],
      results: [{ title: "How to Do Competitor Analysis", url: "https://example.com/how-to", snippet: "A generic guide to competitor analysis methodology.", publishedDate: "2025-01-01" }],
    },
    { ...plan[3], results: [] },
  ];
  const { covered, uncovered } = assessDimensionCoverage(dimensionEvidence);
  assert.strictEqual(uncovered.length, 3);
  assert.strictEqual(covered.length, 1);

  const warning = formatUncoveredDimensionsWarning(uncovered);
  assert.ok(warning.includes("size and growth rate"));
  assert.ok(warning.toLowerCase().includes("limitation"));

  const formatted = formatDimensionEvidenceForContext(dimensionEvidence);
  assert.ok(formatted.includes("How to Do Competitor Analysis"));

  // The synthesis prompt must explicitly instruct that this generic result
  // does not by itself satisfy the Market / Industry evidence requirement.
  const synthesisPrompt = buildSynthesisSystemPrompt("Hat definition text.", "Universal Role Contract text.", ["market_industry", "competitive", "customer_audience"], true);
  assert.ok(synthesisPrompt.toLowerCase().includes("generic"));
});

test("26. capResearchText leaves short text untouched", () => {
  assert.strictEqual(capResearchText("A short research question."), "A short research question.");
});

test("27. capResearchText bounds long text to MAX_RESEARCH_TEXT_LENGTH, keeping the most recent content", () => {
  const long = "x".repeat(MAX_RESEARCH_TEXT_LENGTH * 3) + "MOST_RECENT_TAIL";
  const capped = capResearchText(long);
  assert.strictEqual(capped.length, MAX_RESEARCH_TEXT_LENGTH);
  assert.ok(capped.endsWith("MOST_RECENT_TAIL"));
});

test("28. capResearchText self-heals a previously-bloated value across repeated appends -- confirmed live root cause: unbounded accumulation across clarification/feedback rounds (compounded by Telegram-retry double-appends) grew a research question past 28,000 tokens, which every fallback provider then rejected or timed out on", () => {
  // Simulate the exact accumulation pattern in handleResearchClarification:
  // each round appends to whatever was already stored, uncapped.
  let question = "Original question.";
  for (let round = 0; round < 20; round++) {
    question = capResearchText(`${question}\n\nAdditional detail: ${"detail ".repeat(50)}round ${round}`);
  }
  assert.ok(question.length <= MAX_RESEARCH_TEXT_LENGTH);
  assert.ok(question.includes("round 19"), "the most recent round's content must survive capping");
});

test("34. capSuppliedEvidence leaves short evidence untouched", () => {
  assert.strictEqual(capSuppliedEvidence("Short evidence blob."), "Short evidence blob.");
});

test("35. capSuppliedEvidence bounds long evidence to MAX_SUPPLIED_EVIDENCE_LENGTH, keeping the head (Martin's own supplied context matters most) and noting the truncation -- confirmed live root cause: even after every per-item size fix, a full multi-protocol synthesis request still landed right at Groq's flat 8000-token ceiling", () => {
  const head = "IMPORTANT_HEAD_CONTEXT";
  const long = head + "x".repeat(MAX_SUPPLIED_EVIDENCE_LENGTH * 2);
  const capped = capSuppliedEvidence(long);
  assert.ok(capped.startsWith(head));
  assert.ok(capped.includes("truncated"));
  assert.ok(capped.length < long.length);
});

// =====================================================================================
// Research runtime boundary: one shared pipeline over the six protocol definitions.
// The numbered tests above cover behavior that had to be preserved unchanged (citation
// contract, provenance, fail-closed stops, caps).
// =====================================================================================

const FIVE_RESEARCH_PROTOCOLS: ResearchProtocolId[] = ["business_company", "market_industry", "competitive", "customer_audience", "environmental_regulatory"];

function planPromptFor(ids: ResearchProtocolId[]): string {
  const parts = buildResearchPlanPromptParts("Category summary text.", "Relevance text.", ids);
  return [parts.persona, parts.skillContent].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

test("EXEC 1-5. Each of the five research protocols resolves by canonical name and is consumed by the SAME shared plan + synthesis path -- one pipeline, six protocol definitions", () => {
  for (const id of FIVE_RESEARCH_PROTOCOLS) {
    const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
    assert.strictEqual(nameToProtocolId(procedure.name), id, `${id} must resolve from its canonical protocol name`);

    const stagePrompts = [planPromptFor([id]), buildSynthesisSystemPrompt("Research role contract.", "Universal Role Contract text.", [id], true)];
    for (const prompt of stagePrompts) {
      assert.ok(prompt.includes(procedure.method), `${id}: method must reach the shared stage`);
      assert.ok(prompt.includes(procedure.evidenceRequirements), `${id}: evidence requirements must reach the shared stage`);
      for (const constraint of procedure.interpretationConstraints) {
        assert.ok(prompt.includes(constraint), `${id}: interpretation constraint must reach the shared stage: ${constraint}`);
      }
    }
  }
});

test("EXEC 6. Evidence & Source Validation is a cross-cutting executor gate: the protocol flows through the same shared path, and selecting it never weakens the mandatory gate", () => {
  const procedure = RESEARCH_PROTOCOL_REGISTRY.evidence_validation;
  const plan = planPromptFor(["evidence_validation"]);
  assert.ok(plan.includes(procedure.method), "the protocol is consumed like any other -- no separate pipeline");
  assert.ok(plan.includes(procedure.evidenceRequirements));

  for (const constraint of procedure.interpretationConstraints) {
    assert.ok(constraint.includes("does not replace the research executor's universal Evidence & Source Validation gate"), "the protocol's own contract must not claim the universal gate");
  }

  // A result attributed to evidence_validation still has to pass the gate.
  const broken: ResearchSynthesis = {
    protocolsUsed: ["evidence_validation"],
    sources: [{ id: "s1", source: "Real Source", sourceType: "primary", url: "https://example.com", passage: "...", claimSupported: "x", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "Something", sourceIds: [] }],
    findings: [],
    implications: [],
    limitations: [],
  };
  const gate = applyEvidenceSourceValidationGate(broken, "any supplied context");
  if (gate.valid) assert.fail("an evidence_validation-attributed result must still fail the universal gate when a citation contract is broken");
  assert.strictEqual(gate.failure, "invalid_synthesis");
});

test("EXEC 7. Multiple protocols selected for one question each keep their own contract in the shared prompts, and unselected protocols are not injected", () => {
  const ids: ResearchProtocolId[] = ["market_industry", "competitive", "customer_audience"];
  const prompt = [planPromptFor(ids), buildSynthesisSystemPrompt("role", "urc", ids, true)].join("\n");

  for (const id of ids) {
    const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
    assert.ok(prompt.includes(procedure.method), `${id}'s method must be present`);
    assert.ok(prompt.includes(procedure.evidenceRequirements), `${id}'s evidence requirements must be present`);
    for (const constraint of procedure.interpretationConstraints) {
      assert.ok(prompt.includes(constraint), `${id}'s constraints must be present`);
    }
  }
  assert.ok(!prompt.includes(RESEARCH_PROTOCOL_REGISTRY.business_company.method), "an unselected protocol must not be injected into the shared stages");
});

test("EXEC 8. Ambiguous protocol selection blocks: names that cannot be clearly resolved yield an empty selection -- the AMBIGUOUS_PROTOCOL_SELECTION precondition", () => {
  assert.deepStrictEqual(resolveSelectedProtocols([]), []);
  assert.deepStrictEqual(resolveSelectedProtocols(["Something that is not a registered protocol"]), []);
  assert.deepStrictEqual(resolveSelectedProtocols(["Random Keyword"]), []);
});

test("EXEC 9. Invalid selection is dropped, never guessed into a nearest neighbour", () => {
  assert.deepStrictEqual(resolveSelectedProtocols(["Competitive Research", "Random Keyword", ""]), ["competitive"]);
  assert.deepStrictEqual(resolveSelectedProtocols(["Evidence & Source Validation"]), ["evidence_validation"]);
});

test("EXEC 20. Token/privacy boundaries remain intact: the research-facing context still carries only category + relevance + question + supplied evidence, never system-side governance", () => {
  const context = buildEffectiveResearchContext("AUTHORIZED_CATEGORY_MARKER", "RELEVANCE_MARKER", "QUESTION_MARKER", "SUPPLIED_MARKER");
  for (const marker of ["AUTHORIZED_CATEGORY_MARKER", "RELEVANCE_MARKER", "QUESTION_MARKER", "SUPPLIED_MARKER"]) {
    assert.ok(context.includes(marker), `${marker} must reach the research context`);
  }
  assert.ok(!context.includes("Universal Role Contract"), "system-side governance must never reach the research-facing context");
  assert.ok(!context.includes("RESEARCH ROLE & AUTHORITY"), "system-side governance must never reach the research-facing context");
  // Outbound-query identity redaction is covered in webSearch.test.ts
  // ("gatherDimensionEvidence redacts identity terms...") and by the
  // redaction-gate test above (18).
});

// =====================================================================================
// executeResearch: the stateless research pipeline -- fail-closed outcomes, completion,
// and the boundary guarantees that make it non-organizational.
// =====================================================================================

const SAFE_CONTEXT_KV_KEY = "governance:3ddcb004-e583-81e5-b30a-db8cba543823";
const ROLE_CONTRACT_KV_KEY = "governance:3ddcb004-e583-8161-96ba-cdec357c5b5b";
const UNIVERSAL_CONTRACT_KV_KEY = "governance:3cecb004-e583-81ee-8f1e-f0d58532f4aa";

function researchEnv(ai: unknown, governance: Record<string, string> = {}): Env {
  const kv: Record<string, string> = {
    [SAFE_CONTEXT_KV_KEY]: REAL_SAFE_CONTEXT_PAGE.padEnd(200, " "),
    [ROLE_CONTRACT_KV_KEY]: "Research role contract text.",
    [UNIVERSAL_CONTRACT_KV_KEY]: "Universal role contract text.",
    ...governance,
  };
  return {
    AI: ai as any,
    STATE_KV: { get: async (key: string) => kv[key] ?? null, put: async () => undefined, delete: async () => undefined } as any,
    NOTION_VERSION: "2025-09-03",
    NOTION_TOKEN: "test-notion-token",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
  } as Env;
}

interface ResearchScript {
  relevance?: unknown;
  selection?: unknown;
  plan?: unknown;
  synthesis?: unknown;
  seenSystemPrompts?: string[];
}

function scriptedAi(script: ResearchScript): unknown {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      script.seenSystemPrompts?.push(system);
      const respond = (value: unknown) => ({ response: JSON.stringify(value) });
      if (system.includes("what the question means in relation to this authorized category")) {
        return respond(script.relevance ?? { relevance: "A market-structure question for a strategy-led consultancy in Ghana." });
      }
      if (system.includes("You select research protocol(s)")) {
        return respond(script.selection ?? { protocols: ["Market / Industry Research"], ambiguous: false, reason: "Broad market question." });
      }
      if (system.includes("You generate a bounded research plan")) {
        return respond(script.plan ?? { dimensions: [{ subQuestion: "What is the size of the consulting market in Ghana?" }] });
      }
      if (system.includes("research runtime — the selected research protocol")) {
        return respond(script.synthesis ?? HONEST_EMPTY_SYNTHESIS);
      }
      throw new Error(`Unexpected AI call in test -- system prompt: ${system.slice(0, 80)}`);
    },
  };
}

const HONEST_EMPTY_SYNTHESIS = {
  sources: [],
  evidence: [],
  findings: [],
  implications: [],
  limitations: [{ statement: "No supplied source material was available to research this from." }],
};

const QUESTION = "What is the market structure for strategy consulting in Ghana?";

test("EXEC 10. Missing/invalid safe context blocks execution fail-closed -- SAFE_CONTEXT_UNAVAILABLE, never a generic-assumption fallback, and no AI call is made", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "error", status: 404 }), { status: 404 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const forbiddenAi = {
    run: async () => {
      throw new Error("AI must not be called when the safe context is unavailable");
    },
  };
  const env = researchEnv(forbiddenAi, { [SAFE_CONTEXT_KV_KEY]: "" });

  const outcome = await executeResearch(env, { question: QUESTION, context: "" }, discoveryCronContext());

  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") assert.strictEqual(outcome.code, "SAFE_CONTEXT_UNAVAILABLE");
});

test("EXEC 11. An ambiguous protocol selection blocks as AMBIGUOUS_PROTOCOL_SELECTION and carries the model's own reason -- never a guessed protocol", async () => {
  const env = researchEnv(scriptedAi({ selection: { protocols: ["Competitive Research"], ambiguous: true, reason: "Unclear whether this is about competitors or the whole market." } }));

  const outcome = await executeResearch(env, { question: QUESTION, context: "" }, discoveryCronContext());

  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.strictEqual(outcome.code, "AMBIGUOUS_PROTOCOL_SELECTION");
    assert.match(outcome.reason, /Unclear whether/);
  }
});

test("EXEC 12. A selection naming no registered protocol blocks as AMBIGUOUS_PROTOCOL_SELECTION rather than defaulting to the nearest one", async () => {
  const env = researchEnv(scriptedAi({ selection: { protocols: ["Random Keyword"], ambiguous: false } }));
  const outcome = await executeResearch(env, { question: QUESTION, context: "" }, discoveryCronContext());
  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") assert.strictEqual(outcome.code, "AMBIGUOUS_PROTOCOL_SELECTION");
});

test("EXEC 13. A failed research plan blocks as PLAN_GENERATION_FAILED (the stage is load-bearing)", async () => {
  const env = researchEnv(scriptedAi({ plan: { dimensions: [] } }));
  const outcome = await executeResearch(env, { question: QUESTION, context: "" }, discoveryCronContext());
  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") assert.strictEqual(outcome.code, "PLAN_GENERATION_FAILED");
});

test("EXEC 14. Missing role governance blocks as GOVERNANCE_UNAVAILABLE instead of synthesizing without it", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "error", status: 404 }), { status: 404 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const env = researchEnv(scriptedAi({}), { [ROLE_CONTRACT_KV_KEY]: "" });
  const outcome = await executeResearch(env, { question: QUESTION, context: "" }, discoveryCronContext());
  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") assert.strictEqual(outcome.code, "GOVERNANCE_UNAVAILABLE");
});

test("EXEC 15. An honest, empty synthesis completes -- sources/findings empty with an explicit Limitation, protocols recorded by the executor", async () => {
  const env = researchEnv(scriptedAi({}));
  const progress: string[] = [];

  const outcome = await executeResearch(env, { question: QUESTION, context: "", onProgress: (text) => void progress.push(text) }, discoveryCronContext());

  assert.strictEqual(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.deepStrictEqual(outcome.synthesis.protocolsUsed, ["market_industry"]);
    assert.strictEqual(outcome.synthesis.findings.length, 0);
    assert.strictEqual(outcome.synthesis.limitations.length, 1);
    assert.ok(outcome.relevance.length > 0);
  }
  assert.ok(progress.length >= 2, "the optional progress hook is called per stage");
});

test("EXEC 16. A synthesis citing a source absent from the supplied context is blocked as UNVERIFIABLE_SOURCES -- the fabrication gate runs inside the executor", async () => {
  const fabricated = {
    sources: [{ id: "s1", source: "Invented Market Report 2025", sourceType: "secondary", passage: "p", claimSupported: "c", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "The market is large", sourceIds: ["s1"] }],
    findings: [{ id: "f1", statement: "The market is large", evidenceIds: ["e1"] }],
    implications: [],
    limitations: [],
  };
  const env = researchEnv(scriptedAi({ synthesis: fabricated }));
  const outcome = await executeResearch(env, { question: QUESTION, context: "Nothing relevant was supplied." }, discoveryCronContext());
  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") assert.strictEqual(outcome.code, "UNVERIFIABLE_SOURCES");
});

test("EXEC 17. A well-grounded synthesis (source literally present in the supplied context) completes with its findings intact", async () => {
  const grounded = {
    sources: [{ id: "s1", source: "Ghana Services Survey 2024", sourceType: "secondary", passage: "p", claimSupported: "c", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "Consulting demand grew", sourceIds: ["s1"] }],
    findings: [{ id: "f1", statement: "Consulting demand grew", evidenceIds: ["e1"] }],
    implications: [{ statement: "Demand supports market entry analysis", basedOnFindingIds: ["f1"] }],
    limitations: [],
  };
  const env = researchEnv(scriptedAi({ synthesis: grounded }));
  const outcome = await executeResearch(env, { question: QUESTION, context: "Per the Ghana Services Survey 2024, consulting demand grew." }, discoveryCronContext());
  assert.strictEqual(outcome.status, "completed");
  if (outcome.status === "completed") assert.strictEqual(outcome.synthesis.findings.length, 1);
});

test("EXEC 18. A synthesis with a broken citation chain is blocked as SYNTHESIS_INVALID", async () => {
  const broken = { sources: [], evidence: [], findings: [{ id: "f1", statement: "Unsupported conclusion", evidenceIds: [] }], implications: [], limitations: [] };
  const env = researchEnv(scriptedAi({ synthesis: broken }));
  const outcome = await executeResearch(env, { question: QUESTION, context: "" }, discoveryCronContext());
  assert.strictEqual(outcome.status, "blocked");
  if (outcome.status === "blocked") assert.strictEqual(outcome.code, "SYNTHESIS_INVALID");
});

test("EXEC 19. Declared Skill methodology is passed through to synthesis when the caller supplies it, and absent otherwise -- the executor never resolves a Skill itself", async () => {
  const withSkill: string[] = [];
  await executeResearch(researchEnv(scriptedAi({ seenSystemPrompts: withSkill })), { question: QUESTION, context: "", skillContent: "SKILL_METHODOLOGY_MARKER" }, discoveryCronContext());
  assert.ok(withSkill.some((p) => p.includes("SKILL_METHODOLOGY_MARKER")), "caller-declared Skill content reaches the synthesis prompt");

  const withoutSkill: string[] = [];
  await executeResearch(researchEnv(scriptedAi({ seenSystemPrompts: withoutSkill })), { question: QUESTION, context: "" }, discoveryCronContext());
  assert.ok(!withoutSkill.some((p) => p.includes("SKILL_METHODOLOGY_MARKER")));
  assert.ok(!withoutSkill.some((p) => p.includes("REUSABLE METHODOLOGY")), "no methodology section is invented when no Skill was declared");
});

test("EXEC 20. A throwing progress hook never fails the research it reports on", async () => {
  const env = researchEnv(scriptedAi({}));
  const outcome = await executeResearch(env, { question: QUESTION, context: "", onProgress: () => { throw new Error("cosmetic hook failure"); } }, discoveryCronContext());
  assert.strictEqual(outcome.status, "completed");
});

test("EXEC 21. The research runtime is non-organizational: no module under src/runtime/research or src/runtime/evidence imports a Unit/Hat registry, Work/WorkState, Telegram, Handoffs, or the session layer", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const researchDir = import.meta.dirname;
  const evidenceDir = path.join(researchDir, "..", "evidence");
  const forbidden = /from\s+["'](?:\.\.\/)+(?:units\/|hats\/|session|telegram|handoffWriter|checkHandoffs|router|workspaceRouter|platform\/skillRegistry)[^"']*["']/;
  const forbiddenTypes = /\b(WorkState|Unit)\b[^\n]*from\s+["'](?:\.\.\/)+types["']|from\s+["'](?:\.\.\/)+types["'][^\n]*\b(WorkState)\b/;

  for (const dir of [researchDir, evidenceDir]) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      assert.ok(!forbidden.test(source), `${file} must not import an organizational/application module`);
      assert.ok(!forbiddenTypes.test(source), `${file} must not depend on WorkState/Unit`);
      assert.ok(!/Research & Intelligence/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${file} must not branch on or name the retired Unit in code`);
    }
  }
});

test("EXEC 22. No protocol creates a second execution mechanism -- no per-protocol engine is exported from the research runtime", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const perProtocolEngine = /export\s+(?:async\s+)?function\s+(?:run|execute|invoke)[A-Za-z]*(?:BusinessCompany|MarketIndustry|Competitive|CustomerAudience|EnvironmentalRegulatory|EvidenceValidation)\b/;

  for (const file of fs.readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
    assert.ok(!perProtocolEngine.test(source), `${file} must not export a per-protocol research engine -- a protocol is a descriptor, not a runtime`);
  }
});
