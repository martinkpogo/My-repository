import type { Env, WorkState } from "./types";
import { logActivity } from "./log";
import { HatMessageTarget, sendWorkspaceHatMessage, sendOperationsMessage } from "./telegram";
import { aiJson } from "./ai";
import { ActionCapability, registerActionCapability } from "./actions/registry";
import { getSessionStub, newWorkId, setActiveWorkId } from "./router";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const GOOGLE_OAUTH_SCOPES = [
  // Google only returns an id_token (needed by
  // parseAccountIdentifierFromIdToken to resolve a real email instead of
  // falling back to the literal string "default") when the token exchange
  // request includes "openid" -- confirmed live: every account authorized
  // before this scope was added is stored under key "default" in KV and
  // in every Activity Log entry, since tokenData.id_token was always
  // undefined without it.
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
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

export async function testGoogleDriveConnection(
  env: Env,
  accountIdentifier = "default",
): Promise<{ ok: boolean; status: number; error?: string }> {
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) {
    await logActivity(env, {
      entry: "Google Drive connectivity test failed: missing or invalid credentials",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive API test failed for account '${accountIdentifier}': no valid access token available`,
      outcome: "Blocked",
    });
    return { ok: false, status: 401, error: "Google Workspace authorization missing or invalid" };
  }

  let res: Response;
  try {
    res = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    await logActivity(env, {
      entry: "Google Drive connectivity test failed: network error",
      type: "Activity",
      area: "Operations",
      activity: "Google Drive API test failed due to network or transport error",
      outcome: "Blocked",
    });
    return { ok: false, status: 502, error: "Network error reaching Google Drive API" };
  }

  if (!res.ok) {
    await logActivity(env, {
      entry: "Google Drive connectivity test failed: upstream error",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive API test failed with HTTP ${res.status}`,
      outcome: "Blocked",
    });
    const status = res.status === 401 || res.status === 403 ? 401 : 502;
    return { ok: false, status, error: "Google Drive API request failed" };
  }

  await logActivity(env, {
    entry: "Google Drive connectivity test succeeded",
    type: "Activity",
    area: "Operations",
    activity: `Google Drive API read-only connectivity test succeeded for account '${accountIdentifier}'`,
    outcome: "Complete",
  });

  return { ok: true, status: 200 };
}

