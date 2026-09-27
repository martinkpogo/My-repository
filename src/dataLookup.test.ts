import test from "node:test";
import assert from "node:assert";
import { runDataLookup, classifyDataLookupRequest, runConversationalDataLookup } from "./dataLookup";
import type { Env } from "./types";

/**
 * Covers dataLookup.ts's three surfaces: the deterministic core
 * (runDataLookup -- no AI, built directly from live Notion fields), the
 * natural-language front end (classifyDataLookupRequest -- the classifier
 * AI call), and the conversational layer (runConversationalDataLookup --
 * the fetched rows grounding a second, separate AI chat turn so Martin can
 * actually discuss the data rather than receive a static dump).
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
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-ds",
    AI_MODEL_LIGHT: "test-light-model",
    AI_MODEL_PRIMARY: "test-primary-model",
    ...overrides,
  } as Env;
}

function mockNotionFetch(t: any, resultsByDataSource: Record<string, any[]>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const match = /\/data_sources\/([^/]+)\/query/.exec(String(url));
    if (match) {
      const dsId = match[1];
      const results = resultsByDataSource[dsId] ?? [];
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function matterPage(id: string, number: number, title: string, status: string) {
  return {
    id,
    archived: false,
    in_trash: false,
    properties: {
      Matter_ID: { unique_id: { number, prefix: "MAT" } },
      Matter: { title: [{ plain_text: title }] },
      Status: { select: { name: status } },
    },
  };
}

test("runDataLookup: matters -- returns formatted lines from live fields, most-recent order preserved", async (t) => {
  const env = fakeEnv();
  mockNotionFetch(t, {
    "matters-ds": [matterPage("p1", 20, "Recurring delivery complaints", "Qualified"), matterPage("p2", 19, "Positioning refresh", "Open")],
  });
  const reply = await runDataLookup(env, "matters");
  assert.match(reply, /matters\* \(2\)/);
  assert.match(reply, /MAT-20 — Recurring delivery complaints \[Qualified\]/);
  assert.match(reply, /MAT-19 — Positioning refresh \[Open\]/);
});

test("runDataLookup: filter is passed through as a Status equality filter and reflected in the reply header", async (t) => {
  const env = fakeEnv();
  let capturedBody: any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).includes("/data_sources/matters-ds/query")) {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [matterPage("p1", 20, "Recurring delivery complaints", "Qualified")] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const reply = await runDataLookup(env, "matters", "Qualified");
  assert.deepStrictEqual(capturedBody.filter, { property: "Status", select: { equals: "Qualified" } });
  assert.match(reply, /matters — Qualified\* \(1\)/);
});

test("runDataLookup: no records found returns a plain no-results message, not an error", async (t) => {
  const env = fakeEnv();
  mockNotionFetch(t, { "matters-ds": [] });
  const reply = await runDataLookup(env, "matters", "Converted");
  assert.strictEqual(reply, 'No matters records found matching "Converted".');
});

test("runDataLookup: archived/trashed pages are excluded (queryDataSource's own guarantee, exercised end to end)", async (t) => {
  const env = fakeEnv();
  const archived = matterPage("p1", 20, "Should be excluded", "Open");
  (archived as any).archived = true;
  mockNotionFetch(t, { "matters-ds": [archived] });
  const reply = await runDataLookup(env, "matters");
  assert.strictEqual(reply, "No matters records found.");
});

function mockAiResponse(jsonBody: unknown) {
  const env = fakeEnv({
    AI: {
      run: async () => ({ response: JSON.stringify(jsonBody) }),
    } as any,
  });
  return env;
}

test("classifyDataLookupRequest: a lookup question classifies to its source/filter", async () => {
  const env = mockAiResponse({ is_lookup: true, source: "matters", filter: "Qualified" });
  const result = await classifyDataLookupRequest(env, "Check the Matters database and tell me if anything is Qualified");
  assert.deepStrictEqual(result, { source: "matters", filter: "Qualified" });
});

test("classifyDataLookupRequest: ordinary conversation classifies as not a lookup and returns null", async () => {
  const env = mockAiResponse({ is_lookup: false });
  const result = await classifyDataLookupRequest(env, "How's the business doing this week?");
  assert.strictEqual(result, null);
});

test("classifyDataLookupRequest: a source outside the fixed six is rejected even if the model names one", async () => {
  const env = mockAiResponse({ is_lookup: true, source: "clients" });
  const result = await classifyDataLookupRequest(env, "Check the clients database");
  assert.strictEqual(result, null);
});

test("classifyDataLookupRequest: no filter named omits it entirely", async () => {
  const env = mockAiResponse({ is_lookup: true, source: "handoffs" });
  const result = await classifyDataLookupRequest(env, "What's in the Handoffs database?");
  assert.deepStrictEqual(result, { source: "handoffs", filter: undefined });
});

test("runConversationalDataLookup: grounds the AI reply in the actual live-fetched rows, not a canned string", async (t) => {
  let capturedSystem = "";
  const env = fakeEnv({
    STATE_KV: createMockKv() as any,
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "Yes, MAT-20 is Qualified." };
      },
    } as any,
  });
  mockNotionFetch(t, { "matters-ds": [matterPage("p1", 20, "Recurring delivery complaints", "Qualified")] });

  const reply = await runConversationalDataLookup(env, 1, 604, "matters", undefined, "Is anything in the Matters database?");

  assert.match(capturedSystem, /MAT-20/, "the system prompt must include the actual fetched row, not just the question");
  assert.match(capturedSystem, /never invent/i, "the grounding rule against inventing beyond the snapshot must be present");
  assert.strictEqual(reply, "Yes, MAT-20 is Qualified.");
});

test("runConversationalDataLookup: an empty result set still grounds the reply honestly (no records), never omitted", async (t) => {
  let capturedSystem = "";
  const env = fakeEnv({
    STATE_KV: createMockKv() as any,
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "There's nothing in the Matters database right now." };
      },
    } as any,
  });
  mockNotionFetch(t, { "matters-ds": [] });

  await runConversationalDataLookup(env, 1, 604, "matters", undefined, "Anything in Matters?");

  assert.match(capturedSystem, /No matters records found/i);
});

test("runConversationalDataLookup: a follow-up question carries the prior turn's history for the same source", async (t) => {
  const kv = createMockKv();
  const capturedHistories: any[][] = [];
  const env = fakeEnv({
    STATE_KV: kv as any,
    AI: {
      run: async (_model: any, opts: any) => {
        // messages[0] is system, last is the current user turn -- anything
        // in between is carried history. Content only, not role: the
        // mandatory identity-redaction gate can relabel history roles
        // during boundary transformation, which isn't this test's concern.
        capturedHistories.push(opts.messages.slice(1, -1).map((m: any) => m.content));
        return { response: "MAT-20 is about recurring delivery complaints." };
      },
    } as any,
  });
  mockNotionFetch(t, { "matters-ds": [matterPage("p1", 20, "Recurring delivery complaints", "Qualified")] });

  await runConversationalDataLookup(env, 1, 604, "matters", undefined, "Anything in Matters?");
  await runConversationalDataLookup(env, 1, 604, "matters", undefined, "Tell me more about MAT-20");

  assert.deepStrictEqual(capturedHistories[0], [], "the first turn has no prior history");
  assert.deepStrictEqual(capturedHistories[1], ["Anything in Matters?", "MAT-20 is about recurring delivery complaints."]);
});

test("runConversationalDataLookup: history is scoped per source -- a Leads follow-up never sees Matters history", async (t) => {
  const kv = createMockKv();
  const capturedHistories: any[][] = [];
  const env = fakeEnv({
    STATE_KV: kv as any,
    AI: {
      run: async (_model: any, opts: any) => {
        capturedHistories.push(opts.messages.slice(1, -1));
        return { response: "ok" };
      },
    } as any,
  });
  mockNotionFetch(t, {
    "matters-ds": [matterPage("p1", 20, "Recurring delivery complaints", "Qualified")],
    "leads-ds": [],
  });

  await runConversationalDataLookup(env, 1, 604, "matters", undefined, "Anything in Matters?");
  await runConversationalDataLookup(env, 1, 604, "leads", undefined, "Anything in Leads?");

  assert.deepStrictEqual(capturedHistories[1], [], "a different source must start with no history of its own");
});
