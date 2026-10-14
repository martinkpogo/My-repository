import { salesOperationStub } from "./testSupport/salesOperationStub";
import test from "node:test";
import assert from "node:assert";
import type { Env } from "./types";
import { persistGoogleTokens, registerWatchedGoogleDoc } from "./googleOAuth";
import { pollGoogleDocComments } from "./googleDocComments";

function createMockKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = Array.from(store.keys())
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _rawStore: store,
  };
}

// Default AI mock: parses the "understood" edit-interpretation prompt out of
// the user message and echoes back a plausible replacement so tests don't
// need to special-case every call; individual tests override env.AI.run
// when they need a specific AI response (e.g. "understood: false").
function defaultAiRun() {
  return {
    run: async (_model: unknown, opts: { messages: { role: string; content: string }[] }) => {
      const userMsg = opts.messages.find((m) => m.role === "user")?.content ?? "";
      const changeToMatch = userMsg.match(/change to "([^"]*)"/i);
      const replacementText = changeToMatch ? changeToMatch[1] : "replaced";
      return { response: JSON.stringify({ understood: true, replacementText }) };
    },
  };
}

function createFakeEnv() {
  const mockKv = createMockKv();
  const fakeEnv: Env = {
    AI: defaultAiRun() as unknown as Ai,
    STATE_KV: mockKv as unknown as KVNamespace,
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-999",
    GOOGLE_OAUTH_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "mock-google-client-secret-777",
    ACTIVITY_LOG_DATA_SOURCE_ID: "mock-activity-log-ds",
    TELEGRAM_BOT_TOKEN: "mock-bot-token",
    MARTIN_TELEGRAM_USER_ID: "123456789",
    NOTION_TOKEN: "mock-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "1",
  } as Env;
  return { fakeEnv, mockKv };
}

const DOC_ID = "watched-doc-1";
const OWNER_EMAIL = "owner@enig.com";

async function setUpWatchedDoc(fakeEnv: Env) {
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "tok-1", refresh_token: "refresh-1", expires_in: 3600 },
    OWNER_EMAIL,
  );
  await registerWatchedGoogleDoc(fakeEnv, {
    documentId: DOC_ID,
    accountIdentifier: OWNER_EMAIL,
    title: "Watched Test Doc",
    chatId: 123456789,
    threadId: 604,
    createdAt: new Date().toISOString(),
  });
}

function driveCommentsUrl(docId: string) {
  return `https://www.googleapis.com/drive/v3/files/${docId}/comments`;
}

/** One page of a paginated `comments.list` response, as a test would script it. */
export interface ScriptedCommentsPage {
  comments?: any[];
  /** The token the NEXT request must send to continue, if any. */
  nextPageToken?: string;
  /** Non-200 status, to script a page that fails. */
  status?: number;
}

