# ENIG Agent Execution Contract

This document establishes the ENIG operating model and execution contracts for Claude Code and Jules. The architectural, governance, security, provider, data-boundary, fail-closed, evidence, and documentation rules bind every implementation agent.

## Governing reasoning boundary

ENIG uses two coding agents with the same architectural reasoning boundary but different execution ceilings. **Architect/Martin owns**:

- architectural decisions;
- governance decisions;
- authority and approval rules;
- security and data-boundary policy;
- provider eligibility and fallback policy;
- business-policy interpretation; and
- changes to governing operating-model contracts.

Both Claude Code and Jules may reason deeply about implementation inside an approved boundary. Neither may invent or silently resolve a new architectural, governance, authority, security-boundary, provider-eligibility, or business-policy decision.

> **Think deeply inside the approved boundary; stop at the boundary instead of crossing it.**

### Reasoning and task definition

1. Architectural reasoning belongs to Architect/Martin.
2. Implementation reasoning belongs to the coding agent once the governing intent is established.
3. Implementation reasoning includes repository and file mapping, implementation structure, types and interfaces, dependencies, edge cases, failure modes, tests, regression analysis, and checking that the implementation fits existing contracts.
4. A coding agent may challenge or report contradictions discovered during implementation, but must stop when resolving them would require a new architectural or governance decision.
5. For non-trivial tasks, the task instruction should establish, where applicable: the problem, approved design/decision, scope, no-change scope, boundaries, acceptance criteria, verification requirements, and execution authority.
6. An agent's plan is an implementation plan, not permission to redesign approved architecture.
7. Neither agent should invent requirements, expand scope, introduce a second mechanism, or generalize a local implementation need into a new platform abstraction without approval.

## The Handoff identity-write boundary

Every Handoff field that becomes another Unit's AI input context (Handoff title, Reason, Sources, Required Next Action, Expected Output, Acceptance Criteria, Assumptions, Open Questions, Verified Facts & Sources, and Work Completed) may identify the Entity/Matter only by the opaque `token:entity:<token>`/`token:matter:<token>` entries carried in the Handoff's own `Sources` property—never by the retired `Entity_Token`/`Matter_Token` Handoff properties (deleted from the live schema by LOG-1149, read and written by no code path), never by a canonical Entity/Matter page link standing in for a token binding (a link may cross-check a binding but never produce or replace one), and never by a real Entity/company name, contact name, email address, phone number, or other identifying detail. Real identity may be read while preparing a Handoff, but must be resolved to opaque token entries before anything is written.

Every production Handoff write goes through `src/handoffWriter.ts`'s `createHandoff`/`updateHandoff`, which require an operational Entity/Matter reference (a contracted `Sources` payload carrying the opaque token entries that route's contract requires, or a route explicitly declared generic by a contract that permits omitting them) and reject protected identity fields fail-closed. The retired `Entity_Token`/`Matter_Token` properties are not an alternative reference: omission of `Sources` cannot bypass a route contract's identity requirement, so a create whose route requires identity but whose payload carries no `Sources` (or a missing, partial, malformed or contradictory token pair) is refused at the writer with no Notion call, rather than written and then refused by every consumer. Canonical Entity/Matter links never substitute for the token binding, uncontracted routes remain fail-closed, and a legitimate lifecycle update that does not rewrite `Sources` is never forced to resubmit it. Do not write to the Handoffs database (`HANDOFFS_DATA_SOURCE_ID`) any other way. A Handoff created, updated, or resubmitted by hand through a Notion tool call bypasses that code path and must follow `handoff-writing-rules.yaml` in the repository root before writing anything, applying the same discipline every time.

## Authority model

- **Architect/Martin** remains the architectural and governance authority for ENIG.
- Both agents operate autonomously inside the boundary approved by Architect; Jules is not incapable of reasoning, but has a lower platform execution ceiling.
- Neither agent may redesign ENIG architecture, modify runtime behavior outside authorization, alter provider policy, introduce data-boundary logic, or reinterpret existing governance.
- Both agents must stop and report when a new architectural, governance, authority, security-boundary, provider-eligibility, or business-policy decision is required rather than inventing a rule.

## ENIG Runtime Architecture — mandatory reading

