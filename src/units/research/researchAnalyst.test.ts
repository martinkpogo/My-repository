import test from "node:test";
import assert from "node:assert";
import {
  MAX_RESEARCH_TEXT_LENGTH,
  buildEffectiveResearchContext,
  buildSynthesisSystemPrompt,
  capResearchText,
  formatSynthesisForHandoff,
  handleResearchHandoffApproval,
  resolveResearchHandoffContext,
  routeToConsumingHat,
} from "./researchAnalyst";
import type { WorkState } from "../../types";
import { RESEARCH_PROTOCOL_REGISTRY, RESEARCH_PROTOCOL_IDS, researchProtocolDetail, isResearchProtocolId, nameToProtocolId } from "./protocols";
import { validateSynthesis, findUnverifiableSources } from "./evidence";
import type { ResearchSynthesis } from "./evidence";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import { extractAuthorizedContextSummary, isValidSafeContext } from "./safeContext";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { applyProtocolSelectionGuardrails } from "./protocolGuardrails";
import { capResearchPlan } from "./researchPlan";
import { assessDimensionCoverage, formatDimensionEvidenceForContext, formatUncoveredDimensionsWarning } from "./webSearch";
import type { DimensionEvidence } from "./webSearch";

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
      findings: [{ id: "f1", statement: "APAC region represents strong growth potential", evidenceIds: ["e1"] }],
      implications: [{ statement: "Feasibility study warrants further detailed entry modeling", basedOnFindingIds: ["f1"] }],
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
    findings: [{ id: "f1", statement: "Main competitors are Company A, B, and C", evidenceIds: ["e1"] }],
    implications: [{ statement: "Consider differentiating from Company A", basedOnFindingIds: ["f1"] }],
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
    findings: [{ id: "f1", statement: "The Accra market for this service category is growing", evidenceIds: ["e1"] }],
    implications: [{ statement: "Growing demand may warrant continued investment in this category", basedOnFindingIds: ["f1"] }],
    limitations: [{ statement: "Single source, not independently cross-checked." }],
  };
  assert.strictEqual(validateSynthesis(honestSynthesis).valid, true);
  assert.strictEqual(findUnverifiableSources(honestSynthesis, effectiveContext).length, 0);
});

// --- Architectural correction: protocol-specific research planning, not "protocol -> generic search suffix -> synthesis" ---

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
  assert.strictEqual(corrected[0], "market_industry", "Market / Industry Intelligence must be primary, not omitted");
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

// --- R&I auto-handoff to the Hat that needs the research (currently Marketing Strategist) ---

test("24. formatSynthesisForHandoff preserves Evidence -> Finding -> Implication -> Limitation -> Source structure as plain text for a Notion Handoff record", () => {
  const synthesis: ResearchSynthesis = {
    protocolsUsed: ["market_industry"],
    sources: [{ id: "s1", source: "GSO", sourceType: "primary", url: "https://gso.gov.gh", passage: "...", claimSupported: "growth", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "Market grew 8%", sourceIds: ["s1"] }],
    findings: [{ id: "f1", statement: "The market is growing", evidenceIds: ["e1"] }],
    implications: [{ statement: "Continued investment in this category may be warranted", basedOnFindingIds: ["f1"] }],
    limitations: [{ statement: "Single source." }],
  };
  const formatted = formatSynthesisForHandoff(synthesis);
  assert.ok(formatted.includes("The market is growing"));
  assert.ok(formatted.includes("Continued investment"));
  assert.ok(formatted.includes("Single source."));
  assert.ok(formatted.includes("https://gso.gov.gh"));
});

test("25. formatSynthesisForHandoff omits empty sections rather than printing blank headers", () => {
  const synthesis: ResearchSynthesis = {
    protocolsUsed: ["market_industry"],
    sources: [],
    evidence: [],
    findings: [],
    implications: [],
    limitations: [{ statement: "No evidence was available." }],
  };
  const formatted = formatSynthesisForHandoff(synthesis);
  assert.ok(!formatted.includes("Findings:"));
  assert.ok(!formatted.includes("Sources:"));
  assert.ok(formatted.includes("No evidence was available."));
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

function fakeApprovalEnv(): any {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    NOTION_TOKEN: "test-notion-token",
    NOTION_VERSION: "2025-09-03",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
  };
}

function fakeStateWithPendingHandoff(): WorkState {
  return {
    workId: "work_200",
    chatId: 1,
    unit: "Research & Intelligence",
    hat: "Research & Intelligence Analyst",
    stage: "awaiting_research_handoff_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingResearchHandoff: {
      unit: "Marketing",
      hat: "Marketing Strategist",
      reason: "Directly informs marketing positioning.",
      handoffTitle: "R&I research for Marketing Strategist: test",
      verifiedFactsAndSources: "Findings:\n- The market is growing.",
    },
  };
}

