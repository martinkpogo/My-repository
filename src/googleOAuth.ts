import type { Env, WorkState } from "./types";
import type { FolderClaimStatus } from "./googleFolderClaim";
import { buildDocStyleRequests, observedStylingMatches, type GoogleDocLayout, type ObservedDocParagraph, type ObservedDocStyling, type ObservedDocTextStyle } from "./googleDocSpec";
// The observed read-back shapes are declared by the neutral specification
// module (the one vocabulary for a document's declared and actual styling);
// re-exported here so this layer's existing consumers keep their import site.
export type { ObservedDocParagraph, ObservedDocStyling, ObservedDocTextStyle };
import { logActivity } from "./log";
import { HatMessageTarget, sendWorkspaceHatMessage, sendWorkspaceHatMessageWithOutcome, sendOperationsMessage, type InlineButton, type TelegramSendResult } from "./telegram";
import { generate } from "./ai";
import { getSessionStub, newWorkId, setActiveWorkId } from "./router";
import { kvDelete, kvGet, kvList, kvPut } from "./kvStore";
import { cachedWatchRegistry, invalidateWatchRegistry } from "./watchRegistryCache";
import { isAdminAuthorized } from "./adminAuth";

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
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
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
  const raw = await kvGet(env, key);
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
  await kvPut(env, key, JSON.stringify(stored));
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
  if (!isAdminAuthorized(request, env)) {
    return new Response("forbidden", { status: 403 });
  }
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeFromVerifier(verifier);
  await kvPut(env, `google_oauth_state:${state}`, verifier, { expirationTtl: 1800 });
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
  const verifier = await kvGet(env, stateKey);
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

  await kvDelete(env, stateKey);
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
  if (!isAdminAuthorized(request, env)) {
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

export interface CreateGoogleDocAction {
  type: "create_doc";
  title: string;
  content: string;
  folderId: string;
  accountIdentifier: string;
}

export interface CreateGoogleSheetAction {
  type: "create_sheet";
  title: string;
  /** First row is treated as column headers; the rest are starting data rows. */
  rows: string[][];
  folderId: string;
  accountIdentifier: string;
}

export type PendingGoogleAction = CreateGoogleDocAction | CreateGoogleSheetAction;

export interface CreateGoogleDocResult {
  ok: boolean;
  documentId?: string;
  documentUrl?: string;
  error?: string;
  stage?: "auth" | "validation" | "creation" | "insertion" | "verification";
}

export interface CreateGoogleSheetResult {
  ok: boolean;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  error?: string;
  stage?: "auth" | "validation" | "creation" | "insertion" | "verification";
}

/** Converts a 1-based column index to its A1-notation letter(s), e.g. 1 -> "A", 27 -> "AA". */
export function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
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
  // Preserve the Action's declared content exactly: no trimming, normalisation
  // or other modification. Validation above already rejects empty/whitespace-only
  // content; the exact value is what gets written and exactly verified.
  const content = action.content;
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
  // The Docs API always terminates the body with the protected final newline,
  // so the read-back is either exactly the requested text or that text plus
  // the terminal newline. Anything else is a mismatch -- a matching substring
  // is never sufficient evidence of successful creation.
  const contentMatches = extractedText === content || extractedText === `${content}\n`;
  if (verifiedTitle !== title || !contentMatches) {
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

export async function createGoogleSheet(
  env: Env,
  action: CreateGoogleSheetAction,
): Promise<CreateGoogleSheetResult> {
  // 1. Validation
  if (
    !action ||
    action.type !== "create_sheet" ||
    !action.title?.trim() ||
    !Array.isArray(action.rows) ||
    action.rows.length === 0 ||
    !action.folderId?.trim() ||
    !action.accountIdentifier?.trim()
  ) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: invalid parameters",
      type: "Activity",
      area: "Operations",
      activity: "Google Sheet creation rejected due to missing or invalid action parameters (title, rows, folderId, or accountIdentifier)",
      outcome: "Blocked",
    });
    return { ok: false, stage: "validation", error: "Missing or invalid Google Sheet creation parameters" };
  }

  const title = action.title.trim();
  const rows = action.rows;
  const folderId = action.folderId.trim();
  const accountIdentifier = action.accountIdentifier.trim();
  const numCols = Math.max(...rows.map((r) => r.length));
  const range = `A1:${columnLetter(numCols)}${rows.length}`;

  // 2. Authorization check
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: missing or invalid credentials",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheet creation failed for account '${accountIdentifier}': no valid access token available`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "auth", error: "Google Workspace authorization missing or invalid" };
  }

  // 3. Stage 1: Spreadsheet Creation via Drive API (files.create)
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
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [folderId],
      }),
    });
  } catch (err) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: creation network error",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create failed due to network error for spreadsheet '${title}' in folder '${folderId}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: "Network error during Google Sheet creation" };
  }

  if (!createRes.ok) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: spreadsheet creation error",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create failed with HTTP ${createRes.status} for spreadsheet '${title}' in folder '${folderId}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: `Google Drive file creation failed (HTTP ${createRes.status})` };
  }

  let createData: { id?: string };
  try {
    createData = (await createRes.json()) as { id?: string };
  } catch {
    await logActivity(env, {
      entry: "Google Sheet creation failed: invalid creation response JSON",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create returned non-JSON response for spreadsheet '${title}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: "Invalid JSON response from Google Drive file creation" };
  }

  const spreadsheetId = createData.id;
  if (!spreadsheetId) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: missing spreadsheet ID in response",
      type: "Activity",
      area: "Operations",
      activity: `Google Drive files.create response missing spreadsheet ID for '${title}'`,
      outcome: "Blocked",
    });
    return { ok: false, stage: "creation", error: "Google Drive creation succeeded but no spreadsheet ID was returned" };
  }

  // 4. Stage 2: Row Insertion via Sheets API (values.update)
  let insertRes: Response;
  try {
    insertRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ range, values: rows }),
      },
    );
  } catch (err) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: row insertion network error",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheets values.update network error for spreadsheet ID '${spreadsheetId}'`,
      outcome: "Blocked",
    });
    return { ok: false, spreadsheetId, stage: "insertion", error: "Network error during row insertion" };
  }

  if (!insertRes.ok) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: row insertion error",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheets values.update failed with HTTP ${insertRes.status} for spreadsheet ID '${spreadsheetId}'`,
      outcome: "Blocked",
    });
    return { ok: false, spreadsheetId, stage: "insertion", error: `Google Sheets row insertion failed (HTTP ${insertRes.status})` };
  }

  // 5. Stage 3: Verification Read-Back via Sheets API (values.get)
  let verifyRes: Response;
  try {
    verifyRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
  } catch (err) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: verification network error",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheets verification get network error for spreadsheet ID '${spreadsheetId}'`,
      outcome: "Blocked",
    });
    return { ok: false, spreadsheetId, stage: "verification", error: "Network error during spreadsheet verification" };
  }

  if (!verifyRes.ok) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: verification read-back error",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheets verification get failed with HTTP ${verifyRes.status} for spreadsheet ID '${spreadsheetId}'`,
      outcome: "Blocked",
    });
    return { ok: false, spreadsheetId, stage: "verification", error: `Google Sheets verification read-back failed (HTTP ${verifyRes.status})` };
  }

  let valuesData: { values?: string[][] };
  try {
    valuesData = await verifyRes.json();
  } catch {
    await logActivity(env, {
      entry: "Google Sheet creation failed: invalid verification response JSON",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheets verification get returned invalid JSON for spreadsheet ID '${spreadsheetId}'`,
      outcome: "Blocked",
    });
    return { ok: false, spreadsheetId, stage: "verification", error: "Invalid JSON response during spreadsheet verification" };
  }

  const verifiedRows = valuesData.values ?? [];
  const rowsMatch =
    verifiedRows.length === rows.length &&
    rows.every((row, i) => row.every((cell, j) => (verifiedRows[i]?.[j] ?? "") === cell));

  if (!rowsMatch) {
    await logActivity(env, {
      entry: "Google Sheet creation failed: verification content mismatch",
      type: "Activity",
      area: "Operations",
      activity: `Google Sheet verification failed for spreadsheet ID '${spreadsheetId}': inserted row content mismatch`,
      outcome: "Blocked",
    });
    return { ok: false, spreadsheetId, stage: "verification", error: "Spreadsheet verification failed: row content mismatch" };
  }

  // Success
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  await logActivity(env, {
    entry: "Google Sheet creation succeeded",
    type: "Activity",
    area: "Operations",
    activity: `Google Sheet '${title}' created and verified in folder '${folderId}' (ID: ${spreadsheetId})`,
    outcome: "Complete",
  });

  return { ok: true, spreadsheetId, spreadsheetUrl };
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

  state.pendingActionSummary = {
    label: `Create Google Doc: ${title}`,
    message: messageText,
    buttons,
    createdAt: new Date().toISOString(),
  };

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
    const page = await kvList(env, { prefix: "google_oauth_tokens:", cursor });
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

/**
 * Binds a watched Doc to ONE version of a Runtime Sales Proposal. A comment
 * on such a Doc is never an in-place edit: it is a change REQUEST routed to
 * the Proposal's own revision path, which creates the next version (see
 * googleDocComments.ts and tokenSafeProposal.ts's applyProposalDocComment).
 */
export interface WatchedDocProposalBinding {
  /** The WorkSession that holds this Proposal. */
  workId: string;
  proposalNumber: number;
  /** Display ID, e.g. "PROP-6". */
  proposalId: string;
  /** The version this Doc is a copy of. */
  version: number;
}

export interface WatchedGoogleDoc {
  documentId: string;
  accountIdentifier: string;
  title: string;
  chatId?: number;
  threadId?: number;
  createdAt: string;
  proposal?: WatchedDocProposalBinding;
}

/**
 * Registers a created Google Doc for comment-triggered editing (see
 * googleDocComments.ts). Watching is opt-in-by-creation: only docs this
 * system itself created are watched, never arbitrary pre-existing files.
 */
/**
 * Returns the Drive folder id this system keeps documents of one kind in,
 * creating the folder the first time and remembering it per account. The
 * Runtime's `drive.file` scope covers files and folders this app creates.
 */
export async function ensureGoogleFolder(
  env: Env,
  accountIdentifier: string,
  folderName: string,
  kvKey: string,
): Promise<{ ok: true; folderId: string } | { ok: false; error: string }> {
  const key = `${kvKey}:${accountIdentifier}`;
  const known = await kvGet(env, key);
  if (known) return { ok: true, folderId: known };
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) return { ok: false, error: "Google Workspace authorization missing or invalid" };
  let res: Response;
  try {
    res = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" }),
    });
  } catch {
    return { ok: false, error: "Network error creating the Drive folder" };
  }
  if (!res.ok) return { ok: false, error: `Google Drive folder creation failed (HTTP ${res.status})` };
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  if (!data.id) return { ok: false, error: "Google Drive folder creation returned no id" };
  try {
    await kvPut(env, key, data.id);
  } catch (err) {
    // Truthful post-effect failure: the folder EXISTS (the provider-side
    // write already succeeded), so the id is still returned and the
    // operation stays a success. The cache write is a cache -- its failure
    // is logged, not allowed to turn a created folder into a reported
    // failure, and NOT absorbed by a Turso fallback (this key class is
    // Cloudflare-only: its key embeds the account email). Consequence while
    // the cache stays unwritable: a later ensure misses and may re-create
    // the folder -- logged here so that outcome is traceable.
    console.error(
      `ensureGoogleFolder: folder "${folderName}" was created (id ${data.id}) but its folder-id cache write failed -- the id is returned; a later ensure may re-create this folder while the cache is unwritable`,
      err,
    );
  }
  return { ok: true, folderId: data.id };
}

/**
 * Reads a Doc's body text and end index (Docs indexes, UTF-16 units), or
 * null when the Doc cannot be read at all.
 */
async function readGoogleDocBody(token: string, documentId: string): Promise<{ text: string; endIndex: number } | null> {
  try {
    const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as { body?: { content?: { endIndex?: number; paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] } };
    const content = doc.body?.content ?? [];
    const text = content.flatMap((c) => c.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
    return { text, endIndex: content.reduce((m, c) => Math.max(m, c.endIndex ?? 0), 1) };
  } catch {
    return null;
  }
}

/**
 * A bounded, single-line diagnostic summary of a non-OK Docs/Drive API
 * response: the HTTP status plus Google's OWN error message when the body
 * carries one. Only the declared `error.status`/`error.message` fields are
 * read, then collapsed to one line and truncated -- a large or unexpected
 * body can never flood logs. The OAuth bearer token lives only in the
 * request header and is never part of a response; no request payload and no
 * document content is echoed. What remains is exactly what is needed to see
 * WHICH request the API rejected (for example an unknown field name or an
 * invalid enum value) instead of discarding the only diagnostic Google gave.
 */
async function describeGoogleApiFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const raw = await res.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: { status?: unknown; message?: unknown } };
        const status = typeof parsed?.error?.status === "string" ? parsed.error.status : "";
        const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
        detail = [status, message].filter(Boolean).join(": ");
      } catch {
        detail = raw;
      }
    }
  } catch {
    return `HTTP ${res.status}`;
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

/**
 * Replaces the whole body of a Doc this system created with `layout.text` and
 * applies the layout's styling (buildDocStyleRequests: paragraph hierarchy,
 * bullets, bold headings/labels, struck removed text, underlined added
 * text), then reads the Doc back and confirms the COMPLETE specification:
 * the text is exactly what was written AND every declared paragraph style,
 * bullet, indent and inline mark is actually shown (the one shared matcher,
 * `observedStylingMatches`). Matching text alone is never proof of success --
 * a body written without its declared formatting does not verify. The layout
 * is whatever the resolved Action's validated `document_specification`
 * resolved to -- this established Google layer executes it and never chooses
 * content or structure of its own.
 */
export async function rewriteGoogleDoc(
  env: Env,
  accountIdentifier: string,
  documentId: string,
  layout: GoogleDocLayout,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) return { ok: false, error: "Google Workspace authorization missing or invalid" };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const before = await readGoogleDocBody(token, documentId);
  if (!before) return { ok: false, error: "the Doc could not be read" };

  const requests: unknown[] = [];
  // The body always ends in a protected newline at endIndex-1; delete everything before it.
  if (before.endIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: before.endIndex - 1 } } });
  requests.push({ insertText: { location: { index: 1 }, text: layout.text } });
  requests.push(...buildDocStyleRequests(layout));
  let res: Response;
  try {
    res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, { method: "POST", headers, body: JSON.stringify({ requests }) });
  } catch {
    return { ok: false, error: "network error rewriting the Doc" };
  }
  if (!res.ok) return { ok: false, error: `Google Docs rewrite failed (${await describeGoogleApiFailure(res)})` };
  const after = await readGoogleDocStyling(token, documentId);
  if (!after || after.text.trimEnd() !== layout.text.trimEnd()) {
    return { ok: false, error: "the Doc did not read back as written" };
  }
  if (!observedStylingMatches(layout, after)) {
    return { ok: false, error: "the Doc read back with the wrong formatting: the declared paragraph styles, bullets, indentation or inline marks are missing or wrong" };
  }
  return { ok: true };
}

/**
 * Applies a layout's styling to a Doc WITHOUT touching a single character
 * of its text: reads the Doc, refuses (nothing applied) when its text no
 * longer matches the layout it should show, sends only style requests
 * (buildDocStyleRequests), and reads back to confirm BOTH halves of the
 * specification: the text is still byte-identical AND the declared styling
 * is actually shown (the one shared matcher, `observedStylingMatches`) --
 * a pass whose requests did not take effect is never claimed as verified.
 * The layout comes from the resolved Action's validated
 * `document_specification`; this layer executes it and decides nothing.
 */
export async function restyleGoogleDoc(
  env: Env,
  accountIdentifier: string,
  documentId: string,
  layout: GoogleDocLayout,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) return { ok: false, error: "Google Workspace authorization missing or invalid" };
  const before = await readGoogleDocBody(token, documentId);
  if (!before) return { ok: false, error: "the Doc could not be read" };
  if (before.text.trimEnd() !== layout.text.trimEnd()) {
    return { ok: false, error: "the Doc's text no longer matches the specification it is bound to, so formatting was refused rather than applied to drifted content" };
  }
  let res: Response;
  try {
    res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: buildDocStyleRequests(layout) }),
    });
  } catch {
    return { ok: false, error: "network error formatting the Doc" };
  }
  if (!res.ok) return { ok: false, error: `Google Docs formatting failed (${await describeGoogleApiFailure(res)})` };
  const after = await readGoogleDocStyling(token, documentId);
  if (!after || after.text.trimEnd() !== layout.text.trimEnd()) return { ok: false, error: "the Doc's text changed while it was being formatted" };
  if (!observedStylingMatches(layout, after)) {
    return { ok: false, error: "the Doc's formatting does not match the specification after the styling pass" };
  }
  return { ok: true };
}

/**
 * Parses a Docs document response into the neutral observed shapes the ONE
 * shared matcher verifies against: the text it spells out, every paragraph's
 * own index, named style, bullet and indent, and every text run's inline
 * marks over its own index range. Pure (no I/O) so the read-back of a write
 * and the read-back of a reconciliation parse through exactly the same
 * code, and a malformed body degrades to empty observations rather than
 * throwing.
 */
export function parseGoogleDocStyling(doc: unknown): ObservedDocStyling {
  const body = (doc as {
    body?: {
      content?: {
        startIndex?: number;
        paragraph?: {
          bullet?: unknown;
          paragraphStyle?: {
            namedStyleType?: string;
            indentStart?: { magnitude?: number };
            spaceAbove?: { magnitude?: number };
            spaceBelow?: { magnitude?: number };
          };
          elements?: { textRun?: { content?: string; textStyle?: { bold?: boolean; strikethrough?: boolean; underline?: boolean; foregroundColor?: { color?: { rgbColor?: { red?: number; green?: number; blue?: number } } } } } }[];
        };
      }[];
    };
  } | null)?.body;
  const paragraphs: ObservedDocParagraph[] = [];
  const runs: ObservedDocTextStyle[] = [];
  let text = "";
  for (const structural of body?.content ?? []) {
    const paragraph = structural.paragraph;
    if (!paragraph) continue;
    const paragraphStart = structural.startIndex ?? 0;
    let index = paragraphStart;
    let paragraphText = "";
    for (const element of paragraph.elements ?? []) {
      const run = element.textRun;
      const value = run?.content ?? "";
      if (!value) continue;
      const color = run?.textStyle?.foregroundColor?.color?.rgbColor;
      runs.push({
        start: index,
        end: index + value.length,
        bold: run?.textStyle?.bold === true,
        strikethrough: run?.textStyle?.strikethrough === true,
        underline: run?.textStyle?.underline === true,
        foregroundColor: color !== undefined
          ? { red: color.red ?? 0, green: color.green ?? 0, blue: color.blue ?? 0 }
          : null,
      });
      text += value;
      paragraphText += value;
      index += value.length;
    }
    const paragraphStyle = paragraph.paragraphStyle ?? {};
    paragraphs.push({
      start: paragraphStart,
      namedStyleType: paragraphStyle.namedStyleType ?? "",
      bulleted: paragraph.bullet !== undefined && paragraph.bullet !== null,
      indentStartPt: paragraphStyle.indentStart?.magnitude ?? 0,
      spaceAbovePt: paragraphStyle.spaceAbove?.magnitude ?? 0,
      spaceBelowPt: paragraphStyle.spaceBelow?.magnitude ?? 0,
      text: paragraphText,
    });
  }
  return { text, paragraphs, runs };
}

/**
 * Reads a Doc's ACTUAL styling -- every body paragraph's named style, bullet
 * and indent, plus every text run's bold / strikethrough / underline over its
 * own index range -- together with the text those runs spell out, or null
 * when the Doc cannot be read at all.
 *
 * This is what makes an interrupted FORMATTING attempt reconcilable and a
 * completed write verifiable beyond its text: text alone can never show
 * whether the styles were applied. Reconciliation and read-back verification
 * both read them, through the one shared parser above.
 */
export async function readGoogleDocStyling(
  token: string,
  documentId: string,
): Promise<ObservedDocStyling | null> {
  try {
    const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return parseGoogleDocStyling(await res.json());
  } catch {
    return null;
  }
}

export async function registerWatchedGoogleDoc(env: Env, doc: WatchedGoogleDoc): Promise<void> {
  await kvPut(env, `google_doc_watch:${doc.documentId}`, JSON.stringify(doc));
  await invalidateWatchRegistry("docs");
}

/**
 * Reads ONE watched doc straight from the trusted server-side registration
 * record (the same key registerWatchedGoogleDoc writes), by document id.
 *
 * This is the ONLY way the Drive notification path is allowed to turn a
 * notification into a document: a channel record names a document id that was
 * bound at registration time by an admin-authorized call, and the doc record
 * it resolves to here is Runtime's own state -- never anything taken from an
 * untrusted request body or header. Returns null when the document is not
 * registered, which is a hard stop: the notification is refused rather than
 * processed against a document the system does not know it owns.
 */
export async function getWatchedGoogleDoc(env: Env, documentId: string): Promise<WatchedGoogleDoc | null> {
  if (!documentId) return null;
  const raw = await kvGet(env, `google_doc_watch:${documentId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WatchedGoogleDoc;
  } catch {
    return null;
  }
}

export async function listWatchedGoogleDocs(env: Env, options: { fresh?: boolean } = {}): Promise<WatchedGoogleDoc[]> {
  return cachedWatchRegistry("docs", () => loadWatchedGoogleDocs(env), options);
}

async function loadWatchedGoogleDocs(env: Env): Promise<WatchedGoogleDoc[]> {
  const docs: WatchedGoogleDoc[] = [];
  let cursor: string | undefined;
  do {
    const page = await kvList(env, { prefix: "google_doc_watch:", cursor });
    for (const key of page.keys) {
      const raw = await kvGet(env, key.name);
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

export interface WatchedGoogleSheet {
  spreadsheetId: string;
  accountIdentifier: string;
  title: string;
  chatId?: number;
  threadId?: number;
  createdAt: string;
}

/**
 * Registers a created Google Sheet for comment-triggered editing (see
 * googleSheetComments.ts). Same opt-in-by-creation rule as
 * registerWatchedGoogleDoc: only sheets this system itself created are
 * watched, never arbitrary pre-existing files.
 */
export async function registerWatchedGoogleSheet(env: Env, sheet: WatchedGoogleSheet): Promise<void> {
  await kvPut(env, `google_sheet_watch:${sheet.spreadsheetId}`, JSON.stringify(sheet));
  await invalidateWatchRegistry("sheets");
}

/**
 * Reads ONE watched sheet straight from the trusted server-side registration
 * record (the same key registerWatchedGoogleSheet writes), by spreadsheet id.
 *
 * The exact mirror of getWatchedGoogleDoc: the registered comment-reply
 * operation (google_drive.reply_to_comment) resolves its target from this
 * record, so a reply may only ever target a spreadsheet this Worker itself
 * created and watches -- never an arbitrary Drive file. Returns null when the
 * spreadsheet is not registered, which is a hard stop (fail-closed).
 */
export async function getWatchedGoogleSheet(env: Env, spreadsheetId: string): Promise<WatchedGoogleSheet | null> {
  if (!spreadsheetId) return null;
  const raw = await kvGet(env, `google_sheet_watch:${spreadsheetId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WatchedGoogleSheet;
  } catch {
    return null;
  }
}

export async function listWatchedGoogleSheets(env: Env, options: { fresh?: boolean } = {}): Promise<WatchedGoogleSheet[]> {
  return cachedWatchRegistry("sheets", () => loadWatchedGoogleSheets(env), options);
}

async function loadWatchedGoogleSheets(env: Env): Promise<WatchedGoogleSheet[]> {
  const sheets: WatchedGoogleSheet[] = [];
  let cursor: string | undefined;
  do {
    const page = await kvList(env, { prefix: "google_sheet_watch:", cursor });
    for (const key of page.keys) {
      const raw = await kvGet(env, key.name);
      if (raw) {
        try {
          sheets.push(JSON.parse(raw) as WatchedGoogleSheet);
        } catch {
          // corrupt entry -- skip rather than fail the whole poll
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sheets;
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
  const watchedDocs = await listWatchedGoogleDocs(env, { fresh: true });
  for (const doc of watchedDocs) {
    if (doc.accountIdentifier !== "default") continue;
    if (target) {
      await registerWatchedGoogleDoc(env, { ...doc, accountIdentifier: target });
      docsRepointed.push(doc.documentId);
    } else {
      docsOrphaned.push(doc.documentId);
    }
  }

  await kvDelete(env, getGoogleTokensKvKey("default"));

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
  await kvPut(env, key, JSON.stringify(optionData), { expirationTtl: ttl });
  return opaqueId;
}

export async function consumeOpaqueOption(
  env: Env,
  workId: string,
  opaqueId: string,
): Promise<Record<string, any> | null> {
  const key = `google_option:${workId}:${opaqueId}`;
  const raw = await kvGet(env, key);
  if (!raw) return null;
  await kvDelete(env, key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read a staged option WITHOUT consuming it. Paging the folder picker needs
 * this: the "📂 More folders" button re-renders from the same list, so the
 * option must survive the tap (consume deletes it, which is what makes a
 * folder pick single-use -- you cannot pick the same list twice).
 */
export async function peekOpaqueOption(
  env: Env,
  workId: string,
  opaqueId: string,
): Promise<Record<string, any> | null> {
  const key = `google_option:${workId}:${opaqueId}`;
  const raw = await kvGet(env, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * How many Drive folders the picker shows per page before a "More folders"
 * button. The full list is staged as ONE option (see
 * handleGoogleFolderSelection); the buttons carry positions into it, so
 * paging costs no extra writes.
 */
/**
 * Maximum number of folders to display in a single Telegram message.
 * Telegram's inline keyboard limit is 100 buttons per message.
 * We use 50 to leave room for message overhead and ensure reliable delivery.
 */
const MAX_FOLDERS_PER_PICKER = 50;

export const GoogleDocCreationCapability = {
  id: "workspace.google_doc_creation",
  name: "Google Doc Creation Capability",
  description: "Creates Google Docs in Google Drive with user-selected account, folder, and explicit approval.",
  async handleIntake(env: Env, chatId: number, text: string, threadId?: number): Promise<boolean> {
    const classification = await generate<{ isGoogleDocRequest: boolean; title?: string; content?: string }>(env, {
      taskId: "action.google_doc_intake",
      mode: "json",
      parts: {
        persona: `You classify incoming messages for ENIG's Google Doc creation capability.
Check if the message requests creating a Google Doc / Document.
If yes, set isGoogleDocRequest to true and extract the document title and content text if present.
If title or content is missing, leave them empty/undefined.
Return JSON: {"isGoogleDocRequest": true | false, "title": "...", "content": "..."}`,
        situation: text,
      },
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

    // Option staging is Cloudflare-only (google_option: carries the Doc
    // body + account email), so a storage refusal here is surfaced
    // explicitly: no buttons are sent, nothing pretends the selection
    // state was persisted, and the user is told to retry.
    const buttons = [];
    try {
      for (const account of authorizedAccounts) {
        const opaqueId = await saveOpaqueOption(env, workId, {
          kind: "account",
          accountIdentifier: account,
          title,
          content,
        });
        buttons.push([{ text: `👤 ${account}`, callback_data: `googleaccount:${workId}:${opaqueId}` }]);
      }
    } catch (err) {
      console.error(`Google Doc intake: option staging failed for work ${workId} -- no selection buttons were sent`, err);
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ Could not persist the account-selection options (storage write refused -- likely the daily KV quota), so no approval buttons were sent and nothing was staged. Please retry after the quota window resets.",
      );
      return true;
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

export const GoogleSheetCreationCapability = {
  id: "workspace.google_sheet_creation",
  name: "Google Sheet Creation Capability",
  description:
    "Creates Google Sheets (e.g. content calendars, trackers) in Google Drive with user-selected account, folder, and explicit approval.",
  async handleIntake(env: Env, chatId: number, text: string, threadId?: number): Promise<boolean> {
    const classification = await generate<{
      isGoogleSheetRequest: boolean;
      title?: string;
      rows?: string[][];
    }>(env, {
      taskId: "action.google_sheet_intake",
      mode: "json",
      parts: {
        persona: `You classify incoming messages for ENIG's Google Sheet creation capability.
Check if the message requests creating a Google Sheet / spreadsheet / content calendar / tracker.
If yes, set isGoogleSheetRequest to true, extract a sheet title, and produce an initial 2D array of rows: the FIRST row must be column headers, and any subsequent rows are starting data (use just the header row if no data rows were given).
If the request is a content calendar with no explicit columns specified, default the header row to: ["Date", "Content Piece", "Channel", "Status", "Owner"].
If title is missing, leave it empty/undefined.
Return JSON: {"isGoogleSheetRequest": true | false, "title": "...", "rows": [["Date","Content Piece","Channel","Status","Owner"]]}`,
        situation: text,
      },
      light: true,
    });

    if (!classification || !classification.isGoogleSheetRequest) {
      return false;
    }

    const title = classification.title?.trim();
    const rows =
      Array.isArray(classification.rows) && classification.rows.length > 0
        ? classification.rows
        : undefined;

    const target: HatMessageTarget = { chatId, threadId };

    if (!title || !rows) {
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ I recognized a request to create a Google Sheet, but the sheet Title or column structure is missing. Please specify a title (e.g. 'Q4 Content Calendar').",
      );
      return true;
    }

    const authorizedAccounts = await listAuthorizedGoogleAccounts(env);
    if (authorizedAccounts.length === 0) {
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ Cannot create Google Sheet: no authorized Google Workspace account found. Please visit `/oauth/google/start?key=...` in your browser to authorize an account first.",
      );
      return true;
    }

    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, undefined, undefined, threadId);
    await setActiveWorkId(env, chatId, threadId, workId);

    // Same explicit-failure rule as the Doc intake: google_option: is
    // Cloudflare-only, so a refused write stops the flow with an honest
    // message instead of pretending the selection state was persisted.
    const buttons = [];
    try {
      for (const account of authorizedAccounts) {
        const opaqueId = await saveOpaqueOption(env, workId, {
          kind: "account",
          docType: "sheet",
          accountIdentifier: account,
          title,
          rows,
        });
        buttons.push([{ text: `👤 ${account}`, callback_data: `googleaccount:${workId}:${opaqueId}` }]);
      }
    } catch (err) {
      console.error(`Google Sheet intake: option staging failed for work ${workId} -- no selection buttons were sent`, err);
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ Could not persist the account-selection options (storage write refused -- likely the daily KV quota), so no approval buttons were sent and nothing was staged. Please retry after the quota window resets.",
      );
      return true;
    }

    const messageText = `*Google Workspace Action*: Create Google Sheet\n\n*Title*: ${title}\n\nSelect the authorized Google account to use:`;
    await sendWorkspaceHatMessage(env, { chatId, threadId, workId }, messageText, buttons);

    await logActivity(env, {
      entry: "Google Sheet intake initiated",
      type: "Activity",
      activity: `Google Sheet intake started for '${title}' (workId: ${workId})`,
      outcome: "Active",
    });

    return true;
  },
};

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

  const { accountIdentifier, title, content, rows } = option;
  const docType: "doc" | "sheet" = option.docType === "sheet" ? "sheet" : "doc";
  // Shared output-delivery flow (src/outputDelivery.ts): the account option
  // was staged by handleOutputDeliveryCallback carrying `delivery: true`.
  // The account/folder pickers are reused exactly, but the folder stage must
  // carry the flag forward so handleGoogleFolderSelection routes to the final
  // explicit confirmation (which mints the proof and creates) rather than the
  // legacy pendingGoogleAction approval path.
  const delivery = option.delivery === true;
  // Tool Registry SMOKE flow discriminator (src/googleDocsSmokeFlow.ts): the
  // account option was staged by the /googledocssmoke flow carrying
  // `smoke: true`. Smoke selection reuses this picker exactly -- same
  // consumption, same token gate, same Drive listing -- but stages only
  // further smoke-flagged options; the normal creation path below (title,
  // content, docType) is untouched when the flag is absent.
  const smoke = option.smoke === true;

  const token = await getValidGoogleAccessToken(env, accountIdentifier);
  if (!token) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Could not retrieve valid credentials for account '${accountIdentifier}'. Please re-authorize via /oauth/google/start.`,
    );
    return state;
  }

  // Fetch ALL folders via Google Drive API pagination (following nextPageToken).
  // This preserves the complete folder list so folders beyond the first API
  // response are not silently lost.
  const allFolders: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;
  const maxPages = 20; // Safety limit to prevent infinite loops (matches googleDocComments.ts pattern)
  let pagesFetched = 0;

  try {
    do {
      const url = pageToken
        ? `https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.folder%27+and+trashed%3Dfalse&fields=files(id,name,mimeType,parents,capabilities),nextPageToken&pageSize=100&pageToken=${encodeURIComponent(pageToken)}`
        : "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.folder%27+and+trashed%3Dfalse&fields=files(id,name,mimeType,parents,capabilities),nextPageToken&pageSize=100";

      const folderRes = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!folderRes.ok) {
        await sendWorkspaceHatMessage(
          env,
          target,
          `⚠️ Failed to list Google Drive folders for account '${accountIdentifier}' (HTTP ${folderRes.status}).`,
        );
        return state;
      }

      const folderData = (await folderRes.json()) as {
        files?: Array<{ id: string; name: string }>;
        nextPageToken?: string;
      };

      if (folderData.files) {
        allFolders.push(...folderData.files);
      }

      pageToken = folderData.nextPageToken;
      pagesFetched++;

      // Detect circular pagination tokens (defensive, matches comments implementation)
      if (pageToken && pagesFetched > 1) {
        // We could track seen tokens but for folders the risk is low;
        // the maxPages limit is the primary guard.
      }
    } while (pageToken && pagesFetched < maxPages);

    if (pagesFetched >= maxPages && pageToken) {
      console.warn(
        `Google Drive folder listing hit maxPages (${maxPages}) for account '${accountIdentifier}'; ` +
          `returning ${allFolders.length} folders (list may be incomplete)`
      );
    }
  } catch (err) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Network error listing Google Drive folders for account '${accountIdentifier}'.`,
    );
    return state;
  }

  const folders = allFolders.sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length === 0) {
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ No accessible Drive folders found for account '${accountIdentifier}'.`,
    );
    return state;
  }

  // Folder-option staging is Cloudflare-only too: a refused write is
  // surfaced explicitly (no picker sent, nothing pretended persisted)
  // instead of throwing after the flow has already shown partial state.
  //
  // ONE write, not one per folder (Martin, 2026-11-18). The picker used to
  // call saveOpaqueOption once per folder -- up to 50 writes, and with
  // google_option: Turso-eligible that was up to 50 Turso calls inside a
  // single Worker invocation, which Cloudflare cut off ("Too many
  // subrequests by single Worker invocation", Workers Logs 18 Nov 2026
  // 14:08:25). The whole folder list is now saved as a single option, and
  // every button carries its folder's POSITION in that list (Telegram's
  // 64-byte callback_data limit cannot carry a folder id, so the binding
  // lives in the option, exactly as before -- only the number of writes
  // changes). The folder list is displayed as a continuous selection list
  // (up to Telegram's practical inline-keyboard limit) without a "More
  // folders" button, restoring the previous scrolling experience.
  const folderList = folders.map((f) => ({ id: f.id, name: f.name }));
  const baseOption = smoke
    ? { kind: "folderlist", smoke: true, accountIdentifier, folders: folderList }
    : delivery
      ? { kind: "folderlist", delivery: true, docType, accountIdentifier, title, content, rows, folders: folderList }
      : { kind: "folderlist", docType, accountIdentifier, title, content, rows, folders: folderList };
  // The id is chosen first and stamped onto the staged list.
  const listOpaqueId = crypto.randomUUID().slice(0, 8);
  try {
    await kvPut(env, `google_option:${state.workId}:${listOpaqueId}`, JSON.stringify({ ...baseOption, _listOpaqueId: listOpaqueId }), { expirationTtl: 600 });
  } catch (err) {
    console.error(`Google folder picker: option staging failed for work ${state.workId} -- no picker was sent`, err);
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ Could not persist the folder-selection options (storage write refused -- likely the daily KV quota), so no folder picker was sent and nothing was staged. Please retry after the quota window resets.",
    );
    return state;
  }
  // renderFolderList builds the complete folder list (up to MAX_FOLDERS_PER_PICKER)
  // from the staged list in a single message -- no pagination, no "More folders"
  // button, restoring the continuous scrolling experience.
  return renderFolderList(env, state, target, { ...baseOption, _listOpaqueId: listOpaqueId });
}

