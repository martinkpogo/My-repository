import test from "node:test";
import assert from "node:assert";
import { extractAuthorizedContextSummary, isValidSafeContext } from "./safeContext";

// A faithful shape of the real canonical Notion page (ENIG HQ / 2. Units &
// Hats / Units / Research & Intelligence / "Research-Safe Consultancy
// Context"), trimmed to what these helpers actually key off of.
const REAL_SAFE_CONTEXT = `**Status:** Canonical
## Purpose
A controlled, sanitized description of the consultancy that the Research & Intelligence workspace is authorized to use when interpreting research questions and conducting external research.
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
- Communication
### Geographic Context
- Primary: Ghana
- Secondary: Africa
### Research Relevance
R&I may use this context to understand research relevant to markets, demand, competitors.
## Identity Protection
The R&I runtime must not be given or infer from this context:
- Consultancy name
- Founder or person names
- Client identities
- Proprietary methodologies
## External Research Boundary
- Do not include the organization's identity in external research queries unless explicitly authorized.
## Runtime Use
The authorized R&I execution context is: Research-Safe Consultancy Context + Research Question + Authorized Handoff Context.
## Governance Boundary
This page is the canonical source for the sanitized consultancy context supplied to R&I.`;

test("canonical safe context (real page shape) is recognized as valid", () => {
  assert.strictEqual(isValidSafeContext(REAL_SAFE_CONTEXT), true);
});

test("missing safe context fails closed", () => {
  assert.strictEqual(isValidSafeContext(null), false);
  assert.strictEqual(isValidSafeContext(undefined), false);
  assert.strictEqual(isValidSafeContext(""), false);
});

test("a too-short or gutted page fails closed rather than being trusted", () => {
  assert.strictEqual(isValidSafeContext("Business Category: consulting"), false);
});

test("unrelated content retrieved by mistake (e.g. a different governance page) fails closed", () => {
  const wrongPage = "## Universal Role Contract\nEvery Hat must follow the evidence rule and stop when ambiguous. ".repeat(3);
  assert.strictEqual(isValidSafeContext(wrongPage), false);
});

test("extractAuthorizedContextSummary returns only the Authorized Context section, excluding Identity Protection and Governance Boundary", () => {
  const summary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT);
  assert.ok(summary.includes("Business Category"));
  assert.ok(summary.includes("Ghana"));
  assert.ok(summary.includes("Strategy-led consultancy"));
  // Excluded: meta/policy sections, never sent into a research prompt.
  assert.ok(!summary.includes("Founder or person names"));
  assert.ok(!summary.includes("Governance Boundary"));
  assert.ok(!summary.includes("External Research Boundary"));
});

test("extractAuthorizedContextSummary never includes the word 'Purpose' section preceding Authorized Context", () => {
  const summary = extractAuthorizedContextSummary(REAL_SAFE_CONTEXT);
  assert.ok(!summary.includes("controlled, sanitized description"));
});
