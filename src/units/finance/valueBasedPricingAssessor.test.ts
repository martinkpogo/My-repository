import test from "node:test";
import assert from "node:assert/strict";
import { handlePickup, handleQuoteApproval, validateFinanceJudgement } from "./valueBasedPricingAssessor";
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
    workId: "work_fin_1",
    chatId: 1,
    unit: "Finance",
    hat: "Value-Based Pricing Assessor",
    stage: "awaiting_pickup",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: "handoff-1",
    ...overrides,
  };
}

/** Builds a fake env.AI.run returning the given judgement JSON verbatim. */
function fakeAi(judgementJson: unknown): Ai {
  return {
    run: async () => ({ response: JSON.stringify(judgementJson) }),
  } as any;
}

interface FetchLog {
  handoffPatchBodies: any[];
  sentTexts: string[];
  handoffCreateBody: any;
  getCallCount: number;
}

function mockFetch(
  t: any,
  opts: {
    verifiedFacts?: string;
    entityToken?: string;
    matterToken?: string;
    initialStatus?: string;
    requiredNextAction?: string;
  } = {},
): FetchLog {
  const originalFetch = globalThis.fetch;
  const log: FetchLog = { handoffPatchBodies: [], sentTexts: [], handoffCreateBody: null, getCallCount: 0 };
  const verifiedFacts = opts.verifiedFacts ?? "Proposed intervention: Diagnostic. Value context: GHS 8M-12M opportunity.";
  const entityToken = opts.entityToken ?? "E-47";
  const matterToken = opts.matterToken ?? "M-12";
  const requiredNextAction = opts.requiredNextAction ?? "";

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      log.sentTexts.push(body.text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      log.getCallCount += 1;
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          properties: {
            Status: { select: { name: opts.initialStatus ?? "Pending" } },
            "Verified Facts & Sources": { rich_text: [{ plain_text: verifiedFacts }] },
            "Required Next Action": { rich_text: [{ plain_text: requiredNextAction }] },
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

function openQuestionsText(patch: any): string {
  return patch?.properties?.["Open Questions"]?.rich_text?.[0]?.text?.content ?? "";
}

const SUFFICIENT_JUDGEMENT = {
  sufficient: true,
  evidence_quality_assessment: "Client-estimated range with stated uncertainty.",
  value_at_stake: {
    low: 8000000,
    high: 12000000,
    currency: "GHS",
    period: "annual",
    evidence_type: "client_estimated",
    source: "Client-stated on call",
  },
  intervention_assessment: "Diagnostic engagement to identify positioning gaps ahead of a downstream intervention decision.",
  delivery_floor_rationale: "No independently-tracked delivery-cost data is available in the supplied context.",
  market_modifiers_applied: "None applied.",
  price: 15000,
  currency: "USD",
  rationale: "Priced against the estimated GHS 8M-12M opportunity exposure and the diagnostic's defined scope.",
};

test("K. Finance Hold -- AI itself reports insufficient evidence", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, reason_if_insufficient: "Value exists only as an unsupported assumption." });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held");
  const patch = lastHandoffPatch(log);
  assert.strictEqual(patch.properties.Status.select.name, "Held");
  assert.match(openQuestionsText(patch), /assumption/i);
});

test("Hold reason identifies the specific missing evidence, not a generic message", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ sufficient: false, reason_if_insufficient: "Value-at-stake has no applicable time period." });
  const state = fakeState();

  await handlePickup(env, state);

  const patch = lastHandoffPatch(log);
  assert.match(openQuestionsText(patch), /time period/i);
});

test("Telegram hold message states the actual specific reason -- not a hardcoded budget/WTP message regardless of cause", async (t) => {
  // Regression test for a live incident: the Telegram-facing message was
  // hardcoded to always claim a budget/WTP figure was the problem, even
  // when the real (correctly recorded, in Notion) reason was something
  // else entirely -- e.g. an unclassified evidence_type on otherwise
  // complete business-impact evidence. Martin saw the same generic text
  // on every hold and reasonably concluded Finance wasn't reading the
  // Handoff at all.
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    sufficient: true,
    value_at_stake: { low: 8000000, high: 12000000, currency: "GHS", period: "annual", evidence_type: "not_a_real_type", source: "Client-stated" },
    intervention_assessment: "Website redesign and content creation.",
    price: 300000,
    currency: "GHS",
    rationale: "Priced against the documented opportunity.",
  });
  const state = fakeState();

  await handlePickup(env, state);

  assert.ok(
    log.sentTexts.some((t) => /evidence type/i.test(t) && /directly_measured|client_estimated|derived|assumption/i.test(t)),
    "the Telegram message must state the actual specific hold reason",
  );
  assert.ok(
    !log.sentTexts.some((t) => /isn't enough to work out a value-based price/i.test(t)),
    "must not send the old hardcoded generic-cause message when the real reason is something else",
  );
});

