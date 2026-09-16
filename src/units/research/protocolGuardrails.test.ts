import test from "node:test";
import assert from "node:assert";
import { applyProtocolSelectionGuardrails } from "./protocolGuardrails";

// The exact regression this file exists to prevent: a question fundamentally
// about market structure/demand, classified by the AI as only
// [Competitive Intelligence, Customer / Audience Intelligence] with Market /
// Industry Intelligence silently dropped.
const MARKET_QUESTION =
  "What is the market structure, demand, and growth for strategy, brand, and communications consulting in Ghana and Africa?";

test("1. Broad market question forces Market / Industry Intelligence in as primary even when the AI omitted it entirely", () => {
  const result = applyProtocolSelectionGuardrails(MARKET_QUESTION, ["competitive", "customer_audience"]);
  assert.strictEqual(result[0], "market_industry");
  assert.ok(result.includes("competitive"));
  assert.ok(result.includes("customer_audience"));
});

test("2. Market + competitor question can select Market / Industry plus Competitive Intelligence -- both retained, Market / Industry primary", () => {
  const result = applyProtocolSelectionGuardrails(
    "What is the market size, and who are the named competitors and how do they position?",
    ["market_industry", "competitive"],
  );
  assert.deepStrictEqual(result, ["market_industry", "competitive"]);
});

test("3. Buyer/customer question activates Customer / Audience Intelligence when the AI didn't select it", () => {
  const result = applyProtocolSelectionGuardrails("What do buyers in this category actually need and how do they perceive available options?", []);
  assert.ok(result.includes("customer_audience"));
});

test("4. Mixed research questions can activate multiple protocols simultaneously", () => {
  const result = applyProtocolSelectionGuardrails(
    "What is the market demand, who are the competitors, and what do customers say in reviews?",
    [],
  );
  assert.ok(result.includes("market_industry"));
  assert.ok(result.includes("competitive"));
  assert.ok(result.includes("customer_audience"));
  assert.strictEqual(result[0], "market_industry");
});

test("guardrails never remove a protocol the AI legitimately selected", () => {
  const result = applyProtocolSelectionGuardrails("A vague question with no strong signal.", ["business_company", "environmental_regulatory"]);
  assert.ok(result.includes("business_company"));
  assert.ok(result.includes("environmental_regulatory"));
});

test("a question with no protocol signal at all is left unchanged", () => {
  const result = applyProtocolSelectionGuardrails("Tell me something interesting.", ["business_company"]);
  assert.deepStrictEqual(result, ["business_company"]);
});

test("when the AI already selected market_industry but not first, the guardrail promotes it to primary", () => {
  const result = applyProtocolSelectionGuardrails(MARKET_QUESTION, ["competitive", "market_industry"]);
  assert.strictEqual(result[0], "market_industry");
  assert.strictEqual(result.length, 2);
});

test("a pure competitor question (no market-structure signal) does not force Market / Industry in -- guardrails are protocol-specific, not a blanket addition", () => {
  const result = applyProtocolSelectionGuardrails("Who are our direct competitors and what do their pricing pages show?", ["competitive"]);
  assert.ok(!result.includes("market_industry"));
});
