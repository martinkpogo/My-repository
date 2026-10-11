import type { Env } from "./types";
import { logActivity } from "./log";
import { kvPut } from "./kvStore";

const API = "https://api.telegram.org/bot";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      text?: string;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_thread_id?: number };
    data?: string;
  };
}

export type MessageStream = "workspace" | "operations";

export interface StreamTarget {
  chatId: number;
  threadId: number;
}

/**
 * Returns the target chatId/threadId for the Workspace Stream
 * (Workspace topic in ENIG HQ Supergroup). Fails closed (returns null) if unconfigured.
 */
export function getWorkspaceTarget(env: Env): StreamTarget | null {
  if (!env.TELEGRAM_GROUP_CHAT_ID) return null;
  const chatId = Number(env.TELEGRAM_GROUP_CHAT_ID);
  if (!Number.isFinite(chatId)) return null;

  let threadId: number | undefined;
  if (env.WORKSPACE_TOPIC_ID) {
    threadId = Number(env.WORKSPACE_TOPIC_ID);
  }

  if (threadId === undefined || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
}

/**
 * Returns the target chatId/threadId for the Operations Stream
 * (Operations topic in ENIG HQ Supergroup). Fails closed (returns null) if unconfigured.
 */
export function getOperationsTarget(env: Env): StreamTarget | null {
  if (!env.TELEGRAM_GROUP_CHAT_ID) return null;
  const chatId = Number(env.TELEGRAM_GROUP_CHAT_ID);
  if (!Number.isFinite(chatId)) return null;

  let threadId: number | undefined;
  if (env.OPERATIONS_TOPIC_ID) {
    threadId = Number(env.OPERATIONS_TOPIC_ID);
  }

  if (threadId === undefined || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
}

/** Sends an operational telemetry/digest message directly to the Operations Stream. */
export async function sendOperationsMessage(
  env: Env,
  text: string,
  buttons?: InlineButton[][],
): Promise<number | undefined> {
  const target = getOperationsTarget(env);
  if (!target) {
    console.error("sendOperationsMessage: Operations stream unconfigured (TELEGRAM_GROUP_CHAT_ID or OPERATIONS_TOPIC_ID missing)");
    await logActivity(env, {
      entry: "Operations stream dispatch blocked [Stream Target Unconfigured]",
      type: "Blocker",
      area: "Operations",
      decisionRationale: "TELEGRAM_GROUP_CHAT_ID or OPERATIONS_TOPIC_ID missing from environment bindings. Refusing to send operational message.",
      outcome: "Blocked",
    }).catch(() => {});
    return undefined;
  }
  return sendMessage(env, target.chatId, text, buttons, target.threadId);
}

/** Sends a Hat-labeled operational message directly to the Operations Stream. */
export async function sendOperationsHatMessage(
  env: Env,
  target: HatMessageTarget,
  text: string,
  buttons?: InlineButton[][],
): Promise<number | undefined> {
  const opsTarget = getOperationsTarget(env);
  if (!opsTarget) {
    console.error(`sendOperationsHatMessage: Operations stream unconfigured${target.hat ? ` for ${target.hat}` : ""}`);
    await logActivity(env, {
      entry: `Operations stream dispatch blocked${target.hat ? ` for ${target.hat}` : ""} [Stream Target Unconfigured]`,
      type: "Blocker",
      area: "Operations",
      decisionRationale: "TELEGRAM_GROUP_CHAT_ID or OPERATIONS_TOPIC_ID missing from environment bindings. Refusing to send operational Hat message.",
      outcome: "Blocked",
    }).catch(() => {});
    return undefined;
  }
  return sendHatMessage(
    env,
    { ...target, chatId: opsTarget.chatId, threadId: opsTarget.threadId },
    text,
    buttons,
  );
}

/** Sends a user-facing decision prompt or conversational message directly to the Workspace Stream. */
export async function sendWorkspaceHatMessage(
  env: Env,
  target: HatMessageTarget,
  text: string,
  buttons?: InlineButton[][],
): Promise<number | undefined> {
  return (await sendWorkspaceHatMessageWithOutcome(env, target, text, buttons)).messageId;
}

/**
 * Structured-outcome form of sendWorkspaceHatMessage for callers that must
 * distinguish confirmed delivery from total failure (the Registry smoke
 * picker records whether the picker was actually presented). Same target
 * override, same Hat label, same reply_msg bookkeeping, same retry
 * semantics -- only the return shape differs; the message-id contract of
 * sendWorkspaceHatMessage is untouched.
 */
export async function sendWorkspaceHatMessageWithOutcome(
  env: Env,
  target: HatMessageTarget,
  text: string,
  buttons?: InlineButton[][],
): Promise<TelegramSendResult> {
  const workspaceTarget = getWorkspaceTarget(env);
  if (!workspaceTarget) {
    console.error(`sendWorkspaceHatMessage: Workspace stream unconfigured${target.hat ? ` for ${target.hat}` : ""}`);
    await logActivity(env, {
      entry: `Workspace stream dispatch blocked${target.hat ? ` for ${target.hat}` : ""} [Stream Target Unconfigured]`,
      type: "Blocker",
      area: target.hat,
      decisionRationale: "TELEGRAM_GROUP_CHAT_ID or WORKSPACE_TOPIC_ID missing from environment bindings. Refusing to send workspace message.",
      outcome: "Blocked",
    }).catch(() => {});
    return { delivered: false, attempts: [], unconfiguredStream: true };
  }
  return sendHatMessageCore(
    env,
    { ...target, chatId: workspaceTarget.chatId, threadId: workspaceTarget.threadId },
    text,
    buttons,
  );
}

function call(env: Env, method: string, payload: Record<string, unknown>) {
  return fetch(`${API}${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const TELEGRAM_MAX_LEN = 4000;

/** Longest provider-error detail kept anywhere (logging or structured results) -- diagnostics, never an echo channel. */
const TELEGRAM_ERROR_MAX_CHARS = 200;

/** One HTTP attempt made for a single chunk of a send. */
export interface TelegramSendAttempt {
  /** Which parse mode this attempt carried: the first attempt, or the plain-text retry after it failed. */
  parseMode: "Markdown" | "plain";
  ok: boolean;
  httpStatus?: number;
  /** Redacted, bounded provider error detail; present only when ok is false. */
  error?: string;
  /** 0-based index of the text chunk this attempt belongs to. */
  chunk: number;
}

/** Structured outcome of a send: what Telegram actually accepted, per attempt. */
export interface TelegramSendResult {
  /**
   * True only when EVERY chunk was accepted by Telegram (the button-bearing
   * last chunk included) -- i.e. the message is fully usable as composed.
   * A failed Markdown attempt rescued by the plain-text retry IS delivered;
   * only total rejection of a chunk is a delivery failure.
   */
  delivered: boolean;
  /** Message id of the last delivered chunk, when any chunk was delivered. */
  messageId?: number;
  /** Every attempt, in send order. */
  attempts: TelegramSendAttempt[];
  /** True when no attempt was made because the stream target could not be resolved. */
  unconfiguredStream?: boolean;
}

/**
 * Bounds and redacts provider error text before it is logged or persisted.
 * Telegram error bodies do not echo our message content, but a rejected
 * fetch (or an unusually verbose proxy error) can carry the bot-token URL --
 * so bot-token and Authorization-shaped material is stripped, and the text
 * is capped so diagnostics can never become an echo channel.
 */
export function redactTelegramProviderError(text: string): string {
  const redacted = text
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{10,}/g, "bot[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/g, "Bearer [redacted]")
    .replace(/authorization["']?\s*[:=]\s*["']?[^\s"',;]+/gi, "authorization: [redacted]");
  return redacted.length > TELEGRAM_ERROR_MAX_CHARS ? `${redacted.slice(0, TELEGRAM_ERROR_MAX_CHARS)}…` : redacted;
}

async function attemptOf(res: Response, parseMode: TelegramSendAttempt["parseMode"], chunk: number): Promise<TelegramSendAttempt> {
  if (res.ok) return { parseMode, ok: true, httpStatus: res.status, chunk };
  return { parseMode, ok: false, httpStatus: res.status, error: redactTelegramProviderError(await res.text()), chunk };
}

/**
 * The single send implementation: chunks the text, tries each chunk with
 * Markdown then (still) retries it plain text, and records every attempt's
 * outcome. Both `sendMessage` (message-id contract, every current caller)
 * and the structured-outcome callers go through exactly this path -- there
 * is no second send implementation. Fetch rejections propagate exactly as
 * before; provider rejections are recorded, never thrown.
 */
async function sendMessageCore(
  env: Env,
  chatId: number,
  text: string,
  buttons?: InlineButton[][],
  threadId?: number,
): Promise<TelegramSendResult> {
  const chunks = splitText(text);
  const attempts: TelegramSendAttempt[] = [];
  let lastMessageId: number | undefined;
  let delivered = true;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: "Markdown",
    };
    if (threadId !== undefined) payload.message_thread_id = threadId;
    if (isLast && buttons) {
      payload.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data }))) };
    }
    let res = await call(env, "sendMessage", payload);
    attempts.push(await attemptOf(res, "Markdown", i));
    if (!res.ok) {
      res = await call(env, "sendMessage", { ...payload, parse_mode: undefined });
      const retry = await attemptOf(res, "plain", i);
      attempts.push(retry);
      if (!res.ok) {
        console.error("telegram sendMessage failed", `${retry.httpStatus ?? "no status"} ${retry.error ?? ""}`.trim());
        delivered = false;
        continue;
      }
    }
    lastMessageId = await extractMessageId(res);
  }
  return { delivered, messageId: lastMessageId, attempts };
}

/**
 * Structured-outcome form of sendMessage for callers that must distinguish
 * confirmed delivery from total failure (e.g. the Registry smoke picker,
 * whose "picker presented" record would otherwise be a lie when Telegram
 * rejects the send). Same attempts, same order, same retry semantics as
 * sendMessage -- only the return shape differs.
 */
export async function sendMessageWithOutcome(
  env: Env,
  chatId: number,
  text: string,
  buttons?: InlineButton[][],
  threadId?: number,
): Promise<TelegramSendResult> {
  return sendMessageCore(env, chatId, text, buttons, threadId);
}

/**
 * Returns the sent message's message_id (of the last chunk, if the text
 * was split) so a caller can later edit it in place via editMessageText
 * -- e.g. a single "researching this now" progress message updated at
 * each pipeline stage instead of a new message per stage. Returns
 * undefined if every send attempt failed; callers that don't need the
 * id can simply ignore the return value, as before.
 */
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  buttons?: InlineButton[][],
  threadId?: number,
): Promise<number | undefined> {
  return (await sendMessageCore(env, chatId, text, buttons, threadId)).messageId;
}

/**
 * Edits a previously sent message's text in place -- used for
 * live-updating progress messages rather than spamming a new message
 * per stage. Best-effort: fails silently (logged, not thrown) since a
 * failed edit (e.g. the message is too old, or was deleted) should never
 * block the pipeline it's reporting progress on.
 *
 * Falls back to plain text when the Markdown edit is rejected, exactly as
 * sendMessage does: text carrying an identifier such as `business_strategy`
 * has an unpaired `_`, which Telegram refuses as Markdown ("can't parse
 * entities") -- confirmed live on Strategy's Skill progress line.
 */
export async function editMessageText(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  let res = await call(env, "editMessageText", payload);
  if (!res.ok) {
    res = await call(env, "editMessageText", { ...payload, parse_mode: undefined });
    if (!res.ok) {
      console.error("telegram editMessageText failed", await res.text());
    }
  }
}

/** Shape every WorkState already satisfies -- chatId/threadId/hat -- so callers can pass state directly. */
export interface HatMessageTarget {
  chatId: number;
  threadId?: number;
  hat?: string;
  workId?: string;
}

function withHatLabel(target: HatMessageTarget, text: string): string {
  return target.hat ? `Hat: ${target.hat}.\n\n${text}` : text;
}

/**
 * Like sendMessage, but labels the chat bubble with which Hat is
 * speaking -- "Hat: <name>." on its own line before the content -- so
 * it's visually clear which Hat produced a given message, especially
 * once a work item has moved through more than one Hat (e.g. a Handoff
 * pickup). Prefer this over sendMessage directly for any message
 * originating from Hat logic.
 */
export async function sendHatMessage(env: Env, target: HatMessageTarget, text: string, buttons?: InlineButton[][]): Promise<number | undefined> {
  return (await sendHatMessageCore(env, target, text, buttons)).messageId;
}

/** The single Hat-labelled send path: label, send, reply_msg bookkeeping. Both the message-id and structured-outcome forms go through exactly this. */
async function sendHatMessageCore(
  env: Env,
  target: HatMessageTarget,
  text: string,
  buttons?: InlineButton[][],
): Promise<TelegramSendResult> {
  const result = await sendMessageCore(env, target.chatId, withHatLabel(target, text), buttons, target.threadId);
  if (result.messageId && target.workId && env?.STATE_KV) {
    await kvPut(env, `reply_msg:${result.messageId}`, target.workId, { expirationTtl: 60 * 60 * 24 * 7 }).catch((err) =>
      console.error("sendHatMessage: failed to put reply_msg in KV", err),
    );
  }
  return result;
}

/**
 * Shows "<bot> is typing..." in the Workspace topic. Purely cosmetic:
 * unconfigured streams and Telegram failures are logged, never thrown, so
 * an indicator can never block the work it accompanies.
 */
export async function sendWorkspaceTypingAction(env: Env): Promise<void> {
  const target = getWorkspaceTarget(env);
  if (!target) return;
  try {
    const res = await call(env, "sendChatAction", { chat_id: target.chatId, message_thread_id: target.threadId, action: "typing" });
    if (!res.ok) console.error("telegram sendChatAction failed", await res.text());
  } catch (err) {
    console.error("telegram sendChatAction failed", err);
  }
}

/**
 * Shows the typing indicator once as `work` starts, then runs it. Never
 * changes what `work` returns or throws.
 *
 * Deliberately ONE signal, not a refresh loop: every Telegram call is a
 * Worker subrequest, and a single invocation (a whole Handoff pickup runs in
 * one Durable Object alarm) has a hard subrequest budget shared with every
 * Notion and AI-provider call. Re-sending every few seconds exhausted it in
 * production (2026-10-08, HO-86) and failed the pickup.
 */
export async function withWorkspaceTypingIndicator<T>(env: Env, work: () => Promise<T>): Promise<T> {
  await sendWorkspaceTypingAction(env);
  return work();
}

/** Like editMessageText, but re-applies the same "Hat: <name>." label sendHatMessage used, so an edited bubble doesn't drop it. */
export async function editHatMessage(env: Env, target: HatMessageTarget, messageId: number, text: string): Promise<void> {
  return editMessageText(env, target.chatId, messageId, withHatLabel(target, text));
}

/**
 * Like editHatMessage, but targets the Workspace Stream's own chat --
 * the correct counterpart to sendWorkspaceHatMessage, which overrides
 * target.chatId/threadId to the configured Workspace stream rather than
 * using the caller's own. A caller that instead used plain editHatMessage
 * (target.chatId) to edit a message sendWorkspaceHatMessage sent would
 * edit the WRONG chat whenever target.chatId differs from the Workspace
 * stream's chat -- confirmed live: a Strategy work item picked up via
 * a Unit's own "no prior session" discovery fallback (checkHandoffs.ts)
 * gets chatId set to Martin's DM, while its progress ack was actually
 * sent to the Workspace group via sendWorkspaceHatMessage -- every
 * subsequent progress edit then failed with Telegram's "message to edit
 * not found" (wrong chat_id), silently (editMessageText only logs, never
 * throws), so the mismatch was invisible until Worker logs were checked
 * directly. Fails closed (logs, does not throw) exactly like
 * sendWorkspaceHatMessage if the stream is unconfigured -- a missing
 * progress update must never block the pipeline it's reporting on.
 */
export async function editWorkspaceHatMessage(env: Env, target: HatMessageTarget, messageId: number, text: string): Promise<void> {
  const workspaceTarget = getWorkspaceTarget(env);
  if (!workspaceTarget) {
    console.error(`editWorkspaceHatMessage: Workspace stream unconfigured${target.hat ? ` for ${target.hat}` : ""}`);
    return;
  }
  return editMessageText(env, workspaceTarget.chatId, messageId, withHatLabel(target, text));
}

async function extractMessageId(res: Response): Promise<number | undefined> {
  try {
    const data = (await res.json()) as { result?: { message_id?: number } };
    return data.result?.message_id;
  } catch {
    return undefined;
  }
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await call(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

export async function setWebhook(env: Env, webhookUrl: string): Promise<Response> {
  return call(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  });
}

function splitText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, TELEGRAM_MAX_LEN));
    remaining = remaining.slice(TELEGRAM_MAX_LEN);
  }
  return chunks;
}
