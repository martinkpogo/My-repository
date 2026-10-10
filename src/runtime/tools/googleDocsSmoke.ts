/**
 * GOVERNED GOOGLE DOCS SMOKE -- the live verification harness for the shared
 * Tool Registry (ENIG HQ > 6. Tools; Activity & Decision Log LOG-1069).
 *
 * Martin approved (2026-10-10, option (b)) a dedicated, fail-closed smoke
 * path so ONE real `google_docs.create_and_verify` can run through the
 * EXACT invocation boundary (src/runtime/toolRegistry.ts) against an
 * explicitly disposable Drive folder -- never the production "ENIG Proposals
 * (token-safe)" folder, and never a folder id from source code: the
 * disposable folder id lives only in runtime state under
 * `google_smoke_test_folder:<account>` (src/kvStore.ts, the same convention
 * as `google_proposal_docs_folder:<account>`).
 *
 * This module owns the smoke's OWN policy (which governed Action the smoke
 * Work records, which runtime key holds the disposable target, when the
 * Work is closed) and its orchestration; it deliberately owns no mechanism
 * of its own:
 *
 *   - the governed Work is created through the caller's creation seam (the
 *     WorkSession Durable Object's own `init`, src/session.ts), so the
 *     Action is validated against the Unit Manifest by `recordWorkAction`
 *     exactly like any other Work -- nothing here can record an undeclared
 *     Action as authority;
 *   - the invocation is the registered operation through `invokeTool` with
 *     `workSessionContext(state)`: Access judges the Work's OWN recorded
 *     Action's declaration, and input validation, trusted target
 *     resolution, the durable intent/outcome records, the handler and the
 *     read-back verification are all the Registry's unchanged ones;
 *   - durable operation persistence is installed by `WorkSession.execute`
 *     through the caller's runner seam, so the fail-closed "no adapter, no
 *     effect" rule and the interruption-window recovery apply unchanged.
 *
 * Fail-closed everywhere: a non-smoke Work id, an unresolvable account set
 * (the same exactly-one rule the proposal flow uses), a missing folder
 * configuration, or a Work that cannot be established all refuse BEFORE any
 * Google request, and no step ever messages a chat. The smoke Work is
 * closed through the governed lifecycle only after a clean terminal end
 * (succeeded/denied); an uncertain effect keeps it open with its durable
 * records intact so reconciliation still has its evidence.
 */
import type { Env, Unit, WorkState } from "../../types";
import { workSessionContext } from "../../access";
import { listAuthorizedGoogleAccounts } from "../../googleOAuth";
import { kvGet } from "../../kvStore";
import { invokeTool, type ToolInvocationOutcome } from "../toolRegistry";
import { GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, GOOGLE_DOCS_TOOL_ID } from "./googleDocsTool";

/** Runtime-state key holding the disposable folder id, suffixed with the authorized account. */
export const GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX = "google_smoke_test_folder";

/** Every smoke Work id begins with this prefix; a real Work id can never be used for the smoke. */
export const GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX = "smoke-googledocs-";

/**
 * The governed Work the smoke records: a real Sales Executive write Action
 * that declares `google_docs.create_and_verify` and is not approval-gated
 * (src/units/sales/salesManifest.ts). No approval evidence exists to forge
 * here precisely because this Action requires none; an approval-gated
 * Action (proposal_approve) is deliberately not the smoke's Authority.
 */
export const GOOGLE_DOCS_SMOKE_WORK = {
  unit: "Sales" as Unit,
  hat: "Sales Executive",
  actionName: "proposal_draft",
} as const;

/** The smoke Work belongs to no Telegram chat; nothing in this path messages. */
export const GOOGLE_DOCS_SMOKE_CHAT_ID = 0;

/** What one smoke run reports back: the Registry outcome, or why a pre-flight gate refused. */
export interface GoogleDocsSmokeResult {
  work_id: string;
  /** The Registry outcome for the governed invocation, or null when a pre-flight gate refused before any Work existed or any request was made. */
  outcome: ToolInvocationOutcome | null;
  /** Why a pre-flight gate refused; never set together with an outcome. */
  blocked_reason?: string;
  /** Whether the smoke Work was closed through the governed lifecycle after a clean terminal end. */
  work_closed: boolean;
}

/**
 * The caller-side seams, implemented by the WorkSession Durable Object:
 * genuine Work creation, the `execute` cycle that installs durable
 * operation persistence, and the governed lifecycle close.
 */
