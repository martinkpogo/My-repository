import test from "node:test";
import assert from "node:assert/strict";
import {
  selectRequiredSpecialists,
  runSpecialistDiagnosis,
  runSpecialistDiagnosesConcurrently,
  synthesizeSpecialistFindings,
  type SpecialistFinding,
} from "./strategySpecialists";
import { STRATEGY_ANALYST, BUSINESS_STRATEGIST, BRAND_STRATEGIST, COMMUNICATION_STRATEGIST, MARKETING_HAT_REGISTRY, ALL_HATS } from "../../hats/registry";
import { PRODUCTION_TASK_SENSITIVITY, PRODUCTION_OUTBOUND_POLICY } from "../../dataBoundary/policy";
import type { Env } from "../../types";

/**
 * strategy.specialist_selection / strategy.business_diagnosis /
 * strategy.brand_diagnosis / strategy.communication_diagnosis /
 * strategy.specialist_synthesis are registered SemanticTaskIds but are
 * deliberately left UNCLASSIFIED in PRODUCTION_TASK_SENSITIVITY /
 * PRODUCTION_OUTBOUND_POLICY, pending Architect review -- same discipline
 * as every other new task this repo registers. aiJson fails closed
 * (returns null before any provider is even attempted) for an unclassified
 * task in EVERY environment, tests included, so these tests temporarily
 * classify the five tasks with the exact same category/rationale already
 * approved for strategy.diagnosis/handoff_routing/proposal_drafting
 * (business_sensitive, TOKEN_SAFE_RUNTIME -- Entity_Token/Matter_Token-
 * bound sanitized text, never real client identity) purely so this file's
 * own composition logic is exercisable in isolation from that separate,
 * pending governance decision. This mutates only this test process's
 * in-memory copy of the two policy maps, restored immediately after each
 * test -- it has no effect on production, and does not itself constitute
 * the Architect classification decision (see strategyAnalyst.ts's own
 * runDiagnosis doc comment, and the final implementation report, for that
 * open item).
 */
const COMPOSITION_TASK_IDS = [
  "strategy.specialist_selection",
  "strategy.business_diagnosis",
  "strategy.brand_diagnosis",
  "strategy.communication_diagnosis",
  "strategy.specialist_synthesis",
] as const;

function classifyCompositionTasksForTest(t: any): void {
  for (const id of COMPOSITION_TASK_IDS) {
    (PRODUCTION_TASK_SENSITIVITY as any)[id] = "business_sensitive";
    (PRODUCTION_OUTBOUND_POLICY as any)[id] = "TOKEN_SAFE_RUNTIME";
  }
  t.after(() => {
    for (const id of COMPOSITION_TASK_IDS) {
      delete (PRODUCTION_TASK_SENSITIVITY as any)[id];
      delete (PRODUCTION_OUTBOUND_POLICY as any)[id];
    }
  });
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
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
    ...overrides,
  };
}

/** Every getGovernance call resolves generically -- this file only cares about the composition/orchestration logic layered on top, not Notion fetch mechanics (already covered by strategyAnalyst.test.ts). */
function mockGovernanceFetch(t: any): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/blocks/") && String(url).includes("/children")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

type FakeAiScript = {
  selection?: unknown;
  business?: unknown | "throw";
  brand?: unknown | "throw";
  communication?: unknown | "throw";
  synthesis?: unknown;
};

function fakeSpecialistAi(script: FakeAiScript): Env["AI"] {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      const respond = (val: unknown) => {
        if (val === "throw") throw new Error("simulated specialist infrastructure failure");
        return { response: JSON.stringify(val) };
      };
      if (system.includes("specialist-selection responsibility")) return respond(script.selection ?? { domains: [], reasoning: "test" });
      if (system.includes("Business Strategist Hat")) return respond(script.business ?? { sufficient: false, blockedReason: "not configured for this test" });
      if (system.includes("Brand Strategist Hat")) return respond(script.brand ?? { sufficient: false, blockedReason: "not configured for this test" });
      if (system.includes("Communication Strategist Hat")) return respond(script.communication ?? { sufficient: false, blockedReason: "not configured for this test" });
      if (system.includes("synthesis responsibility")) return respond(script.synthesis ?? { sufficient: true, synthesizedContext: "test synthesis" });
      throw new Error(`Unexpected AI call in test -- system prompt: ${system.slice(0, 80)}`);
    },
  } as any;
}

