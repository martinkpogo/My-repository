/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { resolveUnitRequest, tryResolveUnitAction, type UnitDispatchResult } from "../dispatch";
import { marketingManifest } from "./marketingManifest";
import { findUnitManifest } from "../registry";
import { REGISTERED_MARKETING_RELATIONSHIPS } from "../../hats/relationships";
import { NO_ACTION_SKILLS } from "../../platform/skillRegistry";
import type { Env, WorkState } from "../../types";

/**
 * Conformance tests for Marketing routed through the GENERIC resolution
 * path (resolveUnitRequest / tryResolveUnitAction) with the REAL
 * marketingManifest -- the capability this change adds: the manifest
 * declares hatRelationships, so the generic Organization boundary can
 * express Marketing's Stage 1 relationship tie-breaking instead of failing
 * closed the moment Stage 1 proposes several candidates.
 *
 * Scope note: dispatchCowork's Marketing Cowork branch still runs
 * handleMarketingIntake first (behaviour equivalence -- clarification
 * semantics -- is not proven; see marketingManifest.ts's header), so the
 * Cowork tests below exercise the path directly rather than through
 * dispatchCowork. Chat-mode Marketing has always routed through
 * tryResolveUnitAction, which is where this capability changes real
 * behaviour: a multi-candidate Stage 1 now resolves to a Hat instead of
 * falling open to conversation. marketingIntake.test.ts covers the
 * compatibility path's own decision logic; organizationRelationship.test.ts
 * covers the boundary in isolation with a toy manifest.
 *
 * Everything is a deterministic fixture: the AI provider is a queued mock
 * (no real provider), Notion/Telegram are mocked fetches (no production
 * services).
 */

const WORKSPACE_CHAT = -999;
const WORKSPACE_THREAD = 604;

interface AiCall {
  model: string;
  system: string;
  user: string;
}

interface Harness {
  env: Env;
  aiCalls: AiCall[];
  sentMessages: string[];
  logBodies: string[];
  unexpectedUrls: string[];
}

/** Queues AI responses in call order (raw response text). Every call's model/system/user is captured for assertions. */
function makeHarness(t: any, responses: string[]): Harness {
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
        aiCalls.push({ model, system: String(opts?.messages?.[0]?.content ?? ""), user: String(opts?.messages?.[1]?.content ?? "") });
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

function continuation(result: UnitDispatchResult): Extract<UnitDispatchResult, { kind: "continue" }> {
  assert.strictEqual(result.kind, "continue", `expected a continuable dispatch, got ${result.kind}`);
  return result as Extract<UnitDispatchResult, { kind: "continue" }>;
}

const DRAFT_DECISION = json({ action: "draft", draft: "A drafted output.", involves_spend: false });

// --- The declaration itself ----------------------------------------------------

test("the registered Marketing manifest declares the registered relationships by reference, every endpoint a registered Hat", () => {
  const registered = findUnitManifest("Marketing");
  assert.ok(registered, "Marketing must be registered in the Unit Registry");
  assert.strictEqual(registered!.hatRelationships, REGISTERED_MARKETING_RELATIONSHIPS, "the manifest must declare the registered list by reference, not a copy");
  assert.strictEqual(marketingManifest.hatRelationships, REGISTERED_MARKETING_RELATIONSHIPS);
  const hatNames = new Set(Object.keys(marketingManifest.hats));
  for (const relationship of REGISTERED_MARKETING_RELATIONSHIPS) {
    assert.ok(hatNames.has(relationship.from), `relationship ${relationship.id} names unregistered "from" Hat "${relationship.from}"`);
    assert.ok(hatNames.has(relationship.to), `relationship ${relationship.id} names unregistered "to" Hat "${relationship.to}"`);
  }
});

// --- Cowork generic path (resolveUnitRequest) ---------------------------------

test("resolveUnitRequest: several Stage 1 candidates resolve through the unconditional registered relationship -- one Stage 1 call, no Stage 2", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Brand & Communications Strategist"], establishing: false, reason: "translating positioning" })]);

  const result = await resolveUnitRequest(h.env, marketingManifest, { chatId: WORKSPACE_CHAT, threadId: WORKSPACE_THREAD }, "Translate our positioning into communications guidance.");

  const next = continuation(result);
  assert.strictEqual(next.hat, "Brand & Communications Strategist");
  assert.strictEqual(next.actionName, "handle_request");
  assert.strictEqual(next.execution.organization.hat, "Brand & Communications Strategist");
  assert.strictEqual(next.execution.action.requires_approval, true, "the approval gate is unchanged: handle_request stays privileged");
  assert.strictEqual(next.execution.action.definition_source, "unit_manifest");
  assert.strictEqual(h.aiCalls.length, 1, "the action must resolve structurally from the Work's origin -- only Stage 1 may run");
  assert.deepStrictEqual(h.sentMessages, [], "a write action's own entryHandler decides what to send, not dispatch");
  assert.deepStrictEqual(h.unexpectedUrls, [], "resolution must not touch any external service");
});

