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

test("parseLeadSignal requires Name, Source, and Evidence -- Contact is optional", () => {
  const full = parseLeadSignal("Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for help\nContact: jane@acme.com");
  assert.deepStrictEqual(full, {
    name: "Acme Corp",
    source: "https://example.com/post",
    evidence: "Posted looking for help",
    contact: "jane@acme.com",
  });

  const noContact = parseLeadSignal("Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for help");
  assert.strictEqual(noContact?.contact, "");
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

test("handleLeadDiscoverySignal sends usage instructions when the signal can't be parsed", async (t) => {
  const originalFetch = globalThis.fetch;
  let telegramCalled = false;
  let sentText = "";
  globalThis.fetch = (async (_url: string, init: any) => {
    telegramCalled = true;
    sentText = JSON.parse(init.body).text;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleLeadDiscoverySignal(fakeEnv(), 1, undefined, "not structured at all");

  assert.strictEqual(telegramCalled, true);
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

test("handleLeadDiscoverySignal still records the Lead when Entity access is disconnected -- a real Notion condition, not just a theoretical one", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadCreated = false;
  let sentText = "";
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (typeof url === "string" && url.includes("entity-ds")) {
      // This Worker's Notion integration has had Entity access revoked --
      // Notion's API returns a non-2xx here in production, which
      // notionFetch turns into a thrown Error. Reproduce that exactly.
      return new Response("Not found", { status: 404 });
    }
    if (typeof url === "string" && url.includes("leads-ds") && method !== "POST") {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("/pages") && method === "POST") {
      leadCreated = true;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"genuine": true, "category": "consulting", "reason": "clear need stated"}' } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({ GROQ_API_KEY: "key" });

  await handleLeadDiscoverySignal(
    env,
    1,
    undefined,
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for consulting help",
  );

  assert.strictEqual(leadCreated, true, "the Entity-side duplicate-check failing must not block Lead creation");
  assert.ok(sentText.includes("Lead recorded"));
});

test("handleLeadDiscoverySignal never writes to ENTITY_DATA_SOURCE_ID -- only reads it for duplicate-check", async (t) => {
  const originalFetch = globalThis.fetch;
  const writesToEntity: string[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (typeof url === "string" && url.includes("entity-ds") && method !== "POST") {
      // duplicate-check query against Entity -- read-only, allowed
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "entity-ds") writesToEntity.push("POST /pages");
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("leads-ds")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    // AI provider call (workers-ai binding isn't fetch-based; fallback providers are)
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"genuine": true, "category": "consulting", "reason": "clear need stated"}' } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({
    AI: { run: async () => ({ response: '{"genuine": true, "category": "consulting", "reason": "clear need stated"}' }) } as any,
    GROQ_API_KEY: "key",
  });

  await handleLeadDiscoverySignal(
    env,
    1,
    undefined,
    "Name: Acme Corp\nSource: https://example.com/post\nEvidence: Posted looking for consulting help",
  );

  assert.deepStrictEqual(writesToEntity, [], "Lead Discovery must never create/write an Entity record");
});
