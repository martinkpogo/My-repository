import type { Env } from "./types";

const TOKEN_ENDPOINT = "https://authn.read.ai/oauth2/token";
const AUTHORIZE_UI = "https://api.read.ai/oauth/ui";
const API_BASE = "https://api.read.ai";
const SCOPE = "openid email offline_access profile meeting:read";
const TOKENS_KV_KEY = "readai_oauth_tokens";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface ReadAiMeeting {
  id: string;
  title?: string;
  start_time_ms?: number;
  end_time_ms?: number;
  report_url?: string;
  summary?: string;
  action_items?: { text: string }[];
  key_questions?: { text: string }[];
  transcript?: { speaker_blocks?: { speaker?: { name?: string }; words?: string }[] };
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

export function buildAuthorizeUrl(env: Env, redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: requireClientId(env),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_UI}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<void> {
  const data = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  await persistTokens(env, data);
}

export async function isAuthorized(env: Env): Promise<boolean> {
  return (await loadTokens(env)) !== null;
}

/** Returns a currently-valid access token, refreshing (and rotating the stored refresh token) if needed. */
export async function getValidAccessToken(env: Env): Promise<string | null> {
  const stored = await loadTokens(env);
  if (!stored) return null;
  if (stored.expires_at - Date.now() > 30_000) return stored.access_token;

  try {
    const data = await tokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    });
    await persistTokens(env, data);
    return data.access_token;
  } catch (err) {
    console.error("Read.ai token refresh failed - re-authorization needed", err);
    return null;
  }
}

export async function listRecentMeetings(env: Env, sinceMs: number): Promise<ReadAiMeeting[]> {
  const token = await getValidAccessToken(env);
  if (!token) throw new Error("Read.ai not authorized");
  const params = new URLSearchParams({ limit: "10" });
  params.append("start_time_ms.gte", String(sinceMs));
  const res = await fetch(`${API_BASE}/v1/meetings?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Read.ai list meetings failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: ReadAiMeeting[] };
  return data.data ?? [];
}

export async function getMeeting(env: Env, id: string): Promise<ReadAiMeeting> {
  const token = await getValidAccessToken(env);
  if (!token) throw new Error("Read.ai not authorized");
  const params = new URLSearchParams();
  for (const field of ["summary", "transcript", "action_items", "key_questions"]) {
    params.append("expand[]", field);
  }
  const res = await fetch(`${API_BASE}/v1/meetings/${id}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Read.ai get meeting failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ReadAiMeeting;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const basicAuth = btoa(`${requireClientId(env)}:${requireClientSecret(env)}`);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`Read.ai token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

async function persistTokens(env: Env, data: TokenResponse): Promise<void> {
  const stored: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await env.STATE_KV.put(TOKENS_KV_KEY, JSON.stringify(stored));
}

async function loadTokens(env: Env): Promise<StoredTokens | null> {
  const raw = await env.STATE_KV.get(TOKENS_KV_KEY);
  return raw ? (JSON.parse(raw) as StoredTokens) : null;
}

function requireClientId(env: Env): string {
  if (!env.READAI_OAUTH_CLIENT_ID) throw new Error("READAI_OAUTH_CLIENT_ID not configured");
  return env.READAI_OAUTH_CLIENT_ID;
}

function requireClientSecret(env: Env): string {
  if (!env.READAI_OAUTH_CLIENT_SECRET) throw new Error("READAI_OAUTH_CLIENT_SECRET not configured");
  return env.READAI_OAUTH_CLIENT_SECRET;
}

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
