import assert from "node:assert/strict";
import { test } from "node:test";

import type { Env, WorkState } from "../types";
import {
  AccessDeniedError,
  EXTERNAL_TOOL_TARGET,
  evaluateExternalMutationAccess,
  mintApprovalProofForWork,
  mintExternalToolApprovalProof,
  workSessionContext,
  workSessionReadContext,
} from "../access";
import {
  invokeTool,
  resolveToolOperation,
  validateActionToolDeclarations,
  validateOutcomeShape,
  validateToolOperations,
  type ToolInvocationOutcome,
  type ToolOperationDefinition,
} from "./toolRegistry";
import { GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, GOOGLE_DOCS_TOOL_ID } from "./tools/googleDocsTool";

/**
 * The Tool Registry contract, proven at the invocation boundary:
 * registration and declarations, the external-mutation authorization model,
 * the five canonical Google Docs outcomes, and mandatory retry safety.
 *
 * Every Google interaction here is a scripted fetch fake with call counters
 * -- no real Google document is ever created -- and every denial asserts
 * ZERO Google calls, which is the observable form of "authorization and
 * validation happen before any externally mutating request".
 */

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function fakeEnv(overrides: Partial<Env> = {}, stateKv?: unknown): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: stateKv ?? { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) },
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "m",
    AI_MODEL_LIGHT: "m",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    TELEGRAM_BOT_TOKEN: "t",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "n",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "604",
    OPERATIONS_TOPIC_ID: "588",
    ...overrides,
  } as unknown as Env;
}

/** STATE_KV holding the Worker's OWN authorized Google accounts (never caller-supplied). */
function kvWithGoogleAccounts(accounts: string[] = ["martin@example.com"], opts: { expired?: boolean } = {}) {
  const store = new Map<string, string>();
  for (const account of accounts) {
    store.set(
      `google_oauth_tokens:${account}`,
      JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + (opts.expired ? -3_600_000 : 3_600_000), updated_at: "now" }),
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
  return { store, kv: kv as any };
}

interface GoogleCall {
  method: string;
  url: string;
  body?: any;
}

/**
 * Fetch fake: scripts googleapis.com endpoints, counts every Google call,
 * and swallows everything else (logActivity's Activity-Log write is best
 * effort by design).
 */
const REAL_FETCH = globalThis.fetch;
function installGoogleFake(t: any, handler: (call: { url: string; method: string; body?: any }) => Response | Promise<Response>) {
  const calls: GoogleCall[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (!u.includes("googleapis.com")) {
      return new Response("{}", { status: 200 });
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url: u, method, body };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  // Always restore the REAL fetch: several denials may install fakes within
  // one test, and restoring to a previous fake would leak it.
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return { calls };
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

/** The happy document server: remembers what was created so read-backs verify. */
function docServer() {
  let title = "";
  let text = "";
  return (call: { url: string; method: string; body?: any }): Response => {
    const { url, method, body } = call;
    if (url.endsWith("/oauth2/token")) return json({ access_token: "fresh", refresh_token: "r", expires_in: 3600 });
    if (url.endsWith("/drive/v3/files") && method === "POST") {
      title = body.name;
      return json({ id: "doc-1" });
    }
    if (url.includes(":batchUpdate")) {
      text = body.requests?.[0]?.insertText?.text ?? "";
      return json({});
    }
    if (url.endsWith("/documents/doc-1") && method === "GET") {
      return json({ title, body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } });
    }
    throw new Error(`Unexpected Google call: ${method} ${url}`);
  };
}

const VALID_INPUT = {
  title: "PROP-7",
  content: "Token-safe Proposal body for the Tool Registry tests.",
  folder_id: "folder-1",
  account_identifier: "martin@example.com",
};

function toolState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-tool-1",
    chatId: 12345,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "proposal_submit",
    ...overrides,
  } as unknown as WorkState;
}