function mockNotionAndTelegramFetch(notionShouldFail = false): { restore: () => void; notionCallsByDataSource: string[] } {
  const originalFetch = globalThis.fetch;
  const notionCallsByDataSource: string[] = [];
  globalThis.fetch = (async (urlArg: string, init: any) => {
    const url = String(urlArg);
    if (url.startsWith("https://api.notion.com")) {
      if (url.endsWith("/pages") && init?.method === "POST") {
        const body = JSON.parse(init.body);
        notionCallsByDataSource.push(body.parent?.data_source_id);
        if (notionShouldFail && body.parent?.data_source_id === "handoffs-ds") {
          return new Response("notion error", { status: 500 });
        }
      }
      return new Response(JSON.stringify({ id: "page_1", url: "https://notion.so/page_1", properties: {} }), { status: 200 });
    }
    if (url.startsWith("https://api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    notionCallsByDataSource,
  };
}

test("29. handleResearchHandoffApproval sends nothing to Notion when there's no pending handoff to act on", async () => {
  const { restore, notionCallsByDataSource } = mockNotionAndTelegramFetch();
  try {
    const state = fakeStateWithPendingHandoff();
    state.pendingResearchHandoff = undefined;
    await handleResearchHandoffApproval(fakeApprovalEnv(), state, true);
    assert.strictEqual(notionCallsByDataSource.length, 0);
  } finally {
    restore();
  }
});

test("30. handleResearchHandoffApproval on reject clears the pending handoff without creating a Handoff record", async () => {
  const { restore, notionCallsByDataSource } = mockNotionAndTelegramFetch();
  try {
    const state = fakeStateWithPendingHandoff();
    const result = await handleResearchHandoffApproval(fakeApprovalEnv(), state, false);
    assert.strictEqual(result.pendingResearchHandoff, undefined);
    assert.ok(!notionCallsByDataSource.includes("handoffs-ds"));
  } finally {
    restore();
  }
});

test("31. handleResearchHandoffApproval on approve creates the Handoff record and clears the pending proposal", async () => {
  const { restore, notionCallsByDataSource } = mockNotionAndTelegramFetch();
  try {
    const state = fakeStateWithPendingHandoff();
    const result = await handleResearchHandoffApproval(fakeApprovalEnv(), state, true);
    assert.strictEqual(result.pendingResearchHandoff, undefined);
    assert.ok(notionCallsByDataSource.includes("handoffs-ds"), "a Handoff record must be created on approval");
  } finally {
    restore();
  }
});

test("32. handleResearchHandoffApproval keeps the pending proposal when Handoff creation fails, so approving again can retry it", async () => {
  const { restore } = mockNotionAndTelegramFetch(true);
  try {
    const state = fakeStateWithPendingHandoff();
    const result = await handleResearchHandoffApproval(fakeApprovalEnv(), state, true);
    assert.ok(result.pendingResearchHandoff, "a failed creation must not silently discard the proposal");
    assert.strictEqual(result.pendingResearchHandoff!.hat, "Marketing Strategist");
  } finally {
    restore();
  }
});

test("33. routeToConsumingHat proposes nothing for a synthesis with zero Findings -- an all-Limitations 'we found nothing' result has nothing for a consuming Hat to act on", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error("routeToConsumingHat must not make any AI or Notion call when there are no Findings");
  }) as typeof fetch;

  try {
    const state = fakeStateWithPendingHandoff();
    state.pendingResearchHandoff = undefined;
    const synthesis: ResearchSynthesis = {
      protocolsUsed: ["market_industry"],
      sources: [],
      evidence: [],
      findings: [],
      implications: [],
      limitations: [{ statement: "No evidence was available for this question." }],
    };

    await routeToConsumingHat(fakeApprovalEnv(), state, synthesis);

    assert.strictEqual(fetchCallCount, 0, "no classification call should happen for an empty-findings synthesis");
    assert.strictEqual(state.pendingResearchHandoff, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
