import type { Env } from "./types";
import { logActivity } from "./log";
import { sendOperationsMessage } from "./telegram";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");

export interface StoredGoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  account_identifier?: string;
  updated_at: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildGoogleAuthorizeUrl(
  env: Env,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  prompt = "consent",
): string {
  const params = new URLSearchParams({
    client_id: requireGoogleClientId(env),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
  });
  if (prompt) {
    params.append("prompt", prompt);
  }
  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

export function parseAccountIdentifierFromIdToken(idToken?: string): string {
  if (!idToken) return "default";
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return "default";
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson) as { email?: string; sub?: string };
    return payload.email || payload.sub || "default";
  } catch {
    return "default";
  }
}

export function getGoogleTokensKvKey(accountIdentifier = "default"): string {
  const sanitized = accountIdentifier.trim() || "default";
  return `google_oauth_tokens:${sanitized}`;
}

export async function exchangeGoogleCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ accountIdentifier: string; expires_in: number }> {
  const tokenData = await googleTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: requireGoogleClientId(env),
    client_secret: requireGoogleClientSecret(env),
  });

  const accountIdentifier = parseAccountIdentifierFromIdToken(tokenData.id_token);
  await persistGoogleTokens(env, tokenData, accountIdentifier);
  return { accountIdentifier, expires_in: tokenData.expires_in };
}

export async function isGoogleAuthorized(
  env: Env,
  accountIdentifier = "default",
): Promise<boolean> {
  return (await loadGoogleTokens(env, accountIdentifier)) !== null;
}

export async function loadGoogleTokens(
  env: Env,
  accountIdentifier = "default",
): Promise<StoredGoogleTokens | null> {
  const key = getGoogleTokensKvKey(accountIdentifier);
  const raw = await env.STATE_KV.get(key);
  return raw ? (JSON.parse(raw) as StoredGoogleTokens) : null;
}

export async function persistGoogleTokens(
  env: Env,
  tokenData: GoogleTokenResponse,
  accountIdentifier = "default",
): Promise<void> {
  const existing = await loadGoogleTokens(env, accountIdentifier);
  const refreshToken = tokenData.refresh_token || existing?.refresh_token;

  if (!refreshToken) {
    throw new Error("No refresh_token received from Google and no existing refresh_token stored");
  }

  const stored: StoredGoogleTokens = {
    access_token: tokenData.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + tokenData.expires_in * 1000,
    scope: tokenData.scope || existing?.scope,
    account_identifier: accountIdentifier,
    updated_at: new Date().toISOString(),
  };

  const key = getGoogleTokensKvKey(accountIdentifier);
  await env.STATE_KV.put(key, JSON.stringify(stored));
}

export async function getValidGoogleAccessToken(
  env: Env,
  accountIdentifier = "default",
): Promise<string | null> {
  const stored = await loadGoogleTokens(env, accountIdentifier);
  if (!stored) return null;
  if (stored.expires_at - Date.now() > 30_000) return stored.access_token;

  try {
    const data = await googleTokenRequest({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      client_id: requireGoogleClientId(env),
      client_secret: requireGoogleClientSecret(env),
    });
    await persistGoogleTokens(env, data, accountIdentifier);
    return data.access_token;
  } catch (err) {
    console.error("Google token refresh failed — re-authorization needed", err);
    return null;
  }
}

async function googleTokenRequest(
  params: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    let errorDetail = "";
    try {
      const errJson = (await res.json()) as { error?: string; error_description?: string };
      errorDetail = errJson.error_description || errJson.error || `HTTP ${res.status}`;
    } catch {
      errorDetail = `HTTP ${res.status}`;
    }
    throw new Error(`Google token request failed: ${res.status} (${errorDetail})`);
  }

  return (await res.json()) as GoogleTokenResponse;
}

export function requireGoogleClientId(env: Env): string {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) throw new Error("GOOGLE_OAUTH_CLIENT_ID not configured");
  return env.GOOGLE_OAUTH_CLIENT_ID;
}

export function requireGoogleClientSecret(env: Env): string {
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET not configured");
  return env.GOOGLE_OAUTH_CLIENT_SECRET;
}

export function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function handleGoogleOAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeFromVerifier(verifier);
  await env.STATE_KV.put(`google_oauth_state:${state}`, verifier, { expirationTtl: 1800 });
  const redirectUri = `${url.origin}/oauth/google/callback`;
  const promptParam = url.searchParams.get("prompt") ?? undefined;
  const authorizeUrl = buildGoogleAuthorizeUrl(env, redirectUri, state, challenge, promptParam);

  await logActivity(env, {
    entry: "Google OAuth initiated",
    type: "Activity",
    area: "Operations",
    activity: `Google Workspace OAuth authorization initiated for callback ${redirectUri}`,
    outcome: "Active",
  });

  return Response.redirect(authorizeUrl, 302);
}

export interface GoogleDriveConnectivityResult {
  ok: boolean;
  accountIdentifier: string;
  apiEndpoint?: string;
  filesFound?: number;
  sampleFile?: { id: string; name: string; mimeType: string } | null;
  error?: string;
}

