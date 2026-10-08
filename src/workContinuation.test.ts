/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { continueExistingWork, resumeNotice } from "./workContinuation";
import type { Env, WorkState } from "./types";

/**
 * The shared Work resume path (src/workContinuation.ts) -- the function
 * every workId-discovering entry point funnels through: routeIncomingText's
 * explicit reply association, routeIncomingText's active:<chatId>:<threadId>
 * association, the /sessions switch button, and Matter Continue
 * (matter_current_work:<matterId>). What matters here is that ONE function
 * loads the WorkSession and routes its reply, so no caller re-implements
 * Unit/Hat/action resolution and the runtime cannot grow a second resume
 * engine.
 */

function world() {
  const kv = new Map<string, string>();
  const works = new Map<string, WorkState>();
  const textReplies: Array<{ workId: string; text: string }> = [];
  const env = {
    STATE_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, String(value));
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    },
    WORK_SESSION: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        getState: async () => works.get(id),
        handleTextReply: async (text: string) => {
          textReplies.push({ workId: id, text });
          const state = works.get(id);
          return state ? { ...state, awaiting: undefined, stage: "reply_consumed" } : state;
        },
      }),
    },
    TELEGRAM_BOT_TOKEN: "test-token",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    MARTIN_TELEGRAM_USER_ID: "9999",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
  } as unknown as Env;
  return { env, works, kv, textReplies };
}

function state(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-shared",
    chatId: 9999,
    threadId: 100,
    unit: "Finance",
    hat: "Value-Based Pricing Assessor",
    actionName: "quote",
    stage: "awaiting_quote_approval",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  } as WorkState;
}

function mockFetch(t: any) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

test("an awaiting Work consumes the reply through its own handler -- one implementation, whatever found the workId", async (t) => {
  const w = world();
  const s = state({ awaiting: "proposal_feedback" });
  w.works.set(s.workId, s);
  const calls = mockFetch(t);

  const continued = await continueExistingWork(w.env, 9999, 100, s.workId, "lower it by 10%");
  assert.strictEqual(continued.kind, "continued");
  assert.deepStrictEqual(w.textReplies, [{ workId: s.workId, text: "lower it by 10%" }], "the Work's own awaiting handler ran");
  assert.ok(continued.state.stage === "reply_consumed", "the caller gets the Work's post-reply state");
  assert.deepStrictEqual(calls, [], "no discovery is triggered unless the handler queued a Handoff");
});

test("a Work that is not awaiting a reply is loaded but its text is NOT consumed (routing falls through)", async (t) => {
  const w = world();
  const s = state({ awaiting: undefined, stage: "in_progress" });
  w.works.set(s.workId, s);
  mockFetch(t);

  const result = await continueExistingWork(w.env, 9999, 100, s.workId, "hello?");
  assert.strictEqual(result.kind, "resumed", "the caller may continue ordinary routing");
  assert.ok(result.state === s, "the existing WorkSession's own state");
  assert.deepStrictEqual(w.textReplies, [], "the Work's handler was not invoked");
});

test("with no text (Matter Continue, /sessions switch) the Work is loaded with no side effects", async (t) => {
  const w = world();
  const s = state();
  w.works.set(s.workId, s);
  mockFetch(t);

  const result = await continueExistingWork(w.env, 9999, 100, s.workId);
  assert.strictEqual(result.kind, "resumed");
  assert.ok(result.state === s);
  assert.deepStrictEqual(w.textReplies, []);
});

test("a stale workId reports missing instead of throwing or inventing a Work", async (t) => {
  const w = world();
  mockFetch(t);

  const result = await continueExistingWork(w.env, 9999, 100, "ghost-work");
  assert.strictEqual(result.kind, "missing");
  assert.strictEqual(result.workId, "ghost-work");
  assert.deepStrictEqual(w.textReplies, []);
  assert.strictEqual(w.works.size, 0);
});

test("resumeNotice: a pending approval is re-sent verbatim with its buttons; otherwise the caller's own line", () => {
  const pending = {
    label: "Opportunity: Acme Co",
    message: "Approve this quote?",
    createdAt: "2026-10-08T00:00:00.000Z",
    buttons: [[{ text: "Approve", callback_data: "quote:abc:approve" }]],
  } as WorkState["pendingActionSummary"];
  const notice = resumeNotice(state({ pendingActionSummary: pending }), "Switched active context to work item work-shared.");
  assert.strictEqual(notice.text, "Re-sending pending approval:\n\nApprove this quote?");
  assert.deepStrictEqual(notice.buttons, pending!.buttons, "the original buttons, so they still route through the same resolve handler");

  assert.strictEqual(resumeNotice(state(), "Continuing Matter MAT-26.").text, "Continuing Matter MAT-26.");
  assert.strictEqual(resumeNotice(undefined, "Switched active context to work item work-shared.").text, "Switched active context to work item work-shared.");
});
