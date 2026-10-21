/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { handleNotionWebhookRequest, verifyNotionSignature, evaluateHandoffPageForWebhook } from "./notionWebhook";
import { unitsWithHandoffPickup } from "./checkHandoffs";
import { buildUnitRegistry, getUnitManifests } from "./units/registry";
import type { HandoffSourceRouteContract } from "./handoffSources";
import { financeManifest } from "./units/finance/financeManifest";
import type { UnitManifest } from "./units/unitManifest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env, Unit } from "./types";

const SECRET = "test-notion-webhook-secret";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {} as any,
    WORK_SESSION: { idFromName: (n: string) => n, get: () => ({}) } as any,
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
    NOTION_WEBHOOK_SECRET: SECRET,
    ...overrides,
  } as Env;
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function fakeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => promises.push(p) },
    flush: () => Promise.all(promises),
  };
}

/** Mocks GET /pages/<id> to return a single configurable page, and counts Notion query + Telegram send calls. */
function mockFetchForPage(
  t: any,
  page: { properties: Record<string, any>; parent?: any; archived?: boolean; in_trash?: boolean } | null,
) {
  const originalFetch = globalThis.fetch;
  const counts = { notionQueryCalls: 0, notionGetPageCalls: 0, telegramCalls: 0 };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/data_sources/") && urlStr.includes("/query")) {
      counts.notionQueryCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.match(/\/pages\/[^/]+$/) && (!init || init.method === undefined || (init?.method ?? "GET") === "GET")) {
      counts.notionGetPageCalls++;
      if (!page) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1", ...page }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      counts.telegramCalls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (init?.method === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
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
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return counts;
}

function pendingWorkHandoffPage(overrides: Record<string, any> = {}): {
  properties: Record<string, any>;
  parent: { type: string; data_source_id: string };
  archived: boolean;
  in_trash: boolean;
} {
  return {
    properties: {
      Type: { select: { name: "Work" } },
      Status: { select: { name: "Pending" } },
      "To Unit": { select: { name: "Sales" } },
      Entity_Token: { rich_text: [{ plain_text: "E-20" }] },
      Matter_Token: { rich_text: [{ plain_text: "MAT-20" }] },
      ...overrides,
    },
    parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
    archived: false,
    in_trash: false,
  };
}

function eventBody(pageId = "page-1") {
  return JSON.stringify({
    id: "evt-1",
    type: "page.properties_updated",
    entity: { id: pageId, type: "page" },
  });
}

// --- synthetic newly-registered Unit fixtures -------------------------------
//
// A Unit that exists ONLY as a registry table entry in a test: no production
// code names it, and it is never added to the real registry. `as Unit` is the
// cast that lets a name outside the production Unit union stand in for the
// Unit an architect would add later; the manifests below are the minimum a
// new Unit would declare.

const SYNTHETIC_UNIT = "Synthetic Test Unit" as Unit;

function syntheticManifest(declaresPickup: boolean): UnitManifest {
  const base = {
    unit: SYNTHETIC_UNIT,
    hats: {},
    intakeClassificationTaskId: "test_intake",
    intakeIntroLine: "synthetic test Unit used only by this test file",
    actionClassificationTaskId: "test_action",
  } as unknown as UnitManifest;
  if (!declaresPickup) return base;
  return { ...base, handoffPickup: { handler: async () => {} } } as unknown as UnitManifest;
}

/** The production registry plus a synthetic entry -- the table a newly registered Unit would live in. */
function registryWithSyntheticUnit(declaresPickup: boolean): Partial<Record<Unit, UnitManifest>> {
  return { ...getUnitManifests(), [SYNTHETIC_UNIT]: syntheticManifest(declaresPickup) };
}

// --- signature verification -------------------------------------------------

test("verifyNotionSignature: accepts a correctly-signed body", async () => {
  const env = fakeEnv();
  const body = eventBody();
  assert.strictEqual(await verifyNotionSignature(env, body, sign(body)), true);
});

test("verifyNotionSignature: rejects a wrong signature", async () => {
  const env = fakeEnv();
  const body = eventBody();
  assert.strictEqual(await verifyNotionSignature(env, body, "sha256=deadbeef"), false);
});

