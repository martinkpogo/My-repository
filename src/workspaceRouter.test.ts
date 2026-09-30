import test from "node:test";
import assert from "node:assert";
import { resolveAddressee, resolveWorkspaceRouting, type WorkspaceDecision } from "./workspaceRouter";
import { routeIncomingText, dispatchCowork } from "./router";
import { isSemanticTaskId } from "./dataBoundary/registry";
import { setWorkspaceMode } from "./sessionRouting";
import type { Env } from "./types";
import type { UnitManifest, HatManifest } from "./units/unitManifest";

/**
 * Covers the deterministic Chat/Cowork Workspace routing contract:
 * resolveAddressee (structural Unit/Hat addressee matching, no AI),
 * resolveWorkspaceRouting (the full mode/clarification decision), and
 * routeIncomingText/dispatchCowork (existing-association precedence,
 * Chat-mode bounded capabilities, Cowork dispatch/fail-closed). No test
 * here exercises an AI provider call -- resolveWorkspaceRouting makes none,
 * ever, for mode determination or responsibility resolution.
 */

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

function createMockWorkSession() {
  const calls: {
    init: any[][];
    handleIncomingEnquiry: string[];
    handleMarketingRequest: string[];
    handleResearchRequest: string[];
    handleStrategyRequest: string[];
    handleFinanceRequest: string[];
    handleUnitAction: [string, string][];
  } = {
    init: [],
    handleIncomingEnquiry: [],
    handleMarketingRequest: [],
    handleResearchRequest: [],
    handleStrategyRequest: [],
    handleFinanceRequest: [],
    handleUnitAction: [],
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
    handleStrategyRequest: async (text: string) => {
      calls.handleStrategyRequest.push(text);
    },
    handleFinanceRequest: async (text: string) => {
      calls.handleFinanceRequest.push(text);
    },
    handleUnitAction: async (actionName: string, text: string) => {
      calls.handleUnitAction.push([actionName, text]);
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

// --- resolveAddressee: deterministic structural matching, no AI ---

test("A. Leading vocative Unit name resolves the Unit, no Hat", () => {
  const result = resolveAddressee("Finance, explain our value-based pricing.");
  assert.deepStrictEqual(result, { name: "Finance", unit: "Finance" });
});

test("B. Leading vocative Hat name resolves both Unit and Hat, longest match wins over the bare Unit name", () => {
  const result = resolveAddressee("Sales Executive, we have a new enquiry.");
  assert.strictEqual(result?.unit, "Sales");
  assert.strictEqual(result?.hat, "Sales Executive");
});

test("C. Leading vocative Marketing Hat name resolves that specific Hat", () => {
  const result = resolveAddressee("Marketing Strategist, let's develop the campaign strategy for this.");
  assert.strictEqual(result?.unit, "Marketing");
  assert.strictEqual(result?.hat, "Marketing Strategist");
});

test("D. Explicit alias table resolves a conservative near-match (R&I -> Research & Intelligence)", () => {
  const result = resolveAddressee("R&I, what does this market look like?");
  assert.strictEqual(result?.unit, "Research & Intelligence");
});

test("E. A Unit name appearing mid-sentence is never treated as addressing (structural, not semantic)", () => {
  const result = resolveAddressee("Should we loop in Finance on this before responding?");
  assert.strictEqual(result, null);
});

test("F. Subject-matter wording never implies a Unit -- 'positioning' does not imply Strategy", () => {
  const result = resolveAddressee("Let's talk about positioning for this client.");
  assert.strictEqual(result, null);
});

test("F2. Subject-matter wording never implies a Unit -- 'pricing' does not imply Finance", () => {
  const result = resolveAddressee("What should the pricing look like here?");
  assert.strictEqual(result, null);
});

test("F3. Subject-matter wording never implies a Unit -- 'campaign' does not imply Marketing", () => {
  const result = resolveAddressee("We need a campaign for this launch.");
  assert.strictEqual(result, null);
});

test("G. No registered name anywhere in the message -> null, never a guess", () => {
  const result = resolveAddressee("Can you help me think through this problem?");
  assert.strictEqual(result, null);
});

// --- resolveWorkspaceRouting: the full mode/clarification contract ---

test("H. Chat mode with no addressee -> chat, no unit", async () => {
  const env = fakeEnv();
  const decision = await resolveWorkspaceRouting(env, 1, 604, "How should ENIG approach this kind of client?");
  assert.deepStrictEqual(decision, { mode: "chat" });
});

test("I. Chat mode with a leading addressee -> chat, scoped to that Unit -- never creates governed work", async () => {
  const env = fakeEnv();
  const decision = await resolveWorkspaceRouting(env, 1, 604, "Strategy, what do you think about this positioning problem?");
  assert.deepStrictEqual(decision, { mode: "chat", unit: "Strategy" });
});

test("J. Cowork mode with an explicit Unit addressee -> cowork, resolved deterministically, no clarification", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "Finance, price this for us.");
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Finance", hat: undefined });
});

test("K. Cowork mode with an explicit Hat addressee -> cowork with both Unit and Hat resolved", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "Research & Intelligence Analyst, research this competitor.");
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Research & Intelligence", hat: "Research & Intelligence Analyst" });
});