test("Strategy Hat registration: Strategy Analyst + three specialist Hats are all registered with distinct specializations", () => {
  assert.strictEqual(STRATEGY_ANALYST.name, "Strategy Analyst");
  assert.strictEqual(STRATEGY_ANALYST.specialization, "Strategic Assessment & Synthesis");
  assert.strictEqual(BUSINESS_STRATEGIST.name, "Business Strategist");
  assert.strictEqual(BUSINESS_STRATEGIST.unit, "Strategy");
  assert.strictEqual(BUSINESS_STRATEGIST.specialization, "Business & Commercial Strategy");
  assert.strictEqual(BRAND_STRATEGIST.name, "Brand Strategist");
  assert.strictEqual(BRAND_STRATEGIST.unit, "Strategy");
  assert.strictEqual(BRAND_STRATEGIST.specialization, "Brand & Positioning Strategy");
  assert.strictEqual(COMMUNICATION_STRATEGIST.name, "Communication Strategist");
  assert.strictEqual(COMMUNICATION_STRATEGIST.unit, "Strategy");
  assert.strictEqual(COMMUNICATION_STRATEGIST.specialization, "Communication & Messaging Strategy");
  for (const hat of [STRATEGY_ANALYST, BUSINESS_STRATEGIST, BRAND_STRATEGIST, COMMUNICATION_STRATEGIST]) {
    assert.ok(ALL_HATS.includes(hat), `${hat.name} must be registered in ALL_HATS`);
  }
});

test("Marketing Strategist remains owned exclusively by Marketing -- Strategy never registers a duplicate", () => {
  assert.ok(MARKETING_HAT_REGISTRY["Marketing Strategist"], "Marketing must still own its Marketing Strategist Hat");
  assert.ok(
    !ALL_HATS.some((h) => h.name === "Marketing Strategist" && h.unit === "Strategy"),
    "Strategy must never register its own Marketing Strategist -- it may only invoke Marketing's, never duplicate it",
  );
  const strategyHatNames = ALL_HATS.filter((h) => h.unit === "Strategy").map((h) => h.name);
  assert.deepStrictEqual(
    new Set(strategyHatNames),
    new Set(["Strategy Analyst", "Business Strategist", "Brand Strategist", "Communication Strategist"]),
    "Strategy must own exactly its four composable-model Hats, nothing more",
  );
});

test("selectRequiredSpecialists: a genuinely resolvable question returns zero domains -- a valid, expected outcome, not a fallback", async (t) => {
  classifyCompositionTasksForTest(t);
  const env = fakeEnv({ AI: fakeSpecialistAi({ selection: { domains: [], reasoning: "Directly resolvable from established strategic reasoning." } }) });

  const result = await selectRequiredSpecialists(env, "Should we expand delivery capacity?", "Recurring delivery complaints, capacity constraint documented.");

  assert.ok(result);
  assert.deepStrictEqual(result!.domains, []);
});

test("selectRequiredSpecialists: selects one or multiple domains, filters invalid values, and dedupes", async (t) => {
  classifyCompositionTasksForTest(t);
  const env = fakeEnv({ AI: fakeSpecialistAi({ selection: { domains: ["business", "brand", "business", "not-a-real-domain"], reasoning: "test" } }) });

  const result = await selectRequiredSpecialists(env, "q", "c");

  assert.ok(result);
  assert.deepStrictEqual(result!.domains.sort(), ["brand", "business"]);
});

test("selectRequiredSpecialists: returns null (never a fabricated empty result) when the classifier's own response is unusable", async (t) => {
  classifyCompositionTasksForTest(t);
  const env = fakeEnv({ AI: fakeSpecialistAi({ selection: { reasoning: "no domains field at all" } }) });

  const result = await selectRequiredSpecialists(env, "q", "c");

  assert.strictEqual(result, null);
});

