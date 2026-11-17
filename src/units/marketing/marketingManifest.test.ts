import test from "node:test";
import assert from "node:assert";
import {
  dispatchMarketingHat,
  marketingManifest,
  handleTransitionApproval,
  handleDraftApproval,
  handlePaidMediaApproval,
  handleMarketingFeedback,
  handleMarketingClarification,
  handleClarifyAnswer,
  MARKET_TRANSITION_CALLBACK_PREFIX,
  MARKET_DRAFT_CALLBACK_PREFIX,
  MARKET_PAID_CALLBACK_PREFIX,
  MARKET_CLARIFY_CALLBACK,
} from "./marketingManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers marketingManifest.ts's own declared contract that marketingManifest.ts
 * itself contributes on top of the relocated, already-live behaviour
 * (runMarketingHat/handleTransitionApproval's decision/routing logic is
 * unchanged, relocated verbatim from executionEngine.ts -- no existing
 * coverage of that logic exists yet, and re-testing it here is out of
 * scope for this file). This file tests only the manifest/Hat shape and
 * the callback-dispatch mechanism (HatManifest.callbackHandlers,
 * introduced by PRs #203-206) -- that every Marketing Hat declares
 * markettransition/marketdraft/marketpaid, and that findCallbackHandler's
 * resolved handler genuinely reaches handleTransitionApproval's/
 * handleDraftApproval's/handlePaidMediaApproval's real logic.
 */

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    MARTIN_TELEGRAM_USER_ID: "9999",
    STATE_KV: {
      get: async () => null,
      put: async () => {},
    } as any,
    ...overrides,
  } as Env;
}

function fakeWorkState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-1",
    chatId: 12345,
    threadId: 777,
    unit: "Marketing",
    hat: "Marketing Strategist",
    ...overrides,
  } as WorkState;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in marketingManifest test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("marketingManifest: declares all five Marketing Hats", () => {
  assert.strictEqual(marketingManifest.unit, "Marketing");
  assert.deepStrictEqual(
    new Set(Object.keys(marketingManifest.hats)),
    new Set(["Marketing Strategist", "Campaign & Marketing Communications Manager", "Content Strategist", "Content Manager", "Digital Marketer"]),
  );
});

test("marketingManifest: every Hat declares exactly markettransition, marketdraft, marketpaid, marketredo and marketclarify in callbackHandlers, all pointing to their shared handlers", () => {
  for (const hat of Object.values(marketingManifest.hats)) {
    assert.deepStrictEqual(
      new Set(Object.keys(hat.callbackHandlers ?? {})),
      new Set([MARKET_TRANSITION_CALLBACK_PREFIX, MARKET_DRAFT_CALLBACK_PREFIX, MARKET_CLARIFY_CALLBACK, MARKET_PAID_CALLBACK_PREFIX, "marketredo"]),
    );
    assert.strictEqual(hat.callbackHandlers?.[MARKET_TRANSITION_CALLBACK_PREFIX], handleTransitionApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_DRAFT_CALLBACK_PREFIX], handleDraftApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_CLARIFY_CALLBACK], handleClarifyAnswer);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_PAID_CALLBACK_PREFIX], handlePaidMediaApproval);
  }
});

test("findCallbackHandler resolves markettransition on Marketing Strategist and genuinely delegates to handleTransitionApproval -- rejecting a pending transition discards it and holds on marketing_feedback, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    marketing: { pendingTransition: { toHat: "Digital Marketer", reason: "Needs paid media expertise" } },
  });

  const hat = marketingManifest.hats["Marketing Strategist"];
  const handler = findCallbackHandler(MARKET_TRANSITION_CALLBACK_PREFIX, hat);
  assert.ok(handler, "markettransition must resolve on Marketing Strategist's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.marketing?.pendingTransition, undefined);
  assert.strictEqual(result.awaiting, "marketing_feedback");
  assert.strictEqual(result.hat, "Marketing Strategist", "must not commit the Hat transition on rejection");
});

test("findCallbackHandler resolves marketdraft on Marketing Strategist and genuinely delegates to handleDraftApproval -- rejecting a pending draft holds on marketing_feedback without closing the stage, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    stage: "awaiting_marketing_draft_approval",
    marketing: { draft: "Some drafted output" },
  });

  const hat = marketingManifest.hats["Marketing Strategist"];
  const handler = findCallbackHandler(MARKET_DRAFT_CALLBACK_PREFIX, hat);
  assert.ok(handler, "marketdraft must resolve on Marketing Strategist's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.awaiting, "marketing_feedback");
  assert.strictEqual(result.stage, "awaiting_marketing_draft_approval", "must not advance to complete on rejection");
  assert.strictEqual(result.marketing?.draft, "Some drafted output", "must not discard the draft on rejection -- only on approval");
});

