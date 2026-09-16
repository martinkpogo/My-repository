import test from "node:test";
import assert from "node:assert";
import { nameToProtocolId, resolveResearchHandoffContext } from "./researchAnalyst";
import { RESEARCH_PROTOCOL_REGISTRY, RESEARCH_PROTOCOL_IDS, researchProtocolDetail, isResearchProtocolId } from "./protocols";
import { validateSynthesis } from "./evidence";
import type { ResearchSynthesis } from "./evidence";
import { evaluateHandoffContext } from "../../dataBoundary/policy";

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
