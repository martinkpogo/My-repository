import test from "node:test";
import assert from "node:assert/strict";
import { TELEGRAM_SECRET_HEADER, isTelegramWebhookAuthorized } from "./telegramWebhookAuth";

const SECRET = "telegram-secret-value";
const req = (headers: Record<string, string> = {}) =>
  new Request("https://w.example/telegram/webhook", { method: "POST", headers });

test("authorized only by the matching secret-token header", () => {
  assert.equal(isTelegramWebhookAuthorized(req({ [TELEGRAM_SECRET_HEADER]: SECRET }), { TELEGRAM_WEBHOOK_SECRET: SECRET }), true);
});

test("a missing, empty, wrong or prefix header is refused", () => {
  const env = { TELEGRAM_WEBHOOK_SECRET: SECRET };
  assert.equal(isTelegramWebhookAuthorized(req(), env), false);
  assert.equal(isTelegramWebhookAuthorized(req({ [TELEGRAM_SECRET_HEADER]: "" }), env), false);
  assert.equal(isTelegramWebhookAuthorized(req({ [TELEGRAM_SECRET_HEADER]: "nope" }), env), false);
  assert.equal(isTelegramWebhookAuthorized(req({ [TELEGRAM_SECRET_HEADER]: SECRET.slice(0, -1) }), env), false);
});

test("fails closed when no secret is configured, whatever the request carries", () => {
  for (const secret of [undefined, ""]) {
    const env = { TELEGRAM_WEBHOOK_SECRET: secret };
    assert.equal(isTelegramWebhookAuthorized(req(), env), false);
    assert.equal(isTelegramWebhookAuthorized(req({ [TELEGRAM_SECRET_HEADER]: "" }), env), false);
    assert.equal(isTelegramWebhookAuthorized(req({ [TELEGRAM_SECRET_HEADER]: "undefined" }), env), false);
  }
});
