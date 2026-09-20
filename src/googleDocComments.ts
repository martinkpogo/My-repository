import type { Env } from "./types";
import {
  extractDocText,
  getValidGoogleAccessToken,
  listWatchedGoogleDocs,
  type WatchedGoogleDoc,
} from "./googleOAuth";
import { aiJson } from "./ai";
import { logActivity } from "./log";
import { sendWorkspaceHatMessage } from "./telegram";

const COMMENT_PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

interface DriveCommentAuthor {
  displayName?: string;
  // Google Drive's Comments API frequently omits emailAddress for privacy
  // (confirmed live: real comments came back with no emailAddress at all,
  // even from the doc's own authorized account) -- "me" is the reliable
  // signal instead: true iff this comment was authored by the same
  // identity as whoever's access token was used to fetch it, which is
  // exactly "was this the doc's own authorized account" in this
  // single-account-per-doc design, without depending on email visibility.
  me?: boolean;
}

interface DriveComment {
  id: string;
  content: string;
  resolved?: boolean;
  author?: DriveCommentAuthor;
  quotedFileContent?: { value?: string };
}

async function fetchComments(token: string, documentId: string): Promise<DriveComment[]> {
  const url =
    `https://www.googleapis.com/drive/v3/files/${documentId}/comments` +
    `?fields=comments(id,content,resolved,author(displayName,me),quotedFileContent(value))` +
    `&pageSize=100&includeDeleted=false`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Drive comments.list failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { comments?: DriveComment[] };
  return data.comments ?? [];
}

async function replyToComment(token: string, documentId: string, commentId: string, content: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}/comments/${commentId}/replies?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

async function resolveComment(token: string, documentId: string, commentId: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}/comments/${commentId}?fields=id`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ resolved: true }),
  });
}

async function fetchDocText(token: string, documentId: string): Promise<string | null> {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  try {
    return extractDocText(await res.json());
  } catch {
    return null;
  }
}

async function applyReplacement(
  token: string,
  documentId: string,
  containsText: string,
  replaceText: string,
): Promise<boolean> {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          replaceAllText: {
            containsText: { text: containsText, matchCase: true },
            replaceText,
          },
        },
      ],
    }),
  });
  return res.ok;
}

async function markProcessed(env: Env, commentId: string): Promise<void> {
  await env.STATE_KV.put(`google_comment_processed:${commentId}`, "1", {
    expirationTtl: COMMENT_PROCESSED_TTL_SECONDS,
  });
}

export type CommentOutcome =
  | "already_processed"
  | "resolved_skip"
  | "unauthorized_author"
  | "no_anchor"
  | "doc_read_failed"
  | "anchor_not_unique"
  | "ai_not_understood"
  | "batch_update_failed"
  | "applied";

interface ProcessCommentResult {
  handled: boolean;
  outcome: CommentOutcome;
  detail?: string;
}

/**
 * Processes a single comment on a watched doc. Never guesses WHICH text to
 * change -- that comes only from the comment's own anchor (quotedFileContent),
 * set by the human selecting text before commenting. The AI is only ever
 * asked to determine the replacement text, and only proceeds when the
 * anchored text is verified unique in the doc's current content, so a
 * misfire can't silently clobber the wrong occurrence.
 */
async function processComment(env: Env, doc: WatchedGoogleDoc, comment: DriveComment, token: string): Promise<ProcessCommentResult> {
  const alreadyProcessed = await env.STATE_KV.get(`google_comment_processed:${comment.id}`);
  if (alreadyProcessed) return { handled: false, outcome: "already_processed" };

  if (comment.resolved) {
    await markProcessed(env, comment.id);
    return { handled: false, outcome: "resolved_skip" };
  }

  // Access control: only the doc's own authorized Google identity may
  // trigger an edit via comment -- any other commenter's request is
  // ignored (marked processed so it isn't re-checked forever, but never
  // acted on or replied to). "me" (not emailAddress, which Drive's
  // Comments API frequently omits) is the reliable signal: true iff this
  // comment's author is the same identity as the access token used to
  // fetch it, i.e. the doc's own authorized account.
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
      doc.documentId,
      comment.id,
      "I can only execute edits anchored to specific selected text right now — please select the text you want changed, then comment on that selection.",
    );
    await markProcessed(env, comment.id);
    return { handled: true, outcome: "no_anchor" };
  }

  const fullText = await fetchDocText(token, doc.documentId);
  if (fullText === null) {
    // Transient read failure -- retry on the next poll rather than
    // treating this as the human's problem.
    return { handled: false, outcome: "doc_read_failed" };
  }

  const occurrences = fullText.split(quoted).length - 1;
  if (occurrences !== 1) {
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      occurrences === 0
        ? "I couldn't find the exact text you selected anymore — it may have already changed. Please re-select and comment again."
        : `The selected text appears ${occurrences} times in the document, so I can't safely target just this one — please select a longer, unique snippet and comment again.`,
    );
    await markProcessed(env, comment.id);
    return { handled: true, outcome: "anchor_not_unique", detail: `quoted="${quoted}" occurrences=${occurrences}` };
  }

  const instruction = await aiJson<{ understood: boolean; replacementText?: string }>(env, {
    taskId: "action.google_doc_comment_edit",
    system:
      'You interpret a Google Docs comment as an edit instruction. You are given the exact text the comment is anchored to ("selected text") and the comment\'s own text (the instruction). Determine the exact replacement text the selected text should become. Never invent content beyond what the comment reasonably implies, and never change anything the comment does not ask for. Return JSON: {"understood": true, "replacementText": "..."} if you can determine a specific, unambiguous replacement, or {"understood": false} if the comment does not request a text change, or the requested change is ambiguous.',
    user: `Selected text: "${quoted}"\n\nComment: "${comment.content}"`,
  });

  if (!instruction || !instruction.understood || !instruction.replacementText?.trim()) {
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      "I wasn't able to determine a specific replacement from this comment — could you clarify exactly what the selected text should become?",
    );
    await markProcessed(env, comment.id);
    return { handled: true, outcome: "ai_not_understood", detail: instruction ? JSON.stringify(instruction) : "aiJson returned null" };
  }

  const replacementText = instruction.replacementText.trim();
  const applied = await applyReplacement(token, doc.documentId, quoted, replacementText);

  if (!applied) {
    await logActivity(env, {
      entry: "Google Doc comment-triggered edit failed",
      type: "Activity",
      area: "Operations",
      activity: `Docs batchUpdate failed applying comment ${comment.id}'s edit to document ${doc.documentId}`,
      outcome: "Blocked",
    });
    // Leave unprocessed -- retry next poll; may be transient.
    return { handled: false, outcome: "batch_update_failed" };
  }

  await replyToComment(token, doc.documentId, comment.id, `Done — changed to: "${replacementText}"`);
  await resolveComment(token, doc.documentId, comment.id);
  await markProcessed(env, comment.id);

  await logActivity(env, {
    entry: "Google Doc comment-triggered edit applied",
    type: "Activity",
    area: "Operations",
    activity: `Replaced "${quoted}" with "${replacementText}" in document '${doc.title}' (${doc.documentId}) per comment ${comment.id}`,
    outcome: "Complete",
  });

  if (doc.chatId) {
    await sendWorkspaceHatMessage(
      env,
      { chatId: doc.chatId, threadId: doc.threadId },
      `✏️ Applied a comment-requested edit to *${doc.title}*: "${quoted}" → "${replacementText}"`,
    );
  }

  return { handled: true, outcome: "applied", detail: `"${quoted}" -> "${replacementText}"` };
}

