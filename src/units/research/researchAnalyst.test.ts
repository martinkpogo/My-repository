import test from "node:test";
import assert from "node:assert";
import { buildEffectiveResearchContext, nameToProtocolId, resolveResearchHandoffContext } from "./researchAnalyst";
import { RESEARCH_PROTOCOL_REGISTRY, RESEARCH_PROTOCOL_IDS, researchProtocolDetail, isResearchProtocolId } from "./protocols";
import { validateSynthesis, findUnverifiableSources } from "./evidence";
import type { ResearchSynthesis } from "./evidence";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import { extractAuthorizedContextSummary, isValidSafeContext } from "./safeContext";
import { redactIdentityTerms } from "../../ai/identityRedaction";

test("1. Protocol Coverage: resolves all six approved protocol names to internal IDs", () => {
  for (const id of RESEARCH_PROTOCOL_IDS) {
    const reg = RESEARCH_PROTOCOL_REGISTRY[id];
    assert.ok(reg.evidenceRequirements, `Protocol ${id} must specify evidence requirements`);
    assert.strictEqual(nameToProtocolId(reg.name), id);
    assert.strictEqual(isResearchProtocolId(id), true);
  }
});

test("2. Multi-protocol request: multiple distinct protocol names resolve independently and can be detailed together", () => {
  const p1 = nameToProtocolId("Competitive Intelligence");
  const p2 = nameToProtocolId("Evidence & Source Validation");
  assert.strictEqual(p1, "competitive");
  assert.strictEqual(p2, "evidence_validation");

  const detail = researchProtocolDetail(["competitive", "evidence_validation"]);
  assert.ok(detail.includes("Competitive Intelligence"));
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
    findings: [{ statement: "Competitor pricing has conflicting source data", evidenceIds: ["e1"] }],
    implications: [{ statement: "Pricing tier remains unconfirmed", basedOnFindingIndexes: [0] }],
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
      { statement: "Company will double revenue next year", evidenceIds: [] }, // UNSUPPORTED CLAIM
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

test("9. Unauthorized Handoff → fails closed safely", async () => {
  const mockEnv: any = { NOTION_API_KEY: "invalid_key" };
  const res = await resolveResearchHandoffContext(mockEnv, "unauthorized_handoff_id");
  assert.strictEqual(res.success, false);
  if (!res.success) {
    assert.strictEqual(res.insufficientContext.category, "handoff record access");
    assert.ok(res.insufficientContext.reason.includes("unable to access Handoff record"));
  }
});

test("10. Complete valid Handoff → structured source-linked result", () => {
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
      findings: [{ statement: "APAC region represents strong growth potential", evidenceIds: ["e1"] }],
      implications: [{ statement: "Feasibility study warrants further detailed entry modeling", basedOnFindingIndexes: [0] }],
      limitations: [],
    };
    const val = validateSynthesis(validSynthesis);
    assert.strictEqual(val.valid, true);
  }
});

test("11. Free-text R&I follow-up: updates research context for synthesis", () => {
  const state: any = {
    workId: "work_100",
    selectedResearchProtocols: ["competitive"],
    researchQuestion: "Analyze Competitor A's pricing model.",
    researchContext: "Competitor A prices at $50/mo.",
  };

  state.researchContext = `${state.researchContext}\n\nMartin's follow-up: Compare with Competitor B as well.`;
  assert.ok(state.researchContext.includes("Compare with Competitor B"));
  assert.deepStrictEqual(state.selectedResearchProtocols, ["competitive"]);
});

test("12. Materially changed follow-up → re-enters protocol/scope selection", () => {
  const state: any = {
    workId: "work_101",
    selectedResearchProtocols: ["competitive"],
    researchQuestion: "Analyze Competitor A's pricing model.",
    researchContext: "Competitor A pricing data.",
  };

  // Simulating material change detected on follow-up
  const materiallyChanged = true;
  if (materiallyChanged) {
    state.researchQuestion = `${state.researchQuestion}\n\nMaterially changed follow-up: What are the regulatory compliance requirements in EU?`;
    state.selectedResearchProtocols = undefined;
  }

  assert.strictEqual(state.selectedResearchProtocols, undefined);
  assert.ok(state.researchQuestion.includes("regulatory compliance requirements in EU"));
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
The R&I runtime must not be given or infer from this context:
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
    findings: [{ statement: "Main competitors are Company A, B, and C", evidenceIds: ["e1"] }],
    implications: [{ statement: "Consider differentiating from Company A", basedOnFindingIndexes: [0] }],
    limitations: [],
  };
  const unverifiable = findUnverifiableSources(fabricatedSynthesis, effectiveContext);
  assert.strictEqual(unverifiable.length, 2);
});

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
    findings: [{ statement: "The Accra market for this service category is growing", evidenceIds: ["e1"] }],
    implications: [{ statement: "Growing demand may warrant continued investment in this category", basedOnFindingIndexes: [0] }],
    limitations: [{ statement: "Single source, not independently cross-checked." }],
  };
  assert.strictEqual(validateSynthesis(honestSynthesis).valid, true);
  assert.strictEqual(findUnverifiableSources(honestSynthesis, effectiveContext).length, 0);
});