test("L. Cowork mode with no addressee -> clarify, never a guess, and marks clarification pending", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "Can someone help with this bakery chain enquiry?");
  assert.strictEqual(decision.mode, "clarify");
  assert.ok((decision as any).question.length > 0);
  assert.strictEqual(await env.STATE_KV.get(`cowork_pending:1:604`), "1");
});

test("L2. Cowork mode never infers responsibility from subject matter even with no addressee -- 'pricing' still asks, never assumes Finance", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "What should the pricing look like here?");
  assert.strictEqual(decision.mode, "clarify");
});

test("M. Pending clarification answered with a bare Unit name resolves to cowork and clears pending", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  env.STATE_KV.put(`cowork_pending:1:604`, "1");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "Strategy");
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Strategy", hat: undefined });
  assert.strictEqual(await env.STATE_KV.get(`cowork_pending:1:604`), null);
});

test("M2. Pending clarification answered via the alias table resolves correctly", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  env.STATE_KV.put(`cowork_pending:1:604`, "1");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "That's R&I work.");
  assert.deepStrictEqual(decision, { mode: "cowork", unit: "Research & Intelligence", hat: undefined });
});

test("N. Pending clarification answered with an unrecognized name stays pending, asks again, never guesses", async () => {
  const env = fakeEnv();
  env.STATE_KV.put(`mode:1:604`, "cowork");
  env.STATE_KV.put(`cowork_pending:1:604`, "1");
  const decision = await resolveWorkspaceRouting(env, 1, 604, "Not sure, whoever handles this kind of thing.");
  assert.strictEqual(decision.mode, "clarify");
  assert.strictEqual(await env.STATE_KV.get(`cowork_pending:1:604`), "1");
});

// --- routeIncomingText / dispatchCowork: dispatch-level behavior ---

function fixedDecision(decision: WorkspaceDecision) {
  return async () => decision;
}

test("O. Existing reply-association takes precedence over Workspace mode -- continuation, no mode/clarification lookup", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });
  workSession.get = ((_id: any) => ({
    getState: async () => ({ awaiting: "call_notes" }),
    handleTextReply: async (text: string) => {
      calls.handleIncomingEnquiry.push(`reply:${text}`);
      return undefined;
    },
  })) as any;
  await env.STATE_KV.put(`reply_msg:42`, "work-abc");

  await routeIncomingText(env, -1004435157576, "Here are the call notes.", 604, { replyToMessageId: 42 });

  assert.strictEqual(calls.init.length, 0, "continuation must never re-enter mode/responsibility resolution");
  assert.deepStrictEqual(calls.handleIncomingEnquiry, ["reply:Here are the call notes."]);
});