test("Required Next Action content is folded into the pricing judgment context, not silently ignored", async (t) => {
  // Mirrors strategyAnalyst.ts's equivalent regression test -- same live
  // incident pattern, confirmed for Finance's own context reconstruction.
  mockFetch(t, { requiredNextAction: "The evidence is client-estimated (management estimate from the CEO and BDM) -- classify evidence_type as client_estimated." });
  const env = fakeEnv();
  let capturedUserPrompt = "";
  env.AI = {
    run: async (_model: any, opts: any) => {
      capturedUserPrompt = String(opts?.messages?.[1]?.content ?? "");
      return { response: JSON.stringify(SUFFICIENT_JUDGEMENT) };
    },
  } as any;
  const state = fakeState();

  await handlePickup(env, state);

  assert.match(capturedUserPrompt, /classify evidence_type as client_estimated/, "guidance written into Required Next Action must reach the pricing judgment input");
});

test("L. Finance pricing -- sufficient evidence produces a quote and rationale without budget/WTP as the basis", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_JUDGEMENT);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "awaiting_quote_approval");
  assert.ok(result.quote, "a quote must be attached to state");
  assert.strictEqual(result.quote!.price, 15000);
  assert.ok(result.quote!.rationale.length > 0);
  assert.ok(!/budget|willingness[\s-]?to[\s-]?pay/i.test(result.quote!.rationale));
});

test("M. PPP protection -- rationale invoking a PPP multiplier is deterministically blocked despite sufficient: true", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_JUDGEMENT,
    rationale: "Applied a PPP multiplier to adjust the international benchmark price for the local market.",
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held", "a PPP-based rationale must never produce a quote, regardless of sufficient: true");
  const patch = lastHandoffPatch(log);
  assert.strictEqual(patch.properties.Status.select.name, "Held");
  assert.match(openQuestionsText(patch), /purchasing power parity|ppp/i);
});

test("N. Universal-percentage protection -- a fixed percentage-of-value rationale is deterministically blocked", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_JUDGEMENT,
    rationale: "Priced at 15% of the value at stake, per standard practice.",
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held");
  const patch = lastHandoffPatch(log);
  assert.match(openQuestionsText(patch), /percentage/i);
});

test("O. Currency-conversion protection -- currency conversion presented as pricing authority is deterministically blocked", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_JUDGEMENT,
    rationale: "Converted the currency to set the price using today's exchange rate as the pricing basis.",
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held");
  const patch = lastHandoffPatch(log);
  assert.match(openQuestionsText(patch), /currency conversion/i);
});

test("Budget/WTP-as-basis protection -- a rationale that admits using budget as the price is deterministically blocked", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_JUDGEMENT,
    rationale: "Used the client's disclosed budget as the price since it fell within a reasonable range.",
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held");
  const patch = lastHandoffPatch(log);
  assert.match(openQuestionsText(patch), /budget/i);
});

test("P. Diagnosis-first pricing -- a defined diagnostic can be priced without a predetermined downstream intervention", async (t) => {
  mockFetch(t, { verifiedFacts: "Proposed intervention: Diagnostic positioning review (no downstream intervention selected yet). Value context: GHS 8M-12M opportunity, client-estimated." });
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_JUDGEMENT,
    intervention_assessment: "Diagnostic positioning review: commercial question is why larger-account conversion lags; expected output is a diagnostic report with recommended next steps. No downstream intervention has been selected, and none is required to price this diagnostic.",
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "awaiting_quote_approval", "a diagnostic-only engagement must be priceable without a chosen downstream intervention");
  assert.ok(result.quote);
});

test("Deterministic validation overrides sufficient: true when value-at-stake is assumption-only", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({
    ...SUFFICIENT_JUDGEMENT,
    value_at_stake: { ...SUFFICIENT_JUDGEMENT.value_at_stake, evidence_type: "assumption" },
  });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held", "the AI must not be able to force a quote through sufficient: true when its own value-at-stake is assumption-only");
  const patch = lastHandoffPatch(log);
  assert.match(openQuestionsText(patch), /assumption/i);
});