function mockFetchWith(handlers: {
  docText?: string;
  comments?: any[];
  /**
   * Scripts a paginated `comments.list`, keyed by the `pageToken` the caller
   * sent (`undefined` is the first request). When present this replaces the
   * single-page `comments` handler, so existing tests keep their exact
   * behaviour unless they opt into pagination.
   */
  commentPages?: (pageToken: string | undefined) => ScriptedCommentsPage;
  /** Records every `comments.list` request, so a test can assert on the exact URL/params actually sent. */
  onCommentsList?: (pageToken: string | undefined, url: string) => void;
  onReply?: (commentId: string, body: any) => void;
  /** Scripts a REJECTED reply (non-2xx), so a test can prove the failure is reported and the marker kept. Defaults to 200. */
  replyStatus?: number;
  onResolve?: (commentId: string) => void;
  onBatchUpdate?: (body: any) => boolean;
  onTelegram?: (body: any) => void;
}) {
  return (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    // logActivity (Notion) and sendWorkspaceHatMessage (Telegram) both fire
    // on the success/failure paths this module exercises -- not under test
    // here, so just acknowledge them.
    if (urlStr.startsWith("https://api.notion.com/")) {
      return new Response(JSON.stringify({ id: "notion-page-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.startsWith("https://api.telegram.org/")) {
      handlers.onTelegram?.(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (urlStr.startsWith(driveCommentsUrl(DOC_ID)) && (!init || init.method === undefined || (init?.method ?? "GET") === "GET")) {
      const pageToken = new URL(urlStr).searchParams.get("pageToken") ?? undefined;
      handlers.onCommentsList?.(pageToken, urlStr);
      if (handlers.commentPages) {
        const page = handlers.commentPages(pageToken);
        return new Response(JSON.stringify({ comments: page.comments ?? [], ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) }), {
          status: page.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ comments: handlers.comments ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr.includes(`/comments/`) && urlStr.includes("/replies") && init?.method === "POST") {
      const commentId = urlStr.split("/comments/")[1].split("/replies")[0];
      handlers.onReply?.(commentId, JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "reply-1" }), { status: handlers.replyStatus ?? 200, headers: { "content-type": "application/json" } });
    }

    if (urlStr.includes(`/comments/`) && init?.method === "PATCH") {
      const commentId = urlStr.split("/comments/")[1].split("?")[0];
      handlers.onResolve?.(commentId);
      return new Response(JSON.stringify({ id: commentId }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (urlStr === `https://docs.googleapis.com/v1/documents/${DOC_ID}`) {
      return new Response(
        JSON.stringify({
          title: "Watched Test Doc",
          body: { content: [{ paragraph: { elements: [{ textRun: { content: handlers.docText ?? "" } }] } }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (urlStr === `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`) {
      const ok = handlers.onBatchUpdate ? handlers.onBatchUpdate(JSON.parse(String(init?.body))) : true;
      return new Response(JSON.stringify({ documentId: DOC_ID }), {
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

test("pollGoogleDocComments does nothing when no docs are watched", async () => {
  const { fakeEnv } = createFakeEnv();
  const result = await pollGoogleDocComments(fakeEnv);
  assert.strictEqual(result.docsChecked, 0);
  assert.strictEqual(result.commentsProcessed, 0);
});

test("refuses a comment-anchored edit from the doc's own authorized account -- no authorization path exists, so nothing is written and the refusal is reported", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let repliedCommentId: string | null = null;
  let repliedBody: any = null;
  let resolvedCommentId: string | null = null;
  let batchUpdateBody: any = null;
  let telegramSent = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [
      {
        id: "comment-1",
        content: 'change to "Monday"',
        resolved: false,
        author: { me: true, displayName: "Owner" },
        quotedFileContent: { value: "Friday" },
      },
    ],
    onReply: (id, body) => {
      repliedCommentId = id;
      repliedBody = body;
    },
    onResolve: (id) => {
      resolvedCommentId = id;
    },
    onBatchUpdate: (body) => {
      batchUpdateBody = body;
      return true;
    },
    onTelegram: () => {
      telegramSent = true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(result.docsChecked, 1);
  assert.strictEqual(result.commentsProcessed, 1, "the comment is handled -- marked processed so the same request is never re-attempted on every poll");
  assert.strictEqual(repliedCommentId, "comment-1");
  assert.ok(
    repliedBody.content.includes("not an authorized operation"),
    `the refusal must state the missing authorization honestly, got: ${repliedBody?.content}`,
  );
  assert.ok(repliedBody.content.includes("nothing in this document was changed"), "the refusal must state that nothing changed");
  assert.strictEqual(resolvedCommentId, null, "an edit that was not applied is never resolved");
  assert.strictEqual(batchUpdateBody, null, "no Docs batchUpdate may be sent outside the governed external-effect boundary");
  assert.strictEqual(result.diagnostics.at(-1)!.outcome, "edit_not_authorized");
  assert.strictEqual(telegramSent, false, "the refusal reaches the commenter directly; no extra Telegram signal is manufactured");

  const processedMarker = await fakeEnv.STATE_KV.get("google_comment_processed:comment-1");
  assert.strictEqual(processedMarker, "1");
});

test("ignores a comment from anyone other than the doc's own authorized account -- never executes or replies", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let replied = false;
  let batchUpdated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [
      {
        id: "comment-2",
        content: 'change to "Monday"',
        resolved: false,
        author: { me: false, displayName: "Someone Else" },
        quotedFileContent: { value: "Friday" },
      },
    ],
    onReply: () => {
      replied = true;
    },
    onBatchUpdate: () => {
      batchUpdated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(replied, false, "must never reply to a comment from an unauthorized identity");
  assert.strictEqual(batchUpdated, false, "must never execute an edit requested by an unauthorized identity");
  assert.strictEqual(result.commentsProcessed, 0);
  assert.strictEqual(
    result.diagnostics.find((d) => d.commentId === "comment-2")?.outcome,
    "unauthorized_author",
    "the exact recorded outcome names the refusal",
  );

  const processedMarker = await fakeEnv.STATE_KV.get("google_comment_processed:comment-2");
  assert.strictEqual(processedMarker, "1", "still marked processed so it isn't re-checked forever");
});

test("asks for clarification when the comment has no anchored selection, without guessing a target", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let repliedBody: any = null;
  let batchUpdated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [
      {
        id: "comment-3",
        content: "please fix the date",
        resolved: false,
        author: { me: true },
        // no quotedFileContent -- a general, unanchored comment
      },
    ],
    onReply: (_id, body) => {
      repliedBody = body;
    },
    onBatchUpdate: () => {
      batchUpdated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(batchUpdated, false);
  assert.ok(repliedBody.content.toLowerCase().includes("select"));
});

test("fails closed and asks for a unique selection when the anchored text appears more than once", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let repliedBody: any = null;
  let batchUpdated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "Friday works. Actually Friday is fine too.",
    comments: [
      {
        id: "comment-4",
        content: 'change to "Monday"',
        resolved: false,
        author: { me: true },
        quotedFileContent: { value: "Friday" },
      },
    ],
    onReply: (_id, body) => {
      repliedBody = body;
    },
    onBatchUpdate: () => {
      batchUpdated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(batchUpdated, false, "must never guess which occurrence to replace");
  assert.ok(repliedBody.content.includes("2 times"));
});

test("asks for clarification when the AI cannot determine a specific replacement", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  fakeEnv.AI = {
    run: async () => ({ response: JSON.stringify({ understood: false }) }),
  } as unknown as Ai;

  let repliedBody: any = null;
  let batchUpdated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [
      {
        id: "comment-5",
        content: "hmm not sure about this",
        resolved: false,
        author: { me: true },
        quotedFileContent: { value: "Friday" },
      },
    ],
    onReply: (_id, body) => {
      repliedBody = body;
    },
    onBatchUpdate: () => {
      batchUpdated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(batchUpdated, false);
  assert.ok(repliedBody.content.toLowerCase().includes("clarify"));
});

test("skips an already-resolved comment without replying or editing", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let replied = false;
  let batchUpdated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [
      {
        id: "comment-6",
        content: 'change to "Monday"',
        resolved: true,
        author: { me: true },
        quotedFileContent: { value: "Friday" },
      },
    ],
    onReply: () => {
      replied = true;
    },
    onBatchUpdate: () => {
      batchUpdated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(replied, false);
  assert.strictEqual(batchUpdated, false);
  assert.strictEqual(result.commentsProcessed, 0);
});

test("a comment already marked processed is never re-executed on a later poll", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  await fakeEnv.STATE_KV.put("google_comment_processed:comment-7", "1");

  let batchUpdated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [
      {
        id: "comment-7",
        content: 'change to "Monday"',
        resolved: false,
        author: { me: true },
        quotedFileContent: { value: "Friday" },
      },
    ],
    onBatchUpdate: () => {
      batchUpdated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(batchUpdated, false);
  assert.strictEqual(result.commentsProcessed, 0);
});

// ---------------------------------------------------------------------------
// Proposal-bound Docs: a comment is first CLASSIFIED (routing only,
// fail-closed ambiguous) -- presentation-only goes to the formatting-only
// path, anything requesting a text change is a change REQUEST for that exact
// version, unclear intent is held for clarification.
// ---------------------------------------------------------------------------

async function setUpProposalDoc(
  fakeEnv: Env,
  calls: any[],
  result: any,
  opts: {
    intentResponse?: string;
    formattingCalls?: any[];
    formattingResult?: any;
    clarificationCalls?: any[];
    clarificationResult?: any;
    cycleSyncCalls?: any[];
    cycleSyncResult?: any;
  } = {},
) {
  await persistGoogleTokens(fakeEnv, { access_token: "tok-1", refresh_token: "refresh-1", expires_in: 3600 }, OWNER_EMAIL);
  await registerWatchedGoogleDoc(fakeEnv, {
    documentId: DOC_ID,
    accountIdentifier: OWNER_EMAIL,
    title: "PROP-6 v1",
    chatId: 123456789,
    threadId: 604,
    createdAt: new Date().toISOString(),
    proposal: { workId: "work-1", proposalNumber: 6, proposalId: "PROP-6", version: 1 },
  });
  (fakeEnv as any).WORK_SESSION = {
    idFromName: (name: string) => name,
    get: () => salesOperationStub({
      handleProposalDocComment: async (req: any) => {
        calls.push(req);
        return result;
      },
      handleProposalDocFormatting: async (req: any) => {
        opts.formattingCalls?.push(req);
        return opts.formattingResult ?? { kind: "formatted" };
      },
      // The clarified contract: an AMBIGUOUS comment is recorded on its Work
      // as an awaiting clarification (resumed by Martin's Telegram reply)
      // instead of being marked processed, so the request stays recoverable
      // rather than being settled by guesswork or lost.
      requestProposalDocClarification: async (req: any) => {
        opts.clarificationCalls?.push(req);
        return opts.clarificationResult ?? { ok: true };
      },
      // The approval-cycle sync runs on every poll of a Proposal Doc,
      // independently of whether any comment needed processing -- resolution
      // is observed on its own so a Martin resolve between polls can complete
      // a cycle. Default: no open cycle (nothing to approve).
      syncProposalDocApprovalCycle: async (req: any) => {
        opts.cycleSyncCalls?.push(req);
        return opts.cycleSyncResult ?? { kind: "no_cycle" };
      },
    }),
  };
  // The classifier runs BEFORE either handler: its persona carries
  // "classify ONE comment" (in the system message) and its response is
  // configurable per test -- default "substantive", the existing revision
  // behavior. Any other AI prompt falls back to the understood-edit mock.
  const fallback = defaultAiRun().run;
  fakeEnv.AI = {
    run: async (model: unknown, runOpts: any) => {
      const prompt = (runOpts.messages ?? []).map((m: any) => m.content).join("\n");
      if (prompt.includes("classify ONE comment")) return { response: opts.intentResponse ?? JSON.stringify({ intent: "substantive" }) };
      return fallback(model, runOpts);
    },
  } as unknown as Ai;
}

test("a comment on a proposal-bound Doc requests a change for its version, replies, is deliberately LEFT UNRESOLVED, and never edits the Doc", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 });
  let reply: any = null;
  let resolved: string | null = null;
  let edited = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-p1", content: "Make the scope shorter", resolved: false, author: { me: true }, quotedFileContent: { value: "Scope section" } }],
    onReply: (_id, body) => (reply = body),
    onResolve: (id) => (resolved = id),
    onBatchUpdate: () => ((edited = true), true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  // The comment's identity travels with the request so the approval cycle can
  // register it as an actionable item the moment it is classified substantive.
  assert.deepStrictEqual(calls, [
    { proposalNumber: 6, version: 1, text: 'Regarding "Scope section": Make the scope shorter', commentId: "c-p1", documentId: DOC_ID },
  ]);
  assert.ok(reply.content.includes("PROP-6 v2") && reply.content.includes("unchanged"));
  assert.ok(reply.content.includes("leaving this comment OPEN"), "the reply tells Martin his own resolve completes the cycle");
  assert.strictEqual(resolved, null, "a substantive comment is NEVER auto-resolved -- resolution is Martin's own signal");
  assert.strictEqual(edited, false);
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-p1"), "1");
});

test("a proposal-bound Doc comment from anyone but the authorizing account is ignored", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 });
  let replied = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-p2", content: "Change it", resolved: false, author: { me: false } }],
    onReply: () => (replied = true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const pollResult = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(replied, false);
  assert.strictEqual(
    pollResult.diagnostics.find((d: any) => d.commentId === "c-p2")?.outcome,
    "unauthorized_author",
    "the exact recorded outcome names the refusal",
  );
});

test("a change the Work refuses (stale version) is answered 'Not applied' and the comment stays unresolved", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "stale", detail: "this Doc is v1 but PROP-6 is now v2." });
  let reply: any = null;
  let resolved = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-p3", content: "Shorten", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (reply = body),
    onResolve: () => (resolved = true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.ok(reply.content.startsWith("Not applied -- this Doc is v1"));
  assert.strictEqual(resolved, false);
});

test("a presentation-only comment runs the formatting-only path: no revision, no Doc edit, and the reply says content unchanged and no new version", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const formattingCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { intentResponse: JSON.stringify({ intent: "formatting" }), formattingCalls });
  let reply: any = null;
  let resolved: string | null = null;
  let edited = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-f1", content: "Improve the formatting of this proposal", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (reply = body),
    onResolve: (id) => (resolved = id),
    onBatchUpdate: () => ((edited = true), true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.deepStrictEqual(formattingCalls, [{ proposalNumber: 6, version: 1 }], "the formatting handler gets the Doc's exact binding");
  assert.strictEqual(calls.length, 0, "a formatting-only request never enters the substantive revision path");
  assert.strictEqual(edited, false, "the Doc's text is never edited in place");
  assert.ok(reply.content.includes("content is unchanged") && reply.content.includes("no new version"), reply.content);
  assert.strictEqual(resolved, "c-f1");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-f1"), "1");
  assert.deepStrictEqual(
    result.diagnostics.map((d: any) => d.outcome),
    ["comments_fetched", "formatting_applied", "approval_cycle_synced"],
  );
});

test("a mixed-intent comment (formatting + a text change) is substantive: it never enters the formatting-only path", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const formattingCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { intentResponse: JSON.stringify({ intent: "substantive" }), formattingCalls });
  let reply: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-m1", content: "Improve the formatting and shorten the scope", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (reply = body),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(formattingCalls.length, 0, "a request containing a text change must never take the formatting-only path");
  assert.strictEqual(calls.length, 1, "it takes the substantive revision path");
  assert.ok(calls[0].text.includes("shorten the scope"), "the comment text still reaches the revision path verbatim");
  assert.ok(reply.content.includes("PROP-6 v2"), reply.content);
});

test("an ambiguous comment is held for clarification: neither handler runs, nothing is created, the comment is answered once", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const formattingCalls: any[] = [];
  const clarificationCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { intentResponse: JSON.stringify({ intent: "ambiguous" }), formattingCalls, clarificationCalls });
  let replies = 0;
  let reply: any = null;
  let resolved = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-a1", content: "Maybe improve it somehow?", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (replies++, (reply = body)),
    onResolve: () => (resolved = true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);
  const second = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(calls.length, 0, "the revision handler is never invoked");
  assert.strictEqual(formattingCalls.length, 0, "the formatting handler is never invoked");
  assert.ok(reply.content.includes("formatting only") && reply.content.includes("content/text change"), reply.content);
  assert.strictEqual(resolved, false, "a held comment stays open for Martin's clarification");
  assert.strictEqual(replies, 1, "the clarification is asked exactly once");
  // The clarified contract: the request is recorded on its Work (with its
  // exact bindings) instead of being marked processed, so it stays
  // recoverable and Martin's Telegram reply resumes THIS request.
  assert.strictEqual(clarificationCalls.length, 1, "the clarification is recorded on the Work exactly once");
  assert.deepStrictEqual(clarificationCalls[0], {
    proposalNumber: 6,
    version: 1,
    commentId: "c-a1",
    documentId: DOC_ID,
    text: "Maybe improve it somehow?",
  });
  assert.strictEqual(
    await fakeEnv.STATE_KV.get("google_comment_processed:c-a1"),
    null,
    "a comment awaiting clarification is NOT marked processed -- marking it would close off the request still waiting to be answered",
  );
  assert.strictEqual(second.commentsProcessed, 0, "a duplicate delivery is skipped: the clarification is already outstanding on the Work");
});

test("classifier output that is malformed, unexpected or unparsable fails closed to ambiguous -- never to a handler", async (t) => {
  for (const [idx, response] of ['{"intent":"banana"}', "this is not JSON at all", '{"intent":"FORMATTING"}'].entries()) {
    const { fakeEnv } = createFakeEnv();
    const calls: any[] = [];
    const formattingCalls: any[] = [];
    await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { intentResponse: response, formattingCalls });
    let reply: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWith({
      comments: [{ id: `c-b${idx}`, content: "Improve the formatting", resolved: false, author: { me: true } }],
      onReply: (_id, body) => (reply = body),
    });
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    await pollGoogleDocComments(fakeEnv);

    assert.strictEqual(calls.length, 0, `response ${response}: no revision`);
    assert.strictEqual(formattingCalls.length, 0, `response ${response}: no formatting`);
    assert.ok(reply.content.includes("couldn't tell"), `response ${response}: held for clarification, got: ${reply.content}`);
  }
});

test("a formatting request the Work refuses is answered 'Not applied' and the comment stays unresolved", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const formattingCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, {
    intentResponse: JSON.stringify({ intent: "formatting" }),
    formattingCalls,
    formattingResult: { kind: "stale", detail: "this Doc is a copy of v1, but PROP-6 is now at v2. Comment on the current version's Doc." },
  });
  let reply: any = null;
  let resolved = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-r1", content: "Make it look nicer", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (reply = body),
    onResolve: () => (resolved = true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(formattingCalls.length, 1);
  assert.ok(reply.content.startsWith("Not applied -- this Doc is a copy of v1"), reply.content);
  assert.strictEqual(resolved, false);
  assert.ok(
    result.diagnostics.some((d: any) => d.commentId === "c-r1" && d.outcome === "formatting_not_applied"),
    `the comment's own outcome is recorded, in: ${JSON.stringify(result.diagnostics.map((d: any) => d.outcome))}`,
  );
});

test("a clarification that can never be recorded is answered honestly and closed off, while one deferred behind another stays unprocessed and is retried", async () => {
  // 1. The bindings no longer hold: nothing can ever route this comment, so
  //    it is answered once and closed off rather than re-asked forever.
  const never = createFakeEnv();
  const neverCalls: any[] = [];
  const neverClarifications: any[] = [];
  await setUpProposalDoc(never.fakeEnv, neverCalls, { kind: "revised", newVersion: 2 }, {
    intentResponse: JSON.stringify({ intent: "ambiguous" }),
    clarificationCalls: neverClarifications,
    clarificationResult: { ok: false, detail: "v1 is no longer the current Version of PROP-6, so no clarification was recorded.", retryable: false },
  });
  let neverReplies = 0;
  let neverReply: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-a2", content: "Maybe improve it somehow?", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (neverReplies++, (neverReply = body)),
  });
  try {
    await pollGoogleDocComments(never.fakeEnv);
    const second = await pollGoogleDocComments(never.fakeEnv);

    assert.strictEqual(neverReplies, 1, "the honest answer is sent exactly once");
    assert.match(neverReply.content, /Nothing was changed/);
    assert.match(neverReply.content, /no longer the current Version/, "the reason is reported, not swallowed");
    assert.strictEqual(
      await never.fakeEnv.STATE_KV.get("google_comment_processed:c-a2"),
      "1",
      "a comment that can never be clarified is closed off so it is not re-classified on every future poll",
    );
    assert.strictEqual(second.commentsProcessed, 0, "the closed-off comment is skipped on the next poll");
    assert.strictEqual(neverClarifications.length, 1, "and its request is never re-recorded");

    // 2. A deferred clarification (another one is already outstanding) stays
    //    recoverable: not marked, not re-asked, and retried by a later poll.
    globalThis.fetch = mockFetchWith({
      comments: [{ id: "c-a3", content: "Maybe improve it somehow?", resolved: false, author: { me: true } }],
      onReply: () => {
        throw new Error("a deferred comment must not be asked about again on the same poll");
      },
    });
    const deferredClarifications: any[] = [];
    await setUpProposalDoc(never.fakeEnv, neverCalls, { kind: "revised", newVersion: 2 }, {
      intentResponse: JSON.stringify({ intent: "ambiguous" }),
      clarificationCalls: deferredClarifications,
      clarificationResult: { ok: false, detail: "a clarification is already outstanding for another comment on PROP-6 v2; resolve that one first.", retryable: true },
    });

    await pollGoogleDocComments(never.fakeEnv);
    assert.strictEqual(await never.fakeEnv.STATE_KV.get("google_comment_processed:c-a3"), null, "a deferred comment is never marked processed");
    assert.strictEqual(deferredClarifications.length, 1);

    await pollGoogleDocComments(never.fakeEnv);
    assert.strictEqual(deferredClarifications.length, 2, "a later poll takes the deferred comment up again");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// KV write-quota resilience: the diagnostics timestamp is best-effort so it
// can never block a poll, while the REQUIRED dedup/clarification markers stay
// fail-closed -- a marker that cannot be written means the effect it guards
// never runs, nothing is claimed, and a later poll retries the comment.
// ---------------------------------------------------------------------------

/** Makes STATE_KV.put reject for keys matching `failingPrefix`, everything else untouched. */
function failKvWritesFor(fakeEnv: Env, failingPrefix: string) {
  const kv = fakeEnv.STATE_KV as any;
  const originalPut = kv.put.bind(kv);
  kv.put = async (key: string, value: string, options?: any) => {
    if (key.startsWith(failingPrefix)) throw new Error("KV put() limit exceeded for the day.");
    return originalPut(key, value, options);
  };
}

test("a failed diagnostics timestamp write never blocks the poll from starting", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  failKvWritesFor(fakeEnv, "last_google_doc_comment_poll_run");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({ comments: [] });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(result.docsChecked, 1, "the poll ran past its diagnostics write and checked the watched doc");
  assert.deepStrictEqual(
    result.diagnostics.map((d: any) => d.outcome),
    ["comments_fetched"],
  );
  assert.strictEqual(await fakeEnv.STATE_KV.get("last_google_doc_comment_poll_run"), null, "the timestamp was not recorded, and that is survivable");
});

test("when the dedup marker cannot be persisted, no handler runs, nothing is claimed, and the comment stays unprocessed for a retry", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const formattingCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { intentResponse: JSON.stringify({ intent: "formatting" }), formattingCalls });
  failKvWritesFor(fakeEnv, "google_comment_processed:");
  let reply: any = null;
  let resolved = false;
  let edited = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-q1", content: "Improve the formatting of this proposal", resolved: false, author: { me: true } }],
    onReply: (_id, body) => (reply = body),
    onResolve: () => (resolved = true),
    onBatchUpdate: () => ((edited = true), true),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(formattingCalls.length, 0, "the registered formatting handler never ran without its marker");
  assert.strictEqual(calls.length, 0, "the substantive revision path never ran either");
  assert.strictEqual(edited, false, "the Doc's text and styling are untouched");
  assert.strictEqual(reply, null, "no success is claimed in the Doc thread");
  assert.strictEqual(resolved, false, "the comment is not resolved");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-q1"), null, "the comment stays unprocessed, so nothing is lost");
  assert.strictEqual(result.diagnostics.find((d: any) => d.commentId === "c-q1")?.outcome, "persistence_unavailable", "the failure is recorded as its own truthful outcome");
});

test("when the clarification marker cannot be persisted, the Doc thread is not told a clarification was requested, and the comment stays unprocessed", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const clarificationCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { intentResponse: JSON.stringify({ intent: "ambiguous" }), clarificationCalls });
  failKvWritesFor(fakeEnv, "google_comment_clarification_pending:");
  let replies = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-q2", content: "Maybe improve it somehow?", resolved: false, author: { me: true } }],
    onReply: () => (replies += 1),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(clarificationCalls.length, 1, "the Work was asked to carry the clarification");
  assert.strictEqual(replies, 0, "the Doc thread is not told a clarification was requested when its marker did not persist");
  assert.strictEqual(calls.length, 0, "and no handler is routed from an ambiguous comment");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-q2"), null, "the comment stays unprocessed, so nothing is lost");
  assert.strictEqual(result.diagnostics.find((d: any) => d.commentId === "c-q2")?.outcome, "persistence_unavailable");
});

// ---------------------------------------------------------------------------
// Resolution is a SEPARATE signal from comment processing: it is observed on
// every poll of a Proposal Doc and fed back into the Work's approval cycle,
// whether or not there was anything new to apply. Resolving never skips a
// change that was not applied, and the Runtime never resolves a substantive
// comment itself.
// ---------------------------------------------------------------------------

test("every poll of a Proposal Doc feeds the observed resolution state into the approval cycle, even when nothing needs processing", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const cycleSyncCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { cycleSyncCalls });
  await fakeEnv.STATE_KV.put("google_comment_processed:c-sync", "1"); // already handled earlier
  await fakeEnv.STATE_KV.put("google_comment_processed:c-other", "1"); // and so was this one

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [
      { id: "c-sync", content: "Shorten the scope", resolved: true, modifiedTime: "2026-10-11T09:30:00.000Z", author: { me: true } },
      { id: "c-other", content: "Unrelated", resolved: false, modifiedTime: "2026-10-11T09:00:00.000Z", author: { me: true } },
    ],
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(calls.length, 0, "the already-handled comment is not re-run");
  assert.deepStrictEqual(
    cycleSyncCalls,
    [
      {
        documentId: DOC_ID,
        observations: [
          { commentId: "c-sync", resolved: true, modifiedTime: "2026-10-11T09:30:00.000Z" },
          { commentId: "c-other", resolved: false, modifiedTime: "2026-10-11T09:00:00.000Z" },
        ],
      },
    ],
    "resolution is observed on its own, independently of processing",
  );
  assert.ok(
    result.diagnostics.some((d) => d.outcome === "approval_cycle_synced" && d.detail === "no_cycle"),
    `cycle sync diagnostic recorded: ${JSON.stringify(result.diagnostics.map((d) => d.outcome))}`,
  );
});

