import test from "node:test";
import assert from "node:assert";
import { findUnverifiableSources, validateSynthesis } from "./evidence";
import type { ResearchSynthesis } from "./evidence";

function baseSynthesis(overrides: Partial<ResearchSynthesis> = {}): ResearchSynthesis {
  return {
    protocolsUsed: ["competitive"],
    sources: [{ id: "s1", source: "Company website", sourceType: "primary", passage: "...", claimSupported: "pricing tier", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "Competitor X prices at $50/mo", sourceIds: ["s1"] }],
    findings: [{ statement: "Competitor X undercuts our entry tier", evidenceIds: ["e1"] }],
    implications: [{ statement: "Consider entry-tier repricing", basedOnFindingIndexes: [0] }],
    limitations: [],
    ...overrides,
  };
}

test("a well-formed synthesis validates successfully", () => {
  const result = validateSynthesis(baseSynthesis());
  assert.strictEqual(result.valid, true);
});

test("no protocol recorded fails closed", () => {
  const result = validateSynthesis(baseSynthesis({ protocolsUsed: [] }));
  assert.strictEqual(result.valid, false);
});

test("a Finding with no supporting Evidence is rejected -- never silently turn an inference into a finding", () => {
  const result = validateSynthesis(
    baseSynthesis({ findings: [{ statement: "Unsupported conclusion", evidenceIds: [] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("cites no evidence"));
});

test("a Finding citing a nonexistent evidence id is rejected -- prevents fabricated citations", () => {
  const result = validateSynthesis(
    baseSynthesis({ findings: [{ statement: "Conclusion", evidenceIds: ["nonexistent"] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("unknown evidence id"));
});

test("an Evidence item with no Source is rejected", () => {
  const result = validateSynthesis(
    baseSynthesis({ evidence: [{ id: "e1", statement: "Unsourced claim", sourceIds: [] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("cites no source"));
});

test("an Evidence item citing a nonexistent source id is rejected", () => {
  const result = validateSynthesis(
    baseSynthesis({ evidence: [{ id: "e1", statement: "Claim", sourceIds: ["missing-source"] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("unknown source id"));
});

test("an Implication with no underlying Finding is rejected", () => {
  const result = validateSynthesis(
    baseSynthesis({ implications: [{ statement: "Unsupported implication", basedOnFindingIndexes: [] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("cites no underlying finding"));
});

test("an Implication referencing an out-of-range Finding index is rejected", () => {
  const result = validateSynthesis(
    baseSynthesis({ implications: [{ statement: "Implication", basedOnFindingIndexes: [5] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("references a finding index that doesn't exist"));
});

test("a contradicted source's status is preserved through validation, not silently resolved to a convenient one", () => {
  const result = validateSynthesis(
    baseSynthesis({
      sources: [
        { id: "s1", source: "Vendor site", sourceType: "primary", passage: "claims $50/mo", claimSupported: "price", validationStatus: "validated" },
        { id: "s2", source: "Third-party review", sourceType: "secondary", passage: "reports $75/mo", claimSupported: "price", validationStatus: "contradicted" },
      ],
      evidence: [{ id: "e1", statement: "Sources disagree on Competitor X's price ($50 vs $75/mo)", sourceIds: ["s1", "s2"] }],
      findings: [{ statement: "Competitor X's pricing could not be confirmed with confidence", evidenceIds: ["e1"] }],
      implications: [],
      limitations: [{ statement: "Conflicting source data on pricing -- treat as unconfirmed." }],
    }),
  );
  assert.strictEqual(result.valid, true);
});

test("findUnverifiableSources flags a source whose name and URL never appeared in the supplied context -- the live fabrication case", () => {
  const synthesis = baseSynthesis({
    sources: [{ id: "s1", source: "Company A Website", sourceType: "primary", url: "https://www.companya.com", passage: "...", claimSupported: "positioning", validationStatus: "unvalidated" }],
  });
  const suppliedContext = "Research our main competitors and how they position themselves.";
  const unverifiable = findUnverifiableSources(synthesis, suppliedContext);
  assert.strictEqual(unverifiable.length, 1);
  assert.strictEqual(unverifiable[0].id, "s1");
});

test("findUnverifiableSources accepts a source whose name literally appears in the supplied context", () => {
  const synthesis = baseSynthesis({
    sources: [{ id: "s1", source: "Acme Corp 2025 Annual Report", sourceType: "primary", passage: "...", claimSupported: "revenue", validationStatus: "validated" }],
  });
  const suppliedContext = "Here is the Acme Corp 2025 Annual Report: revenue grew 12% year over year.";
  assert.strictEqual(findUnverifiableSources(synthesis, suppliedContext).length, 0);
});

test("findUnverifiableSources accepts a source whose URL literally appears in the supplied context", () => {
  const synthesis = baseSynthesis({
    sources: [{ id: "s1", source: "Vendor pricing page", sourceType: "primary", url: "https://example.com/pricing", passage: "...", claimSupported: "price", validationStatus: "unvalidated" }],
  });
  const suppliedContext = "Pricing is listed at https://example.com/pricing as $50/mo.";
  assert.strictEqual(findUnverifiableSources(synthesis, suppliedContext).length, 0);
});

test("findUnverifiableSources returns nothing for an honest empty-sources synthesis", () => {
  const synthesis = baseSynthesis({ sources: [], evidence: [], findings: [], implications: [] });
  assert.strictEqual(findUnverifiableSources(synthesis, "").length, 0);
});

test("an empty, honest synthesis (no sources available) validates when findings/evidence/implications are all empty", () => {
  const result = validateSynthesis(
    baseSynthesis({ sources: [], evidence: [], findings: [], implications: [], limitations: [{ statement: "No live source access available." }] }),
  );
  assert.strictEqual(result.valid, true);
});