test("runSpecialistDiagnosis: returns a completed finding matching the bounded-finding schema", async (t) => {
  classifyCompositionTasksForTest(t);
  mockGovernanceFetch(t);
  const env = fakeEnv({
    AI: fakeSpecialistAi({
      business: {
        sufficient: true,
        domainExamined: "Business model and growth model.",
        problemOrIssue: "Growth is capacity-constrained, not demand-constrained.",
        supportingEvidence: "Two quarters of documented capacity shortfall.",
        diagnosis: "The business model's fulfilment capacity has not scaled with demand.",
        strategicImplication: "Any brand/communication fix would not resolve the underlying capacity gap.",
        interventionImplication: "Expand fulfilment capacity before any other intervention.",
        uncertaintyAndLimitations: "Exact cost of expansion not yet known.",
        unresolvedQuestions: "Which vendor has verifiable regional capacity.",
      },
    }),
  });

  const finding = await runSpecialistDiagnosis(env, "business", "Recurring delivery complaints, capacity constraint documented.");

  assert.strictEqual(finding.domain, "business");
  assert.strictEqual(finding.status, "completed");
  assert.strictEqual(finding.failureReason, undefined);
  assert.ok(finding.domainExamined);
  assert.ok(finding.problemOrIssue);
  assert.ok(finding.supportingEvidence);
  assert.ok(finding.diagnosis);
  assert.ok(finding.strategicImplication);
  assert.ok(finding.interventionImplication);
  assert.ok(finding.uncertaintyAndLimitations);
  assert.ok(finding.unresolvedQuestions);
});

test("runSpecialistDiagnosis: a specialist may conclude its own domain does not justify an intervention", async (t) => {
  classifyCompositionTasksForTest(t);
  mockGovernanceFetch(t);
  const env = fakeEnv({
    AI: fakeSpecialistAi({
      brand: {
        sufficient: true,
        domainExamined: "Positioning and perception.",
        problemOrIssue: "Visual identity inconsistency was reported.",
        supportingEvidence: "Inconsistent client-facing materials across two campaigns.",
        diagnosis: "The inconsistency is cosmetic and does not affect client trust or perception materially.",
        strategicImplication: "Not a material driver of the presenting symptom.",
        uncertaintyAndLimitations: "None material.",
        unresolvedQuestions: "None.",
        // interventionImplication deliberately omitted -- this specialist judged no intervention is justified.
      },
    }),
  });

  const finding = await runSpecialistDiagnosis(env, "brand", "context");

  assert.strictEqual(finding.status, "completed");
  assert.strictEqual(finding.interventionImplication, undefined, "must never fabricate an intervention implication merely because the specialist was selected");
});

test("runSpecialistDiagnosis: never throws -- an AI/infrastructure failure becomes a failed finding with a reason, not an exception", async (t) => {
  classifyCompositionTasksForTest(t);
  mockGovernanceFetch(t);
  const env = fakeEnv({ AI: fakeSpecialistAi({ communication: "throw" }) });

  const finding = await runSpecialistDiagnosis(env, "communication", "context");

  assert.strictEqual(finding.domain, "communication");
  assert.strictEqual(finding.status, "failed");
  assert.ok(finding.failureReason, "Strategy Analyst must know exactly why the finding is unavailable");
});

test("runSpecialistDiagnosis: an insufficient specialist response is a failed finding, not a fabricated diagnosis", async (t) => {
  classifyCompositionTasksForTest(t);
  mockGovernanceFetch(t);
  const env = fakeEnv({ AI: fakeSpecialistAi({ business: { sufficient: false, blockedReason: "Supplied context does not distinguish business-model cause from a simple demand spike." } }) });

  const finding = await runSpecialistDiagnosis(env, "business", "context");

  assert.strictEqual(finding.status, "failed");
  assert.strictEqual(finding.failureReason, "Supplied context does not distinguish business-model cause from a simple demand spike.");
});

