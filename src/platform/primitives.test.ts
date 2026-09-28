import test from "node:test";
import assert from "node:assert";
import { readRecord, fetchSkill, search, generate, requestApproval, writeRecord } from "./primitives";
import type { Env, WorkState } from "../types";

/**
 * Covers the Action Catalog's six primitive functions (ENIG Operating
 * Model design doc, "Platform layer"). Each primitive is tested for its
 * own fail-closed eligibility check plus its real underlying mechanism
 * (Notion query/write, live-fetched governance content, Tavily search,
 * an assembled AI prompt, and the send-and-pause half of an approval).
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
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    STATE_KV: createMockKv() as any,
    ...overrides,
  } as Env;
}

function mockFetch(t: any, handler: (url: string, init: any) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

// ---------------------------------------------------------------------------
// read_record
// ---------------------------------------------------------------------------

test("readRecord: fails closed when the calling Unit isn't declared readable for the source", async () => {
  const env = fakeEnv();
  await assert.rejects(() => readRecord(env, "Marketing", "matters"), /Marketing is not declared readable/);
});

test("readRecord: queries the configured data source and returns pages", async (t) => {
  const env = fakeEnv();
  mockFetch(t, (url) => {
    assert.match(url, /\/data_sources\/matters-ds\/query/);
    return new Response(JSON.stringify({ results: [{ id: "p1", url: "u1", properties: {}, archived: false, in_trash: false }] }), { status: 200 });
  });
  const pages = await readRecord(env, "Sales", "matters");
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].id, "p1");
});

// ---------------------------------------------------------------------------
// fetch_skill
// ---------------------------------------------------------------------------

test("fetchSkill: fetches and returns the skill's live governance content", async (t) => {
  const env = fakeEnv();
  mockFetch(t, (url) => {
    if (String(url).includes("/blocks/")) {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Universal Role Contract text." }] } }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  const content = await fetchSkill(env, "universal_role_contract");
  assert.match(content, /Universal Role Contract text\./);
});

test("fetchSkill: fails closed with a clear error when retrieval fails entirely", async (t) => {
  const env = fakeEnv();
  mockFetch(t, () => new Response("server error", { status: 500 }));
  await assert.rejects(() => fetchSkill(env, "universal_role_contract"), /could not be retrieved/);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test("search: throws when web search isn't configured", async () => {
  const env = fakeEnv({ TAVILY_API_KEY: undefined });
  await assert.rejects(() => search(env, "some query"), /web search isn't configured/);
});

test("search: calls Tavily when configured", async (t) => {
  const env = fakeEnv({ TAVILY_API_KEY: "test-key" });
  mockFetch(t, (url) => {
    assert.match(url, /tavily/);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
  const results = await search(env, "some query");
  assert.deepStrictEqual(results, []);
});

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

test("generate: json mode assembles persona+behavior+skillContent+context into the system prompt and returns parsed JSON", async () => {
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = opts.messages[0].content;
        return { response: JSON.stringify({ ok: true }) };
      },
    } as any,
  });
  const result = await generate<{ ok: boolean }>(env, {
    taskId: "chat.data_lookup",
    mode: "json",
    parts: {
      persona: "You are the Toy Hat.",
      behavior: "Never invent facts.",
      skillContent: "Format proposals as bullet points.",
      context: "Matter MAT-20 is Qualified.",
      situation: "Draft a proposal.",
    },
  });
  assert.deepStrictEqual(result, { ok: true });
  assert.match(capturedSystem, /You are the Toy Hat\./);
  assert.match(capturedSystem, /Never invent facts\./);
  assert.match(capturedSystem, /Format proposals as bullet points\./);
  assert.match(capturedSystem, /Matter MAT-20 is Qualified\./);
});

test("generate: text mode returns the raw model text, not parsed JSON", async () => {
  const env = fakeEnv({
    AI: { run: async () => ({ response: "Here is your draft proposal." }) } as any,
  });
  const result = await generate(env, {
    taskId: "chat.data_lookup",
    mode: "text",
    parts: { persona: "You are the Toy Hat.", situation: "Draft a proposal." },
  });
  assert.strictEqual(result, "Here is your draft proposal.");
});

test("generate: omitting optional prompt parts (no behavior/skillContent/context) still assembles a valid prompt", async () => {
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = opts.messages[0].content;
        return { response: "ok" };
      },
    } as any,
  });
  await generate(env, { taskId: "chat.data_lookup", mode: "text", parts: { persona: "You are the Toy Hat.", situation: "Hello" } });
  assert.strictEqual(capturedSystem.trim(), "You are the Toy Hat.");
});

// ---------------------------------------------------------------------------
// request_approval
// ---------------------------------------------------------------------------

test("requestApproval: sends to the WorkState's own chat/thread, not a forced Workspace stream, and persists pendingActionSummary + awaiting", async (t) => {
  const sent: { chatId: number; threadId?: number; text: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(init?.body ?? "{}");
      sent.push({ chatId: body.chat_id, threadId: body.message_thread_id, text: body.text ?? "" });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // A different chat/thread than any configured Workspace stream --
  // proves this never gets forced elsewhere the way sendWorkspaceHatMessage does.
  const env = fakeEnv({ TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_GROUP_CHAT_ID: "-999", WORKSPACE_TOPIC_ID: "604" });
  const state: WorkState = { workId: "work-1", chatId: 12345, threadId: 777, hat: "Toy Hat" } as WorkState;

  await requestApproval(env, {
    state,
    label: "Toy approval",
    message: "Approve this?",
    buttons: [[{ text: "Approve", callback_data: "toy:work-1:approve" }]],
    awaiting: "toy_approval" as any,
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].chatId, 12345);
  assert.strictEqual(sent[0].threadId, 777);
  assert.match(sent[0].text, /Approve this\?/);
  assert.strictEqual(state.pendingActionSummary?.label, "Toy approval");
  assert.strictEqual(state.awaiting, "toy_approval");
});

// ---------------------------------------------------------------------------
// write_record
// ---------------------------------------------------------------------------

test("writeRecord: fails closed when the calling Unit isn't declared writable for the source", async () => {
  const env = fakeEnv();
  await assert.rejects(() => writeRecord(env, "Marketing", "matters", { id: "p1", properties: {} }), /Marketing is not declared writable/);
});

test("writeRecord: an ordinary source (matters) updates the given id via a plain PATCH", async (t) => {
  const env = fakeEnv();
  const calls = mockFetch(t, (url) => {
    assert.match(url, /\/pages\/matter-1/);
    return new Response(JSON.stringify({ id: "matter-1", url: "u", properties: {} }), { status: 200 });
  });
  await writeRecord(env, "Sales", "matters", { id: "matter-1", properties: {} });
  assert.strictEqual(calls[0].init.method, "PATCH");
});

test("writeRecord: an ordinary source with no id throws -- only Handoffs may be created through this primitive", async () => {
  const env = fakeEnv();
  await assert.rejects(() => writeRecord(env, "Sales", "matters", { properties: {} }), /only Handoffs may be created/);
});

test("writeRecord: writing to handoffs without identity fails closed", async () => {
  const env = fakeEnv();
  await assert.rejects(() => writeRecord(env, "Sales", "handoffs", { properties: {} }), /requires identity/);
});

test("writeRecord: creating a handoff (no id) calls createHandoff via a POST to /pages", async (t) => {
  const env = fakeEnv();
  const calls = mockFetch(t, (url) => {
    assert.match(url, /\/pages$/);
    return new Response(JSON.stringify({ id: "handoff-1", url: "u", properties: {} }), { status: 200 });
  });
  const page = await writeRecord(env, "Sales", "handoffs", {
    properties: { "Handoff ID": {} as any },
    identity: { entityToken: "ENT-1", matterToken: "MAT-1" },
  });
  assert.strictEqual(calls[0].init.method, "POST");
  assert.strictEqual(page.id, "handoff-1");
});

test("writeRecord: updating an existing handoff (id given) calls updateHandoff via a PATCH", async (t) => {
  const env = fakeEnv();
  const calls = mockFetch(t, (url) => {
    assert.match(url, /\/pages\/handoff-1/);
    return new Response(JSON.stringify({ id: "handoff-1", url: "u", properties: {} }), { status: 200 });
  });
  await writeRecord(env, "Sales", "handoffs", {
    id: "handoff-1",
    properties: {},
    identity: { entityToken: "ENT-1", matterToken: "MAT-1" },
  });
  assert.strictEqual(calls[0].init.method, "PATCH");
});
