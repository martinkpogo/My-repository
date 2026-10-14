import type { Env } from "./types";
import {
  extractDocText,
  getValidGoogleAccessToken,
  listWatchedGoogleDocs,
  type WatchedGoogleDoc,
} from "./googleOAuth";
import { generate } from "./ai";
import { logActivity } from "./log";
import {
  handleProposalDocComment,
  handleProposalDocFormatting,
  requestProposalDocClarificationOnWork,
  syncProposalDocApprovalCycle,
} from "./units/sales/salesOperations";
import { sendOperationsMessage } from "./telegram";
import { kvGet, kvPut, kvPutHeartbeat, maybeSweepKvFallback, POLL_HEARTBEAT_MIN_INTERVAL_MS } from "./kvStore";
import { DRIVE_DOC_LOCK_TTL_MS, driveDocLockStub } from "./driveDocLockState";

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

interface DriveCommentReply {
  id: string;
  // Google records a "resolve" action as a replies[] entry carrying
  // action:"resolve" with its own author (confirmed live 2026-10-11). This is
  // the only resolver-bearing signal the Comments API exposes -- the comment's
  // own `author` is its commenter, never its resolver -- and because the
  // Runtime reads comments with the same authorized account token Martin's
  // account uses, that reply's author identifies the ACCOUNT, not the human
  // user. It is therefore recorded as evidence only; observed `resolved` is
  // the approval signal (Martin's explicit choice) and no resolver identity
  // is required.
  action?: string;
  author?: DriveCommentAuthor;
  createdTime?: string;
  deleted?: boolean;
}

interface DriveComment {
  id: string;
  content: string;
  // The approval signal Martin chose: observed resolution, without requiring
  // proof of which human clicked Resolve.
  resolved?: boolean;
  // When the comment was last modified -- including a transition to
  // resolved=true. Recorded as resolution evidence/timing only.
  modifiedTime?: string;
  author?: DriveCommentAuthor;
  quotedFileContent?: { value?: string };
  replies?: DriveCommentReply[];
}

/**
 * The maximum number of comment pages fetched for one document. A page holds
 * up to `pageSize=100` comments, so this caps a single fetch at 10,000
 * comments -- far beyond any real Proposal Doc, and present only so an API
 * that kept minting fresh tokens could never make this loop forever.
 * Reaching it throws, so the fetch fails closed rather than returning a list
 * that may be incomplete.
 */
const MAX_COMMENT_PAGES = 100;

/**
 * Lists EVERY comment on a watched document. `comments.list` is paginated at
 * `pageSize=100`, so a single request silently drops every comment after the
 * first 100 -- which, since a Proposal's approval cycle is driven by the
 * resolution state observed here (see the poller's cycle sync below), would
 * let a comment on page 2 hold or complete an approval cycle without ever
 * being seen. Each response's `nextPageToken` is therefore followed as the
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
 * `comments_list_failed` for the document and moves to the next one, so
 * nothing is half-processed and a later poll retries the document from its
 * first page. An absent or empty `nextPageToken` is normal completion. A
 * token the API has already handed back is refused -- continuing would spin,
 * and stopping early would return a list not known to be complete.
 */
