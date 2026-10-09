import type { Env } from "./types";
import {
  extractDocText,
  getValidGoogleAccessToken,
  listWatchedGoogleDocs,
  type WatchedGoogleDoc,
} from "./googleOAuth";
import { generate } from "./ai";
import { logActivity } from "./log";
import { getSessionStub } from "./sessionRouting";

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

async function markProcessed(env: Env, commentId: string): Promise<void> {
  await env.STATE_KV.put(`google_comment_processed:${commentId}`, "1", {
    expirationTtl: COMMENT_PROCESSED_TTL_SECONDS,
  });
}

/**
 * The ONE "this comment is done" marker, shared by the poller and the
 * Work's clarification resume so both paths agree: whatever route ends up
 * handling a Proposal Doc comment, exactly one of them writes this before
 * that route's mutation runs, which is what makes a duplicate poll or a
 * resumed clarification unable to apply the same comment twice.
 */
export async function markProposalDocCommentProcessed(env: Env, commentId: string): Promise<void> {
  await markProcessed(env, commentId);
}

/** "A clarification for this comment is already outstanding" -- asked once, never re-asked on every poll. */
function clarificationKey(commentId: string): string {
  return `google_comment_clarification_pending:${commentId}`;
}

export async function markProposalDocClarificationRequested(env: Env, commentId: string): Promise<void> {
  await env.STATE_KV.put(clarificationKey(commentId), "1", { expirationTtl: COMMENT_PROCESSED_TTL_SECONDS });
}

/**
 * True while a clarification for this comment is outstanding on its Work.
 * The Work's own `state.awaiting` + `pendingProposalDocClarification` remain
 * the authority on what happens next; this marker only keeps the poller from
 * asking the same question again on every pass.
 */
export async function isProposalDocClarificationPending(env: Env, commentId: string): Promise<boolean> {
  return Boolean(await env.STATE_KV.get(clarificationKey(commentId)));
}

export type CommentOutcome =
  | "already_processed"
  | "resolved_skip"
  | "unauthorized_author"
  | "no_anchor"
  | "doc_read_failed"
  | "anchor_not_unique"
  | "ai_not_understood"
  | "edit_not_authorized"
  | "change_requested"
  | "change_not_applied"
  | "empty_comment"
  | "ambiguous_intent"
  | "clarification_pending"
  | "formatting_applied"
  | "formatting_not_applied";

interface ProcessCommentResult {
  handled: boolean;
  outcome: CommentOutcome;
  detail?: string;
}

/** Longest selected passage carried into a change request, so the request stays a sentence, not a paste. */
const MAX_QUOTED_CHARS = 300;

export type ProposalCommentIntent = "formatting" | "substantive" | "ambiguous";

/**
 * Routing-only classification of a Proposal Doc comment (the approved
 * three-way policy): "formatting" ONLY for unambiguous presentation-only
 * requests that request no text change, "substantive" for any requested
 * change to wording/text/terms/meaning (including a mixed request that also
 * mentions formatting), "ambiguous" for anything unclear. The AI result is a
 * routing signal alone -- it can never approve a Proposal, authorize a
 * change, override a binding or bypass a gate -- and anything unexpected
 * (classifier failure, null output, malformed output, an unrecognised
 * label) fails closed to "ambiguous", never to a handler.
 */
export async function classifyProposalCommentIntent(env: Env, text: string): Promise<ProposalCommentIntent> {
  let classified: { intent?: unknown } | null;
  try {
    classified = await generate<{ intent?: unknown }>(env, {
      taskId: "action.google_doc_comment_intent",
      mode: "json",
      parts: {
        persona:
          'You classify ONE comment left on a Google Doc that is a faithful copy of a Proposal whose visible text is the exact source of truth. The Doc is never edited in place; your classification only routes the comment to the right handler. Return JSON {"intent": "..."}. "formatting" ONLY when the comment asks solely for presentation changes (layout, spacing, headings, bullets, fonts, colors, styling) and requests no change to any word, number, date, price, term, scope or meaning. "substantive" when the comment asks for ANY change to wording, text, content, numbers, dates, quantities, prices, terms, obligations, scope or meaning -- including a mixed request that also mentions formatting. "ambiguous" when the intent is unclear, or mixed without a clearly stated text change, or does not fit these rules. When in doubt, return "ambiguous"; never guess a text change into existence.',
        situation: `Comment: "${text}"`,
      },
    });
  } catch (err) {
    console.error("classifyProposalCommentIntent: classifier threw", err);
    return "ambiguous";
  }
  if (!classified || (classified.intent !== "formatting" && classified.intent !== "substantive" && classified.intent !== "ambiguous")) return "ambiguous";
  return classified.intent;
}

