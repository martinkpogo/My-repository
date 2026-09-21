import test from "node:test";
import assert from "node:assert";
import type { Env } from "./types";
import {
  buildGoogleAuthorizeUrl,
  cleanupDefaultGoogleAccount,
  codeChallengeFromVerifier,
  columnLetter,
  consumeOpaqueOption,
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
  saveOpaqueOption,
  testGoogleDriveConnection,
  handleGoogleDriveTest,
} from "./googleOAuth";
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

test("GET /oauth/google/start requires key parameter matching TELEGRAM_WEBHOOK_SECRET", async () => {
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
      `https://enig-agent.martnkpogo.workers.dev/oauth/google/start?key=${fakeEnv.TELEGRAM_WEBHOOK_SECRET}`,
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

  let driveQueryCalled = false;
  let sentButtons: any[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      driveQueryCalled = true;
      assert.ok(urlStr.includes("mimeType%3D%27application%2Fvnd.google-apps.folder%27"));
      return new Response(
        JSON.stringify({
          files: [
            { id: "folder-id-abc", name: "Client Proposals" },
            { id: "folder-id-xyz", name: "Internal Notes" },
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
    assert.strictEqual(driveQueryCalled, true);
    assert.ok(sentButtons.length >= 2);

    // Verify callback data contains ONLY opaque folder option IDs (no raw folder ID)
    const folderCallback = sentButtons[0][0].callback_data;
    assert.match(folderCallback, /^googlefolder:work-picker-100:[a-f0-9-]+$/);
    assert.strictEqual(folderCallback.includes("folder-id-abc"), false);

    // Verify option is consumed / single-use
    const replayOption = await consumeOpaqueOption(fakeEnv, workId, opaqueOptionId);
    assert.strictEqual(replayOption, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Folder selection sets pending action and emits proposal with approve/reject buttons", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-proposal-200";
  const opaqueFolderId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folder",
    accountIdentifier: "selected@enig.com",
    title: "Brand Guidelines",
    content: "Guidelines for ENIG brand assets.",
    folderId: "folder-999",
    folderName: "Brand Assets",
  });

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
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, opaqueFolderId);

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
      `https://enig-agent.martnkpogo.workers.dev/admin/test-google-drive?key=${fakeEnv.TELEGRAM_WEBHOOK_SECRET}`,
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
    if (urlStr.includes("/values/") && (!init || init.method === undefined || init.method === "GET")) {
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
