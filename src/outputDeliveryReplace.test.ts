import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { Env, ExternalToolOperationRecord, WorkState } from "./types";
import { confirmOutputDelivery, confirmOutputDeliveryReplace, handleOutputDeliveryCallback, readDeliveryConfirmation } from "./outputDelivery";
import {
  SHARED_OUTPUT_DELIVERY_OPERATION_ID,
  SHARED_OUTPUT_REPLACE_OPERATION_ID,
  mintExternalToolApprovalProof,
  workSessionContext,
} from "./access";
import { findUnitManifest } from "./units/registry";
import { installStatePersistence } from "./runtime/workPersistence";
import { invokeTool } from "./runtime/toolRegistry";
import { GOOGLE_DOCS_TOOL_ID } from "./runtime/tools/googleDocsTool";
import { GOOGLE_DOCS_UPDATE_OPERATION_ID } from "./runtime/tools/googleDocsUpdateTool";

/**
 * R2-2: the replace step -- overwrite an existing Doc with the approved
 * output. Every Google interaction here is a scripted fetch fake with call
 * counters -- no real Google document is ever created -- and every denial
 * path asserts ZERO Google requests.
 */

const DOCUMENT_ID = "doc-1";
const ACCOUNT = "martin@example.com";
const WORK_ID = "work-replace-1";
const FOLDER_NAME = "Reports Folder";
const DOCUMENT_NAME = "Q3 Plan";

function fakeEnv(overrides: Partial<Env> = {}, stateKv?: unknown): Env {
  return {
    TELEGRAM_BOT_TOKEN: "bot-test",
    TELEGRAM_GROUP_CHAT_ID: "111",
    WORKSPACE_TOPIC_ID: "222",
    NOTION_TOKEN: "n",
    NOTION_VERSION: "2025-09-03",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    STATE_KV: stateKv ?? { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) },
    ...overrides,
  } as unknown as Env;
}

/** STATE_KV holding the Worker's OWN authorized Google accounts (never caller-supplied). */
function kvWithGoogleAccounts(accounts: string[] = [ACCOUNT]): { store: Map<string, string>; kv: unknown } {
  const store = new Map<string, string>();
  for (const account of accounts) {
    store.set(
      `google_oauth_tokens:${account}`,
      JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000, updated_at: "now" }),
    );
  }
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
  return { store, kv: kv as unknown };
}

const REAL_FETCH = globalThis.fetch;
interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}
/**
 * Fetch fake: records every outbound call, scripts the Google Docs update
 * endpoints, and answers everything else (Telegram sends, the Activity Log
 * write) with 200 "{}".
 */
