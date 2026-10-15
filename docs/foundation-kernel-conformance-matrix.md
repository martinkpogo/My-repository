# Foundation & Kernel Hardening — Contract-to-Code Conformance Matrix

**Status:** audit deliverable, 2026-10-14 · **Branch:** `claude/foundation-kernel-hardening` from integration tip `5bd5d3d9aa7c152205eb63b6b934bb8d71162a87`
**Contract source:** `docs/enig-operating-model.md` (binding) + `docs/concurrent-development.md` §8 (generic-runtime boundary rules) + the Handoff identity-write boundary in `AGENTS.md`.
**Method:** direct code reads plus three independent sub-audits (Google/Access mutation paths · Result/closure safeguards · Handoff pickup genericity), each with file:line evidence. Every line below was re-verified in this worktree before being written.

Verdicts: **Conforms** (contract satisfied and covered by tests) · **Gap closed here** (defect verified, smallest fix applied in this branch) · **Gap open — decision required** (closing it needs an Architect/governance decision, so it stops here) · **Disclosed** (documented as reserved, not a silent gap).

---

## 1. Baseline

| Item | Value |
| --- | --- |
| Integration tip | `5bd5d3d9aa7c152205eb63b6b934bb8d71162a87` (ancestor-confirmed, working tree clean) |
| `npm ci` | exit 0 |
| Baseline `npx tsx --test` | **1499 tests, 0 fail** (before any change in this branch) |
| `npm run typecheck` (`tsc --noEmit`) after changes | **exit 0** |
| `npx tsx --test` after changes | **1513 tests, 0 fail** (+14 new, none weakened/removed) |
| `gh` CLI | not installed; GitHub API used with the credential-helper token |

---

## 2. The matrix

### A. Work lifecycle — **Conforms**

| | |
| --- | --- |
| **Contract** | Work is the concrete instance of a resolved Action; Work owns resolved Action identity, status and persisted state. |
| **Code** | `src/runtime/workContract.ts:120/144/184` (contract from request and from persisted state) · `src/units/dispatch.ts:17-47` (the only sanctioned way to set `WorkState.actionName`; fail-closed on an undeclared Action) · `src/runtime/workStatus.ts:56/60/100` · `src/runtime/workPersistence.ts:59/75/116/132` (Tool-operation outcome persistence) · `src/handoffLifecycle.ts:23` (pickup idempotency claim), `:47` (terminal close, never reopening a Closed Handoff) |
| **Tests** | `src/runtime/workStatus.test.ts`, `workPersistence.test.ts`, `src/handoffLifecycle.test.ts`, `src/runtime/resolution.test.ts` |
| **Note** | No change made. |

### B. Organization / ownership resolution — **Conforms**