test("P. Existing active pointer takes precedence over Workspace mode", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });
  workSession.get = ((_id: any) => ({
    getState: async () => ({ awaiting: "qualification_approval" }),
    handleTextReply: async (text: string) => {
      calls.handleIncomingEnquiry.push(`active:${text}`);
      return undefined;
    },
  })) as any;
  await env.STATE_KV.put(`active:-1004435157576:604`, "work-xyz");
  await env.STATE_KV.put(`mode:-1004435157576:604`, "cowork"); // irrelevant -- association wins

  await routeIncomingText(env, -1004435157576, "Finance, go ahead.", 604);

  assert.deepStrictEqual(calls.handleIncomingEnquiry, ["active:Finance, go ahead."]);
});

test("Q. Operations topic rejected before mode/clarification resolution ever runs", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  let resolveCalled = false;
  await routeIncomingText(env, -1004435157576, "Sales, let's start work on this enquiry.", 588, {
    resolveRouting: async () => {
      resolveCalled = true;
      return { mode: "cowork", unit: "Sales", hat: "Sales Executive" } as WorkspaceDecision;
    },
  });

  assert.strictEqual(resolveCalled, false, "the Operations stream must be rejected before routing resolution ever runs");
  assert.strictEqual(calls.init.length, 0);
  assert.ok(sent.some((m) => m.includes("Operations topic is reserved")));
});

test("R. Chat mode never creates a WorkSession, even with capability-adjacent wording", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  await routeIncomingText(env, -1004435157576, "By the way, do you think a spreadsheet would even help here?", 604, {
    resolveRouting: fixedDecision({ mode: "chat" }),
  });

  assert.strictEqual(calls.init.length, 0, "CHAT must never create a WorkSession");
  assert.ok(sent.length >= 0);
});

// --- Chat is action-capable (ENIG Operating Model design doc, 2026-09-28
// decision): Chat resolves and dispatches through the same Action Registry
// Cowork uses, for any Unit with a registered manifest, falling open to
// ordinary conversation on ambiguity rather than blocking with a
// clarifying question the way Cowork does. ---

function toyChatManifest(): UnitManifest {
  const hat: HatManifest<"check_status" | "send_update"> = {
    name: "Toy Hat",
    responsibility: "Handles toy requests for this test.",
    responsibilityId: "toy_responsibility",
    actions: [
      { name: "check_status", responsibility: "toy_responsibility", consequence: "read", requiresApproval: false, description: "Read-only status check." },
      { name: "send_update", responsibility: "toy_responsibility", consequence: "write", requiresApproval: true, description: "Sends a real update -- privileged." },
    ],
    readHandler: async (_env, actionName) => `toy-reply:${actionName}`,
    entryHandler: async (_env, state) => state,
    awaitingHandlers: {},
  };
  return {
    unit: "Business Development",
    hats: { "Toy Hat": hat },
    intakeClassificationTaskId: "business_development.intake_classification",
    intakeIntroLine: "You route incoming toy requests.",
    actionClassificationTaskId: "business_development.hat_action_decision",
  };
}

function mockActionAi(env: Partial<Env>, action: string | null) {
  return {
    ...env,
    AI: { run: async () => ({ response: JSON.stringify({ action }) }) } as any,
  } as Env;
}

test("T0a. Chat mode dispatches a confidently-resolved read action directly, using tryResolveUnitAction's own reply target, and no WorkSession is created", async (t) => {
  const originalFetch = globalThis.fetch;
  const sent: { chatId: number; threadId?: number; text: string }[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(init?.body ?? "{}");
      sent.push({ chatId: body.chat_id, threadId: body.message_thread_id, text: body.text ?? "" });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { calls, workSession } = createMockWorkSession();
  const env = mockActionAi(fakeEnv({ WORK_SESSION: workSession as any }), "check_status");

  // Chat mode only ever reaches routeIncomingText's mode resolution inside
  // the Workspace stream topic (any other thread is "unmapped" and fails
  // closed before mode resolution runs at all) -- -1004435157576/604 is
  // this suite's Workspace stream throughout, same as every other test
  // here. tryResolveUnitAction replying to whatever target it's given,
  // rather than forcing the Workspace stream the way resolveUnitRequest's
  // sendWorkspaceHatMessage does, is covered directly (with a genuinely
  // different chat/thread) in dispatch.test.ts.
  await routeIncomingText(env, -1004435157576, "what's the status?", 604, {
    resolveRouting: fixedDecision({ mode: "chat", unit: "Business Development" }),
    resolveUnitManifestForChat: () => toyChatManifest(),
  });

  assert.strictEqual(calls.init.length, 0, "a read action must never create a WorkSession");
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].chatId, -1004435157576);
  assert.strictEqual(sent[0].threadId, 604);
  assert.match(sent[0].text, /toy-reply:check_status/);
});