export interface GoogleDocsSmokeWorkRunner {
  ensureGovernedWork(workId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  runWithWorkPersistence(workId: string, fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState>;
  closeGovernedWork(workId: string): Promise<void>;
}

/**
 * The exact invocation input for one smoke run. Title and content are
 * token-free by construction (a smoke marker, the Work id and the operation
 * id -- nothing identity-bearing), and the title's unique suffix keeps each
 * run's reconciliation-by-title search exact.
 */
export function googleDocsSmokeInput(workId: string, folderId: string, accountIdentifier: string) {
  const suffix = workId.startsWith(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX)
    ? workId.slice(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX.length, GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX.length + 8).toUpperCase()
    : workId.slice(0, 8).toUpperCase();
  return {
    title: `ENIG-REGISTRY-SMOKE-${suffix}`,
    content: `ENIG Tool Registry live smoke test.\nWork: ${workId}\nOperation: ${GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID}\nDisposable verification content. No client data.\n`,
    folder_id: folderId,
    account_identifier: accountIdentifier,
  };
}

/**
 * Runs the ONE governed smoke invocation. Every gate is evaluated in the
 * order that keeps the blast radius smallest: id shape, then trusted
 * account set, then the configured disposable target, then the governed
 * Work, and only then the Registry -- whose own boundary (input validation,
 * trusted target resolution, Access on the Work's recorded Action, durable
 * records, read-back verification, reconciliation) is what actually judges
 * and performs the operation.
 */
export async function runGoogleDocsSmoke(
  env: Env,
  workId: string,
  runner: GoogleDocsSmokeWorkRunner,
): Promise<GoogleDocsSmokeResult> {
  const blocked = (reason: string): GoogleDocsSmokeResult => ({
    work_id: String(workId),
    outcome: null,
    blocked_reason: reason,
    work_closed: false,
  });

  if (typeof workId !== "string" || !workId.startsWith(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX)) {
    return blocked(`smoke Work ids must begin with "${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}" -- a real Work id can never be used for the smoke.`);
  }

  // Trusted account resolution -- the proposal flow's own exactly-one rule
  // (ensureProposalDoc): the smoke never selects an account itself.
  const accounts = await listAuthorizedGoogleAccounts(env);
  if (accounts.length !== 1) {
    return blocked(
      accounts.length === 0
        ? "no Google account is authorized for this Worker -- the smoke refuses to select an account, so nothing was requested."
        : `${accounts.length} Google accounts are authorized and the smoke never guesses which to use -- exactly one must be authorized.`,
    );
  }
  const accountIdentifier = accounts[0];

  // The explicitly designated disposable target -- runtime state only, so
  // no folder id ever lives in source. Absent configuration refuses here,
  // before any Work exists or any Google request is made.
  const folderId = (await kvGet(env, `${GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX}:${accountIdentifier}`))?.trim();
  if (!folderId) {
    return blocked(
      `no disposable test folder is configured: runtime state "${GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX}:${accountIdentifier}" is empty -- the smoke creates nothing without its explicitly designated target.`,
    );
  }

  // A genuine governed Work, created through the caller's creation seam.
  const established = await runner.ensureGovernedWork(workId);
  if (!established.ok) {
    return blocked(established.reason);
  }

  // Exactly one registered invocation, judged by the Work's own recorded
  // Action, under the durable persistence `execute` installs.
  const input = googleDocsSmokeInput(workId, folderId, accountIdentifier);
  let outcome: ToolInvocationOutcome | undefined;
  await runner.runWithWorkPersistence(workId, async (state) => {
    if (state.workId !== workId) {
      throw new Error(`smoke Work mismatch: the runner presented Work ${state.workId} for smoke ${workId} -- refusing to judge the invocation under another Work's Action.`);
    }
    outcome = await invokeTool(
      env,
      { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input },
      workSessionContext(state),
    );
    return state;
  });
  if (outcome === undefined) {
    return blocked("the smoke Work never reached the invocation (the runner returned without running it) -- no request was made.");
  }

  // Governed close, only on a clean terminal end: `succeeded` proved the
  // effect, `denied` proved there was none. A `failed`/`partially_completed`/
  // `unverified` effect keeps the smoke Work OPEN -- its durable operation
  // records stay discoverable for reconciliation, exactly as the recovery
  // contract requires.
  let workClosed = false;
  if (outcome.state === "succeeded" || outcome.state === "denied") {
    await runner.closeGovernedWork(workId);
    workClosed = true;
  }
  return { work_id: workId, outcome, work_closed: workClosed };
}
