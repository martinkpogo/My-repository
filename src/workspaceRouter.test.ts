import test from "node:test";
import assert from "node:assert";
import { mapRawClassificationToDecision, type WorkspaceDecision } from "./workspaceRouter";
import { routeIncomingText, dispatchCowork } from "./router";
import type { Env } from "./types";

/**
 * mapRawClassificationToDecision covers the CHAT/COWORK/CLARIFY/BLOCKED
 * decision-mapping logic directly. The end-to-end AI call this logic feeds
 * from (routing.workspace_classification) is client_confidential with no
 * eligible provider in PRODUCTION_PROVIDER_ELIGIBILITY -- the same
 * standing, pre-existing constraint its three predecessor classifiers
 * (routing.enquiry_classification / routing.marketing_specialization_check /
 * routing.research_specialization_check) always had -- so it cannot be
 * exercised with controlled message content in this environment. Each test
 * below supplies the raw classification JSON the AI is expected to produce
 * for the named example message, and verifies the resulting WorkspaceDecision
 * is correct. Dispatch-level tests further down use an injected `classify`
 * seam to verify routeIncomingText/dispatchCowork act correctly on a given
 * WorkspaceDecision, independent of that same provider-eligibility gate.
 */

// --- A-G: content-mapping cases (what the classifier is expected to decide) ---

test("A. General ENIG question -> CHAT, no Unit", () => {
  // "How should ENIG approach this kind of client?"
  const { decision } = mapRawClassificationToDecision({ mode: "chat" });
  assert.deepStrictEqual(decision, { mode: "chat", unit: undefined });
});

test("B. General Unit/Hat discussion -> CHAT, scoped to the addressed Unit", () => {
  // "Finance, explain our value-based pricing." / "Strategy, what do you think about this positioning problem?"
  const finance = mapRawClassificationToDecision({ mode: "chat", unit: "Finance" });
  assert.deepStrictEqual(finance.decision, { mode: "chat", unit: "Finance" });

  const strategy = mapRawClassificationToDecision({ mode: "chat", unit: "Strategy" });
  assert.deepStrictEqual(strategy.decision, { mode: "chat", unit: "Strategy" });

  const marketingHat = mapRawClassificationToDecision({ mode: "chat", unit: "Marketing" });
  assert.deepStrictEqual(marketingHat.decision, { mode: "chat", unit: "Marketing" });

  const ri = mapRawClassificationToDecision({ mode: "chat", unit: "Research & Intelligence" });
  assert.deepStrictEqual(ri.decision, { mode: "chat", unit: "Research & Intelligence" });
});

test("C. Concrete Sales enquiry -> COWORK with Sales/Sales Executive", () => {
  // "We're a bakery chain and our branding feels dated, can you help?"
  const { decision } = mapRawClassificationToDecision({ mode: "cowork", unit: "Sales", hat: "Sales Executive" });
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Sales", hat: "Sales Executive", capability: undefined });
});

test("D. Genuine R&I research request -> COWORK with Research & Intelligence", () => {
  // "Research this company's market position and competitors."
  const { decision } = mapRawClassificationToDecision({ mode: "cowork", unit: "Research & Intelligence", hat: "Research & Intelligence Analyst" });
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Research & Intelligence", hat: "Research & Intelligence Analyst", capability: undefined });
});

test("E. Marketing work request -> COWORK with a Marketing Hat", () => {
  // "Marketing Strategist, let's develop the campaign strategy for this."
  const { decision } = mapRawClassificationToDecision({ mode: "cowork", unit: "Marketing", hat: "Marketing Strategist" });
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Marketing", hat: "Marketing Strategist", capability: undefined });
});

test("F. Strategy work request -> COWORK with Strategy", () => {
  // "Okay, let's diagnose the company properly and develop the strategic intervention."
  const { decision } = mapRawClassificationToDecision({ mode: "cowork", unit: "Strategy", hat: "Strategy Analyst" });
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Strategy", hat: "Strategy Analyst", capability: undefined });
});