/** A Work whose resolved Action declares google_docs.create_and_verify and is not approval-gated. */
const submitContext = () => workSessionContext(toolState());

const googleCalls = (calls: GoogleCall[]) => calls.filter((c) => c.url.includes("googleapis.com") && !c.url.includes("/oauth2/"));
const driveCreates = (calls: GoogleCall[]) => googleCalls(calls).filter((c) => c.url.endsWith("/drive/v3/files") && c.method === "POST");

// ---------------------------------------------------------------------------
// Registry and declarations.
// ---------------------------------------------------------------------------

test("A. the registered Google Docs Tool and exact operation resolve -- id, operation id, version 1.0, effect external_mutation, handlers present", () => {
  const operation = resolveToolOperation(GOOGLE_DOCS_TOOL_ID, GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID);
  assert.ok(operation, "the canonical operation must be registered");
  assert.equal(operation.toolId, "google_docs");
  assert.equal(operation.operationId, "google_docs.create_and_verify");
  assert.equal(operation.version, "1.0");
  assert.equal(operation.effect, "external_mutation");
  assert.equal(typeof operation.validateInput, "function");
  assert.equal(typeof operation.resolveTarget, "function");
  assert.equal(typeof operation.run, "function");
  assert.equal(typeof operation.reconcile, "function");
});

test("B. an unknown Tool id is denied and makes zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const outcome = await invokeTool(env, { tool_id: "google_sheets", operation_id: "google_docs.create_and_verify", input: VALID_INPUT }, submitContext());
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", /not registered in the Tool Registry/);
  assert.equal(googleCalls(calls).length, 0, "an unknown Tool must never reach Google");
});

test("C. an unknown operation id is denied and makes zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const outcome = await invokeTool(env, { tool_id: "google_docs", operation_id: "google_docs.delete", input: VALID_INPUT }, submitContext());
  assert.equal(outcome.state, "denied");
  assert.equal(googleCalls(calls).length, 0);
});

test("D. the invocation boundary accepts no handler selection -- a caller-supplied handler field is ignored and the registered operation is the only one that can run", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  let rogueRan = false;
  const request = {
    tool_id: "google_docs",
    operation_id: "google_docs.create_and_verify",
    input: VALID_INPUT,
    handler: () => {
      rogueRan = true;
      return "unauthorized";
    },
  } as any;
  const outcome = await invokeTool(env, request, submitContext());
  assert.equal(outcome.state, "succeeded", "the registered handler runs; the injected field selects nothing");
  assert.equal(rogueRan, false, "the injected handler must never execute");
  assert.ok(driveCreates(calls).length === 1);
});

test("E. invalid inputs are denied before any Google call (non-object, missing fields, blank content, unknown field)", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const cases: unknown[] = [
    "just a string",
    { title: "PROP-7", content: "body", folder_id: "folder-1" },
    { title: "PROP-7", content: "   ", folder_id: "folder-1", account_identifier: "martin@example.com" },
    { ...VALID_INPUT, account_identifier: "someone-else@example.com", extra: "field" },
    { ...VALID_INPUT, folder_id: 123 },
  ];
  for (const input of cases) {
    const outcome = await invokeTool(env, { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input }, submitContext());
    assert.equal(outcome.state, "denied", `input ${JSON.stringify(input)} must be denied`);
    assert.match(outcome.reason ?? "", /invalid input|target input is invalid/);
  }
  assert.equal(googleCalls(calls).length, 0, "invalid input must never reach Google");
});