export async function handleGoogleDriveTest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const accountIdentifier = url.searchParams.get("account") || "default";
  const result = await testGoogleDriveConnection(env, accountIdentifier);

  if (result.ok) {
    return new Response(JSON.stringify({ ok: true, connected: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: false, error: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

export interface PendingGoogleAction {
  type: "create_doc";
  title: string;
  content: string;
  folderId: string;
  accountIdentifier: string;
}

export interface CreateGoogleDocResult {
  ok: boolean;
  documentId?: string;
  documentUrl?: string;
  error?: string;
  stage?: "auth" | "validation" | "creation" | "insertion" | "verification";
}

/**
 * Extracts plain text content from a Google Docs API Document resource.
 */
export function extractDocText(docData: any): string {
  if (!docData || !docData.body || !Array.isArray(docData.body.content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const structuralElement of docData.body.content) {
    if (structuralElement.paragraph && Array.isArray(structuralElement.paragraph.elements)) {
      for (const element of structuralElement.paragraph.elements) {
        if (element.textRun && typeof element.textRun.content === "string") {
          textParts.push(element.textRun.content);
        }
      }
    }
  }
  return textParts.join("");
}

export async function createGoogleDoc(
  env: Env,
  action: PendingGoogleAction,
): Promise<CreateGoogleDocResult> {
  // 1. Validation
  if (
    !action ||
    action.type !== "create_doc" ||
    !action.title?.trim() ||
    !action.content?.trim() ||
    !action.folderId?.trim() ||
    !action.accountIdentifier?.trim()
  ) {
    await logActivity(env, {
      entry: "Google Doc creation failed: invalid parameters",
      type: "Activity",
      area: "Operations",
      activity: "Google Doc creation rejected due to missing or invalid action parameters (title, content, folderId, or accountIdentifier)",
      outcome: "Blocked",
    });
    return { ok: false, stage: "validation", error: "Missing or invalid Google Doc creation parameters" };
  }

  const title = action.title.trim();
  const content = action.content.trim();
  const folderId = action.folderId.trim();
  const accountIdentifier = action.accountIdentifier.trim();

  // 2. Authorization check
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) {
    await logActivity(env, {
      entry: "Google Doc creation failed: missing or invalid credentials",
      type: "Activity",
      area: "Operations",
      activity: `Google Doc creation failed for account '${accountIdentifier}': no valid access token available`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "auth", error: "Google Workspace authorization missing or invalid" };
  }

  // 3. Stage 1: Document Creation via Drive API (files.create)
  let createRes: Response;
  try {
    createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.document",
        parents: [folderId],
      }),
    });
  } catch (err) {
    await logActivity(env, {
      entry: "Google Doc creation failed: creation network error",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create failed due to network error for document '${title}' in folder '${folderId}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: "Network error during Google Doc creation" };
  }

  if (!createRes.ok) {
    await logActivity(env, {
      entry: "Google Doc creation failed: document creation error",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create failed with HTTP ${createRes.status} for document '${title}' in folder '${folderId}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: `Google Drive file creation failed (HTTP ${createRes.status})` };
  }

  let createData: { id?: string };
  try {
    createData = (await createRes.json()) as { id?: string };
  } catch {
    await logActivity(env, {
      entry: "Google Doc creation failed: invalid creation response JSON",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create returned non-JSON response for document '${title}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: "Invalid JSON response from Google Drive file creation" };
  }

  const documentId = createData.id;
  if (!documentId) {
    await logActivity(env, {
      entry: "Google Doc creation failed: missing document ID in response",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create response missing document ID for '${title}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: "Google Drive creation succeeded but no document ID was returned" };
  }

  // 4. Stage 2: Content Insertion via Docs API (documents.batchUpdate)
  let insertRes: Response;
  try {
    insertRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: content,
            },
          },
        ],
      }),
    });
  } catch (err) {
    await logActivity(env, {
      entry: "Google Doc creation failed: content insertion network error",
      type: "Activity",
      area: "Operations",
      activity: `Google Docs batchUpdate network error for document ID '${documentId}'`,
      outcome: "Blocked",
    });
    return { ok: false, documentId, stage: "insertion", error: "Network error during content insertion" };
  }

  if (!insertRes.ok) {
    await logActivity(env, {
      entry: "Google Doc creation failed: content insertion error",
      type: "Activity",
      area: "Operations",
      activity: `Google Docs batchUpdate failed with HTTP ${insertRes.status} for document ID '${documentId}'`,
      outcome: "Blocked",
    });
    return { ok: false, documentId, stage: "insertion", error: `Google Docs content insertion failed (HTTP ${insertRes.status})` };
  }

  // 5. Stage 3: Verification Read-Back via Docs API (documents.get)
  let verifyRes: Response;
  try {
    verifyRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    await logActivity(env, {
      entry: "Google Doc creation failed: verification network error",
      type: "Activity",
      area: "Operations",
      activity: `Google Docs verification get network error for document ID '${documentId}'`,
      outcome: "Blocked",
    });
    return { ok: false, documentId, stage: "verification", error: "Network error during document verification" };
  }

  if (!verifyRes.ok) {
    await logActivity(env, {
      entry: "Google Doc creation failed: verification read-back error",
      type: "Activity",
      area: "Operations",
      activity: `Google Docs verification get failed with HTTP ${verifyRes.status} for document ID '${documentId}'`,
      outcome: "Blocked",
    });
    return { ok: false, documentId, stage: "verification", error: `Google Docs verification read-back failed (HTTP ${verifyRes.status})` };
  }

  let docData: any;
  try {
    docData = await verifyRes.json();
  } catch {
    await logActivity(env, {
      entry: "Google Doc creation failed: invalid verification response JSON",
      type: "Activity",
      area: "Operations",
      activity: `Google Docs verification get returned invalid JSON for document ID '${documentId}'`,
      outcome: "Blocked",
    });
    return { ok: false, documentId, stage: "verification", error: "Invalid JSON response during document verification" };
  }

  const verifiedTitle = (docData.title ?? "").trim();
  const extractedText = extractDocText(docData);

  if (verifiedTitle !== title || !extractedText.includes(content)) {
    await logActivity(env, {
      entry: "Google Doc creation failed: verification content mismatch",
      type: "Activity",
      area: "Operations",
      activity: `Google Doc verification failed for document ID '${documentId}': title or inserted content mismatch`,
      outcome: "Blocked",
    });
    return { ok: false, documentId, stage: "verification", error: "Document verification failed: title or content mismatch" };
  }

  // Success
  const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;

  await logActivity(env, {
    entry: "Google Doc creation succeeded",
    type: "Activity",
    area: "Operations",
    activity: `Google Doc '${title}' created and verified in folder '${folderId}' (ID: ${documentId})`,
    outcome: "Complete",
  });

  return { ok: true, documentId, documentUrl };
}

export async function proposeGoogleDocCreation(
  env: Env,
  state: WorkState,
  input: { title: string; content: string; folderId: string; accountIdentifier: string },
): Promise<WorkState> {
  const title = input.title?.trim();
  const content = input.content?.trim();
  const folderId = input.folderId?.trim();
  const accountIdentifier = input.accountIdentifier?.trim();

  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  if (!title || !content || !folderId || !accountIdentifier) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ Cannot propose Google Doc creation: missing title, content, folder ID, or account identifier.",
    );
    return state;
  }

  const pendingAction: PendingGoogleAction = {
    type: "create_doc",
    title,
    content,
    folderId,
    accountIdentifier,
  };

  state.pendingGoogleAction = pendingAction;

  const preview = content.length > 300 ? `${content.slice(0, 300)}...` : content;
  const messageText = `*Proposed Action*: Create Google Doc\n\n*Title*: ${title}\n*Folder ID*: ${folderId}\n*Account*: ${accountIdentifier}\n\n*Content Preview*:\n${preview}`;

  const buttons = [
    [
      { text: "✅ Approve Document Creation", callback_data: `googleaction:${state.workId}:approve` },
      { text: "❌ Reject", callback_data: `googleaction:${state.workId}:reject` },
    ],
  ];

  await sendWorkspaceHatMessage(env, target, messageText, buttons);

  await logActivity(env, {
    entry: "Google Doc creation proposed",
    type: "Activity",
    area: "Operations",
    activity: `Google Doc creation proposed: '${title}' in folder '${folderId}' for account '${accountIdentifier}'`,
    outcome: "Active",
  });

  return state;
}

