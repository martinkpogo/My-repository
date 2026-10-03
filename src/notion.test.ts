/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueId, queryDataSource } from "./notion";
import type { Env } from "./types";
import { systemContext } from "./access";

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
