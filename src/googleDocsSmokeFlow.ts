/**
 * Interactive Google Docs Tool Registry SMOKE flow (LOG-1069 live
 * verification), Telegram side.
 *
 * Martin starts it with `/googledocssmoke`. The flow stages the three
 * explicit decisions he must make -- which authorized Google account, which
 * DISPOSABLE Drive folder, and an explicit confirmation that names both --
 * and only then runs the shared smoke harness invocation
 * (`runGoogleDocsSmokeInvocation` in src/runtime/tools/googleDocsSmoke.ts),
 * i.e. exactly one registered `google_docs.create_and_verify` through the
 * shared Tool Registry. There is no second execution path here: this module
 * stages options and reports outcomes; the Registry, Access, and the smoke
 * harness decide everything else.
 *
 * Discriminators: every staged option carries `smoke: true` and the Work
 * carries `pendingSmokeSelection` (types.ts). The confirmation button uses
 * its own `googlesmokeconfirm:` callback prefix, so the smoke path cannot
 * structurally fall through into the legacy document-creation approval
 * (`googleaction:` -> handleGoogleActionApproval), which reads only
 * `pendingGoogleAction` and never runs on this flow.
 */
import type { Env, WorkState } from "./types";
import { HatMessageTarget, sendWorkspaceHatMessage, sendWorkspaceHatMessageWithOutcome } from "./telegram";
import { logActivity, type LogEntryInput } from "./log";
import { getSessionStub, setActiveWorkId } from "./router";
import { consumeOpaqueOption, listAuthorizedGoogleAccounts, saveOpaqueOption } from "./googleOAuth";
import {
  GOOGLE_DOCS_SMOKE_WORK,
  GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX,
  isGoogleDocsSmokeWorkId,
  runGoogleDocsSmokeInvocation,
  type GoogleDocsSmokeResult,
} from "./runtime/tools/googleDocsSmoke";

/**
 * Injectable seams for `startGoogleDocsSmokeFlow`, mirroring
 * `GoogleDocsSmokeConfirmSeams`: production callers pass nothing and get the
 * real Activity & Decision Log append; tests inject a recorder so the
 * "picker was presented" vs "picker was NOT delivered" record can be
 * asserted directly instead of through a Notion round-trip.
 */
export interface GoogleDocsSmokeInitiationSeams {
  logActivity(input: LogEntryInput): Promise<void>;
}

/**
 * Stages the smoke flow's first step: the authorized-account picker, on a
 * freshly created governed smoke Work (Sales / Sales Executive /
 * proposal_draft, recorded at creation like any other governed Work).
 * Creates no Google document, makes no Drive request, and needs no folder
 * configuration -- the target is chosen interactively, never pre-configured.
 *
 * The initiation record is delivery-aware: "smoke initiated (picker
 * presented)" is written ONLY when Telegram confirmed the picker send (the
 * plain-text retry counting as delivery). A total delivery failure is
 * recorded as a Blocker with the redacted per-attempt diagnostics instead
 * -- the Work stays open but inert (no options staged for selection,
 * nothing created, no invented lifecycle transition), and the failure
 * notice sent in-chat carries no buttons so it cannot itself be rejected
 * for button data.
 */