export async function listAuthorizedGoogleAccounts(env: Env): Promise<string[]> {
  const accounts: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE_KV.list({ prefix: "google_oauth_tokens:", cursor });
    for (const key of page.keys) {
      const accountIdentifier = key.name.replace(/^google_oauth_tokens:/, "");
      if (accountIdentifier && (await loadGoogleTokens(env, accountIdentifier))) {
        accounts.push(accountIdentifier);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return accounts;
}

export interface WatchedGoogleDoc {
  documentId: string;
  accountIdentifier: string;
  title: string;
  chatId?: number;
  threadId?: number;
  createdAt: string;
}

/**
 * Registers a created Google Doc for comment-triggered editing (see
 * googleDocComments.ts). Watching is opt-in-by-creation: only docs this
 * system itself created are watched, never arbitrary pre-existing files.
 */
export async function registerWatchedGoogleDoc(env: Env, doc: WatchedGoogleDoc): Promise<void> {
  await env.STATE_KV.put(`google_doc_watch:${doc.documentId}`, JSON.stringify(doc));
}

export async function listWatchedGoogleDocs(env: Env): Promise<WatchedGoogleDoc[]> {
  const docs: WatchedGoogleDoc[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE_KV.list({ prefix: "google_doc_watch:", cursor });
    for (const key of page.keys) {
      const raw = await env.STATE_KV.get(key.name);
      if (raw) {
        try {
          docs.push(JSON.parse(raw) as WatchedGoogleDoc);
        } catch {
          // corrupt entry -- skip rather than fail the whole poll
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return docs;
}

export interface CleanupDefaultGoogleAccountResult {
  tokenDeleted: boolean;
  docsRepointedTo: string | null;
  docsRepointed: string[];
  docsOrphaned: string[];
}

/**
 * One-time cleanup for accounts authorized before GOOGLE_OAUTH_SCOPES
 * included "openid"/"email" (see that commit), which were always stored
 * under the literal identifier "default" rather than a real email.
 * Deletes that stale token and, only when exactly one other authorized
 * account exists (the unambiguous common case), re-points any doc still
 * watched under "default" to it -- so nothing already relying on the
 * "default" identity silently stops working. Never guesses when zero or
 * more than one other account exists; those docs are reported as
 * orphaned (still watched, but their token is gone) rather than acted on.
 */
export async function cleanupDefaultGoogleAccount(env: Env): Promise<CleanupDefaultGoogleAccountResult> {
  const defaultToken = await loadGoogleTokens(env, "default");
  if (!defaultToken) {
    return { tokenDeleted: false, docsRepointedTo: null, docsRepointed: [], docsOrphaned: [] };
  }

  const otherAccounts = (await listAuthorizedGoogleAccounts(env)).filter((id) => id !== "default");
  const target = otherAccounts.length === 1 ? otherAccounts[0] : null;

  const docsRepointed: string[] = [];
  const docsOrphaned: string[] = [];
  const watchedDocs = await listWatchedGoogleDocs(env);
  for (const doc of watchedDocs) {
    if (doc.accountIdentifier !== "default") continue;
    if (target) {
      await registerWatchedGoogleDoc(env, { ...doc, accountIdentifier: target });
      docsRepointed.push(doc.documentId);
    } else {
      docsOrphaned.push(doc.documentId);
    }
  }

  await env.STATE_KV.delete(getGoogleTokensKvKey("default"));

  return { tokenDeleted: true, docsRepointedTo: target, docsRepointed, docsOrphaned };
}

export async function saveOpaqueOption(
  env: Env,
  workId: string,
  optionData: Record<string, unknown>,
  ttl = 600,
): Promise<string> {
  const opaqueId = crypto.randomUUID().slice(0, 8);
  const key = `google_option:${workId}:${opaqueId}`;
  await env.STATE_KV.put(key, JSON.stringify(optionData), { expirationTtl: ttl });
  return opaqueId;
}

export async function consumeOpaqueOption(
  env: Env,
  workId: string,
  opaqueId: string,
): Promise<Record<string, any> | null> {
  const key = `google_option:${workId}:${opaqueId}`;
  const raw = await env.STATE_KV.get(key);
  if (!raw) return null;
  await env.STATE_KV.delete(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const GoogleDocCreationCapability: ActionCapability = {
  id: "workspace.google_doc_creation",
  name: "Google Doc Creation Capability",
  description: "Creates Google Docs in Google Drive with user-selected account, folder, and explicit approval.",
  async handleIntake(env: Env, chatId: number, text: string, threadId?: number): Promise<boolean> {
    const classification = await aiJson<{ isGoogleDocRequest: boolean; title?: string; content?: string }>(env, {
      taskId: "action.google_doc_intake",
      system: `You classify incoming messages for ENIG's Google Doc creation capability.
Check if the message requests creating a Google Doc / Document.
If yes, set isGoogleDocRequest to true and extract the document title and content text if present.
If title or content is missing, leave them empty/undefined.
Return JSON: {"isGoogleDocRequest": true | false, "title": "...", "content": "..."}`,
      user: text,
      light: true,
    });

    if (!classification || !classification.isGoogleDocRequest) {
      return false;
    }

    const title = classification.title?.trim();
    const content = classification.content?.trim();

    const target: HatMessageTarget = { chatId, threadId };

    if (!title || !content) {
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ I recognized a request to create a Google Doc, but the document Title or Content is missing. Please specify both the Title and Content.",
      );
      return true;
    }

    const authorizedAccounts = await listAuthorizedGoogleAccounts(env);
    if (authorizedAccounts.length === 0) {
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ Cannot create Google Doc: no authorized Google Workspace account found. Please visit `/oauth/google/start?key=...` in your browser to authorize an account first.",
      );
      return true;
    }

    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, undefined, undefined, threadId);
    await setActiveWorkId(env, chatId, threadId, workId);

    const buttons = [];
    for (const account of authorizedAccounts) {
      const opaqueId = await saveOpaqueOption(env, workId, {
        kind: "account",
        accountIdentifier: account,
        title,
        content,
      });
      buttons.push([{ text: `👤 ${account}`, callback_data: `googleaccount:${workId}:${opaqueId}` }]);
    }

    const messageText = `*Google Workspace Action*: Create Google Doc\n\n*Title*: ${title}\n\nSelect the authorized Google account to use:`;
    await sendWorkspaceHatMessage(env, { chatId, threadId, workId }, messageText, buttons);

    await logActivity(env, {
      entry: "Google Doc intake initiated",
      type: "Activity",
      activity: `Google Doc intake started for '${title}' (workId: ${workId})`,
      outcome: "Active",
    });

    return true;
  },
};

registerActionCapability(GoogleDocCreationCapability);

export async function handleGoogleAccountSelection(
  env: Env,
  state: WorkState,
  opaqueOptionId: string,
): Promise<WorkState> {
  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  const option = await consumeOpaqueOption(env, state.workId, opaqueOptionId);
  if (!option || option.kind !== "account" || !option.accountIdentifier) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ That account selection option is invalid or expired. Please submit the request again.",
    );
    return state;
  }

  const { accountIdentifier, title, content } = option;

  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Could not retrieve valid credentials for account '${accountIdentifier}'. Please re-authorize via /oauth/google/start.`,
    );
    return state;
  }

  let folderRes: Response;
  try {
    folderRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.folder%27+and+trashed%3Dfalse&fields=files(id,name,mimeType,parents,capabilities)&pageSize=50",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
  } catch (err) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Network error listing Google Drive folders for account '${accountIdentifier}'.`,
    );
    return state;
  }

  if (!folderRes.ok) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Failed to list Google Drive folders for account '${accountIdentifier}' (HTTP ${folderRes.status}).`,
    );
    return state;
  }

  let folderData: { files?: Array<{ id: string; name: string }> };
  try {
    folderData = await folderRes.json();
  } catch {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ Invalid JSON response from Google Drive folder query.",
    );
    return state;
  }

  const folders = (folderData.files ?? []).sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length === 0) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ No accessible Drive folders found for account '${accountIdentifier}'.`,
    );
    return state;
  }

  const buttons = [];
  for (const folder of folders) {
    const opaqueFolderId = await saveOpaqueOption(env, state.workId, {
      kind: "folder",
      accountIdentifier,
      title,
      content,
      folderId: folder.id,
      folderName: folder.name,
    });
    buttons.push([{ text: `📁 ${folder.name}`, callback_data: `googlefolder:${state.workId}:${opaqueFolderId}` }]);
  }

  const messageText = `*Google Workspace Action*: Create Google Doc\n\n*Account*: ${accountIdentifier}\n*Title*: ${title}\n\nSelect the target Drive folder:`;
  await sendWorkspaceHatMessage(env, target, messageText, buttons);

  await logActivity(env, {
    entry: "Google Drive folders presented",
    type: "Activity",
    activity: `Drive folder picker presented for account '${accountIdentifier}'`,
    outcome: "Active",
  });

  return state;
}

