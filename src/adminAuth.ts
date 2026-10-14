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

export function isAdminAuthorized(request: Request, env: Pick<Env, "WORKER_ADMIN_KEY">): boolean {
  const expected = env.WORKER_ADMIN_KEY;
  if (!expected) return false;
  const presented = request.headers.get(ADMIN_KEY_HEADER) ?? new URL(request.url).searchParams.get("key");
  if (!presented) return false;
  return constantTimeEqual(presented, expected);
}