test("findCallbackHandler resolves marketpaid on Digital Marketer and genuinely delegates to handlePaidMediaApproval -- rejecting a pending spend action discards it and holds on marketing_feedback without closing the stage, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const env = fakeEnv();
  const state = fakeWorkState({
    hat: "Digital Marketer",
    stage: "awaiting_paid_media_approval",
    marketing: { pendingPaidMediaAction: { description: "Boost a Facebook post, $200 budget" } },
  });

  const hat = marketingManifest.hats["Digital Marketer"];
  const handler = findCallbackHandler(MARKET_PAID_CALLBACK_PREFIX, hat);
  assert.ok(handler, "marketpaid must resolve on Digital Marketer's own manifest entry");

  const result = await handler(env, state, false);

  assert.strictEqual(result.marketing?.pendingPaidMediaAction, undefined);
  assert.strictEqual(result.awaiting, "marketing_feedback");
  assert.strictEqual(result.stage, "awaiting_paid_media_approval", "must not advance to complete on rejection");
});

test("marketingManifest: awaitingHandlers registers marketing_feedback and marketing_clarification on every Hat", () => {
  for (const [hatName, hat] of Object.entries(marketingManifest.hats)) {
    assert.deepStrictEqual(
      Object.keys(hat.awaitingHandlers).sort(),
      ["marketing_clarification", "marketing_feedback"],
      `${hatName} must register exactly Marketing's two continuation states`,
    );
    // Identity assertions: each entry IS the same function the old
    // handleTextReply switch case called -- same body, same arguments.
    assert.strictEqual(hat.awaitingHandlers.marketing_feedback, handleMarketingFeedback, `${hatName}: feedback identity`);
    assert.strictEqual(hat.awaitingHandlers.marketing_clarification, handleMarketingClarification, `${hatName}: clarification identity`);
  }
});

// ---------------------------------------------------------------------------
// Live work status (src/runtime/workStatus.ts) for a Marketing Hat run.
// ---------------------------------------------------------------------------