test("T0b. Chat mode dispatches a confidently-resolved write action into a real WorkSession via handleUnitAction, same as Cowork's manifest dispatch", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = mockActionAi(fakeEnv({ WORK_SESSION: workSession as any }), "send_update");

  await routeIncomingText(env, -1004435157576, "send the update", 604, {
    resolveRouting: fixedDecision({ mode: "chat", unit: "Business Development" }),
    resolveUnitManifestForChat: () => toyChatManifest(),
  });

  assert.strictEqual(calls.init.length, 1);
  assert.strictEqual(calls.init[0][2], "Business Development");
  assert.strictEqual(calls.init[0][3], "Toy Hat");
  assert.deepStrictEqual(calls.handleUnitAction, [["send_update", "send the update"]]);
});

test("T0c. Chat mode falls open to ordinary conversation on ambiguity -- never blocks with a clarifying question, unlike Cowork", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = mockActionAi(fakeEnv({ WORK_SESSION: workSession as any }), null); // Stage 2 finds nothing

  await routeIncomingText(env, -1004435157576, "just chatting, nothing specific", 604, {
    resolveRouting: fixedDecision({ mode: "chat", unit: "Business Development" }),
    resolveUnitManifestForChat: () => toyChatManifest(),
  });

  assert.strictEqual(calls.init.length, 0);
  assert.ok(
    !sent.some((m) => m.toLowerCase().includes("i'm not sure") || m.toLowerCase().includes("clarify")),
    "must never surface a clarifying question in Chat mode",
  );
  // Falls through to the ordinary conversational reply (generalChatReply,
  // which itself calls AI and returns whatever the mocked provider gives
  // it) -- some reply is still sent, just not the toy action's.
  assert.ok(sent.length > 0);
  assert.ok(!sent.some((m) => m.includes("toy-reply")));
});

test("T0d. Chat mode with no registered manifest for the resolved Unit falls straight through to ordinary conversation, unchanged", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  await routeIncomingText(env, -1004435157576, "By the way, do you think a spreadsheet would even help here?", 604, {
    resolveRouting: fixedDecision({ mode: "chat", unit: "Strategy" }),
    resolveUnitManifestForChat: () => undefined,
  });

  assert.strictEqual(calls.init.length, 0);
  assert.ok(sent.length >= 0);
});

test("T. Cowork decision dispatches to the resolved Unit's existing governed entry point with the resolved Hat", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  await routeIncomingText(env, -1004435157576, "Research this competitor.", 604, {
    resolveRouting: fixedDecision({ mode: "cowork", unit: "Research & Intelligence", hat: "Research & Intelligence Analyst" }),
  });
  assert.strictEqual(calls.init[0][2], "Research & Intelligence");
  assert.strictEqual(calls.init[0][3], "Research & Intelligence Analyst");

  await routeIncomingText(env, -1004435157576, "Let's develop the campaign strategy.", 604, {
    resolveRouting: fixedDecision({ mode: "cowork", unit: "Marketing", hat: "Marketing Strategist" }),
  });
  assert.strictEqual(calls.init[1][2], "Marketing");
  assert.strictEqual(calls.init[1][3], "Marketing Strategist");
});