test("F. malformed Tool definitions fail closed (validateToolOperations)", () => {
  const base: ToolOperationDefinition = {
    toolId: "demo",
    operationId: "demo.act",
    version: "1.0",
    effect: "external_mutation",
    validateInput: () => null,
    resolveTarget: async () => ({ ok: true, target: { resourceId: "demo:1" } }),
    run: async () => ({ state: "succeeded", tool_id: "demo", operation_id: "demo.act", verified: true, remote_resource: { document_id: "1" } }),
  };
  assert.equal(validateToolOperations([base]), null, "a complete definition validates");
  assert.match(validateToolOperations([{ ...base, toolId: "" }]) ?? "", /non-empty toolId/);
  assert.match(validateToolOperations([{ ...base, operationId: "act" }]) ?? "", /not namespaced/);
  assert.match(validateToolOperations([{ ...base, version: "" }]) ?? "", /must declare a version/);
  assert.match(validateToolOperations([{ ...base, effect: "external_read" as any }]) ?? "", /unknown effect/);
  assert.match(validateToolOperations([{ ...base, run: undefined as any }]) ?? "", /missing its run/);
  assert.match(validateToolOperations([base, { ...base }]) ?? "", /registered more than once/);
});

test("G. Action declarations validate against the registry: unregistered operations are defects, exact ones pass", () => {
  const declaring = [{ name: "proposal_submit", tool_operations: [{ tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false }] }];
  assert.equal(validateActionToolDeclarations(declaring), null);
  const unregistered = [{ name: "proposal_submit", tool_operations: [{ tool_id: "google_docs", operation_id: "google_docs.frobnicate", required: false }] }];
  assert.match(validateActionToolDeclarations(unregistered) ?? "", /not registered in the Tool Registry/);
  const noDeclaration = [{ name: "new_enquiry" }];
  assert.equal(validateActionToolDeclarations(noDeclaration), null, "an Action with no declaration has nothing to cross-check");
});

// ---------------------------------------------------------------------------
// Authorization -- an external mutation is judged only from trusted state.
// ---------------------------------------------------------------------------

async function expectDenied(
  env: Env,
  context: Parameters<typeof invokeTool>[2],
  reasonPattern: RegExp,
  t: any,
): Promise<void> {
  const { calls } = installGoogleFake(t, docServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    context,
  );
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", reasonPattern);
  assert.equal(googleCalls(calls).length, 0, "authorization denial must happen before any external request");
}

test("H. a Work with no recorded Action is denied even though valid Google OAuth credentials exist -- authentication is not authorization", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await expectDenied(env, workSessionReadContext("work-tool-1"), /no resolved Unit Action/, t);
});

test("I. non-work_session contexts (system, discovery_cron, user_lookup) are denied outright", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  for (const kind of ["system", "discovery_cron", "user_lookup"] as const) {
    await expectDenied(env, { kind }, /requires a "work_session" context/, t);
  }
});

test("J. an incompatible effect classification is denied: a read Action cannot carry an external mutation", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const readContext = workSessionContext(toolState({ hat: "Lead Generation Specialist", actionName: "discover_leads" }));
  await expectDenied(env, readContext, /declared "read" and cannot carry effect "external_mutation"/, t);
});

test("K. an Action that does not declare the operation is denied (undeclared Action-to-Tool combination)", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const undeclaredContext = workSessionContext(toolState({ actionName: "new_enquiry" }));
  await expectDenied(env, undeclaredContext, /does not declare Tool operation google_docs\.google_docs\.create_and_verify|does not declare Tool operation/, t);
});

test("L. a caller cannot substitute a different Action: an asserted-Action mismatch fails closed", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const substituted = workSessionContext(toolState({ actionName: "proposal_submit" }), undefined, "proposal_draft");
  await expectDenied(env, substituted, /can never substitute the Action/, t);
});

test("M. approval evidence is required under an approval-gated Action and its absence is denied before Google", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const approveContext = workSessionContext(toolState({ actionName: "proposal_approve" }));
  await expectDenied(env, approveContext, /requires Martin's explicit approval.*no ApprovalProof was supplied/, t);
});

