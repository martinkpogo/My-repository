import type { Env, WorkState } from "./types";
import { getSessionStub } from "./sessionRouting";
import { isAdminAuthorized } from "./adminAuth";
import {
  RESULT_GATE_SMOKE_WORK_ID_PREFIX,
} from "./runtime/resultGateSmoke";

/**
 * GET /admin/smoke-result-gate-inspect -- READ-ONLY operator inspection of one
 * Result Gate smoke Work's persisted state.
 *
 * Why this exists: after Martin's separate Result approval on a smoke Work,
 * an operator needs to confirm the Work's terminal state (blocked, approved,
 * closed) without re-running the harness -- a re-run would overwrite the
 * very evidence being read and create a new Durable Object execution.
 *
 * Contract -- this route is inspection and nothing else:
 * - authentication is a request header (X-Worker-Admin-Key), never a query
 *   parameter, so the admin secret never lands in the URL or in observability
 *   logs;
 * - fail-closed: no WORKER_ADMIN_KEY secret, no header, or a wrong header are
 *   all 403; a missing/malformed workId is 400 and never reaches idFromName,
 *   so no Durable Object is instantiated for garbage input;
 * - only `result-gate-smoke-<uuid>` ids are accepted -- a real business Work
 *   id can never be inspected through this route;
 * - the ONLY Durable Object call is `getState()` on the stub -- no execute(),
 *   no init(), no Handoff claim, no Notion/Telegram/Activity Log write, no
 *   session execution of any kind;
 * - the response is a fixed, minimal projection. Identity-bearing fields
 *   (chatId, threadId, entityName, matterName, enquiryText) are never
 *   returned; neither is the approval button token.
 */

const JSON_HEADERS = { "content-type": "application/json" };

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status, headers: JSON_HEADERS });
}

const SMOKE_WORK_ID_SHAPE = /^result-gate-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handleResultGateSmokeInspect(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) {
    return new Response("forbidden", { status: 403 });
  }

  const workId = new URL(request.url).searchParams.get("workId");
  if (!workId || !SMOKE_WORK_ID_SHAPE.test(workId)) {
    return jsonError(400, `workId must be "${RESULT_GATE_SMOKE_WORK_ID_PREFIX}<uuid>"`);
  }

  const state = (await getSessionStub(env, workId).getState()) as WorkState | undefined;
  if (!state) {
    return jsonError(404, "smoke work state not found");
  }

  const review = state.resultReview;
  const resultReviewProjection = review
    ? {
        gateStatus: review.gateStatus ?? null,
        blockReason: review.blockReason ?? null,
        preBlockStage: review.preBlockStage ?? null,
        checker: review.checker
          ? {
              outcome: review.checker.outcome,
              checkerId: review.checker.checkerId,
              reason: review.checker.reason ?? null,
              verdictHash: review.checker.verdictHash ?? null,
            }
          : null,
        approval: review.approval
          ? {
              approver: review.approval.approver,
              approvedAt: review.approval.approvedAt,
              reviewHash: review.approval.reviewHash,
            }
          : null,
        pendingApproval: review.pendingApproval
          ? { staged: true, createdAt: review.pendingApproval.createdAt }
          : null,
      }
    : null;

  return new Response(
    JSON.stringify({
      workId: state.workId ?? null,
      unit: state.unit ?? null,
      hat: state.hat ?? null,
      action: state.actionName ?? null,
      stage: state.stage ?? null,
      createdAt: state.createdAt ?? null,
      updatedAt: state.updatedAt ?? null,
      handoffId: state.handoffId ?? null,
      blockedReason: state.blockedReason ?? null,
      resultReview: resultReviewProjection,
    }),
    { headers: JSON_HEADERS },
  );
}
