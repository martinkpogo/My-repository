import test from "node:test";
import assert from "node:assert";
import { SEMANTIC_TASK_REGISTRY, isSemanticTaskId } from "./registry";
import { DataBoundaryEvaluator, createBoundaryAuditEntry, defaultDataBoundaryEvaluator } from "./policy";
import type { BoundaryContext, DataTransformation, SemanticTaskId, TransformationResult } from "./types";

test("1. Validates all 12 semantic task IDs in SEMANTIC_TASK_REGISTRY", () => {
  const expectedTaskIds: SemanticTaskId[] = [
    "routing.enquiry_classification",
    "routing.marketing_specialization_check",
    "chat.general_reply",
    "marketing.intake_classification",
    "marketing.hat_action_decision",
    "sales.enquiry_extraction",
    "sales.matter_summary_drafting",
    "sales.call_prep_briefing",
    "sales.call_qualification",
    "sales.proposal_drafting",
    "sales.proposal_revision",
    "finance.quote_judgment",
  ];

  assert.strictEqual(Object.keys(SEMANTIC_TASK_REGISTRY).length, 12);
  for (const id of expectedTaskIds) {
    assert.strictEqual(isSemanticTaskId(id), true);
    assert.ok(SEMANTIC_TASK_REGISTRY[id]);
    assert.ok(SEMANTIC_TASK_REGISTRY[id].name);
    assert.ok(SEMANTIC_TASK_REGISTRY[id].description);
  }
});

test("2. Fails closed when task ID is missing or unregistered", () => {
  const evaluator = new DataBoundaryEvaluator();
  const dummyContext: BoundaryContext = {
    segments: [{ type: "user", content: "test", provenance: "test.ts" }],
  };

  const result = evaluator.evaluate("invalid_task_id" as any, "workers-ai", dummyContext);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCode, "UNREGISTERED_TASK_ID");
});

test("3. Fails closed under unresolved production policy maps (UNRESOLVED_POLICY_HOLD)", () => {
  // Production evaluator uses default empty policy maps
  const dummyContext: BoundaryContext = {
    segments: [{ type: "user", content: "test", provenance: "test.ts" }],
  };

  const result = defaultDataBoundaryEvaluator.evaluate("finance.quote_judgment", "workers-ai", dummyContext);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCode, "UNRESOLVED_POLICY_HOLD");
});

test("4. Evaluates allowed vs disallowed boundary decisions using isolated test fixtures", () => {
  const testEvaluator = new DataBoundaryEvaluator({
    taskSensitivities: {
      "chat.general_reply": "public",
      "finance.quote_judgment": "business_sensitive",
    },
    providerEligibility: {
      "workers-ai": {
        providerId: "workers-ai",
        allowedSensitivities: new Set(["public"]),
      },
      "secure-private-provider": {
        providerId: "secure-private-provider",
        allowedSensitivities: new Set(["public", "business_sensitive"]),
      },
    },
  });

  const publicContext: BoundaryContext = {
    segments: [{ type: "user", content: "Hello world", provenance: "chat", sensitivity: "public" }],
  };

  const sensitiveContext: BoundaryContext = {
    segments: [{ type: "user", content: "Confidential financial data", provenance: "finance", sensitivity: "business_sensitive" }],
  };

  // Allowed: public task on public-eligible provider
  const res1 = testEvaluator.evaluate("chat.general_reply", "workers-ai", publicContext);
  assert.strictEqual(res1.allowed, true);
  assert.strictEqual(res1.reasonCode, "ALLOWED");

  // Disallowed: business_sensitive task on workers-ai (only public allowed)
  const res2 = testEvaluator.evaluate("finance.quote_judgment", "workers-ai", sensitiveContext);
  assert.strictEqual(res2.allowed, false);
  assert.strictEqual(res2.reasonCode, "SENSITIVITY_DISALLOWED");

  // Allowed: business_sensitive task on secure-private-provider
  const res3 = testEvaluator.evaluate("finance.quote_judgment", "secure-private-provider", sensitiveContext);
  assert.strictEqual(res3.allowed, true);
  assert.strictEqual(res3.reasonCode, "ALLOWED");
});

