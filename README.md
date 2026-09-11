# ENIG Agent Runtime — Cloudflare Worker + Telegram

Runs the ENIG **SM&BD + Finance** vertical slice (per the Build Method in Notion:
*ENIG HQ → 0. Kernel → Build Method*) as a live Cloudflare Worker instead of a
Claude Project you paste instructions into. Telegram is the chat interface for
approvals — the same "shown in chat for approval" mechanic already defined in
the *Universal Role Contract*, just running on infrastructure instead of a
manual chat session.

## What this is (and isn't)

- Implements the **Sales Executive** Hat (SM&BD) and **Value-Based Pricing
  Assessor** Hat (Finance) exactly as defined in Notion under `2. Units & Hats`.
- **Notion stays the system of record.** The Worker reads/writes the live
  `Entity`, `Matters`, `Proposals`, `Handoffs`, and `Activity & Decision Log`
  databases via the Notion API — it does not duplicate or replace them.
- **Workers AI** (free-tier, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by
  default) does the drafting/reasoning — no paid model API calls.
- One Telegram bot, one chat with you. Multiple work items can be open at
  once; `/sessions` lists them and switches which one your next message
  replies to (an "inline Unit switch" — action buttons, not separate bots).
- Governance carried over from the *Universal Role Contract*: AI drafts are
  shown in chat for approval before being written to Notion; Handoffs are
  created directly (no chat gate — per the Contract, transfers aren't content
  for line-by-line review); every material action is logged to the Activity
  & Decision Log; anything the model can't resolve confidently stops and
  surfaces to you rather than guessing.
- **Simplification from the canonical model**: SM&BD and Finance run as one
  Worker/one Durable Object per work item, not as two isolated AI Workspaces
  handing off to each other. The Handoff record in Notion is still real and
  auditable — Finance's pickup just happens synchronously in the same
  request instead of through a second, separately-triggered agent. Revisit
  this if you want stricter Unit isolation later.
- Research & Intelligence, Strategy, Creative & Design, and Operations are
  **not built** — out of scope for this slice, per the Build Method.

## Architecture

```
Telegram  ──webhook──▶  Worker (src/index.ts)
                           │
                           ├─ router.ts        Hat selection / ambiguity guard
                           ├─ session.ts       Durable Object: one per work item
                           │    ├─ units/smbd/sales/salesExecutive.ts
                           │    ├─ units/smbd/marketing/*.ts   (5 Hats)
                           │    ├─ units/finance/valueBasedPricingAssessor.ts
                           │    └─ hats/registry.ts            (Hat discovery + Marketing engine)
                           ├─ notion.ts        Notion API (data sources)
                           ├─ ai.ts            Workers AI (JSON-mode calls)
                           ├─ log.ts           Activity & Decision Log writer
                           └─ telegram.ts      sendMessage / inline keyboards
```

A cron trigger (every 15 min) sends a Telegram digest if any Handoff is
sitting in `Pending` or `Held` — a safety net notification, not an
auto-executor.

## Setup

### 1. Notion integration

1. Create an internal integration at https://www.notion.so/my-integrations,
   copy its token.
2. Share these pages with the integration (Notion sidebar → `...` → Connect
   to → your integration): **Engagements** (covers Entity, Matters,
   Proposals) and **Operation Records** (covers Handoffs, Activity &
   Decision Log).
3. The data source IDs are already wired up in `wrangler.toml` — they were
   read directly from your live databases. If you ever recreate those
   databases, update the IDs there.

### 2. Telegram bot

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
2. Message [@userinfobot](https://t.me/userinfobot) (or similar) to get your
   own numeric Telegram user ID — this is `MARTIN_TELEGRAM_USER_ID`. The bot
   only responds to this user.

### 3. Cloudflare

```bash
npm install
npx wrangler login

npx wrangler kv namespace create STATE_KV
# copy the returned id into wrangler.toml under [[kv_namespaces]]

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string you choose
npx wrangler secret put MARTIN_TELEGRAM_USER_ID
npx wrangler secret put NOTION_TOKEN

npm run deploy
```

### 4. Register the Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-subdomain>.workers.dev/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 5. Read.ai (optional — call notes without typing them yourself)

Two independent integrations exist, pick one (or neither and keep typing
notes manually — that always works, no setup needed):

**Option A — Webhook (push, fully automatic, needs Pro/Enterprise/Enterprise+):**

1. In Read.ai: **Integrations → Your Integrations → Webhooks**
   (`app.read.ai/analytics/integrations/user/workflow/webhooks`) — a
   personal webhook covers your own meetings, which is what you want here.
2. Set the webhook URL to `https://<your-worker-subdomain>.workers.dev/readai/webhook`
3. Read.ai shows a signing key once, at creation — copy it, then:
   ```bash
   npx wrangler secret put READAI_WEBHOOK_SECRET
   ```
4. When a call ends, the Worker checks whether a work item is currently
   waiting on call notes and feeds the transcript/summary in automatically.
   If nothing is waiting, it messages you on Telegram instead of guessing
   which enquiry it belongs to.

**Option B — OAuth pull API (on-demand, works on the free plan, open beta):**

Read.ai's free-plan-compatible pull API requires OAuth 2.1 (browser-based,
one-time bootstrap; no static API keys yet). Setup:

1. Register an OAuth client (self-service, instant, no approval wait):
   ```bash
   curl -X POST https://api.read.ai/oauth/register \
     -H "Content-Type: application/json" \
     -d '{
       "client_name": "ENIG Agent",
       "redirect_uris": ["https://<your-worker-subdomain>.workers.dev/oauth/readai/callback"],
       "grant_types": ["authorization_code", "refresh_token"],
       "response_types": ["code"],
       "scope": "openid email offline_access profile meeting:read",
       "token_endpoint_auth_method": "client_secret_basic"
     }'
   ```
   Response includes `client_id` and `client_secret` (shown once).
2. Set both as Cloudflare secrets:
   ```bash
   npx wrangler secret put READAI_OAUTH_CLIENT_ID
   npx wrangler secret put READAI_OAUTH_CLIENT_SECRET
   ```
3. If you're in a Read.ai workspace, enable **Downloads** under
   **Workspace Settings → Reports & Sharing** — required for API pull access
   regardless of plan.
4. Deploy (`npm run deploy`), then authorize once by visiting, in a browser:
   ```
   https://<your-worker-subdomain>.workers.dev/oauth/readai/start?key=<your TELEGRAM_WEBHOOK_SECRET>
   ```
   Sign in and consent. You should land on a page saying "Read.ai
   authorized." If Read.ai's consent UI instead shows you a `code=...` and
   `state=...` to copy rather than redirecting automatically, just visit
   `.../oauth/readai/callback?code=...&state=...` yourself with those values.
5. From then on, whenever a work item is waiting on call notes, its Telegram
   message includes a **"📞 Pull latest Read.ai call"** button — tap it to
   fetch and apply the transcript instead of typing notes.

Access tokens last 10 minutes and refresh automatically (rotating refresh
tokens, stored in KV). There's no documented hard expiry on the refresh
chain, but Read.ai's own docs note a broken chain "may require manual
intervention" — if pulling ever starts failing with an authorization error,
just redo step 4.

### 6. Telegram Topics (optional — one topic per Unit)

Simulates "one dedicated AI Workspace per Unit" inside a single Telegram
Supergroup, closer to the original per-Unit Claude Project model than one
flat chat:

1. Create a Telegram **Group**, then enable **Topics** in its settings
   (auto-converts it to a Supergroup).
2. Add the bot to the group and make it an **admin** — required for it to
   see every message regardless of Telegram's privacy-mode filtering.
3. Create one topic per Unit: **SM&BD**, **Finance**, **Strategy**,
   **Research & Intelligence**, **Creative & Design**, **Operations**.
4. Deploy, keep `wrangler tail` open, then send a test message in each
   topic — each logs a line like `Message received: chat -100xxxx, thread N`.
5. Fill in `UNIT_TOPIC_MAP` in `wrangler.toml` with the real thread ids, and
   `TELEGRAM_GROUP_CHAT_ID` if you want email-sourced enquiries (below) to
   land in the group rather than your personal DM. Redeploy.

Only SM&BD's topic accepts new enquiries directly — Finance's topic
explains it only activates via Handoff, and the four unbuilt Units' topics
say no Hat is available there yet. Unset `UNIT_TOPIC_MAP` entirely to fall
back to the original flat 1:1 chat behavior.

### 7. Email intake for enquiries (optional)

Two options, from no-setup to fully automatic:

- **Manual (works today, no setup):** forward or paste the email content
  into the SM&BD topic — an enquiry is just text describing a business
  problem, regardless of source.
- **Automatic via Gmail:** a free Google Apps Script polls your inbox and
  forwards labeled emails to the Worker.
  1. In Gmail, create a filter that applies a label (e.g. `ENIG-Enquiry`)
     to whatever mail should count as an incoming enquiry.
  2. Set the secret: `npx wrangler secret put EMAIL_WEBHOOK_SECRET`
  3. Go to **script.google.com** → **New project**, paste in
     `scripts/gmail-enquiry-poller.gs` from this repo, fill in the same
     secret and your Worker URL at the top of the script.
  4. In the script editor, **Triggers** (clock icon) → **Add Trigger** →
     run `checkForEnquiries` on a **time-driven** trigger, every 5 minutes.
  5. It POSTs new labeled emails to `/email/webhook`, which creates a new
     SM&BD work item exactly as if the enquiry had been typed into Telegram,
     then labels the thread `ENIG-Enquiry-Sent` so it isn't reprocessed.
- **Automatic via a custom domain:** if you have a domain on Cloudflare's
  DNS, Cloudflare Email Routing + an Email Worker can trigger this same
  Worker directly on inbound mail — ask if you want this built instead.

### 8. Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
```

## Using it

Message the bot with an incoming enquiry (as if relaying a real one). It
will walk through: Entity match/create → Matter match/create → sales-call
prep → (you run the call, send back notes) → qualification → Lead→Prospect
approval → proposed intervention → automatic Handoff to Finance → Finance
judges a value-based quote (or holds it and asks for more value context) →
Draft Proposal presented for your approval/revision → Proposal record
created in Notion.

`/sessions` — list and switch between open work items.

## Extending to the remaining Units

Per the Build Method: prove this slice live on a real quote request first,
then apply the same pattern — one Hat module under `src/units/<unit>/<specialization>/`
(or directly under `src/units/<unit>/` where no specialization split exists,
as with Finance), registered in `src/hats/registry.ts` and wired into
`session.ts`'s dispatch and `router.ts`'s Hat-selection classifier — to
Research & Intelligence, Strategy, Creative & Design, and Operations, one at
a time.