test("N. an approval bound to one Work/Action/operation/target never authorizes another", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const approveState = toolState({ actionName: "proposal_approve" });
  const binding = { toolId: "google_docs", operationId: "google_docs.create_and_verify", targetResourceId: "gdrive:folder:folder-1" };

  const wrongWork = mintExternalToolApprovalProof(toolState({ workId: "work-other" }), binding);
  await expectDenied(env, workSessionContext(toolState({ actionName: "proposal_approve" }), wrongWork), /never carries across work items/, t);

  const wrongAction = mintApprovalProofForWork(toolState({ actionName: "proposal_draft" }), EXTERNAL_TOOL_TARGET);
  (wrongAction as any).toolOperation = binding;
  await expectDenied(env, workSessionContext(approveState, wrongAction), /for action "proposal_draft", not the resolved action/, t);

  const wrongOperation = mintExternalToolApprovalProof(approveState, { ...binding, operationId: "google_docs.create_and_verify_too" });
  await expectDenied(env, workSessionContext(approveState, wrongOperation), /authorizes Tool operation/, t);

  const wrongTarget = mintExternalToolApprovalProof(approveState, { ...binding, targetResourceId: "gdrive:folder:folder-2" });
  await expectDenied(env, workSessionContext(approveState, wrongTarget), /authorizes external target/, t);

  const notionBound = mintApprovalProofForWork(approveState, "proposals-ds");
  await expectDenied(env, workSessionContext(approveState, notionBound), /targets proposals-ds, not an external Tool operation/, t);

  const noOperationBinding = { ...mintApprovalProofForWork(approveState, EXTERNAL_TOOL_TARGET) };
  await expectDenied(env, workSessionContext(approveState, noOperationBinding), /carries no external Tool operation binding/, t);

  const malformedToken = mintExternalToolApprovalProof(approveState, binding);
  (malformedToken as any).approvalToken = "short";
  await expectDenied(env, workSessionContext(approveState, malformedToken), /no usable approval token/, t);
});

test("O. correctly bound approval evidence authorizes the gated Action -- the full mint/verify round trip through the real path", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const approveState = toolState({ actionName: "proposal_approve" });
  const proof = mintExternalToolApprovalProof(approveState, {
    toolId: "google_docs",
    operationId: "google_docs.create_and_verify",
    targetResourceId: "gdrive:folder:folder-1",
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    workSessionContext(approveState, proof),
  );
  assert.equal(outcome.state, "succeeded", `expected success, got ${outcome.state}: ${outcome.reason ?? ""}`);
  assert.equal(driveCreates(calls).length, 1);
});

test("P. a Notion write proof never authorizes an external Tool mutation, and a Tool proof never satisfies evaluateExternalMutationAccess' Notion path assumptions", () => {
  const state = toolState({ actionName: "proposal_approve" });
  const notionProof = mintApprovalProofForWork(state, "proposals-ds");
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        fakeEnv(),
        { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: "gdrive:folder:folder-1" },
        workSessionContext(state, notionProof),
      ),
    (error: unknown) => error instanceof AccessDeniedError && /not an external Tool operation/.test(error.reason),
    "a Notion-bound proof must be refused by the external-mutation model",
  );
  const toolProof = mintExternalToolApprovalProof(state, {
    toolId: "google_docs",
    operationId: "google_docs.create_and_verify",
    targetResourceId: "gdrive:folder:folder-1",
  });
  assert.equal(toolProof.targetDataSourceId, EXTERNAL_TOOL_TARGET, "an external proof is marked against the external-tool target, never a Notion source");
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        fakeEnv(),
        { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: "gdrive:folder:folder-2" },
        workSessionContext(state, toolProof),
      ),
    (error: unknown) => error instanceof AccessDeniedError && /authorizes external target/.test(error.reason),
  );
});

test("Q. an unregistered account cannot be selected as the target: a caller-named account is resolved against this Worker's authorized set", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const outcome = await invokeTool(
    env,
    {
      tool_id: GOOGLE_DOCS_TOOL_ID,
      operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID,
      input: { ...VALID_INPUT, account_identifier: "attacker@example.com" },
    },
    submitContext(),
  );
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", /not one of the 1 account\(s\) this Worker is authorized for/);
  assert.equal(googleCalls(calls).length, 0);
});

