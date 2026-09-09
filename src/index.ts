import type { Env } from "./types";
import type { TelegramUpdate, InlineButton } from "./telegram";
import { answerCallbackQuery, sendMessage } from "./telegram";
import { getActiveWorkId, getSessionStub, routeIncomingText, setActiveWorkId } from "./router";
import { plainText, queryDataSource } from "./notion";
import type { SessionSummary } from "./types";

export { WorkSession } from "./session";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
      }
      const update = (await request.json()) as TelegramUpdate;
      await handleUpdate(env, update);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await checkStaleHandoffs(env);
  },
};

async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.message) {
    const chatId = update.message.chat.id;
    const fromId = update.message.from?.id;
    if (String(fromId) !== env.MARTIN_TELEGRAM_USER_ID) {
      await sendMessage(env, chatId, "This bot is private.");
      return;
    }
    const text = update.message.text ?? "";
    if (text === "/start") {
      await sendMessage(env, chatId, "ENIG agent runtime online. Send a commercial enquiry to start, or /sessions to see open work items.");
      return;
    }
    if (text === "/sessions") {
      await listSessions(env, chatId);
      return;
    }
    if (text.startsWith("/")) {
      await sendMessage(env, chatId, "Unknown command. Try /sessions.");
      return;
    }
    await routeIncomingText(env, chatId, text);
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    if (String(cq.from.id) !== env.MARTIN_TELEGRAM_USER_ID || !chatId) {
      await answerCallbackQuery(env, cq.id, "Not authorized.");
      return;
    }
    const data = cq.data ?? "";
    const [action, workId, value] = data.split(":");
    await answerCallbackQuery(env, cq.id);

    if (action === "switch") {
      await setActiveWorkId(env, chatId, workId);
      await sendMessage(env, chatId, `Switched active context to work item ${workId}.`);
      return;
    }

    const stub = getSessionStub(env, workId);
    const state = await stub.getState();
    if (!state) {
      await sendMessage(env, chatId, "That work item no longer exists.");
      return;
    }
    await setActiveWorkId(env, chatId, workId);
    await stub.handleCallback(action, value);
    return;
  }
}

async function listSessions(env: Env, chatId: number): Promise<void> {
  const raw = await env.STATE_KV.get("sessions_index");
  const index: SessionSummary[] = raw ? JSON.parse(raw) : [];
  const open = index.filter((s) => s.stage !== "complete" && s.stage !== "closed_not_qualified");
  if (open.length === 0) {
    await sendMessage(env, chatId, "No open work items. Send a new enquiry to start one.");
    return;
  }
  const activeId = await getActiveWorkId(env, chatId);
  const buttons: InlineButton[][] = open.map((s) => [
    {
      text: `${s.workId === activeId ? "• " : ""}${s.unit}/${s.hat} — ${s.label} (${s.stage})`,
      callback_data: `switch:${s.workId}:`,
    },
  ]);
  await sendMessage(env, chatId, "Open work items:", buttons);
}

async function checkStaleHandoffs(env: Env): Promise<void> {
  const results = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    or: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "Status", select: { equals: "Held" } },
    ],
  });
  if (results.length === 0) return;
  const lines = results.map((p) => {
    const status = plainText(p.properties.Status);
    const toUnit = plainText(p.properties["To Unit"]);
    const name = plainText(p.properties.Handoff);
    return `• [${status}] ${name} → ${toUnit}`;
  });
  await sendMessage(
    env,
    Number(env.MARTIN_TELEGRAM_USER_ID),
    `*Handoff check-in* — ${results.length} item(s) not Closed:\n\n${lines.join("\n")}`,
  );
}