| | |
| --- | --- |
| **Contract** | Organization (Unit/Hat/Responsibility) is resolved deterministically before execution; ownership transfers only through a governed Handoff pickup. |
| **Code** | `src/runtime/organization.ts:95` (`resolveOrganization` — Unit resolved like every other, Marketing's Stage 1 Hat classification documented as the known overload) · `src/handoffOwnership.ts:179` (`runWithAdoptedOwnership` — every pickup runner re-reads the Handoff and records destination ownership before the handler runs) |
| **Tests** | `src/handoffOwnership.test.ts` (+ pickup wiring assertions in `src/runtime/actionSkills.test.ts:292-324`) |
| **Note** | No change made. |

### C. Exact-one Action resolution — **Conforms** (with the Result caveat in §J)

| | |
| --- | --- |
| **Contract** | Exactly one Action resolves for a Work entry, or resolution fails closed. |
| **Code** | `src/runtime/actionResolution.ts:158` ("resolves exactly one Action … or fails closed"), failure reasons `:143-150` (`zero_applicable`, `multiple_applicable`, `responsibility_mismatch`, …), dispatch order `:252/282` |
| **Tests** | `src/runtime/resolution.test.ts` (positive + zero/multiple/refusal cases) |
| **Note** | `expected_result` / `completion_criteria` are honest `null` ("Not declared by any Action yet", `:124-127`) — a contract gap, not a fabricated value. See §J. |

### D. Exact Skill resolution / fail-closed — **Conforms; coverage gap closed here**

| | |
| --- | --- |
| **Contract** | The Registry resolves an exact Skill ID or fails; no substitution, no fuzzy match; integrity verified before methodology is followed. |
| **Code** | `src/platform/skillRegistry.ts:421-436` (`resolveSkill`: exact id → format → status → Worker-runtime, all throwing `SkillResolutionError`), `:448-459` (`verifySkillIntegrity`, SHA-256 against the registered literal digest), `:470-478` (`resolveActionSkills` fails on first violation), `:504-511` (the resolved set refuses any id the Action did not declare); binding re-check `src/runtime/actionSkills.ts:61` (`resolved_version` + content must equal the registered package) |
| **Tests (pre-existing)** | `src/runtime/actionSkills.test.ts` — undeclared/missing/unregistered refusal, integrity drift refusal, version-mismatch refusal (`:131`), pickup refusal |
| **Gap found** | The `status`, `workerRuntime`, `format`, `integritySha256`-empty and registered-version branches of `resolveSkill` had **no direct test coverage** — the fail-closed code existed but nothing proved those branches fire. |
| **Gap closed here** | 7 new conformance tests in `src/platform/skillRegistry.test.ts`: positive loop over all 7 registered Skills (exact id, registered version carried, active, current runtime, supported format, integrity passes) + negatives: unknown/empty id, `retired`/`draft` status, foreign Worker runtime, unsupported format, digest mismatch, missing digest. Each mutates the live descriptor returned by `getSkillPackage` and restores it in `finally`, so no production injection point was added. |
| **Doc fix here** | `docs/enig-operating-model.md` claimed "package-format validation" and "no version" were absent. Drift: `resolveSkill` does validate the registered `format`, and packages carry `version` which is returned and re-checked at binding. Corrected in *Skills → Implementation state*, *Known gaps*, and *Open questions* to say precisely what remains absent (selection **across** versions; validation of a **received** package envelope). |

### E. Access / approval proofs — **Conforms at the registered boundary; reserved flows are Disclosed**

| | |
| --- | --- |
| **Contract** | Access answers "is this operation permitted"; external mutations require a Work recording a declaring `write` Action plus bound approval evidence where the Action demands it. |
| **Code** | `src/access.ts:518` (`evaluateAccess`), `:675` (`evaluateExternalMutationAccess`), `:952` (`mintApprovalProofForWork`); the only external-mutation call site is `src/runtime/toolRegistry.ts:476` inside `invokeTool`, in the documented fail-closed order (exact operation → input contract → target from trusted state → Access) |
| **Tests** | `src/access.test.ts`, `src/runtime/toolRegistry.test.ts`, `src/runtime/tools/googleDriveReplyTool.test.ts` (the reply operation: Action-declaration denial, read-context denial, approval-gated refusal and correctly-bound-proof acceptance, all with zero Google calls) |
| **Disclosed (not fixed here)** | **Comment replies are now INSIDE the boundary** (Architect decision, 2026-10-15): every automated Doc-thread reply runs through the registered `google_drive.reply_to_comment` operation, reached via the Sales unit operation `reply_proposal_doc_comment` dispatched inside the comment's Work's own Durable Object -- so the Access context for cron-driven reply writes is the comment's Work's own recorded Action, with bound approval evidence where that Action is approval-gated (the security-boundary question that previously stopped here is thereby answered, not bypassed). Where no Work Action exists (non-Proposal Docs, all Sheet comments) the reply is refused fail-closed with a content-free Operations alert. What remains *outside*: the comment-triggered in-place edit paths (`processComment`/`processSheetComment` fail closed with `edit_not_authorized`) and comment resolutions, which are deliberately never automated (Martin's own resolve is the signal). |

### F. Data identity / token safety — **Conforms**

| | |
| --- | --- |
| **Contract** | Every Handoff field that becomes another Unit's AI input may identify only by `Entity_Token`/`Matter_Token`; writes go through `handoffWriter`; fail-closed. |
| **Code** | `src/handoffWriter.ts:10-14` (boundary statement), `:143` (protected-identity-field violation), `:191/194` (tokens required, non-empty), `:266` (read-back equality); token-safe vs identity-bearing separation `src/dataBoundary/policy.ts` |
| **Tests** | `src/handoffWriter.test.ts`, `src/handoffContracts/unitBoundary.test.ts` (also runs in `npm test` and PR Validation) |
| **Note** | No change made; no Notion write of any kind was performed in this task. |

### G. Tool registration / external mutation — **Conforms**

| | |
| --- | --- |
| **Contract** | One static code-owned registry; a caller cannot register, select or substitute an operation; every declared operation must resolve exactly. |
| **Code** | `src/runtime/toolRegistry.ts:155` (`TOOL_OPERATIONS`, today 5 registered ops, all Google; `google_drive.reply_to_comment` added 2026-10-15 and deliberately declaring **no** `reconcile`, so an uncertain reply is refused rather than repeated), `:165` exact lookup, `:206` registry self-validation; declarations validated at registry assembly `src/units/registry.ts:126-130` (the three Proposal Actions each declare the reply op `required: false`, and `src/units/registryValidation.test.ts` asserts all 15 declarations resolve) |
| **Tests** | `src/runtime/toolRegistry.test.ts` (unknown op → `denied`, input contract, Access denial, approval-evidence denial, and AQ: all five ops resolve with the reply's absent `reconcile`), `src/runtime/tools/googleDriveReplyTool.test.ts` (15 tests: exact input contract, trusted-target denials, honest outcome mapping, durable intent-before-effect/outcome-after, and the never-repeat refusal for an uncertain reply) |
| **Disclosed** | See §E: comment replies were brought into the registry on 2026-10-15; the comment-triggered edit paths remain deliberately unregistered and fail closed. |

### H. Generic Worker + manifest boundaries — **Gap found and closed here**

| | |
| --- | --- |
| **Contract** | One mechanism per capability; Unit specifics declared on manifests; generic code must not name or enumerate Units (`docs/concurrent-development.md` §8; "Avoid Unit-specific execution branches", operating model *Worker*). |
| **Code** | `src/units/registry.ts:105` (`buildUnitRegistry` — malformed manifest / duplicate callback prefix / undeclared Tool op throws at assembly), `:155-166` (the single place a Unit is added), `src/units/unitManifest.ts:229/267/321` (`handoffPickup` declaration, `validateHatManifest`) |
| **Gap found** | `src/notionWebhook.ts` held `const ROUTABLE_UNITS = new Set(["Finance","Sales","Marketing","Strategy"])` — a **second, private statement of "which Units can pick up a Handoff"**, duplicated from the registry's `handoffPickup` declarations. Consequence verified by reasoning against the registry: a Unit added (or Business Development enabled) on its manifest would be accepted by scheduled discovery and silently filtered out of webhook-triggered discovery, with no test failing. |
| **Gap closed here** | `evaluateHandoffPageForWebhook` now resolves `routableUnits()` from `unitsWithHandoffPickup()` (`src/checkHandoffs.ts:302-304`) — the same manifest declarations discovery, session scheduling (`src/session.ts:238`) and pickup dispatch key off. Behavior is identical for all five current Units; the list can no longer drift. |
| **Tests added** | `src/notionWebhook.test.ts` — **11** (positive loop over the real registry: every registered Unit is relevant exactly when its manifest declares `handoffPickup`) · **11b** (a SYNTHETIC Unit — not in the production registry, cast `as Unit`, added only to a fixture table — with a valid `handoffPickup` declaration IS accepted by the unmodified filter, tokens carried through) · **11c** (the same synthetic Unit without a declaration is refused; an unknown Unit stays refused) · **11d** (real `buildUnitRegistry` assembly accepts a valid manifest under an unfamiliar Unit key and the same predicate sees its pickup) · **11e** (source-level: the filter calls `unitsWithHandoffPickup` and names no Unit literal — no private list, no Unit branch) · **12** (unregistered/retired Unit name) · **13** (empty `To Unit`). |
| **Test seam** | The synthetic cases run through a single optional `manifests` parameter on `unitsWithHandoffPickup` (`src/checkHandoffs.ts`) and `evaluateHandoffPageForWebhook` — a default-parameter seam in the exact shape the module already uses for `discoverPendingHandoffsForUnit`'s `declaration` ("production callers never pass it"). No DI, no new mechanism, no change to the memoized/boot-validated registry, and no production caller passes it. Requirement: an isolated test of *registration* is otherwise impossible, because `getUnitManifests()` memoizes the five real manifests at module scope (and `index.ts` validates them at boot) — mutating that singleton from a test would test nothing a production path could ever do. |

### I. Handoff discovery / pickup / provenance — **Conforms** (after §H)

| | |
| --- | --- |
| **Contract** | Discovery is registry-driven; pickup claims the Handoff at the processing boundary; the webhook is a signal only; provenance is recorded; identity stays token-only. |
| **Code** | `src/checkHandoffs.ts:198-221` (discovery per `HandoffPickupDeclaration`), `:302-304` (`unitsWithHandoffPickup`), `:315`, `:486` (registry-driven, no Unit list) · `src/handoffLifecycle.ts:23-35` (live re-read → claim → `Picked-up`; any non-Pending refused) · `src/notionWebhook.ts:6-21` (detect-and-trigger only; never writes Notion, never awaits a pickup — asserted by `notionWebhook.test.ts:406`) · provenance `src/handoffWriter.ts:215/246/284` (`SourceBoundaryResult`), ownership adoption `src/handoffOwnership.ts:179` |
| **Tests** | `src/checkHandoffs.test.ts`, `src/notionWebhook.test.ts` (24 pass), `src/sessionRouting.test.ts`, `src/handoffOwnership.test.ts`, `src/runtime/actionSkills.test.ts:292-324` (every declared pickup handler invoked only through the recorded-Skills path) |
| **Note** | What the tests demonstrate and what they do NOT: the webhook filter provably accepts a newly registered Handoff-capable Unit (11b/11d, through the real filter and real registry assembly) and refuses non-declaring/unknown Units (11c/12/13). **Not exercised, and not claimed:** an end-to-end pickup by a brand-new Unit — that would additionally require editing the `Unit` union in `src/types.ts`, a registry entry, live Notion Handoff data and a running `WorkSession`. The generic pickup *handler invocation* is asserted structurally in `src/runtime/actionSkills.test.ts:292-324` for every currently registered pickup Unit; no test executes it for a Unit outside the production registry. |

### J. Result recording / verification / closure — **Gap open — decision required**

| | |
| --- | --- |
| **Contract** | "Work records and evaluates the Result against acceptance and completion requirements" (`docs/enig-operating-model.md` *Result*, §674-681). |
| **Code reality** | The *Result* section has **no implementation subsection**, and no code evaluates a Result: `src/runtime/actionResolution.ts:121-127` carries `preconditions`, `expected_result`, `completion_criteria` as `null` with the comment "Not declared by any Action yet"; Handoff closure (`Status: Closed` + free-text `Work Completed`) is written directly by Unit handlers — `tokenSafeProposal.ts:980/1142/1156`, `salesExecutive.ts:1341`, `valueBasedPricingAssessor.ts:675`, `marketingManifest.ts:452` — with **no universal verification gate** in front of any of them. |
| **Why not fixed here** | Deciding what a Result is, which Actions must declare completion criteria, and what must be verified before closure is business-policy/governance interpretation (and inventing values for `completion_criteria` is explicitly forbidden). **Stops here, reported to Architect.** Recorded in `docs/enig-operating-model.md` → *Known gaps*. |

---

## 3. Research governance dependency (investigation only)

* **Live-state check 2026-10-14:** both canonical pages are **deleted** in Notion — `Research & Intelligence Analyst` contract (`3ddcb004-e583-8161-96ba-cdec357c5b5b`) and `Research-Safe Consultancy Context` (`3ddcb004-e583-81e5-b30a-db8cba543823`). `UNIVERSAL_ROLE_CONTRACT_PAGE_ID` (`3cecb004-e583-81ee-8f1e-f0d58532f4aa`) is alive.
* **Runtime consequence (already fail-closed, verified):** `src/runtime/research/executor.ts:311-317` blocks `SAFE_CONTEXT_UNAVAILABLE`, `:331-338` blocks `GOVERNANCE_UNAVAILABLE` — no AI call, no generic-assumption fallback. Covered by `executor.test.ts:571` (EXEC 10) and `executor.test.ts:616` (EXEC 14). Live callers `runActionResearch` / `runProspectResearch` (`src/runtime/actionResearch.ts`) — i.e. lead-generation research — are therefore **blocked in production until governance restores the pages**.
* **Not done, deliberately:** no page recreated, restored, edited or redirected; no hard-coded substitute content; no Notion write of any kind. **Governance decision required** (restore vs. replace vs. accept research being unavailable).

## 4. Changes made in this branch

| File | Change |
| --- | --- |
| `src/notionWebhook.ts` | `ROUTABLE_UNITS` constant removed; `routableUnits()` now derives from `unitsWithHandoffPickup()`; refusal reason states the manifest fact. |
| `src/notionWebhook.test.ts` | +7 conformance tests (registry-driven accept/reject loop, unregistered Unit, empty `To Unit`). |
| `src/platform/skillRegistry.test.ts` | +7 conformance tests for package-resolution branches (status/runtime/format/integrity/version/unknown id), mutation restored in `finally`. |
| `docs/enig-operating-model.md` | Skill-Registry drift corrected (3 places); +2 Known-gaps entries (Result verification gap; deleted research governance pages). |
| `docs/foundation-kernel-conformance-matrix.md` | This deliverable. |

**Follow-up commit (synthetic newly registered Unit):** `src/checkHandoffs.ts` and `src/notionWebhook.ts` gained one optional `manifests` parameter each (default: the real registry; production callers unchanged) so the webhook filter can be exercised against a synthetic registry table; `src/notionWebhook.test.ts` gained tests 11b–11e (synthetic pickup Unit accepted, non-declaring/unknown refused, registry assembly accepts an unfamiliar Unit key, source-level no-Unit-list check); matrix §H/§I claims corrected to match what the tests demonstrate.

**No-change scope honored:** no CI/workflow changes, no merge/deploy, no Notion writes, no test weakened/skipped/deleted, no provider/data-boundary policy touched, no second mechanism introduced (the webhook fix *removes* one), no fabricated versions, approvals or results.

## 5. Validation (commands actually run)

* `npm ci` → exit 0
* `npm run typecheck` (`tsc --noEmit`) → **exit 0**
* `npx tsx --test` → **1513 tests, 1513 pass, 0 fail, 0 skipped** (exit 0; baseline was 1499/0)
* Focused runs: `npx tsx --test src/notionWebhook.test.ts` → 28/28; `npx tsx --test src/platform/skillRegistry.test.ts` → 12/12

## 6. Remaining gaps (all requiring an Architect decision — none invented in code)

1. **Result verification before closure** (§J) — no acceptance/completion evaluation anywhere; Handoff closure is Unit-authored free text.
2. **Google comment-triggered in-place edits remain outside `invokeTool`** (§E) — selected-passage Doc edits and Sheet cell edits fail closed with `edit_not_authorized`; converting them needs an Architect decision. **Comment replies were closed on 2026-10-15** (registered `google_drive.reply_to_comment` operation; Access context = the comment's Work's own recorded Action, dispatched inside the Work's Durable Object; refused fail-closed where no Work Action exists), and comment resolutions are deliberately never automated (Martin's own resolve is the signal).
3. **Deleted research governance pages** (§3) — research/lead-gen research blocked fail-closed pending a Notion-write decision.
4. **MVP verification** — a real quote request run end-to-end through the complete governed Handoff workflow has **not** been performed or verified in this task.

## 7. Status declarations

* **Runtime/deployment status:** integration branch CI was green at baseline (Deploy Worker on `5bd5d3d9`, Auto Merge on `efcf3fee`, both success 2026-10-14); **this branch's deployment is unverified** — no deploy was run or authorized.
* **MVP status:** **not verified** — no real quote request was executed through the full governed Handoff workflow in this task.
* **Merged state:** nothing merged; this is a Draft PR only.
