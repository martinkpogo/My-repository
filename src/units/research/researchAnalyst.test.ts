import test from "node:test";
import assert from "node:assert";
import { nameToProtocolId } from "./researchAnalyst";
import { RESEARCH_PROTOCOL_REGISTRY } from "./protocols";

/**
 * nameToProtocolId is the one piece of R&I's protocol-selection stage
 * genuinely testable as pure logic -- the classification call itself runs
 * live through aiJson, the same as every other Hat's AI-driven decision in
 * this codebase (Marketing/Sales/Finance have no dedicated execution-flow
 * tests either; only pure logic like relationships.ts and evidence.ts is
 * unit-tested). Execution coverage per protocol is exercised here by
 * resolving every one of the six canonical names back to its id.
 */

test("resolves every one of the six canonical protocol names to its id -- one test per protocol", () => {
  for (const id of Object.keys(RESEARCH_PROTOCOL_REGISTRY) as (keyof typeof RESEARCH_PROTOCOL_REGISTRY)[]) {
    assert.strictEqual(nameToProtocolId(RESEARCH_PROTOCOL_REGISTRY[id].name), id);
  }
});

test("resolves multiple distinct protocol names independently -- multi-protocol requests are not mutually exclusive", () => {
  assert.strictEqual(nameToProtocolId("Competitive Intelligence"), "competitive");
  assert.strictEqual(nameToProtocolId("Evidence & Source Validation"), "evidence_validation");
  // Both resolve to distinct ids from the same batch of names, unlike
  // Marketing's Hat selection, which resolves to exactly one Hat.
});

test("is tolerant of case and partial-name variance in model output", () => {
  assert.strictEqual(nameToProtocolId("competitive intelligence"), "competitive");
  assert.strictEqual(nameToProtocolId("Market/Industry Intelligence"), "market_industry");
});

test("returns null for a hallucinated or unrecognized protocol name -- never guesses a nearest neighbor", () => {
  assert.strictEqual(nameToProtocolId("Social Media Intelligence"), null);
  assert.strictEqual(nameToProtocolId(""), null);
});