// ---------------------------------------------------------------------------
// Google Docs outcomes.
// ---------------------------------------------------------------------------

test("R. successful create + insert + read-back verification returns succeeded with the verified remote resource", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.verified, true);
  assert.equal(outcome.remote_resource?.document_id, "doc-1");
  assert.ok(outcome.remote_resource?.url, "the outcome carries the document URL");
  assert.equal(driveCreates(calls).length, 1, "exactly one creation");
  const stages = googleCalls(calls).map((c) => c.url);
  assert.equal(stages.filter((u) => u.includes(":batchUpdate")).length, 1);
  assert.equal(stages.filter((u) => u.endsWith("/documents/doc-1")).length, 1, "success is claimed only after read-back");
});

test("S. an expired account whose token refresh fails is a definite failure (failed, stage auth) with zero Drive calls", async (t) => {
  const { kv } = kvWithGoogleAccounts(["martin@example.com"], { expired: true });
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, (call) => (call.url.endsWith("/oauth2/token") ? json({ error: "invalid_grant" }, 400) : docServer()(call)));
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.stage, "auth");
  assert.match(outcome.reason ?? "", /^auth: /);
  assert.equal(driveCreates(calls).length, 0, "an auth failure happens before any Drive request");
});

test("T. a rejected creation (HTTP) is a definite failed outcome -- never reported as uncertainty", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, (call) => (call.url.endsWith("/drive/v3/files") ? json({}, 500) : docServer()(call)));
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "failed");
  assert.match(outcome.reason ?? "", /creation: Google Drive file creation failed \(HTTP 500\)/);
  assert.equal(outcome.reconciliation_required, undefined, "a definite failure demands no reconciliation");
  assert.equal(googleCalls(calls).length, 1);
});

test("U. a lost creation response (network error) is unverified -- a possible remote effect, reconciliation required", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, () => {
    throw new TypeError("fetch failed");
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "unverified");
  assert.equal(outcome.reconciliation_required, true);
  assert.match(outcome.reason ?? "", /Network error during Google Doc creation/);
  assert.equal(driveCreates(calls).length, 1, "the attempt was made; its result is simply unknown");
});

test("V. a failure after the file was created preserves the document id and reports partially_completed (insertion failed)", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, (call) => (call.url.includes(":batchUpdate") ? json({}, 500) : docServer()(call)));
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "partially_completed");
  assert.equal(outcome.remote_resource?.document_id, "doc-1", "the remote identifier survives the failure");
  assert.equal(outcome.reconciliation_required, true);
  assert.match(outcome.reason ?? "", /insertion/);
  assert.equal(driveCreates(calls).length, 1);
});

test("W. a verification failure reports unverified with the document id -- never 'nothing happened'", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  installGoogleFake(t, (call) => {
    if (call.url.endsWith("/documents/doc-1") && call.method === "GET") return json({ title: "Some other title", body: { content: [] } });
    return docServer()(call);
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "unverified");
  assert.equal(outcome.remote_resource?.document_id, "doc-1");
  assert.equal(outcome.reconciliation_required, true);
  assert.match(outcome.reason ?? "", /verification/);
});

test("X. a creation response with no usable document id is partially_completed -- the file may exist with nothing to reconcile against", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  installGoogleFake(t, (call) => (call.url.endsWith("/drive/v3/files") ? json({}) : docServer()(call)));
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "partially_completed");
  assert.equal(outcome.remote_resource, undefined, "no id was returned, so none can be claimed");
  assert.equal(outcome.reconciliation_required, true);
});

// ---------------------------------------------------------------------------
// Retry safety -- reconciliation before any repeat, never a blind retry.
// ---------------------------------------------------------------------------

