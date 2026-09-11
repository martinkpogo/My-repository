/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REGISTERED_MARKETING_RELATIONSHIPS,
  resolveMarketingCandidateRelationships,
  selectMarketingAmbiguityReasonCode,
} from "./relationships";

test("REGISTERED_MARKETING_RELATIONSHIPS contains exactly the five unique approved IDs", () => {
  const ids = REGISTERED_MARKETING_RELATIONSHIPS.map((r) => r.id);
  const expected = [
    "brand-communications-strategist__positioning",
    "content-strategist__brand-guidance",
    "content-manager__content-strategy",
    "digital-marketer__overall-marketing-strategy",
    "digital-marketer__strategic-channel-mix",
  ];
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 5);
});

test("Single candidate resolves directly to that Hat", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist"]);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Marketing Strategist");
  assert.equal(result.relationshipId, undefined);
});

test("Unconditional relationship 1: Brand & Communications Strategist positioning from Marketing Strategist", () => {
  const result = resolveMarketingCandidateRelationships([
    "Marketing Strategist",
    "Brand & Communications Strategist",
  ]);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Brand & Communications Strategist");
  assert.equal(result.relationshipId, "brand-communications-strategist__positioning");
});

test("Unconditional relationship 2: Content Strategist brand guidance from Brand & Communications Strategist", () => {
  const result = resolveMarketingCandidateRelationships([
    "Brand & Communications Strategist",
    "Content Strategist",
  ]);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Content Strategist");
  assert.equal(result.relationshipId, "content-strategist__brand-guidance");
});

test("Unconditional relationship 3: Content Manager content strategy from Content Strategist", () => {
  const result = resolveMarketingCandidateRelationships(["Content Strategist", "Content Manager"]);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Content Manager");
  assert.equal(result.relationshipId, "content-manager__content-strategy");
});

test("The two Digital Marketer -> Marketing Strategist conditional relationships exist independently in registry", () => {
  const dmRels = REGISTERED_MARKETING_RELATIONSHIPS.filter(
    (r) => r.from === "Marketing Strategist" && r.to === "Digital Marketer",
  );
  assert.equal(dmRels.length, 2);
  assert.equal(dmRels[0].id, "digital-marketer__overall-marketing-strategy");
  assert.equal(dmRels[1].id, "digital-marketer__strategic-channel-mix");
  assert.equal(dmRels[0].conditional, true);
  assert.equal(dmRels[1].conditional, true);
  assert.notEqual(dmRels[0].description, dmRels[1].description);
});

test("Conditional relationships do not resolve Marketing Strategist when establishing is false", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist", "Digital Marketer"], false);
  // Conditional relationship to Marketing Strategist is inactive when establishing === false;
  // Marketing Strategist (upstream) is NOT resolved.
  assert.notEqual(result.hat, "Marketing Strategist");
});

test("Active conditional relationship resolves Marketing Strategist when establishing is true", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist", "Digital Marketer"], true);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Marketing Strategist");
  assert.equal(
    result.relationshipId,
    "digital-marketer__overall-marketing-strategy,digital-marketer__strategic-channel-mix",
  );
});

test("Active relationships pointing to different upstream Hats fail closed with MULTIPLE_CONFLICTING_RELATIONSHIPS", () => {
  const result = resolveMarketingCandidateRelationships(
    ["Marketing Strategist", "Brand & Communications Strategist", "Content Strategist"],
    true,
  );
  assert.equal(result.resolved, false);
  assert.equal(result.reasonCode, "MULTIPLE_CONFLICTING_RELATIONSHIPS");
});

test("Hallucinated or unregistered relationship ID is inert and does not affect resolution", () => {
  const result = resolveMarketingCandidateRelationships(["Brand & Communications Strategist", "Digital Marketer"], true);
  assert.equal(result.resolved, false);
  assert.equal(result.reasonCode, "NO_REGISTERED_RELATIONSHIP");
  assert.equal(result.relationshipId, undefined);
});

test("Missing establishing flag for a conditional relationship fails closed with CONDITIONAL_ESTABLISHING_REQUIRED", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist", "Digital Marketer"], undefined);
  assert.equal(result.resolved, false);
  assert.equal(result.hat, undefined);
  assert.equal(result.reasonCode, "CONDITIONAL_ESTABLISHING_REQUIRED");
  assert.equal(selectMarketingAmbiguityReasonCode(result), "CONDITIONAL_ESTABLISHING_REQUIRED");
});

test("Empty candidate list fails closed with NO_PLAUSIBLE_HATS", () => {
  const result = resolveMarketingCandidateRelationships([]);
  assert.equal(result.resolved, false);
  assert.equal(result.hat, undefined);
  assert.equal(result.reasonCode, "NO_PLAUSIBLE_HATS");
  assert.equal(selectMarketingAmbiguityReasonCode(result), "NO_PLAUSIBLE_HATS");
});

test("selectMarketingAmbiguityReasonCode maps null/undefined to CLASSIFICATION_FAILED", () => {
  assert.equal(selectMarketingAmbiguityReasonCode(null), "CLASSIFICATION_FAILED");
  assert.equal(selectMarketingAmbiguityReasonCode(undefined), "CLASSIFICATION_FAILED");
});
