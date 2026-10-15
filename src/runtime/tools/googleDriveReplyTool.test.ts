import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { Env, ExternalToolOperationRecord, WorkState } from "../../types";
import { mintExternalToolApprovalProof, workSessionContext, workSessionReadContext } from "../../access";
import { registerWatchedGoogleDoc, registerWatchedGoogleSheet } from "../../googleOAuth";
import { invokeTool, operationRecordKey, resolveToolOperation } from "../toolRegistry";
import { installStatePersistence } from "../workPersistence";
import { GOOGLE_DRIVE_REPLY_MAX_CONTENT_CHARS, GOOGLE_DRIVE_REPLY_OPERATION_ID } from "./googleDriveReplyTool";
import { GOOGLE_DRIVE_TOOL_ID } from "./googleDriveFolderTool";

/**
 * The registered comment-reply operation (google_drive.reply_to_comment) at
 * the invocation boundary: exact input contract, trusted target from the
 * watch registry, Access on the Work's own resolved Action (including the
 * bound proof the approval-gated Action demands), the honest outcome
 * mapping, the durable intent/outcome records, and the deliberate NO-REPEAT
 * contract for an uncertain reply (no reconciliation step -- a duplicate
 * reply to a human is worse than a missing one).
 *
 * Every Google interaction here is a scripted fetch fake with call counters
 * -- no real Google request is ever made -- and every denial asserts ZERO
 * Google calls.
 */

// ---------------------------------------------------------------------------
// Fixtures (the same conventions as src/runtime/toolRegistry.test.ts).
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
function kvWithGoogleAccounts(accounts: string[] = ["martin@example.com"]) {
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
  return { store, kv: kv as any };
}

interface GoogleCall {
  method: string;
  url: string;
  body?: any;
}

const REAL_FETCH = globalThis.fetch;
function installGoogleFake(t: any, handler: (call: GoogleCall) => Response) {
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
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return { calls };
}

/** Google always answers with raw JSON, so the payload is returned verbatim (never wrapped). */
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

/**
 * The comment-reply server: answers the POST to the replies endpoint and the
 * read-back GET of the comment's replies. The options object is read at call
 * time, so a test can mutate it between invocations (e.g. reject once, then
 * accept the later attempt).
 */
interface ReplyServerScript {
  postStatus?: number;
  postBody?: any;
  networkErrorOnPost?: boolean;
  readBackIds?: string[];
  /** Captured the moment the POST arrives -- proves the durable intent was flushed first. */
  flushesAtPost?: { value: number };
}
function replyServer(opts: ReplyServerScript = {}) {
  return (call: GoogleCall): Response => {
    const { url, method } = call;
    if (url.endsWith("/oauth2/token")) return json({ access_token: "fresh", refresh_token: "r", expires_in: 3600 });
    if (url.includes("/comments/") && url.includes("/replies") && method === "POST") {
      if (opts.flushesAtPost) opts.flushesAtPost.value = flushes.length;
      if (opts.networkErrorOnPost) throw new Error("reply network down");
      return json(opts.postBody ?? { id: "reply-1" }, opts.postStatus ?? 200);
    }
    if (url.includes("/comments/") && method === "GET") {
      return json({ replies: (opts.readBackIds ?? ["reply-1"]).map((id) => ({ id })) });
    }
    throw new Error(`Unexpected Google call: ${method} ${url}`);
  };
}

/** A Work whose resolved Action (proposal_submit) declares the reply operation and is not approval-gated. */
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

const submitContext = () => workSessionContext(toolState());

const googleCalls = (calls: GoogleCall[]) => calls.filter((c) => c.url.includes("googleapis.com") && !c.url.includes("/oauth2/"));
const postReplies = (calls: GoogleCall[]) => googleCalls(calls).filter((c) => c.method === "POST" && c.url.includes("/replies"));
const readBacks = (calls: GoogleCall[], commentId: string) =>
  googleCalls(calls).filter((c) => c.method === "GET" && c.url.includes(`/comments/${commentId}?fields=replies(id)`));

