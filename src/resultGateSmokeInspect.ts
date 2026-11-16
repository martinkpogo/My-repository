import type { Env, WorkState } from "./types";
import { getSessionStub } from "./sessionRouting";
import { isAdminAuthorized } from "./adminAuth";
import { assessResultGateSmoke, isResultGateSmokeWorkId, RESULT_GATE_SMOKE_WORK_ID_PREFIX } from "./runtime/resultGateSmoke";

/**
 * GET /admin/smoke-result-gate-inspect?workId=... -- READ-ONLY inspection of
 * one Result Gate smoke Work (ENIG #370 finding 1, rebuilt 16 Nov 2026).
 *
 * Inspection and nothing else: admin key in the X-Worker-Admin-Key header
 * (isAdminAuthorized), only `result-gate-smoke-<uuid>` ids (validated before
 * idFromName, so a real Work can never be inspected here), and the ONLY
 * Durable Object call is `getState()` -- no execute, no init, no write of any
 * kind. The response is the same shared assessment the harness reports
 * (assessResultGateSmoke), plus the Work's own identity fields; chat ids,
 * thread ids, the approval button token and the artefact content are never
 * returned.
 */
const JSON_HEADERS = { "content-type": "application/json" };

export async function handleResultGateSmokeInspect(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) return new Response("forbidden", { status: 403 });
  const workId = new URL(request.url).searchParams.get("workId");
  if (!isResultGateSmokeWorkId(workId)) return new Response(JSON.stringify({ ok: false, error: `workId must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>"` }), { status: 400, headers: JSON_HEADERS });
  const state = (await getSessionStub(env, workId).getState()) as WorkState | undefined;
  if (!state) return new Response(JSON.stringify({ ok: false, error: "smoke Work not found" }), { status: 404, headers: JSON_HEADERS });
  const assessment = await assessResultGateSmoke(state);
  return new Response(
    JSON.stringify({
      work_id: state.workId,
      unit: state.unit ?? null,
      hat: state.hat ?? null,
      action: state.actionName ?? null,
      created_at: state.createdAt ?? null,
      updated_at: state.updatedAt ?? null,
      ...assessment,
    }),
    { headers: JSON_HEADERS },
  );
}
