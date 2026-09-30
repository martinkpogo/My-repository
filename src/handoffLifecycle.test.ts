import test from "node:test";
import assert from "node:assert/strict";
import { claimPendingHandoff, closeHandoffIfOpen } from "./handoffLifecycle";
import { workSessionContext, type AccessContext } from "./access";
import type { Env, WorkState } from "./types";

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

/**
 * A Work that is advancing the very Handoff it was picked up from.
 *
 * `workSessionContext` is what these two functions are called with in
 * production: the Work item is claiming or closing its own inbound Handoff,
 * which is execution-state projection on a record the Work already owns. It
 * is NOT a governed business write and is NOT Martin's approval-gated effect,
 * so it needs no proof -- it needs an honest name for the Work doing it.
 */
function lifecycleAccess(handoffId: string): AccessContext {
  return workSessionContext({
    workId: "work-lifecycle",
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "new_enquiry",
    stage: "awaiting_pickup",
    handoffId,
  } as WorkState);
}

function mockFetch(t: any, initialStatus: string): { patchBodies: any[] } {
  const originalFetch = globalThis.fetch;
  const log = { patchBodies: [] as any[] };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    if (urlStr.endsWith("/pages/handoff-1") && method === "GET") {
      // `parent` is what src/notion.ts now reads to resolve the page's real
      // target, so the mock has to carry it: without it the target does not
      // resolve and every update is refused before it is ever attempted.
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          properties: { Status: { select: { name: initialStatus } } },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/pages/handoff-1") && method === "PATCH") {
      log.patchBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "handoff-1", url: "https://notion.so/handoff-1", properties: {} }), { status: 200 });
    }
    if (method === "GET" && urlStr.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(urlStr.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: urlStr.split("/v1/pages/").pop()!.split("?")[0],
          url: urlStr,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return log;
}

test("claimPendingHandoff: claims a genuinely Pending Handoff, setting Picked-up", async (t) => {
  const log = mockFetch(t, "Pending");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, true);
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Picked-up");
});

test("claimPendingHandoff: refuses an already Picked-up Handoff, no write", async (t) => {
  const log = mockFetch(t, "Picked-up");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, false);
  if (!result.claimed) assert.strictEqual(result.currentStatus, "Picked-up");
  assert.strictEqual(log.patchBodies.length, 0);
});

test("claimPendingHandoff: refuses a Held Handoff, no write", async (t) => {
  const log = mockFetch(t, "Held");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, false);
  assert.strictEqual(log.patchBodies.length, 0);
});

test("claimPendingHandoff: refuses a Closed Handoff, no write", async (t) => {
  const log = mockFetch(t, "Closed");
  const result = await claimPendingHandoff(fakeEnv(), "handoff-1", lifecycleAccess("handoff-1"));
  assert.strictEqual(result.claimed, false);
  assert.strictEqual(log.patchBodies.length, 0);
});

test("closeHandoffIfOpen: closes a Pending Handoff with the reason recorded", async (t) => {
  const log = mockFetch(t, "Pending");
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Rejected by Martin, no further direction.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
  assert.match(log.patchBodies[0].properties["Open Questions"].rich_text[0].text.content, /Rejected by Martin/);
});

test("closeHandoffIfOpen: closes a Picked-up Handoff", async (t) => {
  const log = mockFetch(t, "Picked-up");
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Cancelled.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies[0].properties.Status.select.name, "Closed");
});

test("closeHandoffIfOpen: does not reopen or rewrite an already-Closed Handoff", async (t) => {
  const log = mockFetch(t, "Closed");
  await closeHandoffIfOpen(fakeEnv(), "handoff-1", "Cancelled.", lifecycleAccess("handoff-1"));
  assert.strictEqual(log.patchBodies.length, 0, "a Closed Handoff must not be touched again");
});
