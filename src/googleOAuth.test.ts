import test from "node:test";
import assert from "node:assert";
import type { Env } from "./types";
import {
  buildGoogleAuthorizeUrl,
  codeChallengeFromVerifier,
  generateCodeVerifier,
  generateState,
  getValidGoogleAccessToken,
  GOOGLE_OAUTH_SCOPES,
  handleGoogleOAuthCallback,
  handleGoogleOAuthStart,
  handleTestGoogleDriveConnection,
  loadGoogleTokens,
  parseAccountIdentifierFromIdToken,
  persistGoogleTokens,
  testGoogleDriveConnection,
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
    GOOGLE_OAUTH_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "mock-google-client-secret-777",
    ACTIVITY_LOG_DATA_SOURCE_ID: "mock-activity-log-ds",
    TELEGRAM_BOT_TOKEN: "mock-bot-token",
    MARTIN_TELEGRAM_USER_ID: "123456789",
    NOTION_TOKEN: "mock-notion-token",
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

  // Verify exact minimum scopes
  assert.strictEqual(
    GOOGLE_OAUTH_SCOPES,
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/spreadsheets.readonly",
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

test("testGoogleDriveConnection fails safely when account is unauthorized or credentials missing", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })) as typeof fetch;

  try {
    const result = await testGoogleDriveConnection(fakeEnv, "unauthorized@enig.com");

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.accountIdentifier, "unauthorized@enig.com");
    assert.strictEqual(result.error, "Google Workspace is not authorized or credentials missing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("testGoogleDriveConnection verifies read access against Google Drive API with valid tokens", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  // Stash active valid token in KV
  await fakeEnv.STATE_KV.put(
    "google_oauth_tokens:admin@enig.com",
    JSON.stringify({
      access_token: "active-google-access-token-100",
      refresh_token: "active-google-refresh-token-100",
      expires_at: Date.now() + 3600_000,
      updated_at: new Date().toISOString(),
    }),
  );

  let driveApiCalled = false;
  let authHeaderUsed = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.startsWith("https://www.googleapis.com/drive/v3/files")) {
      driveApiCalled = true;
      authHeaderUsed = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          files: [
            {
              id: "google-doc-id-001",
              name: "ENIG Strategy Note",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await testGoogleDriveConnection(fakeEnv, "admin@enig.com");

    assert.strictEqual(driveApiCalled, true);
    assert.strictEqual(authHeaderUsed, "Bearer active-google-access-token-100");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.accountIdentifier, "admin@enig.com");
    assert.strictEqual(result.apiEndpoint, "https://www.googleapis.com/drive/v3/files");
    assert.strictEqual(result.filesFound, 1);
    assert.deepStrictEqual(result.sampleFile, {
      id: "google-doc-id-001",
      name: "ENIG Strategy Note",
      mimeType: "application/vnd.google-apps.document",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("testGoogleDriveConnection auto-refreshes near-expired tokens before making API request", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  // Stash near-expiry token (< 30s remaining)
  await fakeEnv.STATE_KV.put(
    "google_oauth_tokens:admin@enig.com",
    JSON.stringify({
      access_token: "expiring-access-token-001",
      refresh_token: "stored-refresh-token-001",
      expires_at: Date.now() + 5000,
      updated_at: new Date().toISOString(),
    }),
  );

  let tokenRefreshCalled = false;
  let driveAuthHeader = "";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr === "https://oauth2.googleapis.com/token") {
      tokenRefreshCalled = true;
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access-token-777",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.startsWith("https://www.googleapis.com/drive/v3/files")) {
      driveAuthHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await testGoogleDriveConnection(fakeEnv, "admin@enig.com");

    assert.strictEqual(tokenRefreshCalled, true);
    assert.strictEqual(driveAuthHeader, "Bearer refreshed-access-token-777");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.filesFound, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("testGoogleDriveConnection handles Google API HTTP errors without exposing credentials", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await fakeEnv.STATE_KV.put(
    "google_oauth_tokens:admin@enig.com",
    JSON.stringify({
      access_token: "secret-bearer-token-888",
      refresh_token: "secret-refresh-token-888",
      expires_at: Date.now() + 3600_000,
      updated_at: new Date().toISOString(),
    }),
  );

  const loggedMessages: string[] = [];

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.startsWith("https://www.googleapis.com/drive/v3/files")) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: "The caller does not have permission",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    if (init?.body) {
      loggedMessages.push(String(init.body));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await testGoogleDriveConnection(fakeEnv, "admin@enig.com");

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "Google Drive API request failed: 403 (The caller does not have permission)");

    for (const msg of loggedMessages) {
      assert.strictEqual(msg.includes("secret-bearer-token-888"), false, "Access token must not appear in logs");
      assert.strictEqual(msg.includes("secret-refresh-token-888"), false, "Refresh token must not appear in logs");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /admin/test-google-drive requires TELEGRAM_WEBHOOK_SECRET and returns structured status", async () => {
  const { fakeEnv } = createFakeEnv();
  const originalFetch = globalThis.fetch;

  await fakeEnv.STATE_KV.put(
    "google_oauth_tokens:default",
    JSON.stringify({
      access_token: "valid-admin-token",
      refresh_token: "valid-admin-refresh-token",
      expires_at: Date.now() + 3600_000,
      updated_at: new Date().toISOString(),
    }),
  );

  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith("https://www.googleapis.com/drive/v3/files")) {
      return new Response(JSON.stringify({ files: [{ id: "f1", name: "Doc1", mimeType: "text/plain" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    // 1. Missing secret key -> 403
    const reqUnauth = new Request("https://enig-agent.martnkpogo.workers.dev/admin/test-google-drive");
    const resUnauth = await handleTestGoogleDriveConnection(reqUnauth, fakeEnv);
    assert.strictEqual(resUnauth.status, 403);

    // 2. Wrong key -> 403
    const reqBadKey = new Request("https://enig-agent.martnkpogo.workers.dev/admin/test-google-drive?key=invalid");
    const resBadKey = await handleTestGoogleDriveConnection(reqBadKey, fakeEnv);
    assert.strictEqual(resBadKey.status, 403);

    // 3. Valid key -> 200 JSON with test result
    const reqAuth = new Request(`https://enig-agent.martnkpogo.workers.dev/admin/test-google-drive?key=${fakeEnv.TELEGRAM_WEBHOOK_SECRET}`);
    const resAuth = await handleTestGoogleDriveConnection(reqAuth, fakeEnv);
    assert.strictEqual(resAuth.status, 200);

    const body = (await resAuth.json()) as any;
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.accountIdentifier, "default");
    assert.strictEqual(body.filesFound, 1);
    assert.strictEqual(body.sampleFile.name, "Doc1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
