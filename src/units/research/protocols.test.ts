import test from "node:test";
import assert from "node:assert";
import { RESEARCH_PROTOCOL_IDS, RESEARCH_PROTOCOL_REGISTRY, isResearchProtocolId, researchProtocolDetail, researchProtocolSummaryList } from "./protocols";

test("registry contains exactly the six approved protocol ids", () => {
  const expected = ["business_company", "market_industry", "competitive", "customer_audience", "environmental_regulatory", "evidence_validation"];
  assert.strictEqual(RESEARCH_PROTOCOL_IDS.length, 6);
  for (const id of expected) {
    assert.ok(RESEARCH_PROTOCOL_IDS.includes(id as any));
    assert.ok(RESEARCH_PROTOCOL_REGISTRY[id as keyof typeof RESEARCH_PROTOCOL_REGISTRY].method);
  }
});

test("isResearchProtocolId accepts registered ids and rejects unknown ones", () => {
  assert.strictEqual(isResearchProtocolId("competitive"), true);
  assert.strictEqual(isResearchProtocolId("hallucinated_protocol"), false);
});

test("researchProtocolSummaryList includes every protocol name", () => {
  const summary = researchProtocolSummaryList();
  for (const id of RESEARCH_PROTOCOL_IDS) {
    assert.ok(summary.includes(RESEARCH_PROTOCOL_REGISTRY[id].name));
  }
});

test("researchProtocolDetail includes only the requested protocols, not all six", () => {
  const detail = researchProtocolDetail(["competitive"]);
  assert.ok(detail.includes("Competitive Intelligence"));
  assert.ok(!detail.includes("Market / Industry Intelligence"));
});

// --- Core Structure v2.4: the six canonical Procedure contracts as the Package consumes them ---

test("every Procedure carries the canonical contract fields (id, name, purpose, method, evidenceRequirements, interpretationConstraints)", () => {
  assert.strictEqual(RESEARCH_PROTOCOL_IDS.length, 6);
  for (const id of RESEARCH_PROTOCOL_IDS) {
    const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
    assert.strictEqual(procedure.id, id, `${id}: id must match its registry key`);
    assert.ok(procedure.name?.trim(), `${id}: name is required`);
    assert.ok(procedure.purpose?.trim(), `${id}: purpose is required`);
    assert.ok(procedure.method?.trim(), `${id}: method is required`);
    assert.ok(procedure.evidenceRequirements?.trim(), `${id}: evidenceRequirements is required`);
    assert.ok(Array.isArray(procedure.interpretationConstraints) && procedure.interpretationConstraints.length > 0, `${id}: interpretation constraints are required`);
  }
});

test("Procedure definitions are declarative data only -- no executable member that could become a second execution mechanism", () => {
  for (const id of RESEARCH_PROTOCOL_IDS) {
    for (const [field, value] of Object.entries(RESEARCH_PROTOCOL_REGISTRY[id])) {
      assert.ok(typeof value !== "function", `Procedure ${id}.${field} must be declarative data, never executable`);
    }
  }
});

test("the canonical per-Procedure distinctions are present in the runtime representation", () => {
  const registry = RESEARCH_PROTOCOL_REGISTRY;

  // Business / Company Research: named organisation, material business evidence, authoritative sources.
  assert.ok(registry.business_company.purpose.includes("named organisation"));
  assert.ok(registry.business_company.interpretationConstraints.some((c) => c.includes("specific organisation named in the question")));
  assert.ok(registry.business_company.evidenceRequirements.includes("Official company filings"));

  // Market / Industry Research: structure, dynamics, demand, benchmarks, growth, external forces, geography/time.
  for (const term of ["market structure", "industry dynamics", "demand conditions", "growth", "benchmarks", "external forces"]) {
    assert.ok(registry.market_industry.method.includes(term), `market method must cover ${term}`);
  }
  assert.ok(registry.market_industry.interpretationConstraints.some((c) => c.includes("geography and the time period")));

  // Competitive Research: observable competitors/substitutes/offers/positioning/pricing, traceable inference, no invented competitors.
  assert.ok(registry.competitive.interpretationConstraints.some((c) => c.includes("traceable to an observation")));
  assert.ok(registry.competitive.interpretationConstraints.some((c) => c.includes("Never name or invent a competitor")));
  assert.ok(registry.competitive.evidenceRequirements.includes("Observable competitor product pages"));

  // Customer / Audience Research: observation vs inference, no generalisation.
  assert.ok(registry.customer_audience.interpretationConstraints.some((c) => c.includes("Distinguish observation from inference")));
  assert.ok(registry.customer_audience.interpretationConstraints.some((c) => c.includes("generalise beyond the evidence")));

  // Environmental / Regulatory Research: jurisdiction, time period, proposed vs historical vs current.
  assert.ok(registry.environmental_regulatory.interpretationConstraints.some((c) => c.includes("jurisdiction and the time period")));
  assert.ok(registry.environmental_regulatory.interpretationConstraints.some((c) => c.includes("proposed, historical, and current")));

  // Evidence & Source Validation: must not claim the Package's universal gate.
  assert.ok(registry.evidence_validation.interpretationConstraints.some((c) => c.includes("does not replace the Package's universal Evidence & Source Validation gate")));
});

test("applicability/selection-relevant criteria are Procedure-owned data: only the three signal-bearing Procedures declare a signal, and only Market / Industry declares primary promotion", () => {
  const withSignals = RESEARCH_PROTOCOL_IDS.filter((id) => (RESEARCH_PROTOCOL_REGISTRY[id].applicabilitySignals ?? []).length > 0);
  assert.deepStrictEqual(withSignals, ["market_industry", "competitive", "customer_audience"]);

  const primary = RESEARCH_PROTOCOL_IDS.filter((id) => RESEARCH_PROTOCOL_REGISTRY[id].primaryWhenApplicable === true);
  assert.deepStrictEqual(primary, ["market_industry"]);
});

test("the selection stage consumes Procedure purpose; the plan/synthesis stages consume method + evidence requirements + constraints", () => {
  const summary = researchProtocolSummaryList();
  const detail = researchProtocolDetail(RESEARCH_PROTOCOL_IDS);
  for (const id of RESEARCH_PROTOCOL_IDS) {
    const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
    assert.ok(summary.includes(procedure.purpose), `${id}: purpose must drive selection`);
    assert.ok(detail.includes(procedure.method), `${id}: method must drive execution`);
    assert.ok(detail.includes(procedure.evidenceRequirements), `${id}: evidence requirements must drive execution`);
    for (const constraint of procedure.interpretationConstraints) {
      assert.ok(detail.includes(constraint), `${id}: constraints must reach execution`);
    }
  }
});
