import test from "node:test";
import assert from "node:assert";
import {
  salesManifest,
  dispatchSalesExecutiveHat,
  LEAD_OPPORTUNITY_CALLBACK_PREFIX,
  ENTITY_NEW_CALLBACK_PREFIX,
  MATTER_NEW_CALLBACK_PREFIX,
  QUALIFY_CALLBACK_PREFIX,
  PROPOSAL_CALLBACK_PREFIX,
} from "./salesManifest";
import { findCallbackHandler } from "../unitManifest";
import type { Env, WorkState } from "../../types";

/**
 * Covers salesManifest.ts's own declared contract -- the thin Unit
 * Registry wiring around Lead Generation Specialist's existing,
 * already-tested discoverLeadsReadHandler (see
 * leadGenerationDiscovery.test.ts for that capability's own real
 * behavior) and, since the Sales Executive thin-wrap migration, Sales
 * Executive's own already-tested handleIncomingEnquiry (see
 * salesExecutive.test.ts for that capability's own real behavior). This
 * file tests only what salesManifest.ts itself contributes: the
 * manifest/Hat shape, that each Hat's readHandler/entryHandler correctly
 * delegates to its wrapped implementation, and that each Hat's
 * unsupported consequence fails closed -- mirroring the level of
 * coverage strategyManifest.ts/marketingManifest.ts's own thin wrappers
 * rely on their wrapped implementation's tests for, rather than
 * re-testing LeadOpportunityDiscoveryCapability's or
 * handleIncomingEnquiry's own logic here.
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
    unit: "Sales",
    hat: "Lead Generation Specialist",
    ...overrides,
  } as WorkState;
}

test("salesManifest: declares Sales's own two Hats -- Lead Generation Specialist and Sales Executive", () => {
  assert.strictEqual(salesManifest.unit, "Sales");
  assert.deepStrictEqual(new Set(Object.keys(salesManifest.hats)), new Set(["Lead Generation Specialist", "Sales Executive"]));
});

test("salesManifest: Lead Generation Specialist declares exactly one action, discover_leads, as 'read'", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.strictEqual(hat.actions.length, 1);
  assert.strictEqual(hat.actions[0].name, "discover_leads");
  assert.strictEqual(hat.actions[0].consequence, "read");
  assert.ok(hat.actions[0].description.trim().length > 0);
});

test("salesManifest: Lead Generation Specialist's responsibility statement is a real, non-empty description", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.ok(hat.responsibility.trim().length > 0);
});

test("salesManifest: readHandler delegates discover_leads to discoverLeadsReadHandler -- classified as a discovery request sends its own message and returns empty", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const body = String(init?.body ?? "");
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (body.includes("on-demand discovery capability")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isDiscoveryRequest: false }) } }] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in salesManifest readHandler test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const hat = salesManifest.hats["Lead Generation Specialist"];
  const reply = await hat.readHandler(fakeEnv({ GROQ_API_KEY: "key" } as any), "discover_leads", "How's it going?");

  assert.match(reply, /didn't look like a discovery request to Lead Generation Specialist/);
});

test("salesManifest: entryHandler fails closed -- no internal/write action is declared on Lead Generation Specialist", async () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  await assert.rejects(
    () => hat.entryHandler(fakeEnv(), fakeWorkState(), "discover_leads", "text"),
    /not an internal\/write action on Lead Generation Specialist/,
  );
});

test("salesManifest: awaitingHandlers is empty -- Lead Generation Specialist has no multi-turn hold/resume flow", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.deepStrictEqual(hat.awaitingHandlers, {});
});

test("salesManifest: Lead Generation Specialist declares exactly leadopportunity in callbackHandlers", () => {
  const hat = salesManifest.hats["Lead Generation Specialist"];
  assert.deepStrictEqual(Object.keys(hat.callbackHandlers ?? {}), [LEAD_OPPORTUNITY_CALLBACK_PREFIX]);
});

test("findCallbackHandler resolves leadopportunity on Lead Generation Specialist and genuinely delegates to handleLeadOpportunityApproval -- rejecting a pending finding clears it and replies, proving real delegation", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in salesManifest leadopportunity delegation test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const hat = salesManifest.hats["Lead Generation Specialist"];
  const handler = findCallbackHandler(LEAD_OPPORTUNITY_CALLBACK_PREFIX, hat);
  assert.ok(handler, "leadopportunity must resolve on Lead Generation Specialist's own manifest entry");

  const state = fakeWorkState({
    pendingLeadOpportunity: { organisation: "Acme Co", evidence: "Some evidence", reason: "Some reason", sourceUrl: "https://example.com", handoffId: "handoff-1" },
  });

  const result = await handler(fakeEnv(), state, false);

  assert.strictEqual(result.pendingLeadOpportunity, undefined);
});

test("salesManifest: Sales Executive declares exactly one action, new_enquiry, as 'write' requiring approval", () => {
  const hat = salesManifest.hats["Sales Executive"];
  assert.strictEqual(hat.actions.length, 1);
  assert.strictEqual(hat.actions[0].name, "new_enquiry");
  assert.strictEqual(hat.actions[0].consequence, "write");
  assert.strictEqual(hat.actions[0].requiresApproval, true);
  assert.ok(hat.actions[0].description.trim().length > 0);
});

test("salesManifest: Sales Executive's responsibility statement is a real, non-empty description", () => {
  const hat = salesManifest.hats["Sales Executive"];
  assert.ok(hat.responsibility.trim().length > 0);
});

test("salesManifest: Sales Executive's readHandler fails closed -- no read action is declared", async () => {
  const hat = salesManifest.hats["Sales Executive"];
  await assert.rejects(
    () => hat.readHandler(fakeEnv(), "new_enquiry", "text"),
    /not a read action -- Sales Executive only declares "new_enquiry"/,
  );
});

test("salesManifest: Sales Executive's awaitingHandlers is empty -- continuation states stay hardcoded in session.ts", () => {
  const hat = salesManifest.hats["Sales Executive"];
  assert.deepStrictEqual(hat.awaitingHandlers, {});
});

test("salesManifest: Sales Executive's entryHandler/dispatchSalesExecutiveHat genuinely delegates to salesExecutive.ts's handleIncomingEnquiry", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("api.notion.com") && String(url).includes("/pages")) {
      return new Response(JSON.stringify({ id: "log-page-1" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in salesManifest Sales Executive delegation test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({
    AI: { run: async () => ({ response: JSON.stringify({}) }) },
  } as any);
  const state = fakeWorkState({ hat: "Sales Executive" });

  const hat = salesManifest.hats["Sales Executive"];
  const result = await hat.entryHandler(env, state, "new_enquiry", "Some inbound enquiry text");

  assert.strictEqual(result.enquiryText, "Some inbound enquiry text");
  assert.strictEqual(result.entryType, "inbound_enquiry");
  assert.strictEqual(result.stage, "awaiting_entity_pick");
  assert.strictEqual(result.awaiting, "entity_pick");
  assert.ok(result.entityDraft);

  const viaDispatch = await dispatchSalesExecutiveHat(env, fakeWorkState({ hat: "Sales Executive" }), "Another enquiry");
  assert.strictEqual(viaDispatch.stage, "awaiting_entity_pick");
});

test("salesManifest: Sales Executive declares exactly entitynew, matternew, qualify, and proposal in callbackHandlers", () => {
  const hat = salesManifest.hats["Sales Executive"];
  assert.deepStrictEqual(
    new Set(Object.keys(hat.callbackHandlers ?? {})),
    new Set([ENTITY_NEW_CALLBACK_PREFIX, MATTER_NEW_CALLBACK_PREFIX, QUALIFY_CALLBACK_PREFIX, PROPOSAL_CALLBACK_PREFIX]),
  );
});

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in salesManifest Sales Executive callback delegation test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("findCallbackHandler resolves entitynew on Sales Executive and genuinely delegates to handleEntityCreationApproval -- rejecting a pending Entity draft holds on entity_redo_reason, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const hat = salesManifest.hats["Sales Executive"];
  const handler = findCallbackHandler(ENTITY_NEW_CALLBACK_PREFIX, hat);
  assert.ok(handler, "entitynew must resolve on Sales Executive's own manifest entry");

  const state = fakeWorkState({ hat: "Sales Executive", entityDraft: { name: "Acme Co", email: "", phone: "", type: "Company" } });
  const result = await handler(fakeEnv(), state, false);

  assert.strictEqual(result.stage, "entity_redo_requested");
  assert.strictEqual(result.awaiting, "entity_redo_reason");
});

test("findCallbackHandler resolves matternew on Sales Executive and genuinely delegates to handleMatterCreationApproval -- rejecting a pending Matter draft holds on matter_redo_reason, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const hat = salesManifest.hats["Sales Executive"];
  const handler = findCallbackHandler(MATTER_NEW_CALLBACK_PREFIX, hat);
  assert.ok(handler, "matternew must resolve on Sales Executive's own manifest entry");

  const state = fakeWorkState({ hat: "Sales Executive", matterDraft: { name: "Website redesign", statedNeed: "Needs a new site" } });
  const result = await handler(fakeEnv(), state, false);

  assert.strictEqual(result.stage, "matter_redo_requested");
  assert.strictEqual(result.awaiting, "matter_redo_reason");
});

test("findCallbackHandler resolves qualify on Sales Executive and genuinely delegates to handleLeadToProspectApproval -- rejecting a pending qualification holds on call_notes, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const hat = salesManifest.hats["Sales Executive"];
  const handler = findCallbackHandler(QUALIFY_CALLBACK_PREFIX, hat);
  assert.ok(handler, "qualify must resolve on Sales Executive's own manifest entry");

  const state = fakeWorkState({ hat: "Sales Executive", stage: "awaiting_qualification_approval", entityName: "Acme Co" });
  const result = await handler(fakeEnv(), state, false);

  assert.strictEqual(result.stage, "qualification_hold");
  assert.strictEqual(result.awaiting, "call_notes");
});

test("findCallbackHandler resolves proposal on Sales Executive and genuinely delegates to handleProposalApproval -- rejecting a pending proposal holds on proposal_feedback, proving real delegation", async (t) => {
  mockTelegramFetch(t);
  const hat = salesManifest.hats["Sales Executive"];
  const handler = findCallbackHandler(PROPOSAL_CALLBACK_PREFIX, hat);
  assert.ok(handler, "proposal must resolve on Sales Executive's own manifest entry");

  const state = fakeWorkState({ hat: "Sales Executive", stage: "awaiting_proposal_approval" });
  const result = await handler(fakeEnv(), state, false);

  assert.strictEqual(result.stage, "awaiting_proposal_revision");
  assert.strictEqual(result.awaiting, "proposal_feedback");
});

test("salesManifest: registers Stage 1/2 SemanticTaskIds required by UnitManifest's shape", () => {
  assert.strictEqual(salesManifest.intakeClassificationTaskId, "sales.intake_classification");
  assert.strictEqual(salesManifest.actionClassificationTaskId, "sales.hat_action_decision");
  assert.ok(salesManifest.intakeIntroLine.trim().length > 0);
});
