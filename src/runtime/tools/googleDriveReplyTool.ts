/**
 * Registered Google Drive comment-reply operation --
 * `google_drive.reply_to_comment`, version 1.0, effect `external_mutation`:
 * post exactly ONE reply to exactly ONE comment on a Doc or Sheet this
 * Worker itself created and watches, and claim success only after the
 * created reply is read back.
 *
 * This is the governed form of the automated comment replies the Doc/Sheet
 * comment pollers used to issue as direct Drive `comments.replies.create`
 * calls. It is the operation Martin's Access-context decision (2026-10-15)
 * authorized: a cron-driven Google reply is permitted ONLY through the
 * external-mutation gate, judged by the comment's Work's own resolved Action
 * (see docs/enig-operating-model.md, "Governance, reserved flows around the
 * Tool Registry"). Everything else is the shared invocation boundary
 * (src/runtime/toolRegistry.ts): exact operation, strict input contract,
 * trusted target (a watched file this Worker created, under that file's own
 * authorized account), Access on the Work's own Action -- including a bound
 * ApprovalProof when that Action is approval-gated -- durable intent/outcome
 * records, and the canonical five outcomes. A caller outside a Work, or an
 * Action that does not declare this operation, is denied before any request.
 *
 * The input is pure business data: which file, which comment, the exact
 * reply text, and the account the file is watched under. No provider request
 * structure enters the contract.
 *
 * RECONCILIATION IS DELIBERATELY ABSENT. A comment reply is an append-only
 * communication whose uncertain outcome must never be repeated -- a lost
 * response may hide a delivered reply, and a duplicate reply to a human is
 * worse than a missing one (the exact no-retry contract the comment flows
 * already keep: marker first, reply best-effort, never retried). Because this
 * operation declares no `reconcile` step, the invocation boundary itself
 * refuses to repeat an uncertain effect: a prior `partially_completed` or
 * `unverified` outcome for the same identity keeps failing closed instead of
 * re-sending. A definite rejection (`failed`) and a denial made no reply, so
 * a later distinct attempt may legitimately proceed.
 */
import type { Env } from "../../types";
import type { ResolvedToolTarget, ToolInvocationOutcome, ToolOperationDefinition } from "../toolRegistry";
import { getValidGoogleAccessToken, getWatchedGoogleDoc, getWatchedGoogleSheet, listAuthorizedGoogleAccounts } from "../../googleOAuth";
import { GOOGLE_DRIVE_TOOL_ID } from "./googleDriveFolderTool";

export const GOOGLE_DRIVE_REPLY_OPERATION_ID = "google_drive.reply_to_comment";

/** Exactly the declared input contract: which file, which comment, the reply text, and the file's own authorized account. */
const ALLOWED_INPUT_KEYS: readonly string[] = ["file_id", "comment_id", "content", "account_identifier"];

/** An opaque url-safe Google file (Doc or Sheet) id -- never a path, URL or blank. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** An opaque url-safe Drive comment id -- never a path, URL or blank. */
const COMMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Reply text is short operational communication: non-empty, bounded, and
 * free of control characters other than newline, carriage return and tab
 * (every reply this Runtime composes is well inside these bounds). The
 * control-character check is a char-code loop rather than a regex so no
 * literal control byte ever appears in this source file.
 */
const MAX_REPLY_CONTENT_CHARS = 2000;

export const GOOGLE_DRIVE_REPLY_MAX_CONTENT_CHARS = MAX_REPLY_CONTENT_CHARS;

function hasUnexpectedControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

interface ReplyToCommentInput {
  file_id: string;
  comment_id: string;
  content: string;
  account_identifier: string;
}

const BASE = { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_REPLY_OPERATION_ID };

/**
 * Validates the input contract exactly: an object with precisely the four
 * declared fields; opaque file and comment ids; non-empty bounded reply text
 * with no unexpected control characters; a non-empty account. Returns the
 * typed input or the defect that made it invalid.
 */
