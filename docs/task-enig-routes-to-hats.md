# Task instruction: ENIG routes work to the owning Hat

Status: **approved by Martin (16 Nov 2026)**, option 1a: automatic, and ENIG asks when it is unsure. Execution authority: implement, open a PR, watch it through merge. The PR auto-merges once CI passes, and merging deploys.

> **Superseded for the confirm step (Martin, 17 Nov 2026).** A `ROUTE:` line no longer re-routes on its own: the runtime asks "Enter Cowork as <Hat>?" with Enter Cowork / Not now buttons, and only Martin's tap switches the thread to Cowork and starts the work as that Hat (an `ASK:` pick still starts immediately, in Cowork). A thread entered this way reverts to Chat when that Work closes. Acceptance criteria 1 and 2 above read "Passing this to <Hat>." and "a tap routes that Hat" as the 16 Nov behaviour; the confirmation replaced that wording only. Everything else in this instruction -- exact startable names only, ASK candidates, no loop back to ENIG, no new AI task, no data-boundary change -- stands. Current spec: the "ENIG names the owning Hat, Martin confirms entering Cowork as it" bullet in `docs/enig-operating-model.md`.

1. **Problem.** An unaddressed work request ("create a marketing campaign offering free consultancy…") was answered by ENIG itself, with a full plan, instead of by the Hat that owns it. No owner was started. Martin doesn't want to name Hats.
2. **Approved decision.** This replaces the 9 Nov "ENIG suggests, Martin confirms" rule.
   - ENIG never does the work. For a work request it routes to the owning Hat **automatically**, through the same dispatch a typed "<Hat>, <message>" takes.
   - When two or three Hats could own the work, ENIG asks Martin to pick, one button per Hat.
   - Questions and status checks stay ENIG's own answers.
3. **Scope.**
   - `src/enigSuggestion.ts`: the instruction, the parser (`ROUTE:` / `SUGGEST:` / `ASK:`), the choice buttons, and consuming a choice.
   - `src/chat.ts` (`enigChatReply`).
   - `src/router.ts` (`deliverEnigReply`, the `routedByEnig` guard).
   - Tests and `docs/enig-operating-model.md`.
4. **No-change scope.**
   - Deterministic Workspace routing (`src/workspaceRouter.ts`), Action Resolution, every Hat, every approval gate and the Result Gate.
   - The business snapshot, the morning brief, and old Yes/No buttons still in the wild, which keep working.
5. **Boundaries.**
   - Only exact, startable names from `suggestableAddressees()`, so the paused Sales Executive is never routed.
   - There's no new dispatch path: a route re-sends the addressed text through `routeIncomingText`.
   - There's no loop back to ENIG.
   - No new AI task and no data-boundary change.
6. **Live-state checks.** The ENIG definition page and the Universal Role Contract are read live, as now. If either is unreadable, it fails closed as now.
7. **Acceptance criteria.**
   1. A work request with one clear owner is announced with "Passing this to <Hat>." and re-routed as "<Hat>, <message>". ENIG's own plan is never shown.
   2. An unsure request shows one button per valid candidate plus "None of these". A tap routes that Hat, once only.
   3. A plain answer routes nothing.
   4. An invalid or paused name routes nothing.
   5. The morning brief carries no routing instruction.
8. **Verification.** `npx tsc --noEmit`, `npm test`. After deploy, Martin sends an unaddressed work request in the Workspace topic and checks that the Hat responds.
9. **Execution authority.** Implement, open a PR, watch it through merge.
10. **Stop rule.** If routing needs a new AI task, data-boundary change or dispatch path, stop and report.
