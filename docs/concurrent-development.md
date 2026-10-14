# Concurrent Development Guide

How two or more coding sessions work on ENIG at the same time without creating
avoidable merge conflicts, architectural coupling, or unsafe integration.

This describes the structure that already exists. It does not introduce a new
registry, router, or capability mechanism — the **Unit Manifest / Action
Registry** remains the only sanctioned way a capability is triggered.

## 1. One session = one worktree + one branch

Each concurrent session gets its own Git worktree **and** its own branch:

```bash
git fetch origin
git worktree add ../enig-marketing -b feat/marketing-x origin/claude/notion-cloudflare-telegram-agents-nsi40m
```

Work inside that directory. Remove it when the work merges:

```bash
git worktree remove ../enig-marketing
```

> **A worktree isolates your working directory, not your architectural
> dependencies.** Two worktrees let two sessions edit files side by side. They
> do **not** make two branches that both change the same shared interface safe
> to merge. If both branches edit `UnitManifest`'s shape, both build cleanly
> alone and conflict on integration. Isolation of *files* is not isolation of
> *contracts* — that is what the ownership rules below are for.

Always branch from a freshly fetched remote tip, not a branch you had lying
around. A stale base is the most common source of "my change broke unrelated
work" reports.

## 2. Ownership layers

| Layer | Paths | Who may change it |
|---|---|---|
| **1. Unit-owned** | `src/units/<Unit>/**` | That Unit's session, alone |
| **2. Shared contracts** | `src/handoffContracts/**`, `src/records/**`, `src/types.ts` | Coordinated — see §4 |
| **3. Generic runtime** | `src/runtime/**`, `src/platform/**`, `src/dataBoundary/**`, `src/ai/**` | Coordinated — must stay Unit-free |
| **4. Composition points** | `src/units/{registry,unitManifest,dispatch,awaitingDispatch,unitOperations}.ts`, `src/hats/actionRegistry.ts` | Coordinated — see §4 |
| **5. Integration-owned** | `src/index.ts`, `src/session.ts`, `src/router.ts`, `src/hats/registry.ts`, `src/hats/executionEngine.ts`, `src/googleDocComments.ts`, `wrangler.toml`, `.github/workflows/**` | Coordinated — highest conflict cost |

A **Unit** is a subdirectory of `src/units/`: `businessDevelopment`,
`finance`, `marketing`, `sales`, `strategy`. They are discovered from the
filesystem by the boundary tests, so a new Unit is covered the day it appears.

### What a Unit session owns outright

Everything under `src/units/<Unit>/`: its manifest, Hats, handlers, state
module, types, and tests. Edit freely. No other session should be touching
these files, so they will not conflict.

### What a Unit session must NOT do

- Import another Unit's code. Cross a boundary with a **Handoff record**, whose
  shared formats live in `src/handoffContracts/`. Strategy reads approved Call
  Notes through `src/records/callNotes` — a governed Business Object no single
  Unit owns — never through Sales's code.
- Add Unit-specific branching to generic runtime. Declare the fact on your
  `UnitManifest` instead (Hats, actions, `handoffPickup`, `operations`,
  `awaitingHandlers`, `callbackHandlers`, `migrateWorkState`).

## 3. Enforced boundaries

`src/handoffContracts/unitBoundary.test.ts` runs in `npm test` and in PR
Validation. It inspects **production source**, so it holds regardless of how a
test file is arranged.

**1. No Unit's production code imports another Unit.**
Resolved by path, not string matching, so it is depth- and form-independent:
`../finance/x`, `../../../units/finance/x`, and `./sales/x` are all caught. The
earlier string pattern silently passed the deeper forms.

**2. Generic infrastructure imports no Unit implementation.**
`runtime`, `platform`, `dataBoundary`, `ai`, `records`, and `handoffContracts`
may depend only on the shared contracts directly in `src/units/`. This is what
keeps a Marketing session from colliding with a Sales session inside the runtime
both need.

**3. The guard itself is not evadable** by import form, path depth, or
doc-comment prose quoting a path.

**4–7.** The neutral contracts module imports no Unit; generic Handoff
discovery and pickup scheduling name no Unit; the Call Notes record module
imports no Unit; `WorkSession` carries no Sales code.

## 4. Changing a shared contract

Shared contracts and composition points are the files every branch can need.
Treat any change to them as a coordination event.