test("a RESOLVED substantive comment on a Proposal Doc is still processed -- resolution never lets an unapplied change count as fulfilled", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const cycleSyncCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, { cycleSyncCalls });
  let reply: any = null;
  let resolved: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-pre", content: "Make the scope shorter", resolved: true, modifiedTime: "2026-10-11T09:45:00.000Z", author: { me: true }, quotedFileContent: { value: "Scope section" } }],
    onReply: (_id, body) => (reply = body),
    onResolve: (id) => (resolved = id),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(calls.length, 1, "the change is still applied even though the comment was already resolved");
  assert.strictEqual(resolved, null, "and the Runtime still never resolves it itself");
  assert.ok(reply.content.includes("PROP-6 v2"), reply?.content);
  assert.strictEqual(cycleSyncCalls[0].observations[0].resolved, true, "the resolution is observed alongside the applied change");
});

test("a poll that COMPLETES the approval cycle reports that completion as its own diagnostic -- observed resolution is the signal, with no attribution gate in the poller", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const calls: any[] = [];
  const cycleSyncCalls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 }, {
    cycleSyncCalls,
    // What the DO reports when the cycle was satisfied and completed.
    cycleSyncResult: { kind: "approved", approvedVersion: 2 },
  });
  await fakeEnv.STATE_KV.put("google_comment_processed:c-sync", "1");
  await fakeEnv.STATE_KV.put("google_comment_processed:c-other", "1");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [
      { id: "c-sync", content: "Shorten the scope", resolved: true, modifiedTime: "2026-10-11T09:30:00.000Z", author: { me: true } },
      { id: "c-other", content: "Unrelated", resolved: false, modifiedTime: "2026-10-11T09:00:00.000Z", author: { me: true } },
    ],
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(calls.length, 0, "a completion needs no further comment processing");
  assert.strictEqual(cycleSyncCalls.length, 1, "the cycle is synced exactly once per poll");
  assert.ok(
    result.diagnostics.some((d) => d.outcome === "approval_cycle_synced" && d.detail === "approved"),
    `completion reported as a diagnostic: ${JSON.stringify(result.diagnostics.map((d) => d.detail))}`,
  );
});

