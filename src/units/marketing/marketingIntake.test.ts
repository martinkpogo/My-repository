/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { handleMarketingIntake, handleMarketingClarification } from "./marketingManifest";
import type { Env, WorkState } from "../../types";

/**
 * Decision-path tests for Marketing's LIVE intake routing logic
 * (handleMarketingIntake: Stage 1 candidate classification -> registered-Hat
 * validation -> Stage 2 relationship resolution -> Hat assignment + dispatch,
 * or a fail-closed clarification). relationships.test.ts covers the pure
 * Stage 2 resolver and marketingManifest.test.ts covers the manifest shape --
 * neither exercises this actual decision path. Everything here is a
 * deterministic fixture: the AI provider is a queued mock (no real provider),
 * and Notion/Telegram are mocked fetches (no production services).
 *
 * Initial WorkState mirrors what the production compatibility path produces
 * for a request that addresses a registered Marketing Hat
 * (dispatchCowork -> stub.init(workId, chatId, "Marketing", decision.hat,
 * threadId) -> handleMarketingRequest): unit "Marketing", a real registered
 * hat, stage "new". An unaddressed ("Marketing" placeholder) init fails
 * closed at recordWorkAction before this intake ever runs, so it is not a
 * reachable entry state here.
 */

const WORKSPACE_CHAT = -999;
const WORKSPACE_THREAD = 604;

interface AiCall {
  model: string;
  system: string;
  user: string;
}

interface IntakeHarness {
  env: Env;
  aiCalls: AiCall[];
  sentMessages: string[];
  logBodies: string[];
  unexpectedUrls: string[];
}