const DOC_ID = "doc-watched-1";
const COMMENT_ID = "c-1";
const ACCOUNT = "martin@example.com";
const REPLY_INPUT = {
  file_id: DOC_ID,
  comment_id: COMMENT_ID,
  content: "Change recorded -- PROP-9 v2 was created from this comment.",
  account_identifier: ACCOUNT,
};
const REPLY_TARGET = `gdrive:comment:${DOC_ID}:${COMMENT_ID}`;
const REPLY_KEY = operationRecordKey(GOOGLE_DRIVE_REPLY_OPERATION_ID, REPLY_TARGET, REPLY_INPUT);

async function registerWatchedDoc(env: Env, overrides: Record<string, unknown> = {}) {
  await registerWatchedGoogleDoc(env, {
    documentId: DOC_ID,
    accountIdentifier: ACCOUNT,
    title: "PROP-9 v1",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as any);
}

// ---------------------------------------------------------------------------
// Durable operation persistence: each test starts with a fresh record store,
// and `flushes` snapshots every durable write so a test can prove the INTENT
// landed before the effect and the OUTCOME right after.
// ---------------------------------------------------------------------------

let workRecords: Record<string, ExternalToolOperationRecord> = {};
let flushes: Record<string, ExternalToolOperationRecord>[] = [];
let releasePersistence: (() => void) | null = null;

beforeEach(() => {
  releasePersistence?.();
  releasePersistence = null;
  workRecords = {};
  flushes = [];
  const installed = installStatePersistence("work-tool-1", workRecords, async () => {
    flushes.push({ ...workRecords });
  });
  releasePersistence = installed.release;
});

afterEach(() => {
  releasePersistence?.();
  releasePersistence = null;
});

// ---------------------------------------------------------------------------
// Registration and the exact input contract.
// ---------------------------------------------------------------------------

test("registration. google_drive.reply_to_comment resolves exactly -- id, version 1.0, effect external_mutation, handlers present, and reconciliation deliberately absent", () => {
  const operation = resolveToolOperation(GOOGLE_DRIVE_TOOL_ID, GOOGLE_DRIVE_REPLY_OPERATION_ID);
  assert.ok(operation, "the comment-reply operation must be registered");
  assert.equal(operation.toolId, "google_drive");
  assert.equal(operation.operationId, "google_drive.reply_to_comment");
  assert.equal(operation.version, "1.0");
  assert.equal(operation.effect, "external_mutation");
  assert.equal(typeof operation.validateInput, "function");
  assert.equal(typeof operation.resolveTarget, "function");
  assert.equal(typeof operation.run, "function");
  assert.equal(
    operation.reconcile,
    undefined,
    "no reconciliation on purpose: an uncertain comment reply is never repeated -- the boundary refuses to re-send it instead",
  );
});

test("the input contract is exact -- unknown fields, unusable ids, empty/oversized/control-character content and a missing field are all denied with zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());
  const cases: unknown[] = [
    { ...REPLY_INPUT, extra: "field" },
    { ...REPLY_INPUT, file_id: "https://drive.google.com/file/d/doc-watched-1" },
    { ...REPLY_INPUT, file_id: "" },
    { ...REPLY_INPUT, comment_id: "c 1" },
    { ...REPLY_INPUT, comment_id: "" },
    { ...REPLY_INPUT, content: "" },
    { ...REPLY_INPUT, content: "   " },
    { ...REPLY_INPUT, content: "x".repeat(GOOGLE_DRIVE_REPLY_MAX_CONTENT_CHARS + 1) },
    // A literal control character in the content (built at runtime so this
    // test file itself never carries control bytes).
    { ...REPLY_INPUT, content: `bad${String.fromCharCode(7)}bell` },
    { ...REPLY_INPUT, account_identifier: "  " },
    { ...REPLY_INPUT, comment_id: undefined },
    "not an object",
  ];
  for (const input of cases) {
    const outcome = await invokeTool(env, { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input }, submitContext());
    assert.equal(outcome.state, "denied", `input ${JSON.stringify(input)} must be denied`);
    assert.match(outcome.reason ?? "", /invalid input/, `input ${JSON.stringify(input)}: ${outcome.reason}`);
  }
  assert.equal(googleCalls(calls).length, 0, "invalid input must never reach Google");
});

// ---------------------------------------------------------------------------
// Trusted-target resolution from the Worker's own runtime state.
// ---------------------------------------------------------------------------

