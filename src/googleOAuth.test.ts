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
import type { WorkState } from "./types";
import type { FolderClaimStatus } from "./googleFolderClaim";

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

/**
 * Mock Stage 4A claim methods for tests. Defaults: no existing claim (status
 * undefined), claim succeeds (returns true), resolve is a no-op. Overrides
 * let tests simulate existing markers and lost races.
 */
function createMockClaims(overrides?: {
  getFolderClaimStatus?: (opaqueId: string) => Promise<FolderClaimStatus | undefined>;
  claimFolderOption?: (opaqueId: string) => Promise<boolean>;
  resolveFolderClaim?: (opaqueId: string, status: "completed" | "failed") => Promise<void>;
}): {
  getFolderClaimStatus: (opaqueId: string) => Promise<FolderClaimStatus | undefined>;
  claimFolderOption: (opaqueId: string) => Promise<boolean>;
  resolveFolderClaim: (opaqueId: string, status: "completed" | "failed") => Promise<void>;
} {
  return {
    getFolderClaimStatus: overrides?.getFolderClaimStatus ?? (async () => undefined),
    claimFolderOption: overrides?.claimFolderOption ?? (async () => true),
    resolveFolderClaim: overrides?.resolveFolderClaim ?? (async () => {}),
  };
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

    // Verify callback data carries the staged list's opaque id plus a POSITION
    // into it -- never the raw folder id (Martin, 2026-11-18: the list is
    // staged as ONE option, not one per folder).
    const folderCallback = sentButtons[0][0].callback_data;
    assert.match(folderCallback, /^googlefolder:work-picker-100:[a-f0-9-]+:\d+$/);
    assert.strictEqual(folderCallback.includes("folder-id-abc"), false);

    // The callback carries the staged list's own opaque id (the account
    // option was consumed by handleGoogleAccountSelection, so peek the LIST
    // id, not the account id). The list survives paging: peek, not consume.
    const listOpaqueId = folderCallback.split(":")[2]!;
    const replayOption = await peekOpaqueOption(fakeEnv, workId, listOpaqueId);
    assert.ok(replayOption, "the folder list survives paging (peek, not consume)");
    assert.ok(Array.isArray(replayOption.folders) && replayOption.folders.length === 2);
    // Tapping a folder consumes the list: a replayed button cannot re-pick. The
    // handler receives the value segment (index.ts splits callback_data as
    // action:workId:value), i.e. "<listOpaqueId>:<position>".
    await handleGoogleFolderSelection(fakeEnv, state, folderCallback.split(":").slice(2).join(":"), createMockClaims());
    const gone = await peekOpaqueOption(fakeEnv, workId, listOpaqueId);
    assert.strictEqual(gone, null, "the list is consumed once a folder is picked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Folder picker follows Google Drive API pagination (nextPageToken) and accumulates all folders", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-pagination-300";
  await persistGoogleTokens(
    fakeEnv,
    { access_token: "token-paginate", refresh_token: "refresh-paginate", expires_in: 3600 },
    "paginate@enig.com",
  );

  const opaqueOptionId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "account",
    accountIdentifier: "paginate@enig.com",
    title: "Paginated Doc",
    content: "Test pagination",
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let page1 = true;
  let page2 = false;

  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("drive/v3/files")) {
      if (page1) {
        page1 = false;
        page2 = true;
        return new Response(
          JSON.stringify({
            files: [
              { id: "folder-1", name: "A First Folder" },
              { id: "folder-2", name: "B Second Folder" },
            ],
            nextPageToken: "page-token-2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (page2) {
        page2 = false;
        return new Response(
          JSON.stringify({
            files: [
              { id: "folder-3", name: "C Third Folder" },
              { id: "folder-4", name: "D Fourth Folder" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (u.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptionId);
    // The test passes if the handler completes without error and the list
    // is staged. The actual verification of all 4 folders being present
    // is done by checking the staged option.
    const store: Map<string, { value: string; expirationTtl?: number }> = mockKv._rawStore;
    let foundList = false;
    let totalFolders = 0;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        foundList = true;
        const option = JSON.parse(value.value);
        totalFolders = option.folders?.length ?? 0;
        break;
      }
    }
    assert.ok(foundList, "folderlist option was staged");
    assert.equal(totalFolders, 4, "all 4 folders from both pages are accumulated");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Folder selection sets pending action and emits proposal with approve/reject buttons", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-proposal-200";
  // The list is staged as ONE folderlist option (Martin, 2026-11-18); the
  // callback carries the list's opaque id plus the picked folder's POSITION,
  // so the handler resolves the pick from the list rather than from a
  // per-folder option.
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "selected@enig.com",
    title: "Brand Guidelines",
    content: "Guidelines for ENIG brand assets.",
    folders: [{ id: "folder-999", name: "Brand Assets" }],
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
    // index.ts splits callback_data as action:workId:value, so the handler
    // receives "<listOpaqueId>:0" -- the list id followed by the position.
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, createMockClaims());

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

test("Stale and replayed folder selections are rejected -- single-use folder list", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-stale-folder-400";
  // Stage a folderlist option directly
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "stale@enig.com",
    title: "Stale Test",
    content: "Testing stale selection",
    folders: [
      { id: "folder-1", name: "Folder One" },
      { id: "folder-2", name: "Folder Two" },
    ],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  // Stateful mock claims: tracks claim status between calls within this test.
  let claimStatus: FolderClaimStatus | undefined = undefined;
  const claims = {
    getFolderClaimStatus: async (_opaqueId: string) => claimStatus,
    claimFolderOption: async (_opaqueId: string) => {
      if (claimStatus) return false;
      claimStatus = "claimed";
      return true;
    },
    resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
      claimStatus = status;
    },
  };

  try {
    // First pick: position 0 (Folder One)
    await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);
    assert.match(sentTelegramText, /Folder One/);
    assert.match(sentTelegramText, /stale@enig.com/);

    // The list should now be consumed (deleted)
    const store: Map<string, { value: string; expirationTtl?: number }> = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, false, "folder list is consumed after first pick");

    // Replay attempt: same button tapped again.
    // Claim status is now "completed" → silently ignored, no Telegram message.
    sentTelegramText = "";
    await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);
    assert.strictEqual(sentTelegramText, "", "replay after completed claim should be silent");

    // Second pick (position 1) on already-consumed list → still silent (claim blocks it)
    sentTelegramText = "";
    await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:1`, claims);
    assert.strictEqual(sentTelegramText, "", "replay on different position should be silent");

    // Out-of-bounds position → still silent (claim blocks it before validation)
    sentTelegramText = "";
    await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:99`, claims);
    assert.strictEqual(sentTelegramText, "", "out-of-bounds on consumed list should be silent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Two genuinely overlapping folder-selection callbacks: exactly one wins", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-concurrent-folder-700";
  // Stage a folderlist option directly
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "concurrent@enig.com",
    title: "Concurrent Test",
    content: "Testing concurrent selection",
    folders: [
      { id: "folder-1", name: "Folder One" },
      { id: "folder-2", name: "Folder Two" },
    ],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const sentTelegramTexts: string[] = [];
  let claimCalledCount = 0;

  // Barrier: both callbacks must reach claimFolderOption before either proceeds.
  // This creates a genuine overlap: both pass peek+validation before either
  // attempts the atomic claim.
  let releaseClaims: (() => void) | null = null;
  const claimBarrier = new Promise<void>((resolve) => {
    releaseClaims = resolve;
  });

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramTexts.push(body.text || "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Stateful claims with barrier around claimFolderOption.
    let claimStatus: FolderClaimStatus | undefined = undefined;
    const claims = {
      getFolderClaimStatus: async (_opaqueId: string) => claimStatus,
      claimFolderOption: async (_opaqueId: string) => {
        claimCalledCount++;
        await claimBarrier; // Both callbacks wait here before deciding the winner
        if (claimStatus) return false;
        claimStatus = "claimed";
        return true;
      },
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        claimStatus = status;
      },
    };

    // Launch both callbacks concurrently — they overlap through peek+validation
    // before either reaches the atomic claim. Start both without awaiting so
    // they are in-flight simultaneously.
    const p1 = handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);
    const p2 = handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:1`, claims);

    // Yield to the event loop so both callbacks reach the claimBarrier.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Release the barrier so both can proceed past claimFolderOption.
    releaseClaims!();

    await Promise.allSettled([p1, p2]);

    // Both callbacks attempted the claim (genuine overlap).
    assert.strictEqual(claimCalledCount, 2, "both callbacks reached the atomic claim");

    // Exactly one Telegram message was sent (the winner). The loser sent
    // nothing — it returned silently without any Telegram message.
    assert.strictEqual(
      sentTelegramTexts.length,
      1,
      "exactly one Telegram message sent (winner only; loser silent)",
    );
    const successMessage = sentTelegramTexts[0];
    assert.match(successMessage, /Folder One|Folder Two/, "winner message names a folder");
    assert.match(successMessage, /concurrent@enig.com/, "winner message names the account");

    // Exactly one option was consumed.
    const store: Map<string, { value: string; expirationTtl?: number }> = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, false, "folder list is consumed after concurrent picks");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Out-of-bounds position rejected while folder list still exists", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-oob-folder-700";
  // Stage a folderlist option directly
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "oob@enig.com",
    title: "Out of Bounds Test",
    content: "Testing out of bounds selection",
    folders: [
      { id: "folder-1", name: "Folder One" },
    ],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Attempt out-of-bounds position while list still exists (position 99, only 1 folder)
    await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:99`, createMockClaims());
    assert.match(sentTelegramText, /no longer current/);

    // List should still exist (not consumed on invalid pick)
    const store: Map<string, { value: string; expirationTtl?: number }> = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "folder list NOT consumed on invalid pick");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Expired folder selection state is rejected (TTL expiry)", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-expired-folder-500";
  // Stage a folderlist option with very short TTL (1 second)
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "expired@enig.com",
    title: "Expired Test",
    content: "Testing expired selection",
    folders: [{ id: "folder-x", name: "Folder X" }],
  });

  // Manually expire it by deleting from store (simulating TTL expiry)
  // The mock KV doesn't auto-expire, so we delete directly
  await mockKv.delete(`google_option:${workId}:${listOpaqueId}`);

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Attempt to select from expired/missing option
    await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, createMockClaims());
    assert.match(sentTelegramText, /invalid or expired/);
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

