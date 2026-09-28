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

Every Handoff field that becomes another Unit's AI input context (Handoff title, Reason, Required Next Action, Expected Output, Acceptance Criteria, Assumptions, Open Questions, Verified Facts & Sources, and Work Completed) may identify the Entity/Matter only by its opaque `Entity_Token`/`Matter_Token`—never a real Entity/company name, contact name, email address, phone number, or other identifying detail. Real identity may be read while preparing a Handoff, but must be resolved to tokens before anything is written.

Every production Handoff write goes through `src/handoffWriter.ts`'s `createHandoff`/`updateHandoff`, which require `Entity_Token`/`Matter_Token` and reject protected identity fields fail-closed. Do not write to the Handoffs database (`HANDOFFS_DATA_SOURCE_ID`) any other way. A Handoff created, updated, or resubmitted by hand through a Notion tool call bypasses that code path and must follow `handoff-writing-rules.yaml` in the repository root before writing anything, applying the same discipline every time.

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
