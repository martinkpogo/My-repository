import test from "node:test";
import assert from "node:assert";
import {
  marketingManifest,
  handleTransitionApproval,
  handleDraftApproval,
  handlePaidMediaApproval,
  handleMarketingFeedback,
  handleMarketingClarification,
  handleClarifyAnswer,
  handleClarifyMore,
  handleClarifyMoreReply,
  dispatchMarketingHat,
  MARKET_TRANSITION_CALLBACK_PREFIX,
  MARKET_DRAFT_CALLBACK_PREFIX,
  MARKET_PAID_CALLBACK_PREFIX,
  MARKET_CLARIFY_CALLBACK,
  MARKET_CLARIFY_MORE_CALLBACK,
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

test("marketingManifest: every Hat declares markettransition, marketdraft, marketpaid, marketredo plus marketclarify and marketclarifymore in callbackHandlers, all pointing to their shared handlers", () => {
  for (const hat of Object.values(marketingManifest.hats)) {
    assert.deepStrictEqual(
      new Set(Object.keys(hat.callbackHandlers ?? {})),
      new Set([MARKET_TRANSITION_CALLBACK_PREFIX, MARKET_DRAFT_CALLBACK_PREFIX, MARKET_PAID_CALLBACK_PREFIX, "marketredo", MARKET_CLARIFY_CALLBACK, MARKET_CLARIFY_MORE_CALLBACK]),
    );
    assert.strictEqual(hat.callbackHandlers?.[MARKET_TRANSITION_CALLBACK_PREFIX], handleTransitionApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_DRAFT_CALLBACK_PREFIX], handleDraftApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_PAID_CALLBACK_PREFIX], handlePaidMediaApproval);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_CLARIFY_CALLBACK], handleClarifyAnswer);
    assert.strictEqual(hat.callbackHandlers?.[MARKET_CLARIFY_MORE_CALLBACK], handleClarifyMore);
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

