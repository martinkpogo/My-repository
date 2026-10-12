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

/** One page of a paginated `comments.list` response, as a test would script it. */
export interface ScriptedCommentsPage {
  comments?: any[];
  /** The token the NEXT request must send to continue, if any. */
  nextPageToken?: string;
  /** Non-200 status, to script a page that fails. */
  status?: number;
}

function mockFetchWith(handlers: {
  values?: string[][];
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
  onCellUpdate?: (range: string, body: any) => boolean;
  onTelegram?: (body: any) => void;
}) {
  return (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.startsWith("https://api.notion.com/")) {
      return new Response(JSON.stringify({ id: "notion-page-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.startsWith("https://api.telegram.org/")) {
      handlers.onTelegram?.(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (urlStr.startsWith(driveCommentsUrl(SHEET_ID)) && (!init || init.method === undefined || (init?.method ?? "GET") === "GET")) {
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

    if (urlStr === VALUES_URL && (!init || init.method === undefined || (init?.method ?? "GET") === "GET")) {
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

test("refuses a comment-anchored cell edit from the sheet's own authorized account -- no authorization path exists, so nothing is written and the refusal is reported", async (t) => {
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
  assert.strictEqual(result.commentsProcessed, 1, "the comment is handled -- marked processed so the same request is never re-attempted on every poll");
  assert.strictEqual(repliedCommentId, "comment-1");
  assert.ok(
    repliedBody.content.includes("not an authorized operation"),
    `the refusal must state the missing authorization honestly, got: ${repliedBody?.content}`,
  );
  assert.ok(repliedBody.content.includes("nothing in this spreadsheet was changed"), "the refusal must state that nothing changed");
  assert.strictEqual(resolvedCommentId, null, "an edit that was not applied is never resolved");
  assert.strictEqual(updatedRange, null, "no cell may be written outside the governed external-effect boundary");
  assert.strictEqual(updatedBody, null, "no cell value may be sent");
  assert.strictEqual(result.diagnostics.at(-1)!.outcome, "edit_not_authorized");

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

// ---------------------------------------------------------------------------
// Pagination: comments.list returns at most pageSize (100) comments per call,
// so the fetcher must follow nextPageToken and accumulate. Before this fix a
// single request silently discarded every comment after the first 100.
// ---------------------------------------------------------------------------

/** A live (unresolved, authorized, unique-anchor) sheet comment requesting a cell change. */
function liveComment(id: string, quoted = "Planned") {
  return { id, content: 'change to "Published"', resolved: false, author: { me: true }, quotedFileContent: { value: quoted } };
}

test("pagination 1. a single-page response is unchanged: one request, no pageToken ever sent, all comments returned", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  const requested: (string | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    comments: [liveComment("c-single-1"), liveComment("c-single-2")],
    onCommentsList: (pageToken) => requested.push(pageToken),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.deepStrictEqual(requested, [undefined], "exactly one request, and it carries no pageToken");
  assert.strictEqual(result.commentsProcessed, 2, "both comments are processed");
  const fetched = result.diagnostics.find((d) => d.outcome === "comments_fetched");
  assert.strictEqual(fetched?.detail, "2 comment(s) found");
});

test("pagination 2. at least 150 comments spread over multiple pages are ALL retrieved and processed", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  // 150 comments across 3 pages: 100 + 50, the final page carrying no token.
  // All but the very last are already resolved, so they exercise the cheap
  // existing rule (resolved -> skip + mark processed) rather than 149 AI
  // calls; the last is a live request and must be genuinely processed.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}`, content: "x", resolved: true, author: { me: true } }));
  const page2 = Array.from({ length: 50 }, (_, i) => ({ id: `c-${100 + i}`, content: "x", resolved: i < 49, author: { me: true } }));
  const live = liveComment("c-149");

  const requested: (string | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    commentPages: (pageToken) => {
      requested.push(pageToken);
      if (pageToken === undefined) return { comments: page1, nextPageToken: "tok-page-2" };
      if (pageToken === "tok-page-2") return { comments: [...page2.slice(0, 49), live] };
      throw new Error(`unexpected pageToken ${pageToken}`);
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.deepStrictEqual(requested, [undefined, "tok-page-2"], "the returned token is followed exactly once");
  assert.strictEqual(result.commentsProcessed, 1, "only the one live comment is a handled request");
  assert.strictEqual(result.diagnostics.filter((d) => d.outcome === "comments_fetched").length, 1);
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "150 comment(s) found", "all 150 comments, not the first 100");
  // Every one of the 149 resolved comments was processed under the existing
  // rule (skipped AND marked), and the live one was refused as usual.
  assert.strictEqual(result.diagnostics.filter((d) => d.outcome === "resolved_skip").length, 149);
  assert.strictEqual(result.diagnostics.filter((d) => d.outcome === "edit_not_authorized").length, 1);
  assert.ok(result.diagnostics.some((d) => d.commentId === "c-149" && d.outcome === "edit_not_authorized"), "a comment on the LAST page is genuinely processed");
  // The marker written by that deep-page comment proves it really ran.
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-149"), "1");
});

test("pagination 3. the follow-up request sends the returned pageToken and preserves fields, pageSize and includeDeleted", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

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

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(urls.length, 2, "two requests: the first page, then the continuation");
  const [first, second] = urls.map((u) => new URL(u));

  for (const u of [first, second]) {
    assert.strictEqual(u.searchParams.get("pageSize"), "100", "pageSize=100 preserved on every request");
    assert.strictEqual(u.searchParams.get("includeDeleted"), "false", "includeDeleted=false preserved on every request");
    assert.ok(
      u.searchParams.get("fields") === "comments(id,content,resolved,author(displayName,me),quotedFileContent(value))",
      `the Sheets fields projection is preserved verbatim: ${u.searchParams.get("fields")}`,
    );
  }
  assert.strictEqual(first.searchParams.get("pageToken"), null, "the first request carries no pageToken");
  assert.strictEqual(second.searchParams.get("pageToken"), "tok/with+specials=&?", "the returned token is sent back, correctly URL-encoded");
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "2 comment(s) found", "both pages accumulated");
});

test("pagination 4. an empty result and an absent nextPageToken both terminate normally", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

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

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(calls, 1, "no nextPageToken means done -- never a second request");
  assert.strictEqual(result.commentsProcessed, 0);
  assert.strictEqual(result.diagnostics.find((d) => d.outcome === "comments_fetched")?.detail, "0 comment(s) found");
  assert.ok(!result.diagnostics.some((d) => d.outcome === "comments_list_failed"), "a genuinely empty result is not a failure");
});

test("pagination 5. a failure on a LATER page rejects the whole fetch -- earlier-page comments are never processed as if the result were complete", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

  let replies = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    values: [["Status"], ["Planned"]],
    commentPages: (pageToken) => {
      if (pageToken === undefined) {
        return {
          comments: [liveComment("c-page1-a"), liveComment("c-page1-b")],
          nextPageToken: "tok-page-2",
        };
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

  const result = await pollGoogleSheetComments(fakeEnv);

  const failed = result.diagnostics.find((d) => d.outcome === "comments_list_failed");
  assert.ok(failed, `a later-page failure is reported: ${JSON.stringify(result.diagnostics.map((d) => d.outcome))}`);
  assert.match(failed!.detail ?? "", /HTTP 500/);
  assert.strictEqual(result.commentsProcessed, 0, "nothing was processed");
  assert.strictEqual(replies, 0, "no reply was sent for the comments from the completed first page");
  assert.strictEqual(result.diagnostics.filter((d) => d.commentId !== null).length, 0, "no per-comment diagnostic at all");
  const markerKeys = [...mockKv._rawStore.keys()].filter((k) => k.startsWith("google_comment_processed:"));
  assert.deepStrictEqual(markerKeys, [], "and no dedup marker was written, so a later poll retries the whole document safely");
});

test("pagination 6. a repeated page token terminates safely instead of looping forever", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

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

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.ok(requests <= 3, `pagination terminates promptly rather than looping (made ${requests} requests)`);
  assert.ok(result.diagnostics.some((d) => d.outcome === "comments_list_failed"), "the ambiguous fetch is refused, not treated as complete");
  assert.strictEqual(result.commentsProcessed, 0);
});

test("pagination 7. an INVALID continuation token (HTTP 400) is a failure, and the dedup markers from earlier polls stay intact", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);
  // An unrelated, pre-existing marker from an earlier poll must survive.
  await fakeEnv.STATE_KV.put("google_comment_processed:c-earlier-poll", "1");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    commentPages: (pageToken) =>
      pageToken === undefined
        ? { comments: [liveComment("c-bad")], nextPageToken: "not-a-real-token" }
        : { status: 400, comments: [] },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.ok(result.diagnostics.some((d) => d.outcome === "comments_list_failed"), "an invalid token fails the fetch");
  assert.match(result.diagnostics.find((d) => d.outcome === "comments_list_failed")!.detail ?? "", /HTTP 400/);
  assert.strictEqual(result.commentsProcessed, 0);
  assert.strictEqual([...mockKv._rawStore.keys()].filter((k) => k.startsWith("google_comment_processed:")).length, 1, "no new marker was written for a rejected fetch");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-earlier-poll"), "1", "and the pre-existing marker is untouched");
});

// ---------------------------------------------------------------------------
// Marker ordering on the Sheets path: the processed marker is persisted BEFORE
// the reply is attempted, exactly as on the non-Proposal Doc branches, so a
// reply that fails can never leave the comment unmarked (which would re-reply
// on the next poll). A rejected reply keeps the marker and is reported to
// Operations with NO comment content. Sheets marker failures are typed with
// the same CommentMarkerPersistenceError googleDocComments.ts uses.
// ---------------------------------------------------------------------------

/** Mirrors the Doc test file's helper: makes a KV prefix's writes throw, to script a marker that cannot be persisted. */
function failKvWritesFor(fakeEnv: Env, failingPrefix: string) {
  const kv = fakeEnv.STATE_KV as any;
  const originalPut = kv.put.bind(kv);
  kv.put = async (key: string, value: string, options?: any) => {
    if (key.startsWith(failingPrefix)) throw new Error("KV put() limit exceeded for the day.");
    return originalPut(key, value, options);
  };
}

test("marker 1. a Sheet persists the processed marker BEFORE calling the reply endpoint", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);

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
    comments: [{ id: "c-order-1", content: "fix the cell", resolved: false, author: { me: true } }],
    onReply: () => order.push("reply"),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await pollGoogleSheetComments(fakeEnv);

  assert.deepStrictEqual(order, ["marker:google_comment_processed:c-order-1", "reply"], "the marker is durably written before the reply endpoint is called");
});

test("marker 2. when a Sheet's marker cannot be persisted, the reply is never attempted and the comment stays unprocessed", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);
  failKvWritesFor(fakeEnv, "google_comment_processed:");

  let replies = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    comments: [{ id: "c-order-2", content: "fix the cell", resolved: false, author: { me: true } }],
    onReply: () => (replies += 1),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.strictEqual(replies, 0, "no reply is attempted when the marker that guards it did not persist");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-order-2"), null, "the comment stays unprocessed, so nothing is lost");
  assert.strictEqual(result.diagnostics.find((d: any) => d.commentId === "c-order-2")?.outcome, "persistence_unavailable", "recorded as its own truthful outcome, same contract as Docs");
});

test("marker 3. a REJECTED reply on a Sheet keeps the marker, is reported to Operations, and never claims success", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);
  // Enable the Operations stream so sendOperationsMessage actually dispatches
  // (getOperationsTarget needs both TELEGRAM_GROUP_CHAT_ID and OPERATIONS_TOPIC_ID).
  (fakeEnv as any).OPERATIONS_TOPIC_ID = "2";

  let replyBody: any = null;
  const operationsAlerts: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchWith({
    // no quotedFileContent -> the no_anchor branch replies.
    comments: [{ id: "c-reject-1", content: "SECRET-COMMENT-WORD please fix the cell", resolved: false, author: { me: true } }],
    replyStatus: 403, // provider rejects the reply
    onReply: (_id, body) => (replyBody = body),
    onTelegram: (body) => operationsAlerts.push(body),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleSheetComments(fakeEnv);

  assert.ok(replyBody, "the reply WAS attempted");
  assert.strictEqual(replyBody.content.toLowerCase().includes("cell"), true, "the intended reply text was what we tried to send");
  assert.strictEqual(await fakeEnv.STATE_KV.get("google_comment_processed:c-reject-1"), "1", "the marker is kept even though the reply failed -- it is never cleared");
  assert.strictEqual(result.diagnostics.find((d: any) => d.commentId === "c-reject-1")?.outcome, "no_anchor", "the comment is still recorded as processed");

  assert.ok(operationsAlerts.length >= 1, "the rejected reply is reported through the Operations stream");
  const alert = JSON.stringify(operationsAlerts);
  assert.ok(alert.includes(SHEET_ID), "the alert names the affected spreadsheet");
  assert.ok(alert.includes("c-reject-1"), "the alert names the affected comment");
  assert.ok(/HTTP\s+403/.test(alert), "the alert carries the failure category (HTTP 403)");
});

test("marker 4. the Operations alert for a rejected Sheet reply contains NO comment or reply content", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpWatchedSheet(fakeEnv);
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

  await pollGoogleSheetComments(fakeEnv);

  assert.ok(operationsAlerts.length >= 1, "an alert was sent");
  const alert = JSON.stringify(operationsAlerts);
  assert.ok(!alert.includes("TOPSECRET-COMMENT-PAYLOAD"), "the comment's text never reaches the Operations stream");
  assert.ok(!alert.toLowerCase().includes("figure"), "nor any other fragment of the comment");
});
