import test from "node:test";
import assert from "node:assert";
import { applyEvidenceSourceValidationGate, findUnverifiableSources, validateSynthesis } from "./validation";
import type { EvidenceSynthesis } from "./validation";

function baseSynthesis(overrides: Partial<EvidenceSynthesis> = {}): EvidenceSynthesis {
  return {
    sources: [{ id: "s1", source: "Company website", sourceType: "primary", passage: "...", claimSupported: "pricing tier", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "Competitor X prices at $50/mo", sourceIds: ["s1"] }],
    findings: [{ id: "f1", statement: "Competitor X undercuts our entry tier", evidenceIds: ["e1"] }],
    implications: [{ statement: "Consider entry-tier repricing", basedOnFindingIds: ["f1"] }],
    limitations: [],
    ...overrides,
  };
}

test("a well-formed synthesis validates successfully", () => {
  const result = validateSynthesis(baseSynthesis());
  assert.strictEqual(result.valid, true);
});

test("a Finding with no supporting Evidence is rejected -- never silently turn an inference into a finding", () => {
  const result = validateSynthesis(
    baseSynthesis({ findings: [{ id: "f1", statement: "Unsupported conclusion", evidenceIds: [] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("cites no evidence"));
});

test("a Finding citing a nonexistent evidence id is rejected -- prevents fabricated citations", () => {
  const result = validateSynthesis(
    baseSynthesis({ findings: [{ id: "f1", statement: "Conclusion", evidenceIds: ["nonexistent"] }] }),
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
    baseSynthesis({ implications: [{ statement: "Unsupported implication", basedOnFindingIds: [] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("cites no underlying finding"));
});

test("an Implication referencing a nonexistent Finding id is rejected -- immune to positional drift when findings are omitted/reordered", () => {
  const result = validateSynthesis(
    baseSynthesis({ implications: [{ statement: "Implication", basedOnFindingIds: ["nonexistent"] }] }),
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes("references unknown finding id"));
});

test("a contradicted source's status is preserved through validation, not silently resolved to a convenient one", () => {
  const result = validateSynthesis(
    baseSynthesis({
      sources: [
        { id: "s1", source: "Vendor site", sourceType: "primary", passage: "claims $50/mo", claimSupported: "price", validationStatus: "validated" },
        { id: "s2", source: "Third-party review", sourceType: "secondary", passage: "reports $75/mo", claimSupported: "price", validationStatus: "contradicted" },
      ],
      evidence: [{ id: "e1", statement: "Sources disagree on Competitor X's price ($50 vs $75/mo)", sourceIds: ["s1", "s2"] }],
      findings: [{ id: "f1", statement: "Competitor X's pricing could not be confirmed with confidence", evidenceIds: ["e1"] }],
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

// --- Evidence & Source Validation: the mandatory cross-cutting gate ---

test("the gate passes a well-formed, fully grounded synthesis", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({
      sources: [{ id: "s1", source: "Acme Corp 2025 Annual Report", sourceType: "primary", passage: "...", claimSupported: "revenue", validationStatus: "validated" }],
    }),
    "Here is the Acme Corp 2025 Annual Report: revenue grew 12%.",
  );
  assert.strictEqual(gate.valid, true);
});

test("the gate rejects a Finding with no Evidence (Evidence -> Finding chain)", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({ findings: [{ id: "f1", statement: "Unsupported conclusion", evidenceIds: [] }] }),
    "context",
  );
  if (gate.valid) assert.fail("a finding without evidence must never pass the gate");
  assert.strictEqual(gate.failure, "invalid_synthesis");
  assert.ok(gate.reason?.includes("cites no evidence"));
});

test("the gate rejects Evidence with no Source (Evidence -> Source chain)", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({ evidence: [{ id: "e1", statement: "Unsourced claim", sourceIds: [] }] }),
    "context",
  );
  if (gate.valid) assert.fail("evidence without a source must never pass the gate");
  assert.strictEqual(gate.failure, "invalid_synthesis");
});

test("the gate rejects an Implication with no Finding (Finding -> Implication chain)", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({ implications: [{ statement: "Unsupported implication", basedOnFindingIds: [] }] }),
    "context",
  );
  if (gate.valid) assert.fail("an implication without a finding must never pass the gate");
  assert.strictEqual(gate.failure, "invalid_synthesis");
});

test("the gate rejects an unverifiable/fabricated source reference (provenance half)", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({
      sources: [{ id: "s1", source: "Company A Website", sourceType: "primary", url: "https://www.companya.com", passage: "...", claimSupported: "positioning", validationStatus: "unvalidated" }],
    }),
    "Research our main competitors and how they position themselves.",
  );
  if (gate.valid) assert.fail("a fabricated source must never pass the gate");
  assert.strictEqual(gate.failure, "unverifiable_sources");
  assert.strictEqual(gate.unverifiableSources[0].id, "s1");
});

test("the gate checks the citation contract before provenance -- structural failure is never reported as a provenance failure", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({
      sources: [{ id: "s1", source: "Never Seen Source", sourceType: "primary", passage: "...", claimSupported: "x", validationStatus: "unvalidated" }],
      findings: [{ id: "f1", statement: "Unsupported", evidenceIds: [] }],
    }),
    "unrelated context",
  );
  if (gate.valid) assert.fail("a synthesis failing both halves must fail the gate");
  assert.strictEqual(gate.failure, "invalid_synthesis");
});

test("the gate records evidence gaps/conflicts as limitations rather than dropping them -- an honest empty synthesis with an explicit limitation passes", () => {
  const gate = applyEvidenceSourceValidationGate(
    baseSynthesis({
      sources: [],
      evidence: [],
      findings: [],
      implications: [],
      limitations: [{ statement: "Coverage gap: no live source access available." }],
    }),
    "",
  );
  assert.strictEqual(gate.valid, true);
});