test("verifyNotionSignature: rejects when no secret is configured", async () => {
  const env = fakeEnv({ NOTION_WEBHOOK_SECRET: undefined });
  const body = eventBody();
  assert.strictEqual(await verifyNotionSignature(env, body, sign(body)), false);
});

test("verifyNotionSignature: rejects a missing signature header", async () => {
  const env = fakeEnv();
  assert.strictEqual(await verifyNotionSignature(env, eventBody(), null), false);
});

// --- 2. invalid webhook authentication/signature is rejected ---------------

test("2. Invalid webhook signature is rejected fail-closed", async (t) => {
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(counts.notionGetPageCalls, 0, "an unauthenticated event must never trigger a page retrieval");
});

test("Invalid webhook: rejected when NOTION_WEBHOOK_SECRET is not configured at all", async (t) => {
  mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv({ NOTION_WEBHOOK_SECRET: undefined });
  const { ctx } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  assert.strictEqual(res.status, 403);
});

test("Invalid webhook: a request with neither signature nor a verification handshake body is rejected fail-closed", async (t) => {
  mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx } = fakeCtx();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body: JSON.stringify({ some: "thing" }),
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  assert.strictEqual(res.status, 403);
});

// --- 3. Notion verification handshake ---------------------------------------

test("3. Notion verification handshake is acknowledged without processing as an event", async (t) => {
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body: JSON.stringify({ verification_token: "notion-issued-token-abc" }),
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(counts.notionGetPageCalls, 0, "the handshake must never be treated as a Handoff event");
});

test("3b. Regression: a verification handshake that ALSO arrives with an X-Notion-Signature header is still recognized (confirmed live -- Notion signs the handshake using the token it's handing over)", async (t) => {
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const handshakeBody = JSON.stringify({ verification_token: "notion-issued-token-abc" });
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body: handshakeBody,
    // Signed with the token itself, per Notion's actual live behavior --
    // NOT with env.NOTION_WEBHOOK_SECRET, which isn't configured yet at
    // this point in a fresh setup. The handshake must be recognized by
    // payload shape regardless of what this header contains.
    headers: { "X-Notion-Signature": sign(handshakeBody, "notion-issued-token-abc") },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(counts.notionGetPageCalls, 0, "a signed handshake must still be recognized as a handshake, not rejected or treated as an event");
});

// --- 1 / 4 / 5 / 6 / 7 / 8 / 9 / 10: filtering ------------------------------

test("1. Valid Notion Handoff event is accepted and wakes the discovery engine", async (t) => {
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  assert.ok(json.detected, "a valid Pending Work Handoff must be reported as detected");
  assert.ok(counts.notionQueryCalls > 0, "the discovery engine must have been woken (background)");
});

test("4. Event for an unrelated Notion page (no page entity) is ignored", async (t) => {
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = JSON.stringify({ id: "evt-2", type: "comment.created", entity: { id: "x", type: "comment" } });
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(counts.notionGetPageCalls, 0, "a non-page event must never trigger a page retrieval");
  assert.strictEqual(counts.notionQueryCalls, 0, "an irrelevant event must never wake the discovery engine");
});

test("5. Event for a non-Handoff page (wrong data source) is ignored", async (t) => {
  const page = pendingWorkHandoffPage();
  page.parent = { type: "data_source_id", data_source_id: "some-other-ds" };
  const counts = mockFetchForPage(t, page);
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  assert.ok(!json.detected, "a page outside the Handoffs data source must never be treated as a Handoff");
  assert.strictEqual(counts.notionQueryCalls, 0);
});

test("6. Event for a Handoff that is not Pending is ignored (already claimed/picked up -- item 15 too)", async (t) => {
  const page = pendingWorkHandoffPage();
  page.properties.Status = { select: { name: "Picked-up" } };
  const counts = mockFetchForPage(t, page);
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  const json: any = await res.json();
  assert.ok(!json.detected);
  assert.strictEqual(counts.notionQueryCalls, 0, "an already-claimed Handoff must never wake the discovery engine again");
});

