import test from "node:test";
import assert from "node:assert";
import { DISCOVERY_QUERIES, notifyDiscoveryRunSummary, runAutonomousLeadDiscovery } from "./leadGenerationDiscovery";
import type { Env } from "../../../types";

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

const PASS_EVALUATION = JSON.stringify({
  candidates: [
    {
      pass: true,
      organisation: "Acme Corp",
      evidence: "Expanded into a new market but public positioning still emphasises its original offering.",
      decisionMakerOrRole: "",
      category: "positioning",
      reason: "Recent expansion without corresponding positioning update.",
    },
  ],
});
const FAIL_EVALUATION = JSON.stringify({
  candidates: [{ pass: false, organisation: "", evidence: "", decisionMakerOrRole: "", category: "", reason: "No commercial problem signal present." }],
});

test("runAutonomousLeadDiscovery does nothing when web search isn't configured -- never fabricates a run", async () => {
  const summary = await runAutonomousLeadDiscovery(fakeEnv());
  assert.deepStrictEqual(summary, { evaluated: 0, recorded: [], screenedOut: 0, skippedAsDuplicate: 0, skippedAsInsufficient: 0 });
});

test("runAutonomousLeadDiscovery records exactly one Lead across all queries and skips the rest as duplicates -- never touches Entity, never writes anything but Status: New", async (t) => {
  const originalFetch = globalThis.fetch;
  let aiCallCount = 0;
  let leadsCreatedCount = 0;
  let leadExists = false;
  const entityCalls: string[] = [];
  let createdProperties: any;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Acme Corp expands into new market", url: "https://example.com/acme-news", content: "Acme Corp announced expansion." }] }), {
        status: 200,
      });
    }
    if (url.includes("entity-ds")) {
      entityCalls.push(method + " " + url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: leadExists ? [{ id: "existing", url: "https://notion.so/existing", properties: { Lead: { title: [{ plain_text: "Acme Corp" }] } } }] : [] }), {
        status: 200,
      });
    }
    if (url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "leads-ds") {
        leadsCreatedCount++;
        createdProperties = body.properties;
        leadExists = true;
      }
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/lead-page-1", properties: {} }), { status: 200 });
    }
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    // AI provider (evaluation call) -- pass on the first two queries (so the
    // second pass exercises the duplicate-skip path against the Lead the
    // first one created), fail every time after.
    aiCallCount++;
    return new Response(JSON.stringify({ choices: [{ message: { content: aiCallCount <= 2 ? PASS_EVALUATION : FAIL_EVALUATION } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.strictEqual(leadsCreatedCount, 1, "exactly one Lead should be created; every later duplicate must be skipped");
  assert.strictEqual(summary.evaluated, DISCOVERY_QUERIES.length, "one result per query means one evaluation per query");
  assert.strictEqual(summary.recorded.length, 1);
  assert.strictEqual(summary.recorded[0].organisation, "Acme Corp");
  assert.ok(summary.skippedAsDuplicate >= 1, "later queries finding the same organisation must be skipped as duplicates, not re-created");
  assert.deepStrictEqual(createdProperties.Status, { select: { name: "New" } });
  assert.strictEqual(createdProperties.Entity, undefined, "autonomous discovery must never set an Entity relation");
  assert.deepStrictEqual(entityCalls.filter((c) => c.startsWith("POST")), [], "autonomous discovery must never write to Entity");
});

test("runAutonomousLeadDiscovery never creates a Lead from an inconsistent AI 'pass' with no organisation/evidence -- fails closed on the evidence-threshold gate itself", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Some Company", url: "https://example.com/post", content: "Vague content." }] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      leadsCreatedCount++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    // AI claims pass:true but supplies no organisation/evidence -- inconsistent output.
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{ pass: true, organisation: "", evidence: "", decisionMakerOrRole: "", category: "", reason: "" }] }) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.strictEqual(leadsCreatedCount, 0);
  assert.strictEqual(summary.skippedAsInsufficient, DISCOVERY_QUERIES.length);
});

test("runAutonomousLeadDiscovery records nothing when governance retrieval fails -- fails closed, not open", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Some Company", url: "https://example.com/post", content: "Some content." }] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response("server error", { status: 500 });
    }
    if (url.includes("/pages") && method === "POST") {
      leadsCreatedCount++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.strictEqual(leadsCreatedCount, 0);
  assert.strictEqual(summary.recorded.length, 0);
});

test("notifyDiscoveryRunSummary sends a single Hat-labeled digest, never one message per Lead", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    sentTexts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await notifyDiscoveryRunSummary(fakeEnv(), 1, undefined, {
    evaluated: 12,
    recorded: [{ organisation: "Acme Corp", url: "https://notion.so/lead-page-1" }],
    screenedOut: 9,
    skippedAsDuplicate: 1,
    skippedAsInsufficient: 1,
  });

  assert.strictEqual(sentTexts.length, 1, "exactly one digest message per run, never one per Lead");
  assert.ok(sentTexts[0].startsWith("Hat: Lead Generation Specialist."));
  assert.ok(sentTexts[0].includes("12 candidate(s) evaluated"));
  assert.ok(sentTexts[0].includes("Acme Corp"));
  assert.ok(sentTexts[0].includes("no Entity created, no qualification performed"));
});
