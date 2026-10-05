import type { Env, WorkState } from "./types";
import { getSessionStub } from "./sessionRouting";

/**
 * GET /admin/work-session-state -- READ-ONLY operator inspection of one
 * WorkSession Durable Object's persisted state.
 *
 * Why this exists: a Strategy Skill cycle that stops at the invocation cap
 * records its per-Skill sequence only in WorkState.strategySkillFindings.
 * Before PR #232 that sequence reached no durable operator surface, so
 * recovering it for a blocked WorkSession requires reading this state rather
 * than re-running (re-running would overwrite the very evidence being read,
 * and would mutate the Handoff/Activity Log).
 *
 * Contract -- this route is inspection and nothing else:
 * - authentication is a request header (X-Worker-Admin-Key), never a query
 *   parameter, so the admin secret never lands in the URL or in observability
 *   logs (wrangler.toml sets redact_query_string = false);
 * - fail-closed: no WORKER_ADMIN_KEY secret, no header, or a wrong header are
 *   all 403; a missing/malformed workId is 400 and never reaches idFromName,
 *   so no Durable Object is instantiated for garbage input;
 * - the ONLY Durable Object call made is stub.getState() -- no execute(),
 *   no Handoff claim, no Notion/Telegram/Activity Log write, no session
 *   execution of any kind;
 * - the response is a fixed projection. The full WorkState carries identity
 *   (entityName/matterName/enquiryText), the operator's chatId/threadId, and
 *   Skill finding prose that PR #232 deliberately keeps off every blocker
 *   surface -- none of it is ever returned. Only the fields needed to recover
 *   the invocation sequence are.
 */

// Exact UUID shape. Deliberately strict: idFromName() would happily derive a
// Durable Object id from any string, instantiating an empty object for input
// nobody meant.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JSON_HEADERS = { "content-type": "application/json" };

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}

export async function handleWorkSessionState(request: Request, env: Env): Promise<Response> {
  const adminKey = request.headers.get("X-Worker-Admin-Key");
  if (!env.WORKER_ADMIN_KEY || !adminKey || adminKey !== env.WORKER_ADMIN_KEY) {
    return new Response("forbidden", { status: 403 });
  }

  const workId = new URL(request.url).searchParams.get("workId");
  if (!workId || !UUID_PATTERN.test(workId)) {
    return jsonError(400, "workId must be a UUID");
  }

  const state = (await getSessionStub(env, workId).getState()) as WorkState | undefined;
  if (!state) {
    return jsonError(404, "work session state not found");
  }

  // Array order IS the invocation order: runStrategySkillCycle pushes each
  // finding inside its sequential await loop, so index + 1 is the invocation
  // number. Nothing here reorders or renumbers.
  const strategySkillFindings = (state.strategySkillFindings ?? []).map((finding, index) => ({
    invocation: index + 1,
    skillId: finding.skillId ?? null,
    status: finding.status ?? null,
  }));

  return new Response(
    JSON.stringify({
      workId: state.workId ?? null,
      handoffId: state.handoffId ?? null,
      stage: state.stage ?? null,
      updatedAt: state.updatedAt ?? null,
      strategySkillCycleUnavailable:
        typeof state.strategySkillCycleUnavailable === "boolean" ? state.strategySkillCycleUnavailable : null,
      strategySkillFindings,
    }),
    { headers: JSON_HEADERS },
  );
}