// ---------------------------------------------------------------------------
// Pagination: comments.list returns at most pageSize (100) comments per call,
// so the fetcher must follow nextPageToken and accumulate. Before this fix a
// single request silently discarded every comment after the first 100 -- which,
// since a Proposal Doc's approval cycle is driven by the resolution state
// observed here, could hide an actionable comment entirely.
// ---------------------------------------------------------------------------

/** A live (unresolved, authorized, uniquely anchored) Doc comment. */
function liveDocComment(id: string, quoted = "Friday") {
  return { id, content: 'change to "Monday"', resolved: false, author: { me: true, displayName: "Owner" }, quotedFileContent: { value: quoted } };
}

test("pagination 1. a single-page Doc response is unchanged: one request, no pageToken ever sent, all comments returned", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  const requested: (string | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    comments: [liveDocComment("c-single-1"), liveDocComment("c-single-2")],
    onCommentsList: (pageToken) => requested.push(pageToken),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.deepStrictEqual(requested, [undefined], "exactly one request, and it carries no pageToken");
  assert.strictEqual(result.commentsProcessed, 2, "both comments are processed");
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "2 comment(s) found");
});

test("pagination 2. at least 150 comments on a Doc, spread over multiple pages, are ALL retrieved and processed", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  // 150 comments across pages of 100 + 50. All but the last are already
  // resolved, so they exercise the existing cheap rule (plain Doc -> skip +
  // mark processed); the last is live and must be genuinely processed, which
  // is what proves a comment on the FINAL page is not dropped.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}`, content: "x", resolved: true, author: { me: true } }));
  const page2Resolved = Array.from({ length: 49 }, (_, i) => ({ id: `c-${100 + i}`, content: "x", resolved: true, author: { me: true } }));
  const live = liveDocComment("c-149");

  const requested: (string | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    commentPages: (pageToken) => {
      requested.push(pageToken);
      if (pageToken === undefined) return { comments: page1, nextPageToken: "tok-page-2" };
      if (pageToken === "tok-page-2") return { comments: [...page2Resolved, live] };
      throw new Error(`unexpected pageToken ${pageToken}`);
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.deepStrictEqual(requested, [undefined, "tok-page-2"], "the returned token is followed exactly once");
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "150 comment(s) found", "all 150, not the first 100");
  assert.strictEqual(result.diagnostics.filter((d) => d.outcome === "resolved_skip").length, 149, "every resolved comment on every page is processed by the existing rule");
  assert.ok(
    result.diagnostics.some((d) => d.commentId === "c-149" && d.outcome === "edit_not_authorized"),
    "the live comment on the LAST page is genuinely processed",
  );
  assert.strictEqual(result.commentsProcessed, 1);
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-149"), "1", "its dedup marker proves it really ran");
});

