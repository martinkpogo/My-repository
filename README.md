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
                           │    ├─ hats/salesExecutive.ts
                           │    └─ hats/financeValueBasedPricing.ts
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

### 5. Local dev

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
then apply the same pattern — one Hat module under `src/hats/`, wired into
`session.ts`'s dispatch and `router.ts`'s Hat-selection classifier — to
Research & Intelligence, Strategy, Creative & Design, and Operations, one at
a time.
