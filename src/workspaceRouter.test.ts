import test from "node:test";
import assert from "node:assert";
import { resolveAddressee, resolveWorkspaceRouting, type WorkspaceDecision } from "./workspaceRouter";
import { routeIncomingText, dispatchCowork } from "./router";
import { isSemanticTaskId } from "./dataBoundary/registry";
import { registerActionCapability, clearRegisteredCapabilities, type ActionCapability } from "./actions/registry";
import { setWorkspaceMode } from "./sessionRouting";
import type { Env } from "./types";

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

test("S. Ordinary Chat never dispatches through the generic Workspace capability registry -- a registered capability that could create governed state must not be reachable merely because a message arrived while mode is Chat", async (t) => {
  mockTelegramFetch(t);
  clearRegisteredCapabilities();
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  let capabilityInvoked = false;
  const capability: ActionCapability = {
    id: "test-capability",
    name: "Test Capability",
    description: "test",
    handleIntake: async () => {
      capabilityInvoked = true;
      return true;
    },
  };
  registerActionCapability(capability);
  t.after(() => clearRegisteredCapabilities());

  await routeIncomingText(env, -1004435157576, "Create a Google Doc for this brief.", 604, {
    resolveRouting: fixedDecision({ mode: "chat" }),
  });

  assert.strictEqual(capabilityInvoked, false, "Chat must never dispatch through the generic capability registry -- see the Chat capability boundary correction");
  assert.strictEqual(calls.init.length, 0, "Chat must never create a WorkSession through generic capability dispatch");
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

test("U. Cowork decision for a Unit with no existing chat-triggered governed entry point fails closed (UNSUPPORTED) -- never fabricates ownership, and notifies Operations", async (t) => {
  const sent = mockTelegramFetch(t);
  const { calls, workSession } = createMockWorkSession();
  const env = fakeEnv({ WORK_SESSION: workSession as any });

  const decision: WorkspaceDecision = { mode: "cowork", unit: "Finance", hat: "Value-Based Pricing Assessor" };
  await dispatchCowork(env, -1004435157576, 604, "Finance, price this for us.", decision as any);

  assert.strictEqual(calls.init.length, 0, "no WorkSession may be fabricated for a Unit with no existing chat-triggered governed entry point");
  assert.ok(
    sent.some((m) => m.includes("Cowork resolved to Finance/Value-Based Pricing Assessor") && m.includes("no existing chat-triggered governed entry point")),
    "an UNSUPPORTED Cowork resolution must be visible in Operations, not just the originating Workspace topic",
  );
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
