import type { Env } from "./types";

/**
 * The ONE admin-key check for every operator endpoint (`/admin/*` and the
 * Google OAuth operator routes). It replaces the copy of
 * `key !== env.WORKER_ADMIN_KEY` that each route used to carry.
 *
 * - Fail closed: no `WORKER_ADMIN_KEY` secret configured, or no credential
 *   presented, is never authorized.
 * - Constant-time comparison (no early exit on the first differing byte, and
 *   the length difference is folded into the result rather than returned
 *   early), so response time does not reveal how much of a guess was right.
 * - The `X-Worker-Admin-Key` header is the preferred channel: unlike a URL
 *   query string it is not written to scheduler configuration screens,
 *   browser history, or any intermediary's access log. `?key=` is still
 *   accepted because the external schedulers and the browser-opened Google
 *   OAuth links use it today; retiring it is a separate decision that needs
 *   those callers moved first.
 * - Query-channel migration support: every request that presents the key in
 *   the URL writes one `admin_auth channel=query ...` log line (path and
 *   outcome only -- never the key, never the query string), so the remaining
 *   `?key=` callers can be counted from Workers logs, with no KV write.
 *   Setting `ADMIN_REJECT_QUERY_KEY` to "1" (or "true") makes the query
 *   channel refuse outright; unset or any other value leaves it accepted.
 *   It ships OFF -- turning it on is a separate, approved step taken only
 *   after the scheduler jobs send the header.
 */
export const ADMIN_KEY_HEADER = "X-Worker-Admin-Key";

const encoder = new TextEncoder();

export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function queryKeyRejected(env: Pick<Env, "ADMIN_REJECT_QUERY_KEY">): boolean {
  const flag = env.ADMIN_REJECT_QUERY_KEY?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export function isAdminAuthorized(request: Request, env: Pick<Env, "WORKER_ADMIN_KEY" | "ADMIN_REJECT_QUERY_KEY">): boolean {
  const expected = env.WORKER_ADMIN_KEY;
  if (!expected) return false;
  const header = request.headers.get(ADMIN_KEY_HEADER);
  if (header !== null) return header !== "" && constantTimeEqual(header, expected);

  const url = new URL(request.url);
  const query = url.searchParams.get("key");
  if (!query) return false;
  if (queryKeyRejected(env)) {
    console.log(`admin_auth channel=query outcome=rejected_by_policy path=${url.pathname}`);
    return false;
  }
  const ok = constantTimeEqual(query, expected);
  console.log(`admin_auth channel=query outcome=${ok ? "accepted" : "denied"} path=${url.pathname}`);
  return ok;
}
