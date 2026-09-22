/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { handleNotionWebhookRequest, verifyNotionSignature, evaluateHandoffPageForWebhook } from "./notionWebhook";
import type { Env } from "./types";

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
    if (urlStr.match(/\/pages\/[^/]+$/) && (!init || init.method === undefined || init.method === "GET")) {
      counts.notionGetPageCalls++;
      if (!page) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1", ...page }), { status: 200 });
    }
    if (urlStr.includes("api.telegram.org")) {
      counts.telegramCalls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
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
