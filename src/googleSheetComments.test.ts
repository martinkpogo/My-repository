import test from "node:test";
import assert from "node:assert";
import type { Env } from "./types";
import { persistGoogleTokens, registerWatchedGoogleSheet } from "./googleOAuth";
import { pollGoogleSheetComments } from "./googleSheetComments";

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

// Default AI mock: parses the "change to ..." instruction out of the user
// message and echoes back a plausible replacement, same convention as
// googleDocComments.test.ts.
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

const SHEET_ID = "watched-sheet-1";
const OWNER_EMAIL = "owner@enig.com";
const VALUES_URL = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:ZZ10000`;

async function setUpWatchedSheet(fakeEnv: Env) {
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "tok-1", refresh_token: "refresh-1", expires_in: 3600 },
    OWNER_EMAIL,
  );
  await registerWatchedGoogleSheet(fakeEnv, {
    spreadsheetId: SHEET_ID,
    accountIdentifier: OWNER_EMAIL,
    title: "Watched Test Sheet",
    chatId: 123456789,
    threadId: 604,
    createdAt: new Date().toISOString(),
  });
}

function driveCommentsUrl(sheetId: string) {
  return `https://www.googleapis.com/drive/v3/files/${sheetId}/comments`;
}

function mockFetchWith(handlers: {
  values?: string[][];
  comments?: any[];
  onReply?: (commentId: string, body: any) => void;
  onResolve?: (commentId: string) => void;
  onCellUpdate?: (range: string, body: any) => boolean;
}) {
  return (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.startsWith("https://api.notion.com/")) {
      return new Response(JSON.stringify({ id: "notion-page-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.startsWith("https://api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (urlStr.startsWith(driveCommentsUrl(SHEET_ID)) && (!init || init.method === undefined || init.method === "GET")) {
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

    if (urlStr === VALUES_URL && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify({ values: handlers.values ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/`) && init?.method === "PUT") {
      const range = urlStr.split("/values/")[1].split("?")[0];
      const ok = handlers.onCellUpdate ? handlers.onCellUpdate(range, JSON.parse(String(init.body))) : true;
      return new Response(JSON.stringify({ updatedRange: range }), {
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

test("pollGoogleSheetComments does nothing when no sheets are watched", async () => {
  const { fakeEnv } = createFakeEnv();
  const result = await pollGoogleSheetComments(fakeEnv);
  assert.strictEqual(result.sheetsChecked, 0);
  assert.strictEqual(result.commentsProcessed, 0);
});

test("applies a comment-anchored cell edit from the sheet's own authorized account, replies, and resolves it", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  let repliedCommentId: string | null = null;
  let repliedBody: any = null;
  let resolvedCommentId: string | null = null;
  let updatedRange: string | null = null;
  let updatedBody: any = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [
      ["Date", "Content Piece", "Status"],
      ["2026-10-01", "Launch post", "Planned"],
    ],
    comments: [
      {
        id: "comment-1",
        content: 'change to "Published"',
        resolved: false,
        author: { me: true, displayName: "Owner" },
        quotedFileContent: { value: "Planned" },
      },
    ],
    onReply: (id, body) => {
      repliedCommentId = id;
      repliedBody = body;
    },
    onResolve: (id) => {
      resolvedCommentId = id;
    },
    onCellUpdate: (range, body) => {
      updatedRange = range;
      updatedBody = body;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(result.sheetsChecked, 1);
  assert.strictEqual(result.commentsProcessed, 1);
  assert.strictEqual(repliedCommentId, "comment-1");
  assert.ok(repliedBody.content.includes("Published"));
  assert.strictEqual(resolvedCommentId, "comment-1");
  // "Planned" is at row index 1, col index 2 -> C2
  assert.strictEqual(updatedRange, "C2");
  assert.deepStrictEqual(updatedBody.values, [["Published"]]);

  const processedMarker = await fakeEnv.STATE_KV.get("google_comment_processed:comment-1");
  assert.strictEqual(processedMarker, "1");
});

test("ignores a comment from anyone other than the sheet's own authorized account -- never executes or replies", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  let replied = false;
  let updated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    comments: [
      {
        id: "comment-2",
        content: 'change to "Published"',
        resolved: false,
        author: { me: false, displayName: "Someone Else" },
        quotedFileContent: { value: "Planned" },
      },
    ],
    onReply: () => {
      replied = true;
    },
    onCellUpdate: () => {
      updated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(replied, false, "must never reply to a comment from an unauthorized identity");
  assert.strictEqual(updated, false, "must never execute an edit requested by an unauthorized identity");
  assert.strictEqual(result.commentsProcessed, 0);

  const processedMarker = await fakeEnv.STATE_KV.get("google_comment_processed:comment-2");
  assert.strictEqual(processedMarker, "1", "still marked processed so it isn't re-checked forever");
});

test("asks for clarification when the comment has no anchored cell, without guessing a target", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  let repliedBody: any = null;
  let updated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    comments: [
      {
        id: "comment-3",
        content: "please fix the status column",
        resolved: false,
        author: { me: true },
        // no quotedFileContent -- a general, unanchored comment
      },
    ],
    onReply: (_id, body) => {
      repliedBody = body;
    },
    onCellUpdate: () => {
      updated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(updated, false);
  assert.ok(repliedBody.content.toLowerCase().includes("select"));
});

test("fails closed and asks for a unique cell when the anchored value appears more than once", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  let repliedBody: any = null;
  let updated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [
      ["Status", "Other"],
      ["Planned", "Planned"],
    ],
    comments: [
      {
        id: "comment-4",
        content: 'change to "Published"',
        resolved: false,
        author: { me: true },
        quotedFileContent: { value: "Planned" },
      },
    ],
    onReply: (_id, body) => {
      repliedBody = body;
    },
    onCellUpdate: () => {
      updated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(updated, false, "must never guess which cell to replace");
  assert.ok(repliedBody.content.includes("2 cells"));
});

test("asks for clarification when the AI cannot determine a specific replacement", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);
  fakeEnv.AI = {
    run: async () => ({ response: JSON.stringify({ understood: false }) }),
  } as unknown as Ai;

  let repliedBody: any = null;
  let updated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    comments: [
      {
        id: "comment-5",
        content: "hmm not sure about this",
        resolved: false,
        author: { me: true },
        quotedFileContent: { value: "Planned" },
      },
    ],
    onReply: (_id, body) => {
      repliedBody = body;
    },
    onCellUpdate: () => {
      updated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(updated, false);
  assert.ok(repliedBody.content.toLowerCase().includes("clarify"));
});

test("skips an already-resolved comment without replying or editing", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  let replied = false;
  let updated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    comments: [
      {
        id: "comment-6",
        content: 'change to "Published"',
        resolved: true,
        author: { me: true },
        quotedFileContent: { value: "Planned" },
      },
    ],
    onReply: () => {
      replied = true;
    },
    onCellUpdate: () => {
      updated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(replied, false);
  assert.strictEqual(updated, false);
  assert.strictEqual(result.commentsProcessed, 0);
});

test("a comment already marked processed is never re-executed on a later poll", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);
  await fakeEnv.STATE_KV.put("google_comment_processed:comment-7", "1");

  let updated = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    comments: [
      {
        id: "comment-7",
        content: 'change to "Published"',
        resolved: false,
        author: { me: true },
        quotedFileContent: { value: "Planned" },
      },
    ],
    onCellUpdate: () => {
      updated = true;
      return true;
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(updated, false);
  assert.strictEqual(result.commentsProcessed, 0);
});