test("pagination 3. the Doc follow-up request sends the returned pageToken and preserves fields, pageSize and includeDeleted", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [],
    commentPages: (pageToken) =>
      pageToken === undefined
        ? { comments: [{ id: "c-a", content: "x", resolved: true, author: { me: true } }], nextPageToken: "tok/with+specials=&?" }
        : { comments: [{ id: "c-b", content: "x", resolved: true, author: { me: true } }] },
    onCommentsList: (_pageToken, url) => urls.push(url),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(urls.length, 2, "two requests: the first page, then the continuation");
  const [first, second] = urls.map((u) => new URL(u));

  for (const u of [first, second]) {
    assert.strictEqual(u.searchParams.get("pageSize"), "100", "pageSize=100 preserved on every request");
    assert.strictEqual(u.searchParams.get("includeDeleted"), "false", "includeDeleted=false preserved on every request");
    assert.strictEqual(
      u.searchParams.get("fields"),
      "comments(id,content,resolved,modifiedTime,author(displayName,me),quotedFileContent(value),replies(id,action,author(displayName,me),createdTime,deleted))",
      "the Doc fields projection (incl. modifiedTime and replies) is preserved verbatim",
    );
  }
  assert.strictEqual(first.searchParams.get("pageToken"), null, "the first request carries no pageToken");
  assert.strictEqual(second.searchParams.get("pageToken"), "tok/with+specials=&?", "the returned token is sent back, correctly URL-encoded");
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "2 comment(s) found", "both pages accumulated");
});

