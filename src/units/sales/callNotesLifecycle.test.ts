import test from "node:test";
import assert from "node:assert/strict";
import { consumeReadyCallNotes } from "./callNotesLifecycle";
import { workSessionContext } from "../../access";
import type { Env, WorkState } from "../../types";

/**
 * Runtime's ONLY write to a Call Notes record, tested against the same
 * compare-current-status -> write-or-refuse shape `claimPendingHandoff` uses.
 *
 * What matters here is not the happy path but the refusals: a record that is
 * already `Consumed`, is `Superseded`, or carries any other Status must produce
 * NO write at all. "Refused" that still PATCHed would be indistinguishable in
 * production from a transition that happened, so every negative case asserts
 * the write count rather than only the returned reason.
 */

function fakeEnv(): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
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
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
  };
}

/** The pickup Work's own context -- consumption reuses it, adding no new Action. */
function pickupContext() {
  const state: WorkState = {
    workId: "work_lifecycle_1",
    chatId: 1,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "proposal_draft",
    handoffId: "handoff-1",
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as WorkState;
  return workSessionContext(state);
}

interface LifecycleMock {
  status: string;
  writes: any[];
  reads: number;
}

function mockLifecycleFetch(t: any, initialStatus: string): LifecycleMock {
  const originalFetch = globalThis.fetch;
  const log: LifecycleMock = { status: initialStatus, writes: [], reads: 0 };

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.endsWith("/pages/call-notes-1") && method === "GET") {
      log.reads += 1;
      return new Response(
        JSON.stringify({
          id: "call-notes-1",
          url: "https://notion.so/call-notes-1",
          parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
          properties: {
            "Call Notes ID": { title: [{ plain_text: "CN-007", text: { content: "CN-007" } }] },
            Status: { select: { name: log.status } },
            Entity: { relation: [{ id: "entity-page-1" }] },
            Matter: { relation: [{ id: "matter-page-1" }] },
            Version: { number: 1 },
          },
        }),
        { status: 200 },
      );
    }

    if (urlStr.endsWith("/pages/call-notes-1") && method === "PATCH") {
      const body = JSON.parse(String(init.body));
      log.writes.push(body);
      if (body.properties?.Status?.select?.name) log.status = body.properties.Status.select.name;
      return new Response(
        JSON.stringify({ id: "call-notes-1", url: "https://notion.so/call-notes-1", parent: { type: "data_source_id", data_source_id: "call-notes-ds" }, properties: {} }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch in call-notes lifecycle test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return log;
}

test("lifecycle: a Ready record is transitioned to Consumed, and the write touches Status and nothing else", async (t) => {
  const log = mockLifecycleFetch(t, "Ready");

  const result = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());

  assert.deepEqual(result, { consumed: true, pageId: "call-notes-1" });
  assert.equal(log.status, "Consumed");
  assert.equal(log.writes.length, 1, "exactly one write");
  assert.deepEqual(
    log.writes[0],
    { properties: { Status: { select: { name: "Consumed" } } } },
    "the lifecycle step may advance Status -- it may never become a second writer of the record's substance (its Entity/Matter relations, Version, or registry fields)",
  );
});

test("lifecycle: a record already Consumed is refused with no write -- this is what makes replay safe", async (t) => {
  const log = mockLifecycleFetch(t, "Consumed");

  const result = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());

  assert.equal(result.consumed, false);
  if (result.consumed) return;
  assert.match(result.reason, /Status "Consumed", not "Ready"/);
  assert.match(result.reason, /consumes a record exactly once/);
  assert.equal(log.writes.length, 0, "a refusal must issue no write");
  assert.equal(log.status, "Consumed", "the record is left exactly as found");
});

test("lifecycle: a Superseded record is refused with no write", async (t) => {
  const log = mockLifecycleFetch(t, "Superseded");

  const result = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());

  assert.equal(result.consumed, false);
  if (result.consumed) return;
  assert.match(result.reason, /Status "Superseded", not "Ready"/);
  assert.equal(log.writes.length, 0, "a refusal must issue no write");
  assert.equal(log.status, "Superseded");
});

test("lifecycle: an unexpected Status is refused with no write rather than being overwritten", async (t) => {
  const log = mockLifecycleFetch(t, "Draft");

  const result = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());

  assert.equal(result.consumed, false);
  if (result.consumed) return;
  assert.match(result.reason, /Status "Draft", not "Ready"/);
  assert.equal(log.writes.length, 0);
});

test("lifecycle: a record with no Status at all is refused with no write", async (t) => {
  const log = mockLifecycleFetch(t, "");

  const result = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());

  assert.equal(result.consumed, false);
  if (result.consumed) return;
  assert.match(result.reason, /Status "\(empty\)", not "Ready"/);
  assert.equal(log.writes.length, 0);
});

test("lifecycle: consuming twice performs one write and refuses the second -- the Status is re-read, never trusted from an earlier read", async (t) => {
  const log = mockLifecycleFetch(t, "Ready");

  const first = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());
  assert.equal(first.consumed, true);

  const second = await consumeReadyCallNotes(fakeEnv(), "call-notes-1", pickupContext());

  assert.equal(second.consumed, false, "the second attempt must observe Consumed");
  if (second.consumed) return;
  assert.match(second.reason, /Status "Consumed", not "Ready"/);
  assert.equal(log.writes.length, 1, "the record is transitioned exactly once across both attempts");
  assert.ok(log.reads >= 2, "each attempt re-reads the live Status at the write boundary rather than reusing an earlier result");
});