export async function startGoogleDocsSmokeFlow(
  env: Env,
  chatId: number,
  threadId?: number,
  seams?: GoogleDocsSmokeInitiationSeams,
): Promise<void> {
  const record = seams?.logActivity ?? ((input: LogEntryInput) => logActivity(env, input));
  const target: HatMessageTarget = { chatId, threadId };

  const authorizedAccounts = await listAuthorizedGoogleAccounts(env);
  if (authorizedAccounts.length === 0) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ Cannot start the Tool Registry smoke: no Google account is authorized for this Worker. Authorize one with /oauth/google/start first.",
    );
    return;
  }

  // Bounded 16-hex-char suffix instead of a full UUID: every callback_data
  // this Work can carry embeds this id (`googleaccount:` in the picker below,
  // `googlefolder:` and `googlesmokeconfirm:` in the shared selection stages,
  // and `switch:<id>:` when the open Work shows in /sessions), and Telegram
  // refuses inline-keyboard callback_data longer than 64 UTF-8 bytes with
  // HTTP 400 BUTTON_DATA_INVALID. The full UUID made the account picker's
  // data 76 bytes, so both live picker sends were rejected (2026-10-10).
  // The prefix is unchanged: routing, isGoogleDocsSmokeWorkId, and the admin
  // gate all discriminate on it alone.
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const stub = getSessionStub(env, workId);
  await stub.init(workId, chatId, GOOGLE_DOCS_SMOKE_WORK.unit, GOOGLE_DOCS_SMOKE_WORK.hat, threadId, {
    actionName: GOOGLE_DOCS_SMOKE_WORK.actionName,
  });
  await setActiveWorkId(env, chatId, threadId, workId);

  const buttons: { text: string; callback_data: string }[][] = [];
  try {
    for (const accountIdentifier of authorizedAccounts) {
      const opaqueId = await saveOpaqueOption(env, workId, { kind: "account", smoke: true, accountIdentifier });
      buttons.push([{ text: `👤 ${accountIdentifier}`, callback_data: `googleaccount:${workId}:${opaqueId}` }]);
    }
  } catch (err) {
    console.error("startGoogleDocsSmokeFlow: failed to stage account options", err);
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ Could not persist the smoke account-selection options (the smoke Work is open but no picker was staged). Nothing was created -- retry /googledocssmoke later.",
    );
    return;
  }

  const delivery = await sendWorkspaceHatMessageWithOutcome(
    env,
    { ...target, workId },
    "🧪 *GOVERNED TOOL REGISTRY SMOKE* (LOG-1069)\n\n" +
      "This runs EXACTLY one `google_docs.create_and_verify` through the shared Tool Registry against a *disposable* Drive folder you choose. " +
      "Nothing is created until you explicitly confirm, and the production proposal folder is never touched.\n\n" +
      "Select the authorized Google account to use:",
    buttons,
  );

  if (!delivery.delivered) {
    // Telegram refused the picker (both the Markdown attempt and the
    // plain-text retry). Recording "picker presented" here would be a lie
    // -- exactly the LOG-1071/LOG-1072 defect. Evidence stays redacted and
    // bounded (the attempt errors were bounded at capture time in
    // telegram.ts), so the Blocker is diagnosable without echoing tokens,
    // message content, or identity.
    const evidence =
      delivery.attempts
        .map((a, i) => `attempt ${i + 1} (${a.parseMode}): HTTP ${a.httpStatus ?? "no status"}${a.error ? ` -- ${a.error}` : ""}`)
        .join("; ") || (delivery.unconfiguredStream ? "workspace stream unconfigured -- no attempt was made" : "no attempt recorded");
    console.error(`startGoogleDocsSmokeFlow: smoke picker NOT delivered for work ${workId} -- ${evidence}`);
    // Best-effort, button-less notice: tells Martin in-chat that nothing was
    // staged, and carries no reply_markup so it cannot repeat the picker's
    // rejection. Its own failure is irrelevant (logged by the send path).
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ The smoke picker could NOT be delivered to this chat, so no account selection is possible. " +
        "The smoke Work exists but nothing was staged and nothing was created -- retry /googledocssmoke once delivery is healthy.",
    );
    await record({
      entry: `Google Docs Registry smoke picker NOT delivered [${workId}]`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        `Telegram refused the account-picker send: ${evidence}. The governed smoke Work was created, but NO picker was presented, ` +
        "no options were staged for selection, and nothing was created. The Work stays open but inert and fail-closed -- no lifecycle " +
        "transition was invented for an undelivered picker.",
      outcome: "Blocked",
      workId,
    });
    return;
  }

  await record({
    entry: `Google Docs Registry smoke initiated [${workId}]`,
    type: "Activity",
    activity: "Interactive Registry smoke picker started: authorized-account selection presented for a governed smoke Work (proposal_draft).",
    outcome: "Active",
    workId,
  });
}

/**
 * The Work-side seams `confirmGoogleDocsSmoke` needs, injected by the Durable
 * Object (WorkSession.runGoogleDocsSmokeConfirmation) so the orchestration
 * itself stays free of DO-only imports and testable directly.
 */