function mockHatRunFetch(t: any): string[] {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("api.telegram.org")) {
      sentTexts.push(JSON.parse(init.body).text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (u.includes("/blocks/") && u.includes("/children")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }), { status: 200 });
    }
    if (method === "GET" && u.includes("/v1/pages/")) {
      const id = u.split("/v1/pages/").pop()!.split("?")[0];
      return new Response(JSON.stringify({ id, url: u, parent: { type: "page", page_id: "governance-root" }, properties: {} }), { status: 200 });
    }
    if (method === "POST" && u.endsWith("/v1/pages")) {
      return new Response(JSON.stringify({ id: "log", url: "https://notion.so/log", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in marketingManifest status test: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return sentTexts;
}

test("Status: a Marketing Hat run shows its real steps and ends on the draft awaiting approval", async (t) => {
  const sentTexts = mockHatRunFetch(t);
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: { run: async () => ({ response: JSON.stringify({ action: "draft", draft: "A positioning brief draft." }) }) } as any,
  });

  await handleMarketingFeedback(env, fakeWorkState({ marketing: { taskText: "Draft a positioning brief for MAT-9." } }), "Make it shorter.");

  const final = sentTexts.filter((s) => s.startsWith("Hat: Marketing Strategist.\n\n🧭")).at(-1)!;
  let at = -1;
  for (const step of [
    "✓ Loading the Universal Role Contract from Notion",
    "✓ Deciding within Marketing Strategist's ownership: draft, route to another Hat, or ask for clarification",
    "✅ Draft ready below -- awaiting your approval.",
  ]) {
    const next = final.indexOf(step);
    assert.ok(next > at, `"${step}" in order, in:\n${final}`);
    at = next;
  }
});

test("decision order (Martin, 2026-11-17): route, then the contract's understand_before_producing question, then a draft that uses the research -- pointed to by name, never restated", async () => {
  const { buildHatPromptParts, MARKETING_DECISION_FORMAT } = await import("./marketingManifest");
  const { MARKETING_HAT_REGISTRY } = await import("../../hats/registry");
  for (const hat of Object.values(MARKETING_HAT_REGISTRY)) {
    assert.ok(buildHatPromptParts(hat, "contract").context!.includes(MARKETING_DECISION_FORMAT), hat.name);
  }
  const route = MARKETING_DECISION_FORMAT.indexOf('"action":"route"');
  const clarify = MARKETING_DECISION_FORMAT.indexOf('"action":"clarify"');
  const draft = MARKETING_DECISION_FORMAT.indexOf('"action":"draft"');
  assert.ok(route >= 0 && route < clarify && clarify < draft, "the question is considered before a draft, not only when the Hat cannot proceed");
  assert.match(MARKETING_DECISION_FORMAT, /understand_before_producing/);
  assert.match(MARKETING_DECISION_FORMAT, /evidence_over_generalities/);
  assert.match(MARKETING_DECISION_FORMAT, /source link exactly as given/);
  assert.match(MARKETING_DECISION_FORMAT, /never ask again what they answer/);
  assert.match(MARKETING_DECISION_FORMAT, /that's enough questions, do not ask/);
  assert.doesNotMatch(MARKETING_DECISION_FORMAT, /budget|timeframe|capacity/i, "the questions themselves come from the live Notion rule, not from code");
});

test("problem brief (Martin, 2026-11-13): every Marketing Hat's instructions carry the seven-part shape, used only with web research, never naming a company", async () => {
  const { buildHatPromptParts, MARKETING_PROBLEM_BRIEF_FORMAT } = await import("./marketingManifest");
  const { MARKETING_HAT_REGISTRY } = await import("../../hats/registry");
  for (const hat of Object.values(MARKETING_HAT_REGISTRY)) {
    assert.ok(buildHatPromptParts(hat, "contract").context!.includes(MARKETING_PROBLEM_BRIEF_FORMAT), hat.name);
  }
  for (const part of ["1. The problem", "2. Evidence", "3. Who has it most", "4. Why it matters", "5. Where ENIG fits", "6. What's still unknown", "7. Recommendation"]) {
    assert.ok(MARKETING_PROBLEM_BRIEF_FORMAT.includes(part), part);
  }
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /AND a WEB RESEARCH block is present/);
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /Never name a company/);
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /Never invent a finding or a source/);
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /no #, \* or other markup/, "headings are plain text -- Telegram showed a literal #");
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /The research did not directly show this problem/, "unsupported evidence is said plainly");
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /Part 7 must give the reason/);
  assert.match(MARKETING_PROBLEM_BRIEF_FORMAT, /If NO WEB RESEARCH block is present, ignore this format: never ask for research/, "without research the Hat drafts normally instead of asking Martin for a research block");
});

test("approving a draft records Martin's approval as Result evidence beside the draft, bound to it by SHA-256 (2026-11-14: the Checker failed criterion 2 on the draft alone)", async (t) => {
  mockTelegramFetch(t);
  const { hashContent } = await import("../../contentHash");
  const draft = "The problem -- SMEs struggle with consistent messaging.";
  const state = fakeWorkState({
    stage: "awaiting_marketing_draft_approval",
    marketing: { draft },
    resultReview: { expectedResult: "A draft approved by Martin", completionCriteria: ["Martin's approval is recorded"], gateStatus: "pending" },
  } as any);
  await handleDraftApproval(fakeEnv(), state, true);
  const evidence = state.resultReview?.evidence ?? [];
  assert.deepStrictEqual(evidence.map((e) => e.kind), ["marketing_output", "operator_approval"]);
  const approval = evidence[1];
  assert.equal(approval.ref, "work-1-approval");
  assert.match(approval.content, /Martin approved work-1-draft at \d{4}-\d\d-\d\dT.*through the verified Approve button/);
  assert.ok(approval.content.includes(await hashContent(draft)), "the approval is bound to the exact approved draft");
  assert.equal(evidence[0].content, draft, "the draft evidence is unchanged");
});

test("approving a paid-media action records the spend approval as Result evidence", async (t) => {
  mockTelegramFetch(t);
  const state = fakeWorkState({
    hat: "Digital Marketer",
    stage: "awaiting_paid_media_approval",
    marketing: { pendingPaidMediaAction: { description: "Boost a Facebook post, $200 budget" } },
    resultReview: { expectedResult: "A paid-media action with spend approval", completionCriteria: ["Spend approval is recorded"], gateStatus: "pending" },
  } as any);
  const { handlePaidMediaApproval } = await import("./marketingManifest");
  await handlePaidMediaApproval(fakeEnv(), state, true);
  assert.deepStrictEqual((state.resultReview?.evidence ?? []).map((e) => e.kind), ["paid_media_action", "spend_approval"]);
  assert.match(state.resultReview!.evidence![1].content, /Martin approved work-1-paid-media/);
});