/**
 * Renders the complete folder picker as a continuous selection list from a
 * staged folder list. Shows up to MAX_FOLDERS_PER_PICKER folders in a single
 * Telegram message without pagination or a "More folders" button, restoring
 * the previous scrolling experience.
 */
async function renderFolderList(
  env: Env,
  state: WorkState,
  target: HatMessageTarget,
  option: Record<string, any>,
): Promise<WorkState> {
  const folders: Array<{ id: string; name: string }> = option.folders;
  // Display up to MAX_FOLDERS_PER_PICKER folders in a single message.
  // If there are more, we show a note but no pagination button (per the
  // restored UX requirement: continuous scrolling list without "More folders").
  const displayFolders = folders.slice(0, MAX_FOLDERS_PER_PICKER);
  const buttons: InlineButton[][] = [];
  for (let i = 0; i < displayFolders.length; i++) {
    const folder = displayFolders[i]!;
    buttons.push([{ text: `📁 ${folder.name}`, callback_data: `googlefolder:${state.workId}:${option._listOpaqueId}:${i}` }]);
  }
  const isSmoke = option.smoke === true;
  const totalFolders = folders.length;
  const moreNote = totalFolders >= MAX_FOLDERS_PER_PICKER
    ? `\n\n_Showing ${MAX_FOLDERS_PER_PICKER} of ${totalFolders} folders._`
    : "";
  const messageText = isSmoke
    ? `🧪 *GOVERNED TOOL REGISTRY SMOKE*\n\n*Account*: ${option.accountIdentifier}\n\nSelect the *disposable* Drive folder for the smoke document (never the production proposal folder):${moreNote}`
    : option.delivery === true
      ? `*Save approved output to Google Drive*\n\n*Account*: ${option.accountIdentifier}\n*Title*: ${option.title}\n\nSelect the target Drive folder -- you will confirm once more before anything is created:${moreNote}`
      : `*Google Workspace Action*: ${option.docType === "sheet" ? "Create Google Sheet" : "Create Google Doc"}\n\n*Account*: ${option.accountIdentifier}\n*Title*: ${option.title}\n\nSelect the target Drive folder:${moreNote}`;
  await sendWorkspaceHatMessage(env, target, messageText, buttons);
  if (isSmoke) {
    await logActivity(env, {
      entry: "Google Docs Registry smoke: folder picker presented",
      type: "Activity",
      activity: `Registry smoke Drive folder picker presented for account '${option.accountIdentifier}' (${totalFolders} folders)`,
      outcome: "Active",
      workId: state.workId,
    });
  } else {
    await logActivity(env, {
      entry: "Google Drive folders presented",
      type: "Activity",
      activity: `Drive folder picker presented for account '${option.accountIdentifier}' (${totalFolders} folders)`,
      outcome: "Active",
    });
  }
  return state;
}