function parseInput(input: unknown): ReplyToCommentInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED_INPUT_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `unknown input field "${unknownKey}" -- the comment reply input contract is exactly ${ALLOWED_INPUT_KEYS.join(", ")}`;
  }
  const missing = ALLOWED_INPUT_KEYS.find((key) => record[key] === undefined || record[key] === null);
  if (missing !== undefined) return `input field "${missing}" is required`;
  if (typeof record.file_id !== "string" || !FILE_ID_PATTERN.test(record.file_id.trim())) {
    return "file_id must be an opaque url-safe Google file id";
  }
  if (typeof record.comment_id !== "string" || !COMMENT_ID_PATTERN.test(record.comment_id.trim())) {
    return "comment_id must be an opaque url-safe Drive comment id";
  }
  if (typeof record.content !== "string") return "content must be a string";
  const content = record.content.trim();
  if (content.length === 0) return "content must be non-empty reply text";
  if (content.length > MAX_REPLY_CONTENT_CHARS) {
    return `content exceeds the ${MAX_REPLY_CONTENT_CHARS}-character reply bound -- a longer text is not a comment reply`;
  }
  if (hasUnexpectedControlCharacters(content)) {
    return "content carries control characters -- reply text is plain human text";
  }
  if (typeof record.account_identifier !== "string" || record.account_identifier.trim().length === 0) {
    return "account_identifier must be a non-empty string";
  }
  return {
    file_id: record.file_id.trim(),
    comment_id: record.comment_id.trim(),
    content,
    account_identifier: record.account_identifier.trim(),
  };
}

/** The exact Drive comments endpoints this operation speaks: create one reply, read the comment's replies back. */
function repliesUrl(fileId: string, commentId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}/comments/${commentId}/replies`;
}

function commentUrl(fileId: string, commentId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}/comments/${commentId}`;
}

/**
 * Trusted-target resolution: the file must be a Doc or Sheet this Worker
 * itself created and watches (the same opt-in-by-creation registry the
 * comment pollers trust), and the invocation's account must be the exact
 * account that file is registered under -- plus membership in the accounts
 * this Worker is actually authorized for. A reply may therefore never target
 * an arbitrary Drive file or an account chosen at call time.
 */
async function resolveTarget(env: Env, input: unknown): Promise<{ ok: true; target: ResolvedToolTarget } | { ok: false; reason: string }> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") return { ok: false, reason: `the comment reply target input is invalid: ${parsed}` };
  const accounts = await listAuthorizedGoogleAccounts(env);
  if (accounts.length === 0) {
    return { ok: false, reason: "no Google account is authorized for this Worker, so the reply's account cannot be resolved from trusted runtime state -- no external mutation may proceed" };
  }
  if (!accounts.includes(parsed.account_identifier)) {
    return {
      ok: false,
      reason: `account "${parsed.account_identifier}" is not one of the ${accounts.length} account(s) this Worker is authorized for -- a Tool invocation may not select an arbitrary account`,
    };
  }
  const watchedDoc = await getWatchedGoogleDoc(env, parsed.file_id);
  const watchedFile = watchedDoc ?? (await getWatchedGoogleSheet(env, parsed.file_id));
  if (!watchedFile) {
    return {
      ok: false,
      reason: `file ${parsed.file_id} is not a Doc or Sheet this Worker created and watches -- a comment reply may only target a watched file resolved from trusted runtime state`,
    };
  }
  if (watchedFile.accountIdentifier !== parsed.account_identifier) {
    return {
      ok: false,
      reason: `file ${parsed.file_id} is watched under a different account than the invocation supplied -- the reply must go out under the file's own authorized account`,
    };
  }
  return { ok: true, target: { resourceId: `gdrive:comment:${parsed.file_id}:${parsed.comment_id}` } };
}

/**
 * Posts the reply and maps the attempt onto the five canonical outcome
 * states -- honestly: a POST the provider accepted AND whose created reply
 * is confirmed by an actual read-back is the one verified success; an
 * explicit rejection is a definite failure (no reply exists); every
 * uncertainty -- a lost response, an accepted POST with no usable id, an
 * unconfirmable read-back -- is an uncertain remote effect that must be
 * reconciled before any retry, which this operation deliberately cannot do
 * (see the header), so the boundary refuses to repeat it.
 */