test("Deterministic validation overrides sufficient: true when no positive price is present", async (t) => {
  mockFetch(t);
  const env = fakeEnv();
  env.AI = fakeAi({ ...SUFFICIENT_JUDGEMENT, price: -5 });
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.stage, "handoff_held");
});

// ============================================================================
// validateFinanceJudgement -- direct unit tests for the deterministic gate
// ============================================================================

test("validateFinanceJudgement: rejects null judgement", () => {
  assert.strictEqual(validateFinanceJudgement(null).valid, false);
});

test("validateFinanceJudgement: rejects missing currency", () => {
  const result = validateFinanceJudgement({
    sufficient: true,
    value_at_stake: { value: 10000, period: "annual", evidence_type: "client_estimated", source: "Client-stated" },
    intervention_assessment: "Diagnostic.",
    price: 5000,
    rationale: "Rationale.",
  } as any);
  assert.strictEqual(result.valid, false);
  if (!result.valid) assert.match(result.reason, /currency/i);
});

test("validateFinanceJudgement: rejects missing intervention identification", () => {
  const result = validateFinanceJudgement({
    sufficient: true,
    value_at_stake: { value: 10000, currency: "USD", period: "annual", evidence_type: "client_estimated", source: "Client-stated" },
    price: 5000,
    rationale: "Rationale.",
  } as any);
  assert.strictEqual(result.valid, false);
  if (!result.valid) assert.match(result.reason, /intervention/i);
});

test("validateFinanceJudgement: rejects missing rationale", () => {
  const result = validateFinanceJudgement({
    sufficient: true,
    value_at_stake: { value: 10000, currency: "USD", period: "annual", evidence_type: "client_estimated", source: "Client-stated" },
    intervention_assessment: "Diagnostic.",
    price: 5000,
    currency: "USD",
  } as any);
  assert.strictEqual(result.valid, false);
  if (!result.valid) assert.match(result.reason, /rationale/i);
});

test("validateFinanceJudgement: rejects a quoted price with no top-level currency stated", () => {
  const result = validateFinanceJudgement({
    sufficient: true,
    value_at_stake: { value: 10000, currency: "GHS", period: "annual", evidence_type: "client_estimated", source: "Client-stated" },
    intervention_assessment: "Diagnostic.",
    price: 5000,
    rationale: "Rationale.",
  } as any);
  assert.strictEqual(result.valid, false);
  if (!result.valid) assert.match(result.reason, /currency/i);
});

test("validateFinanceJudgement: accepts a fully complete, policy-compliant judgement", () => {
  const result = validateFinanceJudgement(SUFFICIENT_JUDGEMENT as any);
  assert.strictEqual(result.valid, true);
});

// ============================================================================
// Handoff pickup idempotency (Sales -> Strategy -> Finance flow)
// ============================================================================

test("Finance pickup refuses a Handoff that is already Picked-up", async (t) => {
  const log = mockFetch(t, { initialStatus: "Picked-up" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_JUDGEMENT);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.quote, undefined, "must not process a Handoff that isn't genuinely Pending");
  assert.strictEqual(log.handoffPatchBodies.length, 0, "no Notion write should occur -- refused before any processing");
});

test("Finance pickup refuses an already-Closed Handoff", async (t) => {
  const log = mockFetch(t, { initialStatus: "Closed" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_JUDGEMENT);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.quote, undefined);
  assert.strictEqual(log.handoffPatchBodies.length, 0);
});

test("Finance pickup refuses a Held Handoff (no explicit retry to Pending)", async (t) => {
  const log = mockFetch(t, { initialStatus: "Held" });
  const env = fakeEnv();
  env.AI = fakeAi(SUFFICIENT_JUDGEMENT);
  const state = fakeState();

  const result = await handlePickup(env, state);

  assert.strictEqual(result.quote, undefined);
  assert.strictEqual(log.handoffPatchBodies.length, 0);
});