test("resolveUnitRequest: a conditional relationship resolves by Stage 1's establishing value (true -> Marketing Strategist)", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Digital Marketer"], establishing: true, reason: "sets overall strategy" })]);

  const result = await resolveUnitRequest(h.env, marketingManifest, { chatId: WORKSPACE_CHAT, threadId: WORKSPACE_THREAD }, "Define our overall marketing objectives for next quarter.");

  assert.strictEqual(continuation(result).hat, "Marketing Strategist");
  assert.strictEqual(h.aiCalls.length, 1);
});

test("resolveUnitRequest: the same conditional relationship resolves to Digital Marketer when establishing is false", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Digital Marketer"], establishing: false, reason: "routine execution" })]);

  const result = await resolveUnitRequest(h.env, marketingManifest, { chatId: WORKSPACE_CHAT, threadId: WORKSPACE_THREAD }, "Adjust the bid on the running paid campaign.");

  assert.strictEqual(continuation(result).hat, "Digital Marketer");
  assert.strictEqual(h.aiCalls.length, 1);
});

test("resolveUnitRequest: a single validated candidate still resolves directly, without consulting relationships", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Content Manager"], establishing: false, reason: "workflow task" })]);

  const result = await resolveUnitRequest(h.env, marketingManifest, { chatId: WORKSPACE_CHAT, threadId: WORKSPACE_THREAD }, "Turn the content direction into this month's editorial calendar.");

  assert.strictEqual(continuation(result).hat, "Content Manager");
  assert.strictEqual(h.aiCalls.length, 1, "single candidate: Stage 1 only, no relationship evaluation, no Stage 2");
});

test("resolveUnitRequest: a conditional relationship with no establishing value fails closed to a clarification -- never a guessed Hat", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Digital Marketer"], reason: "could be either" })]);

  const result = await resolveUnitRequest(h.env, marketingManifest, { chatId: WORKSPACE_CHAT, threadId: WORKSPACE_THREAD }, "Do something with the paid campaigns.");

  assert.strictEqual(result.kind, "handled", "Cowork answers ambiguity itself");
  assert.strictEqual(h.aiCalls.length, 1, "no further resolution may run once the Hat is unresolved");
  assert.ok(
    h.sentMessages.some((m) => m.includes("I'm not sure which Marketing Hat this belongs to")),
    "the existing clarification contract must be preserved",
  );
  assert.ok(!h.sentMessages.some((m) => m.includes("Approve this?")), "no dispatch may present an approval gate without a resolved Hat");
  assert.ok(
    h.logBodies.some((b) => b.includes("Marketing intake ambiguous -- could be either")),
    "the Blocker entry must be logged with Stage 1's reason (the relationship reason code itself is asserted at the Organization boundary)",
  );
  assert.deepStrictEqual(h.unexpectedUrls, [], "no unexpected external call may happen");
});

test("resolveUnitRequest: candidates with no registered relationship between them still fail closed", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Brand & Communications Strategist", "Digital Marketer"], establishing: true, reason: "spans two Hats" })]);

  const result = await resolveUnitRequest(h.env, marketingManifest, { chatId: WORKSPACE_CHAT, threadId: WORKSPACE_THREAD }, "An unclear request spanning two unrelated Hats.");

  assert.strictEqual(result.kind, "handled");
  assert.strictEqual(h.aiCalls.length, 1, "no dispatch may happen without a registered relationship");
  assert.ok(!h.sentMessages.some((m) => m.includes("Approve this?")), "no dispatch may present an approval gate");
});

