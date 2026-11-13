import type { Env } from "./types";
import { getSessionStub } from "./sessionRouting";
import { isAdminAuthorized } from "./adminAuth";
import {
  RESULT_GATE_SMOKE_WORK_ID_PREFIX,
  isResultGateSmokeWorkId,
  newResultGateSmokeWorkId,
  parseResultGateSmokeParams,
  type ResultGateSmokeReport,
} from "./runtime/resultGateSmoke";

/**
 * GET /admin/smoke-result-gate -- the isolated live Result Gate smoke
 * harness (ENIG issue #370). Follows the existing governed Google Docs
 * smoke pattern (`/admin/smoke-google-docs`) and the operator-inspection
 * route's response discipline (`/admin/work-session-state`).
 *
 * Contract -- this route drives exactly one synthetic Work and nothing
 * else:
 * - authentication is the ONE admin-key check (`isAdminAuthorized`), before
 *   any Durable Object is instantiated; no secret, no wrong secret and no
 *   configured-secret-absent case is ever authorized (fail closed);
 * - the query string accepts only `origin`, `action` and `work_id` (plus
 *   the existing admin-auth `key`), each at most once; `origin` and `action`
 *   are REQUIRED and must equal the harness constants exactly -- a missing,
 *   empty or different value is HTTP 400 before any Durable Object is
 *   looked up, and there is no parameter for a Unit, Hat, Responsibility,
 *   Telegram destination, thread or any other Action, so the caller cannot
 *   aim the harness anywhere;
 * - a `work_id`, when supplied, must already carry the dedicated
 *   `result-gate-smoke-<uuid>` shape; when omitted the route generates a
 *   fresh one. Either way the id is validated BEFORE `idFromName`, so
 *   garbage input never instantiates a Durable Object;
 * - the ONLY Durable Object call is `runResultGateSmoke(workId)`, whose
 *   own pre-flight refuses before creating a Work when the destination, the
 *   in-process Action resolution (manifest + Resolution, no Notion fetch of
 *   its own) or the Work itself is unusable;
 * - the response is the harness report itself (work id, target, evidence,
 *   verification verdict and its snapshot identity, approval state, final
 *   stage and whether the Work is closed). It deliberately carries no
 *   Telegram chat id or destination of any kind;
 * - the two facts an operator must never confuse are separate fields:
 *   `harness_execution` (`"completed"` | `"refused"`) says whether the
 *   harness ran, and `result_gate` (`"passed"` | `"failed"` |
 *   `"no_usable_verdict"`) is the Result Gate verdict itself -- a recorded
 *   FAIL is `harness_execution: "completed"` with `result_gate: "failed"`,
 *   never a passing Result Gate test;
 * - HTTP 200 means the harness completed its sequence with a recorded
 *   verdict (check `result_gate` for the verdict); a harness refusal
 *   (including an unavailable verification) is HTTP 500 with the same body
 *   carrying `ok: false`, `harness_execution: "refused"` and `refusal`; an
 *   unexpected throw is HTTP 500 with a fixed error body.
 *
 * The live endpoint is NOT invoked by this repository's tests: the live run
 * is authorized separately, after Architect review.
 */

const JSON_HEADERS = { "content-type": "application/json" };

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: JSON_HEADERS });
}

export async function handleResultGateSmokeRequest(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) {
    return new Response("forbidden", { status: 403 });
  }

  const params = parseResultGateSmokeParams(new URL(request.url).searchParams);
  if (!params.ok) {
    return jsonError(400, params.reason);
  }

  const workId = params.work_id ?? newResultGateSmokeWorkId();
  if (!isResultGateSmokeWorkId(workId)) {
    return jsonError(400, `work_id must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>"`);
  }

  try {
    const report = (await getSessionStub(env, workId).runResultGateSmoke(workId)) as ResultGateSmokeReport;
    return new Response(JSON.stringify(report), {
      status: report?.ok ? 200 : 500,
      headers: JSON_HEADERS,
    });
  } catch (err) {
    console.error("Unhandled error in /admin/smoke-result-gate", err);
    return jsonError(500, "internal error, logged");
  }
}