/**
 * A comment on a Proposal Doc is first CLASSIFIED (routing only, fail-closed
 * ambiguous): a presentation-only request runs the Doc's formatting-only
 * path (applyProposalDocFormatting -- the registered, governed
 * `google_docs.format_and_verify` operation; styling only, no Version, no
 * content change), anything requesting a text change becomes the Proposal's
 * own "Request changes" input for the Doc's exact version: the Work records
 * it verbatim in the next version and sends that to Martin for approval
 * (tokenSafeProposal.ts), and an unclear request is ASKED ABOUT, with
 * neither handler run. The Doc's text is never edited in place.
 *
 * The comment is marked processed immediately before whichever handler runs,
 * so a retry can never create the same revision (or repeat the same
 * formatting) twice; if a handler fails, the reply says so and Martin
 * comments again. The one exception is the ambiguous case: no handler ran,
 * so nothing may mark it processed -- the request is carried on its Work as
 * an awaiting clarification (`state.awaiting`, resumed by Martin's Telegram
 * reply) and stays recoverable. A later poll sees that clarification is
 * outstanding and neither re-classifies nor re-asks.
 */
async function processProposalComment(env: Env, doc: WatchedGoogleDoc, comment: DriveComment, token: string): Promise<ProcessCommentResult> {
  const binding = doc.proposal!;
  const body = comment.content?.trim();
  if (!body) {
    await markProcessed(env, comment.id);
    return { handled: false, outcome: "empty_comment" };
  }
  // A clarification for this comment is already outstanding on its Work,
  // where Martin's Telegram reply will resume it. Do not re-classify, do not
  // ask the same question again, and above all do not mark it processed --
  // that would close off the very request still waiting to be answered.
  if (await isProposalDocClarificationPending(env, comment.id)) {
    return { handled: false, outcome: "clarification_pending", detail: "awaiting Martin's clarification on Telegram" };
  }
  const quoted = comment.quotedFileContent?.value?.trim();
  const text = quoted ? `Regarding "${quoted.slice(0, MAX_QUOTED_CHARS)}": ${body}` : body;

  const intent = await classifyProposalCommentIntent(env, text);
  if (intent === "ambiguous") {
    // Neither mutation path may run. The request is recorded on its Work as
    // an awaiting clarification -- the same continuation every other
    // multi-turn flow uses -- and the comment is deliberately left
    // unprocessed so it cannot be lost. If the Work cannot hold it, that is
    // reported honestly and nothing is settled by guesswork.
    const requested = await getSessionStub(env, binding.workId).requestProposalDocClarification({
      proposalNumber: binding.proposalNumber,
      version: binding.version,
      commentId: comment.id,
      documentId: doc.documentId,
      text,
    });
    if (!requested.ok) {
      // A transient ordering (another clarification is already outstanding)
      // is left unprocessed so a later poll may retry it; a refusal that can
      // never succeed for THIS comment is closed off honestly -- marked so it
      // is not re-classified on every future poll, and answered in the thread.
      if (requested.retryable) {
        return { handled: false, outcome: "ambiguous_intent", detail: `clarification deferred: ${requested.detail}` };
      }
      await markProcessed(env, comment.id);
      await replyToComment(token, doc.documentId, comment.id, `Nothing was changed -- ${requested.detail}`);
      return { handled: true, outcome: "ambiguous_intent", detail: `clarification not recorded: ${requested.detail}` };
    }
    await markProposalDocClarificationRequested(env, comment.id);
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      "I couldn't tell whether this is a presentation-only formatting request or a requested change to the Proposal's content. Nothing has been changed. Reply to me in Telegram, stating one of: (a) formatting only -- presentation changes, no text change; or (b) the exact content/text change you want.",
    );
    return { handled: true, outcome: "ambiguous_intent", detail: "clarification requested; the comment stays unprocessed until it is answered" };
  }

  await markProcessed(env, comment.id);

  if (intent === "formatting") {
    const result = await getSessionStub(env, binding.workId).handleProposalDocFormatting({
      proposalNumber: binding.proposalNumber,
      version: binding.version,
    });
    if (result.kind === "formatted") {
      await replyToComment(
        token,
        doc.documentId,
        comment.id,
        `Formatting applied -- the Doc's content is unchanged and no new version was created (this Doc stays at ${binding.proposalId} v${binding.version}).`,
      );
      await resolveComment(token, doc.documentId, comment.id);
      return { handled: true, outcome: "formatting_applied", detail: `formatted ${binding.proposalId} v${binding.version}` };
    }
    await replyToComment(token, doc.documentId, comment.id, `Not applied -- ${result.detail}`);
    return { handled: true, outcome: "formatting_not_applied", detail: `${result.kind}: ${result.detail}` };
  }

  const result = await getSessionStub(env, binding.workId).handleProposalDocComment({
    proposalNumber: binding.proposalNumber,
    version: binding.version,
    text,
  });

  if (result.kind === "revised") {
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      `Change requested -- ${binding.proposalId} v${result.newVersion} was created with it and sent to Martin for approval. This Doc (v${binding.version}) is unchanged.`,
    );
    await resolveComment(token, doc.documentId, comment.id);
    return { handled: true, outcome: "change_requested", detail: `change request -> ${binding.proposalId} v${result.newVersion}` };
  }
  await replyToComment(token, doc.documentId, comment.id, `Not applied -- ${result.detail}`);
  return { handled: true, outcome: "change_not_applied", detail: `${result.kind}: ${result.detail}` };
}

