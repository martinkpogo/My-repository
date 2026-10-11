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
 * After a creation that its OWN read-back verification proved, the same
 * confirmed run performs one more governed invocation: exactly one
 * `google_docs.update_and_verify` -- the actual content-rewrite operation
 * (delete + insert + canonical styling in one batchUpdate, carrying PR
 * #269's corrected request shapes) -- whose target is taken from the
 * verified creation outcome itself, never from caller input or any
 * selection. That binding makes the rewrite structurally incapable of
 * pointing at any other document: it can only rewrite THE disposable Doc
 * this same run created and proved. Both invocations are judged by the
 * same Work's own recorded Action (`proposal_draft` declares both
 * operations, src/units/sales/salesManifest.ts), run under the same
 * durable persistence, and each keeps its own durable intent/outcome
 * records and canonical five outcomes.
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
import { GOOGLE_DOCS_UPDATE_OPERATION_ID } from "./googleDocsUpdateTool";

/** Runtime-state key holding the disposable folder id, suffixed with the authorized account. */
export const GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX = "google_smoke_test_folder";

/** Every smoke Work id begins with this prefix; a real Work id can never be used for the smoke. */
export const GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX = "smoke-googledocs-";

/** Whether a Work id belongs to a Registry smoke flow (never a real business Work). */
export function isGoogleDocsSmokeWorkId(workId: unknown): workId is string {
  return typeof workId === "string" && workId.startsWith(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX);
}

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
  /** The Registry outcome for the governed CREATE invocation, or null when a pre-flight gate refused before any Work existed or any request was made. */
  outcome: ToolInvocationOutcome | null;
  /**
   * The Registry outcome of the governed REWRITE invocation
   * (`google_docs.update_and_verify`) over THE disposable Doc this run
   * created, or null when no rewrite could exist (any pre-flight refusal,
   * and any creation outcome other than a verified success -- a Doc that
   * was never provably created is never rewritten).
   */
  rewrite_outcome: ToolInvocationOutcome | null;
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

/** The8-char display suffix a smoke Work id contributes to its Doc title and Proposal id (identical derivation for every smoke input). */
function smokeSuffix(workId: string): string {
  return workId.startsWith(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX)
    ? workId.slice(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX.length, GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX.length + 8).toUpperCase()
    : workId.slice(0, 8).toUpperCase();
}

/**
 * The exact invocation input for one smoke run. Title and content are
 * token-free by construction (a smoke marker, the Work id and the operation
 * id -- nothing identity-bearing), and the title's unique suffix keeps each
 * run's reconciliation-by-title search exact.
 */
export function googleDocsSmokeInput(workId: string, folderId: string, accountIdentifier: string) {
  return {
    title: `ENIG-REGISTRY-SMOKE-${smokeSuffix(workId)}`,
    content: `ENIG Tool Registry live smoke test.\nWork: ${workId}\nOperation: ${GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID}\nDisposable verification content. No client data.\n`,
    folder_id: folderId,
    account_identifier: accountIdentifier,
  };
}

/**
 * The governed rewrite invocation's exact input: THE disposable Doc this
 * run just created and verified (its id comes from the create outcome, is
 * passed in here by the invocation core, and is re-validated by the
 * operation's own opaque-id contract), and a rewrite content that is
 * deliberately DIFFERENT from the creation content so the batchUpdate is a
 * real rewrite (delete + insert + styling) whose read-back proves the new
 * text -- not a no-op restatement of what the Doc already holds. Proposal
 * id and content are token-free by construction.
 */
export function googleDocsSmokeRewriteInput(workId: string, documentId: string, accountIdentifier: string) {
  return {
    document_id: documentId,
    account_identifier: accountIdentifier,
    proposal_id: `REGISTRY-SMOKE-${smokeSuffix(workId)}`,
    versions: [
      {
        version: 1,
        // The `- ` line maps to a `bullet` block (currentZoneBlockKind), so
        // the rewrite exercises the corrected #269 `createParagraphBullets`
        // preset as well as the corrected `updateParagraphStyle` shapes.
        content: `ENIG Tool Registry live smoke REWRITE pass.\nWork: ${workId}\nOperation: ${GOOGLE_DOCS_UPDATE_OPERATION_ID}\n- Governed rewrite bullet marker.\nDisposable verification content. No client data.\n`,
      },
    ],
  };
}

/**
 * Runs the governed smoke's registered invocations in order: the creation
 * of THE disposable Doc, and -- only after that creation was proved by its
 * own read-back -- the content rewrite of that same Doc. Every gate is
 * evaluated in the order that keeps the blast radius smallest: id shape,
 * then trusted account set, then the configured disposable target, then the
 * governed Work, and only then the Registry -- whose own boundary (input
 * validation, trusted target resolution, Access on the Work's recorded
 * Action, durable records, read-back verification, reconciliation) is what
 * actually judges and performs each operation.
 */
