import test from "node:test";
import assert from "node:assert";
import type { Env } from "./types";
import {
  buildGoogleAuthorizeUrl,
  cleanupDefaultGoogleAccount,
  codeChallengeFromVerifier,
  columnLetter,
  createGoogleDoc,
  createGoogleSheet,
  generateCodeVerifier,
  generateState,
  getValidGoogleAccessToken,
  GOOGLE_OAUTH_SCOPES,
  GoogleDocCreationCapability,
  GoogleSheetCreationCapability,
  handleGoogleAccountSelection,
  handleGoogleFolderSelection,
  handleGoogleOAuthCallback,
  handleGoogleOAuthStart,
  listAuthorizedGoogleAccounts,
  listWatchedGoogleDocs,
  listWatchedGoogleSheets,
  loadGoogleTokens,
  parseAccountIdentifierFromIdToken,
  PendingGoogleAction,
  persistGoogleTokens,
  proposeGoogleDocCreation,
  handleGoogleActionApproval,
  registerWatchedGoogleDoc,
  registerWatchedGoogleSheet,
  rewriteGoogleDoc,
  saveOpaqueOption,
  testGoogleDriveConnection,
  handleGoogleDriveTest,
  peekOpaqueOption,
} from "./googleOAuth";
import { buildProposalDocLayout } from "./proposalRedline";
import { parseCallbackData } from "./telegramCallbackData";
import { buildBrowseCallback, parseBrowseValue, saveBrowseScreen } from "./googleDriveBrowseScreen";
import type { WorkState } from "./types";

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