`docs/enig-operating-model.md` is the authoritative, binding description of ENIG Runtime's architecture (Units/Hats/Actions, the Action Registry, the Unit Manifest pattern, and Chat/Cowork dispatch semantics), not a proposal or background reading. Before creating or modifying a Unit, Hat, or Action, or touching `src/router.ts`, `src/units/dispatch.ts`, `src/units/unitManifest.ts`, `src/hats/actionRegistry.ts`, or dispatch/Handoff-adjacent code in `src/session.ts`, read that document.

- Never hardcode persona/governance content a Hat could instead load live from Notion. `src/governance.ts`'s `getGovernance` (live-fetched, cached, fail-closed) is the established pattern.
- Never add a second mechanism for how a capability gets triggered. The Unit Manifest / Action Registry (`src/hats/actionRegistry.ts`, `src/units/unitManifest.ts`, `src/units/dispatch.ts`) is the only sanctioned mechanism. `src/actions/registry.ts`'s `ActionCapability` mechanism has been retired; do not reintroduce it under any name.
- A discrepancy between the document and code is a bug in one of them, not acceptable drift. Fix it or flag it explicitly; never silently build around it.
- Any change that alters what the document describes updates the document in the same change, resolving the issue or adding it to the document's Open Questions list.
- These rules do not relax the Authority Model: a genuinely new architectural or governance decision still stops and returns to Architect.

## Concurrent development — mandatory reading

`docs/concurrent-development.md` is the authoritative guide for how independent coding sessions work on ENIG in parallel. Before touching `src/units/`, `src/types.ts`, `src/session.ts`, `src/index.ts`, `src/hats/`, or `src/runtime/`, read it.

- One session = one Git worktree **and** one branch, cut from a freshly fetched remote tip. A worktree isolates your working directory, not your architectural dependencies: two worktrees do not make two branches that change the same shared interface safe to merge.
- A Unit's own directory (`src/units/<Unit>/`) is edited by that session alone. Cross a Unit boundary only with a Handoff record whose shared formats live in `src/handoffContracts/` — never by importing another Unit's code.
- Generic infrastructure (`src/runtime/`, `src/platform/`, `src/dataBoundary/`, `src/ai/`) must stay Unit-free and compose with Units only through the shared contracts in `src/units/`. Declare a Unit-specific fact on its `UnitManifest`, never as a branch in generic code.
- `src/types.ts`, `src/handoffContracts/`, `src/records/`, `src/units/{registry,unitManifest,dispatch,awaitingDispatch,unitOperations}.ts`, `src/session.ts`, `src/index.ts`, `src/hats/` and `src/router.ts` are shared or integration-owned: announce a change to any of them, and never resolve a contract conflict by guessing.
- `src/handoffContracts/unitBoundary.test.ts` enforces these boundaries in `npm test` and in PR Validation. Run `npm run typecheck` and `npm test` before opening a PR; a green local run is not a green CI run, and a merged PR is not a deployed revision.

## Claude Code execution contract

Claude Code is trusted to execute the full engineering lifecycle inside the approved boundary. Its execution authority is **task-scoped**.

- If Martin says **implement only**, Claude Code implements, verifies, self-audits, fixes in-scope findings, and stops.
- If Martin explicitly authorizes **commit/push/open PR**, Claude Code may perform those actions after verification.
- If Martin explicitly says to **watch/babysit the PR through merge**, Claude Code may monitor CI, review, and merge state and continue the authorized workflow through merge.
- If Martin explicitly authorizes **deployment**, Claude Code may execute the approved deployment path and verify deployment and smoke tests.
- If only part of the lifecycle is authorized, Claude Code stops at that authorized completion state.
- Execution authorization never grants permission to make a new architectural or governance decision.
- Claude Code must report actual states rather than assuming them: commit SHA, remote push, PR URL, CI state, merge state, deployment state, and smoke-test result.
- If already-approved repository automation performs a later action, Claude Code may monitor it when the task explicitly asks it to watch the workflow, but must distinguish automated workflow progression from its own authority.

Claude Code must not commit, push, open a PR, merge, or deploy merely because those actions would be convenient or customary. The task instruction itself may explicitly grant the relevant authority; no separate approval beyond that task instruction is required.

## Jules execution contract and sandbox

Jules shares the same reasoning boundary above but has a deliberately lower platform execution ceiling. Jules may inspect, reason about implementation, implement, test, typecheck, build, self-audit, and create a local commit. After Martin's approval for submission, Jules may publish the approved work through its supported submission mechanism.

### Sandbox and submission mechanics