export async function runGoogleDocsSmoke(
  env: Env,
  workId: string,
  runner: GoogleDocsSmokeWorkRunner,
): Promise<GoogleDocsSmokeResult> {
  const blocked = (reason: string): GoogleDocsSmokeResult => ({
    work_id: String(workId),
    outcome: null,
    rewrite_outcome: null,
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

  // The shared invocation core -- the same one the interactive Telegram
  // confirmation path uses (src/googleDocsSmokeFlow.ts), so every smoke
  // entry has exactly one Registry execution and one close rule.
  return runGoogleDocsSmokeInvocation(
    env,
    { workId, accountIdentifier, folderId },
    { runWithWorkPersistence: runner.runWithWorkPersistence, closeGovernedWork: runner.closeGovernedWork },
  );
}

/** The target one smoke run is bound to: one account of the Worker's authorized set and one disposable folder. */
export interface GoogleDocsSmokeInvocationTarget {
  workId: string;
  accountIdentifier: string;
  folderId: string;
}

/** The Work-side seams the invocation core needs (a subset of the full runner). */
export interface GoogleDocsSmokeInvocationRunner {
  runWithWorkPersistence(workId: string, fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState>;
  closeGovernedWork(workId: string): Promise<void>;
}

/**
 * THE shared smoke invocation core: validates the chosen account against
 * the Worker's OWN authorized set (a confirmed selection alone is never
 * authority), then runs TWO registered operations through `invokeTool`,
 * each judged by the Work's own recorded Action under the durable
 * persistence the runner's execute cycle installs:
 *
 *   1. exactly one `google_docs.create_and_verify` (the disposable Doc), and
 *   2. only after that creation returned a VERIFIED success, exactly one
 *      `google_docs.update_and_verify` -- the content rewrite -- whose
 *      document id is taken from the creation outcome's own verified
 *      `remote_resource.document_id`, never from caller input. A creation
 *      that failed, was denied, or is unverified/partial leaves nothing to
 *      rewrite, so no rewrite request is ever attempted in those cases.
 *
 * The terminal-only close rule then applies to the run as a whole: the
 * Work closes only when every attempted operation ended cleanly
 * (`succeeded` proved the effect, `denied` proved there was none); any
 * `failed`/`partially_completed`/`unverified` outcome -- from either step
 * -- keeps the Work open with its durable records intact for
 * reconciliation. Entries add their own target gates around this; this
 * core never chooses an account, folder, or rewrite target itself.
 */
export async function runGoogleDocsSmokeInvocation(
  env: Env,
  target: GoogleDocsSmokeInvocationTarget,
  runner: GoogleDocsSmokeInvocationRunner,
): Promise<GoogleDocsSmokeResult> {
  const blocked = (reason: string): GoogleDocsSmokeResult => ({
    work_id: target.workId,
    outcome: null,
    rewrite_outcome: null,
    blocked_reason: reason,
    work_closed: false,
  });

  const accounts = await listAuthorizedGoogleAccounts(env);
  if (!accounts.includes(target.accountIdentifier)) {
    return blocked(
      `account "${target.accountIdentifier}" is not one of the ${accounts.length} account(s) this Worker is authorized for -- the smoke may only run under an account of the Worker's own authorized set.`,
    );
  }

  const input = googleDocsSmokeInput(target.workId, target.folderId, target.accountIdentifier);
  let outcome: ToolInvocationOutcome | undefined;
  let rewriteOutcome: ToolInvocationOutcome | null = null;
  await runner.runWithWorkPersistence(target.workId, async (state) => {
    if (state.workId !== target.workId) {
      throw new Error(`smoke Work mismatch: the runner presented Work ${state.workId} for smoke ${target.workId} -- refusing to judge the invocation under another Work's Action.`);
    }
    outcome = await invokeTool(
      env,
      { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input },
      workSessionContext(state),
    );
    // The governed rewrite, only over THE Doc this same invocation just
    // created and its own read-back verified: the target id comes out of
    // the verified create outcome, so it cannot point anywhere else. Same
    // Work, same recorded Action, same persistence cycle -- the rewrite is
    // a full Registry invocation with its own durable intent/outcome
    // records, Access judgment, verification, and reconciliation contract.
    const createdDocumentId =
      outcome !== undefined && outcome.state === "succeeded"
        ? outcome.remote_resource?.document_id
        : undefined;
    if (typeof createdDocumentId === "string" && createdDocumentId.length > 0) {
      rewriteOutcome = await invokeTool(
        env,
        {
          tool_id: GOOGLE_DOCS_TOOL_ID,
          operation_id: GOOGLE_DOCS_UPDATE_OPERATION_ID,
          input: googleDocsSmokeRewriteInput(target.workId, createdDocumentId, target.accountIdentifier),
        },
        workSessionContext(state),
      );
    }
    return state;
  });
  if (outcome === undefined) {
    return blocked("the smoke Work never reached the invocation (the runner returned without running it) -- no request was made.");
  }

  // Governed close, only on a clean terminal end for EVERY attempted
  // operation: `succeeded` proved the effect, `denied` proved there was
  // none. A `failed`/`partially_completed`/`unverified` effect from either
  // step keeps the smoke Work OPEN -- its durable operation records stay
  // discoverable for reconciliation, exactly as the recovery contract
  // requires (an uncertain rewrite is never silently discarded by closing
  // the Work around it).
  const cleanly = (o: ToolInvocationOutcome | null): boolean =>
    o === null || o.state === "succeeded" || o.state === "denied";
  let workClosed = false;
  if (cleanly(outcome) && cleanly(rewriteOutcome)) {
    await runner.closeGovernedWork(target.workId);
    workClosed = true;
  }
  return { work_id: target.workId, outcome, rewrite_outcome: rewriteOutcome, work_closed: workClosed };
}
