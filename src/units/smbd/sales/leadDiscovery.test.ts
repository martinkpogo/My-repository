import test from "node:test";
import assert from "node:assert";
import {
  handleLeadDiscoverySignal,
  isCheckableUrl,
  LEAD_SIGNAL_USAGE,
  parseLeadSignal,
  redactSignalForClassification,
} from "./leadDiscovery";
import type { Env } from "../../../types";

test("parseLeadSignal requires Name, Source, and Evidence -- Contact and Entity are optional", () => {
  const full = parseLeadSignal(
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for help\nContact: jane@acme.com\nEntity: https://notion.so/Acme-Corp-3cecb0001111222233334444555566667777",
  );
  assert.strictEqual(full?.name, "Acme Corp");
  assert.strictEqual(full?.source, "https://example.com/post");
  assert.strictEqual(full?.evidence, "Posted looking for help");
  assert.strictEqual(full?.contact, "jane@acme.com");
  assert.ok(full?.entityRef.length);

  const minimal = parseLeadSignal("Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for help");
  assert.strictEqual(minimal?.contact, "");
  assert.strictEqual(minimal?.entityRef, "");
});

test("parseLeadSignal fails closed when a required field is missing", () => {
  assert.strictEqual(parseLeadSignal(""), null);
  assert.strictEqual(parseLeadSignal("Name: Acme Corp\nSource: https://example.com"), null);
  assert.strictEqual(parseLeadSignal("Name: Acme Corp\nEvidence: something"), null);
});

test("isCheckableUrl accepts only real http/https URLs", () => {
  assert.strictEqual(isCheckableUrl("https://example.com/post"), true);
  assert.strictEqual(isCheckableUrl("http://example.com"), true);
  assert.strictEqual(isCheckableUrl("not a url"), false);
  assert.strictEqual(isCheckableUrl("ftp://example.com"), false);
  assert.strictEqual(isCheckableUrl(""), false);
});

test("redactSignalForClassification never leaks the discovered name or contact into the classification text", () => {
  const redacted = redactSignalForClassification({
    name: "Acme Corp",
    source: "https://example.com/post",
    evidence: "Acme Corp posted asking for help, contact jane@acme.com directly",
    contact: "jane@acme.com",
    entityRef: "",
  });
  assert.ok(!redacted.includes("Acme Corp"));
  assert.ok(!redacted.includes("jane@acme.com"));
  assert.ok(redacted.includes("[Organisation/Contact]"));
  assert.ok(redacted.includes("[Contact Details]"));
  assert.ok(redacted.includes("https://example.com/post"));
});

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    STATE_KV: {
      get: async () => null,
      put: async () => {},
    } as any,
    ...overrides,
  } as Env;
}

const GENUINE_CLASSIFICATION_BODY = JSON.stringify({ genuine: true, category: "consulting", reason: "clear need stated" });

function stockFetchHandlers(overrides: {
  onEntityGet?: (url: string) => Response;
  onLeadsQuery?: () => Response;
  onLeadsCreate?: (body: any) => Response;
  onEntityQuery?: () => Response;
} = {}) {
  return (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (typeof url === "string" && url.includes("/pages/") && method === "GET") {
      if (overrides.onEntityGet) return overrides.onEntityGet(url);
      return new Response("Not found", { status: 404 });
    }
    if (typeof url === "string" && url.includes("entity-ds") && method === "POST") {
      // Entity duplicate-search endpoint -- must never be hit post-redesign.
      if (overrides.onEntityQuery) return overrides.onEntityQuery();
      throw new Error("Unexpected query against Entity data source -- Lead Discovery must never search Entity");
    }
    if (typeof url === "string" && url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      if (overrides.onLeadsQuery) return overrides.onLeadsQuery();
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      // logActivity also POSTs to /pages (against ACTIVITY_LOG_DATA_SOURCE_ID)
      // after the Lead itself is created -- only route the Lead-creation
      // callback for the call actually targeting the Leads data source, so
      // the Activity Log write (which never carries an Entity property)
      // can't overwrite what the test observed about the Lead's own write.
      if (overrides.onLeadsCreate && body.parent?.data_source_id === "leads-ds") return overrides.onLeadsCreate(body);
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: GENUINE_CLASSIFICATION_BODY } }] }), { status: 200 });
  }) as typeof fetch;
}