function createFakeEnv() {
  const mockKv = createMockKv();
  const mockAi = {
    run: async () => ({
      response: JSON.stringify({
        isGoogleDocRequest: true,
        title: "Test doc",
        content: "Sample text content",
      }),
    }),
  };
  const mockWorkSession = {
    idFromName: (name: string) => name,
    get: (_id: any) => ({
      init: async () => {},
      getState: async () => null,
    }),
  };
  const fakeEnv: Env = {
    AI: mockAi as unknown as Ai,
    WORK_SESSION: mockWorkSession as unknown as DurableObjectNamespace,
    STATE_KV: mockKv as unknown as KVNamespace,
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-999",
    WORKER_ADMIN_KEY: "test-admin-key-888",
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

// Helper to construct a dummy JWT id_token for account identification testing
function makeDummyIdToken(email: string, sub = "user-sub-123"): string {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ email, sub, iss: "https://accounts.google.com" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.signature`;
}

test("State and PKCE generation produce cryptographic base64url strings", async () => {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeFromVerifier(verifier);

  assert.ok(state.length >= 16);
  assert.ok(verifier.length >= 32);
  assert.ok(challenge.length > 0);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test("Google Authorize URL construction includes exact required parameters and minimum scopes", () => {
  const { fakeEnv } = createFakeEnv();
  const redirectUri = "https://enig-agent.martnkpogo.workers.dev/oauth/google/callback";
  const state = "test-state-123";
  const challenge = "test-challenge-456";

  const urlStr = buildGoogleAuthorizeUrl(fakeEnv, redirectUri, state, challenge);
  const url = new URL(urlStr);

  assert.strictEqual(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.strictEqual(url.searchParams.get("client_id"), fakeEnv.GOOGLE_OAUTH_CLIENT_ID);
  assert.strictEqual(url.searchParams.get("redirect_uri"), redirectUri);
  assert.strictEqual(url.searchParams.get("response_type"), "code");
  assert.strictEqual(url.searchParams.get("state"), state);
  assert.strictEqual(url.searchParams.get("code_challenge"), challenge);
  assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
  assert.strictEqual(url.searchParams.get("access_type"), "offline");
  assert.strictEqual(url.searchParams.get("include_granted_scopes"), "true");
  assert.strictEqual(url.searchParams.get("prompt"), "consent");

  // Verify exact minimum scopes -- "openid email" is required for Google
  // to return an id_token, which parseAccountIdentifierFromIdToken needs
  // to resolve a real email instead of falling back to "default".
  assert.strictEqual(
    GOOGLE_OAUTH_SCOPES,
    "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets",
  );
  assert.strictEqual(url.searchParams.get("scope"), GOOGLE_OAUTH_SCOPES);
});

test("GET /oauth/google/start requires key parameter matching WORKER_ADMIN_KEY", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })) as typeof fetch;

  try {
    // Missing key parameter -> HTTP 403
    const reqUnauth = new Request("https://enig-agent.martnkpogo.workers.dev/oauth/google/start");
    const resUnauth = await handleGoogleOAuthStart(reqUnauth, fakeEnv);
    assert.strictEqual(resUnauth.status, 403);

    // Wrong key parameter -> HTTP 403
    const reqBadKey = new Request("https://enig-agent.martnkpogo.workers.dev/oauth/google/start?key=wrong-key");
    const resBadKey = await handleGoogleOAuthStart(reqBadKey, fakeEnv);
    assert.strictEqual(resBadKey.status, 403);

    // Valid key parameter -> HTTP 302 Redirect to Google Auth
    const reqAuth = new Request(
      `https://enig-agent.martnkpogo.workers.dev/oauth/google/start?key=${fakeEnv.WORKER_ADMIN_KEY}`,
    );
    const resAuth = await handleGoogleOAuthStart(reqAuth, fakeEnv);
    assert.strictEqual(resAuth.status, 302);

    const location = resAuth.headers.get("Location");
    assert.ok(location);
    assert.ok(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));

    // Verify state stored in KV with 1800s TTL
    const redirectUrlObj = new URL(location);
    const state = redirectUrlObj.searchParams.get("state");
    assert.ok(state);

    const stateEntry = mockKv._rawStore.get(`google_oauth_state:${state}`);
    assert.ok(stateEntry);
    assert.strictEqual(stateEntry.expirationTtl, 1800);
    assert.ok(stateEntry.value.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Account picker lists authorized accounts and uses opaque option IDs in callback buttons", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token1", refresh_token: "refresh1", expires_in: 3600 },
    "account1@enig.com",
  );
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token2", refresh_token: "refresh2", expires_in: 3600 },
    "account2@enig.com",
  );

  const accounts = await listAuthorizedGoogleAccounts(fakeEnv);
  assert.strictEqual(accounts.length, 2);
  assert.ok(accounts.includes("account1@enig.com"));
  assert.ok(accounts.includes("account2@enig.com"));

  let sentButtons: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const handled = await GoogleDocCreationCapability.handleIntake(
      fakeEnv,
      12345,
      "Create a document titled Test doc with this content: Sample text content",
    );

    assert.strictEqual(handled, true);
    assert.ok(sentButtons.length >= 2);

    // Verify callback data contains ONLY opaque option IDs (no email or tokens)
    const callbackData1 = sentButtons[0][0].callback_data;
    assert.match(callbackData1, /^googleaccount:[a-f0-9-]+:[a-f0-9-]+$/);
    assert.strictEqual(callbackData1.includes("account1@enig.com"), false);
    assert.strictEqual(callbackData1.includes("token1"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Folder picker queries drive folders using selected account and uses opaque folder callback IDs", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-account-1", refresh_token: "refresh-account-1", expires_in: 3600 },
    "user@enig.com",
  );

  const workId = "work-picker-100";
  const opaqueOptionId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "account",
    accountIdentifier: "user@enig.com",
    title: "Project Strategy",
    content: "Content of strategy document",
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let rootCalls = 0;
  let listCalls = 0;
  let sentButtons: any[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;

    // (1) My Drive's real root id -- the browser's first Drive call. The
    // mock must answer the ROOT url with { id, name }; answering it with a
    // files list is what the old single mock did and it fails closed here.
    if (urlStr.includes("googleapis.com/drive/v3/files/root")) {
      rootCalls++;
      assert.strictEqual(auth, "Bearer token-account-1", "the root lookup uses the selected account's token");
      return new Response(
        JSON.stringify({ id: "root-id-abc123", name: "My Drive" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // (2) The listing of that root's direct contents.
    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      listCalls++;
      assert.strictEqual(auth, "Bearer token-account-1", "the listing uses the selected account's token");
      // URLSearchParams on the URL gives the DECODED query (a "+" is a space).
      assert.ok(
        new URL(urlStr).searchParams.get("q")?.includes("'root-id-abc123' in parents"),
        `the listing must query the root id returned by (1), got: ${urlStr}`,
      );
      return new Response(
        JSON.stringify({
          files: [
            { id: "folder-id-abc", name: "Client Proposals", mimeType: "application/vnd.google-apps.folder" },
            { id: "folder-id-xyz", name: "Internal Notes", mimeType: "application/vnd.google-apps.folder" },
            { id: "file-id-1", name: "notes.txt", mimeType: "text/plain" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    assert.strictEqual(rootCalls, 1, "exactly one files/root call");
    assert.strictEqual(listCalls, 1, "exactly one listing call");
    assert.strictEqual(sentButtons.length, 4, "one row per item (2 folders + 1 file) plus Save here");

    // Every button carries the browse screen's opaque id plus a short action
    // code -- never a raw Drive id (the binding lives in the stored screen).
    for (const row of sentButtons) {
      const callback = row[0].callback_data as string;
      assert.match(callback, /^googlefolder:work-picker-100:[a-f0-9]{8}:/);
      assert.strictEqual(callback.includes("folder-id-abc"), false);
      assert.strictEqual(callback.includes("root-id-abc123"), false);
    }
    assert.strictEqual(sentButtons[3][0].text, "✅ Save here");

    // The screen itself is staged as ONE record under the id the buttons
    // carry, and peek (not consume) reads it back -- the tap path needs it.
    const screenId = (sentButtons[0][0].callback_data as string).split(":")[2]!;
    const screen = await peekOpaqueOption(fakeEnv, workId, screenId);
    assert.ok(screen, "the browse screen survives until a button is tapped (peek, not consume)");
    assert.strictEqual(screen.kind, "drivebrowse");
    assert.strictEqual(screen.folderId, "root-id-abc123");
    assert.strictEqual(screen.items.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Folder selection sets pending action and emits proposal with approve/reject buttons", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-proposal-200";
  // Stage a browser screen whose context carries the same flow fields the
  // old folderlist option carried (without kind and folders), then tap Save.
  const saved = await saveBrowseScreen(fakeEnv, workId, {
    kind: "drivebrowse",
    folderId: "folder-999",
    folderName: "Brand Assets",
    items: [],
    truncated: false,
    context: { docType: "doc", accountIdentifier: "selected@enig.com", title: "Brand Guidelines", content: "Guidelines for ENIG brand assets." },
  });
  assert.strictEqual(saved.ok, true);
  const screenId = saved.screenId;

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentButtons: any[] = [];
  let sentText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentText = body.text || "";
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Tapping Save on the staged browse screen reaches the same flow the
    // old folderlist option used to reach.
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${screenId}:s`);

    assert.ok(updatedState.pendingGoogleAction);
    assert.strictEqual(updatedState.pendingGoogleAction.title, "Brand Guidelines");
    assert.strictEqual(updatedState.pendingGoogleAction.accountIdentifier, "selected@enig.com");
    assert.strictEqual(updatedState.pendingGoogleAction.folderId, "folder-999");

    assert.match(sentText, /Brand Assets/);
    assert.match(sentText, /selected@enig.com/);
    assert.strictEqual(sentButtons[0][0].callback_data, `googleaction:${workId}:approve`);
    assert.strictEqual(sentButtons[0][1].callback_data, `googleaction:${workId}:reject`);

    assert.ok(updatedState.pendingActionSummary, "must also set the generic pendingActionSummary for /sessions recovery");
    assert.strictEqual(updatedState.pendingActionSummary?.label, "Create Google Doc: Brand Guidelines");
    assert.deepStrictEqual(updatedState.pendingActionSummary?.buttons, sentButtons);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Task 14: an old-style value 'ab12cd34:3' -> 'no longer current', ZERO Drive calls, ZERO storage writes", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "tok", refresh_token: "r", expires_in: 3600 }, "user@enig.com");
  const workId = "work-t14-a";
  const state: WorkState = { workId, chatId: 1, stage: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let driveCalls = 0;
  let sentText = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sentText = body?.text ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (s.includes("googleapis.com/drive/v3/files")) driveCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const writes = countOptionWrites(mockKv, workId);

  try {
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, "ab12cd34:3");
    assert.strictEqual(updatedState, state, "state is unchanged");
    assert.ok(sentText.includes("no longer current"), `expected 'no longer current', got: ${sentText}`);
    assert.strictEqual(driveCalls, 0, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Task 14: an old-style 'ab12cd34:more' -> 'no longer current', ZERO Drive calls", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "tok", refresh_token: "r", expires_in: 3600 }, "user@enig.com");
  const workId = "work-t14-b";
  const state: WorkState = { workId, chatId: 1, stage: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let driveCalls = 0;
  let sentText = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sentText = body?.text ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (s.includes("googleapis.com/drive/v3/files")) driveCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const writes = countOptionWrites(mockKv, workId);

  try {
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, "ab12cd34:more");
    assert.strictEqual(updatedState, state, "state is unchanged");
    assert.ok(sentText.includes("no longer current"), `expected 'no longer current', got: ${sentText}`);
    assert.strictEqual(driveCalls, 0, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Task 14: a staged 'folderlist' option + a tap '<itsId>:0' -> 'no longer current'; option not used, pendingGoogleAction unset", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "tok", refresh_token: "r", expires_in: 3600 }, "user@enig.com");
  const workId = "work-t14-c";
  const state: WorkState = { workId, chatId: 1, stage: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let driveCalls = 0;
  let sentText = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sentText = body?.text ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (s.includes("googleapis.com/drive/v3/files")) driveCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  // Stage an old-style folderlist option directly (the dead path's input).
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "user@enig.com",
    title: "Old Picker",
    content: "Body",
    folders: [{ id: "folder-old", name: "Old Folder" }],
  });
  const writes = countOptionWrites(mockKv, workId);

  try {
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`);
    assert.strictEqual(updatedState, state, "state is unchanged");
    assert.ok(sentText.includes("no longer current"), `expected 'no longer current', got: ${sentText}`);
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "pendingGoogleAction stays unset");
    assert.strictEqual(driveCalls, 0, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
    // The folderlist option is NOT consumed/used by the dead path.
    assert.strictEqual(mockKv._rawStore.get(`google_option:${workId}:${listOpaqueId}`) !== undefined, true, "folderlist option still present");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposeGoogleDocCreation and handleGoogleActionApproval enforce state-bound parameter immutability", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  let sentTelegramText = "";
  let sentButtons: any[] = [];
  let filesCreateCallCount = 0;

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    // Telegram sendMessage mock
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }

    // Drive files.create mock
    if (urlStr === "https://www.googleapis.com/drive/v3/files") {
      filesCreateCallCount++;
      return new Response(JSON.stringify({ id: "doc-id-state-bound-100" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Docs batchUpdate mock
    if (urlStr.endsWith(":batchUpdate")) {
      return new Response(JSON.stringify({ documentId: "doc-id-state-bound-100" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Docs get mock
    if (urlStr === "https://docs.googleapis.com/v1/documents/doc-id-state-bound-100") {
      return new Response(
        JSON.stringify({
          title: "Approved Strategy Doc",
          body: {
            content: [{ paragraph: { elements: [{ textRun: { content: "Confidential Strategy Content" } }] } }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "doc-access-token-bound",
      refresh_token: "doc-refresh-token-bound",
      expires_in: 3600,
    },
    "owner@enig.com",
  );

  const state: WorkState = {
    workId: "work-123",
    chatId: 987654321,
    unit: "Operations",
    hat: "Operations Lead",
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    // 1. Propose action
    await proposeGoogleDocCreation(fakeEnv, state, {
      title: "Approved Strategy Doc",
      content: "Confidential Strategy Content",
      folderId: "folder-immutable-1",
      accountIdentifier: "owner@enig.com",
    });

    assert.ok(state.pendingGoogleAction);
    assert.strictEqual(state.pendingGoogleAction.title, "Approved Strategy Doc");
    assert.strictEqual(state.pendingGoogleAction.folderId, "folder-immutable-1");

    // Telegram button callback data contains ONLY workId and action type (no parameters)
    assert.ok(sentButtons.length > 0);
    assert.strictEqual(sentButtons[0][0].callback_data, "googleaction:work-123:approve");
    assert.strictEqual(sentButtons[0][1].callback_data, "googleaction:work-123:reject");

    // 2. Execute approval callback
    const updatedState = await handleGoogleActionApproval(fakeEnv, state, true);

    // State pending action cleared after execution
    assert.strictEqual(updatedState.pendingGoogleAction, undefined);
    assert.strictEqual(updatedState.pendingActionSummary, undefined);
    assert.strictEqual(updatedState.stage, "complete", "a resolved Google action must be marked terminal, not linger as '(new)' in /sessions forever");
    assert.match(sentTelegramText, /Google Doc created and verified successfully/);
    assert.strictEqual(filesCreateCallCount, 1);

    // 3. A stale/resurfaced tap on the same, already-resolved work item
    // (e.g. via /sessions) must not create a second Doc.
    const staleState = await handleGoogleActionApproval(fakeEnv, updatedState, true);
    assert.strictEqual(filesCreateCallCount, 1, "a stale approval tap must not execute the action a second time");
    assert.match(sentTelegramText, /No valid pending Google action/);
    assert.strictEqual(staleState.pendingActionSummary, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleGoogleActionApproval fails closed when no pending action exists", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  let sentTelegramText = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const state: WorkState = {
    workId: "work-empty-999",
    chatId: 987654321,
    unit: "Operations",
    hat: "Operations Lead",
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingGoogleAction: undefined, // No action pending
  };

  try {
    const resState = await handleGoogleActionApproval(fakeEnv, state, true);
    assert.strictEqual(resState.pendingGoogleAction, undefined);
    assert.match(sentTelegramText, /No valid pending Google action found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGoogleDoc validates action parameters and fails closed on missing input", async () => {
  const { fakeEnv } = createFakeEnv();

  // Missing title
  const invalidAction = {
    type: "create_doc",
    title: "",
    content: "Sample text content",
    folderId: "folder-123",
    accountIdentifier: "admin@enig.com",
  } as PendingGoogleAction;

  const res = await createGoogleDoc(fakeEnv, invalidAction);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stage, "validation");
  assert.strictEqual(res.error, "Missing or invalid Google Doc creation parameters");
});

test("createGoogleDoc fails closed when authorization is missing", async () => {
  const { fakeEnv } = createFakeEnv();

  const action: PendingGoogleAction = {
    type: "create_doc",
    title: "Test Proposal Doc",
    content: "Content of proposal",
    folderId: "folder-456",
    accountIdentifier: "unauthorized@enig.com",
  };

  const res = await createGoogleDoc(fakeEnv, action);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stage, "auth");
  assert.strictEqual(res.error, "Google Workspace authorization missing or invalid");
});

test("createGoogleDoc executes 3-stage creation pipeline and verifies title and content", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "doc-access-token-001",
      refresh_token: "doc-refresh-token-001",
      expires_in: 3600,
    },
    "doc-creator@enig.com",
  );

  let driveCreated = false;
  let docBatchUpdated = false;
  let docVerified = false;

  const docTitle = "Client Proposal - ACME Corp";
  const docContent = "Detailed scope of works for ACME Corp.";
  const folderId = "target-folder-777";
  const createdDocId = "new-doc-id-999";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    // Stage 1: Drive files.create
    if (urlStr === "https://www.googleapis.com/drive/v3/files") {
      driveCreated = true;
      assert.strictEqual(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.strictEqual(body.name, docTitle);
      assert.strictEqual(body.mimeType, "application/vnd.google-apps.document");
      assert.deepStrictEqual(body.parents, [folderId]);

      return new Response(JSON.stringify({ id: createdDocId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Stage 2: Docs batchUpdate
    if (urlStr === `https://docs.googleapis.com/v1/documents/${createdDocId}:batchUpdate`) {
      docBatchUpdated = true;
      assert.strictEqual(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.strictEqual(body.requests[0].insertText.text, docContent);

      return new Response(JSON.stringify({ documentId: createdDocId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Stage 3: Docs get verification
    if (urlStr === `https://docs.googleapis.com/v1/documents/${createdDocId}`) {
      docVerified = true;
      assert.strictEqual(init?.method, "GET");

      return new Response(
        JSON.stringify({
          title: docTitle,
          body: {
            content: [
              {
                paragraph: {
                  elements: [
                    {
                      textRun: {
                        content: docContent,
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const action: PendingGoogleAction = {
      type: "create_doc",
      title: docTitle,
      content: docContent,
      folderId,
      accountIdentifier: "doc-creator@enig.com",
    };

    const res = await createGoogleDoc(fakeEnv, action);

    assert.strictEqual(driveCreated, true);
    assert.strictEqual(docBatchUpdated, true);
    assert.strictEqual(docVerified, true);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.documentId, createdDocId);
    assert.strictEqual(res.documentUrl, `https://docs.google.com/document/d/${createdDocId}/edit`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGoogleDoc fails closed when creation, insertion, or verification stage fails", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "doc-access-token-002",
      refresh_token: "doc-refresh-token-002",
      expires_in: 3600,
    },
    "doc-creator-2@enig.com",
  );

  const action: PendingGoogleAction = {
    type: "create_doc",
    title: "Test Doc Failure",
    content: "Some content",
    folderId: "folder-id-888",
    accountIdentifier: "doc-creator-2@enig.com",
  };

  // 1. Creation failure (HTTP 403 from Drive)
  globalThis.fetch = (async (url: string) => {
    if (String(url) === "https://www.googleapis.com/drive/v3/files") {
      return new Response("Permission denied", { status: 403 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const resCreateFail = await createGoogleDoc(fakeEnv, action);
    assert.strictEqual(resCreateFail.ok, false);
    assert.strictEqual(resCreateFail.stage, "creation");

    // 2. Insertion failure (HTTP 500 from Docs)
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "https://www.googleapis.com/drive/v3/files") {
        return new Response(JSON.stringify({ id: "doc-id-123" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).endsWith(":batchUpdate")) {
        return new Response("Internal error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const resInsertFail = await createGoogleDoc(fakeEnv, action);
    assert.strictEqual(resInsertFail.ok, false);
    assert.strictEqual(resInsertFail.stage, "insertion");

    // 3. Verification mismatch failure (mismatched title)
    globalThis.fetch = (async (url: string) => {
      const urlStr = String(url);
      if (urlStr === "https://www.googleapis.com/drive/v3/files") {
        return new Response(JSON.stringify({ id: "doc-id-123" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (urlStr.endsWith(":batchUpdate")) {
        return new Response(JSON.stringify({ documentId: "doc-id-123" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (urlStr === "https://docs.googleapis.com/v1/documents/doc-id-123") {
        return new Response(
          JSON.stringify({
            title: "Wrong Title Returned",
            body: { content: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const resVerifyFail = await createGoogleDoc(fakeEnv, action);
    assert.strictEqual(resVerifyFail.ok, false);
    assert.strictEqual(resVerifyFail.stage, "verification");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGoogleDoc preserves leading and trailing spaces in declared content exactly", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "doc-preserve-spaces-token",
      refresh_token: "doc-preserve-spaces-refresh",
      expires_in: 3600,
    },
    "preserve-creator@enig.com",
  );

  const docTitle = "Spaces Doc";
  // Leading/trailing spaces must be preserved exactly, not trimmed.
  const docContent = "  scoped content with edges  ";
  const folderId = "target-folder-spaces";
  const createdDocId = "new-doc-id-spaces";

  let insertedText = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr === "https://www.googleapis.com/drive/v3/files") {
      return new Response(JSON.stringify({ id: createdDocId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr === `https://docs.googleapis.com/v1/documents/${createdDocId}:batchUpdate`) {
      const body = JSON.parse(String(init?.body));
      insertedText = body.requests[0].insertText.text;
      assert.strictEqual(insertedText, docContent, "content written must preserve leading/trailing spaces exactly");
      return new Response(JSON.stringify({ documentId: createdDocId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr === `https://docs.googleapis.com/v1/documents/${createdDocId}`) {
      return new Response(
        JSON.stringify({
          title: docTitle,
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: `${insertedText}\n` } }],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const action: PendingGoogleAction = {
      type: "create_doc",
      title: docTitle,
      content: docContent,
      folderId,
      accountIdentifier: "preserve-creator@enig.com",
    };

    const res = await createGoogleDoc(fakeEnv, action);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.documentId, createdDocId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGoogleDoc preserves declared newlines in content exactly", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "doc-preserve-newlines-token",
      refresh_token: "doc-preserve-newlines-refresh",
      expires_in: 3600,
    },
    "preserve-newlines-creator@enig.com",
  );

  const docTitle = "Newlines Doc";
  // Declared newlines must be preserved exactly.
  const docContent = "line one\nline two\nline three";
  const folderId = "target-folder-newlines";
  const createdDocId = "new-doc-id-newlines";

  let insertedText = "";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr === "https://www.googleapis.com/drive/v3/files") {
      return new Response(JSON.stringify({ id: createdDocId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr === `https://docs.googleapis.com/v1/documents/${createdDocId}:batchUpdate`) {
      const body = JSON.parse(String(init?.body));
      insertedText = body.requests[0].insertText.text;
      assert.strictEqual(insertedText, docContent, "content written must preserve declared newlines exactly");
      return new Response(JSON.stringify({ documentId: createdDocId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr === `https://docs.googleapis.com/v1/documents/${createdDocId}`) {
      return new Response(
        JSON.stringify({
          title: docTitle,
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: `${insertedText}\n` } }],
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const action: PendingGoogleAction = {
      type: "create_doc",
      title: docTitle,
      content: docContent,
      folderId,
      accountIdentifier: "preserve-newlines-creator@enig.com",
    };

    const res = await createGoogleDoc(fakeEnv, action);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.documentId, createdDocId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGoogleDoc rejects empty or whitespace-only content at validation (without trimming the write value)", async () => {
  const { fakeEnv } = createFakeEnv();

  const action: PendingGoogleAction = {
    type: "create_doc",
    title: "Whitespace Doc",
    content: "   ",
    folderId: "target-folder",
    accountIdentifier: "creator@enig.com",
  };

  const res = await createGoogleDoc(fakeEnv, action);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stage, "validation");
  assert.strictEqual(res.error, "Missing or invalid Google Doc creation parameters");
});

test("rewriteGoogleDoc surfaces Google's rejection detail without leaking the token, and still verifies the read-back", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "rewrite-access-token-secret", refresh_token: "rewrite-refresh-secret", expires_in: 3600 },
    "writer@enig.com",
  );

  const layout = buildProposalDocLayout("PROP-6", [
    { version: 1, content: "Scope A." },
    { version: 2, content: "Scope B." },
  ]);
  const documentId = "doc-rewrite-1";
  const beforeText = "PROP-6 v1 -- current version\nScope A.\n";
  const docGet = () =>
    new Response(
      JSON.stringify({ body: { content: [{ endIndex: beforeText.length + 1, paragraph: { elements: [{ textRun: { content: beforeText } }] } }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    // 1. A batch Google rejects: the whole batch fails, and the error must
    // carry Google's own status + message so the rejected request is knowable
    // -- while never echoing the token or document content.
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u === `https://docs.googleapis.com/v1/documents/${documentId}`) return docGet();
      if (u === `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: `Invalid JSON payload received. Unknown name "textStyle" at 'requests[4].updateParagraphStyle': Cannot find field.`,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected call ${u}`);
    }) as typeof fetch;

    const rejected = await rewriteGoogleDoc(fakeEnv, "writer@enig.com", documentId, layout);
    assert.strictEqual(rejected.ok, false);
    if (!rejected.ok) {
      assert.match(rejected.error, /Google Docs rewrite failed \(HTTP 400/);
      assert.match(rejected.error, /INVALID_ARGUMENT/);
      assert.match(rejected.error, /requests\[4\]\.updateParagraphStyle/, "the rejected request is named");
      assert.ok(rejected.error.length < 500, "the diagnostic is bounded");
      assert.ok(!rejected.error.includes("rewrite-access-token-secret"), "the access token is never echoed");
      assert.ok(!rejected.error.includes(beforeText), "document content is never echoed");
    }

    // 2. An accepted batch whose read-back does not match stays an uncertain
    // failure -- never a success claim.
    let reads = 0;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u === `https://docs.googleapis.com/v1/documents/${documentId}`) {
        reads++;
        const text = reads === 1 ? beforeText : "something else entirely";
        return new Response(
          JSON.stringify({ body: { content: [{ endIndex: text.length + 1, paragraph: { elements: [{ textRun: { content: text } }] } }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u === `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`) {
        return new Response(JSON.stringify({ documentId }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected call ${u}`);
    }) as typeof fetch;

    const drifted = await rewriteGoogleDoc(fakeEnv, "writer@enig.com", documentId, layout);
    assert.strictEqual(drifted.ok, false);
    if (!drifted.ok) assert.strictEqual(drifted.error, "the Doc did not read back as written");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /oauth/google/callback rejects missing, invalid, or denied authorization", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })) as typeof fetch;

  try {
    // 1. Missing code and state
    const reqMissing = new Request("https://enig-agent.martnkpogo.workers.dev/oauth/google/callback");
    const resMissing = await handleGoogleOAuthCallback(reqMissing, fakeEnv);
    assert.strictEqual(resMissing.status, 400);
    assert.match(await resMissing.text(), /Missing code or state/);

    // 2. State not in KV (unknown/expired state)
    const reqInvalidState = new Request(
      "https://enig-agent.martnkpogo.workers.dev/oauth/google/callback?code=some-code&state=non-existent-state",
    );
    const resInvalidState = await handleGoogleOAuthCallback(reqInvalidState, fakeEnv);
    assert.strictEqual(resInvalidState.status, 400);
    assert.match(await resInvalidState.text(), /Unknown or expired state/);

    // 3. Authorization denied parameter error
    const reqDenied = new Request(
      "https://enig-agent.martnkpogo.workers.dev/oauth/google/callback?error=access_denied&error_description=User%20denied%20access",
    );
    const resDenied = await handleGoogleOAuthCallback(reqDenied, fakeEnv);
    assert.strictEqual(resDenied.status, 400);
    assert.match(await resDenied.text(), /User denied access/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /oauth/google/callback consumes state on single use and rejects replay attempts", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  // Stash state in KV
  const testState = "single-use-state-999";
  const testVerifier = "test-verifier-code-123";
  await fakeEnv.STATE_KV.put(`google_oauth_state:${testState}`, testVerifier, { expirationTtl: 1800 });

  const idToken = makeDummyIdToken("user@enig.com");

  // Mock token exchange fetch call
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      assert.strictEqual(init.method, "POST");
      const params = new URLSearchParams(String(init.body));
      assert.strictEqual(params.get("code_verifier"), testVerifier);
      assert.strictEqual(params.get("client_id"), fakeEnv.GOOGLE_OAUTH_CLIENT_ID);
      assert.strictEqual(params.get("client_secret"), fakeEnv.GOOGLE_OAUTH_CLIENT_SECRET);

      return new Response(
        JSON.stringify({
          access_token: "google-access-token-001",
          refresh_token: "google-refresh-token-001",
          expires_in: 3600,
          id_token: idToken,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const reqCallback = new Request(
      `https://enig-agent.martnkpogo.workers.dev/oauth/google/callback?code=valid-code-123&state=${testState}`,
    );
    const resCallback = await handleGoogleOAuthCallback(reqCallback, fakeEnv);

    assert.strictEqual(resCallback.status, 200);
    assert.strictEqual(await resCallback.text(), "Google Workspace authorized. You can close this tab.");

    // State MUST be deleted from KV immediately
    const stateInKvAfter = await fakeEnv.STATE_KV.get(`google_oauth_state:${testState}`);
    assert.strictEqual(stateInKvAfter, null);

    // Replay attempt with same state MUST fail closed
    const resReplay = await handleGoogleOAuthCallback(reqCallback, fakeEnv);
    assert.strictEqual(resReplay.status, 400);
    assert.match(await resReplay.text(), /Unknown or expired state/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Token persistence and refresh-token preservation when subsequent exchange omits refresh_token", async () => {
  const { fakeEnv } = createFakeEnv();

  // 1. First initial token exchange with refresh_token
  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "access-token-1",
      refresh_token: "refresh-token-original",
      expires_in: 3600,
    },
    "user@enig.com",
  );

  const stored1 = await loadGoogleTokens(fakeEnv, "user@enig.com");
  assert.ok(stored1);
  assert.strictEqual(stored1.access_token, "access-token-1");
  assert.strictEqual(stored1.refresh_token, "refresh-token-original");

  // 2. Subsequent re-authorization where Google omits refresh_token
  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "access-token-2-refreshed",
      // refresh_token is missing / undefined
      expires_in: 3600,
    },
    "user@enig.com",
  );

  const stored2 = await loadGoogleTokens(fakeEnv, "user@enig.com");
  assert.ok(stored2);
  assert.strictEqual(stored2.access_token, "access-token-2-refreshed");
  // Original refresh_token preserved!
  assert.strictEqual(stored2.refresh_token, "refresh-token-original");

  // 3. Fresh account with no prior stored token and no refresh_token throws error
  await assert.rejects(
    async () => {
      await persistGoogleTokens(
        fakeEnv,
        {
          access_token: "access-token-3",
          expires_in: 3600,
        },
        "brand-new-user@enig.com",
      );
    },
    /No refresh_token received from Google and no existing refresh_token stored/,
  );
});

test("getValidGoogleAccessToken retrieves active token and auto-refreshes when expired", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  // Stash an expiring token (expires in 5s)
  await fakeEnv.STATE_KV.put(
    "google_oauth_tokens:user@enig.com",
    JSON.stringify({
      access_token: "expiring-access-token",
      refresh_token: "stored-refresh-token-123",
      expires_at: Date.now() + 5000, // < 30s remaining -> triggers refresh
      updated_at: new Date().toISOString(),
    }),
  );

  let refreshCalled = false;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      refreshCalled = true;
      const params = new URLSearchParams(String(init.body));
      assert.strictEqual(params.get("grant_type"), "refresh_token");
      assert.strictEqual(params.get("refresh_token"), "stored-refresh-token-123");

      return new Response(
        JSON.stringify({
          access_token: "freshly-refreshed-access-token-999",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const token = await getValidGoogleAccessToken(fakeEnv, "user@enig.com");
    assert.strictEqual(refreshCalled, true);
    assert.strictEqual(token, "freshly-refreshed-access-token-999");

    // KV state updated with new access token while preserving refresh token
    const stored = await loadGoogleTokens(fakeEnv, "user@enig.com");
    assert.strictEqual(stored?.access_token, "freshly-refreshed-access-token-999");
    assert.strictEqual(stored?.refresh_token, "stored-refresh-token-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("IdToken parsing extracts email or sub safely without throwing", () => {
  const tokenWithEmail = makeDummyIdToken("admin@enig.com", "sub-123");
  assert.strictEqual(parseAccountIdentifierFromIdToken(tokenWithEmail), "admin@enig.com");

  const tokenWithoutEmail = makeDummyIdToken("", "sub-456");
  assert.strictEqual(parseAccountIdentifierFromIdToken(tokenWithoutEmail), "sub-456");

  assert.strictEqual(parseAccountIdentifierFromIdToken("invalid-jwt-format"), "default");
  assert.strictEqual(parseAccountIdentifierFromIdToken(undefined), "default");
});

test("Assurance that sensitive credential material is NEVER written to logs or activity log", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const secretCode = "sensitive-authorization-code-12345";
  const secretState = "state-sensitive-777";
  const secretVerifier = "sensitive-pkce-verifier-99999";
  const secretAccessToken = "secret-access-token-abcde";
  const secretRefreshToken = "secret-refresh-token-vwxyz";
  const secretClientSecret = fakeEnv.GOOGLE_OAUTH_CLIENT_SECRET!;

  await fakeEnv.STATE_KV.put(`google_oauth_state:${secretState}`, secretVerifier, { expirationTtl: 1800 });

  const loggedBodies: string[] = [];
  const consoleLogs: string[] = [];

  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (...args: any[]) => consoleLogs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => consoleLogs.push(args.map(String).join(" "));

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.body) {
      loggedBodies.push(String(init.body));
    }
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: secretAccessToken,
          refresh_token: secretRefreshToken,
          expires_in: 3600,
          id_token: makeDummyIdToken("admin@enig.com"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Notion or Telegram fetch calls
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const reqCallback = new Request(
      `https://enig-agent.martnkpogo.workers.dev/oauth/google/callback?code=${secretCode}&state=${secretState}`,
    );
    const resCallback = await handleGoogleOAuthCallback(reqCallback, fakeEnv);
    assert.strictEqual(resCallback.status, 200);

    // Inspect all fetch bodies sent to Notion or Telegram (Activity Log, Operations Telegram message)
    for (const bodyStr of loggedBodies) {
      // Allow token request body sent directly to Google token endpoint, but verify all Notion/Telegram writes exclude credentials
      if (!bodyStr.includes("grant_type=authorization_code")) {
        assert.strictEqual(bodyStr.includes(secretCode), false, "Auth code must not be exposed in Notion/Telegram logs");
        assert.strictEqual(bodyStr.includes(secretVerifier), false, "PKCE verifier must not be exposed in Notion/Telegram logs");
        assert.strictEqual(
          bodyStr.includes(secretAccessToken),
          false,
          "Access token must not be exposed in Notion/Telegram logs",
        );
        assert.strictEqual(
          bodyStr.includes(secretRefreshToken),
          false,
          "Refresh token must not be exposed in Notion/Telegram logs",
        );
        assert.strictEqual(
          bodyStr.includes(secretClientSecret),
          false,
          "Client secret must not be exposed in Notion/Telegram logs",
        );
      }
    }

    // Inspect console logs
    for (const logLine of consoleLogs) {
      assert.strictEqual(logLine.includes(secretAccessToken), false, "Access token must not appear in console logs");
      assert.strictEqual(logLine.includes(secretRefreshToken), false, "Refresh token must not appear in console logs");
      assert.strictEqual(logLine.includes(secretClientSecret), false, "Client secret must not appear in console logs");
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
});

test("testGoogleDriveConnection returns status 401 when tokens are missing or invalid", async () => {
  const { fakeEnv } = createFakeEnv();
  const res = await testGoogleDriveConnection(fakeEnv, "unauthorized-account@enig.com");

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.error, "Google Workspace authorization missing or invalid");
});

test("testGoogleDriveConnection succeeds when valid access token exists and Google Drive API returns 200", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "valid-drive-access-token",
      refresh_token: "valid-drive-refresh-token",
      expires_in: 3600,
    },
    "user@enig.com",
  );

  let driveApiCalled = false;
  let authHeaderUsed = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) === "https://www.googleapis.com/drive/v3/files?pageSize=1") {
      driveApiCalled = true;
      const headers = init?.headers as Record<string, string> | undefined;
      authHeaderUsed = headers ? headers["Authorization"] || "" : "";
      return new Response(
        JSON.stringify({
          kind: "drive#fileList",
          incompleteSearch: false,
          files: [{ id: "file-123", name: "Sample Document" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await testGoogleDriveConnection(fakeEnv, "user@enig.com");
    assert.strictEqual(driveApiCalled, true);
    assert.strictEqual(authHeaderUsed, "Bearer valid-drive-access-token");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("testGoogleDriveConnection fails closed on upstream Google Drive API error or network failure", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "valid-access-token",
      refresh_token: "valid-refresh-token",
      expires_in: 3600,
    },
    "user@enig.com",
  );

  // 1. Upstream 401 Unauthorized from Google Drive API
  globalThis.fetch = (async (url: string) => {
    if (String(url) === "https://www.googleapis.com/drive/v3/files?pageSize=1") {
      return new Response(JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const res401 = await testGoogleDriveConnection(fakeEnv, "user@enig.com");
    assert.strictEqual(res401.ok, false);
    assert.strictEqual(res401.status, 401);
    assert.strictEqual(res401.error, "Google Drive API request failed");

    // 2. Network / Transport error when fetching Google Drive API
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "https://www.googleapis.com/drive/v3/files?pageSize=1") {
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const resNetErr = await testGoogleDriveConnection(fakeEnv, "user@enig.com");
    assert.strictEqual(resNetErr.ok, false);
    assert.strictEqual(resNetErr.status, 502);
    assert.strictEqual(resNetErr.error, "Network error reaching Google Drive API");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /admin/test-google-drive handles authorization key parameter and returns json response", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "admin-access-token",
      refresh_token: "admin-refresh-token",
      expires_in: 3600,
    },
    "default",
  );

  globalThis.fetch = (async (url: string) => {
    if (String(url) === "https://www.googleapis.com/drive/v3/files?pageSize=1") {
      return new Response(
        JSON.stringify({
          kind: "drive#fileList",
          files: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    // 1. Missing secret key -> 403 Forbidden
    const reqNoKey = new Request("https://enig-agent.martnkpogo.workers.dev/admin/test-google-drive");
    const resNoKey = await handleGoogleDriveTest(reqNoKey, fakeEnv);
    assert.strictEqual(resNoKey.status, 403);

    // 2. Valid secret key -> 200 OK with {"ok": true, "connected": true}
    const reqAuth = new Request(
      `https://enig-agent.martnkpogo.workers.dev/admin/test-google-drive?key=${fakeEnv.WORKER_ADMIN_KEY}`,
    );
    const resAuth = await handleGoogleDriveTest(reqAuth, fakeEnv);
    assert.strictEqual(resAuth.status, 200);

    const json = (await resAuth.json()) as { ok: boolean; connected?: boolean };
    assert.deepStrictEqual(json, { ok: true, connected: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cleanupDefaultGoogleAccount is a no-op when no 'default' account exists", async () => {
  const { fakeEnv } = createFakeEnv();
  const result = await cleanupDefaultGoogleAccount(fakeEnv);
  assert.deepStrictEqual(result, { tokenDeleted: false, docsRepointedTo: null, docsRepointed: [], docsOrphaned: [] });
});

test("cleanupDefaultGoogleAccount deletes the 'default' token and re-points its watched docs when exactly one other account exists", async () => {
  const { fakeEnv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "default-tok", refresh_token: "default-refresh", expires_in: 3600 }, "default");
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "real-tok", refresh_token: "real-refresh", expires_in: 3600 },
    "martinkpogo3@gmail.com",
  );
  await registerWatchedGoogleDoc(fakeEnv, {
    documentId: "doc-under-default",
    accountIdentifier: "default",
    title: "Test Doc",
    createdAt: new Date().toISOString(),
  });

  const result = await cleanupDefaultGoogleAccount(fakeEnv);

  assert.strictEqual(result.tokenDeleted, true);
  assert.strictEqual(result.docsRepointedTo, "martinkpogo3@gmail.com");
  assert.deepStrictEqual(result.docsRepointed, ["doc-under-default"]);
  assert.deepStrictEqual(result.docsOrphaned, []);

  assert.strictEqual(await loadGoogleTokens(fakeEnv, "default"), null);
  const docs = await listWatchedGoogleDocs(fakeEnv);
  assert.strictEqual(docs.find((d) => d.documentId === "doc-under-default")?.accountIdentifier, "martinkpogo3@gmail.com");
});

test("cleanupDefaultGoogleAccount never guesses which account to re-point to when zero or multiple other accounts exist", async () => {
  const { fakeEnv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "default-tok", refresh_token: "default-refresh", expires_in: 3600 }, "default");
  await registerWatchedGoogleDoc(fakeEnv, {
    documentId: "doc-under-default-2",
    accountIdentifier: "default",
    title: "Test Doc",
    createdAt: new Date().toISOString(),
  });

  // Zero other accounts -- deletes the stale token, but reports the doc as
  // orphaned rather than guessing where to send it.
  const result = await cleanupDefaultGoogleAccount(fakeEnv);
  assert.strictEqual(result.tokenDeleted, true);
  assert.strictEqual(result.docsRepointedTo, null);
  assert.deepStrictEqual(result.docsOrphaned, ["doc-under-default-2"]);
  const docs = await listWatchedGoogleDocs(fakeEnv);
  assert.strictEqual(docs.find((d) => d.documentId === "doc-under-default-2")?.accountIdentifier, "default");
});

test("columnLetter converts 1-based column indices to A1-notation letters", () => {
  assert.strictEqual(columnLetter(1), "A");
  assert.strictEqual(columnLetter(5), "E");
  assert.strictEqual(columnLetter(26), "Z");
  assert.strictEqual(columnLetter(27), "AA");
  assert.strictEqual(columnLetter(52), "AZ");
});

test("createGoogleSheet validates action parameters and fails closed on missing input", async () => {
  const { fakeEnv } = createFakeEnv();

  const invalidAction = {
    type: "create_sheet",
    title: "",
    rows: [["Date", "Content Piece"]],
    folderId: "folder-123",
    accountIdentifier: "admin@enig.com",
  } as PendingGoogleAction;

  const res = await createGoogleSheet(fakeEnv, invalidAction as any);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stage, "validation");
  assert.strictEqual(res.error, "Missing or invalid Google Sheet creation parameters");
});

test("createGoogleSheet fails closed when authorization is missing", async () => {
  const { fakeEnv } = createFakeEnv();

  const action = {
    type: "create_sheet",
    title: "Content Calendar",
    rows: [["Date", "Content Piece", "Channel", "Status", "Owner"]],
    folderId: "folder-456",
    accountIdentifier: "unauthorized@enig.com",
  } as PendingGoogleAction;

  const res = await createGoogleSheet(fakeEnv, action as any);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stage, "auth");
  assert.strictEqual(res.error, "Google Workspace authorization missing or invalid");
});

test("createGoogleSheet executes 3-stage creation pipeline and verifies header/data rows", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "sheet-access-token-001",
      refresh_token: "sheet-refresh-token-001",
      expires_in: 3600,
    },
    "sheet-creator@enig.com",
  );

  let driveCreated = false;
  let valuesUpdated = false;
  let valuesVerified = false;

  const sheetTitle = "Q4 Content Calendar";
  const rows = [
    ["Date", "Content Piece", "Channel", "Status", "Owner"],
    ["2026-10-01", "Launch post", "LinkedIn", "Planned", "Content Manager"],
  ];
  const folderId = "target-folder-calendar";
  const createdSheetId = "new-sheet-id-999";
  const range = "A1:E2";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr === "https://www.googleapis.com/drive/v3/files") {
      driveCreated = true;
      assert.strictEqual(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.strictEqual(body.name, sheetTitle);
      assert.strictEqual(body.mimeType, "application/vnd.google-apps.spreadsheet");
      assert.deepStrictEqual(body.parents, [folderId]);

      return new Response(JSON.stringify({ id: createdSheetId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (
      urlStr ===
      `https://sheets.googleapis.com/v4/spreadsheets/${createdSheetId}/values/${range}?valueInputOption=USER_ENTERED`
    ) {
      valuesUpdated = true;
      assert.strictEqual(init?.method, "PUT");
      const body = JSON.parse(String(init?.body));
      assert.deepStrictEqual(body.values, rows);

      return new Response(JSON.stringify({ updatedRange: range }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (urlStr === `https://sheets.googleapis.com/v4/spreadsheets/${createdSheetId}/values/${range}`) {
      valuesVerified = true;
      assert.strictEqual(init?.method, "GET");

      return new Response(JSON.stringify({ values: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const action = {
      type: "create_sheet",
      title: sheetTitle,
      rows,
      folderId,
      accountIdentifier: "sheet-creator@enig.com",
    } as PendingGoogleAction;

    const res = await createGoogleSheet(fakeEnv, action as any);

    assert.strictEqual(driveCreated, true);
    assert.strictEqual(valuesUpdated, true);
    assert.strictEqual(valuesVerified, true);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.spreadsheetId, createdSheetId);
    assert.strictEqual(res.spreadsheetUrl, `https://docs.google.com/spreadsheets/d/${createdSheetId}/edit`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGoogleSheet fails closed on creation, insertion, or verification mismatch", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    {
      access_token: "sheet-access-token-002",
      refresh_token: "sheet-refresh-token-002",
      expires_in: 3600,
    },
    "sheet-creator-2@enig.com",
  );

  const action = {
    type: "create_sheet",
    title: "Test Sheet Failure",
    rows: [["Date", "Content Piece"]],
    folderId: "folder-id-888",
    accountIdentifier: "sheet-creator-2@enig.com",
  } as PendingGoogleAction;

  // 1. Creation failure
  globalThis.fetch = (async (url: string) => {
    if (String(url) === "https://www.googleapis.com/drive/v3/files") {
      return new Response("Permission denied", { status: 403 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const resCreateFail = await createGoogleSheet(fakeEnv, action as any);
    assert.strictEqual(resCreateFail.ok, false);
    assert.strictEqual(resCreateFail.stage, "creation");

    // 2. Insertion failure
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "https://www.googleapis.com/drive/v3/files") {
        return new Response(JSON.stringify({ id: "sheet-id-123" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).includes("/values/")) {
        return new Response("Internal error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const resInsertFail = await createGoogleSheet(fakeEnv, action as any);
    assert.strictEqual(resInsertFail.ok, false);
    assert.strictEqual(resInsertFail.stage, "insertion");

    // 3. Verification mismatch (rows differ from what was inserted)
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === "https://www.googleapis.com/drive/v3/files") {
        return new Response(JSON.stringify({ id: "sheet-id-123" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init?.method === "PUT" && urlStr.includes("/values/")) {
        return new Response(JSON.stringify({ updatedRange: "A1:B1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init?.method === "GET" && urlStr.includes("/values/")) {
        return new Response(JSON.stringify({ values: [["Wrong", "Header"]] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const resVerifyFail = await createGoogleSheet(fakeEnv, action as any);
    assert.strictEqual(resVerifyFail.ok, false);
    assert.strictEqual(resVerifyFail.stage, "verification");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GoogleSheetCreationCapability ignores non-sheet requests and proposes account picker for content calendar requests", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  // Override the AI mock to classify as a sheet (content calendar) request.
  fakeEnv.AI = {
    run: async () => ({
      response: JSON.stringify({
        isGoogleSheetRequest: true,
        title: "November Content Calendar",
        rows: [["Date", "Content Piece", "Channel", "Status", "Owner"]],
      }),
    }),
  } as unknown as Ai;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "cal-token", refresh_token: "cal-refresh", expires_in: 3600 },
    "calendar-owner@enig.com",
  );

  let sentButtons: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const handled = await GoogleSheetCreationCapability.handleIntake(
      fakeEnv,
      12345,
      "Set up a content calendar for November",
    );

    assert.strictEqual(handled, true);
    assert.ok(sentButtons.length >= 1);
    assert.match(sentButtons[0][0].callback_data, /^googleaccount:[a-f0-9-]+:[a-f0-9-]+$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registerWatchedGoogleSheet and listWatchedGoogleSheets round-trip", async () => {
  const { fakeEnv } = createFakeEnv();

  assert.deepStrictEqual(await listWatchedGoogleSheets(fakeEnv), []);

  await registerWatchedGoogleSheet(fakeEnv, {
    spreadsheetId: "sheet-abc",
    accountIdentifier: "owner@enig.com",
    title: "Content Calendar",
    chatId: 111,
    threadId: 604,
    createdAt: new Date().toISOString(),
  });

  const sheets = await listWatchedGoogleSheets(fakeEnv);
  assert.strictEqual(sheets.length, 1);
  assert.strictEqual(sheets[0].spreadsheetId, "sheet-abc");
  assert.strictEqual(sheets[0].title, "Content Calendar");
});

test("handleGoogleActionApproval registers the created sheet for comment-triggered editing and tips about it", async (t) => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "sheet-tok", refresh_token: "sheet-refresh", expires_in: 3600 },
    "owner@enig.com",
  );

  let sentTelegramText = "";
  const createdSheetId = "sheet-watch-target";
  const rows = [["Date", "Content Piece", "Channel", "Status", "Owner"]];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlStr === "https://www.googleapis.com/drive/v3/files") {
      return new Response(JSON.stringify({ id: createdSheetId }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/values/") && init?.method === "PUT") {
      return new Response(JSON.stringify({ updatedRange: "A1:E1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/values/") && (!init || init.method === undefined || (init?.method ?? "GET") === "GET")) {
      return new Response(JSON.stringify({ values: rows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state: WorkState = {
    workId: "work-sheet-watch-1",
    chatId: 987654321,
    threadId: 604,
    unit: "Operations",
    hat: "Content Manager",
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingGoogleAction: {
      type: "create_sheet",
      title: "Watched Content Calendar",
      rows,
      folderId: "folder-1",
      accountIdentifier: "owner@enig.com",
    },
  };

  const updatedState = await handleGoogleActionApproval(fakeEnv, state, true);

  assert.strictEqual(updatedState.pendingGoogleAction, undefined);
  assert.match(sentTelegramText, /Google Sheet created and verified successfully/);
  assert.match(sentTelegramText, /select a cell.*comment/i);

  const watched = await listWatchedGoogleSheets(fakeEnv);
  assert.strictEqual(watched.length, 1);
  assert.strictEqual(watched[0].spreadsheetId, createdSheetId);
  assert.strictEqual(watched[0].accountIdentifier, "owner@enig.com");
});

test("Round-trip: index.ts callback parsing of the second folder button keeps its position (the 4th piece survives parsing)", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-roundtrip", refresh_token: "refresh-roundtrip", expires_in: 3600 },
    "roundtrip@enig.com",
  );

  const workId = "work-roundtrip-1";
  const accountOptionId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "account",
    accountIdentifier: "roundtrip@enig.com",
    title: "Round Trip Doc",
    content: "Round trip content",
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentButtons: any[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("googleapis.com/drive/v3/files/root")) {
      return new Response(
        JSON.stringify({ id: "root-id-abc123", name: "My Drive" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      return new Response(
        JSON.stringify({
          files: [
            { id: "folder-a", name: "Folder A", mimeType: "application/vnd.google-apps.folder" },
            { id: "folder-b", name: "Folder B", mimeType: "application/vnd.google-apps.folder" },
            { id: "folder-c", name: "Folder C", mimeType: "application/vnd.google-apps.folder" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Build a REAL browse screen through the account-selection stage, exactly
    // as production does, and take the SECOND item button's callback_data
    // from the Telegram message that was sent.
    await handleGoogleAccountSelection(fakeEnv, state, accountOptionId);
    assert.strictEqual(sentButtons.length, 4, "one button per item row plus Save here");
    const secondItemData = sentButtons[1][0].callback_data;
    assert.match(secondItemData, /^googlefolder:work-roundtrip-1:[a-f0-9]{8}:o1$/);

    // RED/GREEN seam: index.ts parses the callback_data before the handler
    // ever sees it. This test performs that same parse so a truncating parse
    // fails here instead of in production.
    const { action, workId: parsedWorkId, value } = parseCallbackData(secondItemData);
    assert.strictEqual(action, "googlefolder");
    assert.strictEqual(parsedWorkId, workId);

    // ...and the 4th piece ("<screenId>:<code>") must decode back to the
    // SECOND item's position -- the tap handler (a later task) resolves the
    // item from it, so a parse that drops or corrupts it fails here.
    const parsed = parseBrowseValue(value);
    assert.ok(parsed, `the 4th piece must survive parsing, got value: ${value}`);
    assert.ok(
      parsed.action.type === "open" || parsed.action.type === "file",
      `expected an item action, got ${parsed.action.type}`,
    );
    assert.strictEqual(parsed.action.index, 1, "the SECOND item's position must survive the round trip");
    assert.strictEqual(parsed.screenId, secondItemData.split(":")[2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Drive file browser (Stage C, Task 6): the top-level My Drive screen.
// ---------------------------------------------------------------------------

const BROWSE_ROOT_ID = "root-id-abc123";

/**
 * Scripts the two Drive calls the browser makes -- files/root and the
 * listing of that root -- plus Telegram, capturing every picker keyboard and
 * message text the flow sends. Drive mocks that match any `/drive/v3/files`
 * URL must answer the ROOT url with { id, name } and the listing url with
 * { files: [...] }; the root branch below does that by default.
 */
function installBrowseFake(opts: {
  root?: { status?: number; body?: unknown };
  listing?: { status?: number; body?: unknown };
} = {}) {
  const pickers: any[][][] = [];
  const texts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("googleapis.com/drive/v3/files/root")) {
      const o = opts.root;
      return new Response(
        JSON.stringify(o?.body ?? { id: BROWSE_ROOT_ID, name: "My Drive" }),
        { status: o?.status ?? 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      const o = opts.listing;
      return new Response(
        JSON.stringify(o?.body ?? { files: [] }),
        { status: o?.status ?? 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      texts.push(String(body.text ?? ""));
      if (body.reply_markup?.inline_keyboard) pickers.push(body.reply_markup.inline_keyboard);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return {
    pickers,
    texts,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function browseState(workId: string): WorkState {
  return {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Authorizes the browser's account and stages its account option (real staging, not a fixture). */
async function stageBrowseAccount(
  fakeEnv: Env,
  workId: string,
  option: Record<string, unknown> = {},
): Promise<string> {
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  return saveOpaqueOption(fakeEnv, workId, {
    kind: "account",
    accountIdentifier: "user@enig.com",
    title: "Browse Doc",
    content: "Browse body",
    ...option,
  });
}

function screenIdOf(row: any[]): string {
  return String(row[0].callback_data).split(":")[2]!;
}

function storedScreen(mockKv: ReturnType<typeof createMockKv>, workId: string, screenId: string): any {
  const entry = mockKv._rawStore.get(`google_option:${workId}:${screenId}`);
  assert.ok(entry, `the browse screen ${screenId} must be stored`);
  return JSON.parse(entry.value);
}

/** Counts storage writes made WHILE the handler runs, for this work's google_option: keys only (the `reply_msg:` bookkeeping every sent message performs is not a staging write). */
function countOptionWrites(mockKv: ReturnType<typeof createMockKv>, workId: string): () => number {
  const store = mockKv._rawStore;
  const originalSet = store.set.bind(store);
  let writes = 0;
  (store as any).set = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(`google_option:${workId}:`)) writes++;
    return (originalSet as any)(...args);
  };
  return () => writes;
}

function stagedOptionKeys(mockKv: ReturnType<typeof createMockKv>, workId: string): string[] {
  return [...mockKv._rawStore.keys()].filter((k) => k.startsWith(`google_option:${workId}:`));
}

test("Empty My Drive still shows the browser screen with only the Save here button", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-browse-empty";
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);
  const drive = installBrowseFake({ listing: { body: { files: [] } } });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    assert.strictEqual(drive.pickers.length, 1, "exactly one picker message");
    const rows = drive.pickers[0]!;
    assert.strictEqual(rows.length, 1, "an empty My Drive shows only the Save here row");
    assert.strictEqual(rows[0][0].text, "✅ Save here");
    assert.match(rows[0][0].callback_data, /^googlefolder:work-browse-empty:[a-f0-9]{8}:s$/);

    const screen = storedScreen(mockKv, workId, screenIdOf(rows[0]));
    assert.strictEqual(screen.kind, "drivebrowse");
    assert.deepStrictEqual(screen.items, [], "no items -- but the screen is stored");
    assert.strictEqual(screen.folderName, "My Drive");
    assert.strictEqual(screen.truncated, false);
    assert.ok(drive.texts.join("\n").includes("📂 *My Drive*"), "the folder line is still shown");
  } finally {
    drive.restore();
  }
});

test("Mixed My Drive contents render folders first, then files, then Save here -- with no Back button", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-browse-mixed";
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: "file-z", name: "Zebra notes", mimeType: "text/plain" },
          { id: "folder-b", name: "Beta folder", mimeType: "application/vnd.google-apps.folder" },
          { id: "folder-a", name: "Alpha folder", mimeType: "application/vnd.google-apps.folder" },
          { id: "file-a", name: "Alpha notes", mimeType: "text/plain" },
        ],
      },
    },
  });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    const rows = drive.pickers[0]!;
    // listDriveFolderContents sorts folders first, then files (A-Z inside
    // each group) -- the buttons must follow that exact order.
    assert.deepStrictEqual(
      rows.map((r) => r[0].text),
      ["📁 Alpha folder", "📁 Beta folder", "📄 Alpha notes", "📄 Zebra notes", "✅ Save here"],
    );
    assert.deepStrictEqual(
      rows.map((r) => String(r[0].callback_data).split(":").pop()),
      ["o0", "o1", "f2", "f3", "s"],
      "folders use 'open' codes, files 'file' codes, by their screen position",
    );
    assert.strictEqual(
      rows.some((r) => /back/i.test(String(r[0].text))),
      false,
      "no Back button on the top screen",
    );
    assert.ok(drive.texts.join("\n").includes("📂 *My Drive*"), "text contains the folder line");

    const screen = storedScreen(mockKv, workId, screenIdOf(rows[0]));
    assert.strictEqual(screen.folderId, BROWSE_ROOT_ID);
    assert.strictEqual(screen.parentScreenId, undefined, "no parentScreenId at the top");
    assert.strictEqual(screen.items.length, 4);
  } finally {
    drive.restore();
  }
});

test("A 120-item My Drive shows exactly 90 item buttons plus Save here and says it is showing the first 90", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-browse-120";
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);
  const files = Array.from({ length: 120 }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${String(i).padStart(3, "0")}`,
    mimeType: "application/vnd.google-apps.folder",
  }));
  const drive = installBrowseFake({ listing: { body: { files } } });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    const rows = drive.pickers[0]!;
    assert.strictEqual(rows.length, 91, "exactly 90 item buttons + Save here");
    assert.strictEqual(rows[90][0].text, "✅ Save here", "Save here is the LAST row");
    assert.strictEqual(
      rows.slice(0, 90).every((r) => String(r[0].text).startsWith("📁")),
      true,
    );
    const text = drive.texts.join("\n");
    assert.ok(text.includes("Showing the first 90 items"), `truncation note missing, got: ${text}`);

    const screen = storedScreen(mockKv, workId, screenIdOf(rows[0]));
    assert.strictEqual(screen.items.length, 90, "the stored screen keeps at most 90 items");
    assert.strictEqual(screen.truncated, true);
  } finally {
    drive.restore();
  }
});

test("A My Drive root failure (HTTP 401) reports it and stages nothing", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-browse-root-401";
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);
  const drive = installBrowseFake({
    root: { status: 401, body: { error: { code: 401, message: "Invalid Credentials" } } },
  });
  const optionWrites = countOptionWrites(mockKv, workId);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    const text = drive.texts.join("\n");
    assert.ok(
      text.includes("⚠️ Could not open My Drive for account 'user@enig.com' (HTTP 401)."),
      `expected the Could not open My Drive message, got: ${text}`,
    );
    assert.strictEqual(drive.pickers.length, 0, "no picker is sent");
    assert.strictEqual(optionWrites(), 0, "ZERO storage writes -- nothing is staged");
    assert.deepStrictEqual(stagedOptionKeys(mockKv, workId), [], "no google_option: record survives");
  } finally {
    drive.restore();
  }
});

test("A My Drive listing failure reports it and stages nothing", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-browse-list-500";
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);
  const drive = installBrowseFake({
    listing: { status: 500, body: { error: { code: 500, message: "Internal error" } } },
  });
  const optionWrites = countOptionWrites(mockKv, workId);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    const text = drive.texts.join("\n");
    assert.ok(
      text.includes("⚠️ Could not list My Drive for account 'user@enig.com' (HTTP 500)."),
      `expected the Could not list My Drive message, got: ${text}`,
    );
    assert.strictEqual(drive.pickers.length, 0, "no picker is sent");
    assert.strictEqual(optionWrites(), 0, "ZERO storage writes -- nothing is staged");
    assert.deepStrictEqual(stagedOptionKeys(mockKv, workId), [], "no google_option: record survives");
  } finally {
    drive.restore();
  }
});

test("A refused screen write reports the staging failure and sends no picker", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-browse-refused";
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);
  const drive = installBrowseFake({
    listing: {
      body: { files: [{ id: "folder-a", name: "Alpha folder", mimeType: "application/vnd.google-apps.folder" }] },
    },
  });
  // The single storage write the screen needs is refused (KV quota).
  mockKv.put = async () => {
    throw new Error("KV write refused (quota)");
  };

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    const text = drive.texts.join("\n");
    assert.ok(
      text.includes("⚠️ Could not persist the folder-selection options"),
      `expected the Could not persist message, got: ${text}`,
    );
    assert.strictEqual(drive.pickers.length, 0, "NO picker is sent");
    assert.deepStrictEqual(stagedOptionKeys(mockKv, workId), [], "nothing is staged");
  } finally {
    drive.restore();
  }
});

test("The stored screen's context is correct for the smoke, delivery and normal flows", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const drive = installBrowseFake({
    listing: {
      body: { files: [{ id: "folder-a", name: "Alpha folder", mimeType: "application/vnd.google-apps.folder" }] },
    },
  });

  try {
    // smoke -- the flag and the account only, exactly what staged it.
    const smokeWork = "work-ctx-smoke";
    const smokeOption = await stageBrowseAccount(fakeEnv, smokeWork, {
      smoke: true,
      title: undefined,
      content: undefined,
    });
    await handleGoogleAccountSelection(fakeEnv, browseState(smokeWork), smokeOption);
    const smokeScreen = storedScreen(mockKv, smokeWork, screenIdOf(drive.pickers[0]![0]));
    assert.deepStrictEqual(smokeScreen.context, {
      smoke: true,
      accountIdentifier: "user@enig.com",
    });

    // delivery -- the delivery flag rides with the full payload.
    const deliveryWork = "work-ctx-delivery";
    const deliveryOption = await stageBrowseAccount(fakeEnv, deliveryWork, {
      delivery: true,
      docType: "sheet",
      title: "Report",
      content: "Report body",
      rows: [["Column"], ["Value"]],
    });
    await handleGoogleAccountSelection(fakeEnv, browseState(deliveryWork), deliveryOption);
    const deliveryScreen = storedScreen(mockKv, deliveryWork, screenIdOf(drive.pickers[1]![0]));
    assert.deepStrictEqual(deliveryScreen.context, {
      delivery: true,
      docType: "sheet",
      accountIdentifier: "user@enig.com",
      title: "Report",
      content: "Report body",
      rows: [["Column"], ["Value"]],
    });

    // normal -- no flags, the creation payload unchanged.
    const normalWork = "work-ctx-normal";
    const normalOption = await stageBrowseAccount(fakeEnv, normalWork, {
      title: "My Doc",
      content: "My body",
      rows: [["H1", "H2"], ["v1", "v2"]],
    });
    await handleGoogleAccountSelection(fakeEnv, browseState(normalWork), normalOption);
    const normalScreen = storedScreen(mockKv, normalWork, screenIdOf(drive.pickers[2]![0]));
    assert.deepStrictEqual(normalScreen.context, {
      docType: "doc",
      accountIdentifier: "user@enig.com",
      title: "My Doc",
      content: "My body",
      rows: [["H1", "H2"], ["v1", "v2"]],
    });

    // In every shape the old option's `kind` and `folders` are gone -- the
    // screen's structure replaces them.
    for (const screen of [smokeScreen, deliveryScreen, normalScreen]) {
      assert.strictEqual("kind" in screen.context, false, "kind must not ride along");
      assert.strictEqual("folders" in screen.context, false, "folders must not ride along");
    }
  } finally {
    drive.restore();
  }
});

// ---------------------------------------------------------------------------
// Drive file browser (Task 7, Stages 2-3): opening folders, safety lines,
// folder-name escaping.
// ---------------------------------------------------------------------------

function notionAwareFetch(
  driveFetch: typeof globalThis.fetch,
  counters: { notion: number; listing: number; driveUrls: string[] },
): typeof globalThis.fetch {
  return (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.notion.com")) {
      counters.notion++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("googleapis.com/drive/v3/files") && !s.includes("/root")) {
      counters.listing++;
      counters.driveUrls.push(s);
    }
    return driveFetch(url, init);
  }) as typeof globalThis.fetch;
}

test("Task 7: opening a folder makes exactly one listing call for that folder, stores a child screen whose parentScreenId is the tapped screen, and renders the folder name", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t7-a";
  const folderId = "folder-deep-7a";
  const folderName = "Q4 Plans";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: folderId, name: folderName, mimeType: "application/vnd.google-apps.folder" },
          { id: "file-7a", name: "notes.txt", mimeType: "text/plain" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const parentScreenId = screenIdOf(drive.pickers[0]![0]);
    const baseDrive = counters.driveUrls.length;

    const value = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    assert.strictEqual(counters.driveUrls.length, baseDrive + 1, "exactly one Drive call during the tap");
    const listingUrl = new URL(counters.driveUrls[counters.driveUrls.length - 1]!);
    assert.ok(
      listingUrl.searchParams.get("q")?.includes(`'${folderId}' in parents`),
      `the listing must target the tapped folder, got q=${listingUrl.searchParams.get("q")}`,
    );

    const childScreenId = screenIdOf(drive.pickers[1]![0]);
    const child = storedScreen(mockKv, workId, childScreenId);
    const parent = storedScreen(mockKv, workId, parentScreenId);
    assert.strictEqual(child.parentScreenId, parentScreenId, "child screen records the tapped screen as its parent");
    assert.strictEqual(child.folderId, folderId);
    assert.strictEqual(child.folderName, folderName);
    assert.deepStrictEqual(child.context, parent.context, "child context is deep-equal to the parent's");

    const childText = drive.texts[drive.texts.length - 1]!;
    assert.ok(childText.includes(`📂 *${folderName}*`), `child message names the folder, got: ${childText}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: the parent screen can still be read after a folder is opened", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t7-b";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-b", name: "B folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const parentScreenId = screenIdOf(drive.pickers[0]![0]);
    const parentBefore = storedScreen(mockKv, workId, parentScreenId);

    const value = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    const parentAfter = storedScreen(mockKv, workId, parentScreenId);
    assert.deepStrictEqual(parentAfter, parentBefore, "the stored parent screen is unchanged by opening a folder");
    const peeked = await peekOpaqueOption(fakeEnv, workId, parentScreenId);
    assert.deepStrictEqual(peeked, parentBefore, "the parent screen is still readable via peek");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: opening a folder makes no api.notion.com request while the top screen still logs", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t7-c";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-c", name: "C folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    assert.strictEqual(counters.notion, 1, "the top screen makes one Activity Log write to Notion");

    const beforeNotion = counters.notion;
    const beforeDrive = counters.driveUrls.length;
    const value = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    assert.strictEqual(counters.notion, beforeNotion, "opening a folder makes no Notion request");
    assert.strictEqual(counters.driveUrls.length, beforeDrive + 1, "exactly one Drive listing call for the folder");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: an expired screen id reports expiration and makes zero Drive calls", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t7-d";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-d", name: "D folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const beforeDrive = counters.driveUrls.length;

    const { value } = parseCallbackData(`googlefolder:${workId}:00000000:o0`);
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `expected an expiry message, got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls for an expired screen");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: an out-of-range index and an index pointing at a file both report unavailability with zero Drive calls", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t7-e";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: "folder-e", name: "E folder", mimeType: "application/vnd.google-apps.folder" },
          { id: "file-e", name: "notes.txt", mimeType: "text/plain" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const screenId = screenIdOf(drive.pickers[0]![0]);
    const beforeDrive = counters.driveUrls.length;

    for (const code of ["o99", "o1"]) {
      await handleGoogleFolderSelection(fakeEnv, browseState(workId), `${screenId}:${code}`);
      const last = drive.texts[drive.texts.length - 1]!;
      assert.ok(last.includes("no longer available"), `tap ${code}: expected 'no longer available', got: ${last}`);
    }

    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls for unavailable taps");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: no token reports the credentials message and makes zero Drive calls", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t7-f";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-f", name: "F folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const beforeDrive = counters.driveUrls.length;

    await fakeEnv.STATE_KV.delete(`google_oauth_tokens:user@enig.com`);
    const value = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("Could not retrieve valid credentials"), `expected the credentials message, got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls without a token");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: a listing failure when opening a folder reports it and stores no new screen", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t7-g";
  const folderId = "folder-g";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  let listingCalls = 0;
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "G folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.notion.com")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("googleapis.com/drive/v3/files") && !s.includes("/root")) {
      listingCalls++;
      if (listingCalls === 2) {
        return new Response(JSON.stringify({ error: { code: 500, message: "Internal error" } }), { status: 500 });
      }
    }
    return driveFetch(url, init);
  }) as typeof globalThis.fetch;

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    assert.strictEqual(listingCalls, 1, "the top screen's listing succeeded");

    const baseScreens = stagedOptionKeys(mockKv, workId).length;
    const writes = countOptionWrites(mockKv, workId);
    const value = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("Could not open folder"), `expected 'Could not open folder', got: ${last}`);
    assert.strictEqual(listingCalls, 2, "the child listing was attempted once and failed");
    assert.strictEqual(writes(), 0, "ZERO storage writes during the failed tap");
    assert.strictEqual(stagedOptionKeys(mockKv, workId).length, baseScreens, "ZERO new screens stored");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: file, save and back taps report unavailability with zero Drive calls and zero storage writes", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t7-h";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: "folder-h", name: "H folder", mimeType: "application/vnd.google-apps.folder" },
          { id: "file-h", name: "notes.txt", mimeType: "text/plain" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const screenId = screenIdOf(drive.pickers[0]![0]);
    const beforeDrive = counters.driveUrls.length;
    const writes = countOptionWrites(mockKv, workId);

    await handleGoogleFolderSelection(fakeEnv, browseState(workId), `${screenId}:f1`);
    assert.ok(drive.texts[drive.texts.length - 1]!.includes("No Google Drive link is available for this file."), "file tap: expected 'No Google Drive link is available for this file.' (was 'isn't available yet')");
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), `${screenId}:s`);
    assert.ok(drive.texts[drive.texts.length - 1]!.includes("Create Google Doc"), "save tap: now leads into the Create Google Doc flow (was 'isn't available yet')");
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), `${screenId}:b`);
    assert.ok(
      drive.texts[drive.texts.length - 1]!.includes("has expired"),
      `back after save consumed the screen: expected 'has expired', got: ${drive.texts[drive.texts.length - 1]}`,
    );

    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls for file/save/back taps");
    assert.strictEqual(writes(), 0, "ZERO storage writes for file/save/back taps");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: a folder named 'Q4_plan *draft*' is escaped in the message text but not in the button label", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t7-i";
  const folderName = "Q4_plan *draft*";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-i", name: folderName, mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    assert.strictEqual(drive.pickers[0]![0][0].text, `📁 ${folderName}`, "the button label is not escaped");

    const value = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    const childText = drive.texts[drive.texts.length - 1]!;
    assert.ok(childText.includes("📂 *Q4\\_plan \\*draft\\*"), `escaped folder name missing, got: ${childText}`);
    const child = storedScreen(mockKv, workId, screenIdOf(drive.pickers[1]![0]));
    assert.strictEqual(child.folderName, folderName, "the stored folder name keeps its original characters");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: safety lines -- smoke shows the disposable-folder warning, delivery shows the confirm-once-more warning, normal shows neither, and a smoke screen one level down still has the smoke line", async () => {
  const { fakeEnv } = createFakeEnv();
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-j", name: "J folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    // smoke top screen
    const smokeWork = "work-t7-j-smoke";
    const smokeOption = await stageBrowseAccount(fakeEnv, smokeWork, { smoke: true });
    await handleGoogleAccountSelection(fakeEnv, browseState(smokeWork), smokeOption);
    const smokeTop = drive.texts[0]!;
    assert.ok(smokeTop.includes("disposable"), `smoke top missing 'disposable': ${smokeTop}`);
    assert.ok(smokeTop.includes("never the production proposal folder"), `smoke top missing the folder warning: ${smokeTop}`);
    const smokeFolderValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;

    // delivery top screen
    const deliveryWork = "work-t7-j-delivery";
    const deliveryOption = await stageBrowseAccount(fakeEnv, deliveryWork, {
      delivery: true,
      docType: "sheet",
      title: "Report",
      content: "Report body",
      rows: [["Col"]],
    });
    await handleGoogleAccountSelection(fakeEnv, browseState(deliveryWork), deliveryOption);
    const deliveryTop = drive.texts[1]!;
    assert.ok(deliveryTop.includes("confirm once more"), `delivery top missing 'confirm once more': ${deliveryTop}`);

    // normal top screen
    const normalWork = "work-t7-j-normal";
    const normalOption = await stageBrowseAccount(fakeEnv, normalWork);
    await handleGoogleAccountSelection(fakeEnv, browseState(normalWork), normalOption);
    const normalTop = drive.texts[2]!;
    assert.ok(!normalTop.includes("disposable") && !normalTop.includes("confirm once more"), `normal top shows a safety line: ${normalTop}`);

    // smoke one level down still has the smoke line
    await handleGoogleFolderSelection(fakeEnv, browseState(smokeWork), smokeFolderValue);
    const smokeChild = drive.texts[drive.texts.length - 1]!;
    assert.ok(smokeChild.includes("disposable") && smokeChild.includes("never the production proposal folder"), `smoke child missing the smoke line: ${smokeChild}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 7: two levels deep -- the second opened screen's parentScreenId is the first opened screen's id", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t7-k";
  const folderId = "folder-k";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "K folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    const firstValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;

    await handleGoogleFolderSelection(fakeEnv, browseState(workId), firstValue);
    const firstScreenId = screenIdOf(drive.pickers[1]![0]);
    const first = storedScreen(mockKv, workId, firstScreenId);
    assert.strictEqual(first.parentScreenId, topScreenId, "level 1's parent is the top screen");

    const secondValue = parseCallbackData(String(drive.pickers[1]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), secondValue);
    const secondScreenId = screenIdOf(drive.pickers[2]![0]);
    const second = storedScreen(mockKv, workId, secondScreenId);
    assert.strictEqual(second.parentScreenId, firstScreenId, "level 2's parent is the first opened screen");
    assert.strictEqual(second.folderId, folderId);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

// ---------------------------------------------------------------------------
// Drive file browser (Task 8, Stage 1-2): the Back button.
// ---------------------------------------------------------------------------

/** Returns the index of the "⬅️ Back" row within a picker, or -1 when absent. */
const backRowOf = (picker: any[][]): number =>
  picker.findIndex((r) => r[0]?.text === "⬅️ Back");

/** Finds the picker row whose button shows `text` (e.g. "📁 C folder"). */
const rowWithText = (picker: any[][], text: string): any[] =>
  picker.find((r) => r[0]?.text === text)!;

test("Task 8: an opened folder screen has a Back row directly above Save here (Save last); the top screen has no Back button", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-a";
  const folderId = "folder-a";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "A folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    // Top screen: the folder item row, then Save here; no Back button.
    const topPicker = drive.pickers[0]!;
    assert.strictEqual(topPicker.length, 2, "top screen: folder item + Save here");
    assert.strictEqual(topPicker[0][0].text, "📁 A folder");
    assert.strictEqual(topPicker[1][0].text, "✅ Save here", "Save here is the last row on the top screen");
    assert.strictEqual(backRowOf(topPicker), -1, "no Back button on the top screen");

    // Open the folder.
    const value = parseCallbackData(String(topPicker[0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    // Opened screen: item row, then Back, then Save here (last).
    const opened = drive.pickers[1]!;
    assert.strictEqual(opened.length, 3, "opened screen: item, Back, Save here");
    assert.strictEqual(opened[0][0].text, "📁 A folder");
    const backIdx = backRowOf(opened);
    assert.strictEqual(backIdx, 1, "Back row directly above Save here");
    assert.strictEqual(opened[backIdx][0].text, "⬅️ Back");
    assert.strictEqual(opened[opened.length - 1][0].text, "✅ Save here", "Save here is the last row");
    const backScreenId = screenIdOf(opened[backIdx]);
    const childScreenId = screenIdOf(opened[0]);
    assert.strictEqual(backScreenId, childScreenId, "the Back button carries the opened screen's id");
    const child = storedScreen(mockKv, workId, childScreenId);
    assert.strictEqual(child.parentScreenId, screenIdOf(topPicker[0]), "child records the top screen as parent");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: Back from one level down re-shows My Drive with the top screen's own id, zero Drive/notion/storage activity", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-b";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-b", name: "B folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);

    // Open a folder.
    const openValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);

    // Baselines captured right before the Back tap (top screen + opened screen already exist).
    const beforeNotion = counters.notion;
    const beforeListing = counters.driveUrls.length;
    const writes = countOptionWrites(mockKv, workId);
    const beforeKeys = stagedOptionKeys(mockKv, workId);

    // Back from the opened screen (Back row, not the folder item row).
    const openedPicker = drive.pickers[1]!;
    const backValue = parseCallbackData(String(openedPicker[backRowOf(openedPicker)][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), backValue);

    // The re-shown screen names My Drive.
    const reshownText = drive.texts[drive.texts.length - 1]!;
    assert.ok(reshownText.includes("📂 *My Drive*"), `expected My Drive, got: ${reshownText}`);

    // The new picker carries the TOP screen's own id.
    const reshownPicker = drive.pickers[drive.pickers.length - 1]!;
    assert.strictEqual(screenIdOf(reshownPicker[0]), topScreenId, "re-shown screen uses the top screen's id");
    assert.strictEqual(backRowOf(reshownPicker), -1, "top screen shows only Save here (no Back)");

    // Zero Drive, notion, and storage activity during the Back tap.
    assert.strictEqual(counters.notion, beforeNotion, "zero api.notion.com requests during Back");
    assert.strictEqual(counters.driveUrls.length, beforeListing, "zero Drive calls during Back");
    assert.strictEqual(writes(), 0, "zero storage writes during Back");
    assert.deepStrictEqual(stagedOptionKeys(mockKv, workId), beforeKeys, "no new screen stored by Back");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: two levels down, then Back twice -> level-1 folder, then My Drive", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-c";
  const folderId = "folder-c";
  const childId = "folder-child-c";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: folderId, name: "C folder", mimeType: "application/vnd.google-apps.folder" },
          { id: childId, name: "C child", mimeType: "application/vnd.google-apps.folder" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);

    // Level 1: open C folder.
    const v1 = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📁 C folder")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), v1);
    const level1ScreenId = screenIdOf(drive.pickers[1]![0]);
    const level1 = storedScreen(mockKv, workId, level1ScreenId);
    assert.strictEqual(level1.folderId, folderId);
    assert.strictEqual(level1.parentScreenId, topScreenId);

    // Level 2: open C child (on the level-1 picker).
    const l1Picker = drive.pickers[1]!;
    const childValue = parseCallbackData(String(rowWithText(l1Picker, "📁 C child")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), childValue);
    const level2ScreenId = screenIdOf(drive.pickers[2]![0]);
    const level2 = storedScreen(mockKv, workId, level2ScreenId);
    assert.strictEqual(level2.folderId, childId);
    assert.strictEqual(level2.parentScreenId, level1ScreenId);

    // First Back -> level-1 folder.
    const l2Picker = drive.pickers[2]!;
    const back1 = parseCallbackData(String(l2Picker[backRowOf(l2Picker)][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), back1);
    const text1 = drive.texts[drive.texts.length - 1]!;
    assert.ok(text1.includes("📂 *C folder*"), `first Back should show C folder, got: ${text1}`);

    // Second Back -> My Drive.
    const l1Again = drive.pickers[drive.pickers.length - 1]!;
    const back2 = parseCallbackData(String(l1Again[backRowOf(l1Again)][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), back2);
    const text2 = drive.texts[drive.texts.length - 1]!;
    assert.ok(text2.includes("📂 *My Drive*"), `second Back should show My Drive, got: ${text2}`);
    assert.strictEqual(screenIdOf(drive.pickers[drive.pickers.length - 1]![0]), topScreenId, "final re-shown screen is the top screen");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: Back when the parent screen has expired -> has expired, zero Drive calls", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-d";
  const folderId = "folder-d";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "D folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    const openValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);
    const beforeListing = counters.driveUrls.length;

    // Expire the parent (top) screen.
    mockKv._rawStore.delete(`google_option:${workId}:${topScreenId}`);

    // Back from the opened screen (Back row).
    const openedPicker = drive.pickers[1]!;
    const backValue = parseCallbackData(String(openedPicker[backRowOf(openedPicker)][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), backValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `expected 'has expired', got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeListing, "ZERO Drive calls when parent expired");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: Back when the tapped screen has expired -> has expired", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-e";
  const folderId = "folder-e";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "E folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const openValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);
    const openedScreenId = screenIdOf(drive.pickers[1]![0]);
    const beforeListing = counters.driveUrls.length;

    // Expire the tapped (opened) screen.
    mockKv._rawStore.delete(`google_option:${workId}:${openedScreenId}`);

    const backValue = `${openedScreenId}:b`;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), backValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `expected 'has expired', got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeListing, "ZERO Drive calls when tapped screen expired");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: Back on a screen with no parent -> You're already at the top folder, zero Drive/storage", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-f";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({ listing: { body: { files: [] } } });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    const beforeListing = counters.driveUrls.length;
    const writes = countOptionWrites(mockKv, workId);

    const fullData = buildBrowseCallback(workId, topScreenId, { type: "back" });
    assert.ok(fullData, "top-screen back callback builds within the byte limit");
    const { value } = parseCallbackData(fullData!);
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), value);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("You're already at the top folder."), `expected top-folder message, got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeListing, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: after Back, tapping a folder on the re-shown screen still opens it (one listing call, new screen stored)", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-g";
  const folderId = "folder-g";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "G folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    const openValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);
    const backValue = parseCallbackData(String(drive.pickers[1]![backRowOf(drive.pickers[1]!)][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), backValue);
    const baseScreens = stagedOptionKeys(mockKv, workId).length;
    const listingBeforeReopen = counters.listing; // top-screen listing + the open listing above

    // Tap a folder on the re-shown top screen.
    const reshownPicker = drive.pickers[drive.pickers.length - 1]!;
    const folderValue = parseCallbackData(String(reshownPicker[0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), folderValue);

    const openedText = drive.texts[drive.texts.length - 1]!;
    assert.ok(openedText.includes("📂 *G folder*"), `re-opened folder not shown, got: ${openedText}`);
    const newScreenId = screenIdOf(drive.pickers[drive.pickers.length - 1]![0]);
    const opened = storedScreen(mockKv, workId, newScreenId);
    assert.strictEqual(opened.folderId, folderId);
    assert.strictEqual(opened.parentScreenId, topScreenId, "re-opened screen's parent is the re-shown top screen");
    assert.strictEqual(counters.listing, listingBeforeReopen + 1, "exactly one listing call when re-opening after Back");
    assert.strictEqual(stagedOptionKeys(mockKv, workId).length, baseScreens + 1, "a new screen was stored");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: smoke flow -> after Back, the smoke safety line (disposable) is still in the message", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t8-h";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId, { smoke: true });

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: "folder-h", name: "H folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const openValue = parseCallbackData(String(drive.pickers[0]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);

    const backValue = parseCallbackData(String(drive.pickers[1]![0][0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), backValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("disposable"), `smoke safety line missing after Back, got: ${last}`);
    assert.ok(last.includes("never the production proposal folder"), `smoke folder warning missing after Back, got: ${last}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 8: file and save taps still answer isn't available yet", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t8-i";
  const folderId = "folder-i";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: folderId, name: "I folder", mimeType: "application/vnd.google-apps.folder" },
          { id: "file-i", name: "notes.txt", mimeType: "text/plain" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📁 I folder")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);

    const beforeListing = counters.driveUrls.length;
    const writes = countOptionWrites(mockKv, workId);

    // File tap on the opened screen.
    const fileValue = parseCallbackData(String(rowWithText(drive.pickers[1]!, "📄 notes.txt")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);
    assert.ok(drive.texts[drive.texts.length - 1]!.includes("No Google Drive link is available for this file."), "file tap: expected 'No Google Drive link is available for this file.' (was 'isn't available yet')");

    // Save tap on the opened screen.
    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), saveValue);
    assert.ok(drive.texts[drive.texts.length - 1]!.includes("Create Google Doc"), "save tap: now leads into the Create Google Doc flow (was 'isn't available yet')");

    assert.strictEqual(counters.driveUrls.length, beforeListing, "ZERO Drive calls for file/save taps");
    assert.strictEqual(writes(), 0, "ZERO storage writes for file/save taps");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

// ---------------------------------------------------------------------------
// Drive file browser (Task 9): tapping a file to get its Drive link.
// ---------------------------------------------------------------------------

test("Task 9: tapping a file sends its name and an Open in Google Drive link", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t9-a";
  const fileId = "file-a";
  const fileLink = "https://drive.google.com/file/d/the-file-id/view";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: fileId, name: "notes.txt", mimeType: "text/plain", webViewLink: fileLink },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const beforeListing = counters.driveUrls.length;
    const beforeNotion = counters.notion;
    const writes = countOptionWrites(mockKv, workId);

    const folderScreenId = screenIdOf(drive.pickers[0]![0]);
    const fileValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📄 notes.txt")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("📄 *notes.txt*"), `expected file name, got: ${last}`);
    assert.ok(last.includes(`[Open in Google Drive](${fileLink})`), `expected Drive link, got: ${last}`);

    assert.strictEqual(counters.driveUrls.length, beforeListing, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
    assert.strictEqual(counters.notion, beforeNotion, "ZERO api.notion.com requests during the file tap");
    assert.deepStrictEqual(stagedOptionKeys(mockKv, workId), [`google_option:${workId}:${folderScreenId}`], "no screen changed");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: a file tap makes ZERO Drive calls, ZERO storage writes and ZERO api.notion.com requests", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t9-b";
  const fileId = "file-b";
  const fileLink = "https://drive.google.com/file/d/another-id/view?usp=sharing";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: fileId, name: "report.pdf", mimeType: "application/pdf", webViewLink: fileLink },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const baseListing = counters.driveUrls.length;
    const beforeNotion = counters.notion;
    const writes = countOptionWrites(mockKv, workId);
    const folderScreenId = screenIdOf(drive.pickers[0]![0]);

    const fileValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📄 report.pdf")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);

    assert.strictEqual(counters.driveUrls.length, baseListing, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
    assert.strictEqual(counters.notion, beforeNotion, "ZERO api.notion.com requests during the file tap");
    assert.deepStrictEqual(stagedOptionKeys(mockKv, workId), [`google_option:${workId}:${folderScreenId}`], "screen unchanged");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: after a file tap the same screen still works: tapping a folder opens it", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t9-c";
  const fileId = "file-c";
  const innerFolderId = "folder-inner-c";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: fileId, name: "data.csv", mimeType: "text/csv", webViewLink: "https://drive.google.com/file/d/csv/view" },
          { id: innerFolderId, name: "Inner folder", mimeType: "application/vnd.google-apps.folder" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);

    // File tap first.
    const fileValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📄 data.csv")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);

    // Tapping a folder on the same screen still opens it.
    const folderValue = parseCallbackData(
      String(rowWithText(drive.pickers[0]!, "📁 Inner folder")[0].callback_data),
    ).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), folderValue);

    const openedText = drive.texts[drive.texts.length - 1]!;
    assert.ok(openedText.includes("📂 *Inner folder*"), `inner folder not opened, got: ${openedText}`);
    const openedScreenId = screenIdOf(drive.pickers[drive.pickers.length - 1]![0]);
    const opened = storedScreen(mockKv, workId, openedScreenId);
    assert.strictEqual(opened.folderId, innerFolderId);
    assert.strictEqual(opened.parentScreenId, topScreenId);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: a file with no webViewLink -> No Google Drive link is available for this file", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t9-d";
  const fileId = "file-d";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: fileId, name: "orphan.txt", mimeType: "text/plain" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const beforeDrive = counters.driveUrls.length;
    const fileValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📄 orphan.txt")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("📄 *orphan.txt*"), `expected file name, got: ${last}`);
    assert.ok(last.includes("No Google Drive link is available for this file."), `expected no-link message, got: ${last}`);
    assert.ok(!last.includes("Open in Google Drive"), `no link should appear, got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: unsafe links give the No Google Drive link message", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t9-e";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: "file-unsafe-1", name: "http link.txt", mimeType: "text/plain", webViewLink: "http://evil.example.com/x" },
          { id: "file-unsafe-2", name: "paren link.txt", mimeType: "text/plain", webViewLink: "https://drive.google.com/file/d/x)y/view" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    const httpValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📄 http link.txt")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), httpValue);
    const httpText = drive.texts[drive.texts.length - 1]!;
    assert.ok(httpText.includes("No Google Drive link is available for this file."), `http link: expected no-link message, got: ${httpText}`);
    assert.ok(!httpText.includes("http://evil"), `bad http link must not appear, got: ${httpText}`);

    const parenValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📄 paren link.txt")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), parenValue);
    const parenText = drive.texts[drive.texts.length - 1]!;
    assert.ok(parenText.includes("No Google Drive link is available for this file."), `paren link: expected no-link message, got: ${parenText}`);
    assert.ok(!parenText.includes(")y"), `bad paren link must not appear, got: ${parenText}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: a file named Q4_plan *draft*.pdf escapes the name", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t9-f";
  const fileId = "file-f";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [{ id: fileId, name: "Q4_plan *draft*.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/q4/view" }],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const fileValue = parseCallbackData(
      String(rowWithText(drive.pickers[0]!, "📄 Q4_plan *draft*.pdf")[0].callback_data),
    ).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("Q4\\_plan \\*draft\\*.pdf"), `escaped name missing, got: ${last}`);
    assert.ok(last.includes(`[Open in Google Drive](https://drive.google.com/file/d/q4/view)`), `Drive link missing, got: ${last}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: a folder index and an out-of-range index -> That file is no longer available", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t9-g";
  const folderId = "folder-g";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [
          { id: folderId, name: "G folder", mimeType: "application/vnd.google-apps.folder" },
        ],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    const baseListing = counters.driveUrls.length;

    // Index pointing at a folder (kind !== file): build a "file" callback for index 0.
    const folderFileCallback = buildBrowseCallback(workId, topScreenId, { type: "file", index: 0 })!;
    const folderValue = parseCallbackData(folderFileCallback).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), folderValue);
    const folderText = drive.texts[drive.texts.length - 1]!;
    assert.ok(folderText.includes("That file is no longer available."), `folder index: expected not-available, got: ${folderText}`);

    // Out-of-range index.
    const outOfRangeValue = `${topScreenId}:f99`;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), outOfRangeValue);
    const rangeText = drive.texts[drive.texts.length - 1]!;
    assert.ok(rangeText.includes("That file is no longer available."), `out-of-range: expected not-available, got: ${rangeText}`);

    assert.strictEqual(counters.driveUrls.length, baseListing, "ZERO Drive calls");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: an expired screen id -> has expired", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t9-h";
  const folderId = "folder-h";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [{ id: folderId, name: "H folder", mimeType: "application/vnd.google-apps.folder" }],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    const beforeDrive = counters.driveUrls.length;

    // Expire the tapped screen.
    mockKv._rawStore.delete(`google_option:${workId}:${topScreenId}`);

    const fileValue = `${topScreenId}:f0`;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), fileValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `expected has expired, got: ${last}`);
    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 9: a file inside an opened subfolder sends its link", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t9-i";
  const folderId = "folder-i";
  const fileId = "file-i";
  const fileLink = "https://drive.google.com/file/d/subfile/view";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const pickers: any[][][] = [];
  const texts: string[] = [];
  let subListingCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("googleapis.com/drive/v3/files/root")) {
      return new Response(JSON.stringify({ id: "root-id", name: "My Drive" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("googleapis.com/drive/v3/files") && !s.includes("/root")) {
      const q = new URL(s).searchParams.get("q") ?? "";
      if (q.includes(`'${folderId}' in parents`)) {
        subListingCalls++;
        return new Response(JSON.stringify({ files: [{ id: fileId, name: "notes.txt", mimeType: "text/plain", webViewLink: fileLink }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (q === "'root-id' in parents and trashed=false") {
        return new Response(JSON.stringify({ files: [{ id: folderId, name: "I folder", mimeType: "application/vnd.google-apps.folder" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      texts.push(String(body.text ?? ""));
      if (body.reply_markup?.inline_keyboard) pickers.push(body.reply_markup.inline_keyboard);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);

    // Open the subfolder.
    const openValue = parseCallbackData(String(rowWithText(pickers[0]!, "📁 I folder")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), openValue);
    assert.strictEqual(subListingCalls, 1, "subfolder listing happened once");

    // Tap the file on the subfolder screen (parsed from its message).
    const subFileValue = parseCallbackData(String(rowWithText(pickers[1]!, "📄 notes.txt")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), subFileValue);

    const last = texts[texts.length - 1]!;
    assert.ok(last.includes("📄 *notes.txt*"), `subfolder file name missing, got: ${last}`);
    assert.ok(last.includes(`[Open in Google Drive](${fileLink})`), `subfolder Drive link missing, got: ${last}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Task 9: save taps still answer isn't available yet", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t9-j";
  const fileId = "file-j";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: {
      body: {
        files: [{ id: fileId, name: "link.txt", mimeType: "text/plain", webViewLink: "https://drive.google.com/file/d/l/view" }],
      },
    },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    await handleGoogleAccountSelection(fakeEnv, browseState(workId), opaqueOptionId);
    const saveValue = `${screenIdOf(drive.pickers[0]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, browseState(workId), saveValue);
    assert.ok(drive.texts[drive.texts.length - 1]!.includes("Create Google Doc"), "save tap: now leads into the Create Google Doc flow (was 'isn't available yet')");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

// ---------------------------------------------------------------------------
// Drive file browser (Task 10): ✅ Save here connects to the existing save flows.
// ---------------------------------------------------------------------------

test("Task 10: doc flow -> open a folder, tap Save -> pendingGoogleAction is create_doc with the chosen folderId", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t10-a";
  const folderId = "folder-a";
  const folderName = "A folder";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: folderName, mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, `📁 ${folderName}`)[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const beforeDrive = counters.driveUrls.length;
    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);

    assert.deepStrictEqual(state.pendingGoogleAction, {
      type: "create_doc",
      folderId,
      accountIdentifier: "user@enig.com",
      title: "Browse Doc",
      content: "Browse body",
    });

    const lastText = drive.texts[drive.texts.length - 1]!;
    assert.ok(lastText.includes("Create Google Doc"), `doc flow message missing, got: ${lastText}`);
    assert.ok(lastText.includes(`*Folder*: ${folderName}`), `folder name missing, got: ${lastText}`);

    const lastPicker = drive.pickers[drive.pickers.length - 1]!.flat();
    assert.ok(lastPicker.some((b: any) => String(b.callback_data).endsWith("googleaction:" + workId + ":approve")), "approve button missing");
    assert.ok(lastPicker.some((b: any) => String(b.callback_data).endsWith("googleaction:" + workId + ":reject")), "reject button missing");

    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls during save");
    assert.strictEqual(mockKv._rawStore.get(`google_option:${workId}:${screenIdOf(drive.pickers[1]![0])}`), undefined, "tapped screen consumed (deleted)");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: sheet flow -> pendingGoogleAction is create_sheet with the same rows and chosen folderId", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t10-b";
  const folderId = "folder-b";
  const folderName = "B folder";
  const rows = [["Date", "Task"], ["2026-01", "Review"]];
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId, { docType: "sheet", rows });

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: folderName, mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, `📁 ${folderName}`)[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);

    assert.deepStrictEqual(state.pendingGoogleAction, {
      type: "create_sheet",
      folderId,
      accountIdentifier: "user@enig.com",
      title: "Browse Doc",
      rows,
    });

    const lastText = drive.texts[drive.texts.length - 1]!;
    assert.ok(lastText.includes("Create Google Sheet"), `sheet flow message missing, got: ${lastText}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: delivery flow -> stored delivery_confirm option has the chosen folderId/folderName/accountIdentifier/title; outputdelivery buttons; NO pendingGoogleAction", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t10-c";
  const folderId = "folder-c";
  const folderName = "C folder";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId, {
    delivery: true,
    docType: "sheet",
    title: "Report",
    content: "Report body",
    rows: [["Col"]],
  });

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: folderName, mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, `📁 ${folderName}`)[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);

    assert.strictEqual(state.pendingGoogleAction, undefined, "no pendingGoogleAction for delivery flow");

    const lastPicker = drive.pickers[drive.pickers.length - 1]!.flat();
    const confirmBtn = lastPicker.find((b: any) => String(b.callback_data).startsWith("outputdelivery:" + workId + ":"));
    const dismissBtn = lastPicker.find((b: any) => String(b.callback_data) === "outputdelivery:" + workId + ":dismiss");
    assert.ok(confirmBtn, "delivery confirm button missing");
    assert.ok(dismissBtn, "delivery dismiss button missing");

    const confirmOpaqueId = String(confirmBtn.callback_data).split(":")[2]!;
    const stored = storedScreen(mockKv, workId, confirmOpaqueId);
    assert.strictEqual(stored.kind, "delivery_confirm");
    assert.strictEqual(stored.folderId, folderId);
    assert.strictEqual(stored.folderName, folderName);
    assert.strictEqual(stored.accountIdentifier, "user@enig.com");
    assert.strictEqual(stored.title, "Report");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: smoke flow -> pendingSmokeSelection has the chosen folderId; smoke_confirm stored; googlesmokeconfirm buttons; NO googleaction buttons", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t10-d";
  const folderId = "folder-d";
  const folderName = "D folder";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId, { smoke: true });

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: folderName, mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, `📁 ${folderName}`)[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);

    assert.ok(state.pendingSmokeSelection, "smoke selection pending");
    assert.strictEqual(state.pendingSmokeSelection!.folderId, folderId);
    assert.strictEqual(state.pendingSmokeSelection!.accountIdentifier, "user@enig.com");
    assert.strictEqual(state.pendingSmokeSelection!.folderName, folderName);

    const lastPicker = drive.pickers[drive.pickers.length - 1]!.flat();
    const smokeBtn = lastPicker.find((b: any) => String(b.callback_data).startsWith("googlesmokeconfirm:" + workId + ":"));
    assert.ok(smokeBtn, "smoke confirm button missing");
    assert.ok(!lastPicker.some((b: any) => String(b.callback_data).includes("googleaction:")), "no googleaction buttons for smoke flow");

    const confirmOpaqueId = String(smokeBtn.callback_data).split(":")[2]!;
    const stored = storedScreen(mockKv, workId, confirmOpaqueId);
    assert.strictEqual(stored.kind, "smoke_confirm");
    assert.strictEqual(stored.folderId, folderId);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: Save on the top screen -> folderId equals the fake root id (not 'root') and folder name 'My Drive'", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t10-e";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({ listing: { body: { files: [] } } });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);
    assert.strictEqual(drive.pickers[0]!.length, 1, "top screen: only Save here");
    assert.ok(drive.texts[0].includes("📂 *My Drive*"), `top screen names My Drive, got: ${drive.texts[0]}`);

    const saveValue = `${topScreenId}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);
    assert.ok(state.pendingGoogleAction, "save set pendingGoogleAction");
    assert.strictEqual(state.pendingGoogleAction!.folderId, BROWSE_ROOT_ID, "top-screen save binds the real root id");
    assert.notStrictEqual(state.pendingGoogleAction!.folderId, "root", "top-screen save must not bind the shortcut 'root'");
    const lastText = drive.texts[drive.texts.length - 1]!;
    assert.ok(lastText.includes("*Folder*: My Drive"), `folder name missing, got: ${lastText}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: a Save tap makes ZERO Drive calls", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t10-f";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const counters = { notion: 0, listing: 0, driveUrls: [] as string[] };
  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({ listing: { body: { files: [] } } });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, counters);

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const beforeDrive = counters.driveUrls.length;
    const saveValue = `${screenIdOf(drive.pickers[0]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);

    assert.strictEqual(counters.driveUrls.length, beforeDrive, "ZERO Drive calls during save");
    assert.ok(drive.texts[drive.texts.length - 1]!.includes("Create Google Doc"), "save led to the doc flow");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: single use -> a second Save tap on the same screen answers 'has expired', pendingGoogleAction unchanged", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t10-g";
  const folderId = "folder-g";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "G folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📁 G folder")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);
    const firstAction = state.pendingGoogleAction;
    assert.ok(firstAction, "first save set pendingGoogleAction");

    await handleGoogleFolderSelection(fakeEnv, state, saveValue);
    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `second save expected has expired, got: ${last}`);
    assert.deepStrictEqual(state.pendingGoogleAction, firstAction, "pendingGoogleAction unchanged by second save");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: an expired screen id -> has expired, nothing pending", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const workId = "work-t10-h";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({ listing: { body: { files: [] } } });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const topScreenId = screenIdOf(drive.pickers[0]![0]);

    mockKv._rawStore.delete(`google_option:${workId}:${topScreenId}`);

    const saveValue = `${topScreenId}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);

    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `expected has expired, got: ${last}`);
    assert.strictEqual(state.pendingGoogleAction, undefined, "nothing pending for expired screen");
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("Task 10: end to end -> after Save in the doc flow, approving creates the doc in the chosen folder", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t10-i";
  const folderId = "folder-i";
  const folderName = "I folder";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  let createdParents: string[] | null = null;
  let sentTelegramText = "";
  const pickers: any[][][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      if (body.reply_markup?.inline_keyboard) pickers.push(body.reply_markup.inline_keyboard);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (s.includes("api.notion.com")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s === "https://www.googleapis.com/drive/v3/files" && (init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body));
      createdParents = body.parents;
      return new Response(JSON.stringify({ id: "created-doc-id" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("docs.googleapis.com/v1/documents") && s.includes(":batchUpdate")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (s.includes("docs.googleapis.com/v1/documents/")) {
      const docJson = '{"title":"Browse Doc","body":{"content":[{"paragraph":{"elements":[{"textRun":{"content":"Browse body"}}]}}]}}';
      return new Response(docJson, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("googleapis.com/drive/v3/files/root")) {
      return new Response(JSON.stringify({ id: "root-id-abc123", name: "My Drive" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("googleapis.com/drive/v3/files")) {
      return new Response(JSON.stringify({ files: [{ id: folderId, name: folderName, mimeType: "application/vnd.google-apps.folder" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(pickers[0]!, `📁 ${folderName}`)[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const saveValue = `${screenIdOf(pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);
    assert.ok(state.pendingGoogleAction, "save set pendingGoogleAction");

    const updatedState = await handleGoogleActionApproval(fakeEnv, state, true);
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "approval consumed the action");
    assert.deepStrictEqual(createdParents, [folderId], `create request parents should be [${folderId}], got: ${JSON.stringify(createdParents)}`);
    assert.ok(sentTelegramText.includes("created and verified successfully"), `approval success message missing, got: ${sentTelegramText}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Task 10: save from level 1, then Back on the level-1 screen's old message answers 'has expired' (screen consumed)", async () => {
  const { fakeEnv } = createFakeEnv();
  const workId = "work-t10-j";
  const folderId = "folder-j";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-browse", refresh_token: "refresh-browse", expires_in: 3600 },
    "user@enig.com",
  );
  const opaqueOptionId = await stageBrowseAccount(fakeEnv, workId);

  const realFetch = globalThis.fetch;
  const drive = installBrowseFake({
    listing: { body: { files: [{ id: folderId, name: "J folder", mimeType: "application/vnd.google-apps.folder" }] } },
  });
  const driveFetch = globalThis.fetch;
  globalThis.fetch = notionAwareFetch(driveFetch, { notion: 0, listing: 0, driveUrls: [] });

  try {
    const state = browseState(workId);
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    const openValue = parseCallbackData(String(rowWithText(drive.pickers[0]!, "📁 J folder")[0].callback_data)).value;
    await handleGoogleFolderSelection(fakeEnv, state, openValue);

    const saveValue = `${screenIdOf(drive.pickers[1]![0])}:s`;
    await handleGoogleFolderSelection(fakeEnv, state, saveValue);
    assert.ok(state.pendingGoogleAction, "level-1 save set pendingGoogleAction");
    const level1ScreenId = screenIdOf(drive.pickers[1]![0]);

    const backValue = `${level1ScreenId}:b`;
    await handleGoogleFolderSelection(fakeEnv, state, backValue);
    const last = drive.texts[drive.texts.length - 1]!;
    assert.ok(last.includes("has expired"), `Back on consumed screen expected has expired, got: ${last}`);
  } finally {
    globalThis.fetch = realFetch;
    drive.restore();
  }
});

test("R2-3: a '<screenId>:r0' tap answers 'isn't available yet', with ZERO Drive calls and ZERO storage writes", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "tok", refresh_token: "r", expires_in: 3600 }, "user@enig.com");
  const workId = "work-r2-3-e";
  const state: WorkState = {
    workId,
    chatId: 1,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let driveCalls = 0;
  let sentText = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("api.telegram.org")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sentText = body?.text ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (s.includes("googleapis.com/drive/v3/files")) driveCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const saved = await saveBrowseScreen(fakeEnv, workId, {
      kind: "drivebrowse",
      folderId: "folder-999",
      folderName: "Brand Assets",
      items: [],
      truncated: false,
      context: { accountIdentifier: "user@enig.com", title: "x", content: "y" },
    });
    assert.strictEqual(saved.ok, true);
    const writes = countOptionWrites(mockKv, workId);
    const value = `${saved.screenId}:r0`;
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, value);
    assert.strictEqual(updatedState, state, "state is unchanged");
    assert.ok(sentText.includes("isn't available yet"), `expected 'isn't available yet', got: ${sentText}`);
    assert.strictEqual(driveCalls, 0, "ZERO Drive calls");
    assert.strictEqual(writes(), 0, "ZERO storage writes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
