import type { Env } from "./types";
import {
  columnLetter,
  getValidGoogleAccessToken,
  listWatchedGoogleSheets,
  type WatchedGoogleSheet,
} from "./googleOAuth";
import { generate } from "./ai";
import { logActivity } from "./log";
import { sendOperationsMessage } from "./telegram";
import { CommentMarkerPersistenceError } from "./googleDocComments";
import { kvGet, kvPut, kvPutHeartbeat, POLL_HEARTBEAT_MIN_INTERVAL_MS } from "./kvStore";

const COMMENT_PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const VALUES_RANGE = "A1:ZZ10000";

interface DriveCommentAuthor {
  displayName?: string;
  // Same rationale as googleDocComments.ts: Drive's Comments API frequently
  // omits emailAddress for privacy, even for the requesting account's own
  // comments -- "me" (true iff this comment was authored by the same
  // identity as whoever's access token fetched it) is the reliable signal.
  me?: boolean;
}

interface DriveComment {
  id: string;
  content: string;
  resolved?: boolean;
  author?: DriveCommentAuthor;
  quotedFileContent?: { value?: string };
}

/**
 * The maximum number of comment pages fetched for one spreadsheet. A page
 * holds up to `pageSize=100` comments, so this caps a single fetch at 10,000
 * comments and exists only so an API that kept minting fresh tokens could
 * never make this loop forever. Reaching it throws, so the fetch fails
 * closed rather than returning a list that may be incomplete.
 */
const MAX_COMMENT_PAGES = 100;

/**
 * Lists EVERY comment on a watched spreadsheet. `comments.list` is paginated
 * at `pageSize=100`, so a single request silently drops every comment after
 * the first 100. Each response's `nextPageToken` is therefore followed as the
 * next request's `pageToken`, and the comments are accumulated across pages.
 *
 * Every request keeps the same required parameters -- the same `fields`
 * projection, `pageSize=100` and `includeDeleted=false` -- plus the bearer
 * token header; only `pageToken` is added, and only when the API supplied one.
 *
 * Failure semantics are unchanged and deliberately WHOLE-FETCH: if any page
 * request fails, this throws rather than returning the pages collected so
 * far, because a partial list must never be processed as though it were
 * complete. The poller already catches that throw, records
 * `comments_list_failed` for the spreadsheet and moves to the next one, so
 * nothing is half-processed and a later poll retries it from its first page.
 * An absent or empty `nextPageToken` is normal completion, and a token the
 * API has already handed back is refused rather than looped on.
 */
