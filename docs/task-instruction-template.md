# Task instruction template

Fill every field. Leave none blank; write "none" where it applies.

1. **Problem:** what is wrong or missing, and how we know.
2. **Approved design or decision:** what to build, and who decided it.
3. **Scope:** files and behavior to change.
4. **No-change scope:** files and behavior that must stay exactly as they are.
5. **Boundaries:** rules not to cross (token-only identity, no new trigger mechanism, no provider changes, no hard-coded governance content).
6. **Live-state checks:** Notion pages, data sources, secrets or settings this relies on, to confirm exist before starting.
7. **Acceptance criteria:** testable statements.
8. **Verification:** exact commands, for example `npx tsc --noEmit`, `npm test`, `npx wrangler deploy --dry-run`.
9. **Execution authority:** implement only / commit and push / open PR / watch through merge / deploy. Note that a PR auto-merges once CI passes.
10. **Stop rule:** if this needs a new architectural or governance decision, stop and report to Martin.