test("trusted target. a file this Worker did not create and watch is denied with zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  const { calls } = installGoogleFake(t, replyServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: { ...REPLY_INPUT, file_id: "doc-never-registered" } },
    submitContext(),
  );
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", /not a Doc or Sheet this Worker created and watches/);
  assert.equal(googleCalls(calls).length, 0);
});

test("trusted target. a reply may not go out under an account other than the watched file's own authorized account -- zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts([ACCOUNT, "colleague@example.com"]);
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: { ...REPLY_INPUT, account_identifier: "colleague@example.com" } },
    submitContext(),
  );
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", /watched under a different account than the invocation supplied/);
  assert.equal(googleCalls(calls).length, 0);
});

test("trusted target. an account this Worker is not authorized for is denied with zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: { ...REPLY_INPUT, account_identifier: "attacker@example.com" } },
    submitContext(),
  );
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", /not one of the 1 account\(s\) this Worker is authorized for/);
  assert.equal(googleCalls(calls).length, 0);
});

test("trusted target. a watched Sheet resolves as a reply target exactly like a watched Doc", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedGoogleSheet(env, {
    spreadsheetId: "sheet-1",
    accountIdentifier: ACCOUNT,
    title: "Content Calendar",
    createdAt: new Date().toISOString(),
  } as any);
  const { calls } = installGoogleFake(t, replyServer({ readBackIds: ["reply-1"] }));
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: { ...REPLY_INPUT, file_id: "sheet-1" } },
    submitContext(),
  );
  assert.equal(outcome.state, "succeeded", `a Sheet reply must run through the same gate: ${outcome.reason}`);
  assert.equal(outcome.verified, true);
  assert.equal(postReplies(calls).length, 1, "exactly one reply POST");
});

// ---------------------------------------------------------------------------
// Access: the Work's own resolved Action.
// ---------------------------------------------------------------------------

test("Access. an Action that does not declare the reply operation is denied with zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());
  // proposal_revision declares no Tool operations at all.
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    workSessionContext(toolState({ actionName: "proposal_revision" })),
  );
  assert.equal(outcome.state, "denied");
  assert.match(outcome.reason ?? "", /does not declare Tool operation google_drive\.reply_to_comment/);
  assert.equal(googleCalls(calls).length, 0);
});

test("Access. a read-only context outside a Work's Action cannot authorize a reply -- denied with zero Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());
  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    workSessionReadContext("work-tool-1"),
  );
  assert.equal(outcome.state, "denied");
  assert.equal(googleCalls(calls).length, 0);
});

test("Access. the approval-gated proposal_approve refuses without bound approval evidence, and accepts a correctly bound proof", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());

  const approveState = toolState({ actionName: "proposal_approve" });
  const withoutProof = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    workSessionContext(approveState),
  );
  assert.equal(withoutProof.state, "denied", "a comment arriving while the gated Action is recorded fails closed on the missing bound evidence");
  assert.match(withoutProof.reason ?? "", /approval/);
  assert.equal(googleCalls(calls).length, 0, "the refusal must precede every request");

  const proof = mintExternalToolApprovalProof(approveState, {
    toolId: GOOGLE_DRIVE_TOOL_ID,
    operationId: GOOGLE_DRIVE_REPLY_OPERATION_ID,
    targetResourceId: REPLY_TARGET,
  });
  const withProof = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    workSessionContext(approveState, proof),
  );
  assert.equal(withProof.state, "succeeded", `a correctly bound proof must authorize the gated reply: ${withProof.reason}`);
  assert.equal(postReplies(calls).length, 1, "exactly one reply POST under the bound proof");
});

// ---------------------------------------------------------------------------
// Outcome mapping and the durable records.
// ---------------------------------------------------------------------------