test("5. Verifies transformation failure/insufficiency explicitly fails closed without exposing original context", () => {
  const failingTransformer: DataTransformation = {
    id: "failing-transformer",
    canTransform: (segment) => segment.sensitivity === "business_sensitive",
    transform: (): TransformationResult => ({
      success: false,
      reason: "Redaction engine unavailable",
    }),
  };

  const testEvaluator = new DataBoundaryEvaluator({
    taskSensitivities: {
      "finance.quote_judgment": "business_sensitive",
    },
    providerEligibility: {
      "workers-ai": {
        providerId: "workers-ai",
        allowedSensitivities: new Set(["public"]),
      },
    },
    transformations: [failingTransformer],
  });

  const sensitiveContext: BoundaryContext = {
    segments: [
      { type: "user", content: "Secret budget $500k", provenance: "quote", sensitivity: "business_sensitive" },
    ],
  };

  const result = testEvaluator.evaluate("finance.quote_judgment", "workers-ai", sensitiveContext);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCode, "TRANSFORMATION_FAILED");
  assert.strictEqual(result.transformedContext, undefined);
});

test("6. Verifies fallback provider re-evaluation enforces boundary policy independently", () => {
  const testEvaluator = new DataBoundaryEvaluator({
    taskSensitivities: {
      "sales.proposal_drafting": "business_sensitive",
    },
    providerEligibility: {
      "primary-secure-provider": {
        providerId: "primary-secure-provider",
        allowedSensitivities: new Set(["business_sensitive"]),
      },
      "fallback-public-provider": {
        providerId: "fallback-public-provider",
        allowedSensitivities: new Set(["public"]),
      },
    },
  });

  const context: BoundaryContext = {
    segments: [{ type: "user", content: "Proposal text", provenance: "proposal", sensitivity: "business_sensitive" }],
  };

  // Primary provider is boundary eligible
  const primaryEval = testEvaluator.evaluate("sales.proposal_drafting", "primary-secure-provider", context);
  assert.strictEqual(primaryEval.allowed, true);

  // Fallback provider is boundary INELIGIBLE and must be rejected independently
  const fallbackEval = testEvaluator.evaluate("sales.proposal_drafting", "fallback-public-provider", context);
  assert.strictEqual(fallbackEval.allowed, false);
  assert.strictEqual(fallbackEval.reasonCode, "SENSITIVITY_DISALLOWED");
});

test("7. Verifies audit log entries contain zero prompt or sensitive payload text", () => {
  const secretContent = "TOP_SECRET_FINANCIAL_PROJECTION_2025_$10,000,000";
  const context: BoundaryContext = {
    segments: [
      { type: "system", content: "You are finance AI", provenance: "system_prompt", sensitivity: "internal" },
      { type: "user", content: secretContent, provenance: "user_input", sensitivity: "business_sensitive" },
    ],
  };

  const auditEntry = createBoundaryAuditEntry("finance.quote_judgment", "workers-ai", "BOUNDARY_EVALUATION", {
    allowed: false,
    reasonCode: "SENSITIVITY_DISALLOWED",
    context,
  });

  const JSONString = JSON.stringify(auditEntry);

  // Assert secret string does NOT appear anywhere in the audit entry
  assert.strictEqual(JSONString.includes("TOP_SECRET"), false);
  assert.strictEqual(JSONString.includes("10,000,000"), false);
  assert.strictEqual(JSONString.includes("You are finance AI"), false);

  // Assert metadata IS present
  assert.strictEqual(auditEntry.taskId, "finance.quote_judgment");
  assert.strictEqual(auditEntry.providerId, "workers-ai");
  assert.strictEqual(auditEntry.segmentMetadata.length, 2);
  assert.strictEqual(auditEntry.segmentMetadata[1].charCount, secretContent.length);
  assert.strictEqual(auditEntry.segmentMetadata[1].provenance, "user_input");
  assert.strictEqual(auditEntry.segmentMetadata[1].sensitivity, "business_sensitive");
});