test("T2. Cowork decision for Sales/Lead Generation Specialist routes through the Sales Unit Registry manifest (discover_leads, a 'read' action), never Sales Executive's enquiry-extraction -- no WorkSession fabricated by this dispatch", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  await routeIncomingText(env, -1004435157576, "Lead Generation Specialist: find me 3 companies showing a positioning problem.", 604, {
    resolveRouting: fixedDecision({ mode: "cowork", unit: "Sales", hat: "Lead Generation Specialist" }),
  });

  assert.strictEqual(calls.init.length, 0, "Lead Generation Specialist dispatch must never go through Sales Executive's newWorkId/init/handleIncomingEnquiry path");
  assert.strictEqual(calls.handleIncomingEnquiry.length, 0, "must never misroute into enquiry-extraction");
  // Some reply must still be sent -- either Stage 2's own ambiguity message
  // (since no AI classifier is mocked here, resolveUnitRequest's
  // classifyAction gets no usable response and fails closed) or the
  // discover_leads action's own fallback if Stage 2 somehow resolves it
  // anyway. Either way, resolveUnitRequest's "read" path never creates a
  // WorkSession, so calls.init stays empty regardless of which one fires.
  assert.ok(sent.length > 0, "some reply must still be sent");
});

test("T3. Cowork decision for Strategy routes to its own direct_request entry point (Migration path Step 4)", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  await routeIncomingText(env, -1004435157576, "Strategy, diagnose MAT-20: recurring delivery complaints.", 604, {
    resolveRouting: fixedDecision({ mode: "cowork", unit: "Strategy", hat: "Strategy Analyst" }),
  });

  assert.strictEqual(calls.init[0][2], "Strategy");
  assert.strictEqual(calls.init[0][3], "Strategy Analyst");
  assert.deepStrictEqual(calls.handleStrategyRequest, ["Strategy, diagnose MAT-20: recurring delivery complaints."]);
});

test("U. Cowork decision for a Unit with no existing chat-triggered governed entry point fails closed (UNSUPPORTED) -- never fabricates ownership, and notifies Operations", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  // Business Development is no longer UNSUPPORTED -- it's the first Unit
  // wired to the Unit Registry manifest pattern (see units/dispatch.ts).
  // Creative & Design and Operations remain genuinely unsupported (no
  // manifest, no hand-written entry point), so this test now uses one of
  // those instead of asserting behavior that's deliberately changed.
  const decision: WorkspaceDecision = { mode: "cowork", unit: "Creative & Design", hat: undefined };
  await dispatchCowork(env, -1004435157576, 604, "Creative & Design, mock up a new landing page.", decision as any);

  assert.strictEqual(calls.init.length, 0, "no WorkSession may be fabricated for a Unit with no existing chat-triggered governed entry point");
  assert.ok(
    sent.some((m) => m.includes("Cowork resolved to Creative & Design") && m.includes("no existing chat-triggered governed entry point")),
    "an UNSUPPORTED Cowork resolution must be visible in Operations, not just the originating Workspace topic",
  );
});

test("T4. Cowork decision for Finance routes to its own direct_request entry point (Migration path Step 4)", async (t) => {
  mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  await routeIncomingText(env, -1004435157576, "Finance, price MAT-20: recurring delivery complaints.", 604, {
    resolveRouting: fixedDecision({ mode: "cowork", unit: "Finance", hat: "Value-Based Pricing Assessor" }),
  });

  assert.strictEqual(calls.init[0][2], "Finance");
  assert.strictEqual(calls.init[0][3], "Value-Based Pricing Assessor");
  assert.deepStrictEqual(calls.handleFinanceRequest, ["Finance, price MAT-20: recurring delivery complaints."]);
});

test("V. Mode selection itself never creates governed work -- switching to cowork alone (no follow-up message) creates nothing", async () => {
  const env = fakeEnv();
  await env.STATE_KV.put(`mode:1:604`, "chat");
  await setWorkspaceMode(env, 1, 604, "cowork");
  assert.strictEqual(await env.STATE_KV.get(`mode:1:604`), "cowork");
  // No WorkSession primitive was touched by the mode write itself -- only
  // the thread-scoped mode marker changed.
  assert.strictEqual(await env.STATE_KV.get(`active:1:604`), null);
});

// --- Obsolete AI classifier fully removed ---

test("W. routing.workspace_classification is no longer a registered SemanticTaskId", () => {
  assert.strictEqual(isSemanticTaskId("routing.workspace_classification"), false);
});

