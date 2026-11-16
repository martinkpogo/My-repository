# Task instruction (DRAFT, awaiting Martin's approval): Hat-written deep research brief

Status: **approved by Martin (16 Nov 2026) with all four recommendations (A–D); execution authority: implement, open a PR, watch through merge.** The decisions at the end are resolved as recommended.

## 1. Problem

Hats use the shared Research Runtime when their work needs it, but:

- **Light research** already runs automatically before a Hat's output step (universal web research, 11 Nov 2026, `src/runtime/webResearch.ts`). This is correct, and Martin has confirmed it stays automatic.
- **Deep research** for a Hat's work starts only when Martin taps "🔬 Deep research" on a research card (`src/session.ts` `handleResearchButton`, value `deep`). It starts at once, on the same one-line question, with no brief. Martin can't see or shape what will be researched, and the Hat never says why deeper research would help its work.
- A Hat never proposes deep research itself. It can't say "to do B, I need to research X", so Martin has to notice that more research is needed.

The `/research` brief flow (questions, then a brief with Start / Edit / Fix typos) is the right approval shape. Today it exists only for Martin's manual research.

## 2. Approved design or decision

Martin, 16 Nov 2026 (this conversation):

1. **Light research stays automatic**, unchanged from 11 Nov.
2. **Deep research needs Martin's permission, through a brief the Hat writes.** When a Hat's work would benefit from deep research, the Hat writes a research brief within its own responsibilities and shows it to Martin. The brief says what the research is for, then lists topic and answers, using the same brief card as `/research`. Martin approves (Start), edits (Edit, Fix typos) or declines (Skip research). Nothing is searched before he approves.
3. **Two ways in, one brief.** `/research` stays as it is, for Martin's manual research: he answers the questions. In the Hat-led path the Hat fills in the answers. The brief card, Edit, typo suggestions, identity checks and the research run are the same code.
4. **Hats use the shared feature; they don't own it.** The Hat writes the brief from its own governance and role, through its existing declared Action. No Hat owns research, and there is no research Hat or research Action (15 Nov rule, unchanged).

## 3. Scope

- **Shared brief module.** Move the brief card out of `src/runtime/operatorResearch.ts` into a shared `src/runtime/researchBrief.ts`, covering:
  - rendering;
  - Edit (line buttons, Start over);
  - typo suggestions (Fix typos / Start as is);
  - the identity checks.

  `/research` keeps its exact behaviour on top of it.
