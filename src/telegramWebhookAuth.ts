import type { Env } from "./types";
import { constantTimeEqual } from "./adminAuth";

export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * Authenticates an inbound Telegram webhook delivery. Fail closed: no
 * TELEGRAM_WEBHOOK_SECRET configured, or no/wrong header, is never authorized
 * (an unset secret used to skip verification entirely). `setWebhook`
 * registers the secret with Telegram, so every genuine delivery carries it.
 */
export function isTelegramWebhookAuthorized(request: Request, env: Pick<Env, "TELEGRAM_WEBHOOK_SECRET">): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  const presented = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!presented) return false;
  return constantTimeEqual(presented, expected);
}
