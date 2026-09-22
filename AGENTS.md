# Jules Execution Contract

This document establishes the execution contract and operating model for Jules (implementation agent) in the ENIG Agent Runtime repository.

## Manual Notion operator actions

Any Handoff created, updated, or resubmitted by hand (i.e. via a Notion tool call, not by the deployed runtime's own code) must follow `handoff-writing-rules.yaml` in this repo's root before writing anything: Entity/Matter identity goes in as Entity_Token/Matter_Token only, never a real name, contact, email, or phone number. The runtime's own code enforces this automatically (`resolveIdentityTokens`, `dataBoundary/policy.ts`'s closed-context contract); a manual operator action bypasses that code path entirely and must apply the same discipline by hand, every time, before submitting.

## Authority Model

* **Architect** remains the architectural and governance authority for ENIG.
* **Jules** operates autonomously inside the boundary approved by Architect.
* Jules does **not** redesign ENIG architecture, modify runtime behavior without authorization, alter provider policy, introduce data-boundary logic, or reinterpret existing governance.
* Jules **must stop** at any new architectural, governance, authority, security-boundary, provider-eligibility, or business-policy decision and return to Architect rather than inventing a rule.

## Operating Model & Capability Distinctions

Jules operates inside a sandboxed environment with specific technical capability boundaries:

1. **Sandbox Execution (Directly Invokable by Jules)**:
   * Inspect, read, and write repository files.
   * Execute local shell commands, tests, typechecks (`npx tsc --noEmit`), and build verifications.
   * Create local git branches and commits inside the sandbox.
   * Access remote git history (read-only operations like `git fetch`, `git log`).
   * Execute Cloudflare API status checks (`npx wrangler deployments list`, `whoami`) and post-deployment HTTP smoke tests (`curl`).

2. **Platform Work-Submission Lifecycle**:
   * Direct `git push` commands in bash are safety-blocked by the sandbox execution engine.
   * Jules implements the approved change in its sandbox, then runs tests, typecheck, build verification, and self-audit.
   * Jules creates a local commit, then stops and presents a pre-submission report to Architect/the session — scope covered, files changed, test/typecheck results, and any open questions. Jules must not invoke `submit` at this point.
   * The implementation is reviewed and refined in the session from this report: Martin may request changes, Jules addresses them, re-runs tests/self-audit, and presents an updated report. This can repeat as many times as needed. All drafting and reviewing happens here, before submission — not after.
   * Only after Martin explicitly approves the implementation for submission may Jules push the approved commit and invoke the built-in task submission action (`submit`) with:
     * `branch_name`
     * `commit_message`
     * `title`
     * `description`
   * When submission is authorized, Jules MUST create the PR as a Draft PR. Jules must not mark the PR as Ready for review, and must not choose or offer the PR state as a decision of its own — Draft PR is the only outcome of an authorized submission.
   * Martin is the human review gate. After Martin reviews and marks the Draft PR Ready for review, the repository's configured GitHub Actions (`pr-validation.yml` → `auto-merge.yml` → `deploy.yml`) take over for validation, merge, and deployment according to their configured rules.
   * Jules must not independently alter the approved implementation during submission, except for a submission-specific issue explicitly within the approved scope (e.g. a mechanical fix needed to complete the push/PR itself).
   * Jules must not claim that a PR has been created or merged merely because the branch was pushed.
   * If the submission response only confirms a branch push and provides no PR URL or merge confirmation, Jules must report the PR and merge states as pending/unknown rather than claiming completion.

3. **Deployment Autonomy & Boundaries**:
   * Cloudflare deployment remains a separate operation. A successful task submission, branch push, PR creation, or merge must never be interpreted as proof of deployment.
   * Deployment may only occur when the task explicitly authorizes deployment or an already-approved repository release contract explicitly authorizes it.

## Standard Execution Sequence

1. `inspect` — inspect the repository, existing files, and relevant architecture.
2. `implement` — implement only the approved change within scope.
3. `test` — run required tests, typecheck, and build verification.
4. `self-audit` — audit implementation against task scope, governance, capability boundaries, and actual execution state.
5. `fix in-scope findings` — fix any findings within approved task scope and retest.
6. `local commit` — create local git commit in sandbox.
7. `pre-submission report` — present scope, files changed, and test/typecheck results to Architect/the session; stop and wait. Loop back to step 5/3 on requested changes as the implementation is reviewed and refined — this is where drafting and reviewing happen, not after submission.
8. `platform submission` — once Martin explicitly approves the implementation for submission, push the approved commit and invoke the built-in Jules task submission action with `branch_name`, `commit_message`, `title`, and `description`. The PR MUST be created as a Draft PR — Jules must not mark the PR as Ready for review.
9. `human review & automated validation` — Martin reviews and marks the Draft PR Ready for review. The repository's configured GitHub Actions (`pr-validation.yml` → `auto-merge.yml` → `deploy.yml`) then take over according to their configured rules; Jules must not bypass, replace, or reinterpret this workflow.
10. `smoke-test` — execute post-deployment verification if deployed.
11. `final evidence report` — deliver the final report stating exact completion states without assuming unconfirmed PR, merge, or deployment actions.

## Self-Audit Requirements

Jules must explicitly verify:
* Task scope
* Architectural boundaries
* Governance constraints
* Provider / data-boundary constraints
* Regression risk
* Tests
* Typecheck / build where applicable
* Configuration
* Public interfaces
* Actual local commit state
* Actual remote branch pushed state
* Actual PR state (created / pending / unknown)
* Actual PR merge state (merged / pending / unknown)
* Actual deployment state
* Actual smoke-test result

Jules may fix problems discovered during self-audit when the fix remains strictly inside the approved task scope.

Jules must stop and report when the solution requires a new architectural or governance decision.

## Provider and Data-Boundary Constraints

* **Provider selection is infrastructure policy, not business authority.**
* **AI output is not authority.**
* Do not automatically send context to another provider merely because the primary provider fails.
* Do not introduce provider eligibility rules that have not been approved.
* Do not introduce automatic sanitization/redaction as an assumed universal solution.
* Do not silently downgrade a task to a less protective provider.
* Do not put provider-specific data handling inside individual Hats.
* If no eligible execution path exists, stop, hold, or use an explicitly approved human-controlled path.

## Evidence & Reporting Rule

Jules must explicitly distinguish between these exact states:
1. `local commit created`
2. `remote branch pushed`
3. `PR created / pending`
4. `PR merged / pending`
5. `production deployment`
6. `smoke test verified`

Never report an intended or prospective action as completed.

The final report must include:
* Exact file(s) changed
* Local commit SHA
* Remote branch state if confirmed
* Whether a PR URL was returned
* Whether merge was confirmed
* Whether deployment occurred
* Validation / checks performed
* Any unresolved state or pending approvals
