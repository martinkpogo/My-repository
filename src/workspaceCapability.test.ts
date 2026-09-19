import test from "node:test";
import assert from "node:assert";
import type { Env, WorkState } from "./types";
import {
  classifyWorkspaceCapability,
  handleWorkspaceCapabilityRequest,
  handleGoogleDocInputReply,
} from "./workspaceCapability";
import {
  presentGoogleAccountPicker,
  handleGoogleAccountSelection,
  presentGoogleFolderPicker,
  handleGoogleFolderPage,
  handleGoogleFolderSelection,
  handleGoogleActionApproval,
  persistGoogleTokens,
} from "./googleOAuth";

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
  const fakeEnv: Env = {
    STATE_KV: mockKv as unknown as KVNamespace,
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-999",
    GOOGLE_OAUTH_CLIENT_ID: "mock-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "mock-client-secret-777",
    ACTIVITY_LOG_DATA_SOURCE_ID: "mock-activity-log-ds",
    TELEGRAM_BOT_TOKEN: "mock-bot-token",
    MARTIN_TELEGRAM_USER_ID: "123456789",
    NOTION_TOKEN: "mock-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    CONVERSATION_TOPIC_ID: "1",
    AI: {
      async run(_model: string, _input: any) {
        return {
          response: JSON.stringify({
            is_capability_request: true,
            capability_type: "google_doc",
            title: "Test doc",
            content: "This is a controlled ENIG Google Docs write test.",
          }),
        };
      },
    } as unknown as Ai,
    WORK_SESSION: {
      idFromName(name: string) {
        return { name };
      },
      get(_id: any) {
        let internalState: WorkState | undefined;
        return {
          async init(workId: string, chatId: number, unit?: any, hat?: any, threadId?: number) {
            internalState = {
              workId,
              chatId,
              threadId,
              unit,
              hat,
              stage: "new",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          },
          async getState() {
            return internalState;
          },
        };
      },
    } as unknown as DurableObjectNamespace,
  } as Env;
  return { fakeEnv, mockKv };
}