async function fetchComments(token: string, spreadsheetId: string): Promise<DriveComment[]> {
  const base =
    `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/comments` +
    `?fields=comments(id,content,resolved,author(displayName,me),quotedFileContent(value))` +
    `&pageSize=100&includeDeleted=false`;

  const all: DriveComment[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; ; page++) {
    if (page >= MAX_COMMENT_PAGES) {
      throw new Error(
        `Drive comments.list exceeded ${MAX_COMMENT_PAGES} pages for ${spreadsheetId}; refusing to keep paginating or to return a possibly-incomplete list.`,
      );
    }
    const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Drive comments.list failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as { comments?: DriveComment[]; nextPageToken?: string };
    all.push(...(data.comments ?? []));

    const next = data.nextPageToken;
    if (!next) return all; // absent or empty == normal completion
    if (seenTokens.has(next)) {
      throw new Error(
        `Drive comments.list returned a repeated page token for ${spreadsheetId}; refusing to loop or to return a possibly-incomplete list.`,
      );
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

async function fetchSheetValues(token: string, spreadsheetId: string): Promise<string[][] | null> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${VALUES_RANGE}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as { values?: string[][] };
    return data.values ?? [];
  } catch {
    return null;
  }
}

/**
 * Writes the sheet comment's dedup marker, typed on failure exactly as
 * googleDocComments.ts's does: because the marker is written BEFORE the reply
 * it guards, a typed failure here means the reply never ran, the comment
 * stays unprocessed, and a later poll may retry it. The error class itself is
 * imported from googleDocComments.ts rather than redefined, so the two
 * pollers' `instanceof` checks agree on one type.
 */
async function markProcessed(env: Env, commentId: string): Promise<void> {
  try {
    await kvPut(env, `google_comment_processed:${commentId}`, "1", {
      expirationTtl: COMMENT_PROCESSED_TTL_SECONDS,
    });
  } catch (err) {
    throw new CommentMarkerPersistenceError(commentId, err);
  }
}

/**
 * The one place a failed sheet-comment reply is made operationally visible.
 * Deliberately carries ONLY identifiers and the failure category -- never the
 * comment's text, never the reply text, never the anchored cell content.
 * Best-effort and never thrown: a failure to REPORT must not itself fail a
 * comment that is already durably marked.
 */
async function reportReplyFailure(
  env: Env,
  operation: string,
  spreadsheetId: string,
  commentId: string,
  reason: string,
): Promise<void> {
  await sendOperationsMessage(
    env,
    `⚠️ Google Sheet comment reply not delivered\nOperation: ${operation}\nSpreadsheet: ${spreadsheetId}\nComment: ${commentId}\nReason: ${reason}\n\nThis reply is not retried automatically (a duplicate could reach the commenter after an uncertain outcome or a refusal), and the comment's own processing state is unchanged. No comment content is included in this message.`,
  ).catch((err) => console.error("reportReplyFailure: could not send the Operations alert", err));
}

/**
 * Delivers (or refuses) ONE automated reply to a Sheet comment. Martin's
 * Access-context decision (2026-10-15) authorized automated Docs/Sheets
 * replies ONLY through the registered external-mutation gate under the
 * comment's Work Action -- there is no direct Drive reply any more. A
 * watched Spreadsheet carries NO Work binding (see WatchedGoogleSheet), so
 * no Work Action could ever authorize a reply on it: every automated Sheet
 * reply is therefore refused FAIL-CLOSED here -- never posted around the
 * gate -- and reported to Operations with identifiers only. The comment's
 * own marker-before-reply, dedup and no-retry contracts are unchanged: the
 * marker runs first, and a refused reply is never retried.
 */
async function refuseReplyWithoutWorkAction(env: Env, sheet: WatchedGoogleSheet, commentId: string, operation: string): Promise<void> {
  await reportReplyFailure(
    env,
    operation,
    sheet.spreadsheetId,
    commentId,
    "no Work Action authorizes a reply on this spreadsheet (it is not bound to a Work), so the automated reply was refused fail-closed rather than posted outside the governed gate",
  );
}

export type SheetCommentOutcome =
  | "already_processed"
  | "resolved_skip"
  | "unauthorized_author"
  | "no_anchor"
  | "sheet_read_failed"
  | "anchor_not_unique"
  | "ai_not_understood"
  | "edit_not_authorized";

interface ProcessSheetCommentResult {
  handled: boolean;
  outcome: SheetCommentOutcome;
  detail?: string;
}

/**
 * Processes a single comment on a watched sheet. Never guesses WHICH cell
 * to change -- that comes only from the comment's own anchor
 * (quotedFileContent, the cell's content at the moment the human commented
 * on it). The AI is only ever asked to determine the replacement value,
 * and only proceeds when the anchored value is verified unique across the
 * sheet's current cells, so a misfire can't silently clobber the wrong
 * cell. Unlike a Doc's free-text selection, a Sheets comment always
 * anchors to one whole cell -- so there's no "occurs within a cell"
 * ambiguity, only "which cell has this exact value". The replacement is
 * then NEVER applied: comment-triggered cell edits have no registered Tool
 * operation, no Action declaration and no Architect-approved authorization
 * path, and this boundary never mints authorization -- so the flow fails
 * closed with an honest report (outcome `edit_not_authorized`) instead of
 * mutating the sheet. The dedup marker still runs, so the same request is
 * never re-attempted on every poll.
 *
 * Every reply this flow composes is refused FAIL-CLOSED (a Sheet carries no
 * Work binding, so no Work Action could ever authorize an automated reply --
 * Martin's decision, 2026-10-15; see refuseReplyWithoutWorkAction): reported
 * to Operations with identifiers only, never posted around the gate.
 */
async function processSheetComment(
  env: Env,
  sheet: WatchedGoogleSheet,
  comment: DriveComment,
  token: string,
): Promise<ProcessSheetCommentResult> {
  const alreadyProcessed = await kvGet(env, `google_comment_processed:${comment.id}`);
  if (alreadyProcessed) return { handled: false, outcome: "already_processed" };

  if (comment.resolved) {
    await markProcessed(env, comment.id);
    return { handled: false, outcome: "resolved_skip" };
  }

  // Access control: only the sheet's own authorized Google identity may
  // trigger an edit via comment -- see googleDocComments.ts for the same
  // "me" rationale.
  if (comment.author?.me !== true) {
    await markProcessed(env, comment.id);
    return {
      handled: false,
      outcome: "unauthorized_author",
      detail: `comment author.me=${comment.author?.me ?? "undefined"} (displayName='${comment.author?.displayName ?? "unknown"}')`,
    };
  }

  const quoted = comment.quotedFileContent?.value?.trim();
  if (!quoted) {
    // MARKER BEFORE REPLY (same contract as googleDocComments.ts's branches):
    // the reply is best-effort, so the comment must be durably marked before
    // it is attempted -- a refused or failed reply must never leave the
    // comment unmarked, or the next poll would process it again. The reply
    // itself is refused fail-closed (no Work Action on a Sheet -- see
    // refuseReplyWithoutWorkAction).
    await markProcessed(env, comment.id);
    await refuseReplyWithoutWorkAction(env, sheet, comment.id, "no_anchor");
    return { handled: true, outcome: "no_anchor" };
  }

  const values = await fetchSheetValues(token, sheet.spreadsheetId);
  if (values === null) {
    // Transient read failure -- retry on the next poll rather than
    // treating this as the human's problem.
    return { handled: false, outcome: "sheet_read_failed" };
  }

  const matches: { row: number; col: number }[] = [];
  for (let row = 0; row < values.length; row++) {
    const cells = values[row];
    for (let col = 0; col < cells.length; col++) {
      if ((cells[col] ?? "").trim() === quoted) {
        matches.push({ row, col });
      }
    }
  }

  if (matches.length !== 1) {
    // Marker FIRST -- the reply is best-effort and never retried.
    await markProcessed(env, comment.id);
    await refuseReplyWithoutWorkAction(env, sheet, comment.id, "anchor_not_unique");
    return { handled: true, outcome: "anchor_not_unique", detail: `quoted="${quoted}" occurrences=${matches.length}` };
  }

  const target = matches[0];
  const a1Cell = `${columnLetter(target.col + 1)}${target.row + 1}`;

  const instruction = await generate<{ understood: boolean; replacementText?: string }>(env, {
    taskId: "action.google_sheet_comment_edit",
    mode: "json",
    parts: {
      persona:
        'You interpret a Google Sheets comment as an edit instruction. You are given the exact content of the cell the comment is anchored to ("selected cell") and the comment\'s own text (the instruction). Determine the exact replacement value the cell should become. Never invent content beyond what the comment reasonably implies, and never change anything the comment does not ask for. Return JSON: {"understood": true, "replacementText": "..."} if you can determine a specific, unambiguous replacement, or {"understood": false} if the comment does not request a value change, or the requested change is ambiguous.',
      situation: `Selected cell content: "${quoted}"\n\nComment: "${comment.content}"`,
    },
  });

  if (!instruction || !instruction.understood || !instruction.replacementText?.trim()) {
    // Marker FIRST -- same contract as the other branches in this family.
    await markProcessed(env, comment.id);
    await refuseReplyWithoutWorkAction(env, sheet, comment.id, "ai_not_understood");
    return { handled: true, outcome: "ai_not_understood", detail: instruction ? JSON.stringify(instruction) : "generate() returned null" };
  }

  const replacementText = instruction.replacementText.trim();
  // Applying that replacement would be a direct Sheets values.update outside
  // the governed Tool Registry. Comment-triggered cell edits have no
  // registered operation, no Action declaration and no Architect-approved
  // authorization path behind them, and this boundary never mints
  // authorization -- so it FAILS CLOSED with an honest report instead of
  // mutating the sheet: the cell, its value and its comments are left
  // exactly as they are, the comment is marked processed (a later, different
  // comment is a new request), and the missing authorization decision is
  // reported rather than silently resolved. See docs/enig-operating-model.md
  // (Governance: reserved flows).
  //
  // MARKER BEFORE REPLY. Every branch in this family writes its processed
  // marker first and treats the reply as best-effort: a reply that fails must
  // never leave the comment unmarked, because an unmarked comment is
  // re-processed from scratch on the next poll and would be replied to again
  // -- and a duplicate reply to a human is worse than a missing one.
  //
  // THE REFUSAL REPLY ITSELF IS NOW GOVERNED (Martin's decision, 2026-10-15):
  // automated Sheets replies run only through the registered
  // external-mutation gate under the comment's Work Action, and a Sheet has
  // no Work binding -- so this reply is refused fail-closed and reported to
  // Operations with identifiers only (see refuseReplyWithoutWorkAction). The
  // REFUSAL of the edit itself is unchanged: nothing in the sheet is touched.
  await markProcessed(env, comment.id);
  await refuseReplyWithoutWorkAction(env, sheet, comment.id, "edit_not_authorized");

  await logActivity(env, {
    entry: "Google Sheet comment-triggered edit refused",
    type: "Activity",
    area: "Operations",
    activity: `Refused comment ${comment.id}'s edit to spreadsheet ${sheet.spreadsheetId} (cell ${a1Cell}): comment-triggered cell edits are not an authorized operation, so no values.update was sent`,
    outcome: "Blocked",
  });

  return { handled: true, outcome: "edit_not_authorized", detail: `comment ${comment.id} requested ${a1Cell} = "${replacementText}" -- refused (no authorization path)` };
}

export interface PollGoogleSheetCommentsResult {
  sheetsChecked: number;
  commentsProcessed: number;
  diagnostics: {
    spreadsheetId: string;
    commentId: string | null;
    outcome: SheetCommentOutcome | "token_unavailable" | "comments_list_failed" | "comments_fetched" | "persistence_unavailable" | "unhandled_exception";
    detail?: string;
  }[];
}

/**
 * Polls every sheet this system has created (see registerWatchedGoogleSheet)
 * for new, unresolved comments from the sheet's own authorized account, and
 * evaluates any that resolve to a specific, unambiguous cell replacement --
 * which is then REFUSED (fail-closed, no mutation) because comment-triggered
 * cell edits are not an authorized operation (see processSheetComment).
 * Meant to be hit every 30-60s by an external scheduler (cron-job.org),
 * same pattern as pollGoogleDocComments -- Google Drive has no push
 * notification for comment events, so polling is the only option.
 */
export async function pollGoogleSheetComments(env: Env): Promise<PollGoogleSheetCommentsResult> {
  // Records that the external scheduler actually fired, independent of
  // whether there was anything to do -- read back via
  // /admin/last-google-sheet-comment-poll. Diagnostics ONLY: best-effort,
  // so a failed write (e.g. the per-day KV write quota) is logged and never
  // blocks the poll itself from starting.
  await kvPutHeartbeat(env, "last_google_sheet_comment_poll_run", POLL_HEARTBEAT_MIN_INTERVAL_MS).catch((err) =>
    console.error("pollGoogleSheetComments: could not record the diagnostics timestamp (polling continues)", err),
  );

  const sheets = await listWatchedGoogleSheets(env);
  let commentsProcessed = 0;
  const diagnostics: PollGoogleSheetCommentsResult["diagnostics"] = [];

  for (const sheet of sheets) {
    const token = await getValidGoogleAccessToken(env, sheet.accountIdentifier);
    if (!token) {
      diagnostics.push({ spreadsheetId: sheet.spreadsheetId, commentId: null, outcome: "token_unavailable" });
      continue; // re-authorization needed -- surfaced elsewhere via existing OAuth failure paths
    }

    let comments: DriveComment[];
    try {
      comments = await fetchComments(token, sheet.spreadsheetId);
    } catch (err) {
      console.error(`pollGoogleSheetComments: failed to list comments for ${sheet.spreadsheetId}`, err);
      diagnostics.push({
        spreadsheetId: sheet.spreadsheetId,
        commentId: null,
        outcome: "comments_list_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    diagnostics.push({ spreadsheetId: sheet.spreadsheetId, commentId: null, outcome: "comments_fetched", detail: `${comments.length} comment(s) found` });

    for (const comment of comments) {
      try {
        const result = await processSheetComment(env, sheet, comment, token);
        diagnostics.push({ spreadsheetId: sheet.spreadsheetId, commentId: comment.id, outcome: result.outcome, detail: result.detail });
        if (result.handled) commentsProcessed++;
      } catch (err) {
        if (err instanceof CommentMarkerPersistenceError) {
          // The marker this comment needed could not be written. Because the
          // marker is written BEFORE the reply it guards (see markProcessed),
          // nothing was sent and nothing was claimed; the comment stays
          // unprocessed and a later poll retries it. Recorded as its own
          // truthful outcome instead of a generic handler failure -- the same
          // contract googleDocComments.ts's poller applies.
          console.error(`pollGoogleSheetComments: persistence unavailable for comment ${comment.id} on ${sheet.spreadsheetId}`, err);
          diagnostics.push({
            spreadsheetId: sheet.spreadsheetId,
            commentId: comment.id,
            outcome: "persistence_unavailable",
            detail: err.message,
          });
          continue;
        }
        console.error(`pollGoogleSheetComments: error processing comment ${comment.id} on ${sheet.spreadsheetId}`, err);
        diagnostics.push({
          spreadsheetId: sheet.spreadsheetId,
          commentId: comment.id,
          outcome: "unhandled_exception",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { sheetsChecked: sheets.length, commentsProcessed, diagnostics };
}
