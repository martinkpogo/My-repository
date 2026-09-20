import type { Env } from "./types";
import {
  columnLetter,
  getValidGoogleAccessToken,
  listWatchedGoogleSheets,
  type WatchedGoogleSheet,
} from "./googleOAuth";
import { aiJson } from "./ai";
import { logActivity } from "./log";
import { sendWorkspaceHatMessage } from "./telegram";

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

async function fetchComments(token: string, spreadsheetId: string): Promise<DriveComment[]> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/comments` +
    `?fields=comments(id,content,resolved,author(displayName,me),quotedFileContent(value))` +
    `&pageSize=100&includeDeleted=false`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Drive comments.list failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { comments?: DriveComment[] };
  return data.comments ?? [];
}

async function replyToComment(token: string, spreadsheetId: string, commentId: string, content: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/comments/${commentId}/replies?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

async function resolveComment(token: string, spreadsheetId: string, commentId: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/comments/${commentId}?fields=id`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ resolved: true }),
  });
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

async function applyCellReplacement(
  token: string,
  spreadsheetId: string,
  a1Cell: string,
  replaceText: string,
): Promise<boolean> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${a1Cell}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: a1Cell, values: [[replaceText]] }),
    },
  );
  return res.ok;
}

async function markProcessed(env: Env, commentId: string): Promise<void> {
  await env.STATE_KV.put(`google_comment_processed:${commentId}`, "1", {
    expirationTtl: COMMENT_PROCESSED_TTL_SECONDS,
  });
}

export type SheetCommentOutcome =
  | "already_processed"
  | "resolved_skip"
  | "unauthorized_author"
  | "no_anchor"
  | "sheet_read_failed"
  | "anchor_not_unique"
  | "ai_not_understood"
  | "cell_update_failed"
  | "applied";

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
 * ambiguity, only "which cell has this exact value".
 */
async function processSheetComment(
  env: Env,
  sheet: WatchedGoogleSheet,
  comment: DriveComment,
  token: string,
): Promise<ProcessSheetCommentResult> {
  const alreadyProcessed = await env.STATE_KV.get(`google_comment_processed:${comment.id}`);
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
    await replyToComment(
      token,
      sheet.spreadsheetId,
      comment.id,
      "I can only execute edits anchored to a specific cell right now — please select the cell you want changed, then comment on it.",
    );
    await markProcessed(env, comment.id);
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
    await replyToComment(
      token,
      sheet.spreadsheetId,
      comment.id,
      matches.length === 0
        ? "I couldn't find the exact cell content you selected anymore — it may have already changed. Please re-select the cell and comment again."
        : `The selected value appears in ${matches.length} cells, so I can't safely target just this one — please make sure the cell's content is unique before commenting again.`,
    );
    await markProcessed(env, comment.id);
    return { handled: true, outcome: "anchor_not_unique", detail: `quoted="${quoted}" occurrences=${matches.length}` };
  }

  const target = matches[0];
  const a1Cell = `${columnLetter(target.col + 1)}${target.row + 1}`;

  const instruction = await aiJson<{ understood: boolean; replacementText?: string }>(env, {
    taskId: "action.google_sheet_comment_edit",
    system:
      'You interpret a Google Sheets comment as an edit instruction. You are given the exact content of the cell the comment is anchored to ("selected cell") and the comment\'s own text (the instruction). Determine the exact replacement value the cell should become. Never invent content beyond what the comment reasonably implies, and never change anything the comment does not ask for. Return JSON: {"understood": true, "replacementText": "..."} if you can determine a specific, unambiguous replacement, or {"understood": false} if the comment does not request a value change, or the requested change is ambiguous.',
    user: `Selected cell content: "${quoted}"\n\nComment: "${comment.content}"`,
  });

  if (!instruction || !instruction.understood || !instruction.replacementText?.trim()) {
    await replyToComment(
      token,
      sheet.spreadsheetId,
      comment.id,
      "I wasn't able to determine a specific replacement from this comment — could you clarify exactly what this cell should become?",
    );
    await markProcessed(env, comment.id);
    return { handled: true, outcome: "ai_not_understood", detail: instruction ? JSON.stringify(instruction) : "aiJson returned null" };
  }

  const replacementText = instruction.replacementText.trim();
  const applied = await applyCellReplacement(token, sheet.spreadsheetId, a1Cell, replacementText);

  if (!applied) {
    await logActivity(env, {
      entry: "Google Sheet comment-triggered edit failed",
      type: "Activity",
      area: "Operations",
      activity: `Sheets values.update failed applying comment ${comment.id}'s edit to spreadsheet ${sheet.spreadsheetId} (cell ${a1Cell})`,
      outcome: "Blocked",
    });
    // Leave unprocessed -- retry next poll; may be transient.
    return { handled: false, outcome: "cell_update_failed" };
  }

  await replyToComment(token, sheet.spreadsheetId, comment.id, `Done — changed to: "${replacementText}"`);
  await resolveComment(token, sheet.spreadsheetId, comment.id);
  await markProcessed(env, comment.id);

  await logActivity(env, {
    entry: "Google Sheet comment-triggered edit applied",
    type: "Activity",
    area: "Operations",
    activity: `Replaced cell ${a1Cell} ("${quoted}" -> "${replacementText}") in spreadsheet '${sheet.title}' (${sheet.spreadsheetId}) per comment ${comment.id}`,
    outcome: "Complete",
  });

  if (sheet.chatId) {
    await sendWorkspaceHatMessage(
      env,
      { chatId: sheet.chatId, threadId: sheet.threadId },
      `✏️ Applied a comment-requested edit to *${sheet.title}* (${a1Cell}): "${quoted}" → "${replacementText}"`,
    );
  }

  return { handled: true, outcome: "applied", detail: `${a1Cell}: "${quoted}" -> "${replacementText}"` };
}

export interface PollGoogleSheetCommentsResult {
  sheetsChecked: number;
  commentsProcessed: number;
  diagnostics: {
    spreadsheetId: string;
    commentId: string | null;
    outcome: SheetCommentOutcome | "token_unavailable" | "comments_list_failed" | "comments_fetched" | "unhandled_exception";
    detail?: string;
  }[];
}

/**
 * Polls every sheet this system has created (see registerWatchedGoogleSheet)
 * for new, unresolved comments from the sheet's own authorized account, and
 * applies any that resolve to a specific, unambiguous cell replacement.
 * Meant to be hit every 30-60s by an external scheduler (cron-job.org),
 * same pattern as pollGoogleDocComments -- Google Drive has no push
 * notification for comment events, so polling is the only option.
 */
export async function pollGoogleSheetComments(env: Env): Promise<PollGoogleSheetCommentsResult> {
  // Records that the external scheduler actually fired, independent of
  // whether there was anything to do -- read back via
  // /admin/last-google-sheet-comment-poll.
  await env.STATE_KV.put("last_google_sheet_comment_poll_run", new Date().toISOString());

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