async function postReply(env: Env, parsed: ReplyToCommentInput): Promise<ToolInvocationOutcome> {
  let token: string | null;
  try {
    token = await getValidGoogleAccessToken(env, parsed.account_identifier);
  } catch (error) {
    return { ...BASE, state: "failed", stage: "auth", reason: `the authorized account's token could not be read (${error instanceof Error ? error.message : "unknown error"}) -- no reply was sent` };
  }
  if (!token) {
    return { ...BASE, state: "failed", stage: "auth", reason: "Google Workspace authorization missing or invalid" };
  }
  const remote = { document_id: parsed.file_id };
  let res: Response;
  try {
    res = await fetch(repliesUrl(parsed.file_id, parsed.comment_id), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: parsed.content }),
    });
  } catch (error) {
    // The request may have reached Google with the response lost: the reply
    // may exist, so the outcome is uncertain and must never be repeated.
    return {
      ...BASE,
      state: "unverified",
      stage: "reply",
      reason: `the reply request failed before a response arrived (${error instanceof Error ? error.message : "unknown error"}) -- the reply may have been posted and must not be repeated`,
      remote_resource: remote,
      reconciliation_required: true,
    };
  }
  if (!res.ok) {
    // Google answered with a rejection: a definite failure of this attempt;
    // no reply was created.
    return { ...BASE, state: "failed", stage: "reply", reason: `Google rejected the reply (HTTP ${res.status})` };
  }
  let created: { id?: unknown } | null = null;
  try {
    created = (await res.json()) as { id?: unknown };
  } catch {
    created = null;
  }
  const replyId = typeof created?.id === "string" && created.id.length > 0 ? created.id : null;
  if (!replyId) {
    // The POST was accepted but returned no reply id: a reply may exist with
    // nothing to confirm it by.
    return {
      ...BASE,
      state: "partially_completed",
      stage: "creation",
      reason: "the reply POST was accepted but returned no reply id, so its existence cannot be confirmed -- it must not be repeated",
      remote_resource: remote,
      reconciliation_required: true,
    };
  }
  // Read-back verification: the created reply must appear on the comment
  // itself before success is claimed (the same discipline every registered
  // Google operation keeps).
  try {
    const read = await fetch(`${commentUrl(parsed.file_id, parsed.comment_id)}?fields=replies(id)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (read.ok) {
      const body = (await read.json().catch(() => ({}))) as { replies?: { id?: unknown }[] };
      const confirmed = (body.replies ?? []).some((reply) => reply.id === replyId);
      if (confirmed) {
        return { ...BASE, state: "succeeded", verified: true, remote_resource: remote };
      }
    }
  } catch {
    // fall through to the uncertain outcome below
  }
  return {
    ...BASE,
    state: "partially_completed",
    stage: "verification",
    reason: "the reply was accepted but could not be confirmed by read-back, so its remote state is uncertain -- it must not be repeated",
    remote_resource: remote,
    reconciliation_required: true,
  };
}

/** `google_drive.reply_to_comment`: post ONE reply to ONE watched file's comment, verified by read-back. No `reconcile` -- see the header. */
export const googleDriveReplyToolOperation: ToolOperationDefinition = {
  toolId: GOOGLE_DRIVE_TOOL_ID,
  operationId: GOOGLE_DRIVE_REPLY_OPERATION_ID,
  version: "1.0",
  effect: "external_mutation",

  validateInput(input: unknown): string | null {
    const parsed = parseInput(input);
    return typeof parsed === "string" ? parsed : null;
  },

  resolveTarget,

  async run(env: Env, input: unknown): Promise<ToolInvocationOutcome> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") {
      // Defensive: validateInput already ran. A failure here makes no request.
      return { ...BASE, state: "failed", stage: "validation", reason: `validation: ${parsed}` };
    }
    return postReply(env, parsed);
  },

  // Deliberately no `reconcile`: an uncertain comment reply is never
  // repeated (see the header). The invocation boundary refuses to re-send it.
};
