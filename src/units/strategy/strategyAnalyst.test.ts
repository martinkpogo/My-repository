import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePickup,
  handleStrategyHandoffApproval,
  evaluateCausationDiscipline,
  formatDiagnosisForHandoff,
  type StrategyDiagnosisResult,
} from "./strategyAnalyst";
import { STRATEGY_ANALYST, ALL_HATS } from "../../hats/registry";
import type { WorkState, Env } from "../../types";

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

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work_strat_1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    stage: "awaiting_pickup",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: "handoff-1",
    ...overrides,
  };
}

/** Dispatches on the system prompt's own distinguishing text -- diagnosis vs. handoff-routing classification. */
function fakeAi(diagnosisJson: unknown, routingJson: unknown = { target: "none" }): Ai {
  return {
    run: async (_model: any, opts: any) => {
      const system = String(opts?.messages?.[0]?.content ?? "");
      if (system.includes("canonical operating procedure")) {
        return { response: JSON.stringify(diagnosisJson) };
      }
      if (system.includes("next responsibility belongs to another Unit")) {
        return { response: JSON.stringify(routingJson) };
      }
      throw new Error(`Unexpected AI call in test -- system prompt: ${system.slice(0, 80)}`);
    },
  } as any;
}

/** An env.AI.run that must never be called -- used to prove closed-context failures short-circuit before any AI call. */
function forbiddenAi(): Ai {
  return {
    run: async () => {
      throw new Error("AI must not be called when required context is missing");
    },
  } as any;
}

interface FetchLog {
  handoffPatchBodies: any[];
  handoffCreateBody: any;
  sentTexts: string[];
}

function mockFetch(
  t: any,
  opts: { verifiedFacts?: string; entityToken?: string; matterToken?: string; noWorkspaceConfig?: boolean } = {},
): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = { handoffPatchBodies: [], handoffCreateBody: null, sentTexts: [] };
  const verifiedFacts = opts.verifiedFacts ?? "Sales call notes: recurring client complaints about late delivery over the last two quarters, tied to a named warehouse capacity constraint.";
  const entityToken = opts.entityToken ?? "E-47";
  const matterToken = opts.matterToken ?? "M-12";

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      log.sentTexts.push(body.text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          properties: {
            "Verified Facts & Sources": { rich_text: [{ plain_text: verifiedFacts }] },
            Entity_Token: { rich_text: [{ plain_text: entityToken }] },
            Matter_Token: { rich_text: [{ plain_text: matterToken }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") {
      log.handoffPatchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "handoff-1", url: "https://notion.so/handoff-1", properties: {} }), { status: 200 });
    }
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        log.handoffCreateBody = body;
        return new Response(JSON.stringify({ id: "handoff-new", url: "https://notion.so/handoff-new", properties: {} }), { status: 200 });
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

function lastHandoffPatch(log: FetchLog): any {
  return log.handoffPatchBodies[log.handoffPatchBodies.length - 1];
}

const SUFFICIENT_DIAGNOSIS: StrategyDiagnosisResult = {
  sufficient: true,
  situation: {
    symptoms: "Repeated client complaints about late delivery.",
    businessConditions: "Two consecutive quarters of missed delivery windows.",
    constraints: "Warehouse capacity fixed through year-end.",
    consequences: "Client trust erosion, risk of churn on largest account.",
    stakeholders: "Operations lead, key account client contact.",
    objectives: "Restore reliable delivery within the quarter.",
  },
  diagnosis: {
    symptom: "Late delivery complaints.",
    problem: "Delivery reliability has degraded for the largest account.",
    cause: "Warehouse capacity constraint documented in call notes for two consecutive quarters.",
    causationSupported: true,
    constraint: "Warehouse capacity fixed through year-end.",
    consequence: "Client trust erosion, churn risk.",
  },
  strategicProblem: {
    statement: "Delivery reliability is degrading due to a capacity constraint, threatening the largest account.",
    whyItMatters: "This account represents material recurring revenue.",
    keyDrivers: "Fixed warehouse capacity, sustained demand growth.",
    strategicTension: "Invest in capacity now vs. risk further account erosion.",
    materialUncertainty: "Exact churn probability if unresolved.",
  },
  options: [
    {
      name: "Expand interim capacity via third-party logistics",
      intendedEffect: "Restore delivery reliability within one quarter.",
      rationale: "Fastest lever given fixed warehouse capacity through year-end.",
      evidenceBasis: "Call notes documenting the capacity constraint.",
      assumptions: "Third-party logistics partner has available capacity.",
      constraintsRisks: "Added cost; vendor reliability unverified.",
      conditionsForSuccess: "Partner onboarded within 30 days.",
    },
  ],
  recommendedDirection: "Expand interim delivery capacity via a third-party logistics partner within the quarter.",
  recommendationRationale: "Directly addresses the documented capacity constraint within the client's tolerance window.",
  evidenceSources: "Sales call notes, two quarters of delivery data referenced therein.",
  assumptions: "Third-party logistics partner has available capacity.",
  unresolvedQuestions: "Exact cost of third-party logistics expansion.",
};