- Jules may inspect, read, and write repository files; execute local shell commands, tests, typechecks such as `npx tsc --noEmit`, and builds; create local branches and commits; and read remote history with operations such as `git fetch` and `git log`.
- Jules may execute Cloudflare API status checks such as `npx wrangler deployments list` and `whoami`, and post-deployment HTTP smoke tests with `curl`, but those checks do not authorize deployment.
- Direct `git push` commands in the sandbox are safety-blocked. Jules implements the approved change, verifies it, self-audits, creates a local commit, and stops for a pre-submission report.
- The pre-submission report covers scope, files changed, tests/typecheck/build results, self-audit results, and open questions. Martin may request changes; Jules addresses only approved in-scope changes, reruns verification, and reports again.
- Only after Martin explicitly approves the implementation for submission may Jules push the approved commit and invoke the built-in `submit` action with `branch_name`, `commit_message`, `title`, and `description`.
- Authorized Jules submission **MUST create a Draft PR**. Jules must stop at a Draft PR and must not independently mark it Ready for review, merge, deploy, or decide any later PR state. Draft PR is the only outcome of an authorized Jules submission.
- Jules must not independently alter the approved implementation during submission except for a submission-specific mechanical issue explicitly within approved scope.
- Jules must not claim that a PR was created or merged merely because a branch was pushed. If no PR URL or merge confirmation is returned, report those states as pending/unknown.
- After Martin reviews and marks the Draft PR Ready for review, configured repository automation may validate, merge, and deploy according to its approved rules. Jules must not bypass, replace, or reinterpret that workflow.

## Execution sequences

### Claude Code

`inspect → reason → implement → test → self-audit → fix in-scope findings → execute the explicitly authorized lifecycle → final evidence report`

The authorized lifecycle may include, depending on Martin's instruction: `commit → push → PR → watch checks/merge → deploy → smoke test`.

### Jules

`inspect → reason → implement → test → self-audit → fix in-scope findings → local commit → pre-submission report → Martin approval → publish/create Draft PR → stop`

## Self-audit and evidence

The responsible agent must verify task scope, architectural and governance boundaries, provider/data-boundary constraints, regression risk, tests, typecheck/build where applicable, configuration, public interfaces, and actual execution state. Findings may be fixed only when strictly inside approved task scope. A new architectural or governance decision requires stopping and reporting.

Reports must explicitly distinguish:

1. `local commit created`
2. `remote branch pushed`
3. `PR created / pending`
4. `PR merged / pending`
5. `production deployment`
6. `smoke test verified`

Never report an intended or prospective action as complete. Final evidence must include exact files changed, local commit SHA, confirmed remote branch state, PR URL if returned, merge confirmation, deployment state, validation/checks performed, and unresolved states or pending approvals.

## Task instructions and review

- Non-trivial tasks are written to `docs/task-instruction-template.md`. An instruction that omits the no-change scope, the boundaries or the verification commands is incomplete; ask for them before starting.
- **Live-state check.** Before relying on a Notion page, data source, secret, setting or other external resource, confirm it exists and is readable now. If it is missing or deleted, stop and report; never substitute hard-coded content for it.
- **Diff review.** Before reporting done, check the diff against this list and state the result for each:
  1. It stays inside the scope and does not touch the no-change scope.
  2. It adds no second mechanism for something that already has one.
  3. It hard-codes nothing that should be read live from Notion.
  4. `docs/enig-operating-model.md` is updated in the same change if the change alters what it describes.
  5. No test was weakened, skipped or deleted.
- Martin holds final authority over architecture and governance decisions; the Architect advises. The stop-and-report rule above still applies: an agent that meets such a decision stops and reports it to Martin.

## Provider and data-boundary constraints

- Provider selection is infrastructure policy, not business authority.
- AI output is not authority.
- Do not automatically send context to another provider merely because the primary provider fails.
- Do not introduce provider eligibility or fallback rules that have not been approved.
- Do not introduce automatic sanitization/redaction as an assumed universal solution.
- Do not silently downgrade a task to a less protective provider.
- Do not put provider-specific data handling inside individual Hats.
- If no eligible execution path exists, stop, hold, or use an explicitly approved human-controlled path.

These constraints, the Handoff identity-token boundary, fail-closed behavior, the Unit Manifest/Action Registry rule, mandatory operating-model reading, and synchronized documentation remain binding for both agents.