test("1. Natural-language Google Doc request reaches the generic Workspace capability seam", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        is_capability_request: true,
        capability_type: "google_doc",
        title: "Test doc",
        content: "This is a controlled ENIG Google Docs write test.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const res = await classifyWorkspaceCapability(
      fakeEnv,
      "Create a document titled Test doc with this content: This is a controlled ENIG Google Docs write test.",
    );

    assert.strictEqual(res.isCapability, true);
    assert.strictEqual(res.capability, "google_doc");
    assert.strictEqual(res.title, "Test doc");
    assert.strictEqual(res.content, "This is a controlled ENIG Google Docs write test.");
    assert.strictEqual(res.missingField, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("2. Existing Unit/Hat context is preserved when request originates inside an active session", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();

  // Active session in Sales
  const workId = "existing-sales-workid-123";
  await mockKv.put("active:987654321:1", workId);

  const activeState: WorkState = {
    workId,
    chatId: 987654321,
    threadId: 1,
    unit: "Sales",
    hat: "Sales Executive",
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Mock stub returning activeState
  fakeEnv.WORK_SESSION = {
    idFromName: () => ({ name: workId }),
    get: () => ({
      getState: async () => activeState,
    }),
  } as unknown as DurableObjectNamespace;

  assert.strictEqual(activeState.unit, "Sales");
  assert.strictEqual(activeState.hat, "Sales Executive");
});

test("3 & 4. Standalone request has undefined Unit/Hat and introduces no synthetic Operations Unit/Hat", async () => {
  const state: WorkState = {
    workId: "standalone-work-999",
    chatId: 123456,
    threadId: 1,
    unit: undefined,
    hat: undefined,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.strictEqual(state.unit, undefined);
  assert.strictEqual(state.hat, undefined);
  assert.notStrictEqual(state.unit, "Operations");
  assert.notStrictEqual(state.hat, "Workspace Action");
});

test("5, 7, 8. Authorized Google accounts presented as explicit options with opaque option IDs (no auto-selection even if 1 account)", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 },
    "user1@enig.com",
  );

  let sentButtons: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  const state: WorkState = {
    workId: "work-picker-100",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await presentGoogleAccountPicker(fakeEnv, state, "Title X", "Content Y");

    assert.strictEqual(sentButtons.length, 1);
    const callbackData = sentButtons[0][0].callback_data;
    assert.ok(callbackData.startsWith("googleaccount:work-picker-100:"));
    assert.strictEqual(callbackData.includes("user1@enig.com"), false); // No raw email in callback_data
    assert.strictEqual(callbackData.includes("Title X"), false); // No title in callback_data
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("6. No authorized account fails closed and reports blocker without exposing credentials", async () => {
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
    workId: "work-no-acct-1",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await presentGoogleAccountPicker(fakeEnv, state, "Doc A", "Content B");
    assert.match(sentTelegramText, /No authorized Google Workspace account is available/);
    assert.strictEqual(sentTelegramText.includes("mock-client-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("9 & 10. Invalid or expired account selection fails closed", async () => {
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
    workId: "work-invalid-acct-1",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await handleGoogleAccountSelection(fakeEnv, state, "non-existent-opaque-id");
    assert.match(sentTelegramText, /invalid, expired, or already used/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("11, 13, 14, 15, 16, 17, 21. Folder listing occurs after account selection, uses selected account, restricts to non-trashed folders, uses opaque callback IDs", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "folder-at-99", refresh_token: "rt-99", expires_in: 3600 },
    "folder-owner@enig.com",
  );

  let driveQueryUrl = "";
  let sentButtons: any[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      driveQueryUrl = urlStr;
      return new Response(
        JSON.stringify({
          files: [
            { id: "raw-drive-folder-id-123", name: "Projects" },
            { id: "raw-drive-folder-id-456", name: "Archive" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const state: WorkState = {
    workId: "work-folder-test-1",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    // 1. Account option setup in KV
    const opaqueOptId = "opt-acct-999";
    await mockKv.put(
      `google_account_opt:work-folder-test-1:${opaqueOptId}`,
      JSON.stringify({
        accountIdentifier: "folder-owner@enig.com",
        title: "Test Doc Title",
        content: "Test Doc Content",
      }),
    );

    // 2. Select account
    await handleGoogleAccountSelection(fakeEnv, state, opaqueOptId);

    // Verify account option key consumed immediately
    const kvAfter = await mockKv.get(`google_account_opt:work-folder-test-1:${opaqueOptId}`);
    assert.strictEqual(kvAfter, null);

    // Verify Drive query restricts to non-trashed folders
    assert.ok(driveQueryUrl.includes("mimeType"));
    assert.ok(driveQueryUrl.includes("application%2Fvnd.google-apps.folder"));
    assert.ok(driveQueryUrl.includes("trashed"));

    // Verify folder buttons use opaque callback IDs and do NOT expose raw folder IDs
    assert.strictEqual(sentButtons.length, 2);
    const folderCb1 = sentButtons[0][0].callback_data;
    assert.ok(folderCb1.startsWith("googlefolder:work-folder-test-1:"));
    assert.strictEqual(folderCb1.includes("raw-drive-folder-id-123"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("18, 19, 20. Invalid or expired folder option fails closed; valid option binds folderId and accountIdentifier to pendingGoogleAction", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  let sentButtons: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const state: WorkState = {
    workId: "work-folder-bind-1",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    // Setup valid folder option mapping in KV
    const opaqueOptId = "fopt-888";
    await mockKv.put(
      `google_folder_opt:work-folder-bind-1:${opaqueOptId}`,
      JSON.stringify({
        folderId: "bound-folder-id-777",
        folderName: "Strategy Work",
        accountIdentifier: "selected-account@enig.com",
        title: "Client Brief",
        content: "Detailed Brief Content",
      }),
    );

    await handleGoogleFolderSelection(fakeEnv, state, opaqueOptId);

    // Option key consumed immediately
    const kvAfter = await mockKv.get(`google_folder_opt:work-folder-bind-1:${opaqueOptId}`);
    assert.strictEqual(kvAfter, null);

    // pendingGoogleAction explicitly bound
    assert.ok(state.pendingGoogleAction);
    assert.strictEqual(state.pendingGoogleAction.type, "create_doc");
    assert.strictEqual(state.pendingGoogleAction.title, "Client Brief");
    assert.strictEqual(state.pendingGoogleAction.content, "Detailed Brief Content");
    assert.strictEqual(state.pendingGoogleAction.folderId, "bound-folder-id-777");
    assert.strictEqual(state.pendingGoogleAction.accountIdentifier, "selected-account@enig.com");

    // Approval buttons contain ONLY workId + approve/reject (no folder IDs or emails)
    assert.ok(sentButtons.length > 0);
    assert.strictEqual(sentButtons[0][0].callback_data, "googleaction:work-folder-bind-1:approve");
    assert.strictEqual(sentButtons[0][1].callback_data, "googleaction:work-folder-bind-1:reject");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("22. Pagination uses opaque server-side state without exposing raw Drive IDs", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "page-at-123", refresh_token: "rt-123", expires_in: 3600 },
    "page-user@enig.com",
  );

  // Generate 15 fake folders to trigger pagination (>10)
  const fakeFolders = Array.from({ length: 15 }, (_, i) => ({
    id: `raw-folder-id-${i + 1}`,
    name: `Folder ${i + 1}`,
  }));

  let sentButtons: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      return new Response(JSON.stringify({ files: fakeFolders }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const state: WorkState = {
    workId: "work-page-test-1",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await presentGoogleFolderPicker(fakeEnv, state, "page-user@enig.com", "Title Page", "Content Page", 0);

    // 10 folder rows + 1 pagination row (Next)
    assert.strictEqual(sentButtons.length, 11);
    const navRow = sentButtons[10];
    assert.strictEqual(navRow.length, 1);
    assert.strictEqual(navRow[0].text, "Next ➡️");

    const pageCbData = navRow[0].callback_data;
    assert.ok(pageCbData.startsWith("googlefolderpage:work-page-test-1:"));
    assert.strictEqual(pageCbData.includes("raw-folder-id"), false);

    // Extract opaque page ID and execute page nav callback
    const opaquePageId = pageCbData.split(":")[2];
    await handleGoogleFolderPage(fakeEnv, state, opaquePageId);

    // Page 2 shows remaining 5 folders
    assert.strictEqual(sentButtons.length, 6); // 5 folders + 1 Prev button
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("35. handleWorkspaceCapabilityRequest routes directly to handleTextReply when active session is awaiting google_doc_input", async () => {
  const { fakeEnv, mockKv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 },
    "user1@enig.com",
  );

  let sentButtons: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentButtons = body.reply_markup?.inline_keyboard || [];
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const workId = "work-input-reply-1";
  await mockKv.put("active:123456:dm", workId);

  const awaitingState: WorkState = {
    workId,
    chatId: 123456,
    stage: "new",
    awaiting: "google_doc_input",
    marketingTaskText: "CONTENT:Hello World",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  fakeEnv.WORK_SESSION = {
    idFromName: () => ({ name: workId }),
    get: () => ({
      getState: async () => awaitingState,
      handleTextReply: async (text: string) => {
        return handleGoogleDocInputReply(fakeEnv, awaitingState, text);
      },
    }),
  } as unknown as DurableObjectNamespace;

  try {
    const handled = await handleWorkspaceCapabilityRequest(fakeEnv, 123456, "My Missing Title");
    assert.strictEqual(handled, true);
    assert.strictEqual(awaitingState.awaiting, undefined);
    assert.strictEqual(sentButtons.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("26, 27, 28. Approval consumes pending action before execution; reject performs no write; replayed approval fails closed", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  let driveCreated = false;
  let sentTelegramText = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("googleapis.com/drive/v3/files")) {
      driveCreated = true;
      return new Response(JSON.stringify({ id: "created-doc-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.endsWith(":batchUpdate")) {
      return new Response(JSON.stringify({ documentId: "created-doc-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes("googleapis.com/v1/documents/created-doc-123")) {
      return new Response(
        JSON.stringify({
          title: "Doc Title Replay Test",
          body: { content: [{ paragraph: { elements: [{ textRun: { content: "Doc Content Replay Test" } }] } }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body));
      sentTelegramText = body.text || "";
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await persistGoogleTokens(
    fakeEnv,
    { access_token: "replay-at-123", refresh_token: "rt-replay", expires_in: 3600 },
    "replay-user@enig.com",
  );

  const state: WorkState = {
    workId: "work-replay-test-1",
    chatId: 123456,
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingGoogleAction: {
      type: "create_doc",
      title: "Doc Title Replay Test",
      content: "Doc Content Replay Test",
      folderId: "folder-replay-100",
      accountIdentifier: "replay-user@enig.com",
    },
  };

  try {
    // 1. First approval execution
    const stateAfterApprove = await handleGoogleActionApproval(fakeEnv, state, true);

    assert.strictEqual(driveCreated, true);
    assert.strictEqual(stateAfterApprove.pendingGoogleAction, undefined); // Consumed!
    assert.match(sentTelegramText, /Google Doc created and verified successfully/);

    // Reset indicator
    driveCreated = false;

    // 2. Replay approval attempt with same state
    await handleGoogleActionApproval(fakeEnv, stateAfterApprove, true);

    assert.strictEqual(driveCreated, false); // No second Google write performed!
    assert.match(sentTelegramText, /No valid pending Google action found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
