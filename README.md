ENIG Agent Runtime

The ENIG Agent Runtime is the execution layer for ENIG’s AI-assisted business operations.

It runs ENIG’s operational Units and Hats through a Cloudflare Worker, connects execution to Notion as the system of record, and uses Telegram as an operational interface.

The current implementation covers the SM&BD and Finance vertical slice. Other Units are not yet part of the live runtime.

Current status

Runtime: Cloudflare Worker
Primary AI provider: Cloudflare Workers AI
Provider architecture: Provider abstraction implemented; secondary-provider governance is being defined
System of record: Notion
Operational interface: Telegram
Live Units: SM&BD, Finance
Deployment: Cloudflare Workers
Repository: martinkpogo/My-repository

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
├── ai.ts
├── ai/
│   ├── types.ts
│   ├── policy.ts
│   ├── workersai.ts
│   └── ...
├── router.ts
├── executionEngine.ts
├── salesExecutive.ts
├── finance/
├── marketing/
├── notion/
├── telegram/
├── session/
├── log/
└── ...
tests/

The exact directory structure may evolve as the runtime is developed. Architectural responsibility should remain more stable than file locations.

Operational model

The runtime executes ENIG responsibilities through Units and Hats.

A Hat represents a defined responsibility. An Agent is an execution mechanism. An AI Workspace is the environment in which execution occurs.

The runtime does not treat an AI model, provider, Agent, or code module as a substitute for a Hat’s business authority.

The current live vertical slice includes:

* SM&BD
* Finance

The remaining ENIG Units are not being implemented merely to complete an organisational diagram. They will be built when real ENIG work requires them.

Data and state

Notion remains the authoritative business system.

The Worker interacts with Notion for governed business objects and operational records rather than maintaining an independent shadow business database.

Telegram provides an operational interface to the runtime. It is not the system of record.

Runtime/session state may be maintained in Cloudflare infrastructure where required for execution, but this does not replace Notion’s authority over governed ENIG records.

Development

Install dependencies:

npm install

Run the test suite:

npx vitest run

Run type checking:

npx tsc --noEmit

Development and deployment configuration should be maintained separately from this README where the instructions become operationally detailed.

Deployment & CI/CD Automation

The runtime is deployed as a Cloudflare Worker using an automated end-to-end GitHub Actions workflow.

### Continuous Integration & Deployment Lifecycle

1. **Pull Request Submission (`pr-validation.yml`)**:
   - Triggered when a PR is opened, updated, or reopened against target branches (`claude/notion-cloudflare-telegram-agents-nsi40m` or `main`).
   - Runs type checks (`npm run typecheck`) and unit tests (`npx tsx --test ...`).

2. **Fail-Closed Automated Merge (`auto-merge.yml`)**:
   - Triggered strictly by successful completion of the `PR Validation` workflow (`github.event.workflow_run.conclusion == 'success'`).
   - Verifies the associated PR is open, targets `claude/notion-cloudflare-telegram-agents-nsi40m`, and matches the validated head commit SHA.
   - Performs a squash merge and deletes the head branch without unconditional fallbacks.

3. **Explicit Deployment Dispatch (`deploy.yml`)**:
   - Explicitly dispatched by `auto-merge.yml` on `claude/notion-cloudflare-telegram-agents-nsi40m` immediately following a successful merge.
   - Executes type checks and unit test validations.
   - Deploys the worker to Cloudflare using `npm run deploy` (`wrangler deploy`).
   - Runs post-deployment health check verification against `https://enig-agent.martnkpogo.workers.dev/health`.

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

* Notion
* Telegram
* Cloudflare Workers
* Cloudflare Workers AI

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