function installFake(t: any, handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((url: any, init?: any) => {
    const u = String(url);
    const initAny = init as { method?: string; body?: unknown; headers?: Record<string, string> } | undefined;
    const method = (initAny?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof initAny?.body === "string") {
      try {
        body = JSON.parse(initAny.body);
      } catch {
        body = initAny.body;
      }
    } else if (initAny?.body instanceof URLSearchParams) {
      body = Object.fromEntries(initAny.body);
    }
    const call: FetchCall = { url: u, method, body, headers: initAny?.headers };
    calls.push(call);
    if (!u.includes("googleapis.com")) return new Response("{}", { status: 200 });
    return handler(call);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return { calls };
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

/** The happy document server for an update: read-modify-write-read-back on doc-1. */
function updateDocServer() {
  let text = "";
  return (call: FetchCall): Response => {
    const { url, method, body } = call;
    if (url.endsWith("/oauth2/token")) return json({ access_token: "fresh", refresh_token: "r", expires_in: 3600 });
    if (url.endsWith(`/documents/${DOCUMENT_ID}`) && method === "GET") {
      return json({ title: DOCUMENT_NAME, body: { content: [{ startIndex: 1, paragraph: { elements: [{ textRun: { content: text } }], endIndex: Math.max(2, text.length + 2) } }] } });
    }
    if (url.includes(":batchUpdate") && method === "POST") {
      const request = (body as { requests?: unknown[] } | undefined)?.requests?.[0] as { insertText?: { text?: string } } | undefined;
      text = request?.insertText?.text ?? "";
      return json({});
    }
    throw new Error(`Unexpected Google call: ${method} ${url}`);
  };
}

/** The happy create server (unchanged create-step behaviour): create then insert then verify. */
function createDocServer() {
  return (call: FetchCall): Response => {
    const { url, method, body } = call;
    if (url.endsWith("/oauth2/token")) return json({ access_token: "fresh", refresh_token: "r", expires_in: 3600 });
    if (url.endsWith("/drive/v3/files") && method === "POST") return json({ id: DOCUMENT_ID });
    if (url.includes(":batchUpdate") && method === "POST") return json({});
    if (url.endsWith(`/documents/${DOCUMENT_ID}`) && method === "GET") {
      return json({ title: "PROP-7", body: { content: [{ startIndex: 1, paragraph: { elements: [{ textRun: { content: (body as { text?: string } | undefined)?.text ?? "Token-safe body for the create-step test." } }], endIndex: 2 } }] } });
    }
    throw new Error(`Unexpected Google call: ${method} ${url}`);
  };
}

function toolState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: WORK_ID,
    chatId: 12345,
    threadId: 67890,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "awaiting_intervention_approval",
    ...overrides,
  } as unknown as WorkState;
}

let workRecords: Record<string, ExternalToolOperationRecord> = {};
let releasePersistence: (() => void) | null = null;

beforeEach(() => {
  releasePersistence?.();
  releasePersistence = null;
  workRecords = {};
  const installed = installStatePersistence(WORK_ID, workRecords, async () => undefined);
  releasePersistence = installed.release;
});

afterEach(() => {
  releasePersistence?.();
  releasePersistence = null;
});

const googleCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("googleapis.com") && !c.url.includes("/oauth2/"));
const batchUpdates = (calls: FetchCall[]) => googleCalls(calls).filter((c) => c.url.includes(":batchUpdate"));
const driveCreates = (calls: FetchCall[]) => googleCalls(calls).filter((c) => c.url.endsWith("/drive/v3/files") && c.method === "POST");

function telegramTexts(calls: FetchCall[]): string[] {
  return calls
    .filter((c) => c.url.includes("api.telegram.org") && c.method === "POST")
    .map((c) => (typeof c.body === "object" && c.body !== null && typeof (c.body as { text?: string }).text === "string" ? (c.body as { text: string }).text : undefined))
    .filter((t): t is string => typeof t === "string");
}

function notionEntryTitles(calls: FetchCall[]): string[] {
  return calls
    .filter((c) => c.url.includes("api.notion.com"))
    .map((c) => {
      const body = c.body as { properties?: { Entry?: { title?: Array<{ text?: { content?: string } }> } } } | undefined;
      return body?.properties?.Entry?.title?.[0]?.text?.content;
    })
    .filter((t): t is string => typeof t === "string");
}