/** Queues AI responses in call order. Each item is the RAW response text (use json() for a JSON object). The system+user of every call is captured for assertions. */
function makeHarness(t: any, responses: string[]): IntakeHarness {
  const aiCalls: AiCall[] = [];
  let call = 0;
  const sentMessages: string[] = [];
  const logBodies: string[] = [];
  const unexpectedUrls: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("api.telegram.org")) {
      try {
        const body = JSON.parse(init?.body ?? "{}");
        if (body.text) sentMessages.push(body.text);
      } catch {
        // editMessageText and text-less actions carry no capturable text
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (u.includes("/blocks/") && u.includes("/children")) {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (method === "GET" && u.includes("/v1/pages/")) {
      const id = u.split("/v1/pages/").pop()!.split("?")[0];
      return new Response(JSON.stringify({ id, url: u, parent: { type: "page", page_id: "governance-root" }, properties: {} }), { status: 200 });
    }
    if (method === "POST" && u.endsWith("/v1/pages")) {
      logBodies.push(init?.body ?? "");
      return new Response(JSON.stringify({ id: "log-entry", url: "https://notion.so/log-entry", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }
    unexpectedUrls.push(`${method} ${u}`);
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_GROUP_CHAT_ID: String(WORKSPACE_CHAT),
    WORKSPACE_TOPIC_ID: String(WORKSPACE_THREAD),
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI_MODEL_PRIMARY: "test-primary",
    AI_MODEL_LIGHT: "test-light",
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
    AI: {
      run: async (model: string, opts: any) => {
        aiCalls.push({
          model,
          system: String(opts?.messages?.[0]?.content ?? ""),
          user: String(opts?.messages?.[1]?.content ?? ""),
        });
        const response = responses[Math.min(call++, responses.length - 1)] ?? "null";
        return { response };
      },
    },
  } as Env;

  return { env, aiCalls, sentMessages, logBodies, unexpectedUrls };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** A Work mirroring the production compatibility-path init for an addressed Marketing request. */
function workState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-intake-1",
    chatId: 12345,
    threadId: 777,
    unit: "Marketing",
    hat: "Marketing Strategist",
    stage: "new",
    marketing: { taskText: "" },
    ...overrides,
  } as WorkState;
}

/** The Hat run's draft decision -- dispatch reaching runMarketingHat and producing a normal (non-paid-media) draft awaiting approval. */
const DRAFT_DECISION = json({ action: "draft", draft: "A drafted output.", involves_spend: false });

function assertDispatchedToDraft(state: WorkState) {
  assert.equal(state.stage, "awaiting_marketing_draft_approval", "dispatch must reach the Hat run's draft awaiting-approval state");
  assert.equal(state.awaiting, undefined);
}

function assertClarificationHeld(state: WorkState) {
  assert.equal(state.stage, "marketing_ambiguous");
  assert.equal(state.awaiting, "marketing_clarification");
}

// --- Resolution outcomes -----------------------------------------------------

test("a single plausible candidate resolves to that registered Hat and dispatches to its manifest handler", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Content Manager"], establishing: false, reason: "production workflow task" }), DRAFT_DECISION]);
  const state = workState();

  const result = await handleMarketingIntake(h.env, state, "Turn the content direction into this month's editorial calendar.");

  assert.equal(result.hat, "Content Manager");
  assertDispatchedToDraft(result);
  assert.equal(result.marketing?.taskText, "Turn the content direction into this month's editorial calendar.", "the request text is captured on the Work");
  assert.ok(h.sentMessages.some((m) => m.includes("Hat: Content Manager.")), "the Content Manager Hat run must announce itself in the Workspace stream");
  assert.ok(h.sentMessages.some((m) => m.includes("Approve this?")), "the resolved Hat's draft approval gate must be presented");
  assert.ok(h.aiCalls.length === 2, `Stage 1 plus the Hat run decision must be the only AI calls, got ${h.aiCalls.length}`);
  assert.ok(
    h.logBodies.some((b) => b.includes("Marketing task routed to Content Manager") && !b.includes("via relationship")),
    "the Activity log must record the direct single-candidate routing without a relationship id",
  );
  assert.deepEqual(h.unexpectedUrls, [], "no unexpected external call may happen");
});

test("an unconditional registered relationship selects the expected downstream Hat", async (t) => {
  const h = makeHarness(t, [
    json({ candidates: ["Marketing Strategist", "Brand & Communications Strategist"], establishing: false, reason: "translating positioning into communications" }),
    DRAFT_DECISION,
  ]);
  const state = workState();

  const result = await handleMarketingIntake(h.env, state, "Translate our positioning into communications guidance.");

  assert.equal(result.hat, "Brand & Communications Strategist");
  assertDispatchedToDraft(result);
  assert.ok(
    h.logBodies.some((b) => b.includes("Marketing task routed to Brand & Communications Strategist") && b.includes("via relationship brand-communications-strategist__positioning")),
    "the Activity log must record the registered relationship that decided the Hat",
  );
});

test("conditional relationships resolve to Marketing Strategist when establishing is true", async (t) => {
  const h = makeHarness(t, [
    json({ candidates: ["Marketing Strategist", "Digital Marketer"], establishing: true, reason: "sets overall marketing strategy" }),
    DRAFT_DECISION,
  ]);
  const state = workState();

  const result = await handleMarketingIntake(h.env, state, "Define our overall marketing objectives and channel strategy for next quarter.");

  assert.equal(result.hat, "Marketing Strategist");
  assertDispatchedToDraft(result);
  assert.ok(
    h.logBodies.some((b) => b.includes("via relationship digital-marketer__overall-marketing-strategy,digital-marketer__strategic-channel-mix")),
    "the Activity log must record the conditional relationships that decided the Hat",
  );
});

test("conditional relationships resolve to Digital Marketer when establishing is false", async (t) => {
  const h = makeHarness(t, [
    json({ candidates: ["Marketing Strategist", "Digital Marketer"], establishing: false, reason: "routine execution within established strategy" }),
    DRAFT_DECISION,
  ]);
  const state = workState();

  const result = await handleMarketingIntake(h.env, state, "Adjust the bid on the running paid campaign.");

  assert.equal(result.hat, "Digital Marketer");
  assertDispatchedToDraft(result);
});

// --- Fail-closed outcomes ----------------------------------------------------

test("a conditional relationship with a missing establishing value fails closed to clarification -- no Hat is dispatched", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Digital Marketer"], reason: "could be either" })]);
  const state = workState({ hat: "Marketing" as any, stage: "new" });

  const result = await handleMarketingIntake(h.env, state, "Do something with the paid campaigns.");

  assert.equal(result.hat, "Marketing", "no Hat may be invented when the conditional relationship cannot be resolved");
  assertClarificationHeld(result);
  assert.ok(h.sentMessages.some((m) => m.includes("I'm not sure which Marketing Hat this belongs to")), "the existing clarification contract must be preserved");
  assert.ok(h.sentMessages.some((m) => m.includes("Can you clarify what's needed?")), "the existing clarification contract must be preserved");
  assert.equal(h.aiCalls.length, 1, "only Stage 1 may have run -- no Hat-run decision dispatch");
  assert.ok(!h.sentMessages.some((m) => m.includes("Approve this?")), "no dispatch may present a draft approval gate");
  assert.ok(h.logBodies.some((b) => b.includes("CONDITIONAL_ESTABLISHING_REQUIRED")), "the Activity log must record the fail-closed reason code");
});

test("conflicting candidate relationships fail closed to clarification", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Brand & Communications Strategist", "Content Strategist"], establishing: true })]);
  const state = workState({ hat: "Marketing" as any });

  const result = await handleMarketingIntake(h.env, state, "An unclear request spanning several Hats.");

  assert.equal(result.hat, "Marketing");
  assertClarificationHeld(result);
  assert.equal(h.aiCalls.length, 1, "no dispatch may happen on conflicting relationships");
  assert.ok(h.logBodies.some((b) => b.includes("MULTIPLE_CONFLICTING_RELATIONSHIPS")), "the Activity log must record the fail-closed reason code");
});

test("candidates with no registered relationship between them fail closed to clarification", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Brand & Communications Strategist", "Digital Marketer"], establishing: true })]);
  const state = workState({ hat: "Marketing" as any });

  const result = await handleMarketingIntake(h.env, state, "An unclear request spanning two unrelated Hats.");

  assert.equal(result.hat, "Marketing");
  assertClarificationHeld(result);
  assert.equal(h.aiCalls.length, 1, "no dispatch may happen without a registered relationship");
  assert.ok(h.logBodies.some((b) => b.includes("NO_REGISTERED_RELATIONSHIP")), "the Activity log must record the fail-closed reason code");
});

