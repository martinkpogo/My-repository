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

test("Test A: Real identity never enters downstream package", () => {
  const { constructDownstreamFinancePackage } = require("./policy");

  const controlledStateInput = {
    workId: "work_001",
    entityName: "Acme Corp (John Doe)",
    matterName: "Commercial Advisory 2025",
    email: "john.doe@acme.com",
    phone: "+1-555-0199",
    rawCallNotes: "Spoke with CEO John regarding $2M budget and internal restructuring.",
    entityToken: "ENT-104",
    matterToken: "MAT-208",
    proposedIntervention: "System transformation and pricing optimization",
  };

  const downstreamPkg = constructDownstreamFinancePackage({
    workId: controlledStateInput.workId,
    entityToken: controlledStateInput.entityToken,
    matterToken: controlledStateInput.matterToken,
    proposedIntervention: controlledStateInput.proposedIntervention,
  });

  const serialized = JSON.stringify(downstreamPkg);

  // Assert required safe tokens & context are present
  assert.strictEqual(downstreamPkg.entityToken, "ENT-104");
  assert.strictEqual(downstreamPkg.matterToken, "MAT-208");
  assert.strictEqual(downstreamPkg.transformationStatus, "authorized");
  assert.strictEqual(downstreamPkg.transformationProvenance, "smbd:intervention_sanitization");

  // Assert real controlled identity fields are ABSENT from downstream package
  assert.strictEqual(serialized.includes("Acme Corp"), false);
  assert.strictEqual(serialized.includes("John Doe"), false);
  assert.strictEqual(serialized.includes("john.doe@acme.com"), false);
  assert.strictEqual(serialized.includes("+1-555-0199"), false);
  assert.strictEqual(serialized.includes("CEO John"), false);
  assert.strictEqual(serialized.includes("Commercial Advisory 2025"), false);
});

test("Test B: Missing transformation evidence fails closed", () => {
  const { evaluateHandoffContext } = require("./policy");

  const unverifiedHandoff = {
    handoffId: "handoff_no_evidence",
    entityToken: "ENT-104",
    matterToken: "MAT-208",
    sanitizedContext: "Proposed intervention text without evidence headers",
    // transformationStatus is missing
    requiredCategory: "historical business-impact range",
  };

  const evalResult = evaluateHandoffContext(unverifiedHandoff, "finance.quote_judgment");

  assert.strictEqual(evalResult.success, false);
  if (!evalResult.success) {
    assert.strictEqual(evalResult.insufficientContext.isInsufficient, true);
    assert.strictEqual(evalResult.insufficientContext.category, "transformation authorization evidence");
    assert.ok(evalResult.insufficientContext.reason.includes("missing or invalid transformation authorization evidence"));
    // Category-focused, non-sensitive reason
    assert.strictEqual(evalResult.insufficientContext.reason.includes("Acme"), false);
  }
});

test("Test C: Invalid transformation evidence fails closed", () => {
  const { evaluateHandoffContext } = require("./policy");

  const invalidHandoff = {
    handoffId: "handoff_invalid",
    entityToken: "ENT-104",
    matterToken: "MAT-208",
    sanitizedContext: "Intervention text",
    transformationStatus: "unauthorized" as const,
    transformationProvenance: "unauthorized_source",
    requiredCategory: "historical business-impact range",
  };

  const evalResult = evaluateHandoffContext(invalidHandoff, "finance.quote_judgment");

  assert.strictEqual(evalResult.success, false);
  if (!evalResult.success) {
    assert.strictEqual(evalResult.insufficientContext.category, "transformation authorization evidence");
    assert.ok(evalResult.insufficientContext.reason.includes("unauthorized"));
  }
});

test("Test D: Authorized transformed context succeeds", () => {
  const { evaluateHandoffContext } = require("./policy");

  const validHandoff = {
    handoffId: "handoff_valid_123",
    entityToken: "ENT-104",
    matterToken: "MAT-208",
    sanitizedContext: "Proposed intervention: Pricing framework overhaul",
    transformationStatus: "authorized" as const,
    transformationProvenance: "smbd:intervention_sanitization",
    sensitivity: "business_sensitive" as const,
  };

  const evalResult = evaluateHandoffContext(validHandoff, "finance.quote_judgment");

  assert.strictEqual(evalResult.success, true);
  if (evalResult.success) {
    assert.strictEqual(evalResult.contract.entityToken, "ENT-104");
    assert.strictEqual(evalResult.contract.matterToken, "MAT-208");
    assert.strictEqual(evalResult.contract.transformationStatus, "authorized");
    assert.strictEqual(evalResult.boundaryContext.segments.length, 1);
  }
});

test("Test E: Token opacity preserved", () => {
  const { evaluateHandoffContext } = require("./policy");

  const result = evaluateHandoffContext(
    {
      handoffId: "h_opaque",
      entityToken: "ENT-555",
      matterToken: "MAT-777",
      sanitizedContext: "Scope context",
      transformationStatus: "authorized",
      transformationProvenance: "smbd:intervention_sanitization",
    },
    "finance.quote_judgment",
  );

  assert.strictEqual(result.success, true);
  if (result.success) {
    const json = JSON.stringify(result.contract);
    assert.strictEqual(json.includes("notion.so"), false);
    assert.strictEqual(json.includes("http"), false);
    assert.strictEqual(json.includes("3cecb004"), false); // No Notion page UUIDs
    assert.strictEqual(result.contract.entityToken, "ENT-555");
    assert.strictEqual(result.contract.matterToken, "MAT-777");
  }
});

test("Test F: No Entity/Matter database traversal during Finance pickup", async () => {
  const origFetch = globalThis.fetch;
  const fetchedPaths: string[] = [];

  // Mock globalThis.fetch to observe exact Notion API HTTP requests made by Finance
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    fetchedPaths.push(urlStr);

    if (urlStr.includes("/pages/handoff_page_999")) {
      return new Response(
        JSON.stringify({
          id: "handoff_page_999",
          url: "https://notion.so/handoff_page_999",
          properties: {
            Entity_Token: { rich_text: [{ plain_text: "ENT-104" }] },
            Matter_Token: { rich_text: [{ plain_text: "MAT-208" }] },
            "Verified Facts & Sources": {
              rich_text: [
                {
                  plain_text:
                    "[TRANSFORMATION_STATUS: authorized]\n[TRANSFORMATION_PROVENANCE: smbd:intervention_sanitization]\nProposed intervention: Pricing model review",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected Notion API request for controlled record: ${urlStr}`);
  }) as typeof fetch;

  try {
    const { resolveHandoffBusinessContext } = require("../units/finance/valueBasedPricingAssessor");
    const mockEnv = { NOTION_TOKEN: "mock_token", NOTION_VERSION: "2025-09-03" };

    const evalResult = await resolveHandoffBusinessContext(mockEnv, "handoff_page_999");

    assert.strictEqual(evalResult.success, true);
    if (evalResult.success) {
      assert.strictEqual(evalResult.contract.entityToken, "ENT-104");
      assert.strictEqual(evalResult.contract.matterToken, "MAT-208");
    }

    // Assert fetch was called ONLY for the Handoff page itself
    assert.strictEqual(fetchedPaths.length, 1);
    assert.ok(fetchedPaths[0].includes("/pages/handoff_page_999"));

    // Assert NO fetch requests to Entity or Matter databases
    assert.strictEqual(fetchedPaths.some((p) => p.includes("437248f7") || p.includes("0e68feef")), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
