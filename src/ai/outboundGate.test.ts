import test from "node:test";
import assert from "node:assert/strict";
import { classifyOutboundText, OutboundDataGateEvaluator, defaultOutboundDataGateEvaluator } from "./outboundGate";
import { AiPolicyExecutor } from "./policy";
import { aiJson, aiText } from "../ai";
import { AiProvider, AiTask, InfrastructureError, ProviderAdapterResult, ProviderId } from "./types";
import type { Env } from "../types";
import { DataBoundaryEvaluator, PRODUCTION_OUTBOUND_POLICY, OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS } from "../dataBoundary/policy";
import { SEMANTIC_TASK_REGISTRY } from "../dataBoundary/registry";
import type { SemanticTaskId } from "../dataBoundary/types";

// ---------------------------------------------------------------------------
// Standalone detector unit tests (scenarios 1-9 from the task, at the
// classifyOutboundText level -- no provider/executor plumbing needed here).
// ---------------------------------------------------------------------------

test("1. E-20 + MAT-20 + sanitized business context -> ALLOW", () => {
  const text = "Entity_Token: E-20\nMatter_Token: MAT-20\nStrategic problem: Inconsistent external presentation across channels.";
  const result = classifyOutboundText(text, false);
  assert.strictEqual(result.classification, "DEFINITELY_PERMITTED");
});

test("2. Normal business language with no identity indicators -> ALLOW", () => {
  const text =
    "The approved intervention focuses on a unified messaging framework and an enhanced digital presence. Expected outcomes include improved credibility with larger accounts and a reduction in inconsistent materials in circulation.";
  const result = classifyOutboundText(text, false);
  assert.strictEqual(result.classification, "DEFINITELY_PERMITTED");
});

