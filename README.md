ENIG Agent Runtime

The ENIG Agent Runtime is the execution layer for ENIG’s AI-assisted business operations.

It runs ENIG’s operational Units and Hats through a Cloudflare Worker, connects execution to Notion as the system of record, and uses Telegram as an operational interface.

The current implementation covers Sales (Lead Generation Specialist live; Sales Executive paused by policy — see below), Marketing, Finance, and Research & Intelligence. Business Development, Strategy, Creative & Design, and Operations exist in the type system but have no live implementation yet.

Current status

Runtime: Cloudflare Worker (`enig-agent`), Durable Objects for per-work-item state, KV for routing/session-index state
Primary AI provider: Cloudflare Workers AI
Provider architecture: Provider abstraction implemented (Workers AI plus several OpenAI-compatible fallback providers); automatic cross-provider fallback policy is not yet implemented — an ineligible/unavailable provider fails closed rather than silently downgrading
System of record: Notion
Operational interface: Telegram (two-stream: a Workspace topic for interactive decisions/approvals, an Operations topic for background telemetry/watchdogs)
Live Units: Sales (Lead Generation Specialist), Marketing, Finance, Research & Intelligence
Other integrations: Google Workspace (Docs/Sheets, controlled creation + comment-triggered editing), Read.ai (call notes)
Deployment: Cloudflare Workers, via Cloudflare Workers Builds (see Deployment & CI/CD Automation below)
Repository: martinkpogo/My-repository
Tests: `npm test` (Node's built-in test runner via `tsx`) — 263 tests as of this writing, all passing; `npm run typecheck` clean

The provider layer currently isolates provider-specific execution behind a common interface. Workers AI remains the production provider.

Provider redundancy is an architectural requirement, but a secondary provider must not be introduced merely because it is technically available. Provider eligibility, data boundaries, fallback authority, and external-data rules must be established before live fallback is enabled.

Runtime architecture

Intake
  │
  ▼
Worker
  │
  ▼
Session / Execution Context
  │
  ▼
Unit / Hat Execution
  │
  ▼
AI Task
  │
  ▼
Data Boundary / Context Transformation
  │
  ▼
Model / Provider Policy
  │
  ▼
Provider Adapter
  │
  ▼
Common AI Response Contract
  │
  ▼
Domain Validation / Resolver
  │
  ├──────────────► Notion
  │
  └──────────────► Activity & Decision Log

The Data Boundary / Context Transformation stage is an OS-level architectural capability currently being defined. It is not yet a provider-specific sanitization layer and must not be implemented independently inside individual Hats.

The runtime should preserve this separation:

AI Task
    ↓
Model / Provider Policy
    ↓
Provider Adapter
    ↓
Common AI Response Contract
    ↓
Existing domain validation / resolver

Provider selection is infrastructure policy. It is not business authority.

Governance principles

ENIG’s governing architecture remains the authority for the runtime.

The runtime therefore follows these rules:

* Notion is the system of record for ENIG governance and operational state.
* AI output is never treated as authority by itself.
* Consequential ambiguity must stop execution rather than be guessed through.
* Disclosure of uncertainty does not constitute permission to proceed.
* Provider fallback is policy-controlled, not automatic simply because another provider is reachable.
* The runtime must fail closed when no eligible execution path exists.
* A lower data-protection boundary must never be silently substituted for a higher one.
* Material actions and decisions must remain auditable.
* Coding agents implement approved architecture. They do not redefine ENIG governance.
* Business authority remains with the appropriate human or governed business process.

AI provider architecture

Provider-specific implementations are isolated behind the AI provider interface.

The current structure is:

src/ai.ts
    │
    ▼
AiPolicyExecutor
    │
    ▼
AiProvider
    │
    └── WorkersAiProvider
             │
             ▼
       Cloudflare Workers AI

The policy layer is responsible for controlled provider execution and infrastructure-error fallback.

The provider adapter is responsible for communicating with a specific AI provider and translating provider-specific failures into the common runtime error model.

The domain layer remains responsible for interpreting and validating AI results.

Provider redundancy

The runtime is being designed for provider redundancy because infrastructure limits such as AI quota exhaustion can interrupt otherwise valid work.

However, redundancy does not mean:

Provider A fails
      ↓
send the same context to Provider B

The intended model is:

AI Task
   ↓
Determine data boundary
   ↓
Determine eligible providers
   ↓
Apply provider policy
   ↓
Execute eligible provider

If no provider satisfies the required boundary and policy, execution stops or is held for an appropriate human-controlled path.

Repository structure

src/
├── index.ts                    — Worker entry point: HTTP routes, Telegram webhook, admin endpoints, scheduled discovery
├── router.ts                   — Workspace message classification/dispatch across Units
├── session.ts                  — WorkSession Durable Object: per-work-item state, callback dispatch, sessions_index registry
├── sessionsIndex.ts            — pure bounded-retention logic for the /sessions enumeration index
├── types.ts                    — Env, WorkState, and the shared pending-approval types
├── telegram.ts                 — Telegram Bot API client, two-stream (Workspace/Operations) message targeting
├── notion.ts, governance.ts    — Notion API client; canonical governance-page retrieval
├── log.ts                      — Activity & Decision Log writes
├── chat.ts                     — general/DM conversational fallback
├── ai.ts, ai/                  — AiPolicyExecutor, provider adapters (Workers AI + OpenAI-compatible fallbacks), common response contract
├── dataBoundary/                — SemanticTaskId registry + sensitivity-tier policy every AI call is checked against
├── actions/registry.ts         — generic ActionCapability hook (natural-language → proposed action), checked before Unit classification
├── googleOAuth.ts               — Google Workspace OAuth + controlled Doc/Sheet creation and approval
├── googleDocComments.ts, googleSheetComments.ts
│                                — comment-triggered live editing (polled) for Docs and Sheets
├── readai.ts, readaiOAuth.ts   — Read.ai call-notes integration
├── hats/
│   ├── registry.ts             — Marketing Hat registry (name → definition)
│   ├── executionEngine.ts      — Marketing Hat execution/routing/approval lifecycle
│   ├── relationships.ts        — cross-Hat context-sharing rules
│   └── types.ts
└── units/
    ├── smbd/
    │   ├── sales/
    │   │   ├── salesExecutive.ts          — paused by policy (see Operational model)
    │   │   ├── leadDiscovery.ts           — manual /lead recording + duplicate/governance helpers
    │   │   └── leadGenerationDiscovery.ts — scheduled + on-demand opportunity discovery, approval gate
    │   └── marketing/                     — the 5 Marketing Hat implementations (Strategist, Brand Communications, Content Strategist, Content Manager, Digital Marketer)
    ├── finance/
    │   └── valueBasedPricingAssessor.ts   — Handoff-only quote judgment + approval
    └── research/
        ├── researchAnalyst.ts             — protocol selection, synthesis, Handoff routing
        ├── protocols.ts, researchPlan.ts, evidence.ts, safeContext.ts, protocolGuardrails.ts
        └── webSearch.ts                   — Tavily-backed live search (optional; R&I stays closed-book without it)

Each `*.ts` file above has a co-located `*.test.ts` alongside it where automated coverage exists (22 test files, 263 tests as of this writing). Architectural responsibility should remain more stable than file locations — this listing may drift; treat it as a map, not a contract.

Operational model

The runtime executes ENIG responsibilities through Units and Hats.

A Hat represents a defined responsibility. An Agent is an execution mechanism. An AI Workspace is the environment in which execution occurs.

The runtime does not treat an AI model, provider, Agent, or code module as a substitute for a Hat’s business authority.

The current live Units:

* **Sales** — Lead Generation Specialist is live: scheduled discovery (fixed problem-signal queries against the canonical Acquisition Criteria) and on-demand discovery (asked for directly in the Workspace stream, e.g. "find me 3 companies with a positioning problem"). Both paths run the same evidence pipeline — search → AI screening → Research & Intelligence Handoff → evaluate synthesis against Acquisition Criteria — and neither may create a Lead without Martin's explicit approval of the resulting Opportunity Finding. Sales Executive (the client-facing enquiry → proposal pipeline) is paused by standing policy: real client identity is confirmed-sensitive data Workers AI's training-data policy hasn't been approved to process, so that work runs instead in an isolated Sales Executive project with its own Notion/Gmail access, exchanging only opaque Entity/Matter tokens with this Worker via the Handoffs database.
* **Marketing** — 5 Hats (Marketing Strategist, Brand Communications Strategist, Content Strategist, Content Manager, Digital Marketer), each drafting within its own ownership or routing/escalating to another Hat; paid-media/spend actions carry their own explicit approval gate.
* **Finance** — Value-Based Pricing Assessor, activated only via Handoff from Sales (never directly from chat); judges a quote, presents it for approval, then hands the approved quote back to Sales.
* **Research & Intelligence** — runs bounded research protocols against a canonical Research-Safe Consultancy Context, synthesizes source-linked findings, and can propose (approval-gated) routing a completed research item to another Unit as direct input to its work.

Every approval-gated action across these Units — Google Doc/Sheet creation, Lead Opportunities, Entity/Matter drafts, Finance quotes, Marketing drafts/transitions/paid-media, R&I Handoffs — shares one generic recovery mechanism: if the Telegram approval message is missed or dismissed, `/sessions` shows it with a meaningful label and resurfaces the exact original message/buttons on selection, guarded against being actioned twice. `sessions_index` (the KV-backed enumeration this relies on) is bounded, not a second source of truth — see `src/sessionsIndex.ts`.

The remaining ENIG Units (Business Development, Strategy, Creative & Design, Operations) are not being implemented merely to complete an organisational diagram. They will be built when real ENIG work requires them.

Data and state

Notion remains the authoritative business system.

The Worker interacts with Notion for governed business objects and operational records rather than maintaining an independent shadow business database.

Telegram provides an operational interface to the runtime. It is not the system of record.

Runtime/session state may be maintained in Cloudflare infrastructure where required for execution, but this does not replace Notion’s authority over governed ENIG records.

Development

Install dependencies:

npm install

Run the test suite:

npm test

(Node's built-in test runner via `tsx --test`, not vitest — despite what an older version of this README said.)

Run type checking:

npm run typecheck

Development and deployment configuration should be maintained separately from this README where the instructions become operationally detailed.

Deployment & CI/CD Automation

The runtime is deployed as a Cloudflare Worker. PR validation and merge are automated through GitHub Actions; the actual production deploy is handled by **Cloudflare Workers Builds** (its native Git integration, connected directly to this repo in the Cloudflare dashboard), not by the `deploy.yml` GitHub Actions workflow below — `deploy.yml` exists as a secondary/backup path and is not currently what ships code to production.

### Continuous Integration & Deployment Lifecycle

1. **Pull Request Submission (`pr-validation.yml`)**:
   - Triggered when a PR is opened, updated, or reopened against target branches (`claude/notion-cloudflare-telegram-agents-nsi40m` or `main`).
   - Runs type checks (`npm run typecheck`) and unit tests (`npx tsx --test ...`).

2. **Automated Review & Auto-Merge (`auto-merge.yml`)**:
   - Triggered on PR events and `PR Validation` workflow completion.
   - Automatically approves and squashes/merges PRs into the target branch once validation passes.

3. **Production deploy (Cloudflare Workers Builds — dashboard-configured, not a file in this repo)**:
   - Triggered automatically by Cloudflare on every push to the connected branch, independently of the GitHub Actions workflows above.
   - Its **Build command** (Cloudflare dashboard → Workers & Pages → `enig-agent` → Settings → Build) is set to `npm run typecheck && npm test`, so a push that fails either check is not deployed.
   - Its Deploy command is `npx wrangler deploy` directly, not `npm run deploy` — so `package.json`'s `deploy` script (which chains `typecheck`/`test` before `wrangler deploy`) does not gate this path; the Build command above is what does.
   - Not version-controlled: this configuration lives only in the Cloudflare dashboard and won't show up in a diff if changed.

4. **Cloudflare Deployment (`deploy.yml`, GitHub Actions — secondary/backup, not currently exercised)**:
   - Triggered automatically on push / merge to target branches.
   - Executes type checks and unit test validations (via `npm run deploy`, which itself now runs `npm run typecheck && npm test` before `wrangler deploy`).
   - Runs post-deployment health check verification against `https://enig-agent.martnkpogo.workers.dev/health`.
   - Its own run history has been empty since Workers Builds took over deploys; kept as a fallback, but Workers Builds' dashboard settings are the ones that actually gate what reaches production.

### Required GitHub Configuration & Setup

To enable fully automated PR checking, merging, and deployment after task submission, configure the following in your GitHub repository:

#### 1. Repository Secrets (`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`):
* `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers Deployment permissions.
* `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID.
* `WORKER_ADMIN_KEY`: Secret key matching `TELEGRAM_WEBHOOK_SECRET` for scheduled administrative jobs (e.g. Finance Handoff discovery).

#### 2. Repository Settings for Auto-Merge & Actions Permissions:
* **Allow auto-merge**: Go to `Settings` -> `General` -> `Pull Requests` and check **"Allow auto-merge"**.
* **Workflow permissions**: Go to `Settings` -> `Actions` -> `General` -> `Workflow permissions` and select:
  - **Read and write permissions**
  - Check **"Allow GitHub Actions to create and approve pull requests"**.
* **Branch Protection Rules (Optional but Recommended)**:
  - Under `Settings` -> `Branches`, add protection rule for `main` / `claude/notion-cloudflare-telegram-agents-nsi40m`.
  - Check **"Require status checks to pass before merging"** and select `PR Validation`.

Deployment credentials and environment secrets must never be committed to the repository or included in source code.

Integrations

The runtime currently interfaces with:

* Notion — system of record for governance pages and business objects (Entities, Matters, Proposals, Leads, Handoffs, Activity & Decision Log)
* Telegram — operational interface (Workspace/Operations two-stream architecture), including inline-keyboard approval flows
* Cloudflare Workers — runtime, Durable Objects (per-work-item session state), KV (routing pointers, `sessions_index`, watchdog bookkeeping)
* Cloudflare Workers AI — primary AI provider, plus optional OpenAI-compatible fallback providers (Groq, OpenRouter, Cerebras, Gemini, SambaNova, NVIDIA NIM) at the same protection tier
* Google Workspace (Docs, Sheets, Drive) — OAuth-authorized, multi-account controlled Doc/Sheet creation with explicit approval before anything is written, plus comment-triggered live editing (polled)
* Read.ai — pulls call summaries/notes into a work item via OAuth
* Tavily — optional live web search backing Research & Intelligence and Lead Generation discovery; R&I stays closed-book (reasoning over supplied context only) if unset, rather than failing

Additional integrations may be added when required by an approved responsibility.

Detailed setup instructions for individual integrations should live under repository documentation rather than in this file.

Extending the runtime

When adding a new capability:

1. Identify the business responsibility.
2. Identify the existing governing architecture that applies.
3. Inspect the current execution path before creating new abstractions.
4. Make the smallest complete implementation.
5. Preserve the existing AI execution contract.
6. Add deterministic tests for the changed behavior.
7. Verify type safety.
8. Review the resulting diff for unrelated changes.
9. Deploy only through the approved path.
10. Verify the live behavior after deployment.

Do not introduce a new Unit, Hat, provider, routing rule, authority boundary, or governance mechanism merely because the code could support one.

Build from demonstrated operational need.

Current architectural work

The current provider architecture establishes the infrastructure necessary for provider redundancy.

The next architectural problem is the data boundary of an AI execution:

Business / Domain Context
        ↓
Data Boundary / Context Transformation
        ↓
Provider Eligibility
        ↓
Provider Execution

The runtime must determine what information may cross an AI provider boundary before a secondary provider can be safely introduced.

This work is intentionally separate from adding another provider.

What is not yet implemented

The following should not be inferred from the existence of the provider abstraction:

* automatic secondary-provider routing
* approved external-provider eligibility rules
* automated sanitization of sensitive context
* universal PII redaction
* provider-specific business logic inside Hats
* automatic downgrade to a less-protective provider
* a completed provider redundancy policy

Those require separate architectural decisions and implementation approval.

Design constraint

The runtime exists to execute ENIG’s governed operating model.

It should become more capable by making existing responsibilities executable, not by accumulating abstractions ahead of demonstrated need.