test("1. Strategy Analyst identity resolves correctly", () => {
  assert.strictEqual(STRATEGY_ANALYST.name, "Strategy Analyst");
  assert.strictEqual(STRATEGY_ANALYST.unit, "Strategy");
  assert.strictEqual(STRATEGY_ANALYST.specialization, "Strategy");
  assert.ok(ALL_HATS.some((h) => h.name === "Strategy Analyst" && h.unit === "Strategy"));
});

test("2. Valid strategic work enters the Strategy runtime and delivers a diagnosis", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "delivered");
  assert.ok(result.strategyDiagnosis, "diagnosis must be attached to state");
  const closePatch = lastHandoffPatch(log);
  assert.strictEqual(closePatch.properties.Status.select.name, "Closed");
  assert.match(closePatch.properties["Work Completed"].rich_text[0].text.content, /Strategic problem/);
  assert.ok(log.sentTexts.some((t) => /Diagnosis:/.test(t)));
});

test("3. Material ambiguity blocks execution", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, blockedCategory: "ambiguous_question", blockedReason: "The strategic question could mean either a pricing problem or a delivery problem -- materially different diagnoses follow from each." });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked");
  assert.strictEqual(result.awaiting, "strategy_clarification");
  const heldPatch = lastHandoffPatch(log);
  assert.strictEqual(heldPatch.properties.Status.select.name, "Held");
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /materially different diagnoses/);
});

test("4. Insufficient evidence blocks rather than inventing a diagnosis", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, blockedCategory: "insufficient_evidence", blockedReason: "No evidence is supplied connecting the stated symptom to any business condition -- cannot responsibly diagnose." });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked");
  const heldPatch = lastHandoffPatch(log);
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /No evidence is supplied/);
});

test("5. Unsupported causation is rejected -- runtime overrides sufficient: true", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_DIAGNOSIS,
    diagnosis: { ...SUFFICIENT_DIAGNOSIS.diagnosis, causationSupported: false },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "strategy_blocked", "a recommendation resting on unsupported causation must never be delivered as-is");
  const heldPatch = lastHandoffPatch(log);
  assert.match(heldPatch.properties["Open Questions"].rich_text[0].text.content, /causation/i);
});

test("evaluateCausationDiscipline: rejects a recommendation when causation is not marked supported", () => {
  const result = evaluateCausationDiscipline({
    ...SUFFICIENT_DIAGNOSIS,
    diagnosis: { ...SUFFICIENT_DIAGNOSIS.diagnosis, causationSupported: false },
  });
  assert.strictEqual(result.valid, false);
});

test("evaluateCausationDiscipline: accepts a fully supported diagnosis", () => {
  const result = evaluateCausationDiscipline(SUFFICIENT_DIAGNOSIS);
  assert.strictEqual(result.valid, true);
});

test("evaluateCausationDiscipline: requires a stated reason when no recommendation is given", () => {
  const result = evaluateCausationDiscipline({
    sufficient: true,
    diagnosis: { problem: "Problem.", cause: "Cause.", causationSupported: true },
  });
  assert.strictEqual(result.valid, false);
});

test("6. Recommendation is not treated as approval", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  await handlePickup(env, state);

  assert.ok(
    log.sentTexts.some((t) => /not yet approved/i.test(t)),
    "the delivered message must explicitly mark the recommendation as not yet approved",
  );
});

test("7. Finance/pricing work is not executed by Strategy -- Strategy->Finance Handoff tells Finance to price, never prices itself", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, { target: "finance", reason: "Recommended intervention now needs value-based pricing." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.ok(afterPickup.pendingStrategyHandoff, "a downstream handoff must be proposed, not auto-created");
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.unit, "Finance");

  const afterApproval = await handleStrategyHandoffApproval(env, afterPickup, true);
  assert.strictEqual(afterApproval.pendingStrategyHandoff, undefined);

  const created = log.handoffCreateBody;
  assert.ok(created, "the Finance handoff must be created only after explicit approval");
  const props = created.properties;
  assert.strictEqual(props["To Unit"].select.name, "Finance");
  assert.strictEqual(props["To Hat"].rich_text[0].text.content, "Value-Based Pricing Assessor");
  // Strategy must never itself set a price/quote property.
  for (const key of ["Quoted Price", "Price", "Quote"]) {
    assert.strictEqual(props[key], undefined, `Strategy must never set a pricing property (${key})`);
  }
  assert.match(props["Required Next Action"].rich_text[0].text.content, /[Pp]rice the .*intervention/);
  assert.match(props["Required Next Action"].rich_text[0].text.content, /[Dd]o not redesign/);
});