async function fetchComments(token: string, documentId: string): Promise<DriveComment[]> {
  const base =
    `https://www.googleapis.com/drive/v3/files/${documentId}/comments` +
    `?fields=comments(id,content,resolved,modifiedTime,author(displayName,me),quotedFileContent(value),replies(id,action,author(displayName,me),createdTime,deleted))` +
    `&pageSize=100&includeDeleted=false`;

  const all: DriveComment[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; ; page++) {
    if (page >= MAX_COMMENT_PAGES) {
      throw new Error(
        `Drive comments.list exceeded ${MAX_COMMENT_PAGES} pages for ${documentId}; refusing to keep paginating or to return a possibly-incomplete list.`,
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
        `Drive comments.list returned a repeated page token for ${documentId}; refusing to loop or to return a possibly-incomplete list.`,
      );
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

async function replyToComment(token: string, documentId: string, commentId: string, content: string): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}/comments/${commentId}/replies?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

/**
 * Sends a reply and REPORTS whether the provider actually accepted it --
 * `replyToComment` above ignores the response entirely, which silently
 * claims success for a rejected reply. This variant (used only by the
 * NON-Proposal branches; the Proposal path is deliberately untouched) reads
 * the status and returns a failure rather than pretending.
 *
 * A failure is reported to Operations as its own signal, never swallowed and
 * never thrown back into the poll loop: the caller has already written its
 * processed marker before replying, so the comment is durably done and a
 * retry is not safe (it could duplicate a reply after an uncertain provider
 * outcome). The alert therefore reports and stops; it does not clear the
 * marker and does not retry.
 */
async function replyToCommentChecked(
  env: Env,
  token: string,
  documentId: string,
  commentId: string,
  content: string,
  operation: string,
): Promise<{ ok: boolean; status: number }> {
  let res: Response;
  try {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}/comments/${commentId}/replies?fields=id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    await reportReplyFailure(env, operation, documentId, commentId, `request failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 0 };
  }
  if (!res.ok) {
    await reportReplyFailure(env, operation, documentId, commentId, `HTTP ${res.status}`);
    return { ok: false, status: res.status };
  }
  return { ok: true, status: res.status };
}

/**
 * The one place a failed reply is made operationally visible. Deliberately
 * carries ONLY identifiers and the failure category -- never the comment's
 * text, never the reply text, never the anchored selection. Comment content
 * stays out of the Operations stream (and out of Telegram, which is not a
 * governed data boundary); what goes is enough to find and diagnose the
 * failure: which operation, on which document, on which comment, and how it
 * failed. Best-effort and never thrown: a failure to REPORT must not itself
 * fail the comment, which is already durably marked.
 */
async function reportReplyFailure(
  env: Env,
  operation: string,
  documentId: string,
  commentId: string,
  reason: string,
): Promise<void> {
  await sendOperationsMessage(
    env,
    `⚠️ Google comment reply not delivered\nOperation: ${operation}\nDocument: ${documentId}\nComment: ${commentId}\nReason: ${reason}\n\nThe comment is already marked processed, so this reply is not retried automatically (a retry could duplicate it after an uncertain outcome). No comment content is included in this message.`,
  ).catch((err) => console.error("reportReplyFailure: could not send the Operations alert", err));
}

/**
 * The one honest answer to a Proposal comment whose handler or transport
 * escaped AFTER its processed marker was already written (the marker runs
 * before the handler, so such a comment is durably done and will never be
 * picked up by a later pass).
 *
 * WHAT ESCAPED IS GENUINELY UNKNOWN. The throw can come from before any
 * outcome existed (a lost Durable Object transport call), but it can equally
 * come from AFTER a successful revision, when the confirmation reply or the
 * resolve could not be delivered -- and a lost response may even hide a
 * completed run. The error that reaches the caller carries no origin, so the
 * escape is answered with its true uncertainty: processing was interrupted,
 * the outcome could not be confirmed, and the authoritative Proposal and
 * Operations records are where it can be checked. It NEVER claims the request
 * was not applied, NEVER claims success, NEVER implies a retry, and never
 * claims the Operations notification was delivered -- that notification is
 * itself best-effort and may fail, and a failed claim would be worse than
 * silence.
 *
 * Both attempts are best-effort and independently guarded: a reply that
 * cannot be delivered (or an alert that cannot be sent) is logged and
 * swallowed here, so neither can replace the `unhandled_exception` diagnostic
 * the caller records FIRST, nor change control flow, nor re-enter any
 * handler. The comment stays marked -- unmarking would risk a duplicate
 * revision after an ambiguous outcome.
 */
async function answerEscapedProposalComment(env: Env, doc: WatchedGoogleDoc, comment: DriveComment, token: string): Promise<void> {
  if (!doc.proposal) return;
  let marked: string | null = null;
  try {
    // Only a CONFIRMED marker gates the answer: replying to a comment that is
    // still unprocessed could contradict the pass a later poll legitimately
    // runs over it.
    marked = await kvGet(env, `google_comment_processed:${comment.id}`);
  } catch (err) {
    console.error(`answerEscapedProposalComment: could not read the processed marker for comment ${comment.id}`, err);
    return;
  }
  if (!marked) return;
  try {
    await sendOperationsMessage(
      env,
      `⚠️ Google Doc comment pass stopped\nDocument: ${doc.documentId}\nComment: ${comment.id}\n\nThe pass stopped with an error after this comment was marked processed and the outcome of the request could not be confirmed -- it may have been applied before the interruption. The comment is answered with that uncertainty and is never retried automatically (a retry could duplicate an uncertain outcome). No comment content is included in this message.`,
    );
  } catch (err) {
    console.error(`answerEscapedProposalComment: could not send the Operations notification for comment ${comment.id}`, err);
  }
  try {
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      "An internal error interrupted processing, so the outcome of this request could not be confirmed. Please check the Proposal and its Operations record before taking any further action.",
    );
  } catch (err) {
    console.error(`answerEscapedProposalComment: could not deliver the honest reply for comment ${comment.id}`, err);
  }
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

/**
 * Thrown when a comment's REQUIRED persistence marker cannot be written
 * (today: Cloudflare's per-day KV write quota). Both routes agree on what it
 * means, because both write their marker BEFORE the effect it guards: a typed
 * failure here means the effect never ran, the comment stays unprocessed, and
 * a later retry may run it exactly once. It is never swallowed into a success
 * and never left to surface as a generic handler failure.
 */
export class CommentMarkerPersistenceError extends Error {
  readonly retryable = true;

  constructor(commentId: string, cause: unknown) {
    super(
      `a required marker for comment ${commentId} could not be persisted (${cause instanceof Error ? cause.message : String(cause)}) -- nothing was changed and the comment remains unprocessed for a later retry`,
    );
    this.name = "CommentMarkerPersistenceError";
  }
}

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
  try {
    await kvPut(env, clarificationKey(commentId), "1", { expirationTtl: COMMENT_PROCESSED_TTL_SECONDS });
  } catch (err) {
    throw new CommentMarkerPersistenceError(commentId, err);
  }
}

/**
 * True while a clarification for this comment is outstanding on its Work.
 * The Work's own `state.awaiting` + `pendingProposalDocClarification` remain
 * the authority on what happens next; this marker only keeps the poller from
 * asking the same question again on every pass.
 */
export async function isProposalDocClarificationPending(env: Env, commentId: string): Promise<boolean> {
  return Boolean(await kvGet(env, clarificationKey(commentId)));
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
 * comments again. If that marker itself cannot be persisted (a typed
 * CommentMarkerPersistenceError, e.g. KV write quota), the flow stops before
 * any handler runs: nothing is executed, nothing is claimed, the comment
 * stays unprocessed, and the poll records a retryable
 * `persistence_unavailable` outcome. The one exception is the ambiguous
 * case: no handler ran, so nothing may mark it processed -- the request is
 * carried on its Work as an awaiting clarification (`state.awaiting`,
 * resumed by Martin's Telegram reply) and stays recoverable. A later poll
 * sees that clarification is outstanding and neither re-classifies nor
 * re-asks.
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
    const requested = await requestProposalDocClarificationOnWork(env, binding.workId, {
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
    const result = await handleProposalDocFormatting(env, binding.workId, {
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

  const result = await handleProposalDocComment(env, binding.workId, {
    proposalNumber: binding.proposalNumber,
    version: binding.version,
    text,
    commentId: comment.id,
    documentId: doc.documentId,
  });

  if (result.kind === "revised") {
    // The Runtime NEVER resolves a substantive comment: resolution is
    // Martin's own signal that the change is accepted, and the approval cycle
    // completes only when he resolves it. Auto-resolving here would both
    // forge that signal and, under the new lifecycle, silently close the
    // cycle the comment just opened.
    await replyToComment(
      token,
      doc.documentId,
      comment.id,
      `Change recorded -- ${binding.proposalId} v${result.newVersion} was created from this comment. This Doc (v${binding.version}) is unchanged. I am deliberately leaving this comment OPEN: resolve it yourself once you are happy with the change, because your resolve is what completes the approval cycle for ${binding.proposalId}.`,
    );
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
  const alreadyProcessed = await kvGet(env, `google_comment_processed:${comment.id}`);
  if (alreadyProcessed) return { handled: false, outcome: "already_processed" };

  // Resolution is now a SEPARATE signal from processing. On a Proposal Doc a
  // resolved comment is still processed if its change was never applied
  // (resolving before the change lands must never let an unapplied request
  // count as fulfilled), and its resolution is observed by the cycle
  // afterwards. Only the legacy in-place-edit docs (no Proposal binding) keep
  // the old "resolved means done, skip it" short-circuit.
  if (comment.resolved && !doc.proposal) {
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
    // Marker FIRST (see this branch family's comment below): the reply is
    // best-effort, so a failed reply must never leave the comment to be
    // re-processed on every poll.
    await markProcessed(env, comment.id);
    await replyToCommentChecked(
      env,
      token,
      doc.documentId,
      comment.id,
      "I can only execute edits anchored to specific selected text right now — please select the text you want changed, then comment on that selection.",
      "no_anchor",
    );
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
    // Marker FIRST: the reply is best-effort and is never retried, so the
    // comment must be durably done before it is attempted.
    await markProcessed(env, comment.id);
    await replyToCommentChecked(
      env,
      token,
      doc.documentId,
      comment.id,
      occurrences === 0
        ? "I couldn't find the exact text you selected anymore — it may have already changed. Please re-select and comment again."
        : `The selected text appears ${occurrences} times in the document, so I can't safely target just this one — please select a longer, unique snippet and comment again.`,
      "anchor_not_unique",
    );
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
    // Marker FIRST -- same contract as the other branches in this family.
    await markProcessed(env, comment.id);
    await replyToCommentChecked(
      env,
      token,
      doc.documentId,
      comment.id,
      "I wasn't able to determine a specific replacement from this comment — could you clarify exactly what the selected text should become?",
      "ai_not_understood",
    );
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
  //
  // MARKER BEFORE REPLY. Every branch in this non-Proposal family writes its
  // processed marker first and treats the reply as best-effort: a reply that
  // fails must never leave the comment unmarked, because an unmarked comment
  // is re-processed from scratch on the next poll and would be replied to
  // again -- and a duplicate reply to a human is worse than a missing one.
  // If the reply is then rejected, that is reported to Operations (identifiers
  // and failure category only -- never the comment's or the reply's text) and
  // deliberately NOT retried: the provider's outcome is uncertain, so a retry
  // could duplicate the reply. See replyToCommentChecked.
  await markProcessed(env, comment.id);
  await replyToCommentChecked(
    env,
    token,
    doc.documentId,
    comment.id,
    `I can't apply this edit: comment-triggered in-place edits are not an authorized operation in the governed external-effect boundary, so nothing in this document was changed. This is reported to Martin as a missing authorization decision, not carried out.`,
    "edit_not_authorized",
  );

  await logActivity(env, {
    entry: "Google Doc comment-triggered edit refused",
    type: "Activity",
    area: "Operations",
    activity: `Refused comment ${comment.id}'s edit to document ${doc.documentId}: comment-triggered in-place edits are not an authorized operation, so no batchUpdate was sent`,
    outcome: "Blocked",
  });

  return { handled: true, outcome: "edit_not_authorized", detail: `comment ${comment.id} requested a replacement of "${quoted}" with "${replacementText}" -- refused (no authorization path)` };
}

export type DocCommentDiagnostic = {
  documentId: string;
  commentId: string | null;
  outcome: CommentOutcome | "token_unavailable" | "comments_list_failed" | "comments_fetched" | "persistence_unavailable" | "unhandled_exception" | "approval_cycle_synced" | "skipped_concurrent_pass";
  detail?: string;
};

export interface PollGoogleDocCommentsResult {
  docsChecked: number;
  commentsProcessed: number;
  diagnostics: DocCommentDiagnostic[];
}

/** The outcome of ONE document's complete comment pass -- see processGoogleDocComments. */
export interface ProcessDocCommentsResult {
  documentId: string;
  commentsProcessed: number;
  diagnostics: DocCommentDiagnostic[];
}

/**
 * Runs the COMPLETE comment pass for exactly ONE watched document: acquire the
 * doc's own account token, list every comment (following every nextPageToken --
 * a partial list must never be processed as though it were complete), process
 * each comment through processComment, and -- for a Proposal Doc -- feed the
 * observed resolution state into the approval cycle.
 *
 * This is the single pass both entry points share: the polling safety net
 * (pollGoogleDocComments, which loops it over every watched doc) and the
 * Drive notification receiver (googleDriveWatch.ts, which runs it for the one
 * doc a channel names). Both MUST run the same pass, because
 * syncProposalDocApprovalCycle depends on observing a Proposal Doc's FULL
 * resolved state -- a notification names only that a change happened, never
 * which comments it touched, so it is only ever a signal to re-read everything.
 *
 * Semantics are exactly the poller's per-doc body: a token failure or a
 * comments-list failure is recorded and the doc is skipped (a later run
 * retries it); each comment's own failure is recorded per comment and never
 * aborts the rest; a marker-persistence failure is its own truthful outcome
 * and leaves the comment unprocessed. Nothing here is notification-specific
 * and nothing here inspects how it was triggered.
 */
export async function processGoogleDocComments(env: Env, doc: WatchedGoogleDoc): Promise<ProcessDocCommentsResult> {
  const diagnostics: DocCommentDiagnostic[] = [];
  let commentsProcessed = 0;

  const token = await getValidGoogleAccessToken(env, doc.accountIdentifier);
  if (!token) {
    diagnostics.push({ documentId: doc.documentId, commentId: null, outcome: "token_unavailable" });
    return { documentId: doc.documentId, commentsProcessed, diagnostics };
  }

  let comments: DriveComment[];
  try {
    comments = await fetchComments(token, doc.documentId);
  } catch (err) {
    console.error(`processGoogleDocComments: failed to list comments for ${doc.documentId}`, err);
    diagnostics.push({
      documentId: doc.documentId,
      commentId: null,
      outcome: "comments_list_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { documentId: doc.documentId, commentsProcessed, diagnostics };
  }

  diagnostics.push({ documentId: doc.documentId, commentId: null, outcome: "comments_fetched", detail: `${comments.length} comment(s) found` });

  for (const comment of comments) {
    try {
      const result = await processComment(env, doc, comment, token);
      diagnostics.push({ documentId: doc.documentId, commentId: comment.id, outcome: result.outcome, detail: result.detail });
      if (result.handled) commentsProcessed++;
    } catch (err) {
      if (err instanceof CommentMarkerPersistenceError) {
        // The marker this comment needed could not be written. Because
        // every marker is written BEFORE the effect it guards, nothing
        // was executed and nothing was claimed; the comment stays
        // unprocessed and a later run retries it. Recorded as its own
        // truthful outcome instead of a generic handler failure.
        console.error(`processGoogleDocComments: persistence unavailable for comment ${comment.id} on ${doc.documentId}`, err);
        diagnostics.push({
          documentId: doc.documentId,
          commentId: comment.id,
          outcome: "persistence_unavailable",
          detail: err.message,
        });
        continue;
      }
      console.error(`processGoogleDocComments: error processing comment ${comment.id} on ${doc.documentId}`, err);
      // The original failure evidence is recorded FIRST, so nothing that
      // follows can replace it; only then is the Proposal thread told the
      // truth about the escape -- an interruption whose outcome could not be
      // confirmed (best-effort, independently guarded, never a retry).
      diagnostics.push({
        documentId: doc.documentId,
        commentId: comment.id,
        outcome: "unhandled_exception",
        detail: err instanceof Error ? err.message : String(err),
      });
      await answerEscapedProposalComment(env, doc, comment, token);
    }
  }

  // A Proposal Doc's approval cycle is driven by the resolution state
  // observed here, fed back into the Work so the cycle can be evaluated
  // (evaluateProposalApprovalCycle). This runs on EVERY pass over a Proposal
  // Doc -- including ones where no comment needed processing -- because a
  // Martin resolve that happened between passes is exactly the event that
  // can complete a cycle, and it may arrive with nothing new to apply.
  // Resolution is observed independently of processing, so a resolved
  // comment is never mistaken for an applied one. This is why the notification
  // path re-reads the COMPLETE comment list rather than trusting the
  // notification for detail: the cycle's input is the full observed state.
  if (doc.proposal) {
    try {
      const observations = comments.map((c) => ({
        commentId: c.id,
        resolved: c.resolved === true,
        modifiedTime: c.modifiedTime,
      }));
      const sync = await syncProposalDocApprovalCycle(env, doc.proposal.workId, {
        documentId: doc.documentId,
        observations,
      });
      diagnostics.push({
        documentId: doc.documentId,
        commentId: null,
        outcome: "approval_cycle_synced",
        detail: sync.reasons?.length ? `${sync.kind}: ${sync.reasons.join("; ")}` : sync.kind,
      });
    } catch (err) {
      console.error(`processGoogleDocComments: approval-cycle sync failed for ${doc.documentId}`, err);
      diagnostics.push({
        documentId: doc.documentId,
        commentId: null,
        outcome: "unhandled_exception",
        detail: `approval-cycle sync: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { documentId: doc.documentId, commentsProcessed, diagnostics };
}

/**
 * The poller's per-doc step: processGoogleDocComments under the SAME per-Doc
 * lock (DriveDocLock) the notification receiver takes, so the two entry points
 * can never run overlapping passes on one document.
 *
 * Deliberate differences from the notification path, both in service of the
 * poller being the safety net:
 *  - No cooldown (0). A poll skips a doc ONLY while another pass on it is
 *    genuinely in flight -- that pass is re-reading the complete comment list
 *    anyway, and the next poll covers anything it missed. A recent-but-finished
 *    pass never causes a poll to skip.
 *  - An unbound or unreachable lock does NOT stop the poll. The notification
 *    path refuses to run without the lock, so when the lock is unavailable no
 *    notification pass can be holding it; refusing here too would silently
 *    disable the safety net exactly when the newer path is impaired.
 *
 * The claim is released in `finally` with its own token, and every claim also
 * expires on DRIVE_DOC_LOCK_TTL_MS, so a failed or hung poll pass can never
 * leave a permanent lock.
 */
export async function processGoogleDocCommentsForPoll(env: Env, doc: WatchedGoogleDoc): Promise<ProcessDocCommentsResult> {
  const stub = driveDocLockStub(env, doc.documentId);
  if (!stub) return processGoogleDocComments(env, doc);

  let claim: { token: string } | null;
  try {
    claim = await stub.tryAcquire(DRIVE_DOC_LOCK_TTL_MS, 0);
  } catch (err) {
    console.error(`pollGoogleDocComments: per-Doc lock unavailable for ${doc.documentId}; polling proceeds (safety net)`, err);
    return processGoogleDocComments(env, doc);
  }

  if (!claim) {
    return {
      documentId: doc.documentId,
      commentsProcessed: 0,
      diagnostics: [{ documentId: doc.documentId, commentId: null, outcome: "skipped_concurrent_pass", detail: "another pass on this document is in flight; the next poll re-checks it" }],
    };
  }

  try {
    return await processGoogleDocComments(env, doc);
  } finally {
    await stub.release(claim.token).catch((err: unknown) => console.error(`pollGoogleDocComments: could not release the per-Doc lock for ${doc.documentId}`, err));
  }
}

/**
 * Polls every doc this system has created (see registerWatchedGoogleDoc)
 * for new, unresolved comments from the doc's own authorized account, and
 * applies any that resolve to a specific, unambiguous text replacement.
 * Meant to be hit every 30-60s by an external scheduler (cron-job.org),
 * same pattern as /admin/run-finance-discovery and
 * /admin/run-lead-discovery.
 *
 * This is the SAFETY NET, deliberately kept enabled alongside the Drive
 * files.watch notification path (googleDriveWatch.ts): notifications are a
 * promptness optimization, never the authority. They can be lost, delayed,
 * duplicated, or arrive without useful detail, so polling remains what
 * guarantees a doc is eventually fully processed. Each doc is processed by
 * the SAME single-document pass the notification handler runs --
 * processGoogleDocComments -- so the two paths cannot drift in what a pass
 * means.
 */
export async function pollGoogleDocComments(env: Env): Promise<PollGoogleDocCommentsResult> {
  // Records that the external scheduler actually fired, independent of
  // whether there was anything to do -- read back via
  // /admin/last-google-doc-comment-poll to verify cron-job.org is really
  // hitting this on schedule (Cloudflare's basic Workers analytics doesn't
  // break requests down by path, so there's no other way to tell this
  // endpoint's traffic apart from any other route's). Diagnostics ONLY:
  // best-effort, so a failed write (e.g. the per-day KV write quota) is
  // logged and never blocks the poll itself from starting.
  await kvPutHeartbeat(env, "last_google_doc_comment_poll_run", POLL_HEARTBEAT_MIN_INTERVAL_MS).catch((err) =>
    console.error("pollGoogleDocComments: could not record the diagnostics timestamp (polling continues)", err),
  );

  // Section 5B reconciliation heartbeat: this poll is the runtime's most
  // reliable de-facto schedule (cron-job.org hits it every few minutes, and
  // the native Cron Trigger also runs the sweep from scheduled()), so it is
  // where fallback rows accumulated during a KV quota window get swept back
  // into KV once it has quota again. Throttled internally (a no-op for most
  // calls) and never allowed to block or fail the poll itself.
  await maybeSweepKvFallback(env).catch((err) => console.error("pollGoogleDocComments: fallback sweep failed (polling continues)", err));

  const docs = await listWatchedGoogleDocs(env);
  let commentsProcessed = 0;
  const diagnostics: DocCommentDiagnostic[] = [];

  for (const doc of docs) {
    // The same single-document pass the Drive notification handler runs,
    // under the same per-Doc lock, so a notification pass and a poll pass can
    // never overlap on one document.
    const result = await processGoogleDocCommentsForPoll(env, doc);
    commentsProcessed += result.commentsProcessed;
    diagnostics.push(...result.diagnostics);
  }

  return { docsChecked: docs.length, commentsProcessed, diagnostics };
}
