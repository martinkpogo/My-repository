/**
 * The shared output-delivery feature (Martin's decision, 2026-11-17):
 * once ANY Hat's output is approved, the user may file that exact output
 * into Google Drive as a Doc -- the same way the Research Runtime is a
 * single shared capability rather than a per-Hat one.
 *
 * DESIGN (one shared install point, one Access rule):
 *  - A Hat's own approval-success point calls `captureApprovedOutput` with
 *    the exact approved output text. That is the ONLY producer; nothing here
 *    parses text or trusts AI output. The text is token-checked (the same
 *    identity check the Sales Doc path uses) before it is stored.
 *  - The user is offered one quiet choice below the approval: "Save as Doc"
 *    or "Keep in chat". Doing nothing keeps the text -- the default.
 *  - "Save as Doc" runs the SAME governed picker as the interactive Doc
 *    creation (account -> folder), then a final explicit confirmation. That
 *    final tap mints the ApprovalProof (bound to the exact picked folder as
 *    the external target) and runs `google_docs.create_and_verify` through
 *    the shared Tool Registry invocation boundary in one step. See
 *    `confirmOutputDelivery`.
 *  - The Access rule is the single shared exemption in
 *    `evaluateExternalMutationAccess` (SHARED_OUTPUT_DELIVERY_OPERATION_ID):
 *    any Work may save its own approved output with that one operation,
 *    without a per-Action declaration, and only with a bound proof. See
 *    src/access.ts.
 *
 * Docs only for now: Sheets are offered only once a registered Sheets-create
 * operation exists in the Google tool (none does today). Sales proposals move
 * onto this same shared feature in a later PR with no behaviour change.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Env, WorkState } from "./types";
import type { InlineButton } from "./telegram";
import { HatMessageTarget, sendWorkspaceHatMessage } from "./telegram";
import { logActivity } from "./log";
import { invokeTool } from "./runtime/toolRegistry";
import { mintExternalToolApprovalProof, workSessionContext } from "./access";
import { findIdentityViolation, type HandoffIdentity } from "./handoffWriter";
import { listAuthorizedGoogleAccounts, saveOpaqueOption } from "./googleOAuth";

/** The callback prefix for the shared output-delivery buttons (index.ts splits `action:workId:value`). */
export const OUTPUT_DELIVERY_CALLBACK = "outputdelivery";

/** The one artifact kind offered today. "sheet" is reserved for a future registered Sheets-create operation. */
export type OutputDeliveryFormat = "doc" | "sheet";

/**
 * The identity fields the token-safety check compares against -- the same
 * deny-list discipline as the Sales Doc path (`knownIdentity` in
 * tokenSafeProposal.ts): only ever used to detect a leak, never to resolve
 * anything. entityName/matterName are deliberately excluded for Units that
 * only ever hold tokens (their entityName is a token, not a real name).
 */
function deliveryIdentity(state: WorkState): HandoffIdentity {
  return {
    entityToken: state.entityToken,
    matterToken: state.matterToken,
    entityName: state.entityName,
    matterName: state.matterName,
    contactName: state.entityDraft?.name,
    email: state.entityDraft?.email,
    phone: state.entityDraft?.phone,
  };
}

/**
 * True when the text carries no identity-bearing value this runtime can
 * detect -- the SAME check as the Sales Doc path (`isTokenSafe`). The
 * violation detail is never echoed (it may contain the identity itself).
 */
export function isDeliveryTokenSafe(state: WorkState, text: string): boolean {
  return findIdentityViolation("Approved Output", text, deliveryIdentity(state)) === null;
}

/**
 * Captures a Hat's approved output so the shared save feature can offer to
 * file it. Called ONLY from a Hat's own approval-success point, with the
 * exact approved text. Fails closed: an empty output, or one that fails the
 * token-safety check, is NOT stored and the user is told plainly -- nothing
 * is offered that could leak identity into a Doc.
 *
 * Returns the updated state (use it as the handler's return value). Storage
 * is in-memory on the Work's own persisted state; no Drive request is made.
 */
