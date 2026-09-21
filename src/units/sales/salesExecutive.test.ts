import test from "node:test";
import assert from "node:assert/strict";
import { handleInterventionText, handleQuoteReceived, handleLeadToProspectApproval } from "./salesExecutive";
import type { WorkState, Env } from "../../types";

function fakeEnv(): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any,
    } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
  };
}

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work_se_1",
    chatId: 1,
    unit: "Sales",
    hat: "Sales Executive",
    stage: "awaiting_intervention",
    awaiting: "intervention",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entityId: "entity-page-1",
    entityName: "Acme Co",
    matterId: "matter-page-1",
    matterName: "Acme Co — Positioning",
    enquiryText: "We're a bakery chain and our branding feels dated, can you help?",
    entryType: "inbound_enquiry",
    ...overrides,
  };
}

interface FetchLog {
  handoffCreateBody: any;
  matterUpdateBody: any;
  sentTexts: string[];
}

function mockFetch(t: any, opts: { entityUniqueId?: number; matterUniqueId?: number } = {}): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = { handoffCreateBody: null, matterUpdateBody: null, sentTexts: [] };
  const entityUniqueId = opts.entityUniqueId ?? 47;
  const matterUniqueId = opts.matterUniqueId ?? 12;

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      log.sentTexts.push(body.text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }

    if (urlStr.endsWith("/pages/entity-page-1") && method === "GET") {
      return new Response(
        JSON.stringify({ id: "entity-page-1", url: "https://notion.so/entity-page-1", properties: { "Entity ID": { unique_id: { number: entityUniqueId, prefix: "E" } } } }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "GET") {
      return new Response(
        JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", properties: { Matter_ID: { unique_id: { number: matterUniqueId, prefix: "M" } } } }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "PATCH") {
      log.matterUpdateBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        log.handoffCreateBody = body;
        return new Response(JSON.stringify({ id: "handoff-page-1", url: "https://notion.so/handoff-page-1", properties: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", properties: {} }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return log;
}

function handoffProps(log: FetchLog): Record<string, any> {
  return log.handoffCreateBody.properties;
}

function richTextValue(prop: any): string {
  return prop?.rich_text?.[0]?.text?.content ?? "";
}

test("1. Inbound enquiry -> valid Sales -> Finance Handoff via the existing queue", async (t) => {
  const log = mockFetch(t);
  const state = fakeState({ entryType: "inbound_enquiry" });

  const result = await handleInterventionText(fakeEnv(), state, "Rebrand the storefront and packaging.");

  assert.ok(log.handoffCreateBody, "a Handoff must be created");
  const props = handoffProps(log);
  assert.strictEqual(props["From Unit"].select.name, "Sales");
  assert.strictEqual(props["From Hat"].rich_text[0].text.content, "Sales Executive");
  assert.strictEqual(props["To Unit"].select.name, "Finance");
  assert.strictEqual(props["To Hat"].rich_text[0].text.content, "Value-Based Pricing Assessor");
  assert.strictEqual(props.Type.select.name, "Work");
  assert.strictEqual(props.Status.select.name, "Pending");
  assert.match(richTextValue(props.Reason), /inbound_enquiry/);
  assert.ok(props.Entity_Token, "Entity_Token must be present");
  assert.ok(props.Matter_Token, "Matter_Token must be present");
  assert.ok(props["Required Next Action"], "Required Next Action must be carried");
  assert.ok(props["Acceptance Criteria"], "Acceptance Criteria must be carried");
  assert.ok(props["Expected Output"]);
  assert.ok(props.Assumptions);
  assert.ok(props["Verified Facts & Sources"]);
  assert.strictEqual(result.handoffId, "handoff-page-1");
  assert.strictEqual(result.stage, "awaiting_quote");
});

test("2. Outbound outreach -> valid Sales -> Finance Handoff carrying entry_type", async (t) => {
  const log = mockFetch(t);
  const state = fakeState({ entryType: "outbound_outreach", enquiryText: undefined, callNotes: "Proactive outreach call: prospect confirmed a positioning gap and wants a scoped engagement." });

  await handleInterventionText(fakeEnv(), state, "Reposition the brand narrative across all channels.");

  assert.ok(log.handoffCreateBody, "a Handoff must be created for an outbound-outreach-originated work item too");
  const props = handoffProps(log);
  assert.match(richTextValue(props.Reason), /outbound_outreach/);
});

test("3. Missing entry_type fails closed -- no Handoff created, Blocker logged", async (t) => {
  const log = mockFetch(t);
  const state = fakeState({ entryType: undefined });

  const result = await handleInterventionText(fakeEnv(), state, "Rebrand the storefront and packaging.");

  assert.strictEqual(log.handoffCreateBody, null, "must not create a Handoff without a valid entry_type");
  assert.ok(log.sentTexts.some((t) => /entry type/i.test(t)));
  assert.strictEqual(result.handoffId, undefined);
});

test("4. Missing proposed intervention (empty/whitespace text) fails closed", async (t) => {
  const log = mockFetch(t);
  const state = fakeState();

  const result = await handleInterventionText(fakeEnv(), state, "   ");

  assert.strictEqual(log.handoffCreateBody, null, "must not create a Handoff with no proposed intervention");
  assert.ok(log.sentTexts.some((t) => /what's the proposed intervention/i.test(t)));
  assert.strictEqual(result.handoffId, undefined);
});

test("5. Missing required value-relevant context (no enquiry text, no call notes) fails closed", async (t) => {
  const log = mockFetch(t);
  const state = fakeState({ enquiryText: undefined, callNotes: undefined });

  const result = await handleInterventionText(fakeEnv(), state, "Rebrand the storefront and packaging.");

  assert.strictEqual(log.handoffCreateBody, null, "must not create a Handoff with no value-relevant context for Finance to judge against");
  assert.ok(log.sentTexts.some((t) => /no value-relevant context/i.test(t)));
  assert.strictEqual(result.handoffId, undefined);
});

test("6. Disclosed budget/willingness-to-pay is never transferred as a Finance pricing input", async (t) => {
  const log = mockFetch(t);
  const state = fakeState({
    callNotes: "Client mentioned they have roughly $50,000 budgeted and are willing to pay up to $60k for the right partner.",
  });

  await handleInterventionText(fakeEnv(), state, "Full brand repositioning engagement.");

  const props = handoffProps(log);
  // The explicit anti-leak declaration must be present and must not itself
  // echo the disclosed figure as something Finance should use.
  const assumptions = richTextValue(props.Assumptions);
  assert.match(assumptions, /should be used as a Finance pricing input/i);
  assert.ok(!/\$\d/.test(assumptions), "Assumptions must not restate the disclosed figure");
  // No dedicated pricing-input field of any kind exists on the payload --
  // the schema has no such property, and none is invented here.
  for (const key of ["Budget", "Willingness To Pay", "Willingness to Pay", "Pricing Input", "Disclosed Budget"]) {
    assert.strictEqual(props[key], undefined, `must never add a dedicated pricing-input property (${key})`);
  }
  // Required Next Action / Acceptance Criteria / Expected Output stay
  // generic -- they must not echo the specific disclosed figure either.
  for (const field of ["Required Next Action", "Acceptance Criteria", "Expected Output"]) {
    assert.ok(!/\$\d/.test(richTextValue(props[field])), `${field} must not carry the disclosed figure`);
  }
});

test("7. Entity_Token/Matter_Token remain opaque -- no real Entity/Matter name crosses the boundary", async (t) => {
  const log = mockFetch(t, { entityUniqueId: 47, matterUniqueId: 12 });
  const state = fakeState();

  await handleInterventionText(fakeEnv(), state, "Rebrand the storefront and packaging.");

  const props = handoffProps(log);
  // The opaque token boundary is Entity_Token/Matter_Token specifically --
  // these are what the receiving Unit's own automated/AI logic consumes
  // (see dataBoundary/policy.ts's evaluateHandoffContext), so they must be
  // the Notion Unique ID token, never the real Entity/Matter name. The
  // Handoff's own title is a human-facing work descriptor for Martin (who
  // already has full Notion access) and, consistent with every other
  // Handoff-creation site in this codebase, may legitimately carry the
  // Matter's own human-readable title -- that's not an identity leak across
  // the automated-processing boundary this requirement protects.
  assert.strictEqual(richTextValue(props.Entity_Token), "E-47");
  assert.strictEqual(richTextValue(props.Matter_Token), "M-12");
  assert.ok(!richTextValue(props.Entity_Token).includes("Acme"), "Entity_Token must be the opaque unique-ID token, never the real Entity name");
  assert.ok(!richTextValue(props.Matter_Token).includes("Acme"), "Matter_Token must be the opaque unique-ID token, never the real Entity name");
});

test("8. Finance processes the Handoff through the existing queue mechanism (handoff_workitem KV mapping, no direct invocation)", async (t) => {
  const originalFetch = globalThis.fetch;
  const putCalls: { key: string; value: string }[] = [];
  mockFetch(t);
  const env = fakeEnv();
  env.STATE_KV = {
    ...env.STATE_KV,
    put: async (key: string, value: string) => {
      putCalls.push({ key, value });
    },
  } as any;

  const state = fakeState();
  const result = await handleInterventionText(env, state, "Rebrand the storefront and packaging.");

  const mapping = putCalls.find((c) => c.key === `handoff_workitem:${result.handoffId}`);
  assert.ok(mapping, "the Handoff must be registered in the same handoff_workitem KV mapping independent discovery relies on");
  assert.strictEqual(mapping!.value, state.workId);
  globalThis.fetch = originalFetch;
});

test("9. Finance quote authority remains unchanged -- Sales reads the quote verbatim, never modifies/converts/reinterprets it", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/handoff-quote-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "handoff-quote-1",
          url: "https://notion.so/handoff-quote-1",
          properties: {
            "Verified Facts & Sources": {
              rich_text: [{ plain_text: "Authoritative quote: $18500\nRationale: Value-based on projected revenue lift." }],
            },
            Entity_Token: { rich_text: [{ plain_text: "E-47" }] },
            Matter_Token: { rich_text: [{ plain_text: "M-12" }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      // Governance page content (Sales Executive Hat Definition, Universal
      // Role Contract) -- non-empty content is all handleQuoteReceived needs
      // to proceed past the governance-retrieval gate for this test's purpose.
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (method === "PATCH" || (method === "POST" && urlStr.endsWith("/pages"))) {
      return new Response(JSON.stringify({ id: "page", url: "https://notion.so/page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeState({ handoffId: "handoff-quote-1", stage: "awaiting_quote", awaiting: undefined });
  const result = await handleQuoteReceived(fakeEnv(), state);

  assert.ok(result.quote, "the parsed quote must be attached to state");
  assert.strictEqual(result.quote!.price, 18500, "the quote price must be read verbatim -- never modified, converted, or reinterpreted");
  assert.strictEqual(result.quote!.rationale, "Value-based on projected revenue lift.");
});

// ============================================================================
// Commercial Value & Pricing Operating Model
//
// NOTE ON TEST STRATEGY: handleCallNotes's two AI calls (commercial-value
// extraction, then qualification) run through the production
// AiPolicyExecutor/data-boundary evaluator exactly like every other sales.*
// task. Per dataBoundary/policy.ts's own documented "Sales Executive pause"
// (see PRODUCTION_PROVIDER_ELIGIBILITY's comment), every sales.* task is
// client_confidential and, as of today, has ZERO eligible provider in
// production -- a pre-existing gap unrelated to this change (it already
// applied to the four original qualification conditions before this task).
// aiJson therefore returns null for both calls in this environment, exactly
// as it would in production today, so a test that mocked env.AI.run would
// never actually reach it -- it would just be exercising dead code that
// can't run outside a test process. Since fixing that provider-eligibility
// gate is an explicitly out-of-scope architectural change (see AGENTS.md's
// Provider and Data-Boundary Constraints and this task's own "no additional
// architectural changes" instruction), these tests instead exercise the
// deterministic evidence-gate logic directly, and the Handoff/Matter
// carry-forward logic that doesn't require an AI call to succeed -- both
// exported from salesExecutive.ts for this purpose (see the "Exported for
// unit testing only" block at the end of that file).
// ============================================================================

import {
  normalizeCommercialEvidence,
  normalizeInvestmentToleranceContext,
  evaluateCommercialValueEvidence,
  computeOverallQualification,
  buildMeasurementBaseline,
  formatCommercialEvidenceForHandoff,
} from "./salesExecutive";

test("A. Sufficient commercial evidence (numerical affected opportunity/value, source, period, desired outcome) -> commercial_value_evidence can be Satisfied", () => {
  const evidence = normalizeCommercialEvidence({
    value_at_stake: { low: 8000000, high: 12000000, currency: "GHS", period: "annual", evidence_type: "client_estimated", source: "Client-stated on call" },
    affected_revenue_or_opportunity: "Larger-account sales opportunities",
    desired_measurable_outcome: "Number/value of qualified larger-account opportunities progressed",
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Satisfied");

  // And the qualification-level splice/override + overall recomputation
  // wires correctly once this deterministic result is available -- the
  // rest of handleCallNotes's integration.
  const conditions = [
    { condition: "within_specialization" as const, evidence: "Fits our specialization.", assessment: "Satisfied" as const },
    { condition: "allows_diagnosis_first" as const, evidence: "Open to diagnosis.", assessment: "Satisfied" as const },
    { condition: "open_to_ballpark_amount_and_time" as const, evidence: "Open to discussing scope.", assessment: "Satisfied" as const },
    { condition: "ready_to_commit_required_resources" as const, evidence: "Ready to commit resources.", assessment: "Satisfied" as const },
    { condition: "commercial_value_evidence" as const, evidence: result.evidenceText, assessment: result.assessment },
  ];
  assert.strictEqual(computeOverallQualification(conditions), "Qualified");
});

test("B. Turnover-only (no value connected to the problem) -> insufficient commercial evidence", () => {
  // The extraction prompt is instructed not to populate value_at_stake from
  // bare turnover -- this is what that discipline holding looks like: no
  // value_at_stake or cost_of_inaction extracted at all, even though a
  // number (GHS 28M) appeared in the source text.
  const evidence = normalizeCommercialEvidence({ affected_revenue_or_opportunity: undefined });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
  assert.match(result.evidenceText, /no numerical value/i);
});

test("C. Budget-only (disclosed budget, no business-value evidence) -> insufficient commercial evidence", () => {
  const evidence = normalizeCommercialEvidence({});
  const investmentTolerance = normalizeInvestmentToleranceContext({ investment_tolerance_context: { low: 30000, high: 60000, currency: "GHS" } });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
  // Investment tolerance is captured separately -- and must never leak into
  // the deterministic evidence assessment itself as if it satisfied it.
  assert.strictEqual(investmentTolerance?.low, 30000);
});

test("D. Willingness-to-pay-only -> insufficient commercial evidence", () => {
  const evidence = normalizeCommercialEvidence({});
  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
});

test("E. Unsupported AI inference (X% of revenue) -> blocked/fail-closed", () => {
  // Even if extraction itself misbehaves and reports a number, an AI
  // inference with no real attribution must self-report (per the
  // extraction prompt's own instruction) as evidence_type "assumption" --
  // and the deterministic gate must reject an assumption-only figure
  // regardless of what any downstream AI qualification call might conclude.
  const evidence = normalizeCommercialEvidence({
    value_at_stake: { value: 2800000, currency: "GHS", period: "annual", evidence_type: "assumption", source: "AI-inferred percentage of stated turnover" },
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
  assert.match(result.evidenceText, /assumption/i);
});

test("F. Client-estimated range, explicitly identified as an estimate -> accepted as client-estimated, not measured fact", () => {
  const evidence = normalizeCommercialEvidence({
    cost_of_inaction: {
      low: 1000000,
      high: 3000000,
      currency: "GHS",
      period: "6-12 months",
      evidence_type: "client_estimated",
      source: "Client management estimate, not measured loss",
    },
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Satisfied");
  assert.match(result.evidenceText, /client_estimated/);
});

test("G. Derived value (mathematically derived from attributable supplied figures) -> accepted as derived, with derivation preserved", () => {
  const evidence = normalizeCommercialEvidence({
    value_at_stake: {
      value: 500000,
      currency: "GHS",
      period: "annual",
      evidence_type: "derived",
      source: "Derived: 10 accounts x GHS 50,000 average stated deal value",
      assumptions: "Derived from client-stated average deal value x client-stated pipeline count.",
    },
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Satisfied");
  assert.match(result.evidenceText, /derived/);
  assert.strictEqual(evidence.valueAtStake?.assumptions, "Derived from client-stated average deal value x client-stated pipeline count.");
});

test("H. Assumption-only value -> cannot satisfy the required evidence gate by itself", () => {
  const evidence = normalizeCommercialEvidence({
    value_at_stake: { value: 100000, currency: "GHS", period: "annual", evidence_type: "assumption", source: "Unattributed internal guess" },
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
});

test("I. Missing period (numerical value exists, applicable period unknown) -> flagged insufficient", () => {
  const evidence = normalizeCommercialEvidence({
    value_at_stake: { value: 500000, currency: "GHS", evidence_type: "client_estimated", source: "Client-stated on call" },
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
  assert.match(result.evidenceText, /period/i);
});

test("J. Missing source (numerical value exists, attribution absent) -> insufficient evidence", () => {
  const evidence = normalizeCommercialEvidence({
    value_at_stake: { value: 500000, currency: "GHS", period: "annual", evidence_type: "client_estimated" },
  });

  const result = evaluateCommercialValueEvidence(evidence);
  assert.strictEqual(result.assessment, "Insufficient Evidence");
  assert.match(result.evidenceText, /source/i);
});

test("Q. Measurement baseline carries forward from qualification onto the Matter record", async (t) => {
  const originalFetch = globalThis.fetch;
  let matterUpdateBody: any = null;
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "PATCH") {
      matterUpdateBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/entity-page-1") && method === "PATCH") {
      return new Response(JSON.stringify({ id: "entity-page-1", url: "https://notion.so/entity-page-1", properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const evidence = normalizeCommercialEvidence({
    value_at_stake: { low: 8000000, high: 12000000, currency: "GHS", period: "annual", evidence_type: "client_estimated", source: "Client-stated on call" },
    affected_revenue_or_opportunity: "Larger-account sales opportunities",
    desired_measurable_outcome: "Progression rate of qualified larger-account opportunities",
  });
  const baseline = buildMeasurementBaseline(evidence);
  assert.ok(baseline, "measurement baseline must be derivable from sufficient commercial evidence");
  assert.strictEqual(baseline!.baselinePeriod, "annual");

  // Carry-forward onto the Matter record is exercised end-to-end --
  // handleLeadToProspectApproval doesn't call AI, so this part of the
  // pipeline isn't affected by the provider-eligibility gap noted above.
  const state = fakeState({ stage: "awaiting_qualification_approval", measurementBaseline: baseline });
  const afterApproval = await handleLeadToProspectApproval(fakeEnv(), state, true);

  assert.strictEqual(afterApproval.stage, "awaiting_intervention");
  assert.ok(matterUpdateBody, "Matter record must be updated on Lead->Prospect approval");
  const understanding = matterUpdateBody.properties.Current_understanding?.rich_text?.[0]?.text?.content ?? "";
  assert.match(understanding, /Commercial baseline/);
  assert.match(understanding, /8000000-12000000|GHS/);
});

test("R. Existing approval behavior is preserved -- redo on qualification still routes to call_notes, no Matter/Entity mutation", async (t) => {
  const originalFetch = globalThis.fetch;
  let matterUpdateBody: any = null;
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/matter-page-1") && method === "PATCH") {
      matterUpdateBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "matter-page-1", url: "https://notion.so/matter-page-1", properties: {} }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      return new Response(JSON.stringify({ id: "log-page", url: "https://notion.so/log-page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  const state = fakeState({ stage: "awaiting_qualification_approval" });

  const result = await handleLeadToProspectApproval(env, state, false);

  assert.strictEqual(result.stage, "qualification_hold");
  assert.strictEqual(result.awaiting, "call_notes");
  assert.strictEqual(matterUpdateBody, null, "a redo must not mutate the Matter record");
});

test("Handoff evidence formatting keeps investment tolerance in a clearly separate, labeled context-only block", () => {
  const evidence = normalizeCommercialEvidence({
    value_at_stake: { low: 8000000, high: 12000000, currency: "GHS", period: "annual", evidence_type: "client_estimated", source: "Client-stated on call" },
    desired_measurable_outcome: "Qualified opportunity progression rate",
  });
  const tolerance = normalizeInvestmentToleranceContext({ investment_tolerance_context: { low: 30000, high: 60000, currency: "GHS" } });

  const text = formatCommercialEvidenceForHandoff(evidence, tolerance);

  assert.match(text, /Commercial-value evidence \(pricing basis\)/);
  assert.match(text, /Investment tolerance \(CONTEXT ONLY/);
  // Investment tolerance section must appear strictly after the pricing-
  // basis section, never interleaved into it.
  assert.ok(text.indexOf("CONTEXT ONLY") > text.indexOf("pricing basis"));
});

test("S. Opaque-token boundary holds even with commercial evidence attached -- Handoff still carries only Entity_Token/Matter_Token, never real names", async (t) => {
  const log = mockFetch(t, { entityUniqueId: 47, matterUniqueId: 12 });
  const state = fakeState({
    commercialEvidence: {
      valueAtStake: { low: 8000000, high: 12000000, currency: "GHS", period: "annual", evidenceType: "client_estimated", source: "Client-stated" },
    },
    investmentToleranceContext: { low: 30000, high: 60000, currency: "GHS" },
  });

  await handleInterventionText(fakeEnv(), state, "Diagnostic engagement to identify positioning gaps.");

  const props = handoffProps(log);
  assert.strictEqual(richTextValue(props.Entity_Token), "E-47");
  assert.strictEqual(richTextValue(props.Matter_Token), "M-12");
  const factsText = richTextValue(props["Verified Facts & Sources"]);
  assert.match(factsText, /Commercial-value evidence/);
  assert.match(factsText, /Investment tolerance/);
  assert.ok(!factsText.includes("Acme"), "structured evidence carry-forward must not reintroduce the real Entity name");
});
