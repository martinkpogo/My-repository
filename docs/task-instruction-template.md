# Task instruction template

Fill every field. Leave none blank; write "none" where it applies.

## Permissions: standing vs task-specific

The **standing permissions** in `AGENTS.md` ("Standing permissions and lifecycle restrictions") already grant every approved agent: local commits, pushes to its own working branch, and opening a Draft PR. Claude Code alone may additionally open a non-Draft PR after local verification. Do **not** write an instruction that re-asks for these actions — that is what "standing" means. Platform restrictions (Jules's sandbox, OpenCode's `deny` rules, Cline's approval controls) always apply on top.

An instruction uses the fields below to **narrow** standing permissions (for example "implement only — do not push") or to authorize something they do not cover (for example "watch through merge", "deploy"). Any narrowing or extension is explicit; nothing else changes.

## Assignment

1. **Problem:** what is wrong or missing, and how we know.
2. **Approved design or decision:** what to build, and who decided it.
3. **Scope:** files and behavior to change.
4. **No-change scope:** files and behavior that must stay exactly as they are.
5. **Boundaries:** rules not to cross (token-only identity, no new trigger mechanism, no provider changes, no hard-coded governance content).
6. **Live-state checks:** Notion pages, data sources, secrets or settings this relies on, to confirm exist before starting.
7. **Acceptance criteria:** testable statements.
8. **Verification:** exact commands, for example `npx tsc --noEmit`, `npm test`, `npx wrangler deploy --dry-run`.

## Authority and submission

9. **Execution authority and task-specific restrictions:** what the standing permissions do **not** already cover — for example "implement only, no push", "watch through merge", "deploy authorized", "no Notion changes", "no GitHub issue edits". Write "none" when the standing permissions suffice. Note that a non-Draft PR auto-merges once CI passes (the Auto Merge workflow skips Draft PRs).
10. **Stop rule:** if this needs a new architectural or governance decision, stop and report to Martin — bring the problem, the available options, and a recommendation.
11. **Expected submission:** the agent's submission type — `Draft PR (standing)` for OpenCode, Jules, Kilo Code, and Cline; `PR (Draft or non-Draft per standing permissions)` for Claude Code; or `implement only` when no submission is wanted.

## Handoff

12. **Completion report:** the standard handoff artifact. Write it into the **Draft PR description** (not only a comment), covering: (1) problem addressed, (2) implementation and rationale, (3) files changed and important changes, (4) tests/typecheck/other verification results, (5) self-audit findings and corrections, (6) known limitations and unresolved issues, (7) commit SHA and branch, (8) areas deserving reviewer attention.
13. **Review path:** if this task corrects someone else's open PR, say so and continue that PR's branch sequentially (`AGENTS.md` → "Draft PR handoff and review"; `docs/concurrent-development.md` §7) — never open a competing PR.
