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

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  buttons?: InlineButton[][],
  threadId?: number,
): Promise<void> {
  const chunks = splitText(text);
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
    const res = await call(env, "sendMessage", payload);
    if (!res.ok) {
      const plain = await call(env, "sendMessage", { ...payload, parse_mode: undefined });
      if (!plain.ok) console.error("telegram sendMessage failed", await plain.text());
    }
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