/**
 * Minimal interface for the Stage 4A WorkSession claim methods, exposed to
 * `handleGoogleFolderSelection` so the callback can coordinate on the
 * Durable Object transaction-backed claim primitive without importing the
 * full WorkSession class.
 */
interface FolderClaimMethods {
  claimFolderOption(opaqueId: string): Promise<boolean>;
  resolveFolderClaim(opaqueId: string, status: "completed" | "failed"): Promise<void>;
  getFolderClaimStatus(opaqueId: string): Promise<FolderClaimStatus | undefined>;
}

export async function handleGoogleFolderSelection(
  env: Env,
  state: WorkState,
  opaqueOptionId: string,
  claims: FolderClaimMethods,
): Promise<WorkState> {
  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  // Send a Workspace task-interrupting failure notice. Swallow any transport
  // failure so the notification attempt never escapes as an uncaught
  // exception into generic WorkSession/Operations handling.
  const notifyWorkspaceTaskError = async (message: string): Promise<void> => {
    try {
      await sendWorkspaceHatMessage(env, target, message);
    } catch {
      console.error(`Folder selection: Workspace notification transport failed for work ${state.workId}: ${message}`);
    }
  };

  // The callback value is "<opaqueId>:<position>": index.ts splits
  // callback_data on ":" into [action, workId, value], and opaqueIds are
  // 8 hex characters with no colon of their own, so the position is the last
  // segment and the opaque id is everything before it.
  const colon = opaqueOptionId.lastIndexOf(":");
  const opaqueId = colon === -1 ? opaqueOptionId : opaqueOptionId.slice(0, colon);
  const position = colon === -1 ? undefined : opaqueOptionId.slice(colon + 1);

  // STEP 1: Check the claim status FIRST, before reading the folder-list
  // option. A duplicate callback arriving after the winner has consumed the
  // option must be silently ignored, not misclassified as expired/invalid.
  let claimStatus: FolderClaimStatus | undefined;
  try {
    claimStatus = await claims.getFolderClaimStatus(opaqueId);
  } catch (err) {
    // Status lookup failure: must not proceed to peek, claim, or consume.
    // Report as a Workspace task error, not an uncaught exception.
    await notifyWorkspaceTaskError("⚠️ Folder selection could not be verified. Please try again or start a fresh selection.");
    return state;
  }
  if (claimStatus === "claimed" || claimStatus === "completed" || claimStatus === "failed") {
    // Duplicate callback: silently ignore. No Telegram message, no peek,
    // no consumption, no continuation.
    return state;
  }

  // STEP 2: Peek the existing folder-list option (no claim yet).
  let option: Record<string, any> | null;
  try {
    option = await peekOpaqueOption(env, state.workId, opaqueId);
  } catch (err) {
    // Peek failure: must not proceed to claim or consume.
    await notifyWorkspaceTaskError("⚠️ Folder selection could not be read. Please try again or start a fresh selection.");
    return state;
  }
  if (!option || option.kind !== "folderlist" || !Array.isArray(option.folders)) {
    await notifyWorkspaceTaskError("⚠️ That folder selection option is invalid or expired. Please submit the request again.");
    return state;
  }

  // STEP 3: Validate the selected folder position against the peeked option.
  const index = position === undefined ? NaN : Number(position);
  const picked = Number.isInteger(index) && index >= 0 && index < option.folders.length ? option.folders[index] : undefined;
  if (!picked) {
    await notifyWorkspaceTaskError("⚠️ That folder selection is no longer current -- nothing was recorded.");
    return state;
  }

  // STEP 4: Attempt the atomic claim. The Stage 4A DO transaction-backed
  // primitive decides the winner. If we lose, return silently.
  let claimed: boolean;
  try {
    claimed = await claims.claimFolderOption(opaqueId);
  } catch (err) {
    // Claim acquisition failure with uncertain outcome: do not blindly
    // retry or consume. Preserve the claim's protected state and report
    // the uncertainty.
    await notifyWorkspaceTaskError("⚠️ Folder selection claim could not be verified. Please try again or start a fresh selection.");
    return state;
  }
  if (!claimed) {
    // Lost the claim race: another callback already won. Silent ignore.
    return state;
  }

  // STEP 5: Only the winner consumes the option.
  // Any failure from this point onward must resolve the claim as "failed"
  // so the claim marker is not left stranded as "claimed" forever.
  let claimResolved = false;

  const resolveClaimFailed = async (message: string): Promise<void> => {
    if (!claimResolved) {
      try {
        await claims.resolveFolderClaim(opaqueId, "failed");
        claimResolved = true;
      } catch (err) {
        // Resolve itself failed; claim remains in its prior state.
        console.error(`Folder selection: failed to resolve claim "${opaqueId}" as failed for work ${state.workId}`, err);
      }
    }
    // Send the Workspace notification, but never let a transport failure
    // create a second uncaught exception that falls through to Operations.
    try {
      await sendWorkspaceHatMessage(env, target, message);
    } catch {
      console.error(`Folder selection: Workspace notification transport failed for work ${state.workId}: ${message}`);
    }
  };

  const resolveClaimCompleted = async (): Promise<void> => {
    if (!claimResolved) {
      try {
        await claims.resolveFolderClaim(opaqueId, "completed");
        claimResolved = true;
      } catch (err) {
        // Log the resolution failure so a stranded "claimed" marker is
        // diagnosable. Do not tell the user the proposal failed — the
        // Telegram handoff may already have succeeded.
        console.error(`Folder selection: failed to resolve claim "${opaqueId}" as completed for work ${state.workId}`, err);
      }
    }
  };

  // Do not catch network exceptions here: a rejected fetch is an unknown
  // delivery outcome, not a confirmed provider rejection. Let it propagate
  // so callers can distinguish confirmed failure from unknown outcome.
  const sendWithOutcome = async (
    text: string,
    buttons?: InlineButton[][],
  ): Promise<TelegramSendResult> => {
    return await sendWorkspaceHatMessageWithOutcome(env, target, text, buttons);
  };

  // Clear any WorkSession state mutations made during this call before
  // returning on a post-claim failure. Keeps the Work clean for a fresh
  // selection so a stale pendingGoogleAction/pendingSmokeSelection doesn't
  // survive a failed delivery.
  const clearPendingState = (): void => {
    state.pendingGoogleAction = undefined;
    state.pendingActionSummary = undefined;
    state.pendingSmokeSelection = undefined;
  };

  let consumed: Record<string, any> | null = null;
  let consumeError: unknown;
  try {
    consumed = await consumeOpaqueOption(env, state.workId, opaqueId);
  } catch (err) {
    consumeError = err;
  }

  if (consumeError !== undefined || !consumed) {
    await resolveClaimFailed(
      consumeError !== undefined
        ? "⚠️ Folder selection failed while reading your selection. Nothing was created — try again or start a fresh selection."
        : "⚠️ That folder selection option was already consumed. Please submit the request again.",
    );
    return state;
  }
  // Re-validate the pick against the consumed option (authoritative source).
  const revalidated = Number.isInteger(index) && index >= 0 && index < consumed.folders.length ? consumed.folders[index] : undefined;
  if (!revalidated) {
    await resolveClaimFailed("⚠️ That folder selection is no longer current -- nothing was recorded.");
    return state;
  }

  const { accountIdentifier, title, content, rows } = consumed;
  const folderId = revalidated.id;
  const folderName = revalidated.name;
  const docType: "doc" | "sheet" = option.docType === "sheet" ? "sheet" : "doc";
  // Shared output-delivery flow (src/outputDelivery.ts): the folder option
  // carries `delivery: true`. Route to the final explicit confirmation, which
  // mints the ApprovalProof (bound to this exact folder) and creates through
  // the shared Tool Registry -- never the legacy pendingGoogleAction path.
  const delivery = option.delivery === true;

  // Tool Registry SMOKE flow (src/googleDocsSmokeFlow.ts): the folder option
  // was staged carrying `smoke: true`. Instead of the normal creation
  // approval (pendingGoogleAction + googleaction: buttons -- which this
  // branch never touches, so the legacy document-creation path cannot be
  // reached from here), record the selected target on the Work and stage an
  // explicit smoke confirmation bound to this exact Work + account + folder.
  if (option.smoke === true) {
    let confirmOpaqueId: string;
    try {
      confirmOpaqueId = await saveOpaqueOption(env, state.workId, {
        kind: "smoke_confirm",
        smoke: true,
        accountIdentifier,
        folderId,
        folderName,
      });
    } catch (err) {
      console.error(`Google Docs smoke confirmation staging failed for work ${state.workId} -- nothing was staged`, err);
      await resolveClaimFailed("⚠️ Could not persist the smoke confirmation (storage write refused). Nothing was created — retry the folder step or start a fresh /googledocssmoke flow.");
      return state;
    }

    state.pendingSmokeSelection = {
      accountIdentifier,
      folderId,
      folderName,
      createdAt: new Date().toISOString(),
    };

    const confirmButtons = [
      [
        { text: "🧪 Confirm Registry smoke test", callback_data: `googlesmokeconfirm:${state.workId}:${confirmOpaqueId}` },
        { text: "❌ Cancel", callback_data: `googlesmokeconfirm:${state.workId}:cancel` },
      ],
    ];

    const messageText =
      "🧪 *GOVERNED TOOL REGISTRY SMOKE* -- Confirmation\n\n" +
      `*Account*: ${accountIdentifier}\n` +
      `*Folder*: ${folderName} (\`${folderId}\`)\n\n` +
      "Confirming will create exactly ONE disposable Google Doc through the shared Tool Registry " +
      "(`google_docs.create_and_verify`, proved by read-back) and then REWRITE that same disposable " +
      "Doc's content through the registered `google_docs.update_and_verify` operation (also proved by " +
      "read-back) -- each as its own governed invocation with its own durable operation records, both " +
      "judged by this Work's recorded Action. Nothing has been created yet; the rewrite can only ever " +
      "target the Doc this same run creates, and the production proposal folder is never touched.\n\nConfirm?";

    // Deliver Telegram confirmation and check whether delivery succeeded.
    let telegramOutcome: "delivered" | "rejected" | "unknown";
    try {
      const result = await sendWithOutcome(messageText, confirmButtons);
      telegramOutcome = result.delivered ? "delivered" : "rejected";
    } catch {
      // Unknown delivery outcome: a network exception after a send was
      // attempted. Do not blindly retry, do not clear state, do not
      // resolve the claim as "failed". Preserve state so a confirmation
      // button that WAS delivered can still be honoured. The claim
      // remains "claimed" and protected against duplicate callbacks.
      console.error(`Folder selection: Telegram delivery outcome unknown (network exception) for work ${state.workId}`);
      await notifyWorkspaceTaskError("⚠️ Telegram delivery of your smoke confirmation could not be confirmed. No Google Doc has been created yet. Please check whether the confirmation message arrived before retrying the folder step or starting a fresh /googledocssmoke flow.");
      return state;
    }

    if (telegramOutcome === "rejected") {
      clearPendingState();
      await resolveClaimFailed("⚠️ Smoke confirmation was staged but could not be delivered. Your selection was recorded — try the folder step again or start a fresh /googledocssmoke flow.");
      return state;
    }
    // telegramOutcome === "delivered": continue to logActivity below.

    try {
      await logActivity(env, {
        entry: "Google Docs Registry smoke: confirmation presented",
        type: "Activity",
        activity: `Registry smoke target selected for account '${accountIdentifier}' in folder '${folderName}' (${folderId}) -- awaiting explicit confirmation`,
        outcome: "Active",
        workId: state.workId,
      });
    } catch (err) {
      // Telegram was delivered successfully; activity logging failed.
      // Preserve pending state so the delivered confirmation button remains usable.
      // Do not resolve the claim as failed or completed merely because logging failed.
      console.error(`Folder selection: smoke confirmation activity logging failed for work ${state.workId}`, err);
      await notifyWorkspaceTaskError("⚠️ Your smoke confirmation was delivered but activity logging failed. No document has been created. Please check whether the confirmation message arrived before retrying.");
      return state;
    }

    // STEP 6: Mark the claim completed after successful handoff to the smoke confirmation stage.
    await resolveClaimCompleted();
    return state;
  }

  if (delivery) {
    // Re-stage the picked target as a delivery_confirm option so the final
    // confirm callback can recover the exact account + folder it is bound to
    // (Telegram callback_data cannot carry the folder id within its 64-byte
    // limit, so the binding lives in the opaque option, not the button).
    let confirmOpaqueId: string;
    try {
      confirmOpaqueId = await saveOpaqueOption(env, state.workId, {
        kind: "delivery_confirm",
        delivery: true,
        accountIdentifier,
        folderId,
        folderName,
        title,
      });
    } catch (err) {
      console.error(`Output delivery: confirmation staging failed for work ${state.workId} -- nothing was staged`, err);
      await resolveClaimFailed("⚠️ Could not persist the output-delivery confirmation (storage write refused). Nothing was created — please try again after the quota window resets.");
      return state;
    }
    // Final explicit confirmation before creation. The confirm button carries
    // only the opaque id (the account + folder binding lives there, within the
    // callback byte limit); the handler mints the proof bound to that folder.
    const confirmButtons = [
      [
        { text: "✅ Confirm & create Doc", callback_data: `outputdelivery:${state.workId}:${confirmOpaqueId}` },
        { text: "❌ Cancel", callback_data: `outputdelivery:${state.workId}:dismiss` },
      ],
    ];
    const messageText =
      `*Save approved output to Google Drive* -- confirm\n\n` +
      `*Account*: ${accountIdentifier}\n` +
      `*Folder*: ${folderName} (\`${folderId}\`)\n` +
      `*Title*: ${title}\n\n` +
      "Confirming creates exactly ONE Google Doc in this folder through the shared Tool Registry " +
      "(`google_docs.create_and_verify`, proved by read-back). Nothing has been created yet.\n\nConfirm?";

    let telegramOutcome: "delivered" | "rejected" | "unknown";
    try {
      const result = await sendWithOutcome(messageText, confirmButtons);
      telegramOutcome = result.delivered ? "delivered" : "rejected";
    } catch {
      // Unknown delivery outcome: network exception after a send was
      // attempted. Do not blindly retry, do not clear state, do not
      // resolve the claim as "failed". Preserve state.
      console.error(`Folder selection: Telegram delivery outcome unknown (network exception) for work ${state.workId}`);
      await notifyWorkspaceTaskError("⚠️ Telegram delivery of your output-delivery confirmation could not be confirmed. No Google Doc has been created yet. Please check whether the confirmation message arrived before retrying.");
      return state;
    }

    if (telegramOutcome === "rejected") {
      clearPendingState();
      await resolveClaimFailed("⚠️ Output-delivery confirmation was staged but could not be delivered. Your selection was recorded — try again or start a fresh selection.");
      return state;
    }

    try {
      await logActivity(env, {
        entry: "Output delivery confirmation presented",
        type: "Activity",
        area: state.unit ?? "Operations",
        activity: `Output delivery target selected for account '${accountIdentifier}' in folder '${folderName}' (${folderId}) -- awaiting explicit confirmation`,
        outcome: "Active",
        workId: state.workId,
      });
    } catch (err) {
      // Telegram was delivered successfully; activity logging failed.
      // Preserve pending state so the delivered confirmation button remains usable.
      // Do not resolve the claim as failed or completed merely because logging failed.
      console.error(`Folder selection: output-delivery confirmation activity logging failed for work ${state.workId}`, err);
      await notifyWorkspaceTaskError("⚠️ Your output-delivery confirmation was delivered but activity logging failed. No document has been created. Please check whether the confirmation message arrived before retrying.");
      return state;
    }

    // STEP 6: Mark the claim completed after successful handoff to the delivery confirmation stage.
    await resolveClaimCompleted();
    return state;
  }

  const buttons = [
    [
      { text: docType === "sheet" ? "✅ Approve Sheet Creation" : "✅ Approve Document Creation", callback_data: `googleaction:${state.workId}:approve` },
      { text: "❌ Reject", callback_data: `googleaction:${state.workId}:reject` },
    ],
  ];

  if (docType === "sheet") {
    state.pendingGoogleAction = {
      type: "create_sheet",
      title,
      rows,
      folderId,
      accountIdentifier,
    };

    const previewRows = (rows as string[][]).slice(0, 5);
    const preview = previewRows.map((r) => r.join(" | ")).join("\n");
    const truncated = (rows as string[][]).length > previewRows.length ? "\n..." : "";
    const messageText = `*Proposed Action*: Create Google Sheet\n\n*Title*: ${title}\n*Account*: ${accountIdentifier}\n*Folder*: ${folderName}\n\n*Preview*:\n${preview}${truncated}\n\nCreation has NOT executed yet. Approve this action?`;

    state.pendingActionSummary = { label: `Create Google Sheet: ${title}`, message: messageText, buttons, createdAt: new Date().toISOString() };

    let telegramOutcome: "delivered" | "rejected" | "unknown";
    try {
      const result = await sendWithOutcome(messageText, buttons);
      telegramOutcome = result.delivered ? "delivered" : "rejected";
    } catch {
      // Unknown delivery outcome: network exception after a send was
      // attempted. Do not blindly retry, do not clear state, do not
      // resolve the claim as "failed". Preserve state.
      console.error(`Folder selection: Telegram delivery outcome unknown (network exception) for work ${state.workId}`);
      await notifyWorkspaceTaskError("⚠️ Telegram delivery of your Google Sheet proposal could not be confirmed. No Google Sheet has been created yet. Please check whether the proposal message arrived before retrying.");
      return state;
    }

    if (telegramOutcome === "rejected") {
      clearPendingState();
      await resolveClaimFailed("⚠️ Google Sheet proposal was staged but could not be delivered. Your selection was recorded — try again or start a fresh selection.");
      return state;
    }

    try {
      await logActivity(env, {
        entry: "Google Sheet creation proposed",
        type: "Activity",
        activity: `Google Sheet creation proposed for '${title}' in folder '${folderName}' (${folderId}) for account '${accountIdentifier}'`,
        outcome: "Active",
      });
    } catch (err) {
      // Telegram was delivered successfully; activity logging failed.
      // Preserve pending state so the delivered proposal button remains usable.
      // Do not resolve the claim as failed or completed merely because logging failed.
      console.error(`Folder selection: Google Sheet proposal activity logging failed for work ${state.workId}`, err);
      await notifyWorkspaceTaskError("⚠️ Your Google Sheet proposal was delivered but activity logging failed. No sheet has been created. Please check whether the proposal message arrived before retrying.");
      return state;
    }

    // STEP 6: Mark the claim completed after successful handoff to the sheet proposal stage.
    await resolveClaimCompleted();
    return state;
  }

  state.pendingGoogleAction = {
    type: "create_doc",
    title,
    content,
    folderId,
    accountIdentifier,
  };

  const preview = content.length > 300 ? `${content.slice(0, 300)}...` : content;
  const messageText = `*Proposed Action*: Create Google Doc\n\n*Title*: ${title}\n*Account*: ${accountIdentifier}\n*Folder*: ${folderName}\n\n*Content Preview*:\n${preview}\n\nCreation has NOT executed yet. Approve this action?`;

  state.pendingActionSummary = { label: `Create Google Doc: ${title}`, message: messageText, buttons, createdAt: new Date().toISOString() };

  let telegramOutcome: "delivered" | "rejected" | "unknown";
  try {
    const result = await sendWithOutcome(messageText, buttons);
    telegramOutcome = result.delivered ? "delivered" : "rejected";
  } catch {
    // Unknown delivery outcome: network exception after a send was
    // attempted. Do not blindly retry, do not clear state, do not
    // resolve the claim as "failed". Preserve state.
    console.error(`Folder selection: Telegram delivery outcome unknown (network exception) for work ${state.workId}`);
    await notifyWorkspaceTaskError("⚠️ Telegram delivery of your Google Doc proposal could not be confirmed. No Google Doc has been created yet. Please check whether the proposal message arrived before retrying.");
    return state;
  }

  if (telegramOutcome === "rejected") {
    clearPendingState();
    await resolveClaimFailed("⚠️ Google Doc proposal was staged but could not be delivered. Your selection was recorded — try again or start a fresh selection.");
    return state;
  }

  try {
    await logActivity(env, {
      entry: "Google Doc creation proposed",
      type: "Activity",
      activity: `Google Doc creation proposed for '${title}' in folder '${folderName}' (${folderId}) for account '${accountIdentifier}'`,
      outcome: "Active",
    });
  } catch (err) {
    // Telegram was delivered successfully; activity logging failed.
    // Preserve pending state so the delivered proposal button remains usable.
    // Do not resolve the claim as failed or completed merely because logging failed.
    console.error(`Folder selection: Google Doc proposal activity logging failed for work ${state.workId}`, err);
    await notifyWorkspaceTaskError("⚠️ Your Google Doc proposal was delivered but activity logging failed. No document has been created. Please check whether the proposal message arrived before retrying.");
    return state;
  }

  // STEP 6: Mark the claim completed after successful handoff to the doc proposal stage.
  await resolveClaimCompleted();
  return state;
}

