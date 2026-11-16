import type { Env } from "./types";
import { getSessionStub } from "./sessionRouting";
import { isAdminAuthorized } from "./adminAuth";
import { isResultGateSmokeWorkId, newResultGateSmokeWorkId, parseResultGateSmokeParams, RESULT_GATE_SMOKE_WORK_ID_PREFIX, type ResultGateSmokeReport } from "./runtime/resultGateSmoke";

/**
 * GET /admin/smoke-result-gate -- the isolated live Result Gate smoke harness
 * (ENIG #370, rebuilt 16 Nov 2026). Admin key first, then the strict query
 * contract, both before any Durable Object exists; the ONLY Durable Object
 * call is `runResultGateSmoke(workId)`.
 *
 * HTTP 200 means only that the harness ran its sequence: read `overall` for
 * the outcome (right after a run it is at best "awaiting_martin" -- the Work
 * closes only after Martin's tap, which the read-only inspection then
 * reports). A harness refusal is HTTP 500 with `harness_execution: "refused"`
 * and `refusal`. The response carries no chat id, token or destination.
 *
 * Not invoked by any repository test: the live run is Martin's.
 */
const JSON_HEADERS = { "content-type": "application/json" };

export async function handleResultGateSmokeRequest(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) return new Response("forbidden", { status: 403 });
  const params = parseResultGateSmokeParams(new URL(request.url).searchParams);
  if (!params.ok) return new Response(JSON.stringify({ ok: false, error: params.reason }), { status: 400, headers: JSON_HEADERS });
  const workId = params.work_id ?? newResultGateSmokeWorkId();
  if (!isResultGateSmokeWorkId(workId)) return new Response(JSON.stringify({ ok: false, error: `work_id must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>"` }), { status: 400, headers: JSON_HEADERS });
  try {
    const report = (await getSessionStub(env, workId).runResultGateSmoke(workId)) as ResultGateSmokeReport;
    return new Response(JSON.stringify(report), { status: report?.harness_execution === "completed" ? 200 : 500, headers: JSON_HEADERS });
  } catch (err) {
    console.error("Unhandled error in /admin/smoke-result-gate", err);
    return new Response(JSON.stringify({ ok: false, error: "internal error, logged" }), { status: 500, headers: JSON_HEADERS });
  }
}
