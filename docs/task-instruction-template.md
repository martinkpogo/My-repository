# Task instruction template

Fill every field. Leave none blank; write "none" where it applies.

## Permissions: standing vs task-specific

The **standing permissions** in `AGENTS.md` ("Standing permissions and lifecycle restrictions") already grant every approved agent: local commits, pushes to its own working branch, and opening a Draft PR. Claude Code alone may additionally open a non-Draft PR after local verification. Do **not** write an instruction that re-asks for these actions — that is what "standing" means. Platform restrictions (Jules's sandbox, OpenCode's `deny` rules, Cline's approval controls) always apply on top.

An instruction uses the fields below to **narrow** standing permissions (for example "implement only — do not push") or to authorize something they do not cover (for example "watch through merge", "deploy"). Any narrowing or extension is explicit; nothing else changes.

A task instruction may narrow standing permissions or authorize additional actions **only where the agent's individual contract permits them** — it can never override an absolute restriction of that contract. In particular, no task instruction can authorize OpenCode, Jules, Kilo Code, or Cline to mark a PR Ready for review, merge, or deploy; those agents stop at the Draft PR no matter what the instruction says.

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

## Staged instructions (preferred layout for implementation tasks)

This is a layout for the fields above, not a replacement: every field 1–13 is still required. It is the preferred way to write a bounded implementation task for any agent, and the default for agents that have shown recurring verification gaps (see the agent profiles in `AGENTS.md`). It was adopted after the Drive-browser work (PR #487), where the staged version of a task was delivered complete and verified while unstaged versions of the same task were not.

Write the instruction in this order:

1. **Start-of-work report.** The agent states its environment, working directory, branch, HEAD commit and available tools before editing anything.
2. **Branch block.** The exact commands to reach the starting point, each followed by the check that proves it, for example `git status -sb` (no changed files) and `git log --oneline -1` (must show `<sha>`). If a check fails, the agent stops.
3. **Rules for this session.**
   - Stages run in order. After every stage the agent runs the stated checks (typecheck and the relevant test files) and pastes the summary lines; it does not start the next stage until they are green.
   - The exact command for running only the new tests (for example `--test-name-pattern="Task N:"`).
   - A retry limit: if something is still red after two fix attempts, stop, paste the output and wait.
   - No force-push, rebase or amend; the expected number of new commits.
   - Report only what pasted output proves.
4. **Background.** What already exists and must not be changed, by function name, and the production path to trace before editing (entry point → shared boundary → the function being changed).
5. **Stages.** One stage per independently checkable change, each giving the exact behaviour, the exact user-facing text, and what must not happen (for example "no Drive call", "no storage write").
6. **Test stage.** Each test as a testable statement, a shared title prefix so the tests can be counted, the existing helpers to reuse by name, and the test-input pattern to follow.
7. **Self-check stage.** Commands whose output makes missing work obvious: typecheck, the full suite, a `grep -c` of the new test titles with the expected count, a `grep` for each required string or call, and `git diff <start-sha> --stat` limited to the in-scope files. Known environmental failures are named so that any other failure counts.
8. **Commit, push and report stage.** `git add` with explicit file names (never `-A`), the commit message, one CI check after the push (never claim CI passed without seeing it), and the completion report (field 12) added to the PR description without rewriting earlier sections.
9. **Scope, no-change scope and authority** (fields 3, 4 and 9) restated in one block at the end, followed by "When done, STOP. Do not begin the next task."

Fields 1, 2, 5–8, 10, 11 and 13 that the stages do not already state are added in a short block labelled with the field numbers, so a reviewer can check the instruction against this template.
