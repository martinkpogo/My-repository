import type { Env } from "./types";
import type { TelegramUpdate, InlineButton } from "./telegram";
import { answerCallbackQuery, sendMessage, setWebhook } from "./telegram";
import {
  getActiveWorkId,
  getSessionStub,
  getWorkspaceMode,
  routeIncomingText,
  setActiveWorkId,
  setCoworkClarificationPending,
  setWorkspaceMode,
} from "./router";
import {
  checkStaleHandoffs,
  discoverPendingFinanceHandoffs,
  discoverPendingMarketingHandoffs,
  discoverPendingResearchHandoffs,
  discoverPendingSalesHandoffs,
  discoverPendingStrategyHandoffs,
  maybeAutoContinueCheckHandoffs,
  runCheckHandoffs,
} from "./checkHandoffs";
import { handleLeadDiscoverySignal, LEAD_COMMAND_PATTERN } from "./units/sales/leadDiscovery";
import { notifyDiscoveryRunSummary, runAutonomousLeadDiscovery } from "./units/sales/leadGenerationDiscovery";
import type { SessionSummary } from "./types";
import {
  handleGoogleOAuthStart,
  handleGoogleOAuthCallback,
  handleGoogleDriveTest,
  cleanupDefaultGoogleAccount,
} from "./googleOAuth";
import { pollGoogleDocComments } from "./googleDocComments";
import { pollGoogleSheetComments } from "./googleSheetComments";
import { handleNotionWebhookRequest } from "./notionWebhook";

