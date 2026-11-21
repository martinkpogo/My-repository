/**
 * Stage 4D runtime test harness entrypoint.
 *
 * Test-only Worker that binds the production WorkSession Durable Object class
 * and exposes HTTP endpoints to invoke its public claim methods through
 * Durable Object RPC. Isolated from the production Worker entrypoint
 * (src/index.ts) and production configuration (wrangler.toml).
 *
 * Used with: wrangler dev --config wrangler.test.toml
 */
import { WorkSession } from "../session";
import type { Env } from "../types";

export { WorkSession };

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const workId = url.searchParams.get("workId") ?? "runtime-test-work";
    const opaqueId = url.searchParams.get("opaqueId") ?? "runtime-test-opaque";
    const status = url.searchParams.get("status") as "completed" | "failed" | undefined;

    const id = env.WORK_SESSION.idFromName(workId);
    const stub = env.WORK_SESSION.get(id) as unknown as WorkSession;

    let result: unknown;
    try {
      if (path === "/claim") {
        result = await stub.claimFolderOption(opaqueId);
      } else if (path === "/resolve") {
        if (!status) {
          return new Response(JSON.stringify({ error: "status query param required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        result = await stub.resolveFolderClaim(opaqueId, status);
      } else if (path === "/status") {
        result = await stub.getFolderClaimStatus(opaqueId);
      } else {
        return new Response(JSON.stringify({ error: "unknown endpoint" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