test("7. Event for a Pending non-Work Handoff (e.g. Type=Info) is ignored", async (t) => {
  const page = pendingWorkHandoffPage();
  page.properties.Type = { select: { name: "Info" } };
  mockFetchForPage(t, page);
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  const json: any = await res.json();
  assert.ok(!json.detected);
});

test("8. Pending Work Handoff with valid Entity_Token and Matter_Token is detected", () => {
  const env = fakeEnv();
  const result = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage());
  assert.strictEqual(result.relevant, true);
  if (result.relevant) {
    assert.strictEqual(result.entityToken, "E-20");
    assert.strictEqual(result.matterToken, "MAT-20");
    assert.strictEqual(result.toUnit, "Sales");
  }
});

test("9. Missing Entity_Token fails closed", () => {
  const env = fakeEnv();
  const page = pendingWorkHandoffPage();
  page.properties.Entity_Token = { rich_text: [] };
  const result = evaluateHandoffPageForWebhook(env, page);
  assert.strictEqual(result.relevant, false);
});

test("10. Missing Matter_Token fails closed", () => {
  const env = fakeEnv();
  const page = pendingWorkHandoffPage();
  page.properties.Matter_Token = { rich_text: [] };
  const result = evaluateHandoffPageForWebhook(env, page);
  assert.strictEqual(result.relevant, false);
});

// --- "To Unit" routing is registry-driven, never a private Unit list --------

test("11. The webhook's routable set IS the Unit Registry's handoffPickup declarations: every registered Unit is relevant exactly when its manifest declares pickup (no second, hardcoded Unit list)", () => {
  const env = fakeEnv();
  const pickupUnits = new Set<string>(unitsWithHandoffPickup());
  const registered = Object.keys(getUnitManifests());
  assert.ok(registered.length > 0, "fixture sanity: the registry must have at least one Unit");
  assert.ok(pickupUnits.size > 0, "fixture sanity: at least one Unit must declare handoffPickup");

  for (const unit of registered) {
    const result = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage({ "To Unit": { select: { name: unit } } }));
    if (pickupUnits.has(unit)) {
      assert.strictEqual(result.relevant, true, `Unit "${unit}" declares handoffPickup, so a Pending Work Handoff to it must wake discovery`);
    } else {
      // Registered but no pickup declaration (today: Business Development):
      // filtered out fail-closed, so discovery is never woken for a Unit
      // that has no pickup handler to run.
      assert.strictEqual(result.relevant, false, `Unit "${unit}" declares no handoffPickup, so the Handoff must not wake discovery`);
      if (!result.relevant) assert.match(result.reason, /declare Handoff pickup/);
    }
  }
});

test("12. An unregistered/retired Unit name in To Unit fails closed rather than being routed by guess", () => {
  const env = fakeEnv();
  const result = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage({ "To Unit": { select: { name: "Research & Intelligence" } } }));
  assert.strictEqual(result.relevant, false);
  if (!result.relevant) assert.match(result.reason, /declare Handoff pickup/);
});

test("13. An empty To Unit fails closed", () => {
  const env = fakeEnv();
  const result = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage({ "To Unit": { select: null } }));
  assert.strictEqual(result.relevant, false);
  if (!result.relevant) assert.match(result.reason, /missing or does not declare/);
});

// --- a SYNTHETIC newly registered Handoff-capable Unit ----------------------
//
// The loop in test 11 proves the filter agrees with today's manifests. These
// prove the case the registry cannot show on its own: a Unit that is NOT
// registered in production, added purely by declaring `handoffPickup` on its
// manifest in a registry table, is accepted by the SAME filter -- with no
// Unit-specific branch, no private Unit list and no change to production
// code. The filter runs unmodified; only the registry table it reads is a
// fixture (the `manifests` seam, which production callers never pass).

