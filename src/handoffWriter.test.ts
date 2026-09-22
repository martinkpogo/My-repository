/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoff, updateHandoff, validateHandoffProperties, HandoffWriteViolationError } from "./handoffWriter";
import { richText, select, title } from "./notion";
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

/** Mocks global fetch to capture the outgoing Notion request body and return a minimal successful page response. */
function mockNotionFetch(t: any) {
  const calls: { method: string; path: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? "GET", path: String(url), body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1", properties: {} }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

const baseIdentity = { entityToken: "E-20", matterToken: "MAT-20" };

function validProperties(overrides: Record<string, unknown> = {}) {
  return {
    Handoff: title("Value-based quote request — MAT-20"),
    "From Unit": select("Strategy"),
    "To Unit": select("Finance"),
    Status: select("Pending"),
    Reason: richText("Approved intervention ready for pricing."),
    Entity_Token: richText("E-20"),
    Matter_Token: richText("MAT-20"),
    "Verified Facts & Sources": richText("Sanitized business context only."),
    ...overrides,
  };
}

// --- Valid cases ---------------------------------------------------------

test("createHandoff: a token-only Handoff succeeds", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const page = await createHandoff(env, validProperties(), baseIdentity);
  assert.strictEqual(page.id, "page-1");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.properties.Matter_Token.rich_text[0].text.content, "MAT-20");
});

test("createHandoff: normal sanitized business context succeeds", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(() =>
    createHandoff(
      env,
      validProperties({
        "Verified Facts & Sources": richText(
          "Value at stake: GHS 420,000 over 12 months, evidence type: client_estimated, source: client-stated on call 2026-09-20.",
        ),
      }),
      baseIdentity,
    ),
  );
});

test("updateHandoff: an existing lifecycle update with safe Work Completed succeeds", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(() =>
    updateHandoff(env, "handoff-1", {
      Status: select("Closed"),
      "Work Completed": richText("Quoted price: GHS 420000. Rationale: value-based pricing applied to the approved intervention."),
    }),
  );
});

// --- Invalid cases ---------------------------------------------------------

test("createHandoff: real Entity/company name in Handoff title fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Handoff: title("Commercial diagnosis — Meridian Foods Ghana Ltd") }), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: real Matter name in Handoff title fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Handoff: title("Draft Proposal — Cold Chain Logistics Redesign") }), { ...baseIdentity, matterName: "Cold Chain Logistics Redesign" }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: Entity/company name in Reason fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Reason: richText("Commercial fit approved for Meridian Foods Ghana Ltd.") }), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: Matter name in Verified Facts & Sources fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      createHandoff(env, validProperties({ "Verified Facts & Sources": richText("Situation concerns the Cold Chain Logistics Redesign matter specifically.") }), {
        ...baseIdentity,
        matterName: "Cold Chain Logistics Redesign",
      }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: known contact name in a protected field fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      createHandoff(env, validProperties({ "Required Next Action": richText("Follow up with Comfort Agyare about the timeline.") }), {
        ...baseIdentity,
        contactName: "Comfort Agyare",
      }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: email address in a protected field fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ "Open Questions": richText("Confirm with comfort@meridianfoods.com before proceeding.") }), baseIdentity),
    HandoffWriteViolationError,
  );
});

test("createHandoff: phone number in a protected field fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Assumptions: richText("Contact reachable at +233 24 412 3456 if needed.") }), baseIdentity),
    HandoffWriteViolationError,
  );
});

test("createHandoff: missing Entity_Token fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties(), { entityToken: "", matterToken: "MAT-20" }), HandoffWriteViolationError);
});

test("createHandoff: missing Matter_Token fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties(), { entityToken: "E-20", matterToken: "" }), HandoffWriteViolationError);
});

test("createHandoff: empty (whitespace-only) token fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties(), { entityToken: "   ", matterToken: "MAT-20" }), HandoffWriteViolationError);
});

test("updateHandoff: prohibited identity in Work Completed fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      updateHandoff(
        env,
        "handoff-1",
        { Status: select("Closed"), "Work Completed": richText("Delivered to Meridian Foods Ghana Ltd as agreed.") },
        { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" },
      ),
    HandoffWriteViolationError,
  );
});

test("updateHandoff: prohibited identity in Assumptions fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      updateHandoff(env, "handoff-1", { Assumptions: richText("Assumes Meridian Foods Ghana Ltd confirms budget by month end.") }, { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }),
    HandoffWriteViolationError,
  );
});

test("updateHandoff: prohibited identity in Open Questions fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      updateHandoff(env, "handoff-1", { "Open Questions": richText("Does Meridian Foods Ghana Ltd want a phased rollout?") }, { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: does not call Notion at all when validation fails (validate before write, not create-then-repair)", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties({ Reason: richText("For Meridian Foods Ghana Ltd.") }), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }));
  assert.strictEqual(calls.length, 0, "no Notion API call may happen once validation has failed");
});

test("validateHandoffProperties: a short/generic needle (e.g. a 2-letter name) does not cause false-positive rejections", () => {
  assert.doesNotThrow(() =>
    validateHandoffProperties(validProperties(), { ...baseIdentity, entityName: "A1", matterName: "B2" }),
  );
});

test("updateHandoff: a plain Status-only lifecycle update with no identity supplied succeeds", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(() => updateHandoff(env, "handoff-1", { Status: select("Picked-up") }));
});