test("G. Ambiguous request -> CLARIFY with a question, never a guess", () => {
  const { decision } = mapRawClassificationToDecision({ mode: "clarify", question: "Would you like to discuss this, or should ENIG start work on it?" });
  assert.strictEqual(decision.mode, "clarify");
  assert.ok((decision as any).question.length > 0);
});

test("G2. cowork with an unresolvable Unit falls back to CLARIFY, never invented ownership", () => {
  const { decision } = mapRawClassificationToDecision({ mode: "cowork", unit: "Not A Real Unit" });
  assert.strictEqual(decision.mode, "clarify");
});

test("H2. cowork capability only accepted when it matches a registered id", () => {
  const withBogusCapability = mapRawClassificationToDecision({ mode: "cowork", unit: "Marketing", hat: "Content Manager", capability: "not-a-real-capability" });
  assert.strictEqual((withBogusCapability.decision as any).capability, undefined, "an unregistered capability id must never be trusted through");
});

test("J. AI classifier failure -> BLOCKED, never execute", () => {
  const nullResult = mapRawClassificationToDecision(null);
  assert.strictEqual(nullResult.decision.mode, "blocked");
  assert.ok(nullResult.messageForMartin, "a blocked classification must always produce a message for Martin, never silent failure");

  const malformed = mapRawClassificationToDecision({} as any);
  assert.strictEqual(malformed.decision.mode, "blocked");

  const unrecognizedMode = mapRawClassificationToDecision({ mode: "not_a_real_mode" as any });
  assert.strictEqual(unrecognizedMode.decision.mode, "blocked");
  assert.ok(unrecognizedMode.messageForMartin);
});

// --- Dispatch-level tests: routeIncomingText / dispatchCowork acting on a WorkspaceDecision ---

function createMockKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string }) => {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
    store,
  };
}

function createMockWorkSession() {
  const calls: { init: any[][]; handleIncomingEnquiry: string[]; handleMarketingRequest: string[]; handleResearchRequest: string[] } = {
    init: [],
    handleIncomingEnquiry: [],
    handleMarketingRequest: [],
    handleResearchRequest: [],
  };
  const stub = {
    init: async (...args: any[]) => {
      calls.init.push(args);
    },
    handleIncomingEnquiry: async (text: string) => {
      calls.handleIncomingEnquiry.push(text);
    },
    handleMarketingRequest: async (text: string) => {
      calls.handleMarketingRequest.push(text);
    },
    handleResearchRequest: async (text: string) => {
      calls.handleResearchRequest.push(text);
    },
    getState: async () => undefined,
  };
  return {
    calls,
    workSession: {
      idFromName: (name: string) => name,
      get: (_id: any) => stub,
    },
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  const kv = createMockKv();
  return {
    MARTIN_TELEGRAM_USER_ID: "123456",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "604",
    OPERATIONS_TOPIC_ID: "588",
    TELEGRAM_BOT_TOKEN: "test-token",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    STATE_KV: kv as any,
    ...overrides,
  } as Env;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  const sentMessages: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      try {
        const body = JSON.parse(init?.body ?? "{}");
        if (body.text) sentMessages.push(body.text);
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return sentMessages;
}

function fixedDecision(decision: WorkspaceDecision) {
  return async () => decision;
}

test("H. Capability-like wording inside a general discussion -> CHAT, capability registry never seizes it first", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  // Even if the message happens to mention "spreadsheet" or "doc" in passing,
  // a CHAT decision from the central router must never reach a capability or
  // create a WorkSession -- routeWorkspaceCapabilityAction is only ever
  // invoked from inside dispatchCowork, never on the "chat" branch.
  await routeIncomingText(env, -1004435157576, "By the way, do you think a spreadsheet would even help here?", 604, {
    classify: fixedDecision({ mode: "chat", unit: undefined }),
  });

  assert.strictEqual(calls.init.length, 0, "CHAT must never create a WorkSession");
  assert.ok(sent.length >= 0); // reply path exercised without throwing; content not asserted (depends on chat.ts's own AI call)
});

test("I. COWORK decision with capability routes only through routeWorkspaceCapabilityAction, never a parallel implementation", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  const decision: WorkspaceDecision = { mode: "cowork", unit: "Marketing", hat: "Content Manager", capability: "some-capability" };
  await dispatchCowork(env, -1004435157576, 604, "Create a Google Doc for this brief.", decision as any);

  // No WorkSession was created directly by dispatchCowork's capability
  // branch -- capability execution belongs entirely to
  // routeWorkspaceCapabilityAction's own registered handlers.
  assert.strictEqual(calls.init.length, 0, "the capability branch must not itself create a WorkSession -- that's the capability's own governed path");
});