export async function handleGoogleFolderSelection(
  env: Env,
  state: WorkState,
  opaqueOptionId: string,
): Promise<WorkState> {
  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  const option = await consumeOpaqueOption(env, state.workId, opaqueOptionId);
  if (!option || option.kind !== "folder" || !option.folderId) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ That folder selection option is invalid or expired. Please submit the request again.",
    );
    return state;
  }

  const { accountIdentifier, title, content, folderId, folderName } = option;

  state.pendingGoogleAction = {
    type: "create_doc",
    title,
    content,
    folderId,
    accountIdentifier,
  };

  const preview = content.length > 300 ? `${content.slice(0, 300)}...` : content;
  const messageText = `*Proposed Action*: Create Google Doc\n\n*Title*: ${title}\n*Account*: ${accountIdentifier}\n*Folder*: ${folderName}\n\n*Content Preview*:\n${preview}\n\nCreation has NOT executed yet. Approve this action?`;

  const buttons = [
    [
      { text: "✅ Approve Document Creation", callback_data: `googleaction:${state.workId}:approve` },
      { text: "❌ Reject", callback_data: `googleaction:${state.workId}:reject` },
    ],
  ];

  await sendWorkspaceHatMessage(env, target, messageText, buttons);

  await logActivity(env, {
    entry: "Google Doc creation proposed",
    type: "Activity",
    activity: `Google Doc creation proposed for '${title}' in folder '${folderName}' (${folderId}) for account '${accountIdentifier}'`,
    outcome: "Active",
  });

  return state;
}