- **Hat-written brief.** When the existing research-need check (`runtime.research_need`, run inside the Hat's own output step) judges that deep research would materially help, it returns a brief: topic, "needed for", and 2 to 5 lines answered from the Hat's step context. The Hat then holds its draft. It uses the existing pause path: stage `awaiting_research`, as Marketing does today in `src/units/marketing/marketingManifest.ts`.
- **Brief card on the Hat's Work**, with `[▶️ Start deep research]` `[✏️ Edit]` `[⏭ Skip research]`, plus Fix typos when suggested.
  - **Start:** schedules deep research on the Work's own alarm (`PendingResearch` with `brief`, the existing `runPendingResearch` / `resumeDeepResearch` path).
  - **Skip:** continues the Hat's work without deep research through `continueAfterResearch`, and the output says deep research was skipped.
- **Martin's own Deep research tap** on an existing research card now opens a Hat-written brief for approval instead of starting at once.
- **Continue after research.** Once the deep research completes, the Hat continues through its declared `continueAfterResearch` with the findings. Whether that happens automatically or needs a "Continue to draft" tap is open decision A.
- **Hats in scope:** Hats that declare `continueAfterResearch`. Today that's the Marketing Hats only. Other Hats keep today's behaviour until they declare it.
- **Docs:** `docs/enig-operating-model.md` (universal web research, Deep Research, Martin-started research, and the Unit Manifest `continueAfterResearch` entry), in the same change.

## 4. No-change scope

- Light research: when it runs, its limits, its "Research more" card and its daily allowance.
- `/research` and `/deep_research`: the same questions, brief, buttons and results (only refactored onto the shared module).
- The Research Runtime's evidence gate. The Hat path keeps the strict gate unless Martin decides otherwise (open decision B).
- Access contexts, data-boundary task sensitivities and provider routes: no new task ID unless the research-need check cannot carry the brief. If it can't, stop and ask, because a new task ID is a provider/data-boundary decision.
- Hats that don't declare `continueAfterResearch`.
- `src/handoffWriter.ts` and every Handoff path.

## 5. Boundaries

- **No second trigger mechanism.** The brief comes from the research-need check that already runs in the Hat's output step, through the Hat's declared Action. The resume uses `continueAfterResearch` (Unit Manifest). There is no new router branch and no Unit name in generic code.
- **Data boundary.** The brief becomes public web searches. It may carry only what the Hat's step already holds in token-safe form and its governance. It must never carry client identity (names, emails, phones, links, record tokens). Every brief line passes the same checks as `/research`: `identityProblem` plus the names-a-party flag. A line that fails is dropped and shown to Martin to rephrase, never rewritten.
- **AI output is not authority.** The brief is a proposal. Nothing is searched before Martin taps Start.
- **No hard-coded governance.** The Hat's role comes from what the step already loads.
- **Fail closed.** If no usable brief comes back, deep research is not offered, and the Hat continues with light research as today.

## 6. Live-state checks (before starting)

- The Research-Safe Consultancy Context page (`requireSafeContext`) is readable.
- The research role contract and Universal Role Contract pages are readable.
- The ENIG Consultancy Profile is readable (`businessContext.ts`).
- `RESEARCH_DATA_SOURCE_ID` is set, if decision C saves Hat research there.

## 7. Acceptance criteria

1. A Marketing Hat's output step whose research-need check recommends deep research holds its draft (`awaiting_research`) and sends the brief card. The card shows what the research is needed for, the topic and the lines, and nothing has been searched.
2. Start schedules deep research with the brief as `brief` (framing, not evidence). After completion, the Hat continues per decision A.
3. Edit and Fix typos behave exactly as in `/research`.
4. Skip continues the Hat's work without deep research, and the output says so.
5. Martin's Deep research tap on a research card opens a Hat-written brief and does not start research.
6. A brief line carrying a token, email, phone, link, ENIG's or Martin's name, or a named party never reaches the card. Martin is asked to rephrase it.
7. Light research behaves exactly as before (existing tests pass unchanged).
8. `/research` and `/deep_research` behave exactly as before (existing tests pass unchanged).
9. A Hat without `continueAfterResearch` behaves exactly as before.

## 8. Verification

- `npx tsc --noEmit`
- `npm test` (including `src/handoffContracts/unitBoundary.test.ts`)
- New tests for criteria 1–6 and 9.
- After deploy: a Marketing request that needs research. Check the brief card, then Start, then a completed draft. Then repeat and tap Skip.

## 9. Execution authority

To be set by Martin. Proposed: implement, commit, push, open a PR, and watch it through merge. Note that the PR auto-merges once CI passes, and merging triggers deploy.

## 10. Stop rule

If any part needs a new architectural, governance, data-boundary or provider decision beyond those approved above, stop and report to Martin. That includes a new AI task ID, a Hat reading client records into the brief, or a change to the evidence gate for Hat research.

---

## Open decisions for Martin

- **A. After deep research completes,** does the Hat continue its work automatically, or wait for a "Continue to draft" tap? *Recommendation: automatically. You already approved the brief.*
- **B. The evidence rule for Hat deep research.** Keep the strict rule (one unsupported finding rejects the result), or drop uncited findings with a note, as `/research` now does? *Recommendation: the same as `/research`, for consistency, since the brief is now framing on both paths.*
- **C. Where findings go.** The Work only, with a 24-hour cache as today, or also a page in the Research database? *Recommendation: also the Research database, so Hat research isn't lost after 24 hours.*
- **D. How often a Hat may propose deep research.** *Recommendation: at most once per Work, so it can't keep asking.*