// --- Chat generic path (tryResolveUnitAction) ---------------------------------

test("tryResolveUnitAction: several candidates resolve through the relationship, and Chat's Stage 2 names the resolved Hat's declared action", async (t) => {
  const h = makeHarness(t, [
    json({ candidates: ["Marketing Strategist", "Brand & Communications Strategist"], establishing: false, reason: "translating positioning" }),
    json({ action: "handle_request", reason: "the Hat's only action" }),
  ]);

  const result = await tryResolveUnitAction(h.env, marketingManifest, { chatId: 12345, threadId: 777 }, "Translate our positioning into communications guidance.");

  const next = continuation(result);
  assert.strictEqual(next.hat, "Brand & Communications Strategist");
  assert.strictEqual(next.actionName, "handle_request");
  assert.strictEqual(next.execution.action.requires_approval, true);
  assert.strictEqual(h.aiCalls.length, 2, "Chat runs Stage 1 (Hat) and Stage 2 (action) -- both read from this manifest");
  assert.ok(h.aiCalls[1].system.includes("handle_request"), "Stage 2 must classify against the resolved Hat's declared actions");
  assert.deepStrictEqual(h.sentMessages, [], "a write action replies through its own entryHandler, never here");
});

test("tryResolveUnitAction: an unresolved conditional relationship falls open to conversation silently -- Chat's fail-open discipline is unchanged", async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist", "Digital Marketer"], reason: "could be either" })]);

  const result = await tryResolveUnitAction(h.env, marketingManifest, { chatId: 12345, threadId: 777 }, "Do something with the paid campaigns.");

  assert.deepStrictEqual(result, { kind: "ambiguous" });
  assert.strictEqual(h.aiCalls.length, 1, "Stage 2 must not run once the Hat is unresolved");
  assert.deepStrictEqual(h.sentMessages, [], "Chat never sends a clarifying question");
  assert.deepStrictEqual(h.logBodies, [], "Chat never logs a Blocker on a miss");
});

// --- The generic entry handler -------------------------------------------------

function hatWorkState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-conformance-1",
    chatId: 12345,
    threadId: 777,
    unit: "Marketing",
    hat: "Content Manager",
    stage: "new",
    marketing: { taskText: "" },
    ...overrides,
  } as WorkState;
}

test("the manifest entryHandler captures the request text the generic path never captured, and runs the Hat decision on it", async (t) => {
  const h = makeHarness(t, [DRAFT_DECISION]);
  const state = hatWorkState({ marketing: undefined as any }); // a generic-path Work: nothing captured task text yet
  const hat = marketingManifest.hats["Content Manager"];

  const result = await hat.entryHandler(h.env, state, "handle_request", "Build the editorial calendar.", NO_ACTION_SKILLS);

  assert.strictEqual(result.marketing?.taskText, "Build the editorial calendar.", "the generic entry must capture the task text the compatibility path captures");
  assert.strictEqual(h.aiCalls.length, 1, "exactly the Hat run's decision may run");
  assert.ok(h.aiCalls[0].user.includes("Build the editorial calendar."), "the Hat decision must see the captured task text, not an empty situation");
  assert.strictEqual(result.stage, "awaiting_marketing_draft_approval", "the same execution reaches the same approval gate as the compatibility path");
  assert.ok(h.sentMessages.some((m) => m.includes("Hat: Content Manager.")), "the Hat run must announce itself in the Workspace stream");
  assert.ok(h.sentMessages.some((m) => m.includes("Approve this?")), "the approval gate must be presented");
  assert.deepStrictEqual(h.unexpectedUrls, [], "no unexpected external call may happen");
});

test("the manifest entryHandler never overwrites task text a caller already captured", async (t) => {
  const h = makeHarness(t, [DRAFT_DECISION]);
  const state = hatWorkState({ marketing: { taskText: "Original captured task." } });
  const hat = marketingManifest.hats["Content Manager"];

  const result = await hat.entryHandler(h.env, state, "handle_request", "Original captured task.", NO_ACTION_SKILLS);

  assert.strictEqual(result.marketing?.taskText, "Original captured task.");
  assert.ok(h.aiCalls[0].user.includes("Original captured task."));
});