export async function captureApprovedOutput(
  env: Env,
  state: WorkState,
  approvedOutput: { text: string; title: string },
  seams?: { send?: typeof sendWorkspaceHatMessage },
): Promise<WorkState> {
  const send = seams?.send ?? sendWorkspaceHatMessage;
  const target: HatMessageTarget = { chatId: state.chatId, threadId: state.threadId, hat: state.hat, workId: state.workId };
  const text = approvedOutput.text?.trim() ?? "";
  if (!text) {
    await send(env, target, "⚠️ This output was approved but is empty, so there is nothing to save. It was not offered for delivery.");
    return state;
  }
  if (!isDeliveryTokenSafe(state, text)) {
    // The violation detail is never echoed -- it may contain the identity.
    await send(
      env,
      target,
      "⚠️ This approved output could not be checked clean of identity-bearing detail, so it was NOT offered for Google Drive. Nothing was saved.",
    );
    await logActivity(env, {
      entry: "Output delivery refused (identity check)",
      type: "Blocker",
      area: state.unit ?? "Operations",
      activity: `Approved output for work ${state.workId} failed the token-safety check and was not offered for delivery.`,
      outcome: "Blocked",
      workId: state.workId,
    });
    return state;
  }
  state.outputDelivery = {
    text,
    title: approvedOutput.title?.trim() || "Untitled",
    capturedAt: new Date().toISOString(),
  };
  // "Approve and save to Google Drive": the session opens the picker right
  // after this approval, so no separate offer is shown.
  if (SAVE_ON_APPROVAL.getStore() === true) {
    state.outputDelivery.saveRequested = true;
    return state;
  }
  // Show the offer. (Until 2026-11-18 the output was captured but the offer
  // was never sent, so Martin approved a draft and saw no save button.) The
  // offer is advisory: a failed send never undoes or blocks the approval.
  await send(env, target, OUTPUT_DELIVERY_OFFER_TEXT, outputDeliveryOfferButtons(state.workId)).catch((err) =>
    console.error(`Output delivery: the save offer could not be sent for work ${state.workId}`, err),
  );
  return state;
}

/**
 * The quiet offer shown right after a Hat's approval succeeds. One tap on
 * "Save as Doc" opens the governed picker; "Keep in chat" (or doing nothing)
 * keeps the text as-is. This message is advisory: it never blocks, delays or
 * invalidates the approval that already happened.
 */
/**
 * "✅ Approve and save to Google Drive" (Martin, 2026-11-18): one shared
 * button a Hat adds to its own approval card beside its Approve. Its callback
 * is that Hat's own approve callback plus SAVE_ON_APPROVAL_SUFFIX: the session
 * strips the suffix, runs the Hat's normal approval unchanged, and -- only if
 * that approval captured an output -- opens the same account/folder picker.
 * Nothing is saved before the approval, and the picker's final tap still
 * decides the Doc.
 */
export const SAVE_ON_APPROVAL_SUFFIX = "~save";

export function approveAndSaveRow(approveCallbackData: string): InlineButton[] {
  return [{ text: "✅ Approve and save to Google Drive", callback_data: `${approveCallbackData}${SAVE_ON_APPROVAL_SUFFIX}` }];
}

const SAVE_ON_APPROVAL = new AsyncLocalStorage<boolean>();

/** Runs a Hat's approval with "save to Google Drive" requested (see approveAndSaveRow). */
export function runWithSaveOnApproval<T>(fn: () => Promise<T>): Promise<T> {
  return SAVE_ON_APPROVAL.run(true, fn);
}

export function outputDeliveryOfferButtons(workId: string): InlineButton[][] {
  // "doc" is the only offered format today; "sheet" is added here only once a
  // registered Sheets-create operation exists.
  return [
    [
      { text: "📄 Save as Doc", callback_data: `${OUTPUT_DELIVERY_CALLBACK}:${workId}:start` },
      { text: "💬 Keep in chat", callback_data: `${OUTPUT_DELIVERY_CALLBACK}:${workId}:dismiss` },
    ],
  ];
}

export const OUTPUT_DELIVERY_OFFER_TEXT =
  "Your output is approved. Want a copy in Google Drive?\n\n📄 Save as Doc files it into a Drive folder you pick. 💬 Keep in chat leaves it here -- nothing is created.";

/**
 * Handles every `outputdelivery:` callback. `value` is one of:
 *  - `dismiss` -- keep in chat: clear the captured output, create nothing;
 *  - `start`   -- stage the account picker for the governed account->folder flow;
 *  - an opaque option id from the account picker (handled in googleOAuth,
 *    which reuses the same account/folder staging with a `delivery` flag).
 *
 * The actual Drive creation happens only in `confirmOutputDelivery` below,
 * from the final explicit confirmation tap.
 */