export async function handleGoogleActionApproval(
  env: Env,
  state: WorkState,
  approved: boolean,
): Promise<WorkState> {
  const action = state.pendingGoogleAction;
  state.pendingGoogleAction = undefined;

  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  if (!action || action.type !== "create_doc") {
    await sendWorkspaceHatMessage(
      env,
      target,
      "No valid pending Google action found for this work item.",
    );
    return state;
  }

  if (!approved) {
    await logActivity(env, {
      entry: "Google Doc creation rejected",
      type: "Activity",
      area: "Operations",
      activity: `Google Doc creation rejected by user for '${action.title}'`,
      outcome: "Blocked",
    });

    await sendWorkspaceHatMessage(
      env,
      target,
      `Google Doc creation rejected for *${action.title}*. No document was created.`,
    );

    return state;
  }

  const result = await createGoogleDoc(env, action);

  if (!result.ok) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Google Doc creation failed during ${result.stage} stage: ${result.error}`,
    );
    return state;
  }

  if (result.documentId) {
    await registerWatchedGoogleDoc(env, {
      documentId: result.documentId,
      accountIdentifier: action.accountIdentifier,
      title: action.title,
      chatId: state.chatId,
      threadId: state.threadId,
      createdAt: new Date().toISOString(),
    });
  }

  await sendWorkspaceHatMessage(
    env,
    target,
    `✅ Google Doc created and verified successfully!\n\n*Title*: ${action.title}\n*URL*: ${result.documentUrl}\n\nTip: select text in the doc, leave a comment describing the change, and it'll be applied automatically within about a minute.`,
  );

  return state;
}