// ---------------------------------------------------------------------------
// Stage 4B claim integration tests
// ---------------------------------------------------------------------------

test("Stage 4B: existing claimed marker → callback silently ignored", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-claimed-1";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "claimed@enig.com",
    title: "Claimed Test",
    content: "Testing claimed marker",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Claim status is "claimed" → silently ignored before any peek or consume.
    const claims = {
      getFolderClaimStatus: async () => "claimed" as const,
      claimFolderOption: async () => {
        throw new Error("claimFolderOption must not be called when claim exists");
      },
      resolveFolderClaim: async () => {
        throw new Error("resolveFolderClaim must not be called when claim exists");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(sentTelegramText, "", "claimed marker: no Telegram message sent");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "claimed marker: no pending action created");

    // Option must not be consumed
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "claimed marker: option NOT consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: existing completed marker → callback silently ignored", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-completed-1";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "completed@enig.com",
    title: "Completed Test",
    content: "Testing completed marker",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const claims = {
      getFolderClaimStatus: async () => "completed" as const,
      claimFolderOption: async () => {
        throw new Error("claimFolderOption must not be called when claim exists");
      },
      resolveFolderClaim: async () => {
        throw new Error("resolveFolderClaim must not be called when claim exists");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(sentTelegramText, "", "completed marker: no Telegram message sent");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "completed marker: no pending action created");

    // Option must not be consumed
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "completed marker: option NOT consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: existing failed marker → callback silently ignored", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-failed-1";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "failed@enig.com",
    title: "Failed Test",
    content: "Testing failed marker",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const claims = {
      getFolderClaimStatus: async () => "failed" as const,
      claimFolderOption: async () => {
        throw new Error("claimFolderOption must not be called when claim exists");
      },
      resolveFolderClaim: async () => {
        throw new Error("resolveFolderClaim must not be called when claim exists");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(sentTelegramText, "", "failed marker: no Telegram message sent");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "failed marker: no pending action created");

    // Option must not be consumed
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "failed marker: option NOT consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: missing or expired option → Workspace notification, no claim, no consumption", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-missing-1";
  // Do NOT stage any option — it's missing/expired

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, "nonexistent:0", claims);

    assert.match(sentTelegramText, /invalid or expired/, "missing option: Workspace notification sent");
    assert.strictEqual(claimCalled, false, "missing option: claim NOT attempted");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "missing option: no pending action");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: malformed option → Workspace notification, no claim, no consumption", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-malformed-1";
  // Stage a non-folderlist option
  const opaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "account",
    accountIdentifier: "malformed@enig.com",
    title: "Not a folder list",
    content: "This is not a folderlist option",
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${opaqueId}:0`, claims);

    assert.match(sentTelegramText, /invalid or expired/, "malformed option: Workspace notification sent");
    assert.strictEqual(claimCalled, false, "malformed option: claim NOT attempted");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "malformed option: no pending action");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: invalid folder index → Workspace notification, no claim, no consumption", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-invalid-1";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "invalid@enig.com",
    title: "Invalid Index Test",
    content: "Testing invalid folder index",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    // Position 99 is out of bounds (only 1 folder at index 0)
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:99`, claims);

    assert.match(sentTelegramText, /no longer current/, "invalid index: Workspace notification sent");
    assert.strictEqual(claimCalled, false, "invalid index: claim NOT attempted");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "invalid index: no pending action");

    // Option must NOT be consumed
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "invalid index: option NOT consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: first valid callback → claims, consumes once, continues once, preserves data", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-claim-valid-1";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "valid@enig.com",
    title: "Valid Test Doc",
    content: "Valid test content for document creation",
    folders: [{ id: "folder-valid-1", name: "Valid Folder" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";
  let sentButtons: any[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      sentButtons = body.reply_markup?.inline_keyboard || [];
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCalled = false;
    let resolveCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        resolveCalled = true;
        assert.strictEqual(status, "completed", "claim resolved as completed");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(claimCalled, true, "valid callback: claim attempted");
    assert.strictEqual(resolveCalled, true, "valid callback: claim resolved as completed");
    assert.match(sentTelegramText, /Valid Folder/, "valid callback: folder name in message");
    assert.match(sentTelegramText, /valid@enig.com/, "valid callback: account in message");
    assert.match(sentTelegramText, /Valid Test Doc/, "valid callback: title in message");
    assert.strictEqual(
      updatedState.pendingGoogleAction?.title,
      "Valid Test Doc",
      "valid callback: pending action title preserved",
    );
    assert.strictEqual(
      updatedState.pendingGoogleAction?.folderId,
      "folder-valid-1",
      "valid callback: pending action folderId preserved",
    );
    assert.strictEqual(
      updatedState.pendingGoogleAction?.accountIdentifier,
      "valid@enig.com",
      "valid callback: pending action accountIdentifier preserved",
    );
    assert.strictEqual(
      sentButtons[0][0].callback_data,
      `googleaction:${workId}:approve`,
      "valid callback: approve button present",
    );
    assert.strictEqual(
      sentButtons[0][1].callback_data,
      `googleaction:${workId}:reject`,
      "valid callback: reject button present",
    );

    // Option must be consumed
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, false, "valid callback: option consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Stage 4C failure-handling tests
// ---------------------------------------------------------------------------

test("Stage 4C: failure before option consumption — claim resolved as failed, no consumption", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-consume-fail";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "consume-fail@enig.com",
    title: "Consume Fail Test",
    content: "Testing consume failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Make kvGet throw only on the consume call (second kvGet), not the peek
  // call (first kvGet). consumeOpaqueOption reads then deletes; peek only
  // reads. We want consume to throw so the claim is resolved as failed.
  const originalGet = mockKv.get.bind(mockKv);
  let getCallCount = 0;
  mockKv.get = async (key: string) => {
    getCallCount++;
    if (key.startsWith(`google_option:${workId}:`) && getCallCount >= 2) {
      throw new Error("KV read failed on consume");
    }
    return originalGet(key);
  };

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
        if (status === "completed") resolveCompletedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(resolveFailedCalled, true, "claim resolved as failed after consume error");
    assert.strictEqual(resolveCompletedCalled, false, "claim NOT resolved as completed");
    assert.match(sentTelegramText, /failed while reading/, "Workspace notification about consume failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after consume failure");

    // Option still exists (consume threw before delete)
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "option NOT consumed when consume threw");
  } finally {
    mockKv.get = originalGet;
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: failure after consumption, before confirmation staging — claim resolved as failed", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-stage-fail";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    smoke: true,
    docType: "doc",
    accountIdentifier: "stage-fail@enig.com",
    title: "Stage Fail Test",
    content: "Testing staging failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Make kvPut throw so saveOpaqueOption throws (staging fails)
  const originalPut = mockKv.put.bind(mockKv);
  mockKv.put = async (key: string, value: string, options?: { expirationTtl?: number }) => {
    if (key.startsWith(`google_option:${workId}:`) && value.includes("smoke_confirm")) {
      throw new Error("KV write failed");
    }
    return originalPut(key, value, options);
  };

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
        if (status === "completed") resolveCompletedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(resolveFailedCalled, true, "claim resolved as failed after staging error");
    assert.strictEqual(resolveCompletedCalled, false, "claim NOT resolved as completed");
    assert.match(sentTelegramText, /persist the smoke confirmation/, "Workspace notification about staging failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after staging failure");
    assert.strictEqual(updatedState.pendingSmokeSelection, undefined, "no pending smoke selection after staging failure");

    // Option was consumed (consume succeeded before staging)
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, false, "option WAS consumed");
  } finally {
    mockKv.put = originalPut;
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: Telegram delivery failure after confirmation staged — claim resolved as failed, user notified", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-telegram-fail";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "telegram-fail@enig.com",
    title: "Telegram Fail Test",
    content: "Testing Telegram delivery failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Make the FIRST telegram chunk fail on BOTH Markdown and plain-text
  // attempts (confirmed rejection). The notification call from
  // resolveClaimFailed succeeds.
  let telegramCallCount = 0;
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      telegramCallCount++;
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      if (telegramCallCount <= 2) {
        return new Response(JSON.stringify({ ok: false, description: "Internal Server Error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
        if (status === "completed") resolveCompletedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(resolveFailedCalled, true, "claim resolved as failed after Telegram delivery failure");
    assert.strictEqual(resolveCompletedCalled, false, "claim NOT resolved as completed");
    assert.match(sentTelegramText, /could not be delivered/, "Workspace notification about Telegram failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action when Telegram failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: Telegram delivery success, then logActivity failure — claim completed despite logActivity swallowing error", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-notion-fail";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "notion-fail@enig.com",
    title: "Notion Fail Test",
    content: "Testing logActivity failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Telegram succeeds. notion (logActivity) returns 401 but logActivity
  // catches its own errors and never throws, so the claim completes normally.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("notion.com")) {
      return new Response(JSON.stringify({ object: "error", status: 401, message: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
        if (status === "completed") resolveCompletedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    // logActivity catches its own errors, so the claim completes normally
    assert.strictEqual(resolveFailedCalled, false, "claim NOT resolved as failed (logActivity swallows errors)");
    assert.strictEqual(resolveCompletedCalled, true, "claim resolved as completed despite logActivity error");
    assert.match(sentTelegramText, /Proposed Action.*Create Google Doc/, "proposal was delivered to user");
    assert.strictEqual(updatedState.pendingGoogleAction?.title, "Notion Fail Test", "state persisted despite logActivity error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: claim resolution failure — claim left as claimed, user notified", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-resolve-fail";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "resolve-fail@enig.com",
    title: "Resolve Fail Test",
    content: "Testing claim resolution failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
        if (status === "completed") resolveCompletedCalled = true;
        // Always throw — claim resolution fails
        throw new Error("DO storage write failed");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(resolveCompletedCalled, true, "attempted to resolve as completed (resolve throws, so claim stays claimed)");
    assert.strictEqual(resolveFailedCalled, false, "claim was NOT resolved as failed (resolveClaimFailed not called in success path)");
    // Telegram was delivered (proposal shown), so the workflow progressed
    // despite claim resolution failure. State should have pendingGoogleAction.
    assert.strictEqual(updatedState.pendingGoogleAction?.title, "Resolve Fail Test", "state preserved despite resolve failure");
    assert.match(sentTelegramText, /Proposed Action.*Create Google Doc/, "proposal was delivered to user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: duplicate callback while original claim is active — silently ignored", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-duplicate-active";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "duplicate@enig.com",
    title: "Duplicate Active Test",
    content: "Testing duplicate while active",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimStatus: "claimed" | "completed" | "failed" | undefined = "claimed";
    const claims = {
      getFolderClaimStatus: async () => claimStatus,
      claimFolderOption: async () => {
        throw new Error("claimFolderOption must not be called when claim is active");
      },
      resolveFolderClaim: async () => {
        throw new Error("resolveFolderClaim must not be called when claim is active");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(sentTelegramText, "", "duplicate while active: silent ignore");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "duplicate while active: no new action");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: duplicate callback after completion — silently ignored, no expired-option notification", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-duplicate-complete";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "duplicate-complete@enig.com",
    title: "Duplicate Complete Test",
    content: "Testing duplicate after completion",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // Claim is "completed" — duplicate should be silently ignored
    const claims = {
      getFolderClaimStatus: async () => "completed" as const,
      claimFolderOption: async () => {
        throw new Error("claimFolderOption must not be called after completion");
      },
      resolveFolderClaim: async () => {
        throw new Error("resolveFolderClaim must not be called after completion");
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(sentTelegramText, "", "duplicate after completion: silent ignore");
    assert.match(sentTelegramText, /^$/, "no expired-option notification for completed claim");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "duplicate after completion: no new action");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: recoverable failure followed by fresh selection succeeds", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-recover";
  const firstOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "recover@enig.com",
    title: "First Selection",
    content: "First attempt",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // First attempt: Telegram returns a confirmed rejection (HTTP 500) on BOTH
  // Markdown and plain-text attempts. The notification call from
  // resolveClaimFailed succeeds. Second attempt: all calls succeed.
  let telegramCallCount = 0;
  let firstAttemptDone = false;
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      telegramCallCount++;
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      if (!firstAttemptDone && telegramCallCount <= 2) {
        return new Response(JSON.stringify({ ok: false, description: "Internal Server Error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    // First attempt fails (Telegram delivery fails)
    let resolveFailedCalled = false;
    const claims1 = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
      },
    };

    await handleGoogleFolderSelection(fakeEnv, state, `${firstOpaqueId}:0`, claims1);
    firstAttemptDone = true;
    assert.strictEqual(resolveFailedCalled, true, "first attempt: claim resolved as failed");
    assert.match(sentTelegramText, /could not be delivered/, "first attempt: Telegram failure notification");

    // Second attempt: fresh selection with new opaqueId succeeds
    const secondOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
      kind: "folderlist",
      docType: "doc",
      accountIdentifier: "recover@enig.com",
      title: "Second Selection",
      content: "Second attempt succeeds",
      folders: [{ id: "folder-2", name: "Folder Two" }],
    });

    let claimResolvedCompleted = false;
    const claims2 = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "completed") claimResolvedCompleted = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${secondOpaqueId}:0`, claims2);

    assert.strictEqual(claimResolvedCompleted, true, "second attempt: claim resolved as completed");
    assert.strictEqual(updatedState.pendingGoogleAction?.title, "Second Selection", "second attempt: fresh selection succeeds");
    assert.match(sentTelegramText, /Folder Two/, "second attempt: new folder in message");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: uncertain remote operation does not trigger blind retry", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-uncertain";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "uncertain@enig.com",
    title: "Uncertain Test",
    content: "Testing uncertain operation",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Telegram delivery is uncertain (returns 500 without throwing).
  // sendMessageCore retries with plain text, still fails, returns delivered: false.
  // No blind retry of the claim happens.
  let telegramCallCount = 0;
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      telegramCallCount++;
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: false, description: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let claimCallCount = 0;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCallCount++;
        return true;
      },
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    // Claim attempted exactly once — no blind retry
    assert.strictEqual(claimCallCount, 1, "claim attempted exactly once — no blind retry");
    assert.strictEqual(resolveFailedCalled, true, "claim resolved as failed after uncertain delivery");
    assert.match(sentTelegramText, /could not be delivered/, "Workspace notification about uncertain delivery");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action when delivery uncertain");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: Telegram network exception — unknown delivery outcome, state preserved", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-telegram-unknown";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "telegram-unknown@enig.com",
    title: "Telegram Unknown Test",
    content: "Testing unknown delivery outcome",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // First telegram call throws (network exception → unknown outcome).
  // Second call (from any notification) succeeds.
  let telegramCallCount = 0;
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      telegramCallCount++;
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      if (telegramCallCount === 1) {
        throw new Error("Telegram network exception");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") resolveFailedCalled = true;
        if (status === "completed") resolveCompletedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    // Unknown outcome: claim NOT resolved as failed, state preserved,
    // no user-facing failure message (delivery could not be confirmed as failed).
    assert.strictEqual(resolveFailedCalled, false, "claim NOT resolved as failed on unknown outcome");
    assert.strictEqual(resolveCompletedCalled, false, "claim NOT resolved as completed on unknown outcome");
    assert.strictEqual(updatedState.pendingGoogleAction?.title, "Telegram Unknown Test", "state preserved — pendingGoogleAction not cleared");
    assert.strictEqual(updatedState.pendingActionSummary !== undefined, true, "state preserved — pendingActionSummary not cleared");
    // No failure notification was sent for the unknown outcome.
    assert.match(sentTelegramText, /Proposed Action.*Create Google Doc/, "proposal message was delivered (or attempted), not a failure notice");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: status lookup throwing before any option read or claim", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-status-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "status-throw@enig.com",
    title: "Status Throw Test",
    content: "Testing status lookup failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => {
        throw new Error("DO storage read failed");
      },
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    // Track consume via KV: if peek threw, consume should never be reached.
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(claimCalled, false, "claimFolderOption NOT called after status lookup failure");
    assert.match(sentTelegramText, /could not be verified/, "Workspace notification about status lookup failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after status lookup failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: folder-option peek throwing before claim or consumption", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;
  const originalGet = mockKv.get.bind(mockKv);

  const workId = "work-4c-peek-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "peek-throw@enig.com",
    title: "Peek Throw Test",
    content: "Testing peek failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Make kvGet throw on google_option keys (peek fails).
  mockKv.get = async (key: string) => {
    if (key.startsWith(`google_option:${workId}:`)) {
      throw new Error("KV read failed on peek");
    }
    return originalGet(key);
  };

  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(claimCalled, false, "claimFolderOption NOT called after peek failure");
    assert.match(sentTelegramText, /could not be read/, "Workspace notification about peek failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after peek failure");
  } finally {
    mockKv.get = originalGet;
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: claim acquisition throwing without consuming the option", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-claim-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "claim-throw@enig.com",
    title: "Claim Throw Test",
    content: "Testing claim acquisition failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        throw new Error("DO transaction failed");
      },
      resolveFolderClaim: async () => {},
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.match(sentTelegramText, /could not be verified/, "Workspace notification about claim acquisition failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after claim acquisition failure");

    // Option must NOT be consumed (claim failed before consume).
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "option NOT consumed when claim acquisition threw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: uncertain claim acquisition outcome without blind retry", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-claim-uncertain";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "claim-uncertain@enig.com",
    title: "Claim Uncertain Test",
    content: "Testing uncertain claim acquisition",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let claimCallCount = 0;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCallCount++;
        throw new Error("DO transaction uncertain outcome");
      },
      resolveFolderClaim: async () => {},
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(claimCallCount, 1, "claim attempted exactly once — no blind retry on uncertain outcome");
    assert.match(sentTelegramText, /could not be verified/, "Workspace notification about uncertain claim outcome");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after uncertain claim outcome");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: Workspace notification transport failure without uncaught exception", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-notify-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "notify-throw@enig.com",
    title: "Notify Throw Test",
    content: "Testing notification transport failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // All telegram fetch calls throw — including the notification attempt
  // from notifyWorkspaceTaskError. The exception must be caught internally
  // and never escape to generic WorkSession/Operations handling.
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    throw new Error("Telegram transport failure");
  }) as typeof fetch;

  try {
    const claims = {
      getFolderClaimStatus: async () => {
        throw new Error("DO storage read failed");
      },
      claimFolderOption: async () => true,
      resolveFolderClaim: async () => {},
    };

    // Should not throw — notification transport failure is caught internally.
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action when notification transport failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: completed claim resolution failure — diagnostic logged, user not told proposal failed", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-resolve-complete-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "resolve-complete-throw@enig.com",
    title: "Resolve Complete Throw Test",
    content: "Testing completed claim resolution failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Telegram delivery succeeds. resolveFolderClaim throws on "completed".
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveCompletedCalled = false;
    let resolveFailedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "completed") {
          resolveCompletedCalled = true;
          throw new Error("DO storage write failed on completed");
        }
        if (status === "failed") resolveFailedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(resolveCompletedCalled, true, "resolve as completed was attempted");
    assert.strictEqual(resolveFailedCalled, false, "claim NOT resolved as failed");
    // State preserved (proposal handoff succeeded).
    assert.strictEqual(updatedState.pendingGoogleAction?.title, "Resolve Complete Throw Test", "state preserved after complete-resolution failure");
    // User was NOT told the proposal failed — the Telegram handoff succeeded.
    assert.match(sentTelegramText, /Proposed Action.*Create Google Doc/, "proposal message delivered to user, not a failure notice");
    // Claim remains "claimed" (not resolved) — protected against duplicates.
    assert.strictEqual(updatedState.pendingActionSummary !== undefined, true, "pendingActionSummary preserved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4C: failed claim resolution failure — diagnostic logged, user notified anyway", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4c-resolve-fail-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "resolve-fail-throw@enig.com",
    title: "Resolve Fail Throw Test",
    content: "Testing failed claim resolution failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let sentTelegramText = "";

  // Telegram delivery fails (confirmed rejection). resolveFolderClaim throws on "failed".
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    const u = String(_url);
    if (u.includes("api.telegram.org")) {
      const body = _init?.body ? JSON.parse(String(_init.body)) : {};
      sentTelegramText = body.text || "";
      return new Response(JSON.stringify({ ok: false, description: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    let resolveFailedCalled = false;
    let resolveCompletedCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => true,
      resolveFolderClaim: async (_opaqueId: string, status: "completed" | "failed") => {
        if (status === "failed") {
          resolveFailedCalled = true;
          throw new Error("DO storage write failed on failed");
        }
        if (status === "completed") resolveCompletedCalled = true;
      },
    };

    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:0`, claims);

    assert.strictEqual(resolveFailedCalled, true, "resolve as failed was attempted");
    assert.strictEqual(resolveCompletedCalled, false, "claim NOT resolved as completed");
    // User-facing notification was still sent despite resolve failure.
    assert.match(sentTelegramText, /could not be delivered/, "Workspace notification about delivery failure sent despite resolve failure");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "no pending action after delivery failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: missing/expired option — Workspace notification transport throws, no claim, no consumption", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4b-missing-throw";
  // Do NOT stage any option — it's missing/expired

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // All Telegram fetch calls throw — including the notification attempt from
  // notifyWorkspaceTaskError. The exception must be caught internally and never
  // escape to generic WorkSession/Operations handling.
  globalThis.fetch = (async () => {
    throw new Error("Telegram transport failure");
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    // Should not throw — notification transport failure is caught internally.
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, "nonexistent:0", claims);

    assert.strictEqual(claimCalled, false, "missing option: claim NOT attempted when transport throws");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "missing option: no pending action");

    // Option must NOT be consumed (nothing was staged, so nothing to consume).
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`)) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, false, "missing option: nothing consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stage 4B: out-of-bounds folder position — Workspace notification transport throws, no claim, no consumption", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  const workId = "work-4b-oob-throw";
  const listOpaqueId = await saveOpaqueOption(fakeEnv, workId, {
    kind: "folderlist",
    docType: "doc",
    accountIdentifier: "oob-throw@enig.com",
    title: "OOB Throw Test",
    content: "Testing out-of-bounds with transport failure",
    folders: [{ id: "folder-1", name: "Folder One" }],
  });

  const state: WorkState = {
    workId,
    chatId: 12345,
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // All Telegram fetch calls throw — including the notification attempt from
  // notifyWorkspaceTaskError. The exception must be caught internally.
  globalThis.fetch = (async () => {
    throw new Error("Telegram transport failure");
  }) as typeof fetch;

  try {
    let claimCalled = false;
    const claims = {
      getFolderClaimStatus: async () => undefined,
      claimFolderOption: async () => {
        claimCalled = true;
        return true;
      },
      resolveFolderClaim: async () => {},
    };

    // Position 99 is out of bounds (only 1 folder at index 0).
    // Should not throw — notification transport failure is caught internally.
    const updatedState = await handleGoogleFolderSelection(fakeEnv, state, `${listOpaqueId}:99`, claims);

    assert.strictEqual(claimCalled, false, "out-of-bounds: claim NOT attempted when transport throws");
    assert.strictEqual(updatedState.pendingGoogleAction, undefined, "out-of-bounds: no pending action");

    // Option must NOT be consumed — invalid selection never triggers consume.
    const store = mockKv._rawStore;
    let listExists = false;
    for (const [key, value] of store.entries()) {
      if (key.startsWith(`google_option:${workId}:`) && value.value.includes("folderlist")) {
        listExists = true;
        break;
      }
    }
    assert.strictEqual(listExists, true, "out-of-bounds: option NOT consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