export { WorkSession } from "./session";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Externally-created Handoff detection -- a Handoff queued directly in
    // Notion (e.g. by the isolated Sales Claude Project) rather than by
    // this Worker's own code. See notionWebhook.ts for the full
    // authentication/filtering contract; this route only wires it up.
    if (url.pathname === "/notion/webhook" && request.method === "POST") {
      return handleNotionWebhookRequest(request, env, ctx);
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (header !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
      }
      const update = (await request.json()) as TelegramUpdate;
      try {
        await handleUpdate(env, update);
      } catch (err) {
        console.error("Unhandled error processing Telegram update", err, JSON.stringify(update));
        await notifyMartinOfFailure(env, update).catch((notifyErr) =>
          console.error("Failed to notify Martin of unhandled webhook error", notifyErr),
        );
      }
      return new Response("ok");
    }

    // Fed by a Gmail-polling Apps Script (or any other email source) —
    // treats the email body as a new incoming enquiry, exactly as if it had
    // been typed into the Sales topic. Shared-secret gated.
    if (url.pathname === "/email/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Email-Webhook-Secret");
      if (!env.EMAIL_WEBHOOK_SECRET || secret !== env.EMAIL_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as { from?: string; subject?: string; text?: string };
      if (!body.text) return new Response("Missing text", { status: 400 });

      // Martin's preferred front door is DM (see routeIncomingText's DM
      // fallback and generalDmReply) -- an email-sourced enquiry lands
      // there too, rather than a Unit topic, so every Unit/Hat's work
      // reaches him in one place.
      const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
      const threadId = undefined;
      const enquiryText = `Email enquiry${body.from ? ` from ${body.from}` : ""}${body.subject ? ` — "${body.subject}"` : ""}:\n\n${body.text}`;
      await routeIncomingText(env, chatId, enquiryText, threadId, { forceNewEnquiry: true });
      return new Response("ok");
    }

    // Google Workspace OAuth start endpoint. Gated on the webhook secret key parameter.
    // PKCE verifier and state are saved in KV (1800s TTL) for callback consumption.
    if (url.pathname === "/oauth/google/start" && request.method === "GET") {
      return handleGoogleOAuthStart(request, env);
    }

    // Google Workspace OAuth callback endpoint.
    // Consumes single-use state, exchanges authorization code with PKCE verifier for tokens,
    // and stores credentials persistently in KV.
    if (url.pathname === "/oauth/google/callback" && request.method === "GET") {
      return handleGoogleOAuthCallback(request, env);
    }

    // Google Drive read-only connectivity test endpoint. Gated on the webhook secret key parameter.
    if (url.pathname === "/admin/test-google-drive" && request.method === "GET") {
      return handleGoogleDriveTest(request, env);
    }

    // One-time cleanup for the "default"-keyed Google account left behind
    // by authorizations that predate GOOGLE_OAUTH_SCOPES including
    // "openid"/"email" -- see cleanupDefaultGoogleAccount's own doc
    // comment. Safe to call repeatedly: a no-op once the "default" token
    // is gone.
    if (url.pathname === "/admin/cleanup-default-google-account" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const result = await cleanupDefaultGoogleAccount(env);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        console.error("Unhandled error in /admin/cleanup-default-google-account", err);
        return new Response(JSON.stringify({ ok: false, error: "internal error, logged" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // One-time setup helper: registers this Worker's own /telegram/webhook URL
    // with Telegram, using the bot token already stored as a Cloudflare
    // secret. Never requires the bot token to leave Cloudflare. Gated on the
    // webhook secret you already set, so only you can trigger it.
    if (url.pathname === "/admin/register-webhook" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const webhookUrl = `${url.origin}/telegram/webhook`;
      const res = await setWebhook(env, webhookUrl);
      const body = await res.text();
      return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
    }

    // Runs everything the native Cloudflare Cron Trigger was supposed to
    // (confirmed correctly configured but never actually firing - see
    // /admin/last-cron-run) - Finance-Handoff discovery and the
    // stale-handoff digest. Called on a schedule by a GitHub Actions
    // workflow (.github/workflows/finance-discovery-cron.yml) as a
    // workaround. Gated the same as every other admin endpoint.
    if (url.pathname === "/admin/run-finance-discovery" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      // Best-effort diagnostic timestamp for /admin/last-cron-run and the
      // watchdog -- must never take down the actual discovery run below it
      // (e.g. if this key's write rate is briefly exceeded, now that it's
      // written by GitHub Actions every 5 min, cron-job.org, the native
      // Cron Trigger, and /checkhandoffs, all landing on the same key).
      await env.STATE_KV.put("last_cron_run", new Date().toISOString()).catch((err) =>
        console.error("Failed to record last_cron_run", err),
      );
      try {
        const picked = await discoverPendingFinanceHandoffs(env);
        const pickedForSales = await discoverPendingSalesHandoffs(env);
        const pickedForResearch = await discoverPendingResearchHandoffs(env);
        const pickedForMarketing = await discoverPendingMarketingHandoffs(env);
        const pickedForStrategy = await discoverPendingStrategyHandoffs(env);
        await checkStaleHandoffs(env);
        return new Response(
          JSON.stringify({
            ok: true,
            handoffs_picked_up: picked,
            sales_handoffs_picked_up: pickedForSales,
            research_handoffs_picked_up: pickedForResearch,
            marketing_handoffs_picked_up: pickedForMarketing,
            strategy_handoffs_picked_up: pickedForStrategy,
          }),
          { headers: { "content-type": "application/json" } },
        );
      } catch (err) {
        console.error("Unhandled error in /admin/run-finance-discovery", err);
        await sendMessage(
          env,
          Number(env.MARTIN_TELEGRAM_USER_ID),
          `⚠️ The Handoff discovery run failed unexpectedly. Logged for review — will retry next cycle.`,
        ).catch((notifyErr) => console.error("Failed to notify Martin of discovery-route failure", notifyErr));
        return new Response(JSON.stringify({ ok: false, error: "internal error, logged" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Autonomous Lead Generation Specialist discovery -- same
    // external-cron-hits-an-admin-endpoint pattern as
    // /admin/run-finance-discovery above (the native Cloudflare Cron
    // Trigger has never reliably fired on this account). Meant to be hit
    // three times a day by an external scheduler (cron-job.org), not by
    // the native trigger. Independent of SALES_EXECUTIVE_PAUSED -- Lead
    // Generation Specialist runs in this shared Worker regardless of
    // whether Sales Executive's isolated pipeline is paused, same as the
    // /lead command.
    if (url.pathname === "/admin/run-lead-discovery" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const summary = await runAutonomousLeadDiscovery(env);
        let notificationSent = false;
        let notificationError: string | null = null;
        try {
          const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
          notificationSent = await notifyDiscoveryRunSummary(env, chatId, undefined, summary);
          if (!notificationSent) {
            notificationError = "Telegram notification returned unconfirmed or failed status";
          }
        } catch (notifyErr) {
          notificationError = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          console.error("Failed to deliver discovery run notification digest", notifyErr);
        }

        return new Response(
          JSON.stringify({
            ok: true,
            ...summary,
            notificationSent,
            notificationError,
          }),
          { headers: { "content-type": "application/json" } }
        );
      } catch (err) {
        console.error("Unhandled error in /admin/run-lead-discovery", err);
        await sendMessage(
          env,
          Number(env.MARTIN_TELEGRAM_USER_ID),
          `⚠️ The scheduled Lead discovery run failed unexpectedly. Logged for review — will retry next cycle.`,
        ).catch((notifyErr) => console.error("Failed to notify Martin of lead-discovery failure", notifyErr));
        return new Response(JSON.stringify({ ok: false, error: "internal error, logged" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Comment-triggered Google Doc editing -- same external-cron-hits-an-
    // admin-endpoint pattern as /admin/run-finance-discovery and
    // /admin/run-lead-discovery above. Meant to be hit every 30-60s by an
    // external scheduler (cron-job.org): Google Drive has no push
    // notification for comment events (the X-Goog-Changed header's
    // tracked change types are content/properties/parents/children/
    // permissions -- comments are not among them, verified against
    // Drive's own API docs), so polling is the only option here, not a
    // fallback for a push mechanism that doesn't exist.
    if (url.pathname === "/admin/poll-google-doc-comments" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const result = await pollGoogleDocComments(env);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        console.error("Unhandled error in /admin/poll-google-doc-comments", err);
        return new Response(JSON.stringify({ ok: false, error: "internal error, logged" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Diagnostic: when did the cron trigger last actually run, per the
    // Worker's own record - no live-watching required, check anytime.
    if (url.pathname === "/admin/last-cron-run" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const lastRun = await env.STATE_KV.get("last_cron_run");
      return new Response(JSON.stringify({ last_cron_run: lastRun ?? null, checked_at: new Date().toISOString() }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Same diagnostic as /admin/last-cron-run above, for the separate
    // cron-job.org schedule hitting /admin/poll-google-doc-comments --
    // Cloudflare's basic Workers analytics doesn't break requests down by
    // path, so this KV record is the only way to confirm that scheduler
    // is actually firing.
    if (url.pathname === "/admin/last-google-doc-comment-poll" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const lastRun = await env.STATE_KV.get("last_google_doc_comment_poll_run");
      return new Response(JSON.stringify({ last_google_doc_comment_poll_run: lastRun ?? null, checked_at: new Date().toISOString() }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Comment-triggered Google Sheet editing -- same pattern and same
    // rationale (no Drive push notification for comment events) as
    // /admin/poll-google-doc-comments above. Meant to be hit every 30-60s
    // by a second cron-job.org schedule.
    if (url.pathname === "/admin/poll-google-sheet-comments" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const result = await pollGoogleSheetComments(env);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        console.error("Unhandled error in /admin/poll-google-sheet-comments", err);
        return new Response(JSON.stringify({ ok: false, error: "internal error, logged" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Same diagnostic as /admin/last-google-doc-comment-poll above, for
    // the separate cron-job.org schedule hitting
    // /admin/poll-google-sheet-comments.
    if (url.pathname === "/admin/last-google-sheet-comment-poll" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const lastRun = await env.STATE_KV.get("last_google_sheet_comment_poll_run");
      return new Response(JSON.stringify({ last_google_sheet_comment_poll_run: lastRun ?? null, checked_at: new Date().toISOString() }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Independent watchdog: meant to be pinged by a SECOND, separate external
    // scheduler (different provider than the one hitting
    // /admin/run-finance-discovery). If the discovery trigger has gone
    // silent - the external scheduler running it stopped, paused, or was
    // never set up - this notices via the Worker's own KV record and DMs
    // Martin directly, instead of the Handoff just sitting Pending forever
    // with no one told. Throttled independently so a prolonged outage
    // doesn't spam.
    if (url.pathname === "/admin/watchdog" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const lastRun = await env.STATE_KV.get("last_cron_run");
      const staleMs = lastRun ? Date.now() - new Date(lastRun).getTime() : Infinity;
      const isStale = staleMs > WATCHDOG_STALE_THRESHOLD_MS;
      if (isStale) {
        const lastAlertKey = "watchdog_alert_last_sent";
        const lastAlert = await env.STATE_KV.get(lastAlertKey);
        if (!lastAlert || Date.now() - Number(lastAlert) > WATCHDOG_ALERT_MIN_INTERVAL_MS) {
          const minutesSince = lastRun ? Math.round(staleMs / 60000) : null;
          await sendMessage(
            env,
            Number(env.MARTIN_TELEGRAM_USER_ID),
            minutesSince === null
              ? `*Watchdog alert*: Finance-Handoff discovery has never run - /admin/run-finance-discovery may not be scheduled. Nothing will surface Pending Handoffs until it runs.`
              : `*Watchdog alert*: Finance-Handoff discovery hasn't run in ${minutesSince} minute(s). Check that its external scheduler (cron-job.org) is still active - until it runs, Pending Handoffs won't be picked up or reported.`,
          );
          await env.STATE_KV.put(lastAlertKey, String(Date.now()));
        }
      }
      return new Response(JSON.stringify({ ok: true, stale: isStale, last_cron_run: lastRun ?? null }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await env.STATE_KV.put("last_cron_run", new Date().toISOString()).catch((err) =>
      console.error("Failed to record last_cron_run", err),
    );
    try {
      await discoverPendingFinanceHandoffs(env);
      await discoverPendingSalesHandoffs(env);
      await discoverPendingResearchHandoffs(env);
      await discoverPendingMarketingHandoffs(env);
      await discoverPendingStrategyHandoffs(env);
      await checkStaleHandoffs(env);
    } catch (err) {
      console.error("Unhandled error in scheduled discovery run", err);
      await sendMessage(
        env,
        Number(env.MARTIN_TELEGRAM_USER_ID),
        `⚠️ The scheduled Handoff discovery run failed unexpectedly. Logged for review — will retry next cycle.`,
      ).catch((notifyErr) => console.error("Failed to notify Martin of scheduled-run failure", notifyErr));
    }
  },
};

/**
 * Runtime protection layer (Gap B) for the main Telegram entry point: if
 * handleUpdate throws anything not already caught by a more specific
 * fail-closed check, this reports it to the same chat/topic the update
 * came from (falling back to Martin's DM when that can't be determined)
 * instead of the request failing silently.
 */
async function notifyMartinOfFailure(env: Env, update: TelegramUpdate): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? Number(env.MARTIN_TELEGRAM_USER_ID);
  const threadId = update.message?.message_thread_id ?? update.callback_query?.message?.message_thread_id;
  await sendMessage(
    env,
    chatId,
    `⚠️ Something went wrong processing that. It's been logged for review — nothing further was changed. Please try again.`,
    undefined,
    threadId,
  );
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
    // Telegram appends "@<botusername>" to commands sent in group chats
    // (to disambiguate which bot, when several might be present) --
    // e.g. "/clearsessions@enig_hq_ops_bot confirm". Strip it right after
    // the leading /command token so every exact-string command check
    // below works the same in a group/topic as it does in a DM.
    const text = (update.message.text ?? "").replace(/^(\/\w+)@\w+/, "$1");
    if (text === "/start") {
      await sendMessage(
        env,
        chatId,
        "ENIG agent runtime online. Send a commercial enquiry to start, /mode to view or switch this thread between Chat and Cowork, /sessions to see open work items, /cancel to drop the active one, /clearsessions to wipe all KV routing/session state (Notion untouched), /checkhandoffs to run Handoff discovery now, /lead to record a discovered Lead (send /lead with no arguments for the format).",
        undefined,
        threadId,
      );
      return;
    }
    if (text === "/sessions") {
      await listSessions(env, chatId, threadId);
      return;
    }
    if (text === "/mode") {
      // Displays the current Workspace mode and the two toggle buttons --
      // the actual switch happens only through the "mode" callback below
      // (a deterministic Telegram tap), never through this command or any
      // AI interpretation of it. Same pattern as /sessions's own
      // display-then-tap-a-button design.
      const currentMode = await getWorkspaceMode(env, chatId, threadId);
      const buttons: InlineButton[][] = [
        [
          { text: currentMode === "chat" ? "• Chat" : "Chat", callback_data: "mode::chat" },
          { text: currentMode === "cowork" ? "• Cowork" : "Cowork", callback_data: "mode::cowork" },
        ],
      ];
      await sendMessage(env, chatId, `Current Workspace mode here: *${currentMode}*.`, buttons, threadId);
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
    // Matches "/clearsessions", "/clearsessions confirm", and (since a
    // BotFather-registered command name can't contain a space, so the
    // confirm variant may get registered as one word) "/clearsessionsconfirm"
    // -- with or without the leading slash, case-insensitively, since a
    // phone keyboard may also auto-capitalize the first letter.
    const clearSessionsMatch = text.trim().match(/^\/?clearsessions\s*(confirm)?$/i);
    if (clearSessionsMatch) {
      const keys = await listSessionKvKeys(env);
      if (!clearSessionsMatch[1]) {
        await sendMessage(
          env,
          chatId,
          `This would delete ${keys.length} KV key(s) (active/chat_history/handoff_workitem/sessions_index routing state) — Notion is never touched, and Read.ai's own credential is left alone. Send /clearsessions confirm to proceed.`,
          undefined,
          threadId,
        );
        return;
      }
      await Promise.all(keys.map((key) => env.STATE_KV.delete(key)));
      await sendMessage(env, chatId, `Cleared ${keys.length} KV key(s). Every chat/topic starts a fresh work item on its next message.`, undefined, threadId);
      return;
    }
    // Lead Generation Specialist's own entry point (Sales Unit's Lead
    // Discovery specialization) -- deliberately outside
    // routeIncomingText/SALES_EXECUTIVE_PAUSED. Sales is active and Lead
    // Discovery runs in this shared "ENIG - Sales runtime" Worker regardless
    // of whether Sales Executive's isolated Sales Progression pipeline is
    // paused; the two are independent by design (see leadDiscovery.ts).
    if (LEAD_COMMAND_PATTERN.test(text)) {
      const body = text.replace(LEAD_COMMAND_PATTERN, "");
      await handleLeadDiscoverySignal(env, chatId, threadId, body);
      return;
    }
    if (text === "/checkhandoffs") {
      // Same discovery logic /admin/run-finance-discovery and the 5-minute
      // GitHub Actions cron already run -- exposed as a command so it's
      // triggerable directly from Telegram, without the admin URL/secret,
      // and entirely outside the AI-gated routeIncomingText path (a plain
      // command, never routed through generalChatReply). The full
      // implementation now lives in checkHandoffs.ts's runCheckHandoffs --
      // shared verbatim with the automatic post-confirmation continuation a
      // Hat triggers right after successfully queuing a Handoff (see e.g.
      // salesExecutive.ts's handleInterventionText).
      await runCheckHandoffs(env, chatId, threadId);
      return;
    }
    if (text.startsWith("/")) {
      await sendMessage(env, chatId, "Unknown command. Try /sessions.", undefined, threadId);
      return;
    }
      const replyToMessageId = update.message.reply_to_message?.message_id;
      await routeIncomingText(env, chatId, text, threadId, { replyToMessageId });
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
      const switchedStub = getSessionStub(env, workId);
      const switchedState = await switchedStub.getState();
      const pending = switchedState?.pendingActionSummary;
      if (pending) {
        // Resurface the exact original approval message/buttons rather
        // than just confirming the context switch -- this is the recovery
        // path for a missed or dismissed approval message. The buttons are
        // the same callback_data as the original send, so tapping them
        // still routes through the same resolve handler and its own
        // stale/already-resolved guard -- nothing here bypasses that.
        await sendMessage(env, chatId, `Re-sending pending approval:\n\n${pending.message}`, pending.buttons, threadId);
      } else {
        await sendMessage(env, chatId, `Switched active context to work item ${workId}.`, undefined, threadId);
      }
      return;
    }

    if (action === "mode") {
      // Deterministic Telegram toggle -- the sole way Workspace mode
      // changes. Never creates, cancels, or mutates a WorkSession or
      // Handoff; only writes the thread-scoped mode marker (and clears any
      // stale clarification-pending marker, since switching away from
      // Cowork mid-clarification should not leave a dangling "waiting for
      // an answer" state behind).
      const newMode = value === "cowork" ? "cowork" : "chat";
      await setWorkspaceMode(env, chatId, threadId, newMode);
      await setCoworkClarificationPending(env, chatId, threadId, false);
      await sendMessage(env, chatId, `Workspace mode switched to *${newMode}*.`, undefined, threadId);
      return;
    }

    const stub = getSessionStub(env, workId);
    const state = await stub.getState();
    if (!state) {
      await sendMessage(env, chatId, "That work item no longer exists.", undefined, threadId);
      return;
    }
    const result = await stub.handleCallback(action, value);
    await maybeAutoContinueCheckHandoffs(env, chatId, threadId, result);
    return;
  }
}

// Work-item stages are internal code states (e.g. "awaiting_qualification_approval")
// used for control flow, not written for a human reader — this turns any of
// them into plain English for display without needing a maintained mapping.
function humanizeStage(stage: string): string {
  return stage.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
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
      text: `${s.workId === activeId ? "• " : ""}${s.unit}/${s.hat} — ${s.label} (${humanizeStage(s.stage)})`,
      callback_data: `switch:${s.workId}:`,
    },
  ]);
  await sendMessage(env, chatId, "Open work items:", buttons, threadId);
}

/**
 * Enumerates every KV key that represents routing/session state --
 * active/chat_history/handoff_workitem entries plus the sessions_index --
 * for /clearsessions. Deliberately excludes the cron/stale-digest
 * bookkeeping keys (harmless either way, not what "clear sessions"
 * means). Notion is never touched by this -- KV only holds routing
 * pointers, never business records.
 */
async function listSessionKvKeys(env: Env): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of ["active:", "chat_history:", "handoff_workitem:"]) {
    let cursor: string | undefined;
    do {
      const page = await env.STATE_KV.list({ prefix, cursor });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  if (await env.STATE_KV.get("sessions_index")) keys.push("sessions_index");
  return keys;
}

// Discovery now runs every 15 min (see wrangler.toml / cron-job.org), so a
// legitimate gap between runs can be nearly that long — the threshold has
// to clear one full cycle plus buffer, or every check would false-alarm.
const WATCHDOG_STALE_THRESHOLD_MS = 20 * 60 * 1000;
const WATCHDOG_ALERT_MIN_INTERVAL_MS = 30 * 60 * 1000;