export interface GoogleDocsSmokeConfirmSeams {
  /** Runs `fn` as this Work's governed execute cycle (persists state, installs durable operation persistence). */
  runExclusive(workId: string, fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState>;
  /** Terminal close for a clean end: marks the confirmed smoke Work complete and clears the pending selection. */
  markComplete(workId: string): Promise<void>;
}

/** Why a Work may not run the smoke confirmation, or null when it may. */
function smokeWorkDefect(state: WorkState): string | null {
  if (!isGoogleDocsSmokeWorkId(state.workId)) {
    return `Work ${state.workId} is not a Registry smoke Work -- this confirmation belongs to no smoke flow and was refused.`;
  }
  if (
    state.unit !== GOOGLE_DOCS_SMOKE_WORK.unit ||
    state.hat !== GOOGLE_DOCS_SMOKE_WORK.hat ||
    state.actionName !== GOOGLE_DOCS_SMOKE_WORK.actionName
  ) {
    return (
      `Work ${state.workId} does not record the governed smoke Action ` +
      `(${GOOGLE_DOCS_SMOKE_WORK.unit} / ${GOOGLE_DOCS_SMOKE_WORK.hat} / ${GOOGLE_DOCS_SMOKE_WORK.actionName}) ` +
      "-- refusing to invoke the Registry under this Work."
    );
  }
  return null;
}

function smokeOutcomeMessage(result: GoogleDocsSmokeResult): string {
  if (result.blocked_reason) {
    return `⚠️ *Registry smoke blocked* -- ${result.blocked_reason}\n\nNothing was created.`;
  }
  const outcome = result.outcome;
  if (!outcome) {
    return "⚠️ *Registry smoke returned no outcome* -- nothing can be asserted about the remote state. No retry was attempted.";
  }
  switch (outcome.state) {
    case "succeeded": {
      const url = outcome.remote_resource?.url ? `\nDoc: ${outcome.remote_resource.url}` : "";
      return (
        "✅ *Registry smoke SUCCEEDED* -- `google_docs.create_and_verify` created the disposable document " +
        `and the read-back verification passed.${url}\n` +
        `Operation evidence is kept on smoke Work \`${result.work_id}\`.`
      );
    }
    case "denied":
      return (
        `🛑 *Registry smoke DENIED by the governance boundary* -- ${outcome.reason ?? "no detail reported"}\n\n` +
        "No Google request was made."
      );
    case "failed":
      return (
        `⚠️ *Registry smoke FAILED* -- ${outcome.reason ?? "no detail reported"}\n\n` +
        "The smoke Work stays open with its durable operation record for inspection; nothing will be retried automatically."
      );
    case "partially_completed":
      return (
        `⚠️ *Registry smoke PARTIALLY COMPLETED* -- ${outcome.reason ?? "no detail reported"}\n\n` +
        "The smoke Work stays open with its durable operation record; the document that may now exist must be " +
        "reconciled before anything else is created (never blindly re-created)."
      );
    case "unverified":
      return (
        `⚠️ *Registry smoke outcome UNVERIFIED* -- ${outcome.reason ?? "no detail reported"}\n\n` +
        "The remote state could not be confirmed. The smoke Work stays open with its durable operation record " +
        "for reconciliation; no automatic retry was attempted."
      );
    default:
      return `⚠️ *Registry smoke ended with unexpected state '${(outcome as { state: string }).state}'* -- no assumption was made; inspect smoke Work \`${result.work_id}\`.`;
  }
}

/**
 * The confirmation step: validates the pending smoke Work and the staged
 * target (they must still match), then runs the shared invocation core once.
 *
 * `value` is either `cancel` (terminal: clears the selection, completes the
 * Work, creates nothing) or the opaque id of a staged `smoke_confirm`
 * option. Every refusal path sends an explicit message and returns the Work
 * state unchanged, with zero Google requests.
 */
export async function confirmGoogleDocsSmoke(
  env: Env,
  state: WorkState,
  value: string,
  seams: GoogleDocsSmokeConfirmSeams,
): Promise<WorkState> {
  const target: HatMessageTarget = {
    chatId: state.chatId,
    threadId: state.threadId,
    hat: state.hat,
    workId: state.workId,
  };

  if (value === "cancel") {
    return seams.runExclusive(state.workId, async (s) => {
      s.pendingSmokeSelection = undefined;
      s.stage = "complete";
      await sendWorkspaceHatMessage(env, target, "🧪 Registry smoke cancelled -- nothing was created.");
      return s;
    });
  }

  const defect = smokeWorkDefect(state);
  if (defect) {
    await sendWorkspaceHatMessage(env, target, `⚠️ ${defect}`);
    return state;
  }

  const pending = state.pendingSmokeSelection;
  if (!pending) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ This smoke Work has no pending selection to confirm (the confirmation may already have been used, or the flow was cancelled). Nothing was run -- start a fresh /googledocssmoke if you still need the smoke.",
    );
    return state;
  }

  const option = await consumeOpaqueOption(env, state.workId, value);
  if (
    !option ||
    option.kind !== "smoke_confirm" ||
    option.smoke !== true ||
    typeof option.accountIdentifier !== "string" ||
    typeof option.folderId !== "string"
  ) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ That smoke confirmation option is invalid or expired. Nothing was run -- start a fresh /googledocssmoke flow.",
    );
    return state;
  }

  if (option.accountIdentifier !== pending.accountIdentifier || option.folderId !== pending.folderId) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ That smoke confirmation does not match this Work's pending selection. Nothing was run.",
    );
    return state;
  }

  const result = await runGoogleDocsSmokeInvocation(
    env,
    { workId: state.workId, accountIdentifier: pending.accountIdentifier, folderId: pending.folderId },
    {
      runWithWorkPersistence: seams.runExclusive,
      closeGovernedWork: async () => seams.markComplete(state.workId),
    },
  );

  return seams.runExclusive(state.workId, async (s) => {
    // The confirmation is consumed either way: a closed Work already had its
    // selection cleared by markComplete; an uncertain outcome keeps the Work
    // open for reconciliation but must never leave a re-confirmable button
    // behind (re-invoking the same create is exactly the blind retry the
    // harness forbids).
    if (!result.work_closed) {
      s.pendingSmokeSelection = undefined;
    }
    await sendWorkspaceHatMessage(env, target, smokeOutcomeMessage(result));
    return s;
  });
}