test("handleQuoteApproval: proceeds normally and creates the Finance -> Sales Handoff when matterName is already present", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const state = fakeState({
    stage: "awaiting_quote_approval",
    entityToken: "E-47",
    matterToken: "M-12",
    quote: { price: 100000, rationale: "Value-based rationale." },
  });

  const result = await handleQuoteApproval(env, state, true);

  assert.strictEqual(result.stage, "quote_approved");
  assert.ok(log.handoffCreateBody, "the Finance -> Sales Handoff must be created");
  assert.strictEqual(log.handoffCreateBody.properties["To Unit"].select.name, "Sales");
  assert.strictEqual(log.handoffCreateBody.properties.Matter_Token.rich_text[0].text.content, "M-12");
});

test("19. Finance -> Sales creates a token-only Handoff -- the title and Reason never expose the Matter name, only Matter_Token", async (t) => {
  const log = mockFetch(t);
  const env = fakeEnv();
  const state = fakeState({
    stage: "awaiting_quote_approval",
    entityToken: "E-47",
    matterToken: "M-12",
    quote: { price: 100000, currency: "GHS", rationale: "Value-based rationale." },
  });

  const result = await handleQuoteApproval(env, state, true);

  const props = log.handoffCreateBody.properties;
  assert.strictEqual(props.Entity_Token.rich_text[0].text.content, "E-47");
  assert.strictEqual(props.Matter_Token.rich_text[0].text.content, "M-12");
  assert.match(props.Handoff.title[0].text.content, /M-12/);
  assert.match(props.Reason.rich_text[0].text.content, /M-12/);
  assert.strictEqual(result.pendingHandoffAutoCheck, true, "successful Finance -> Sales Handoff creation must automatically invoke the existing /checkhandoffs path");
});

test("Finance -> Sales: quote approval blocked on a missing Matter_Token must not invoke the /checkhandoffs continuation", async (t) => {
  const env = fakeEnv();
  const state = fakeState({
    stage: "awaiting_quote_approval",
    entityToken: "E-20",
    matterToken: undefined,
    quote: { price: 420000, rationale: "Value-based rationale." },
  });
  mockFetch(t, { matterToken: "" });

  const result = await handleQuoteApproval(env, state, true);

  assert.notStrictEqual(result.pendingHandoffAutoCheck, true, "no Handoff was queued (still blocked on Matter_Token), so the continuation must not be invoked");
});

test("handleQuoteApproval: recovers a Matter_Token that was corrected in Notion after pickup, and completes the retry", async (t) => {
  // Reproduces the live incident: the ORIGINATING Handoff's Matter_Token was
  // empty at Finance pickup time (state.matterName cached as undefined), so
  // the first Approve attempt blocked. Martin then corrects Matter_Token on
  // the live Notion record and clicks Approve again (the documented retry
  // path) -- this must now succeed rather than blocking forever, since
  // nothing about the in-memory WorkState could otherwise ever change.
  // The live Notion record now carries the corrected Matter_Token ("MAT-20")
  // -- as it would after Martin edits the Handoff and clicks Approve again,
  // a fresh invocation of handleQuoteApproval with its own live re-fetch.
  const log = mockFetch(t, { matterToken: "MAT-20" });
  const env = fakeEnv();
  const state = fakeState({
    stage: "awaiting_quote_approval",
    entityToken: "E-20",
    matterToken: undefined,
    quote: { price: 420000, rationale: "Value-based rationale." },
  });

  const result = await handleQuoteApproval(env, state, true);

  assert.strictEqual(result.stage, "quote_approved", "the retry must succeed once Matter_Token is present on the live record");
  assert.ok(log.handoffCreateBody, "the Finance -> Sales Handoff must be created once recovered");
  assert.strictEqual(log.handoffCreateBody.properties.Matter_Token.rich_text[0].text.content, "MAT-20");
});

test("handleQuoteApproval: stays blocked (not a silent failure) when Matter_Token is still missing on re-check", async (t) => {
  const log = mockFetch(t, { matterToken: "" });
  const env = fakeEnv();
  const state = fakeState({
    stage: "awaiting_quote_approval",
    entityToken: "E-20",
    matterToken: undefined,
    quote: { price: 420000, rationale: "Value-based rationale." },
  });

  const result = await handleQuoteApproval(env, state, true);

  assert.strictEqual(result.stage, "awaiting_quote_approval", "stage must not silently advance when still blocked");
  assert.strictEqual(log.handoffCreateBody, null, "no Finance -> Sales Handoff may be created without a Matter_Token");
  assert.ok(log.sentTexts.some((t) => /no Matter_Token on record/i.test(t)));
});