test("8. Marketing-specific work is routed to Marketing, not absorbed by Strategy", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, { target: "marketing", reason: "Recommended direction is a marketing positioning decision." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.unit, "Marketing");
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.hat, "Marketing Strategist");

  await handleStrategyHandoffApproval(env, afterPickup, true);
  const props = log.handoffCreateBody.properties;
  assert.strictEqual(props["To Unit"].select.name, "Marketing");
});

test("9. R&I evidence/research boundary preserved -- Strategy routes missing-evidence work to R&I rather than inventing it", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, { target: "research", reason: "Recommendation would benefit from validated market evidence R&I owns." });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.unit, "Research & Intelligence");
  assert.strictEqual(afterPickup.pendingStrategyHandoff!.hat, "Research & Intelligence Analyst");

  await handleStrategyHandoffApproval(env, afterPickup, true);
  const props = log.handoffCreateBody.properties;
  assert.match(props["Required Next Action"].rich_text[0].text.content, /[Gg]ather.*validate/);
});

test("10. Handoff preserves strategic context -- receiving Unit doesn't get a bare conclusion", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS, { target: "finance" });
  const state = fakeState();

  const afterPickup = await handlePickup(env, state);
  await handleStrategyHandoffApproval(env, afterPickup, true);

  const factsText = log.handoffCreateBody.properties["Verified Facts & Sources"].rich_text[0].text.content;
  assert.match(factsText, /Strategic problem/);
  assert.match(factsText, /Diagnosis \(Symptom/);
  assert.match(factsText, /Cause:/);
  assert.match(factsText, /Recommended direction/);
});

test("formatDiagnosisForHandoff includes the full reasoning chain, not just the conclusion", () => {
  const text = formatDiagnosisForHandoff(SUFFICIENT_DIAGNOSIS);
  assert.match(text, /Symptom:/);
  assert.match(text, /Problem:/);
  assert.match(text, /Cause:/);
  assert.match(text, /Constraint:/);
  assert.match(text, /Consequence:/);
  assert.match(text, /Recommended direction:/);
  assert.match(text, /Rationale:/);
});

test("11. Closed-context protections remain intact -- missing Entity_Token blocks before any AI call", async (t) => {
  mockFetch(t, { entityToken: "" });
  const env = fakeEnv();
  env.AI = forbiddenAi();
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.strategyDiagnosis, undefined, "no diagnosis should have been attempted");
});

test("12. Missing Telegram stream configuration fails closed rather than throwing", async (t) => {
  mockFetch(t);
  const env = fakeEnv({ TELEGRAM_GROUP_CHAT_ID: undefined, WORKSPACE_TOPIC_ID: undefined });
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();

  // Must not throw even though every sendWorkspaceHatMessage call in the
  // pipeline will fail closed (return undefined) for lack of stream config.
  const result = await handlePickup(env, state);
  assert.strictEqual(result.stage, "delivered");
});

test("13. Material events use the existing logActivity mechanism", async (t) => {
  const originalFetch = globalThis.fetch;
  const logEntries: any[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          properties: {
            "Verified Facts & Sources": { rich_text: [{ plain_text: "Some documented situation with evidence." }] },
            Entity_Token: { rich_text: [{ plain_text: "E-1" }] },
            Matter_Token: { rich_text: [{ plain_text: "M-1" }] },
          },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") return new Response(JSON.stringify({ id: "handoff-1", url: "x", properties: {} }), { status: 200 });
    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Gov." }] } }] }), { status: 200 });
    }
    if (urlStr.endsWith("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "activity-log-ds") logEntries.push(body.properties);
      return new Response(JSON.stringify({ id: "p", url: "x", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_DIAGNOSIS);
  const state = fakeState();
  await handlePickup(env, state);

  assert.ok(logEntries.length >= 2, "pickup and completion must both be logged");
  for (const entry of logEntries) {
    assert.ok(entry.Entry, "every log entry must have an Entry");
    assert.ok(entry.Type, "every log entry must have a Type");
    assert.ok(entry.Area, "every log entry must have an Area");
    assert.ok(entry.Outcome, "every log entry must have an Outcome");
  }
});