test("handleLeadDiscoverySignal sends usage instructions when the signal can't be parsed", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = (async (_url: string, init: any) => {
    sentText = JSON.parse(init.body).text;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(fakeEnv(), 1, undefined, "not structured at all");

  assert.ok(sentText.includes(LEAD_SIGNAL_USAGE));
});

test("handleLeadDiscoverySignal refuses a signal with an unverifiable Source rather than fabricating one", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = (async (_url: string, init: any) => {
    sentText = JSON.parse(init.body).text;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(
    fakeEnv(),
    1,
    undefined,
    "Name: Acme Corp\nSource: heard it secondhand\nEvidence: someone mentioned it",
  );

  assert.ok(sentText.includes("checkable URL"));
});

test("handleLeadDiscoverySignal never queries Entity when no Entity reference is given -- only reads it via an explicit reference", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadCreated = false;
  let createdProperties: any;
  globalThis.fetch = stockFetchHandlers({
    onLeadsCreate: (body) => {
      leadCreated = true;
      createdProperties = body.properties;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(
    fakeEnv({ GROQ_API_KEY: "key" }),
    1,
    undefined,
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for consulting help",
  );

  assert.strictEqual(leadCreated, true);
  assert.strictEqual(createdProperties.Entity, undefined, "no Entity relation should be set without an explicit, verified reference");
});

test("handleLeadDiscoverySignal relates the Lead to an explicitly provided Entity once verified", async (t) => {
  const originalFetch = globalThis.fetch;
  let createdProperties: any;
  globalThis.fetch = stockFetchHandlers({
    onEntityGet: () =>
      new Response(JSON.stringify({ id: "entity-page-1", url: "https://notion.so/entity-page-1", properties: { Name: { title: [{ plain_text: "Acme Corp" }] } } }), {
        status: 200,
      }),
    onLeadsCreate: (body) => {
      createdProperties = body.properties;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(
    fakeEnv({ GROQ_API_KEY: "key" }),
    1,
    undefined,
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for consulting help\nEntity: https://notion.so/Acme-Corp-3cecb0001111222233334444555566667777",
  );

  assert.deepStrictEqual(createdProperties.Entity, { relation: [{ id: "entity-page-1" }] });
});

test("handleLeadDiscoverySignal surfaces a conflict instead of linking when the explicit Entity doesn't match the Lead name", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  let createdProperties: any;
  globalThis.fetch = stockFetchHandlers({
    onEntityGet: () =>
      new Response(JSON.stringify({ id: "entity-page-1", url: "https://notion.so/entity-page-1", properties: { Name: { title: [{ plain_text: "Totally Different Co" }] } } }), {
        status: 200,
      }),
    onLeadsCreate: (body) => {
      createdProperties = body.properties;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    },
  });
  const originalTelegramFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
    }
    return originalTelegramFetch(url as any, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(
    fakeEnv({ GROQ_API_KEY: "key" }),
    1,
    undefined,
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for consulting help\nEntity: https://notion.so/Some-Page-3cecb0001111222233334444555566667777",
  );

  assert.strictEqual(createdProperties.Entity, undefined, "a conflicting reference must never be linked");
  assert.ok(sentText.includes("does not clearly match"));
});

test("handleLeadDiscoverySignal still records the Lead when the explicit Entity reference can't be verified (e.g. Entity access unavailable)", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadCreated = false;
  globalThis.fetch = stockFetchHandlers({
    onEntityGet: () => new Response("Not found", { status: 404 }),
    onLeadsCreate: (_body) => {
      leadCreated = true;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(
    fakeEnv({ GROQ_API_KEY: "key" }),
    1,
    undefined,
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for consulting help\nEntity: https://notion.so/Some-Page-3cecb0001111222233334444555566667777",
  );

  assert.strictEqual(leadCreated, true, "Entity verification failing must not block Lead creation");
});