export async function handleOutputDeliveryCallback(
  env: Env,
  state: WorkState,
  value: string,
): Promise<WorkState> {
  const target: HatMessageTarget = { chatId: state.chatId, threadId: state.threadId, hat: state.hat, workId: state.workId };
  const captured = state.outputDelivery;

  if (value === "dismiss") {
    state.outputDelivery = undefined;
    await sendWorkspaceHatMessage(env, target, "Kept in chat -- nothing was created in Google Drive.");
    return state;
  }

  if (!captured) {
    await sendWorkspaceHatMessage(env, target, "There is no approved output waiting to be saved for this work item.");
    return state;
  }

  // `start`: stage the account picker. The account option carries the
  // captured output so the folder stage and the final confirmation can build
  // the exact create input; the `delivery` flag keeps this flow
  // structurally separate from the legacy creation-approval path.
  const authorizedAccounts = await listAuthorizedGoogleAccounts(env);
  if (authorizedAccounts.length === 0) {
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ Cannot save to Google Drive: no authorized Google Workspace account. Authorize one with /oauth/google/start first.",
    );
    return state;
  }

  const buttons: InlineButton[][] = [];
  for (const accountIdentifier of authorizedAccounts) {
    const opaqueId = await saveOpaqueOption(env, state.workId, {
      kind: "account",
      delivery: true,
      accountIdentifier,
      title: captured.title,
      content: captured.text,
    });
    buttons.push([{ text: `👤 ${accountIdentifier}`, callback_data: `googleaccount:${state.workId}:${opaqueId}` }]);
  }

  await sendWorkspaceHatMessage(
    env,
    target,
    `*Save output to Google Drive*\n\n*Title*: ${captured.title}\n\nSelect the authorized Google account to use:`,
    buttons,
  );
  await logActivity(env, {
    entry: "Output delivery initiated",
    type: "Activity",
    area: state.unit ?? "Operations",
    activity: `Output delivery account picker presented for work ${state.workId}.`,
    outcome: "Active",
    workId: state.workId,
  });
  return state;
}

/**
 * The final explicit confirmation tap: mints the ApprovalProof bound to the
 * exact picked folder, then runs `google_docs.create_and_verify` through the
 * shared Tool Registry invocation boundary. This is the "final approve tap in
 * the picker" -- the proof is minted from it and bound to the folder the user
 * picked, so a proof can never authorize a different folder.
 *
 * Every non-success is reported honestly (denied/failed/partial/unverified)
 * and never retried automatically; an uncertain effect keeps its durable
 * operation record for reconciliation.
 */
export async function confirmOutputDelivery(
  env: Env,
  state: WorkState,
  accountIdentifier: string,
  folderId: string,
  folderName: string,
): Promise<WorkState> {
  const target: HatMessageTarget = { chatId: state.chatId, threadId: state.threadId, hat: state.hat, workId: state.workId };
  const captured = state.outputDelivery;
  if (!captured) {
    await sendWorkspaceHatMessage(env, target, "There is no approved output waiting to be saved for this work item.");
    return state;
  }

  // Re-check token-safety at creation time: state may have changed identity
  // fields between capture and confirmation, and nothing identity-bearing
  // may reach Google even then.
  if (!isDeliveryTokenSafe(state, captured.text)) {
    state.outputDelivery = undefined;
    await sendWorkspaceHatMessage(
      env,
      target,
      "⚠️ This output no longer passes the identity check, so nothing was created in Google Drive.",
    );
    return state;
  }

  // The one shared Access rule (src/access.ts): the proof is minted from this
  // final tap and bound to the exact picked folder as the external target.
  const target_resource_id = `gdrive:folder:${folderId}`;
  const proof = mintExternalToolApprovalProof(state, {
    toolId: "google_docs",
    operationId: "google_docs.create_and_verify",
    targetResourceId: target_resource_id,
  });

  const outcome = await invokeTool(
    env,
    {
      tool_id: "google_docs",
      operation_id: "google_docs.create_and_verify",
      input: { title: captured.title, content: captured.text, folder_id: folderId, account_identifier: accountIdentifier },
    },
    workSessionContext(state, proof),
  );

  // The captured output is consumed either way: a re-tap must never re-create
  // the same Doc blindly (that is the reconciliation rule the Registry keeps).
  state.outputDelivery = undefined;

  const url = outcome.remote_resource?.url;
  switch (outcome.state) {
    case "succeeded":
      await sendWorkspaceHatMessage(
        env,
        target,
        `✅ Saved to Google Drive in *${folderName}*${url ? `\n${url}` : ""}`,
      );
      break;
    case "denied":
      await sendWorkspaceHatMessage(env, target, `🛑 Not saved -- the governance boundary refused it: ${outcome.reason ?? "no detail"}`);
      break;
    case "failed":
      await sendWorkspaceHatMessage(env, target, `⚠️ Not saved -- ${outcome.reason ?? "it failed"}. Nothing will be retried automatically.`);
      break;
    default:
      await sendWorkspaceHatMessage(
        env,
        target,
        `⚠️ Save ended ${outcome.state} -- ${outcome.reason ?? "the remote state could not be confirmed"}. The document may exist; it must be reconciled before anything else is created.`,
      );
  }

  await logActivity(env, {
    entry: `Output delivery ${outcome.state}`,
    type: "Activity",
    area: state.unit ?? "Operations",
    activity: `Output delivery for work ${state.workId} into '${folderName}' (${folderId}) ended ${outcome.state}${url ? ` -- ${url}` : ""}.`,
    outcome: outcome.state === "succeeded" ? "Complete" : "Active",
    workId: state.workId,
  });
  return state;
}