test("a successful reply posts exactly once, claims success only after the read-back, and persists intent before the effect and outcome after", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const flushesAtPost = { value: -1 };
  const { calls } = installGoogleFake(t, replyServer({ flushesAtPost }));

  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );

  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.verified, true, "success is claimed only after the created reply was read back");
  assert.equal(outcome.remote_resource?.document_id, DOC_ID);
  const posts = postReplies(calls);
  assert.equal(posts.length, 1, "exactly one reply POST");
  assert.equal(posts[0].url, `https://www.googleapis.com/drive/v3/files/${DOC_ID}/comments/${COMMENT_ID}/replies`);
  assert.deepEqual(posts[0].body, { content: REPLY_INPUT.content }, "the reply carries exactly the composed text");
  assert.equal(readBacks(calls, COMMENT_ID).length, 1, "one read-back verification");

  assert.equal(flushesAtPost.value, 1, "the durable INTENT was already flushed when the POST arrived");
  assert.equal(flushes[0][REPLY_KEY]?.status, "in_progress", "the first durable write is the intent, never the outcome");
  assert.equal(flushes[0][REPLY_KEY]?.outcome, undefined, "the intent carries no outcome yet");
  const last = flushes[flushes.length - 1];
  assert.equal(last[REPLY_KEY]?.outcome?.state, "succeeded", "the observed outcome lands right after the effect");
});

test("an identical repeat of a verified reply is served from the durable record and never re-posted", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer());

  const first = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  const second = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );

  assert.equal(first.state, "succeeded");
  assert.equal(second.state, "succeeded", "the recorded verified success is returned as-is");
  assert.equal(postReplies(calls).length, 1, "the reply is posted exactly once for the identical invocation identity -- deduplicated by the gate itself");
});

test("an explicit Google rejection is a definite failure with no reply, and a later attempt may run", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const script: ReplyServerScript = { postStatus: 403, readBackIds: [] };
  const { calls } = installGoogleFake(t, replyServer(script));

  const first = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  assert.equal(first.state, "failed", "an answered rejection is a definite failure of this attempt");
  assert.match(first.reason ?? "", /HTTP 403/);
  assert.equal(first.reconciliation_required, undefined, "a definite failure asserts that no remote effect exists");
  assert.equal(readBacks(calls, COMMENT_ID).length, 0, "no read-back is attempted for a rejected POST");
  assert.equal(workRecords[REPLY_KEY]?.outcome?.state, "failed", "the definite failure is recorded durably");

  // A definite failure carries no remote effect, so a later attempt may
  // legitimately run (the comment flow's own marker-first policy still never
  // retries -- this is the boundary's contract, not the poller's behaviour).
  // The server now accepts it.
  script.postStatus = 200;
  script.readBackIds = ["reply-1"];
  const second = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  assert.equal(second.state, "succeeded", "after a definite failure a fresh attempt may proceed");
  assert.equal(postReplies(calls).length, 2, "the retry posted exactly once more");
});

test("a lost response leaves an uncertain effect that is NEVER repeated -- the next attempt refuses with zero new Google calls", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer({ networkErrorOnPost: true }));

  const first = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  assert.equal(first.state, "unverified", "a request that never got a response leaves the remote state unknown");
  assert.equal(first.reconciliation_required, true);
  assert.equal(workRecords[REPLY_KEY]?.status, "unverified", "the uncertainty is carried in the Work's durable record");

  const postsAfterFirst = postReplies(calls).length;
  const second = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  assert.equal(second.state, "unverified", "the boundary refuses to repeat an uncertain reply");
  assert.match(second.reason ?? "", /no reconciliation step -- refusing to repeat it/);
  assert.equal(second.reconciliation_required, true);
  assert.equal(postReplies(calls).length, postsAfterFirst, "zero new Google calls -- a duplicate reply must never reach the commenter");
});

test("an accepted POST without a reply id is partially_completed -- existence unknown, never repeated", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer({ postBody: {} }));

  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "partially_completed");
  assert.equal(outcome.reconciliation_required, true);
  assert.match(outcome.reason ?? "", /no reply id/);
  assert.equal(googleCalls(calls).length, 1, "the accepted POST, and no claimed read-back");
});

test("a read-back that does not confirm the created reply is partially_completed -- success is never claimed unverified", async (t) => {
  const { kv } = kvWithGoogleAccounts();
  const env = fakeEnv({}, kv);
  await registerWatchedDoc(env);
  const { calls } = installGoogleFake(t, replyServer({ readBackIds: ["some-other-reply"] }));

  const outcome = await invokeTool(
    env,
    { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID, input: REPLY_INPUT },
    submitContext(),
  );
  assert.equal(outcome.state, "partially_completed");
  assert.equal(outcome.reconciliation_required, true);
  assert.match(outcome.reason ?? "", /could not be confirmed by read-back/);
  assert.equal(readBacks(calls, COMMENT_ID).length, 1, "the read-back was genuinely attempted");
});