/**
 * Processes a single comment on a watched doc. Never guesses WHICH text to
 * change -- that comes only from the comment's own anchor (quotedFileContent),
 * set by the human selecting text before commenting. The AI is only ever
 * asked to determine the replacement text, and only proceeds when the
 * anchored text is verified unique in the doc's current content, so a
 * misfire can't silently clobber the wrong occurrence. The replacement is
 * then NEVER applied: comment-triggered in-place edits have no registered
 * Tool operation, no Action declaration and no Architect-approved
 * authorization path, and this boundary never mints authorization -- so the
 * flow fails closed with an honest reply and reports the missing
 * authorization decision (outcome `edit_not_authorized`) instead of
 * mutating the document. The dedup marker still runs, so the same request
 * is never re-attempted on every poll.
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

  // A Doc created from a Runtime Sales Proposal version: a comment there is a
  // change REQUEST for that exact version, never an in-place edit.
  if (doc.proposal) return processProposalComment(env, doc, comment, token);

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

  const instruction = await generate<{ understood: boolean; replacementText?: string }>(env, {
    taskId: "action.google_doc_comment_edit",
    mode: "json",
    parts: {
      persona:
        'You interpret a Google Docs comment as an edit instruction. You are given the exact text the comment is anchored to ("selected text") and the comment\'s own text (the instruction). Determine the exact replacement text the selected text should become. Never invent content beyond what the comment reasonably implies, and never change anything the comment does not ask for. Return JSON: {"understood": true, "replacementText": "..."} if you can determine a specific, unambiguous replacement, or {"understood": false} if the comment does not request a text change, or the requested change is ambiguous.',
      situation: `Selected text: "${quoted}"\n\nComment: "${comment.content}"`,
    },
  });

  if (!instruction || !instruction.understood || !instruction.replacementText?.trim()) {
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      "I wasn't able to determine a specific replacement from this comment — could you clarify exactly what the selected text should become?",
    );
    await markProcessed(env, comment.id);
    return { handled: true, outcome: "ai_not_understood", detail: instruction ? JSON.stringify(instruction) : "generate() returned null" };
  }

  const replacementText = instruction.replacementText.trim();
  // Applying that replacement would be a direct Docs batchUpdate outside the
  // governed Tool Registry. Comment-triggered in-place edits have no
  // registered operation, no Action declaration and no Architect-approved
  // authorization path behind them, and this boundary never mints
  // authorization -- so it FAILS CLOSED with an honest report instead of
  // mutating the document: the Doc, its anchored text and its comments are
  // left exactly as they are, the comment is marked processed (a later,
  // different comment is a new request), and the missing authorization
  // decision is reported rather than silently resolved. See
  // docs/enig-operating-model.md (Governance: reserved flows).
  await replyToComment(
    token,
    doc.documentId,
    comment.id,
    `I can't apply this edit: comment-triggered in-place edits are not an authorized operation in the governed external-effect boundary, so nothing in this document was changed. This is reported to Martin as a missing authorization decision, not carried out.`,
  );
  await markProcessed(env, comment.id);

  await logActivity(env, {
    entry: "Google Doc comment-triggered edit refused",
    type: "Activity",
    area: "Operations",
    activity: `Refused comment ${comment.id}'s edit to document ${doc.documentId}: comment-triggered in-place edits are not an authorized operation, so no batchUpdate was sent`,
    outcome: "Blocked",
  });

  return { handled: true, outcome: "edit_not_authorized", detail: `comment ${comment.id} requested a replacement of "${quoted}" with "${replacementText}" -- refused (no authorization path)` };
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
