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
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_thread_id?: number };
    data?: string;
  };
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