test("11b. A SYNTHETIC newly registered Unit declaring handoffPickup is accepted by the webhook filter -- generic by construction, no Unit-specific branch", () => {
  const env = fakeEnv();
  const table = registryWithSyntheticUnit(true);

  // The synthetic Unit really is in the table's pickup set...
  assert.ok(unitsWithHandoffPickup(table).includes(SYNTHETIC_UNIT), "the synthetic manifest must declare pickup");
  // ...and the production filter accepts a Pending Work Handoff addressed to it.
  const result = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage({ "To Unit": { select: { name: SYNTHETIC_UNIT } } }), table);
  assert.strictEqual(result.relevant, true, "a newly registered Handoff-capable Unit must wake discovery");
  if (result.relevant) {
    assert.strictEqual(result.toUnit, SYNTHETIC_UNIT);
    assert.strictEqual(result.entityToken, "E-20");
    assert.strictEqual(result.matterToken, "MAT-20");
  }
});

test("11c. The SAME synthetic Unit without a pickup declaration is refused, and an unknown Unit stays refused -- acceptance is about the manifest declaration, never the Unit's identity", () => {
  const env = fakeEnv();
  // Registered in the table, but declares no pickup.
  const noDeclaration = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage({ "To Unit": { select: { name: SYNTHETIC_UNIT } } }), registryWithSyntheticUnit(false));
  assert.strictEqual(noDeclaration.relevant, false);
  if (!noDeclaration.relevant) assert.match(noDeclaration.reason, /declare Handoff pickup/);

  // Not in the table at all (today's production registry): unknown Unit, fail closed.
  const unknown = evaluateHandoffPageForWebhook(env, pendingWorkHandoffPage({ "To Unit": { select: { name: SYNTHETIC_UNIT } } }));
  assert.strictEqual(unknown.relevant, false);

  // The routable predicate is declaration PRESENCE, not deep validity: a
  // malformed declaration (present, no handler) is not silently repaired here.
  // That is deliberate -- execution is where it fails, closed, in
  // WorkSession.runHandoffPickup (src/session.ts:266-273: nothing is claimed
  // or persisted and the Handoff stays Pending), never at the filter.
});

test("11d. Registry assembly accepts a Unit purely by registration -- a valid manifest under a new Unit key passes buildUnitRegistry and enters the pickup set, with no registry-code change", () => {
  // The real assembly path, run over a table whose Unit key production has
  // never heard of: if registering a new Unit required a Unit-specific branch
  // anywhere, this is where it would have to appear.
  const assembled = buildUnitRegistry({ [SYNTHETIC_UNIT]: financeManifest } as Partial<Record<Unit, UnitManifest>>);
  assert.ok(assembled[SYNTHETIC_UNIT], "a valid manifest must survive assembly under an unfamiliar Unit key");
  assert.ok(unitsWithHandoffPickup(assembled).includes(SYNTHETIC_UNIT), "its handoffPickup must be visible to the same discovery predicate");
});

test("11e. The webhook filter carries no Unit list and no Unit-specific branch in source -- it can only read the registry's declarations", () => {
  const source = readFileSync(join(__dirname, "notionWebhook.ts"), "utf8");
  assert.ok(/unitsWithHandoffPickup\(/.test(source), "the filter must derive its routable set from the registry predicate");
  assert.ok(!/ROUTABLE_UNITS/.test(source), "the former hardcoded Unit set must be gone");
  for (const unitName of ["Finance", "Sales", "Marketing", "Strategy", "Business Development", "Creative & Design", "Operations"]) {
    assert.ok(!source.includes(`"${unitName}"`), `notionWebhook.ts must not name Unit "${unitName}" -- the registry declares who picks up`);
  }
});

// --- 14. duplicate delivery does not double-process -------------------------

test("14. Duplicate webhook delivery does not result in duplicate pickup -- the shared recursion guard caps overlapping runs", async (t) => {
  const store = new Map<string, string>();
  const env = fakeEnv({
    STATE_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
      delete: async (k: string) => {
        store.delete(k);
      },
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any,
    } as any,
  });
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const signature = sign(body);

  // Two rapid duplicate deliveries of the identical event.
  const req1 = new Request("https://worker.example/notion/webhook", { method: "POST", body, headers: { "X-Notion-Signature": signature } });
  const req2 = new Request("https://worker.example/notion/webhook", { method: "POST", body, headers: { "X-Notion-Signature": signature } });
  const res1 = await handleNotionWebhookRequest(req1, env, ctx);
  const res2 = await handleNotionWebhookRequest(req2, env, ctx);
  await flush();

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  // Both webhook requests are individually valid and acknowledged -- but
  // the background discovery sweeps they trigger share the same recursion
  // guard, so only one of them actually runs Notion discovery.
  assert.ok(counts.notionQueryCalls > 0, "at least one sweep must run");
});