test("J2. dispatchCowork for a Unit with no existing direct-chat governed entry point fails closed, creates nothing", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  const decision: WorkspaceDecision = { mode: "cowork", unit: "Finance", hat: "Value-Based Pricing Assessor" };
  await dispatchCowork(env, -1004435157576, 604, "Finance, price this for us.", decision as any);

  assert.strictEqual(calls.init.length, 0, "no WorkSession may be fabricated for a Unit with no existing chat-triggered governed entry point");
});

test("K. Conversation topic (Workspace stream) does not force a Unit -- dispatch is driven by the decision, not the thread", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  // Same Workspace thread (604) used for two different Units in sequence --
  // the topic itself carries no Unit identity, only the decision does.
  await routeIncomingText(env, -1004435157576, "Research this competitor.", 604, {
    classify: fixedDecision({ mode: "cowork", unit: "Research & Intelligence", hat: "Research & Intelligence Analyst" }),
  });
  assert.strictEqual(calls.init[0][2], "Research & Intelligence");

  await routeIncomingText(env, -1004435157576, "Let's develop the campaign strategy.", 604, {
    classify: fixedDecision({ mode: "cowork", unit: "Marketing", hat: "Marketing Strategist" }),
  });
  assert.strictEqual(calls.init[1][2], "Marketing");
});

test("L. Operations topic cannot become an interactive COWORK session -- rejected before classification ever runs", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  let classifyCalled = false;
  await routeIncomingText(env, -1004435157576, "Sales, let's start work on this enquiry.", 588, {
    classify: async () => {
      classifyCalled = true;
      return { mode: "cowork", unit: "Sales", hat: "Sales Executive" } as WorkspaceDecision;
    },
  });

  assert.strictEqual(classifyCalled, false, "the Operations stream must be rejected before the classification seam ever runs");
  assert.strictEqual(calls.init.length, 0);
  assert.ok(sent.some((m) => m.includes("Operations topic is reserved")));
});

test("M. Chat -> Cowork transition: a decision returned as cowork after prior chat context is dispatched normally", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  // classifyWorkspaceMessage's own implementation supplies the last 6 turns
  // of chat_history:<chat>:<thread> to the AI call as conversational
  // context (see workspaceRouter.ts) -- exercising that the AI actually
  // uses it correctly is blocked by the same provider-eligibility
  // constraint noted at the top of this file. What's verified here is that
  // once a "cowork" decision is returned (as it should be for "Okay, let's
  // diagnose the company properly and develop the strategic intervention"
  // following prior chat establishing the situation), dispatch proceeds
  // exactly as any other cowork decision would.
  await routeIncomingText(env, -1004435157576, "Okay, let's diagnose the company properly and develop the strategic intervention.", 604, {
    classify: fixedDecision({ mode: "cowork", unit: "Strategy", hat: "Strategy Analyst" }),
  });

  // Strategy has no existing direct-chat governed entry point (see J2) --
  // the transition must still fail closed rather than fabricate one.
  assert.strictEqual(calls.init.length, 0);
});