// --- Data lookup bypasses mode/clarification entirely (regression: a plain
// "check the Matters database" question in Cowork mode, with no explicit
// Unit/Hat addressee, must never hit the ownership clarification gate) ---

function mockCombinedFetch(t: any, notionResultsByDataSource: Record<string, any[]> = {}) {
  const originalFetch = globalThis.fetch;
  const sentMessages: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      try {
        const body = JSON.parse(init?.body ?? "{}");
        if (body.text) sentMessages.push(body.text);
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    const match = /\/data_sources\/([^/]+)\/query/.exec(s);
    if (match) {
      const results = notionResultsByDataSource[match[1]] ?? [];
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return sentMessages;
}

test("X. A plain database lookup question in Cowork mode with no addressee answers directly -- never asks the ownership clarification question, and never calls resolveWorkspaceRouting at all", async (t) => {
  const sent = mockCombinedFetch(t, {
    "matters-ds": [
      {
        id: "p1",
        archived: false,
        in_trash: false,
        properties: {
          Matter_ID: { unique_id: { number: 20, prefix: "MAT" } },
          Matter: { title: [{ plain_text: "Recurring delivery complaints" }] },
          Status: { select: { name: "Qualified" } },
        },
      },
    ],
  });
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({
    WORK_SESSION: workSession as any,
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: {
      run: async (_model: any, opts: any) => {
        const isClassification = String(opts?.messages?.[0]?.content ?? "").includes("Respond with a single valid JSON object only");
        if (isClassification) return { response: JSON.stringify({ is_lookup: true, source: "matters" }) };
        // Conversational reply: echo back the grounding snapshot handed to
        // it in the system message, proving the AI turn is actually
        // grounded in the live fetched rows rather than a canned string.
        const systemContent = String(opts?.messages?.[0]?.content ?? "");
        return { response: systemContent.includes("MAT-20") ? "Yes -- MAT-20 is currently Qualified." : "(no matching records)" };
      },
    } as any,
  });
  await setWorkspaceMode(env, -1004435157576, 604, "cowork");

  let resolveCalled = false;
  await routeIncomingText(env, -1004435157576, "Check matter Database and tell me if anything is there", 604, {
    resolveRouting: async () => {
      resolveCalled = true;
      return { mode: "clarify", question: "Who should own this work? Name the Unit or Hat." };
    },
  });

  assert.strictEqual(resolveCalled, false, "a data lookup match must short-circuit before resolveWorkspaceRouting ever runs");
  assert.strictEqual(calls.init.length, 0, "a read-only lookup must never create governed work");
  assert.ok(sent.some((m) => m.includes("MAT-20")), "the reply must be grounded in the actual lookup result");
  assert.ok(
    !sent.some((m) => m.includes("Who should own this work")),
    "the ownership clarification question must never be sent for a lookup question",
  );
});

test("Y. A failure in the lookup check (classifier matches, but the Notion read it triggers throws) falls open into ordinary Workspace routing instead of propagating -- regression: this check now runs for every message, so it must never take down unrelated message processing", async (t) => {
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      try {
        const body = JSON.parse(init?.body ?? "{}");
        if (body.text) sent.push(body.text);
      } catch {
        // ignore
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (s.includes("/data_sources/")) {
      // Simulate a Notion outage -- notionFetch throws on a non-ok response.
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({
    WORK_SESSION: workSession as any,
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI: { run: async () => ({ response: JSON.stringify({ is_lookup: true, source: "matters" }) }) } as any,
  });
  await setWorkspaceMode(env, -1004435157576, 604, "cowork");

  await routeIncomingText(env, -1004435157576, "Finance, price MAT-20: recurring delivery complaints.", 604, {
    resolveRouting: fixedDecision({ mode: "cowork", unit: "Finance", hat: "Value-Based Pricing Assessor" }),
  });

  assert.strictEqual(calls.init.length, 1, "the unrelated Cowork dispatch must still succeed despite the lookup check's Notion read failing");
  assert.ok(
    !sent.some((m) => m.includes("Something went wrong")),
    "a lookup-check failure must never surface as a generic processing error",
  );
});
