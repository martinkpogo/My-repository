import type { Env } from "./types";
import type { TelegramUpdate, InlineButton } from "./telegram";
import { answerCallbackQuery, sendMessage, setWebhook } from "./telegram";
import { getActiveWorkId, getSessionStub, routeIncomingText, setActiveWorkId, threadIdForUnit } from "./router";
import { plainText, queryDataSource } from "./notion";
import type { SessionSummary } from "./types";
import { verifyReadAiSignature, formatCallNotesFromPayload } from "./readai";
import type { ReadAiPayload } from "./readai";
import {
  buildAuthorizeUrl,
  codeChallengeFromVerifier,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateState,
  getMeeting,
  isAuthorized,
  listRecentMeetings,
} from "./readaiOAuth";

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

    if (url.pathname === "/readai/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const valid = await verifyReadAiSignature(env, rawBody, request.headers.get("X-Read-Signature"));
      if (!valid) return new Response("forbidden", { status: 403 });

      const payload = JSON.parse(rawBody) as ReadAiPayload;
      if (payload.trigger !== "meeting_end") return new Response("ok");

      if (payload.request_id) {
        const seenKey = `readai_seen:${payload.request_id}`;
        if (await env.STATE_KV.get(seenKey)) return new Response("ok");
        await env.STATE_KV.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 * 7 });
      }

      await handleReadAiMeetingEnd(env, payload);
      return new Response("ok");
    }

    // Fed by a Gmail-polling Apps Script (or any other email source) —
    // treats the email body as a new incoming enquiry, exactly as if it had
    // been typed into the SM&BD topic. Shared-secret gated.
    if (url.pathname === "/email/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Email-Webhook-Secret");
      if (!env.EMAIL_WEBHOOK_SECRET || secret !== env.EMAIL_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as { from?: string; subject?: string; text?: string };
      if (!body.text) return new Response("Missing text", { status: 400 });

      const chatId = env.TELEGRAM_GROUP_CHAT_ID ? Number(env.TELEGRAM_GROUP_CHAT_ID) : Number(env.MARTIN_TELEGRAM_USER_ID);
      const threadId = threadIdForUnit(env, "SM&BD");
      const enquiryText = `Email enquiry${body.from ? ` from ${body.from}` : ""}${body.subject ? ` — "${body.subject}"` : ""}:\n\n${body.text}`;
      await routeIncomingText(env, chatId, enquiryText, threadId, { forceNewEnquiry: true });
      return new Response("ok");
    }

    // One-time bootstrap: starts the Read.ai OAuth authorization flow. Gated
    // on the webhook secret so only you can trigger it. PKCE verifier and
    // state are stashed in KV for the callback to consume.
    if (url.pathname === "/oauth/readai/start" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const state = generateState();
      const verifier = generateCodeVerifier();
      const challenge = await codeChallengeFromVerifier(verifier);
      await env.STATE_KV.put(`readai_oauth_state:${state}`, verifier, { expirationTtl: 1800 });
      const redirectUri = `${url.origin}/oauth/readai/callback`;
      const authorizeUrl = buildAuthorizeUrl(env, redirectUri, state, challenge);
      return Response.redirect(authorizeUrl, 302);
    }

    // Read.ai redirects the browser here after you sign in and consent.
    // Exchanges the authorization code for tokens and stores them (with
    // rotating-refresh handling) in KV. If Read.ai's hosted consent UI shows
    // you a "code=...&state=..." pair to copy instead of auto-redirecting,
    // just visit this same URL yourself with those two as query params.
    if (url.pathname === "/oauth/readai/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return new Response("Missing code or state", { status: 400 });
      const stateKey = `readai_oauth_state:${state}`;
      const verifier = await env.STATE_KV.get(stateKey);
      if (!verifier) return new Response("Unknown or expired state — restart at /oauth/readai/start", { status: 400 });
      await env.STATE_KV.delete(stateKey);
      const redirectUri = `${url.origin}/oauth/readai/callback`;
      try {
        await exchangeCodeForTokens(env, code, redirectUri, verifier);
      } catch (err) {
        return new Response(`Token exchange failed: ${err}`, { status: 502 });
      }
      return new Response("Read.ai authorized. You can close this tab.");
    }

    // One-time setup helper: registers this Worker's own /telegram/webhook URL
    // with Telegram, using the bot token already stored as a Cloudflare
    // secret. Never requires the bot token to leave Cloudflare. Gated on the
    // webhook secret you already set, so only you can trigger it.
    if (url.pathname === "/admin/register-webhook" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const webhookUrl = `${url.origin}/telegram/webhook`;
      const res = await setWebhook(env, webhookUrl);
      const body = await res.text();
      return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
    }

    // Testing convenience only: runs the same Pending-Finance-Handoff
    // discovery the cron does, on demand, instead of waiting up to 15
    // minutes for the next scheduled tick. Gated the same as every other
    // admin endpoint. Does not change what the discovery does or how
    // Finance executes - only when it's triggered.
    if (url.pathname === "/admin/run-finance-discovery" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const picked = await discoverPendingFinanceHandoffs(env);
      return new Response(JSON.stringify({ ok: true, handoffs_picked_up: picked }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Diagnostic: when did the cron trigger last actually run, per the
    // Worker's own record - no live-watching required, check anytime.
    if (url.pathname === "/admin/last-cron-run" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const lastRun = await env.STATE_KV.get("last_cron_run");
      return new Response(JSON.stringify({ last_cron_run: lastRun ?? null, checked_at: new Date().toISOString() }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await env.STATE_KV.put("last_cron_run", new Date().toISOString());
    await discoverPendingFinanceHandoffs(env);
    await checkStaleHandoffs(env);
  },
};

/**
 * The Finance side of the SM&BD -> Finance execution boundary. SM&BD's Hat
 * code only ever creates the Handoff (Status: Pending) and records the
 * handoff_workitem mapping, then returns - it never calls into Finance
 * directly. This runs on its own schedule and discovers that Handoff
 * independently, the same way a separate Finance AI Workspace would.
 */
async function discoverPendingFinanceHandoffs(env: Env): Promise<number> {
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: "Finance" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let pickedUp = 0;
  for (const handoff of pending) {
    const workId = await env.STATE_KV.get(`handoff_workitem:${handoff.id}`);
    if (!workId) {
      console.error(`Pending Finance Handoff ${handoff.id} has no known work item mapping — skipping automated pickup`);
      continue;
    }
    const stub = getSessionStub(env, workId);
    await stub.runFinancePickup();
    pickedUp++;
  }
  return pickedUp;
}

async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.message) {
    const chatId = update.message.chat.id;
    const threadId = update.message.message_thread_id;
    if (threadId !== undefined) {
      // Visible in `wrangler tail` — read a topic's thread id off this line
      // when setting up UNIT_TOPIC_MAP.
      console.log(`Message received: chat ${chatId}, thread ${threadId}`);
    }
    const fromId = update.message.from?.id;
    if (String(fromId) !== env.MARTIN_TELEGRAM_USER_ID) {
      await sendMessage(env, chatId, "This bot is private.", undefined, threadId);
      return;
    }
    const text = update.message.text ?? "";
    if (text === "/start") {
      await sendMessage(
        env,
        chatId,
        "ENIG agent runtime online. Send a commercial enquiry to start, /sessions to see open work items, /cancel to drop the active one.",
        undefined,
        threadId,
      );
      return;
    }
    if (text === "/sessions") {
      await listSessions(env, chatId, threadId);
      return;
    }
    if (text === "/cancel") {
      const activeId = await getActiveWorkId(env, chatId, threadId);
      if (!activeId) {
        await sendMessage(env, chatId, "Nothing active here to cancel.", undefined, threadId);
        return;
      }
      const stub = getSessionStub(env, activeId);
      await stub.cancel();
      await sendMessage(env, chatId, "Cancelled the active work item.", undefined, threadId);
      return;
    }
    if (text.startsWith("/")) {
      await sendMessage(env, chatId, "Unknown command. Try /sessions.", undefined, threadId);
      return;
    }
    await routeIncomingText(env, chatId, text, threadId);
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    const threadId = cq.message?.message_thread_id;
    if (String(cq.from.id) !== env.MARTIN_TELEGRAM_USER_ID || !chatId) {
      await answerCallbackQuery(env, cq.id, "Not authorized.");
      return;
    }
    const data = cq.data ?? "";
    const [action, workId, value] = data.split(":");
    await answerCallbackQuery(env, cq.id);

    if (action === "switch") {
      await setActiveWorkId(env, chatId, threadId, workId);
      await sendMessage(env, chatId, `Switched active context to work item ${workId}.`, undefined, threadId);
      return;
    }

    if (action === "pullcall") {
      await handlePullReadAiCall(env, chatId, workId, threadId);
      return;
    }

    if (action === "pullcallpick") {
      await applyReadAiMeeting(env, chatId, workId, value, undefined, threadId);
      return;
    }

    const stub = getSessionStub(env, workId);
    const state = await stub.getState();
    if (!state) {
      await sendMessage(env, chatId, "That work item no longer exists.", undefined, threadId);
      return;
    }
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleCallback(action, value);
    return;
  }
}

async function handlePullReadAiCall(env: Env, chatId: number, workId: string, threadId?: number): Promise<void> {
  if (!(await isAuthorized(env))) {
    await sendMessage(
      env,
      chatId,
      "Read.ai isn't connected yet. Visit /oauth/readai/start?key=<your webhook secret> in a browser once to authorize it, then try again.",
      undefined,
      threadId,
    );
    return;
  }
  const stub = getSessionStub(env, workId);
  const state = await stub.getState();
  if (!state) {
    await sendMessage(env, chatId, "That work item no longer exists.", undefined, threadId);
    return;
  }
  let meetings;
  try {
    meetings = await listRecentMeetings(env, new Date(state.createdAt).getTime());
  } catch (err) {
    await sendMessage(env, chatId, `Couldn't reach Read.ai: ${err}`, undefined, threadId);
    return;
  }
  if (meetings.length === 0) {
    await sendMessage(
      env,
      chatId,
      "No Read.ai meetings found since this enquiry started. Try again after the call ends, or type notes manually.",
      undefined,
      threadId,
    );
    return;
  }
  if (meetings.length === 1) {
    await applyReadAiMeeting(env, chatId, workId, meetings[0].id, meetings[0].title, threadId);
    return;
  }
  const buttons: InlineButton[][] = meetings.map((m) => [
    {
      text: `${m.title ?? "Untitled"}${m.start_time_ms ? ` — ${new Date(m.start_time_ms).toLocaleString()}` : ""}`,
      callback_data: `pullcallpick:${workId}:${m.id}`,
    },
  ]);
  await sendMessage(env, chatId, "Multiple recent Read.ai meetings found — which one?", buttons, threadId);
}

async function applyReadAiMeeting(
  env: Env,
  chatId: number,
  workId: string,
  meetingId: string,
  knownTitle?: string,
  threadId?: number,
): Promise<void> {
  let meeting;
  try {
    meeting = await getMeeting(env, meetingId);
  } catch (err) {
    await sendMessage(env, chatId, `Couldn't fetch that meeting from Read.ai: ${err}`, undefined, threadId);
    return;
  }
  await sendMessage(
    env,
    chatId,
    `Pulled *${meeting.title ?? knownTitle ?? "the meeting"}* from Read.ai — feeding it in as call notes.`,
    undefined,
    threadId,
  );
  const stub = getSessionStub(env, workId);
  await setActiveWorkId(env, chatId, threadId, workId);
  await stub.handleTextReply(formatCallNotesFromPayload(meeting));
}

async function handleReadAiMeetingEnd(env: Env, payload: ReadAiPayload): Promise<void> {
  const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
  const title = payload.title ?? "a meeting";
  const activeId = await getActiveWorkId(env, chatId);

  if (activeId) {
    const stub = getSessionStub(env, activeId);
    const state = await stub.getState();
    if (state && state.awaiting === "call_notes") {
      await sendMessage(env, chatId, `Read.ai call ended: *${title}*. Feeding it in as call notes for the active work item.`);
      await stub.handleTextReply(formatCallNotesFromPayload(payload));
      return;
    }
  }

  await sendMessage(
    env,
    chatId,
    `Read.ai sent a summary for *${title}*, but no work item is currently expecting call notes.${payload.report_url ? ` Report: ${payload.report_url}` : ""} Use /sessions to pick the right work item, then paste the notes in yourself.`,
  );
}

async function listSessions(env: Env, chatId: number, threadId?: number): Promise<void> {
  const raw = await env.STATE_KV.get("sessions_index");
  const index: SessionSummary[] = raw ? JSON.parse(raw) : [];
  const open = index.filter((s) => s.stage !== "complete" && s.stage !== "closed_not_qualified");
  if (open.length === 0) {
    await sendMessage(env, chatId, "No open work items. Send a new enquiry to start one.", undefined, threadId);
    return;
  }
  const activeId = await getActiveWorkId(env, chatId, threadId);
  const buttons: InlineButton[][] = open.map((s) => [
    {
      text: `${s.workId === activeId ? "• " : ""}${s.unit}/${s.hat} — ${s.label} (${s.stage})`,
      callback_data: `switch:${s.workId}:`,
    },
  ]);
  await sendMessage(env, chatId, "Open work items:", buttons, threadId);
}

const STALE_HANDOFF_DIGEST_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Runs on every scheduled tick (as often as the cron fires, currently every
// 1 minute for Finance-discovery latency), but only actually messages
// Martin at most once per STALE_HANDOFF_DIGEST_MIN_INTERVAL_MS - discovery
// and notification cadence are independent concerns.
async function checkStaleHandoffs(env: Env): Promise<void> {
  const results = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    or: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "Status", select: { equals: "Held" } },
    ],
  });
  if (results.length === 0) return;

  const lastSentKey = "stale_handoff_digest_last_sent";
  const lastSent = await env.STATE_KV.get(lastSentKey);
  if (lastSent && Date.now() - Number(lastSent) < STALE_HANDOFF_DIGEST_MIN_INTERVAL_MS) return;

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
  await env.STATE_KV.put(lastSentKey, String(Date.now()));
}