test("marketingManifest: awaitingHandlers registers marketing_feedback, marketing_clarification and marketing_clarify_more on every Hat", () => {
  for (const [hatName, hat] of Object.entries(marketingManifest.hats)) {
    assert.deepStrictEqual(
      Object.keys(hat.awaitingHandlers).sort(),
      ["marketing_clarification", "marketing_clarify_more", "marketing_feedback"],
      `${hatName} must register Marketing's continuation states`,
    );
    // Identity assertions: each entry IS the same function the old
    // handleTextReply switch case called -- same body, same arguments.
    assert.strictEqual(hat.awaitingHandlers.marketing_feedback, handleMarketingFeedback, `${hatName}: feedback identity`);
    assert.strictEqual(hat.awaitingHandlers.marketing_clarification, handleMarketingClarification, `${hatName}: clarification identity`);
    assert.strictEqual(hat.awaitingHandlers.marketing_clarify_more, handleClarifyMoreReply, `${hatName}: clarify-more identity`);
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
// Clarify questions one at a time, with suggested answers as buttons
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

test("Clarify: suggested answers come through as tap buttons, and typing an answer still works", async (t) => {
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
  const keyboard = JSON.parse(sentTexts.find((s) => s.includes("marketclarify:work-1:0"))!);
  assert.deepStrictEqual(keyboard, [
    [{ text: "$5k", callback_data: "marketclarify:work-1:0" }],
    [{ text: "$10k", callback_data: "marketclarify:work-1:1" }],
    [{ text: "$20k", callback_data: "marketclarify:work-1:2" }],
  ]);
  assert.ok(sentTexts.some((s) => s.includes("Hat: Marketing Strategist.\n\nWhat is the budget?")));
  assert.ok(sentTexts.some((s) => s.includes("Tap an answer above, or type your own answer below.")));

  // Tapping a suggested answer appends it and re-runs the Hat.
  const answered = await handleClarifyAnswer(env, out, false, "1");
  assert.deepStrictEqual(answered.marketing?.pendingClarification, undefined);
  assert.ok(answered.marketing?.taskText!.includes("Martin's answer: $10k"));
  assert.strictEqual(answered.stage, "awaiting_marketing_draft_approval");

  // A typed answer is treated exactly like a picked one.
  const typed = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy for SMEs." } });
  const clarified = await dispatchMarketingHat(env, typed);
  await handleMarketingClarification(env, clarified, "My own answer: $15k.");
  assert.deepStrictEqual(clarified.marketing?.pendingClarification, undefined);
  assert.ok(clarified.marketing?.taskText!.includes("Additional detail: My own answer: $15k."));
});

test("Clarify more: after one answered question, the Hat asks once whether it may ask one more", async (t) => {
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
          return { response: JSON.stringify({ action: "clarify", reason: "What is the budget?", suggestedAnswers: ["$5k", "$10k"] }) };
        }
        if (aiCalls === 2) {
          return { response: JSON.stringify({ action: "clarify", reason: "Which region?", suggestedAnswers: ["US", "EU"] }) };
        }
        return { response: JSON.stringify({ action: "draft", draft: "Drafted with the best assumption stated plainly." }) };
      },
    } as any,
  });

  const state = fakeWorkState({ marketing: { taskText: "Draft a campaign strategy for SMEs." } });
  let out = await dispatchMarketingHat(env, state);
  assert.strictEqual(out.stage, "marketing_ambiguous");
  assert.strictEqual(out.awaiting, "marketing_clarification");

  // Answer the first question: the Hat still needs something, so it asks
  // once whether one more question may be asked (the gate).
  out = await handleClarifyAnswer(env, out, false, "0");
  assert.strictEqual(out.stage, "marketing_ambiguous");
  assert.strictEqual(out.awaiting, "marketing_clarify_more");
  assert.deepStrictEqual(out.marketing?.pendingClarification, { question: "Which region?", suggestedAnswers: ["US", "EU"], questionCount: 2 });
  assert.deepStrictEqual(JSON.parse(sentTexts.find((s) => s.includes("marketclarifymore:work-1:ask"))!), [
    [{ text: "Ask it", callback_data: "marketclarifymore:work-1:ask" }],
    [{ text: "Skip and draft now", callback_data: "marketclarifymore:work-1:skip" }],
  ]);
  assert.ok(sentTexts.some((s) => s.includes("May I ask it, or should I skip it and draft with my best assumption?")));

  // "Ask it" asks the held question with its suggested answers, one at a time.
  out = await handleClarifyMore(env, out, false, "ask");
  assert.strictEqual(out.stage, "marketing_ambiguous");
  assert.strictEqual(out.awaiting, "marketing_clarification");
  assert.deepStrictEqual(out.marketing?.pendingClarification, { question: "Which region?", suggestedAnswers: ["US", "EU"], questionCount: 2 });
  assert.deepStrictEqual(JSON.parse(sentTexts.find((s) => s.includes('"US"'))!), [
    [{ text: "US", callback_data: "marketclarify:work-1:0" }],
    [{ text: "EU", callback_data: "marketclarify:work-1:1" }],
  ]);
  assert.ok(sentTexts.some((s) => s.includes("Which region?")));

  // Answering the second question re-runs the Hat, which now drafts -- a
  // third clarify would cap at draft-with-best-assumption instead.
  out = await handleClarifyAnswer(env, out, false, "0");
  assert.deepStrictEqual(out.marketing?.pendingClarification, undefined);
  assert.ok(out.marketing?.taskText!.includes("Martin's answer: US"));
  assert.strictEqual(out.stage, "awaiting_marketing_draft_approval");

  // "Skip and draft now" on a fresh gate: drafts with the best assumption stated plainly.
  const skipState = fakeWorkState({
    stage: "marketing_ambiguous",
    marketing: { taskText: "Draft a campaign strategy.", pendingClarification: { question: "Which region?", suggestedAnswers: ["US", "EU"], questionCount: 2 }, clarificationCount: 2 },
  });
  const skipped = await handleClarifyMore(env, skipState, false, "skip");
  assert.deepStrictEqual(skipped.marketing?.pendingClarification, undefined);
  assert.ok(skipped.marketing?.taskText!.includes("Martin skipped the clarification. Draft with your best assumption and state that assumption plainly in the draft."));
  assert.strictEqual(skipped.stage, "awaiting_marketing_draft_approval");
});

test("Clarify more reply: typing during the gate is nudged to tap a button", async (t) => {
  const { sentTexts } = clarifyFetchMock(t);
  const env = fakeEnv({
    TELEGRAM_BOT_TOKEN: "t",
  } as any);
  const state = fakeWorkState({ stage: "marketing_ambiguous", awaiting: "marketing_clarify_more" });
  const out = await handleClarifyMoreReply(env, state, "whatever I type");
  assert.strictEqual(out, state);
  assert.ok(sentTexts.some((s) => s.includes("Please tap 'Ask it' or 'Skip and draft now'.")));
});

test("Clarify answer taps are safe no-ops when nothing is pending", async (t) => {
  clarifyFetchMock(t);
  const env = fakeEnv({ TELEGRAM_BOT_TOKEN: "t" } as any);
  const state = fakeWorkState({ stage: "marketing_ambiguous" });
  const out = await handleClarifyAnswer(env, state, false, "0");
  assert.strictEqual(out, state);
  const outMore = await handleClarifyMore(env, state, false, "ask");
  assert.strictEqual(outMore, state);
});
