import type { Env } from "./types";

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

export type MessageStream = "conversation" | "operations";

/**
 * Returns the target chatId/threadId for Martin's 1:1 Telegram DM (Conversation Stream).
 */
export function getConversationTarget(env: Env): { chatId: number; threadId?: number } {
  return {
    chatId: Number(env.MARTIN_TELEGRAM_USER_ID),
    threadId: undefined,
  };
}

/**
 * Returns the target chatId/threadId for the Operations Stream
 * (Operations topic in ENIG HQ Supergroup, falling back to Martin's DM if group chat is unconfigured).
 */
export function getOperationsTarget(env: Env): { chatId: number; threadId?: number } {
  if (env.TELEGRAM_GROUP_CHAT_ID) {
    const groupChatId = Number(env.TELEGRAM_GROUP_CHAT_ID);
    let operationsThreadId = 14;
    if (env.UNIT_TOPIC_MAP) {
      try {
        const map = JSON.parse(env.UNIT_TOPIC_MAP);
        if (map["Operations"] !== undefined) operationsThreadId = map["Operations"];
      } catch {
        // Fall back to default
      }
    }
    return { chatId: groupChatId, threadId: operationsThreadId };
  }
  return getConversationTarget(env);
}

/** Sends an operational telemetry/digest message directly to the Operations Stream. */
export async function sendOperationsMessage(
  env: Env,
  text: string,
  buttons?: InlineButton[][],
): Promise<number | undefined> {
  const target = getOperationsTarget(env);
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
  return sendHatMessage(
    env,
    { ...target, chatId: opsTarget.chatId, threadId: opsTarget.threadId },
    text,
    buttons,
  );
}

/** Sends a user-facing decision prompt or conversational message directly to Martin's 1:1 DM (Conversation Stream). */
export async function sendConversationHatMessage(
  env: Env,
  target: HatMessageTarget,
  text: string,
  buttons?: InlineButton[][],
): Promise<number | undefined> {
  const convTarget = getConversationTarget(env);
  return sendHatMessage(
    env,
    { ...target, chatId: convTarget.chatId, threadId: convTarget.threadId },
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
  const chunks = splitText(text);
  let lastMessageId: number | undefined;
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
    if (!res.ok) {
      res = await call(env, "sendMessage", { ...payload, parse_mode: undefined });
      if (!res.ok) {
        console.error("telegram sendMessage failed", await res.text());
        continue;
      }
    }
    lastMessageId = await extractMessageId(res);
  }
  return lastMessageId;
}

/**
 * Edits a previously sent message's text in place -- used for
 * live-updating progress messages rather than spamming a new message
 * per stage. Best-effort: fails silently (logged, not thrown) since a
 * failed edit (e.g. the message is too old, or was deleted) should never
 * block the pipeline it's reporting progress on.
 */
export async function editMessageText(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  const res = await call(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
  });
  if (!res.ok) {
    console.error("telegram editMessageText failed", await res.text());
  }
}

/** Shape every WorkState already satisfies -- chatId/threadId/hat -- so callers can pass state directly. */
export interface HatMessageTarget {
  chatId: number;
  threadId?: number;
  hat: string;
  workId?: string;
}

function withHatLabel(target: HatMessageTarget, text: string): string {
  return `Hat: ${target.hat}.\n\n${text}`;
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
  const msgId = await sendMessage(env, target.chatId, withHatLabel(target, text), buttons, target.threadId);
  if (msgId && target.workId && env?.STATE_KV) {
    await env.STATE_KV.put(`reply_msg:${msgId}`, target.workId, { expirationTtl: 60 * 60 * 24 * 7 }).catch((err) =>
      console.error("sendHatMessage: failed to put reply_msg in KV", err),
    );
  }
  return msgId;
}

/** Like editMessageText, but re-applies the same "Hat: <name>." label sendHatMessage used, so an edited bubble doesn't drop it. */
export async function editHatMessage(env: Env, target: HatMessageTarget, messageId: number, text: string): Promise<void> {
  return editMessageText(env, target.chatId, messageId, withHatLabel(target, text));
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
