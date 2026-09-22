/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueId, queryDataSource } from "./notion";
import type { Env } from "./types";

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

  const results = await queryDataSource(fakeEnv(), "handoffs-ds", { property: "Status", select: { equals: "Pending" } });

  assert.deepStrictEqual(results.map((r) => r.id), ["live-page"], "archived/trashed pages must never be returned as discoverable work");
});