test("pagination 4. an empty Doc result and an absent nextPageToken both terminate normally", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [],
    commentPages: () => {
      calls++;
      return {}; // no comments at all, and no nextPageToken
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(calls, 1, "no nextPageToken means done -- never a second request");
  assert.strictEqual(result.commentsProcessed, 0);
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "0 comment(s) found");
  assert.ok(!result.diagnostics.some((d) => d.outcome === "comments_list_failed"), "a genuinely empty result is not a failure");
});

test("pagination 5. a failure on a LATER Doc page rejects the whole fetch -- earlier-page comments are never processed as if the result were complete", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let replies = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    docText: "The quarterly report is due Friday.",
    commentPages: (pageToken) => {
      if (pageToken === undefined) {
        return { comments: [liveDocComment("c-page1-a"), liveDocComment("c-page1-b")], nextPageToken: "tok-page-2" };
      }
      return { status: 500, comments: [] }; // the continuation blows up
    },
    onReply: () => {
      replies++;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  const failed = result.diagnostics.find((d) => d.outcome === "comments_list_failed");
  assert.ok(failed, `a later-page failure is reported: ${JSON.stringify(result.diagnostics.map((d) => d.outcome))}`);
  assert.match(failed!.detail ?? "", /HTTP 500/);
  assert.strictEqual(result.commentsProcessed, 0, "nothing was processed");
  assert.strictEqual(replies, 0, "no reply was sent for comments from the completed first page");
  assert.strictEqual(result.diagnostics.filter((d) => d.commentId !== null).length, 0, "no per-comment diagnostic at all");
  const markerKeys = [...mockKv._rawStore.keys()].filter((k) => k.startsWith("google_comment_processed:"));
  assert.deepStrictEqual(markerKeys, [], "and no dedup marker was written, so a later poll retries the whole document safely");
});

test("pagination 6. a repeated Doc page token terminates safely instead of looping forever", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    commentPages: () => {
      requests++;
      // The API keeps handing back the SAME token -- a buggy server.
      return { comments: [{ id: `c-loop-${requests}`, content: "x", resolved: true, author: { me: true } }], nextPageToken: "tok-same" };
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.ok(requests <= 3, `pagination terminates promptly rather than looping (made ${requests} requests)`);
  assert.ok(result.diagnostics.some((d) => d.outcome === "comments_list_failed"), "the ambiguous fetch is refused, not treated as complete");
  assert.strictEqual(result.commentsProcessed, 0);
});

test("pagination 7. an INVALID Doc continuation token (HTTP 400) is a failure, and dedup markers from earlier polls stay intact", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  // An unrelated, pre-existing marker from an earlier poll must survive.
  await fakeEnv.STATE_KV.put("google_comment_processed:c-earlier-poll", "1");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    commentPages: (pageToken) =>
      pageToken === undefined
        ? { comments: [liveDocComment("c-bad")], nextPageToken: "not-a-real-token" }
        : { status: 400, comments: [] },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.ok(result.diagnostics.some((d) => d.outcome === "comments_list_failed"), "an invalid token fails the fetch");
  assert.match(result.diagnostics.find((d) => d.outcome === "comments_list_failed")!.detail ?? "", /HTTP 400/);
  assert.strictEqual(result.commentsProcessed, 0);
  assert.strictEqual([...mockKv._rawStore.keys()].filter((k) => k.startsWith("google_comment_processed:")).length, 1, "no new marker was written for a rejected fetch");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-earlier-poll"), "1", "and the pre-existing marker is untouched");
});