test("runSpecialistDiagnosesConcurrently: runs every selected domain and never lets one failure short-circuit the batch", async (t) => {
  classifyCompositionTasksForTest(t);
  mockGovernanceFetch(t);
  const env = fakeEnv({
    AI: fakeSpecialistAi({
      business: { sufficient: true, domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "diag", strategicImplication: "s", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
      brand: "throw",
      communication: { sufficient: false, blockedReason: "insufficient" },
    }),
  });

  const findings = await runSpecialistDiagnosesConcurrently(env, ["business", "brand", "communication"], "context");

  assert.strictEqual(findings.length, 3);
  const byDomain = Object.fromEntries(findings.map((f) => [f.domain, f]));
  assert.strictEqual(byDomain.business.status, "completed");
  assert.strictEqual(byDomain.brand.status, "failed");
  assert.strictEqual(byDomain.communication.status, "failed");
});

test("synthesizeSpecialistFindings: sufficient findings produce a reconciled synthesizedContext", async (t) => {
  classifyCompositionTasksForTest(t);
  const env = fakeEnv({ AI: fakeSpecialistAi({ synthesis: { sufficient: true, synthesizedContext: "Business and brand findings agree the root cause is commercial, not brand.", agreements: "Both point to capacity.", crossDomainRelationships: "Brand perception issue is downstream of the capacity constraint." } }) });
  const findings: SpecialistFinding[] = [
    { domain: "business", status: "completed", domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "diag", strategicImplication: "s", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
    { domain: "brand", status: "completed", domainExamined: "d2", problemOrIssue: "p2", supportingEvidence: "e2", diagnosis: "diag2", strategicImplication: "s2", uncertaintyAndLimitations: "u2", unresolvedQuestions: "q2" },
  ];

  const result = await synthesizeSpecialistFindings(env, "Should we expand capacity?", findings);

  assert.ok(result);
  assert.strictEqual(result!.sufficient, true);
  assert.ok(result!.synthesizedContext);
});

test("synthesizeSpecialistFindings: conflicting findings that cannot be reconciled are surfaced as insufficient, never silently resolved", async (t) => {
  classifyCompositionTasksForTest(t);
  const env = fakeEnv({
    AI: fakeSpecialistAi({
      synthesis: {
        sufficient: false,
        insufficiencyReason: "Business Strategist attributes the symptom to capacity, Brand Strategist attributes it to positioning -- the two accounts materially conflict and neither is corroborated well enough to prefer one over the other from the supplied evidence.",
        disagreements: "Business vs. Brand attribute the root cause differently.",
      },
    }),
  });
  const findings: SpecialistFinding[] = [
    { domain: "business", status: "completed", domainExamined: "d", problemOrIssue: "p", supportingEvidence: "e", diagnosis: "Capacity-driven.", strategicImplication: "s", uncertaintyAndLimitations: "u", unresolvedQuestions: "q" },
    { domain: "brand", status: "completed", domainExamined: "d2", problemOrIssue: "p2", supportingEvidence: "e2", diagnosis: "Positioning-driven.", strategicImplication: "s2", uncertaintyAndLimitations: "u2", unresolvedQuestions: "q2" },
  ];

  const result = await synthesizeSpecialistFindings(env, "q", findings);

  assert.ok(result);
  assert.strictEqual(result!.sufficient, false);
  assert.ok(result!.insufficiencyReason);
});

test("synthesizeSpecialistFindings: an unavailable (failed) specialist is passed through explicitly, never silently backfilled", async (t) => {
  classifyCompositionTasksForTest(t);
  let capturedUserPrompt = "";
  const env = fakeEnv({
    AI: {
      run: async (_model: any, opts: any) => {
        const system = String(opts?.messages?.[0]?.content ?? "");
        if (system.includes("synthesis responsibility")) {
          capturedUserPrompt = String(opts?.messages?.[1]?.content ?? "");
          return { response: JSON.stringify({ sufficient: false, insufficiencyReason: "Business Strategist's finding is unavailable and material to this question." }) };
        }
        throw new Error("unexpected call");
      },
    } as any,
  });
  const findings: SpecialistFinding[] = [{ domain: "business", status: "failed", failureReason: "Could not retrieve canonical governance." }];

  const result = await synthesizeSpecialistFindings(env, "q", findings);

  assert.ok(result);
  assert.strictEqual(result!.sufficient, false);
  assert.ok(capturedUserPrompt.includes("UNAVAILABLE"), "the synthesis prompt must explicitly mark the failed specialist as unavailable, never omit it");
});

test("Specialist orchestration never has access to WorkState or the canonical Strategy Proposal -- structurally cannot mutate it", () => {
  // runSpecialistDiagnosis/runSpecialistDiagnosesConcurrently/
  // synthesizeSpecialistFindings each take only primitive/finding-shaped
  // arguments (env, domain(s)/question, context/findings) -- never a
  // WorkState or StrategyProposal. This is enforced by TypeScript at every
  // call site; asserting arity here is a lightweight regression guard that
  // a future edit doesn't quietly widen these signatures to accept one.
  assert.strictEqual(runSpecialistDiagnosis.length, 3, "runSpecialistDiagnosis(env, domain, strategyContext) -- no WorkState/proposal parameter");
  assert.strictEqual(runSpecialistDiagnosesConcurrently.length, 3, "runSpecialistDiagnosesConcurrently(env, domains, strategyContext) -- no WorkState/proposal parameter");
  assert.strictEqual(synthesizeSpecialistFindings.length, 3, "synthesizeSpecialistFindings(env, strategyQuestion, findings) -- no WorkState/proposal parameter");
});
