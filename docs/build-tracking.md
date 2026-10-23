# How ENIG's build is tracked

Approved by Martin on 2026-10-22. This repository's GitHub issues are the single tracker for ENIG build work. Notion holds the rules (ENIG HQ), the business records, and the Build Decision Record; it never states build status, it links to the issue instead.

## The plan

The approved build plan runs in dependency order: Stage 0 → Stage 1 → Stage 2 → Stage 3, then Lane A (prove the core) and Lane B (attract clients) side by side, then Stage 4. Each stage or lane is a milestone; each step is one issue. Captured ideas sit in the `Later` milestone with `status: idea`.

## Status

| Label | Meaning |
| --- | --- |
| *(no status label)* | Planned; waiting for the steps it depends on |
| `status: idea` | Captured; not approved to start |
| `status: ready` | Martin approved the plan for it and its dependencies are done; can start |
| `status: in progress` | Someone is working on it |
| `status: in review` | Handed in; the Checker confirms, then Martin signs off |
| `status: blocked` | Cannot move until the named blocker clears |
| *(closed)* | Done: finish line met, evidence linked, Martin signed off |

`needs: martin` marks anything waiting on Martin's decision, approval or action.

## Rules

1. **Work only from an issue.** If it is not in the tracker, it is not being worked on.
2. **One ID everywhere.** The issue number appears in the branch name (`enig-<number>-<short-name>`), the pull request (`Refs #<number>` — never a GitHub closing keyword such as `Closes #<number>`, so merging never auto-closes the issue; an issue closes only under rule 7), the builder instruction and the evidence.
3. **Every issue has a finish line before it starts.**
4. **Small items.** One builder session and one pull request each; split anything bigger.
5. **At most two items in progress at once:** one with a builder, one with Martin.
6. **One branch per issue,** deleted when merged. A branch untouched for 14 days is picked up or closed at the weekly review.
7. **Done means signed off with evidence.** A merged pull request or a builder's report is not enough on its own.
8. **Modularity test.** Each finish line includes the relevant rows of the modularity test in the ENIG Modular Build Review: a change touches only what the test allows.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Owner | Martin | Sets priorities, approves plans before work starts, signs off results |
| Planner | ENIG Architect (ChatGPT project) | Inspects Notion and GitHub, drafts issues and builder instructions, records decisions |
| Builder | Claude Code or Jules | Builds one approved issue on its own branch; can create issues Architect drafts |
| Checker | A fresh session that did not build it | Confirms the evidence meets the finish line before Martin signs off |

## Rhythm

- **Start of a session:** open the in-progress and ready lists below; take the top approved item.
- **End of a session:** update the issue's status label and add a two-line comment: what changed, what is next.
- **Weekly review (Friday):** clear `needs: martin`, triage ideas, close stale branches, choose next week's items.
- **Milestone review:** confirm the milestone's finish line; record it in the Build Decision Record.

## Saved views

- In progress: https://github.com/martinkpogo/My-repository/issues?q=is%3Aopen+label%3A%22status%3A+in+progress%22
- Ready to start: https://github.com/martinkpogo/My-repository/issues?q=is%3Aopen+label%3A%22status%3A+ready%22
- Waiting on Martin: https://github.com/martinkpogo/My-repository/issues?q=is%3Aopen+label%3A%22needs%3A+martin%22
- By stage: https://github.com/martinkpogo/My-repository/milestones
