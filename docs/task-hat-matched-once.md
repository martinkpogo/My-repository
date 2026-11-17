# Task instruction: match the Hat once, on responsibilities; the confirmed Hat is final

Status: **approved by Martin (17 Nov 2026).** Execution authority: implement, open a PR, watch it through merge. The PR auto-merges once CI passes, and merging deploys.

1. **Problem.** Martin describes work and never names a Hat. ENIG matched one, e.g. Marketing Strategist, and he confirmed it. Then Marketing's intake matched again from scratch, disagreed, and asked "I'm not sure which Marketing Hat this belongs to… can you clarify?". On top of that, ENIG matched on each Hat's terse responsibility line only.
2. **Decision.**
   - Match once, against every Hat's declared responsibilities, for every Unit.
   - One match: the Enter-Cowork offer.
   - Several: "which?" buttons, each with what the Hat does.
   - None: ENIG answers.
   - The Hat Martin confirms is final. If it's wrong, the Hat itself proposes a transition.
3. **Scope.**
   - `src/chat.ts`: `hatDuties` / `hatDutySummary` in the structure facts, and the descriptions on ASK candidates.
   - `src/router.ts`: `dispatchCowork` takes `confirmedHat` (from `routedByEnig`), plus `withoutAddressee`.
   - `src/session.ts`: `handleConfirmedMarketingRequest`.
   - `src/units/marketing/marketingManifest.ts`: `startConfirmedMarketingHat`.
   - Tests and docs.
4. **No-change scope.**
   - Typed "<Hat>, …" and "Marketing, …" messages (Marketing intake unchanged), and `resolveOrganization`.
   - Every Hat's decision and its approval and transition gates, the Result Gate.
   - No new AI task, data-boundary change or dispatch path. The option-C tie-break commit is reverted.
5. **Boundaries.** Responsibilities come only from code declarations; nothing is copied from Notion. The smoke-test Action is never offered. A non-Marketing-Hat "confirmed" Work falls back to the normal intake.
6. **Live-state checks.** None beyond today's: the ENIG definition and the Universal Role Contract are read live, as now.
7. **Acceptance criteria.**
   1. The structure facts carry each Hat's full declared duties.
   2. ASK candidates are listed with what each does.
   3. A confirmed Marketing Hat starts with no intake match or clarification.
   4. Typed paths are unchanged.
8. **Verification.** `npx tsc --noEmit`, `npm test`. After deploy, Martin repeats the campaign request.
9. **Execution authority.** Implement, open a PR, watch it through merge.
10. **Stop rule.** If this needs a new AI task, a data-boundary change or a change to `resolveOrganization`, stop and report.