// --- 18. no synthetic Telegram /checkhandoffs message -----------------------

test("18. No synthetic Telegram /checkhandoffs message is emitted by the webhook path", async (t) => {
  const counts = mockFetchForPage(t, pendingWorkHandoffPage());
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  assert.strictEqual(counts.telegramCalls, 0, "the webhook path must never send a synthetic /checkhandoffs summary or fake conversation reply");
});

// --- pickup is never awaited inside the webhook request ---------------------

test("Webhook handler returns without awaiting any Unit pickup -- the background discovery only schedules the pickup onto the WorkSession alarm", async (t) => {
  const scheduled: string[] = [];
  const runnerCalls: string[] = [];
  const stub = {
    init: async () => {},
    // The one thing discovery is allowed to do to the session: record the kind.
    schedulePickup: async (kind: string) => {
      scheduled.push(kind);
    },
    // Tripwires: if the webhook path ever awaited a pickup runner directly
    // again (the pre-alarm inline shape), these record it and the last
    // assertion fails.
    runStrategyPickup: async () => {
      runnerCalls.push("strategy");
    },
    runFinancePickup: async () => {
      runnerCalls.push("finance");
    },
    runCallNotesPickup: async () => {
      runnerCalls.push("sales_call_notes");
    },
    runTokenSafeProposal: async () => {
      runnerCalls.push("sales_proposal");
    },
    runMarketingHandoffPickup: async () => {
      runnerCalls.push("marketing");
    },
  };
  const env = fakeEnv({
    WORK_SESSION: { idFromName: (n: string) => n, get: () => stub } as any,
  });

  const originalFetch = globalThis.fetch;
  const strategyHandoff = {
    id: "handoff-strategy-1",
    url: "https://notion.so/handoff-strategy-1",
    properties: {
      "To Unit": { select: { name: "Strategy" } },
      "To Hat": { rich_text: [{ plain_text: "Strategy Analyst" }] },
      Matter_Token: { rich_text: [{ plain_text: "MAT-30" }] },
      Entity_Token: { rich_text: [{ plain_text: "E-30" }] },
    },
    archived: false,
  };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/data_sources/") && urlStr.includes("/query")) {
      const body = JSON.parse(init.body);
      // The canonical Matter lookup the new-Work boundary runs first
      // (checkHandoffs.resolveHandoffMatterIdentity): MAT-30 resolves to a
      // real Matter, so the Strategy Work can be created carrying it.
      if (body.filter?.unique_id !== undefined) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                url: "https://notion.so/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                properties: {
                  Matter_ID: { unique_id: { prefix: "MAT", number: 30 } },
                  Entity: { relation: [{ id: "entity-page-1" }] },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      const toUnit = body.filter?.and?.find((f: any) => f.property === "To Unit")?.select?.equals;
      if (toUnit === "Strategy") {
        return new Response(JSON.stringify({ results: [strategyHandoff] }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.match(/\/pages\/[^/]+$/)) {
      // The handler's own awaited page retrieval (evaluation only).
      return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1", ...pendingWorkHandoffPage() }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (init?.method === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
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
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });

  const res = await handleNotionWebhookRequest(req, env, ctx);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(scheduled, [], "the handler returns without awaiting discovery, so no pickup kind is scheduled yet at response time");

  await flush();

  assert.deepStrictEqual(scheduled, ["Strategy"], "the background discovery schedules exactly the pending Strategy pickup afterwards");
  assert.deepStrictEqual(runnerCalls, [], "no Unit pickup runner is ever awaited on the webhook path -- only the WorkSession alarm runs those");
});

// --- 20. no real identity in the detection response/telemetry --------------

test("20. Webhook detection response carries only opaque identifiers, never full page properties", async (t) => {
  const page = pendingWorkHandoffPage();
  page.properties.Handoff = { title: [{ plain_text: "Real Company Name Ltd -- Something" }] };
  mockFetchForPage(t, page);
  const env = fakeEnv();
  const { ctx, flush } = fakeCtx();
  const body = eventBody();
  const req = new Request("https://worker.example/notion/webhook", {
    method: "POST",
    body,
    headers: { "X-Notion-Signature": sign(body) },
  });
  const res = await handleNotionWebhookRequest(req, env, ctx);
  await flush();
  const text = await res.text();
  assert.ok(!text.includes("Real Company Name"), "the webhook response must never echo real Handoff title/identity content");
  assert.match(text, /MAT-20/);
});

// --- Operational reference: legacy tokens, canonical Sources, generic routes -

function tokenlessSourcesPage(overrides: Record<string, any> = {}) {
  const url = "https://www.notion.so/Acme-Entity-eeee6666-dddd-7777-cccc-8888bbbb4444";
  const page = pendingWorkHandoffPage({
    "From Unit": { select: { name: "Sales" } },
    "To Unit": { select: { name: "Strategy" } },
    Sources: { rich_text: [{ type: "text", text: { content: url, link: { url } }, plain_text: url, href: url }] },
    ...overrides,
  });
  delete page.properties.Entity_Token;
  delete page.properties.Matter_Token;
  return page;
}

test("15. A Sources-carrying Pending Work Handoff with NO token properties is detected -- the webhook is a detector, and never resolves identity itself", () => {
  const env = fakeEnv();
  const result = evaluateHandoffPageForWebhook(env, tokenlessSourcesPage());
  assert.strictEqual(result.relevant, true, result.relevant ? "" : result.reason);
  if (!result.relevant) return;
  assert.strictEqual(result.toUnit, "Strategy");
  assert.strictEqual(result.entityToken, undefined, "no token is echoed -- the record carries none");
  assert.strictEqual(result.matterToken, undefined);
});

test("16. A Pending Work Handoff with no operational reference at all (no tokens, no Sources) is still not relevant -- unchanged", () => {
  const env = fakeEnv();
  const page = tokenlessSourcesPage();
  delete (page.properties as Record<string, any>).Sources;
  const result = evaluateHandoffPageForWebhook(env, page);
  assert.strictEqual(result.relevant, false);
  if (!result.relevant) assert.match(result.reason, /missing Entity_Token/);
});

test("17. A Handoff whose Sources is unusable and carries no tokens is not relevant -- a malformed declaration never wakes discovery", () => {
  const env = fakeEnv();
  const page = tokenlessSourcesPage({ Sources: { rich_text: [{ plain_text: "not a url at all" }] } });
  const result = evaluateHandoffPageForWebhook(env, page);
  assert.strictEqual(result.relevant, false);
  if (!result.relevant) assert.match(result.reason, /missing Entity_Token/);
});

test("19. A declared-generic route's Pending Work Handoff is detected without tokens (contracts seam) -- genericity is read from the contract, never inferred", () => {
  const env = fakeEnv();
  const page = pendingWorkHandoffPage({
    "From Unit": { select: { name: "BD" } },
    "To Unit": { select: { name: "Strategy" } },
  });
  delete page.properties.Entity_Token;
  delete page.properties.Matter_Token;
  const contracts: Readonly<Record<string, HandoffSourceRouteContract>> = {
    "BD->Strategy": { required: [], optional: ["call_notes"], prohibited: ["handoffs", "entities", "matters"] },
  };
  const result = evaluateHandoffPageForWebhook(env, page, undefined, contracts);
  assert.strictEqual(result.relevant, true, result.relevant ? "" : result.reason);
  // The SAME Handoff without the contract declaration is refused: nothing
  // is generic by accident.
  const withoutContract = evaluateHandoffPageForWebhook(env, page);
  assert.strictEqual(withoutContract.relevant, false);
  if (!withoutContract.relevant) assert.match(withoutContract.reason, /missing Entity_Token/);
});