1. **Say so first.** Announce the change — target branch, the exact files, and
   the shape you intend. If another session is mid-flight on the same contract,
   one of you rebases.
2. **Change it once, additively where possible.** An optional field or a new
   declared operation is mergeable by every other branch. Renaming or removing
   one forces every branch to rebase.
3. **Never silently reinterpret a contract.** `AGENTS.md` governs this: a
   discrepancy between `docs/enig-operating-model.md` and code is a bug in one
   of them, not drift to build around. A change that alters what the operating
   model describes updates that document in the same change.
4. **New Unit?** Register it in `src/units/registry.ts` (one import, one entry)
   and add its state slice to `WorkState` in `src/types.ts`. Both are expected,
   small, and reviewable — but they are exactly the lines two sessions will
   both touch, so coordinate them.

## 5. Conflict handling and reconciliation

- **Never resolve a conflict in a shared contract by guessing.** Re-read both
  intents. If both sides changed the contract's *meaning*, stop and return to
  Architect/Martin rather than picking one.
- **Rebase early, rebase often.** Rebase your branch onto the fresh remote tip
  before opening a PR, and again if your PR sits while others merge.
- **After rebasing, re-run the full local checks.** A rebase can introduce a
  conflict that compiles but violates a boundary.
- **Work-state compatibility is a contract too.** Saved Work persists across
  deployments. A Unit that changes its state shape declares `migrateWorkState`
  on its manifest so in-flight Works convert on their next save
  (`src/workStateMigration.ts`). Do not assume a fresh shape is safe to store.

## 6. Required checks before integration

Locally, before opening a PR:

```bash
npm run typecheck
npm test
```

Both must pass. PR Validation runs the same two commands and gates Auto Merge
on them; a green local run is **not** a green CI run, and a merged PR is **not**
a deployed revision.

Review your own final diff before pushing. Confirm every changed file belongs to
your task. Unrelated edits — even opportunistic cleanups — belong in their own
change, or they make someone else's rebase needlessly hard.

## 7. Approval gates, Handoffs, and deployment

These are not negotiable in the name of speed:

- **Access and approval rules**, Work ownership, Handoff routing, and lifecycle
  semantics do not change to make a feature fit. Architect/Martin owns them.
- **Handoff identity tokens.** Any Handoff field that becomes another Unit's AI
  input identifies the Entity/Matter only by `Entity_Token`/`Matter_Token`.
  Production Handoff writes go through `src/handoffWriter.ts`'s
  `createHandoff`/`updateHandoff`, fail-closed.
- **Fail-closed stays.** A missing manifest entry, unknown action, or unresolved
  Responsibility refuses. Do not add a fallback that guesses.
- **Deployment** happens only through the merged-PR pipeline. No direct
  production changes, no bypassing CI or merge protections.
- **Jules submissions are Draft PRs** and stop there; Martin marks them ready.

## 8. Known integration-owned coupling

These are real and deliberately **not** refactored here — each would be a
material architecture change, so they are documented rather than papered over:

- `src/index.ts` imports two Sales modules (`leadDiscovery`,
  `leadGenerationDiscovery`) for the `/lead` command and autonomous discovery.
- `src/session.ts` imports Marketing's `handleMarketingIntake` and Strategy's
  `strategyOf`. The Sales-specific guard does not cover these.
- `src/hats/registry.ts` imports five Marketing Hat identity constants;
  `src/hats/executionEngine.ts` imports `dispatchMarketingHat` and `marketingOf`.
  Marketing's Stage 1/2 resolution has no generic equivalent in `resolveHat`.
- `src/googleDocComments.ts` imports Sales's `salesOperations`.

If you are working in one of these files, **announce it** — a concurrent branch
touching the same file will very likely conflict.

`src/types.ts`'s `WorkState` Unit slices use type-only `import(...)` so they
cost nothing at runtime and do not create a module cycle, but every Unit that
adds state still edits those lines. Treat `types.ts` as shared.

**Two test files cross Unit boundaries** (`units/sales/tokenSafeProposal.test.ts`
↔ `units/finance/valueBasedPricingAssessor.test.ts`, sharing pricing fixtures).
They are excluded by the production-only rule on purpose; if you touch either,
expect the other to conflict.

Removing the coupling above is a separate architectural decision owned by
Architect/Martin, not a cleanup for a feature branch.