test("rejecting a draft records no approval evidence", async (t) => {
  mockTelegramFetch(t);
  const state = fakeWorkState({ stage: "awaiting_marketing_draft_approval", marketing: { draft: "x" }, resultReview: { expectedResult: "e", completionCriteria: ["c"], gateStatus: "pending" } } as any);
  await handleDraftApproval(fakeEnv(), state, false);
  assert.equal(state.resultReview?.evidence, undefined);
});

test("option B: Marketing declares continueAfterResearch, and it refuses unless the Work is waiting on research", async () => {
  const { marketingManifest, continueMarketingAfterResearch } = await import("./marketingManifest");
  for (const hat of Object.values(marketingManifest.hats)) assert.strictEqual(typeof hat.continueAfterResearch, "function", hat.name);
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")).text ?? "");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
  try {
    const state = { workId: "w", chatId: 1, stage: "awaiting_marketing_draft_approval", unit: "Marketing", hat: Object.keys(marketingManifest.hats)[0] } as any;
    const out = await continueMarketingAfterResearch({ TELEGRAM_BOT_TOKEN: "t" } as any, state);
    assert.strictEqual(out.stage, "awaiting_marketing_draft_approval");
    assert.deepStrictEqual(sent, [], "no draft or dispatch ran");
  } finally {
    globalThis.fetch = original;
  }
});

test("resuming a held draft never claims research ran: it follows a skip or a failed run as well as a completed one", async () => {
  const { MARKETING_CONTINUE_MESSAGE } = await import("./marketingManifest");
  assert.doesNotMatch(MARKETING_CONTINUE_MESSAGE, /research|complete/i);
});

// ---------------------------------------------------------------------------
// Clarify flow: one question at a time, suggested answers as tap buttons,
// "Type my own answer" always available, "✋ That's enough" from Q6.
// ---------------------------------------------------------------------------