test("pagination 8. a Proposal Doc's approval cycle observes comments from EVERY page, not just the first 100", async (t) => {
  // The regression that matters most: since observed resolution is the
  // Proposal approval signal, a comment beyond page 1 must still reach the
  // cycle sync, or it could hold (or complete) a cycle invisibly.
  const { fakeEnv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "tok-1", refresh_token: "refresh-1", expires_in: 3600 }, OWNER_EMAIL);
  await registerWatchedGoogleDoc(fakeEnv, {
    documentId: DOC_ID,
    accountIdentifier: OWNER_EMAIL,
    title: "PROP-6 v1",
    chatId: 123456789,
    threadId: 604,
    createdAt: new Date().toISOString(),
    proposal: { workId: "work-1", proposalNumber: 6, proposalId: "PROP-6", version: 1 },
  });

  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}`, content: "x", resolved: true, modifiedTime: "2026-10-11T09:00:00.000Z", author: { me: true } }));
  const page2 = [
    { id: "c-deep-resolved", content: "x", resolved: true, modifiedTime: "2026-10-11T09:30:00.000Z", author: { me: true } },
    { id: "c-deep-open", content: "x", resolved: false, modifiedTime: "2026-10-11T09:00:00.000Z", author: { me: true } },
  ];

  const syncCalls: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [],
    commentPages: (pageToken) => (pageToken === undefined ? { comments: page1, nextPageToken: "tok-page-2" } : { comments: page2 }),
  });
  (fakeEnv as any).WORK_SESSION = {
    idFromName: (name: string) => name,
    get: () => salesOperationStub({
      handleProposalDocComment: async () => ({ kind: "revised", newVersion: 2 }),
      handleProposalDocFormatting: async () => ({ kind: "formatted" }),
      requestProposalDocClarification: async () => ({ ok: true }),
      syncProposalDocApprovalCycle: async (req: any) => {
        syncCalls.push(req);
        return { kind: "held_unsatisfied" };
      },
    }),
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(syncCalls.length, 1, "the cycle is synced once, from the COMPLETE comment set");
  const observations = syncCalls[0].observations;
  assert.strictEqual(observations.length, 102, "all 102 comments across both pages are observed, not just the first 100");
  assert.deepStrictEqual(
    observations.find((o: any) => o.commentId === "c-deep-resolved"),
    { commentId: "c-deep-resolved", resolved: true, modifiedTime: "2026-10-11T09:30:00.000Z" },
    "a RESOLVED comment on page 2 reaches the approval cycle -- it can no longer be invisible to it",
  );
  assert.deepStrictEqual(
    observations.find((o: any) => o.commentId === "c-deep-open"),
    { commentId: "c-deep-open", resolved: false, modifiedTime: "2026-10-11T09:00:00.000Z" },
    "and an unresolved page-2 comment still blocks, exactly as on page 1",
  );
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "approval_cycle_synced")?.detail, "held_unsatisfied");
});

// ---------------------------------------------------------------------------
// Marker ordering on the NON-Proposal doc branches: the processed marker is
// persisted BEFORE the reply is attempted, so a reply that fails can never
// leave the comment unmarked (which would re-reply on the next poll). A
// rejected reply keeps the marker and is reported to Operations with NO
// comment content. The Proposal path is deliberately untouched by these rules
// (it replies through replyToComment and manages its own markers).
// ---------------------------------------------------------------------------

test("marker 1. a non-Proposal Doc persists the processed marker BEFORE calling the reply endpoint", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  const order: string[] = [];
  const kv = fakeEnv.STATE_KV as any;
  const originalPut = kv.put.bind(kv);
  kv.put = async (key: string, value: string, options?: any) => {
    if (key.startsWith("google_comment_processed:")) order.push(`marker:${key}`);
    return originalPut(key, value, options);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    // no quotedFileContent -> the no_anchor branch replies.
    comments: [{ id: "c-order-1", content: "fix the date", resolved: false, author: { me: true } }],
    onReply: (_id, _body) => order.push("reply"),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.deepStrictEqual(order, ["marker:google_comment_processed:c-order-1", "reply"], "the marker is durably written before the reply endpoint is called");
});

test("marker 2. when a non-Proposal Doc's marker cannot be persisted, the reply is never attempted and the comment stays unprocessed", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  failKvWritesFor(fakeEnv, "google_comment_processed:");

  let replies = 0;
  let telegramSent = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-order-2", content: "fix the date", resolved: false, author: { me: true } }],
    onReply: () => (replies += 1),
    onTelegram: () => (telegramSent += 1),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(replies, 0, "no reply is attempted when the marker that guards it did not persist");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-order-2"), null, "the comment stays unprocessed, so nothing is lost");
  assert.strictEqual(result.diagnostics.find((d: any) => d.commentId === "c-order-2")?.outcome, "persistence_unavailable", "recorded as its own truthful outcome");
});

test("marker 3. a REJECTED reply on a non-Proposal Doc keeps the marker, is reported to Operations, and never claims success", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  // Enable the Operations stream so sendOperationsMessage actually dispatches
  // (getOperationsTarget needs both TELEGRAM_GROUP_CHAT_ID and OPERATIONS_TOPIC_ID).
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  let replyBody: any = null;
  const operationsAlerts: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    // no quotedFileContent -> the no_anchor branch replies.
    comments: [{ id: "c-reject-1", content: "SECRET-COMMENT-WORD please fix the date", resolved: false, author: { me: true } }],
    replyStatus: 403, // provider rejects the reply
    onReply: (_id, body) => (replyBody = body),
    onTelegram: (body) => operationsAlerts.push(body),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.ok(replyBody, "the reply WAS attempted");
  assert.strictEqual(replyBody.content.toLowerCase().includes("select"), true, "the intended reply text was what we tried to send");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-reject-1"), "1", "the marker is kept even though the reply failed -- it is never cleared");
  assert.strictEqual(result.diagnostics.find((d: any) => d.commentId === "c-reject-1")?.outcome, "no_anchor", "the comment is still recorded as processed");

  assert.ok(operationsAlerts.length >= 1, "the rejected reply is reported through the Operations stream");
  const alert = JSON.stringify(operationsAlerts);
  assert.ok(alert.includes(DOC_ID), "the alert names the affected document");
  assert.ok(alert.includes("c-reject-1"), "the alert names the affected comment");
  assert.ok(/HTTP\s+403/.test(alert), "the alert carries the failure category (HTTP 403)");
});

test("marker 4. the Operations alert for a rejected reply contains NO comment or reply content", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  const operationsAlerts: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    // Distinctive strings that must NEVER appear in the Operations alert.
    comments: [{ id: "c-noleak-1", content: "TOPSECRET-COMMENT-PAYLOAD change the figure", resolved: false, author: { me: true } }],
    replyStatus: 500,
    onTelegram: (body) => operationsAlerts.push(body),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleDocComments(fakeEnv);

  assert.ok(operationsAlerts.length >= 1, "an alert was sent");
  const alert = JSON.stringify(operationsAlerts);
  assert.ok(!alert.includes("TOPSECRET-COMMENT-PAYLOAD"), "the comment's text never reaches the Operations stream");
  assert.ok(!alert.includes("select the text"), "the reply's text never reaches the Operations stream either");
  assert.ok(!alert.toLowerCase().includes("figure"), "nor any other fragment of the comment");
});

// ---------------------------------------------------------------------------
// An escaped Proposal handler AFTER the processed marker: the comment is
// durably done (the marker runs before the handler), so it must be answered
// honestly instead of silently closed off -- without ever unmarking it,
// retrying the operation, or losing the original failure evidence.
// ---------------------------------------------------------------------------

test("escape 1. a Proposal handler that THROWS after the processed marker is answered with the interruption's true uncertainty: unhandled_exception preserved, an 'outcome could not be confirmed' reply attempted (never 'not applied'), a content-free Operations notification sent, and the handler never runs twice", async (t) => {
  const { fakeEnv } = createFakeEnv();
  // Enable the Operations stream (sendOperationsMessage needs the group chat
  // + topic), so the notification is observable exactly as in production.
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 });
  // Replace the Work stub so the substantive-comment handler itself escapes
  // (a Durable Object transport failure) AFTER the poller wrote the marker.
  (fakeEnv as any).WORK_SESSION = {
    idFromName: (name: string) => name,
    get: () =>
      salesOperationStub({
        handleProposalDocComment: async (req: any) => {
          calls.push(req);
          throw new Error("WorkSession transport unavailable");
        },
        handleProposalDocFormatting: async () => ({ kind: "formatted" }),
        requestProposalDocClarification: async () => ({ ok: true }),
        syncProposalDocApprovalCycle: async () => ({ kind: "no_cycle" }),
      }),
  };

  let reply: any = null;
  let resolved = false;
  let batchUpdated = false;
  const operationsAlerts: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-esc-1", content: "SECRET-ESCAPE-PAYLOAD shorten the scope", resolved: false, author: { me: true }, quotedFileContent: { value: "Scope section" } }],
    onReply: (_id, body) => (reply = body),
    onResolve: () => (resolved = true),
    onBatchUpdate: () => ((batchUpdated = true), true),
    onTelegram: (body) => operationsAlerts.push(body),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  // The original failure evidence is preserved verbatim.
  const diag = result.diagnostics.find((d) => d.commentId === "c-esc-1");
  assert.strictEqual(diag?.outcome, "unhandled_exception", "the escape is still recorded as its own diagnostic");
  assert.ok(diag?.detail?.includes("WorkSession transport unavailable"), `the diagnostic keeps the original error: ${diag?.detail}`);

  // The marker written before the handler is KEPT -- no unmark, no blind retry.
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-esc-1"), "1", "the comment stays durably processed");
  assert.strictEqual(calls.length, 1, "the handler ran exactly once -- a second execution attempt never happens");

  // The thread is answered with the truth about the escape: the outcome is
  // unconfirmed, and neither a failure nor a delivery claim is invented.
  assert.ok(reply, "an honest reply WAS attempted despite the escape");
  assert.match(reply.content, /could not be confirmed/, "the reply states the outcome honestly as unconfirmed");
  assert.match(reply.content, /check the Proposal/, "the reply points to the authoritative records");
  assert.ok(!/Not applied/i.test(reply.content), "the reply never claims the request was not applied -- even a lost transport call may hide a completed run");
  assert.ok(!/Martin has been notified/i.test(reply.content), "the reply never claims the Operations notification was delivered -- it is best-effort and may itself fail");
  assert.ok(!/applied successfully|change recorded|formatting applied/i.test(reply.content), "the reply never claims success either");
  assert.strictEqual(resolved, false, "a failed pass never resolves the comment");
  assert.strictEqual(batchUpdated, false, "the Doc itself is never touched");

  // Martin is notified through Operations -- identifiers only.
  assert.ok(operationsAlerts.length >= 1, "the Operations notification was sent");
  const alert = JSON.stringify(operationsAlerts);
  assert.ok(alert.includes(DOC_ID), "the alert names the affected document");
  assert.ok(alert.includes("c-esc-1"), "the alert names the affected comment");
  assert.ok(!alert.includes("SECRET-ESCAPE-PAYLOAD"), "no comment content reaches the Operations stream");
  assert.ok(!alert.includes("shorten the scope"), "nor any fragment of it");
});

test("escape 2. when the honest reply itself cannot be delivered, the original unhandled_exception evidence and the Operations notification still stand -- and nothing is re-executed", async (t) => {
  const { fakeEnv } = createFakeEnv();
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 });
  (fakeEnv as any).WORK_SESSION = {
    idFromName: (name: string) => name,
    get: () =>
      salesOperationStub({
        handleProposalDocComment: async (req: any) => {
          calls.push(req);
          throw new Error("WorkSession transport unavailable");
        },
        handleProposalDocFormatting: async () => ({ kind: "formatted" }),
        requestProposalDocClarification: async () => ({ ok: true }),
        syncProposalDocApprovalCycle: async () => ({ kind: "no_cycle" }),
      }),
  };

  let replyAttempts = 0;
  const operationsAlerts: any[] = [];
  const originalFetch = globalThis.fetch;
  const inner = mockFetchWith({
    comments: [{ id: "c-esc-2", content: "tighten the budget", resolved: false, author: { me: true }, quotedFileContent: { value: "Budget" } }],
    onTelegram: (body) => operationsAlerts.push(body),
  });
  // The reply endpoint's own network call fails -- the failure of the
  // best-effort answer must not replace the original evidence. The attempt
  // is counted here (the inner mock never sees it).
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).includes("/comments/") && String(url).includes("/replies") && init?.method === "POST") {
      replyAttempts += 1;
      throw new Error("reply network down");
    }
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  const diag = result.diagnostics.find((d) => d.commentId === "c-esc-2");
  assert.strictEqual(diag?.outcome, "unhandled_exception", "the original failure evidence survives the failed reply attempt");
  assert.ok(diag?.detail?.includes("WorkSession transport unavailable"), "with the original error intact");
  assert.strictEqual(replyAttempts, 1, "the reply was attempted exactly once (and its failure is swallowed, never re-run)");
  assert.ok(operationsAlerts.length >= 1, "the Operations notification still went out");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-esc-2"), "1", "the marker is kept");
  assert.strictEqual(calls.length, 1, "the handler is never entered a second time");
});

test("escape 3. a SUCCESSFUL revision followed by a failure in the confirmation reply is answered with the interruption's true uncertainty -- the reply never states the revision was not applied", async (t) => {
  const { fakeEnv } = createFakeEnv();
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  // The handler SUCCEEDS this time (v2 is created through the governed
  // path); the failure comes LATER, while the pass is delivering the
  // "Change recorded" confirmation -- exactly the case where "not applied"
  // would have been a lie.
  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 });

  let reply: any = null;
  let replies = 0;
  let replyAttempts = 0;
  let resolved = false;
  const operationsAlerts: any[] = [];
  const originalFetch = globalThis.fetch;
  const inner = mockFetchWith({
    comments: [{ id: "c-esc-3", content: "add a delivery-risk paragraph", resolved: false, author: { me: true }, quotedFileContent: { value: "Scope" } }],
    onReply: (_id, body) => {
      replies += 1;
      reply = body;
    },
    onResolve: () => (resolved = true),
    onTelegram: (body) => operationsAlerts.push(body),
  });
  // The FIRST reply POST (the success confirmation) fails at the network
  // level; the escape answer's own reply (attempt 2) goes through.
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).includes("/comments/") && String(url).includes("/replies") && init?.method === "POST") {
      replyAttempts += 1;
      if (replyAttempts === 1) throw new Error("confirmation reply network down");
    }
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(replyAttempts, 2, "the failure happened AFTER the successful revision, in the confirmation reply; the second attempt is the escape answer");
  assert.strictEqual(replies, 1, "exactly one reply was delivered -- the escape answer");
  assert.strictEqual(calls.length, 1, "the handler ran exactly once -- the successful revision was never re-entered");
  assert.strictEqual(result.diagnostics.find((d) => d.commentId === "c-esc-3")?.outcome, "unhandled_exception", "the interruption is preserved as its own diagnostic");

  assert.ok(reply, "the thread was still answered");
  assert.match(reply.content, /could not be confirmed/, "the outcome is stated honestly as unconfirmed");
  assert.ok(!/Not applied/i.test(reply.content), "the reply never states the revision was not applied -- it may well exist");
  assert.ok(!/change recorded|was created from this comment/i.test(reply.content), "and it does not claim a success it cannot confirm either");
  assert.ok(!/Martin has been notified/i.test(reply.content), "and it makes no notification claim");
  assert.strictEqual(resolved, false, "the comment stays open -- Martin's resolve remains the approval signal");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-esc-3"), "1", "the processed marker is kept");
  assert.ok(operationsAlerts.length >= 1, "Operations is notified that the outcome is unconfirmed (identifiers only)");
  assert.ok(!JSON.stringify(operationsAlerts).includes("delivery-risk"), "no comment content reaches the Operations stream");
});

test("escape 4. when the Operations notification itself fails, the thread is still answered -- and the reply never claims Martin was notified", async (t) => {
  const { fakeEnv } = createFakeEnv();
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  const calls: any[] = [];
  await setUpProposalDoc(fakeEnv, calls, { kind: "revised", newVersion: 2 });
  // The handler itself escapes (as in escape 1) so the pass reaches the
  // escape answer -- and then that answer's own notification fails.
  (fakeEnv as any).WORK_SESSION = {
    idFromName: (name: string) => name,
    get: () =>
      salesOperationStub({
        handleProposalDocComment: async (req: any) => {
          calls.push(req);
          throw new Error("WorkSession transport unavailable");
        },
        handleProposalDocFormatting: async () => ({ kind: "formatted" }),
        requestProposalDocClarification: async () => ({ ok: true }),
        syncProposalDocApprovalCycle: async () => ({ kind: "no_cycle" }),
      }),
  };

  let reply: any = null;
  let telegramFailures = 0;
  const originalFetch = globalThis.fetch;
  const inner = mockFetchWith({
    comments: [{ id: "c-esc-4", content: "tighten the budget", resolved: false, author: { me: true }, quotedFileContent: { value: "Budget" } }],
    onReply: (_id, body) => (reply = body),
  });
  // The notification's own send fails; the reply attempt must survive it,
  // and the reply must not paper over the failure with a delivery claim.
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).includes("api.telegram.org")) {
      telegramFailures += 1;
      throw new Error("telegram down");
    }
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.ok(telegramFailures >= 1, "the notification send genuinely failed");
  assert.strictEqual(result.diagnostics.find((d) => d.commentId === "c-esc-4")?.outcome, "unhandled_exception", "the original failure evidence survives the notification failure");
  assert.ok(reply, "the thread is still answered despite the failed notification");
  assert.match(reply.content, /could not be confirmed/, "with the honest uncertainty");
  assert.ok(!/Martin has been notified/i.test(reply.content), "crucially: with the notification failed, the reply still never claims Martin was notified");
  assert.ok(!/Not applied/i.test(reply.content), "and it still never claims the request was not applied");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-esc-4"), "1", "the processed marker is kept");
  assert.strictEqual(calls.length, 1, "the handler is never entered a second time");
});