export interface PollGoogleDocCommentsResult {
  docsChecked: number;
  commentsProcessed: number;
  diagnostics: {
    documentId: string;
    commentId: string | null;
    outcome: CommentOutcome | "token_unavailable" | "comments_list_failed" | "comments_fetched" | "unhandled_exception";
    detail?: string;
  }[];
}

/**
 * Polls every doc this system has created (see registerWatchedGoogleDoc)
 * for new, unresolved comments from the doc's own authorized account, and
 * applies any that resolve to a specific, unambiguous text replacement.
 * Meant to be hit every 30-60s by an external scheduler (cron-job.org),
 * same pattern as /admin/run-finance-discovery and
 * /admin/run-lead-discovery -- Google Drive has no push notification for
 * comment events (verified against Drive API docs: the X-Goog-Changed
 * header's tracked change types are content/properties/parents/children/
 * permissions, comments are not among them), so polling is the only
 * option, not a fallback for a push mechanism that doesn't exist.
 */
export async function pollGoogleDocComments(env: Env): Promise<PollGoogleDocCommentsResult> {
  // Records that the external scheduler actually fired, independent of
  // whether there was anything to do -- read back via
  // /admin/last-google-doc-comment-poll to verify cron-job.org is really
  // hitting this on schedule (Cloudflare's basic Workers analytics doesn't
  // break requests down by path, so there's no other way to tell this
  // endpoint's traffic apart from any other route's).
  await env.STATE_KV.put("last_google_doc_comment_poll_run", new Date().toISOString());

  const docs = await listWatchedGoogleDocs(env);
  let commentsProcessed = 0;
  const diagnostics: PollGoogleDocCommentsResult["diagnostics"] = [];

  for (const doc of docs) {
    const token = await getValidGoogleAccessToken(env, doc.accountIdentifier);
    if (!token) {
      diagnostics.push({ documentId: doc.documentId, commentId: null, outcome: "token_unavailable" });
      continue; // re-authorization needed -- surfaced elsewhere via existing OAuth failure paths
    }

    let comments: DriveComment[];
    try {
      comments = await fetchComments(token, doc.documentId);
    } catch (err) {
      console.error(`pollGoogleDocComments: failed to list comments for ${doc.documentId}`, err);
      diagnostics.push({
        documentId: doc.documentId,
        commentId: null,
        outcome: "comments_list_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    diagnostics.push({ documentId: doc.documentId, commentId: null, outcome: "comments_fetched", detail: `${comments.length} comment(s) found` });

    for (const comment of comments) {
      try {
        const result = await processComment(env, doc, comment, token);
        diagnostics.push({ documentId: doc.documentId, commentId: comment.id, outcome: result.outcome, detail: result.detail });
        if (result.handled) commentsProcessed++;
      } catch (err) {
        console.error(`pollGoogleDocComments: error processing comment ${comment.id} on ${doc.documentId}`, err);
        diagnostics.push({
          documentId: doc.documentId,
          commentId: comment.id,
          outcome: "unhandled_exception",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { docsChecked: docs.length, commentsProcessed, diagnostics };
}