const priorUncertain = (documentId?: string): ToolInvocationOutcome => ({
  state: "unverified",
  tool_id: GOOGLE_DOCS_TOOL_ID,
  operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID,
  ...(documentId ? { remote_resource: { document_id: documentId, url: `https://docs.google.com/document/d/${documentId}` } } : {}),
  reason: "earlier uncertain attempt (fixture)",
  reconciliation_required: true,
});

test("Y. a prior uncertain outcome whose document already holds the content returns succeeded via reconciliation, with zero new creations", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, (call) => {
    if (call.url.endsWith("/documents/doc-1") && call.method === "GET") {
      return json({
        title: VALID_INPUT.title,
        body: { content: [{ paragraph: { elements: [{ textRun: { content: VALID_INPUT.content } }] } }] },
      });
    }
    return docServer()(call);
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: priorUncertain("doc-1") },
    submitContext(),
  );
  assert.equal(outcome.state, "succeeded");
  assert.match(outcome.reason ?? "", /reconciled/);
  assert.equal(driveCreates(calls).length, 0, "reconciliation must not create anything");
});

test("Z. a prior uncertain outcome whose document exists but does not match reports partially_completed with the same id -- no duplicate creation", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, (call) => {
    if (call.url.endsWith("/documents/doc-1") && call.method === "GET") {
      return json({ title: "PROP-7", body: { content: [{ paragraph: { elements: [{ textRun: { content: "an empty or stale body" } }] } }] } });
    }
    return docServer()(call);
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: priorUncertain("doc-1") },
    submitContext(),
  );
  assert.equal(outcome.state, "partially_completed");
  assert.equal(outcome.remote_resource?.document_id, "doc-1");
  assert.match(outcome.reason ?? "", /exists but does not hold the requested content/);
  assert.equal(driveCreates(calls).length, 0, "an existing remote effect is reconciled, never recreated");
});

test("AA. only reconciliation that establishes NO remote effect (404) permits a fresh creation", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const server = docServer();
  const { calls } = installGoogleFake(t, (call) => {
    // The FIRST read is reconciliation (404: nothing exists); reads after
    // the fresh creation must serve the happy-path verification from the
    // same shared server state.
    if (call.url.endsWith("/documents/doc-1") && call.method === "GET" && driveCreates(calls).length === 0) {
      return json({ error: "not found" }, 404);
    }
    return server(call);
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: priorUncertain("doc-1") },
    submitContext(),
  );
  assert.equal(outcome.state, "succeeded");
  assert.equal(driveCreates(calls).length, 1, "one creation, and only after the read proved nothing exists");
});

test("AB. a prior uncertain outcome with no resource identifier refuses outright -- zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: priorUncertain(undefined) },
    submitContext(),
  );
  assert.equal(outcome.state, "unverified");
  assert.equal(outcome.reconciliation_required, true);
  assert.match(outcome.reason ?? "", /no resource identifier to reconcile/);
  assert.equal(googleCalls(calls).length, 0, "nothing may run when the remote state cannot be established");
});

test("AC. a prior succeeded outcome is returned as-is -- the verified effect is never recreated", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const prior: ToolInvocationOutcome = {
    state: "succeeded",
    tool_id: GOOGLE_DOCS_TOOL_ID,
    operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID,
    verified: true,
    remote_resource: { document_id: "doc-1", url: "https://docs.google.com/document/d/doc-1" },
  };
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: prior },
    submitContext(),
  );
  assert.equal(outcome.state, "succeeded");
  assert.equal(googleCalls(calls).length, 0);
});

test("AD. a malformed prior outcome (unknown state or wrong operation) refuses outright", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const malformedStates = [
    { ...priorUncertain("doc-1"), state: "maybe" },
    { ...priorUncertain("doc-1"), operation_id: "google_docs.other" },
  ] as ToolInvocationOutcome[];
  for (const prior_outcome of malformedStates) {
    const outcome = await invokeTool(
      env,
      { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome },
      submitContext(),
    );
    assert.equal(outcome.state, "denied");
    assert.match(outcome.reason ?? "", /malformed prior_outcome/);
  }
  assert.equal(googleCalls(calls).length, 0);
});