function clarifyFetchMock(t: any): { sentTexts: string[] } {
  const sentTexts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      sentTexts.push(body.text ?? "");
      if (body.reply_markup) sentTexts.push(JSON.stringify(body.reply_markup.inline_keyboard));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (method === "GET" && u.includes("/v1/pages/")) {
      return new Response(JSON.stringify({ id: "x", url: u, parent: { type: "page", page_id: "governance-root" }, properties: {} }), { status: 200 });
    }
    if (u.includes("/blocks/") && u.includes("/children")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }), { status: 200 });
    }
    if (method === "POST" && u.endsWith("/v1/pages")) {
      return new Response(JSON.stringify({ id: "log", url: "https://notion.so/log", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in clarify test: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { sentTexts };
}

test("Clarify: suggested answers come through as tap buttons, plus a 'Type my own answer' button; typing still works", async (t) => {
  const { sentTexts } = clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        if (aiCalls === 1) {
          return { response: JSON.stringify({ action: "clarify", reason: "What is the budget?", suggestedAnswers: ["$5k", "$10k", "$20k"] }) };
        }
        return { response: JSON.stringify({ action: "draft", draft: "Draft with the stated budget assumption." }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy for SMEs." } });
  const out = await dispatchMarketingHat(env, state);

  assert.strictEqual(out.stage, "marketing_ambiguous");
  assert.strictEqual(out.awaiting, "marketing_clarification");
  assert.deepStrictEqual(out.marketing?.pendingClarification, { question: "What is the budget?", suggestedAnswers: ["$5k", "$10k", "$20k"], questionCount: 1 });
  assert.strictEqual(out.marketing?.clarificationCount, 1);
  const keyboard = JSON.parse(sentTexts.find((s) => s.includes("marketclarify:work-1:1.0"))!);
  assert.deepStrictEqual(keyboard, [
    [{ text: "$5k", callback_data: "marketclarify:work-1:1.0" }],
    [{ text: "$10k", callback_data: "marketclarify:work-1:1.1" }],
    [{ text: "$20k", callback_data: "marketclarify:work-1:1.2" }],
    [{ text: "✏️ Type my own answer", callback_data: "marketclarify:work-1:1.type" }],
  ]);
  assert.ok(sentTexts.some((s) => s.includes("What is the budget?")));
  assert.ok(sentTexts.some((s) => s.includes("The buttons are below")));
  assert.ok(sentTexts.some((s) => s.includes("type your answer directly below")));
  assert.ok(!sentTexts.some((s) => s.includes("✋ That's enough")), "question 1 must not have 'That's enough'");

  await handleClarifyAnswer(env, out, false, "1.0");
  assert.strictEqual(out.marketing?.taskText!.includes("Additional detail: $5k"), true);
  assert.strictEqual(out.marketing?.pendingClarification, undefined);
  assert.strictEqual(out.stage, "awaiting_marketing_draft_approval", "hat re-ran and drafted after answer");
});

test("Clarify: no suggested answers means a 'Type my own answer' button only, no 'tap above' wording", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        if (aiCalls === 1) {
          return { response: JSON.stringify({ action: "clarify", reason: "What is the deadline?" }) };
        }
        return { response: JSON.stringify({ action: "draft", draft: "Drafted." }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy for SMEs." } });
  const out = await dispatchMarketingHat(env, state);
  const pc = out.marketing?.pendingClarification;

  assert.ok(pc, "pending clarification should be set");
  assert.deepStrictEqual(pc.question, "What is the deadline?");
  assert.deepStrictEqual(pc.suggestedAnswers, []);
  assert.strictEqual(pc.questionCount, 1);

  // Keyboard has only the type-my-own button.
  const buttons = out.pendingActionSummary?.buttons ?? [];
  assert.deepStrictEqual(buttons, [[{ text: "✏️ Type my own answer", callback_data: "marketclarify:work-1:1.type" }]]);

  // Wording: buttons below, no "tap above", question present.
  const message = out.pendingActionSummary?.message ?? "";
  const hasDeadline = message.includes("What is the deadline?");
  assert.ok(hasDeadline, "question text present");
  const hasTypeBelow = message.includes("type your answer directly below");
  assert.ok(hasTypeBelow, "type-below wording present");
  const hasTapAbove = message.includes("Tap an answer above");
  assert.ok(!hasTapAbove, "no 'tap above' wording when there are no suggested buttons");
  const hasButtonsBelow = message.includes("The buttons are below");
  assert.ok(hasButtonsBelow, "buttons-below wording present");

  await handleMarketingClarification(env, out, "Next Friday.");
  assert.strictEqual(out.marketing?.pendingClarification, undefined);
  assert.ok(out.marketing?.taskText!.includes("Additional detail: Next Friday."));
});

test("Clarify: from the sixth question on there is also a 'That's enough' button", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        const reason = "Missing detail " + aiCalls + "?";
        return { response: JSON.stringify({ action: "clarify", reason, suggestedAnswers: ["A", "B"] }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy." } });
  let out = await dispatchMarketingHat(env, state);
  // Questions 1-5: no "That's enough" button.
  for (let i = 1; i <= 5; i++) {
    const buttons = out.pendingActionSummary?.buttons ?? [];
    const flattened = buttons.flat();
    assert.ok(!flattened.some((b) => b.text === "✋ That's enough"), `question ${i} should not have 'That's enough'`);
    assert.ok(flattened.some((b) => b.text === "✏️ Type my own answer"), `question ${i} should have 'Type my own answer'`);
    out = await handleClarifyAnswer(env, out, false, `${i}.0`);
  }
  // After 5 answers, clarificationCount is 6 (each answer re-runs dispatch
  // which triggers the next question). Question 6 is already pending.
  assert.strictEqual(out.marketing?.clarificationCount, 6);
  const buttons6 = out.pendingActionSummary?.buttons ?? [];
  assert.ok(buttons6.some((row) => row.some((b) => b.text === "✋ That's enough")), "question 6 should have 'That's enough'");
  assert.ok(out.pendingActionSummary?.message.includes('Tap "✋ That\'s enough" to stop questioning'));
});

test("Clarify: tapping 'That's enough' drafts with assumptions stated plainly and sets enoughSaid", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        if (aiCalls === 1) {
          return { response: JSON.stringify({ action: "clarify", reason: "What is the region?", suggestedAnswers: ["US", "EU"] }) };
        }
        return { response: JSON.stringify({ action: "draft", draft: "Draft with regional assumption." }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy." } });
  const out = await dispatchMarketingHat(env, state);
  assert.deepStrictEqual(out.marketing?.enoughSaid, undefined);

  const enoughResult = await handleClarifyAnswer(env, out, false, "1.enough");
  assert.strictEqual(enoughResult.marketing?.enoughSaid, true);
  assert.strictEqual(enoughResult.marketing?.pendingClarification, undefined);
  assert.ok(enoughResult.marketing?.taskText!.includes("Martin said that's enough questions. Draft with what you have and state your assumptions plainly."));
  assert.strictEqual(enoughResult.marketing?.enoughSaid, true);
});

test("Clarify: typing 'enough' works like the 'That's enough' button", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        if (aiCalls === 1) {
          return { response: JSON.stringify({ action: "clarify", reason: "What is the region?", suggestedAnswers: ["US", "EU"] }) };
        }
        return { response: JSON.stringify({ action: "draft", draft: "Drafted with enough." }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy." } });
  const out = await dispatchMarketingHat(env, state);

  const typed = await handleMarketingClarification(env, out, "enough");
  assert.strictEqual(typed.marketing?.enoughSaid, true);
  assert.strictEqual(typed.marketing?.pendingClarification, undefined);
  assert.ok(typed.marketing?.taskText!.includes("Martin said that's enough questions."));
});

test("Clarify: after enoughSaid, if the Hat still asks it stops and says it couldn't draft -- no loop", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        return { response: JSON.stringify({ action: "clarify", reason: "Still missing detail?", suggestedAnswers: ["A", "B"] }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy.", enoughSaid: true } });
  const out = await dispatchMarketingHat(env, state);
  assert.strictEqual(out.marketing?.pendingClarification, undefined);
  assert.strictEqual(out.awaiting, "marketing_feedback", "waits for Martin's note, which redoes the work");
  assert.strictEqual(aiCalls, 1, "the Hat is not re-run -- no loop");
});

test("Clarify: a button left on an earlier question can never answer a newer one", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        return { response: JSON.stringify({ action: "clarify", reason: `Question ${aiCalls}?`, suggestedAnswers: ["A", "B"] }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy." } });
  let out = await dispatchMarketingHat(env, state);
  out = await handleClarifyAnswer(env, out, false, "1.0");
  assert.strictEqual(out.marketing?.pendingClarification?.questionCount, 2);
  const before = out.marketing?.taskText;
  out = await handleClarifyAnswer(env, out, false, "1.1");
  assert.strictEqual(out.marketing?.taskText, before, "the stale tap recorded nothing");
  assert.strictEqual(out.marketing?.pendingClarification?.questionCount, 2, "question 2 is still waiting");
  assert.strictEqual(aiCalls, 2, "the Hat was not re-run");
});

test("Clarify: typing \"that's enough\" works like typing \"enough\"", async (t) => {
  clarifyFetchMock(t);
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: { run: async () => ({ response: JSON.stringify({ action: "draft", draft: "Drafted." }) }) } as any,
  });
  const state = fakeWorkState({
    stage: "marketing_ambiguous",
    awaiting: "marketing_clarification",
    marketing: { taskText: "Draft a campaign strategy.", clarificationCount: 6, pendingClarification: { question: "Region?", suggestedAnswers: ["US"], questionCount: 6 } },
  });
  const out = await handleMarketingClarification(env, state, "That's enough.");
  assert.strictEqual(out.marketing?.enoughSaid, true);
  assert.ok(!out.marketing?.taskText!.includes("Additional detail"));
});

test("Clarify: answer taps are safe no-ops when nothing is pending", async (t) => {
  clarifyFetchMock(t);
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: { run: async () => ({ response: JSON.stringify({ action: "draft", draft: "Drafted." }) }) } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy." } });
  const out = await handleClarifyAnswer(env, state, false, "0");
  assert.strictEqual(out, state, "no-op returns state unchanged");
});

test("Clarify: redo resets the clarification count and enoughSaid", async (t) => {
  clarifyFetchMock(t);
  let aiCalls = 0;
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async () => {
        aiCalls++;
        if (aiCalls === 1) {
          return { response: JSON.stringify({ action: "clarify", reason: "What is the budget?", suggestedAnswers: ["$5k"] }) };
        }
        return { response: JSON.stringify({ action: "draft", draft: "Drafted after redo." }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy." } });
  let out = await dispatchMarketingHat(env, state);
  assert.strictEqual(out.marketing?.clarificationCount, 1);

  out = await handleMarketingFeedback(env, out, "Redo with more detail.");
  assert.strictEqual(out.marketing?.clarificationCount, 0);
  assert.strictEqual(out.marketing?.enoughSaid, undefined);
  assert.strictEqual(out.marketing?.pendingClarification, undefined);
});
