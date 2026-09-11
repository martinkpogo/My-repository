/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveMarketingCandidateRelationships,
  selectMarketingAmbiguityReasonCode,
} from "./relationships";

test("Single candidate resolves directly to that Hat", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist"]);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Marketing Strategist");
  assert.equal(result.relationshipId, undefined);
});

test("Two candidates with registered conditional relationship (establishing: true) resolves to upstream Hat", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist", "Content Strategist"], true);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Marketing Strategist");
  assert.equal(result.relationshipId, "REL_MS_CS");
});

test("Two candidates with registered conditional relationship (establishing: false) resolves to downstream Hat", () => {
  const result = resolveMarketingCandidateRelationships(["Marketing Strategist", "Content Strategist"], false);
  assert.equal(result.resolved, true);
  assert.equal(result.hat, "Content Strategist");
  assert.equal(result.relationshipId, "REL_MS_CS");
});

test("Two candidates with conditional relationship missing establishing flag fails closed with CONDITIONAL_ESTABLISHING_REQUIRED", () => {
  const result = resolveMarketingCandidateRelationships(["Content Strategist", "Content Manager"], undefined);
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

test("Unregistered candidate pair fails closed with NO_REGISTERED_RELATIONSHIP", () => {
  const result = resolveMarketingCandidateRelationships(["Brand & Communications Strategist", "Digital Marketer"], true);
  assert.equal(result.resolved, false);
  assert.equal(result.hat, undefined);
  assert.equal(result.reasonCode, "NO_REGISTERED_RELATIONSHIP");
  assert.equal(selectMarketingAmbiguityReasonCode(result), "NO_REGISTERED_RELATIONSHIP");
});

test("selectMarketingAmbiguityReasonCode maps null/undefined to CLASSIFICATION_FAILED", () => {
  assert.equal(selectMarketingAmbiguityReasonCode(null), "CLASSIFICATION_FAILED");
  assert.equal(selectMarketingAmbiguityReasonCode(undefined), "CLASSIFICATION_FAILED");
});