test("AE. an unreachable reconciliation read keeps the outcome unverified and starts no creation", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, () => {
    throw new TypeError("fetch failed");
  });
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: priorUncertain("doc-1") },
    submitContext(),
  );
  assert.equal(outcome.state, "unverified");
  assert.equal(outcome.reconciliation_required, true);
  assert.equal(driveCreates(calls).length, 0, "an unreadable remote state never permits a new creation");
});

test("AF. a prior failed (definite, no remote effect) outcome may be retried -- reconciliation is only demanded for uncertain ones", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, docServer());
  const prior: ToolInvocationOutcome = {
    state: "failed",
    tool_id: GOOGLE_DOCS_TOOL_ID,
    operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID,
    stage: "creation",
    reason: "creation: Google Drive file creation failed (HTTP 500)",
  };
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: VALID_INPUT, prior_outcome: prior },
    submitContext(),
  );
  assert.equal(outcome.state, "succeeded");
  assert.equal(driveCreates(calls).length, 1, "a definite failure created nothing, so a fresh attempt is honest");
});

// ---------------------------------------------------------------------------
// Outcome-shape validation (malformed handler outcomes fail closed).
// ---------------------------------------------------------------------------

test("AG. malformed outcomes are rejected by the contract validator; valid ones pass", () => {
  const operation = resolveToolOperation(GOOGLE_DOCS_TOOL_ID, GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID)!;
  const base = { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID };
  const valid: ToolInvocationOutcome[] = [
    { ...base, state: "succeeded", verified: true, remote_resource: { document_id: "doc-1" } },
    { ...base, state: "failed", reason: "creation: HTTP 500" },
    { ...base, state: "partially_completed", reason: "insertion", reconciliation_required: true },
    { ...base, state: "unverified", reason: "verification", reconciliation_required: true },
    { ...base, state: "denied", reason: "not declared" },
  ];
  for (const outcome of valid) assert.equal(validateOutcomeShape(outcome, operation), null, JSON.stringify(outcome));

  const defective: [ToolInvocationOutcome, RegExp][] = [
    [{ ...base, state: "succeeded", remote_resource: { document_id: "doc-1" } }, /verified: true/],
    [{ ...base, state: "succeeded", verified: true }, /remote resource id/],
    [{ ...base, state: "failed" }, /why it failed/],
    [{ ...base, state: "failed", reason: "x", reconciliation_required: true }, /may not demand reconciliation/],
    [{ ...base, state: "partially_completed" }, /reconciliation_required/],
    [{ ...base, state: "unverified", reason: "x" }, /reconciliation_required/],
    [{ ...base, state: "denied", remote_resource: { document_id: "doc-1" } }, /may not claim a remote resource/],
    [{ ...base, state: "wobbly" } as any, /unknown outcome state/],
    [{ ...base, tool_id: "other", state: "denied", reason: "x" }, /not google_docs/],
  ];
  for (const [outcome, pattern] of defective) {
    assert.match(validateOutcomeShape(outcome, operation) ?? "", pattern, JSON.stringify(outcome));
  }
});

test("AH. a resolution of an unregistered operation is null, not a partial or fuzzy match", () => {
  assert.equal(resolveToolOperation("google_docs", "google_docs.create"), null, "prefix of a real operation id must not match");
  assert.equal(resolveToolOperation("google_docs", "create_and_verify"), null, "an un-namespaced operation id must not match");
  assert.equal(resolveToolOperation("Google_Docs", "google_docs.create_and_verify"), null, "ids are exact and case-sensitive");
  assert.equal(resolveToolOperation(undefined as any, undefined as any), null);
});