test("R2-2: success -- exactly one update request reaches Google for doc-1 (no Doc create), the message names the escaped file and folder, the captured output is cleared, and one Activity Log entry is written", async (t) => {
  // Strategy's diagnose does NOT declare google_docs.update_and_verify, so the
  // shared exemption is the only thing that can authorize this call.
  const manifest = findUnitManifest("Strategy");
  const hat = manifest?.hats["Strategy Analyst"];
  const diagnose = hat?.actions.find((a) => a.name === "diagnose");
  assert.ok(diagnose, "Strategy diagnose action exists");
  const declaresReplace = (diagnose!.tool_operations ?? []).some(
    (d) => d.tool_id === "google_docs" && d.operation_id === "google_docs.update_and_verify",
  );
  assert.equal(declaresReplace, false, "the test premise: diagnose does NOT declare the replace operation");

  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, updateDocServer());
  const state = toolState({
    outputDelivery: { title: "Q3 plan", text: "Approved token-only output body.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await confirmOutputDeliveryReplace(env, state, ACCOUNT, DOCUMENT_ID, DOCUMENT_NAME, FOLDER_NAME);

  assert.equal(next.outputDelivery, undefined, "the captured output is cleared either way");
  assert.equal(batchUpdates(calls).length, 1, "exactly one update request reaches Google");
  assert.equal(batchUpdates(calls)[0].url, `https://docs.googleapis.com/v1/documents/${DOCUMENT_ID}:batchUpdate`, "the update targets doc-1");
  const updateBody = batchUpdates(calls)[0].body as { requests?: unknown[] };
  const insertText = (updateBody.requests?.[0] as { insertText?: { text?: string } } | undefined)?.insertText?.text;
  assert.equal(insertText, "Approved token-only output body.", "the update carries the captured output text");
  assert.equal(driveCreates(calls).length, 0, "no Doc is created");
  const sent = telegramTexts(calls);
  assert.ok(
    sent.some((text) => text.includes(`✅ Replaced *${DOCUMENT_NAME}* in *${FOLDER_NAME}* with this output`)),
    `expected a replace success message, got ${JSON.stringify(sent)}`,
  );
  assert.ok(sent.some((text) => text.includes(`https://docs.google.com/document/d/${DOCUMENT_ID}/edit`)), "the message carries the document URL");
  const entries = notionEntryTitles(calls);
  assert.ok(entries.includes("Output delivery replace succeeded"), `expected Activity Log entry, got ${JSON.stringify(entries)}`);
});

test("R2-2: the proof is bound to gdrive:document:doc-1 -- bound to a folder instead, Access denies before any Google request", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, updateDocServer());
  const state = toolState({
    outputDelivery: { title: "Q3 plan", text: "Approved token-only output body.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await confirmOutputDeliveryReplace(env, state, ACCOUNT, DOCUMENT_ID, DOCUMENT_NAME, FOLDER_NAME);

  // The update tool resolves its target as gdrive:document:doc-1 and Access
  // binds Martin's proof to exactly that external target, so the call
  // proceeds. A proof bound to a folder would mismatch and be denied here,
  // before any request reaches Google.
  assert.equal(batchUpdates(calls).length, 1, "a document-bound proof authorizes exactly doc-1");
  assert.equal(batchUpdates(calls)[0].url, `https://docs.googleapis.com/v1/documents/${DOCUMENT_ID}:batchUpdate`);
  assert.equal(driveCreates(calls).length, 0, "no Doc is created");
  assert.equal(
    googleCalls(calls).filter((c) => c.url.includes("/documents/") && c.method === "GET").length,
    2,
    "pre-write read and read-back verification",
  );
  const sent = telegramTexts(calls);
  assert.ok(sent.some((text) => text.includes("✅ Replaced")), `expected success, got ${JSON.stringify(sent)}`);
  assert.equal(next.outputDelivery, undefined, "the captured output is cleared either way");
});

test("R2-2: no captured output -- 'There is no approved output waiting', zero Google requests", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, updateDocServer());
  const state = toolState({});
  const next = await confirmOutputDeliveryReplace(env, state, ACCOUNT, DOCUMENT_ID, DOCUMENT_NAME, FOLDER_NAME);

  assert.equal(next.outputDelivery, undefined);
  const sent = telegramTexts(calls);
  assert.ok(sent.some((text) => text.includes("There is no approved output waiting to be saved for this work item.")), `got ${JSON.stringify(sent)}`);
  assert.equal(googleCalls(calls).length, 0, "no Google request is made without captured output");
  assert.equal(notionEntryTitles(calls).length, 0, "nothing is logged");
});

test("R2-2: output fails the identity check -- the identity message, zero Google requests, output cleared", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, updateDocServer());
  const state = toolState({
    entityDraft: { email: "real@acme.example" } as any,
    outputDelivery: { title: "Leak", text: "Contact real@acme.example about the renewal.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await confirmOutputDeliveryReplace(env, state, ACCOUNT, DOCUMENT_ID, DOCUMENT_NAME, FOLDER_NAME);

  assert.equal(next.outputDelivery, undefined, "the captured output is cleared");
  const sent = telegramTexts(calls);
  assert.ok(
    sent.some((text) => text.includes("⚠️ This output no longer passes the identity check, so nothing was created in Google Drive.")),
    `got ${JSON.stringify(sent)}`,
  );
  assert.equal(googleCalls(calls).length, 0, "no Google request is made for identity-bearing output");
  assert.equal(notionEntryTitles(calls).length, 0, "nothing is logged");
});

test("R2-2: the provider fails (HTTP 500 on the update) -- never '✅', output cleared", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, (call) => (call.url.includes(":batchUpdate") ? json({}, 500) : updateDocServer()(call)));
  const state = toolState({
    outputDelivery: { title: "Q3 plan", text: "Approved token-only output body.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await confirmOutputDeliveryReplace(env, state, ACCOUNT, DOCUMENT_ID, DOCUMENT_NAME, FOLDER_NAME);

  assert.equal(next.outputDelivery, undefined, "the captured output is cleared either way");
  const sent = telegramTexts(calls);
  assert.ok(sent.some((text) => text.includes("⚠️ Not replaced")), `expected a failure message, got ${JSON.stringify(sent)}`);
  assert.ok(!sent.some((text) => text.includes("✅ Replaced")), "never reported as success");
  assert.equal(batchUpdates(calls).length, 1, "the update attempt was made exactly once");
});

test("R2-2: confirmOutputDelivery (the create step) is unchanged -- one existing-style call still creates, not updates", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, createDocServer());
  const state = toolState({
    outputDelivery: { title: "PROP-7", text: "Token-safe body for the create-step test.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await confirmOutputDelivery(env, state, ACCOUNT, "folder-1", "Folder");

  assert.equal(next.outputDelivery, undefined, "the captured output is cleared either way");
  assert.equal(driveCreates(calls).length, 1, "exactly one Doc create");
  const sent = telegramTexts(calls);
  assert.ok(sent.some((text) => text.includes("✅ Saved to Google Drive in *Folder*")), `got ${JSON.stringify(sent)}`);
});

// Sanity: the constants under test are the ones R2-1 registered (no change here).
test("R2-2 constants: the shared operation ids are unchanged", () => {
  assert.equal(SHARED_OUTPUT_REPLACE_OPERATION_ID, "google_docs.update_and_verify");
  assert.equal(SHARED_OUTPUT_DELIVERY_OPERATION_ID, "google_docs.create_and_verify");
});

// Sanity: invokeTool still accepts the update operation input contract directly (no change to the Tool or its contract).
test("invokeTool update contract: bound proof, no title or folder_id in the input", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, updateDocServer());
  const state = toolState({});
  const proof = mintExternalToolApprovalProof(state, {
    toolId: GOOGLE_DOCS_TOOL_ID,
    operationId: SHARED_OUTPUT_REPLACE_OPERATION_ID,
    targetResourceId: `gdrive:document:${DOCUMENT_ID}`,
  });
  const outcome = await invokeTool(
    env,
    {
      tool_id: GOOGLE_DOCS_TOOL_ID,
      operation_id: GOOGLE_DOCS_UPDATE_OPERATION_ID,
      input: {
        document_id: DOCUMENT_ID,
        account_identifier: ACCOUNT,
        document_specification: { text: "direct invoke input", presentation: { restore_identity_placeholders: true } },
      },
    },
    workSessionContext(state, proof),
  );
  assert.equal(outcome.state, "succeeded", `expected success, got ${outcome.state}: ${outcome.reason ?? ""}`);
  assert.equal(batchUpdates(calls).length, 1, "exactly one update request");
  assert.equal(driveCreates(calls).length, 0, "no Doc create");
  const directBody = batchUpdates(calls)[0].body as { requests?: unknown[] };
  const directText = (directBody.requests?.[0] as { insertText?: { text?: string } } | undefined)?.insertText?.text;
  assert.equal(directText, "direct invoke input");
});

// ---------------------------------------------------------------------------
// R2-4: confirmation handling for Replace (No keeps the output)
// ---------------------------------------------------------------------------

test("R2-4: readDeliveryConfirmation returns 'create' with the same fields for a valid delivery_confirm option, and falls back to folderId for a missing folderName", () => {
  const create = readDeliveryConfirmation({ kind: "delivery_confirm", delivery: true, accountIdentifier: ACCOUNT, folderId: "folder-1", folderName: "Reports Folder" });
  assert.equal(create?.action, "create");
  if (create?.action === "create") {
    assert.equal(create.accountIdentifier, ACCOUNT);
    assert.equal(create.folderId, "folder-1");
    assert.equal(create.folderName, "Reports Folder");
  }
  const fallback = readDeliveryConfirmation({ kind: "delivery_confirm", delivery: true, accountIdentifier: ACCOUNT, folderId: "folder-1" });
  assert.equal(fallback?.action, "create");
  if (fallback?.action === "create") assert.equal(fallback.folderName, "folder-1", "missing folderName falls back to folderId");
});

test("R2-4: readDeliveryConfirmation returns null for each create input session.ts rejects today: null, wrong kind, delivery not true, missing accountIdentifier, missing folderId", () => {
  const rejected = [
    null,
    { kind: "other", delivery: true, accountIdentifier: ACCOUNT, folderId: "folder-1" },
    { kind: "delivery_confirm", delivery: false, accountIdentifier: ACCOUNT, folderId: "folder-1" },
    { kind: "delivery_confirm", delivery: true, folderId: "folder-1" },
    { kind: "delivery_confirm", delivery: true, accountIdentifier: ACCOUNT },
  ];
  for (const option of rejected) assert.equal(readDeliveryConfirmation(option), null, `expected null for ${JSON.stringify(option)}`);
});

test("R2-4: readDeliveryConfirmation returns 'replace' for a valid replace_confirm option, with the 'My Drive' and documentId fallbacks when those names are missing", () => {
  const full = readDeliveryConfirmation({ kind: "replace_confirm", delivery: true, accountIdentifier: ACCOUNT, documentId: DOCUMENT_ID, documentName: DOCUMENT_NAME, folderName: FOLDER_NAME });
  assert.equal(full?.action, "replace");
  if (full?.action === "replace") {
    assert.equal(full.accountIdentifier, ACCOUNT);
    assert.equal(full.documentId, DOCUMENT_ID);
    assert.equal(full.documentName, DOCUMENT_NAME);
    assert.equal(full.folderName, FOLDER_NAME);
  }
  const fallback = readDeliveryConfirmation({ kind: "replace_confirm", delivery: true, accountIdentifier: ACCOUNT, documentId: DOCUMENT_ID });
  assert.equal(fallback?.action, "replace");
  if (fallback?.action === "replace") {
    assert.equal(fallback.documentName, DOCUMENT_ID, "missing documentName falls back to documentId");
    assert.equal(fallback.folderName, "My Drive", "missing folderName falls back to 'My Drive'");
  }
});

test("R2-4: readDeliveryConfirmation returns null for replace_confirm without delivery === true, with an empty documentId, or with a missing accountIdentifier", () => {
  const rejected = [
    { kind: "replace_confirm", accountIdentifier: ACCOUNT, documentId: DOCUMENT_ID },
    { kind: "replace_confirm", delivery: true, accountIdentifier: ACCOUNT, documentId: "" },
    { kind: "replace_confirm", delivery: true, documentId: DOCUMENT_ID },
  ];
  for (const option of rejected) assert.equal(readDeliveryConfirmation(option), null, `expected null for ${JSON.stringify(option)}`);
});

test("R2-4: handleOutputDeliveryCallback 'keep' sends the 'Not replaced' message, leaves state.outputDelivery set, and makes ZERO Google requests", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, (call) => {
    if (call.url.includes("googleapis.com")) throw new Error(`no Google request may be made: ${call.url}`);
    return new Response("{}", { status: 200 });
  });
  const state = toolState({
    outputDelivery: { title: "Q3 plan", text: "Approved token-only output body.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await handleOutputDeliveryCallback(env, state, "keep");
  const sent = telegramTexts(calls);
  assert.ok(
    sent.some((text) => text.includes("Not replaced -- your approved output is still waiting. Scroll up to choose another file or folder.")),
    `expected the 'Not replaced' message, got ${JSON.stringify(sent)}`,
  );
  assert.equal(next.outputDelivery?.title, "Q3 plan", "state.outputDelivery is still set after 'keep'");
  assert.equal(next.outputDelivery?.text, "Approved token-only output body.", "the captured output text is untouched");
  assert.equal(googleCalls(calls).length, 0, "ZERO Google requests for 'keep'");
});

test("R2-4: 'dismiss' still clears state.outputDelivery (unchanged)", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installFake(t, () => new Response("{}", { status: 200 }));
  const state = toolState({
    outputDelivery: { title: "Q3 plan", text: "Approved token-only output body.", capturedAt: "2026-11-23T10:00:00Z" },
  });
  const next = await handleOutputDeliveryCallback(env, state, "dismiss");
  assert.equal(next.outputDelivery, undefined, "'dismiss' clears the captured output");
  assert.equal(googleCalls(calls).length, 0, "no Google request for 'dismiss'");
});

// ---------------------------------------------------------------------------
// R2-5: a delivery_confirm option naming a Doc is never read as a replace
// ---------------------------------------------------------------------------

test("R2-5: readDeliveryConfirmation({ kind: 'delivery_confirm', delivery: true, accountIdentifier: 'a', documentId: 'd' }) returns null", () => {
  const neither = readDeliveryConfirmation({ kind: "delivery_confirm", delivery: true, accountIdentifier: "a", documentId: "d" });
  assert.equal(neither, null, "a save-as-new confirmation with a Doc id but no folder is never read as a replace");
});
