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

function mockFetchWith(handlers: {
  docText?: string;
  comments?: any[];
  onReply?: (commentId: string, body: any) => void;
  onResolve?: (commentId: string) => void;
  onBatchUpdate?: (body: any) => boolean;
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
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (urlStr.startsWith(driveCommentsUrl(DOC_ID)) && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify({ comments: handlers.comments ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr.includes(`/comments/`) && urlStr.includes("/replies") && init?.method === "POST") {
      const commentId = urlStr.split("/comments/")[1].split("/replies")[0];
      handlers.onReply?.(commentId, JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "reply-1" }), { status: 200, headers: { "content-type": "application/json" } });
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

test("applies a comment-anchored edit from the doc's own authorized account, replies, and resolves it", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedDoc(fakeEnv);

  let repliedCommentId: string | null = null;
  let repliedBody: any = null;
  let resolvedCommentId: string | null = null;
  let batchUpdateBody: any = null;

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
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);

  assert.strictEqual(result.docsChecked, 1);
  assert.strictEqual(result.commentsProcessed, 1);
  assert.strictEqual(repliedCommentId, "comment-1");
  assert.ok(repliedBody.content.includes("Monday"));
  assert.strictEqual(resolvedCommentId, "comment-1");
  assert.strictEqual(batchUpdateBody.requests[0].replaceAllText.containsText.text, "Friday");
  assert.strictEqual(batchUpdateBody.requests[0].replaceAllText.replaceText, "Monday");

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