export async function handleGoogleActionApproval(
  env: Env,
  state: WorkState,
  approved: boolean,
): Promise<WorkState> {
  const action = state.pendingGoogleAction;
  state.pendingGoogleAction = undefined;
  state.pendingActionSummary = undefined;

  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  if (!action || (action.type !== "create_doc" && action.type !== "create_sheet")) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "No valid pending Google action found for this work item.",
    );
    return state;
  }

  // Every path below this point is a final outcome (rejected, created, or
  // failed) -- nothing remains pending on this work item afterward, so mark
  // it terminal. Without this it stayed at its initial "new" stage forever,
  // showing up in /sessions indefinitely as an ambiguous "(new)" entry with
  // nothing left to act on.
  state.stage = "complete";

  const kindLabel = action.type === "create_sheet" ? "Google Sheet" : "Google Doc";

  if (!approved) {
    await logActivity(env, {
      entry: `${kindLabel} creation rejected`,
      type: "Activity",
      area: "Operations",
      activity: `${kindLabel} creation rejected by user for '${action.title}'`,
      outcome: "Blocked",
    });

    await sendWorkspaceHatMessage(
      env,
      target,
      `${kindLabel} creation rejected for *${action.title}*. Nothing was created.`,
    );

    return state;
  }

  if (action.type === "create_sheet") {
    const result = await createGoogleSheet(env, action);

    if (!result.ok) {
      await sendWorkspaceHatMessage(
        env,
        target,
        `⚠️ Google Sheet creation failed during ${result.stage} stage: ${result.error}`,
      );
      return state;
    }

    // Truthful failure AFTER the provider-side effect: the Sheet exists
    // regardless of what storage does. A refused watch write (watch
    // registries are Cloudflare-only) must not turn a created Sheet into
    // a reported failure, and must not be swallowed either -- the
    // success message states plainly that comment polling will not cover
    // this Sheet until a watch is registered.
    let watchWarning = "";
    if (result.spreadsheetId) {
      try {
        await registerWatchedGoogleSheet(env, {
          spreadsheetId: result.spreadsheetId,
          accountIdentifier: action.accountIdentifier,
          title: action.title,
          chatId: state.chatId,
          threadId: state.threadId,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(
          `handlePendingGoogleAction: the Sheet ${result.spreadsheetId} was created but its watch registration was refused -- comments on it will NOT be polled until a watch is registered`,
          err,
        );
        watchWarning =
          "\n\n⚠️ *Watch registration failed* (storage write refused -- likely the daily KV quota): comments on this Sheet will **not** be polled until a watch is registered. Re-register the watch after the quota window resets.";
      }
    }

    await sendWorkspaceHatMessage(
      env,
      target,
      `✅ Google Sheet created and verified successfully!\n\n*Title*: ${action.title}\n*URL*: ${result.spreadsheetUrl}\n\nTip: select a cell, leave a comment describing the change, and it'll be applied automatically within about a minute.${watchWarning}`,
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

  // Truthful failure AFTER the provider-side effect, same as the Sheet
  // path: the Doc exists regardless of what storage does, so a refused
  // watch write (watch registries are Cloudflare-only) must neither fail
  // the creation nor be swallowed silently.
  let watchWarning = "";
  if (result.documentId) {
    try {
      await registerWatchedGoogleDoc(env, {
        documentId: result.documentId,
        accountIdentifier: action.accountIdentifier,
        title: action.title,
        chatId: state.chatId,
        threadId: state.threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `handlePendingGoogleAction: the Doc ${result.documentId} was created but its watch registration was refused -- comments on it will NOT be polled until a watch is registered`,
        err,
      );
      watchWarning =
        "\n\n⚠️ *Watch registration failed* (storage write refused -- likely the daily KV quota): comments on this Doc will **not** be polled until a watch is registered. Re-register the watch after the quota window resets.";
    }
  }

  await sendWorkspaceHatMessage(
    env,
    target,
    `✅ Google Doc created and verified successfully!\n\n*Title*: ${action.title}\n*URL*: ${result.documentUrl}\n\nTip: select text in the doc, leave a comment describing the change, and it'll be applied automatically within about a minute.${watchWarning}`,
  );

  return state;
}
