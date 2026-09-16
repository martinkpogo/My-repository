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