export async function testGoogleDriveConnection(
  env: Env,
  accountIdentifier = "default",
): Promise<GoogleDriveConnectivityResult> {
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) {
    await logActivity(env, {
      entry: "Google Drive connectivity test failed: not authorized",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive API connectivity test failed for account ${accountIdentifier}: Google Workspace is not authorized or credentials missing`,
      outcome: "Blocked",
    });
    return {
      ok: false,
      accountIdentifier,
      error: "Google Workspace is not authorized or credentials missing",
    };
  }

  const endpoint = "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id,name,mimeType)";
  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let errorDetail = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as { error?: { message?: string } };
      if (errJson.error?.message) {
        errorDetail = `${res.status} (${errJson.error.message})`;
      }
    } catch {
      // Keep default HTTP status text
    }

    await logActivity(env, {
      entry: "Google Drive connectivity test failed",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive API connectivity test failed for account ${accountIdentifier}: ${errorDetail}`,
      outcome: "Blocked",
    });
    await sendOperationsMessage(env, `⚠️ Google Drive connectivity test failed for ${accountIdentifier}: ${errorDetail}`);

    return {
      ok: false,
      accountIdentifier,
      apiEndpoint: "https://www.googleapis.com/drive/v3/files",
      error: `Google Drive API request failed: ${errorDetail}`,
    };
  }

  const data = (await res.json()) as { files?: { id: string; name: string; mimeType: string }[] };
  const files = data.files ?? [];
  const sampleFile = files.length > 0 ? { id: files[0].id, name: files[0].name, mimeType: files[0].mimeType } : null;

  await logActivity(env, {
    entry: "Google Drive connectivity test succeeded",
    type: "Activity",
    area: "Operations",
    activity: `Google Drive API connectivity test verified read access for account ${accountIdentifier}. Sample files retrieved: ${files.length}`,
    outcome: "Complete",
  });

  return {
    ok: true,
    accountIdentifier,
    apiEndpoint: "https://www.googleapis.com/drive/v3/files",
    filesFound: files.length,
    sampleFile,
  };
}

export async function handleTestGoogleDriveConnection(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const accountParam = url.searchParams.get("account") || "default";
  const result = await testGoogleDriveConnection(env, accountParam);
  const status = result.ok ? 200 : 502;

  return new Response(JSON.stringify(result), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleGoogleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  if (errParam) {
    const errDesc = url.searchParams.get("error_description") || errParam;
    await logActivity(env, {
      entry: "Google OAuth callback failed: authorization denied",
      type: "Activity",
      area: "Operations",
      activity: `Google Workspace OAuth access denied by user or server: ${errDesc}`,
      outcome: "Blocked",
    });
    await sendOperationsMessage(env, `⚠️ Google OAuth callback failed: ${errDesc}`);
    return new Response(`Google OAuth access denied: ${errDesc}`, { status: 400 });
  }

  if (!code || !state) {
    await logActivity(env, {
      entry: "Google OAuth callback failed: missing code or state",
      type: "Activity",
      area: "Operations",
      activity: "Google Workspace OAuth callback rejected due to missing code or state parameter",
      outcome: "Blocked",
    });
    await sendOperationsMessage(env, "⚠️ Google OAuth callback failed: missing code or state parameter");
    return new Response("Missing code or state", { status: 400 });
  }

  const stateKey = `google_oauth_state:${state}`;
  const verifier = await env.STATE_KV.get(stateKey);
  if (!verifier) {
    await logActivity(env, {
      entry: "Google OAuth callback failed: invalid/expired/reused state",
      type: "Activity",
      area: "Operations",
      activity: "Google Workspace OAuth callback rejected due to unknown, expired, or already-consumed state",
      outcome: "Blocked",
    });
    await sendOperationsMessage(env, "⚠️ Google OAuth callback failed: unknown, expired, or reused state token");
    return new Response("Unknown or expired state — restart at /oauth/google/start", { status: 400 });
  }

  await env.STATE_KV.delete(stateKey);
  const redirectUri = `${url.origin}/oauth/google/callback`;

  try {
    const result = await exchangeGoogleCodeForTokens(env, code, redirectUri, verifier);
    await logActivity(env, {
      entry: "Google OAuth callback succeeded",
      type: "Activity",
      area: "Operations",
      activity: `Google Workspace OAuth authorization succeeded for account ${result.accountIdentifier}`,
      outcome: "Complete",
    });
    return new Response("Google Workspace authorized. You can close this tab.");
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    await logActivity(env, {
      entry: "Google OAuth callback failed: token exchange failure",
      type: "Activity",
      area: "Operations",
      activity: `Google Workspace OAuth token exchange failed: ${errMessage}`,
      outcome: "Blocked",
    });
    await sendOperationsMessage(env, `⚠️ Google OAuth callback failed: ${errMessage}`);
    return new Response(`Token exchange failed: ${errMessage}`, { status: 502 });
  }
}
