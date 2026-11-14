/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueId, queryDataSource, createPage, title } from "./notion";
import type { Env } from "./types";
import { AccessDeniedError, systemContext, workSessionReadContext } from "./access";
import { liveStatusSteps, withLiveStatus } from "./runtime/liveStatus";

function fakeEnv(): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
  };
}

test("uniqueId reads a bare auto_increment_id number", () => {
  assert.equal(uniqueId({ unique_id: { prefix: null, number: 47 } }), "47");
});

test("uniqueId prefixes the number when a prefix is configured", () => {
  assert.equal(uniqueId({ unique_id: { prefix: "E", number: 47 } }), "E-47");
});

test("uniqueId returns empty string for a missing property", () => {
  assert.equal(uniqueId(undefined), "");
  assert.equal(uniqueId(null), "");
  assert.equal(uniqueId({}), "");
});

test("uniqueId returns empty string when number is null or undefined", () => {
  assert.equal(uniqueId({ unique_id: { prefix: null, number: null } }), "");
  assert.equal(uniqueId({ unique_id: {} }), "");
});

test("uniqueId treats 0 as a valid number, not empty", () => {
  assert.equal(uniqueId({ unique_id: { prefix: null, number: 0 } }), "0");
});

test("Notion requests use the Worker runtime NOTION_TOKEN binding", async (t) => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await queryDataSource(fakeEnv(), "handoffs-ds", systemContext());
  assert.equal(authorization, "Bearer test-notion-token");
});

test("queryDataSource excludes archived/trashed pages from results", async (t) => {
  // Regression test for a live incident: an archived Handoff was still
  // returned by a Status=Pending discovery query, so a WorkSession
  // repeatedly tried (and failed) to edit it -- "Can't edit block that is
  // archived" -- on every scheduled discovery cycle, spamming an
  // operational failure alert. Discovery must never re-find work on a
  // page Notion itself reports as archived/trashed.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          { id: "live-page", url: "https://notion.so/live-page", properties: { Status: { select: { name: "Pending" } } }, archived: false },
          { id: "archived-page", url: "https://notion.so/archived-page", properties: { Status: { select: { name: "Pending" } } }, archived: true },
          { id: "trashed-page", url: "https://notion.so/trashed-page", properties: { Status: { select: { name: "Pending" } } }, in_trash: true },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const results = await queryDataSource(fakeEnv(), "handoffs-ds", systemContext(),  { property: "Status", select: { equals: "Pending" } });

  assert.deepStrictEqual(results.map((r) => r.id), ["live-page"], "archived/trashed pages must never be returned as discoverable work");
});

test("every Notion request is authorized with env.NOTION_TOKEN from the Worker binding, not a hardcoded or cached value", async (t) => {
  // Regression/verification test for the ENIG Notion secret blocker: the
  // only way a Notion request could ever carry the wrong credential (or
  // none) is if notionFetch read the token from somewhere other than the
  // env binding handed to it per-call. This asserts the literal
  // Authorization header Notion receives is derived from env.NOTION_TOKEN
  // on each call, by varying it across two otherwise-identical calls and
  // confirming the header varies with it -- never logging a real secret,
  // only these test-fixture placeholder strings.
  const seenAuthHeaders: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    seenAuthHeaders.push(headers.Authorization);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await queryDataSource(fakeEnv(), "handoffs-ds", systemContext(), { property: "Status", select: { equals: "Pending" } });
  await queryDataSource({ ...fakeEnv(), NOTION_TOKEN: "a-different-fixture-token" }, "handoffs-ds", systemContext(), {
    property: "Status",
    select: { equals: "Pending" },
  });

  assert.equal(seenAuthHeaders[0], "Bearer test-notion-token", "the Authorization header must be built from env.NOTION_TOKEN, not a hardcoded value");
  assert.equal(
    seenAuthHeaders[1],
    "Bearer a-different-fixture-token",
    "changing env.NOTION_TOKEN between calls must change the Authorization header sent -- proves the token is read fresh from the binding on every request, never cached",
  );
});

// ---------------------------------------------------------------------------
// Issue #369: Notion reports to the live status only through authorize()'s
// fixed source labels, and only AFTER Access has permitted the operation. A
// denial reports nothing -- the feed must never claim a write that Access
// refused -- and a permitted write carries only the source's fixed name,
// never a page title or property value.
// ---------------------------------------------------------------------------

test("a denied Notion write reports nothing to the live status feed -- Access decides before any claim", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  let steps: string[] | undefined;
  await assert.rejects(
    withLiveStatus(env, { chatId: -100, header: "Notion feed" }, async () => {
      try {
        // A work-session read context may write nothing: createPage must be
        // refused by authorize() before the network is touched.
        await createPage(env, env.ENTITY_DATA_SOURCE_ID, { Name: title("A page title that must never show") }, workSessionReadContext("work-1"));
      } finally {
        steps = liveStatusSteps();
      }
    }),
    AccessDeniedError,
  );
  assert.equal(fetchCalls, 0, "a denied operation reaches neither Notion nor Telegram");
  assert.deepEqual(steps, [], `a denial must report nothing to the feed: ${(steps ?? []).join(" | ")}`);
});

test("a permitted Notion write reports only the source's fixed name -- never a title or property value", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("api.notion.com")) {
      return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1", properties: {} }), { status: 200 });
    }
    // The run's Telegram send/edit/delete: a valid empty ack is enough.
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv();
  let steps: string[] = [];
  await withLiveStatus(env, { chatId: -100, header: "Notion feed" }, async () => {
    await createPage(env, env.ACTIVITY_LOG_DATA_SOURCE_ID, { Name: title("A page title that must never show") }, systemContext("kernel-1"));
    steps = liveStatusSteps() ?? [];
  });
  assert.deepEqual(steps, ["Writing to the Activity Log"], steps.join(" | "));
  assert.ok(!steps.join("\n").includes("A page title"), "no page title or property value may reach the feed");
});