test("an empty Stage 1 candidate list fails closed without inventing a Hat", async (t) => {
  const h = makeHarness(t, [json({ candidates: [], establishing: false, reason: "nothing matches" })]);
  const state = workState({ hat: "Marketing" as any });

  const result = await handleMarketingIntake(h.env, state, "Something no Marketing Hat owns.");

  assert.equal(result.hat, "Marketing");
  assertClarificationHeld(result);
  assert.equal(h.aiCalls.length, 1, "no dispatch may happen on an empty candidate list");
  assert.ok(h.logBodies.some((b) => b.includes("Marketing intake ambiguous [NO_PLAUSIBLE_HATS]")), "the Activity log must record NO_PLAUSIBLE_HATS");
});

test("a failed Stage 1 classification fails closed without inventing a Hat", async (t) => {
  const h = makeHarness(t, ["this is not a JSON object"]);
  const state = workState({ hat: "Marketing" as any });

  const result = await handleMarketingIntake(h.env, state, "A request the classifier cannot answer.");

  assert.equal(result.hat, "Marketing", "a failed classification must never invent a Hat");
  assert.equal(result.stage, "new", "the failed-classification path holds the Work unchanged (no guessed dispatch)");
  assert.equal(result.awaiting, undefined);
  assert.equal(h.aiCalls.length, 1);
  assert.ok(h.sentMessages.some((m) => m.includes("Couldn't determine which Marketing Hat this belongs to")), "the existing classification-failure message must be preserved");
  assert.ok(!h.sentMessages.some((m) => m.includes("Approve this?")), "no dispatch may present a draft approval gate");
  assert.ok(h.logBodies.some((b) => b.includes("Marketing intake blocked [CLASSIFICATION_FAILED]")), "the Activity log must record CLASSIFICATION_FAILED");
});

// --- Registered-Hat validation ----------------------------------------------

test("candidate names not registered to Marketing never become the selected Hat -- a registered candidate still resolves", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Growth Hacker", "Content Manager"], establishing: false }), DRAFT_DECISION]);
  const state = workState();

  const result = await handleMarketingIntake(h.env, state, "Build the editorial calendar.");

  assert.equal(result.hat, "Content Manager", "the unregistered candidate is filtered out; the registered one is selected");
  assert.notEqual(result.hat, "Growth Hacker");
  assertDispatchedToDraft(result);
});

test("an unregistered-only candidate list fails closed without inventing a Hat", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Growth Hacker"], establishing: false })]);
  const state = workState({ hat: "Marketing" as any });

  const result = await handleMarketingIntake(h.env, state, "A request only an unregistered name seems to fit.");

  assert.equal(result.hat, "Marketing", "an unregistered candidate can never become the selected Hat");
  assertClarificationHeld(result);
  assert.equal(h.aiCalls.length, 1, "no dispatch may happen");
});

// --- Clarification / continuation contract -----------------------------------

test("a clarification reply on an assigned-Hat Work re-runs that Hat's decision on the augmented task text -- never a guessed dispatch", async (t) => {
  const h = makeHarness(t, [DRAFT_DECISION]);
  const state = workState({
    hat: "Marketing Strategist",
    stage: "marketing_ambiguous",
    awaiting: "marketing_clarification",
    marketing: { taskText: "Draft something about the new positioning." },
  });

  const result = await handleMarketingClarification(h.env, state, "Focus it on the retail segment.");

  assert.equal(result.hat, "Marketing Strategist", "the clarification reply keeps the already-assigned Hat");
  assertDispatchedToDraft(result);
  assert.equal(
    result.marketing?.taskText,
    "Draft something about the new positioning.\n\nAdditional detail: Focus it on the retail segment.",
    "the clarification detail is appended to the captured task text",
  );
  assert.ok(h.aiCalls.length === 1, "only the Hat run decision runs -- intake classification is not re-run when a Hat is assigned");
  assert.ok(h.aiCalls[0].user.includes("Focus it on the retail segment"), "the Hat decision must see the augmented task text");
});

test("a clarification reply on a Work with no assigned Hat re-runs intake with the augmented text and still fails closed rather than guessing", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Digital Marketer"], reason: "still ambiguous" })]);
  const state = workState({
    hat: "Marketing" as any,
    stage: "marketing_ambiguous",
    awaiting: "marketing_clarification",
    marketing: { taskText: "Do the paid thing." },
  });

  const result = await handleMarketingClarification(h.env, state, "It is about the search ads budget.");

  assert.equal(result.hat, "Marketing", "the re-run intake must still fail closed rather than inventing a Hat");
  assertClarificationHeld(result);
  assert.equal(h.aiCalls.length, 1, "only the re-run intake classification may call AI");
  assert.ok(
    h.aiCalls[0].user.includes("Do the paid thing.") && h.aiCalls[0].user.includes("Additional detail: It is about the search ads budget."),
    "the re-run Stage 1 must classify the augmented task text, not the reply alone",
  );
});