test("3. Email address -> BLOCK", () => {
  const result = classifyOutboundText("Please follow up with the client at comfort@meridianfoods.com directly.", false);
  assert.strictEqual(result.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(result.reasonCategory, "EMAIL_DETECTED");
});

test("4. Phone number -> BLOCK", () => {
  const intl = classifyOutboundText("Reachable at +233 24 412 3456 during business hours.", false);
  assert.strictEqual(intl.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(intl.reasonCategory, "PHONE_DETECTED");

  const local = classifyOutboundText("Call the office on 0244123456 to confirm.", false);
  assert.strictEqual(local.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(local.reasonCategory, "PHONE_DETECTED");
});

test("5. Address/contact information -> BLOCK", () => {
  const street = classifyOutboundText("Deliver the samples to 123 Independence Avenue before Friday.", false);
  assert.strictEqual(street.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(street.reasonCategory, "ADDRESS_DETECTED");

  const poBox = classifyOutboundText("Mail can be sent to P.O. Box 4521, Accra.", false);
  assert.strictEqual(poBox.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(poBox.reasonCategory, "ADDRESS_DETECTED");
});

test("6. Person-name-shaped identity-bearing content with no email/phone -> UNCERTAIN/BLOCKED, not falsely ALLOWED", () => {
  const titled = classifyOutboundText("Please loop in Dr. Kwame Owusu on this before we proceed.", false);
  assert.notStrictEqual(titled.classification, "DEFINITELY_PERMITTED", "must not be falsely classified as safe merely because no email/phone exists");
  assert.strictEqual(titled.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(titled.reasonCategory, "TITLE_NAME_DETECTED");

  const labeled = classifyOutboundText("Name: Kwame Mensah\nRole: Operations lead", false);
  assert.notStrictEqual(labeled.classification, "DEFINITELY_PERMITTED");
  assert.strictEqual(labeled.reasonCategory, "NAME_FIELD_DETECTED");

  const contextual = classifyOutboundText("Spoke with Ama Boateng ahead of the renewal.", false);
  assert.notStrictEqual(contextual.classification, "DEFINITELY_PERMITTED");
  assert.strictEqual(contextual.reasonCategory, "CONTACT_CONTEXT_NAME_DETECTED");
});

test("7. Real company/entity identity in a TOKEN_SAFE_RUNTIME payload -> same fail-closed treatment", () => {
  const result = classifyOutboundText("Meridian Foods Ghana Ltd is pursuing larger retail accounts this quarter.", false);
  assert.notStrictEqual(result.classification, "DEFINITELY_PERMITTED");
  assert.strictEqual(result.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(result.reasonCategory, "COMPANY_SUFFIX_DETECTED");

  // Confirms the previous session's real, confirmed leak (HO-62's carried
  // Strategy content) would now be caught by this exact detector.
  const leak = classifyOutboundText("The description of Meridian Foods Ghana Ltd's size and capabilities is not always consistent.", false);
  assert.strictEqual(leak.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(leak.reasonCategory, "COMPANY_SUFFIX_DETECTED");
});

test("8. Mixed E-20 + real identity -> BLOCK", () => {
  const result = classifyOutboundText("Entity_Token: E-20. Please email jane.doe@example.com to confirm scope.", false);
  assert.strictEqual(result.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(result.reasonCategory, "EMAIL_DETECTED");

  const mixedCompany = classifyOutboundText("Entity_Token: MAT-20. Acme Foods Ghana Ltd confirmed the engagement scope.", false);
  assert.strictEqual(mixedCompany.classification, "DEFINITELY_PROHIBITED");
});

test("9. Unknown/unclassified content where token-safe status cannot be established -> BLOCK", () => {
  // An ambiguous labeled field this codebase's own generated content never
  // legitimately produces -- ambiguous, not a confident structural leak,
  // but still fails closed for TOKEN_SAFE_RUNTIME.
  const result = classifyOutboundText("Prepared for: Kofi Ansah, per the attached scope.", false);
  assert.strictEqual(result.classification, "UNRESOLVED_UNCERTAIN");
  assert.strictEqual(result.reasonCategory, "AMBIGUOUS_LABELED_FIELD_UNCERTAIN");
});

// ---------------------------------------------------------------------------
// The company-suffix exemption: legitimate public-source organisation
// names (Lead Discovery's own subject matter) are not blocked by the
// company-suffix detector specifically, but a discovered contact's direct
// details still are.
// ---------------------------------------------------------------------------

test("Public-source exemption: a real company name in the exempted task's payload is allowed by the company detector...", () => {
  const result = classifyOutboundText("[0] Title: Acme Corp expands into enterprise market\nURL: https://example.com/acme\nSnippet: Acme expansion news.", true);
  assert.strictEqual(result.classification, "DEFINITELY_PERMITTED");
});

test("...but a discovered contact's email/phone still blocks even for the exempted task", () => {
  const email = classifyOutboundText("Snippet: Acme Corp, reach the team at info@acme.com for details.", true);
  assert.strictEqual(email.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(email.reasonCategory, "EMAIL_DETECTED");
});

test("Non-exempted TOKEN_SAFE_RUNTIME task still blocks a company-suffix name", () => {
  const result = classifyOutboundText("Acme Corp is the approved intervention's subject.", false);
  assert.strictEqual(result.classification, "DEFINITELY_PROHIBITED");
  assert.strictEqual(result.reasonCategory, "COMPANY_SUFFIX_DETECTED");
});

// ---------------------------------------------------------------------------
// Every production task resolves to an explicit outbound policy (or is
// deliberately, verifiably absent -- fail closed).
// ---------------------------------------------------------------------------

test("Every registered SemanticTaskId either has a resolved outbound policy or is deliberately absent (blocked)", () => {
  const allTaskIds = Object.keys(SEMANTIC_TASK_REGISTRY) as SemanticTaskId[];
  assert.strictEqual(allTaskIds.length, 30);
  for (const id of allTaskIds) {
    const policy = PRODUCTION_OUTBOUND_POLICY[id];
    assert.ok(
      policy === "TOKEN_SAFE_RUNTIME" || policy === "IDENTITY_AUTHORIZED" || policy === undefined,
      `unexpected outbound policy value for ${id}: ${policy}`,
    );
  }
});

test("sales.enquiry_extraction is the only IDENTITY_AUTHORIZED production task", () => {
  const identityAuthorized = Object.entries(PRODUCTION_OUTBOUND_POLICY).filter(([, v]) => v === "IDENTITY_AUTHORIZED");
  assert.deepStrictEqual(identityAuthorized.map(([k]) => k), ["sales.enquiry_extraction"]);
});

test("Strategy tasks, Finance quote judgment, and ordinary Sales proposal drafting/revision are TOKEN_SAFE_RUNTIME", () => {
  for (const id of [
    "strategy.diagnosis",
    "strategy.handoff_routing",
    "strategy.proposal_drafting",
    "finance.quote_judgment",
    "sales.proposal_drafting",
    "sales.proposal_revision",
  ] as SemanticTaskId[]) {
    assert.strictEqual(PRODUCTION_OUTBOUND_POLICY[id], "TOKEN_SAFE_RUNTIME", id);
  }
});

test("Lead Discovery public-source tasks are TOKEN_SAFE_RUNTIME, and only the signal-evaluation task is company-suffix-exempt", () => {
  for (const id of [
    "lead.discovery_classification",
    "lead.discovery_signal_evaluation",
    "lead.discovery_ondemand_intake",
    "lead.discovery_ondemand_query_generation",
  ] as SemanticTaskId[]) {
    assert.strictEqual(PRODUCTION_OUTBOUND_POLICY[id], "TOKEN_SAFE_RUNTIME", id);
  }
  assert.ok(OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS.has("lead.discovery_signal_evaluation"));
  assert.strictEqual(OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS.size, 1, "the exemption is narrow, not blanket");
});

test("Raw pre-tokenization Sales tasks and the routing classifiers are deliberately unresolved (blocked), not mislabeled TOKEN_SAFE_RUNTIME", () => {
  for (const id of [
    "routing.enquiry_classification",
    "routing.marketing_specialization_check",
    "routing.research_specialization_check",
    "sales.matter_summary_drafting",
    "sales.call_prep_briefing",
    "sales.commercial_evidence_extraction",
    "sales.call_qualification",
  ] as SemanticTaskId[]) {
    assert.strictEqual(PRODUCTION_OUTBOUND_POLICY[id], undefined, id);
  }
});

// ---------------------------------------------------------------------------
// OutboundDataGateEvaluator: policy resolution, fail-closed unresolved.
// ---------------------------------------------------------------------------

test("10. IDENTITY_AUTHORIZED policy does not block identity-bearing content merely because it is identity-bearing", () => {
  const gate = new OutboundDataGateEvaluator({ taskOutboundPolicy: { "sales.enquiry_extraction": "IDENTITY_AUTHORIZED" } });
  const result = gate.evaluate("sales.enquiry_extraction", "workers-ai", [
    { role: "user", content: "From: Jane Doe <jane.doe@meridianfoods.com>. We'd like a proposal for our branding refresh." },
  ]);
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.reasonCategory, "IDENTITY_AUTHORIZED_TASK");
  // No current production task is IDENTITY_AUTHORIZED merely by being
  // Sales-related -- confirm the production table doesn't grant it broadly.
  assert.strictEqual(PRODUCTION_OUTBOUND_POLICY["sales.call_qualification"], undefined);
  assert.strictEqual(PRODUCTION_OUTBOUND_POLICY["sales.matter_summary_drafting"], undefined);
});

test("An unregistered task ID fails closed at the gate", () => {
  const result = defaultOutboundDataGateEvaluator.evaluate("not.a.real.task" as SemanticTaskId, "workers-ai", [{ role: "user", content: "hi" }]);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCategory, "UNREGISTERED_TASK_ID");
});

test("A registered task with no resolved outbound policy fails closed", () => {
  const result = defaultOutboundDataGateEvaluator.evaluate("routing.enquiry_classification", "workers-ai", [
    { role: "user", content: "We're a bakery chain and our branding feels dated, can you help?" },
  ]);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reasonCategory, "NO_RESOLVED_OUTBOUND_POLICY");
  assert.strictEqual(result.policy, "UNRESOLVED");
});

test("Audit result never carries the detected payload content -- metadata only", () => {
  const secret = "Contact jane.doe@meridianfoods.com about Meridian Foods Ghana Ltd's renewal.";
  const result = defaultOutboundDataGateEvaluator.evaluate("strategy.diagnosis", "workers-ai", [{ role: "user", content: secret }]);
  assert.strictEqual(result.allowed, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("jane.doe"), "audit result must never include the detected email");
  assert.ok(!serialized.includes("Meridian"), "audit result must never include the detected company name");
  assert.strictEqual(result.taskId, "strategy.diagnosis");
  assert.strictEqual(result.providerId, "workers-ai");
  assert.ok(result.reasonCategory);
  assert.ok(result.detectorClassification);
});

// ---------------------------------------------------------------------------
// Full integration through AiPolicyExecutor.executeTask, mirroring
// ai/policy.test.ts's own MockProvider pattern -- scenarios 11-14.
// ---------------------------------------------------------------------------

class MockProvider implements AiProvider {
  public attempts = 0;
  public executedMessages: string[] = [];
  constructor(
    public readonly id: ProviderId,
    private readonly handler: (task: AiTask) => ProviderAdapterResult,
    private readonly eligible: boolean = true,
  ) {}
  public isEligible(_env: Env, _task: AiTask): boolean {
    return this.eligible;
  }
  public async execute(_env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    this.attempts++;
    this.executedMessages.push(task.messages.map((m) => m.content).join("\n"));
    return this.handler(task);
  }
}

const fakeEnv = {} as Env;

const permissiveBoundaryEvaluator = new DataBoundaryEvaluator({
  taskSensitivities: { "strategy.diagnosis": "business_sensitive", "sales.enquiry_extraction": "pii_restricted" },
  providerEligibility: {
    p1: { providerId: "p1", allowedSensitivities: new Set(["business_sensitive", "pii_restricted"]) },
    p2: { providerId: "p2", allowedSensitivities: new Set(["business_sensitive", "pii_restricted"]) },
  },
});

test("11. Approved Finance/Strategy-shaped TOKEN_SAFE_RUNTIME content reaches the provider end to end", async () => {
  const p1 = new MockProvider("p1", () => ({ success: true, response: { rawText: '{"ok":true}' } }));
  const executor = new AiPolicyExecutor([p1], permissiveBoundaryEvaluator);

  const res = await aiJson(
    fakeEnv,
    { taskId: "strategy.diagnosis", system: "Diagnose the situation.", user: "Entity_Token: E-20. Strategic problem: inconsistent presentation." },
    executor,
  );

  assert.deepEqual(res, { ok: true });
  assert.strictEqual(p1.attempts, 1);
});

test("12. A provider fallback must not bypass the gate -- every attempt is checked, and a leaked payload blocks every provider", async () => {
  const p1 = new MockProvider("p1", () => ({ success: false, error: new InfrastructureError("p1", "timeout") }));
  const p2 = new MockProvider("p2", () => ({ success: true, response: { rawText: '{"ok":true}' } }));
  const executor = new AiPolicyExecutor([p1, p2], permissiveBoundaryEvaluator);

  const res = await aiJson(
    fakeEnv,
    { taskId: "strategy.diagnosis", system: "Diagnose the situation.", user: "Contact jane.doe@meridianfoods.com about the renewal." },
    executor,
  );

  assert.strictEqual(res, null, "the leaked payload must be blocked, not silently sent to the fallback provider");
  assert.strictEqual(p1.attempts, 0, "p1's execute() must never run for blocked content");
  assert.strictEqual(p2.attempts, 0, "p2's execute() must never run either -- fallback does not bypass the gate");
});

test("13. The gate runs on the final effective/transformed messages, not the original pre-transformation messages", async () => {
  const transformingEvaluator = new DataBoundaryEvaluator({
    taskSensitivities: { "strategy.diagnosis": "internal" },
    // p1 is NOT eligible for "internal" directly -- this forces every
    // segment through the transformation below, so the gate is proven to
    // see its OUTPUT, not the pre-transform segment.
    providerEligibility: { p1: { providerId: "p1", allowedSensitivities: new Set(["business_sensitive"]) } },
    transformations: [
      {
        id: "inject-leak",
        canTransform: (segment) => segment.sensitivity === "internal",
        transform: (segment) => ({
          success: true,
          // Simulates a transformation step introducing identity-bearing
          // content into the EFFECTIVE message -- the gate must catch this
          // even though the ORIGINAL pre-transform text was clean.
          transformedSegment: { ...segment, content: `${segment.content} Contact jane.doe@meridianfoods.com for details.` },
        }),
      },
    ],
  });
  const p1 = new MockProvider("p1", () => ({ success: true, response: { rawText: "clean original text, no leak here" } }));
  const executor = new AiPolicyExecutor([p1], transformingEvaluator);

  const res = await aiText(fakeEnv, "strategy.diagnosis", "Diagnose.", "Entity_Token: E-20. Clean, sanitized business context.", {}, executor);

  assert.strictEqual(res, "", "the transformed (post-transform) content carries the leak and must be blocked even though the ORIGINAL user text was clean");
  assert.strictEqual(p1.attempts, 0);
});

test("14. No provider's execute() is called when the gate blocks", async () => {
  const p1 = new MockProvider("p1", () => ({ success: true, response: { rawText: "should never run" } }));
  const p2 = new MockProvider("p2", () => ({ success: true, response: { rawText: "should never run either" } }));
  const executor = new AiPolicyExecutor([p1, p2], permissiveBoundaryEvaluator);

  await aiText(fakeEnv, "strategy.diagnosis", "Diagnose.", "Meridian Foods Ghana Ltd needs a repositioning plan.", {}, executor);

  assert.strictEqual(p1.attempts, 0);
  assert.strictEqual(p2.attempts, 0);
});

test("IDENTITY_AUTHORIZED task (sales.enquiry_extraction) is allowed to reach the provider with identity-bearing content, unlike a TOKEN_SAFE_RUNTIME task with the same content", async () => {
  const p1 = new MockProvider("p1", () => ({ success: true, response: { rawText: '{"name":"Jane Doe","email":"jane.doe@meridianfoods.com"}' } }));
  const executor = new AiPolicyExecutor([p1], permissiveBoundaryEvaluator);

  const res = await aiJson(
    fakeEnv,
    { taskId: "sales.enquiry_extraction", system: "Extract sender details.", user: "From: Jane Doe <jane.doe@meridianfoods.com>." },
    executor,
  );

  assert.deepEqual(res, { name: "Jane Doe", email: "jane.doe@meridianfoods.com" });
  assert.strictEqual(p1.attempts, 1);
});

// ---------------------------------------------------------------------------
// 11. Existing ENIG/Martin redaction behavior remains intact alongside the
// new gate (both run, in order, before execute()).
// ---------------------------------------------------------------------------

test("11b. Existing identity-redaction (ENIG/Martin) still runs, upstream of and independent from the new gate", async () => {
  const p1 = new MockProvider("p1", () => ({ success: true, response: { rawText: "ok" } }));
  const executor = new AiPolicyExecutor([p1], permissiveBoundaryEvaluator);

  await aiText(fakeEnv, "strategy.diagnosis", "You represent ENIG.", "Martin's own internal note: proceed with the review.", {}, executor);

  assert.strictEqual(p1.attempts, 1, "redacted, token-safe content must still reach the provider");
  const sent = p1.executedMessages[0];
  assert.ok(!sent.includes("ENIG"), "ENIG must still be redacted");
  assert.ok(!sent.includes("Martin"), "Martin must still be redacted");
  assert.ok(sent.includes("the business"));
  assert.ok(sent.includes("the operator"));
});
