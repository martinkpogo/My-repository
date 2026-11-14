# Activity Feed Labels (Issue #369)

Every run the ENIG Runtime performs shows Martin what it is doing right now, on one in-place Telegram message per run. The labels are **controlled**: fixed vocabulary from fixed maps, never a page title, record content, client text, query, prompt, or model output.

## How a run reports

A run is opened by `src/runtime/liveStatus.ts` at the places every run passes through (Work execution, ENIG turns, topic chat, the Workspace lookup check, Chat-mode read Actions). Chokepoints report steps into the run:

```
🧭 <header>
✓ Reading Payments
⏳ Writing to Payments
```

- All steps except the last render `✓`; the last renders `⏳`.
- A step reported earlier as pending resolves to its terminal state (`resolvePendingStep` renames the last matching label, or pushes a new final line when none matches).
- A run that succeeds **deletes** its message (Martin's choice).
- A run waiting on Martin ends `⏸` and stays; a thrown run ends `⛔` naming the step it stopped at.
- At most 1 send + `MAX_EDITS` (6) edits + 1 final call; edits at most once per `EDIT_INTERVAL_MS` (1000 ms). A failed Telegram call is logged and never blocks the run.
- Where a Hat already reports its own named steps (`src/runtime/workStatus.ts`), those lead: opening them removes any live message already shown, and what the live run sees during each Hat step is shown on that Hat step's own line.

## Fixed label vocabulary

### Tool Registry lifecycle (`src/runtime/toolRegistry.ts`)

| Step | Meaning |
|------|---------|
| `Checking tool registry` | The registry lookup itself — reported before any tool is named. Only a lookup that actually happened is shown. |
| `Tool not registered` | Terminal resolution of `Checking tool registry` when no exact operation is registered. |
| `Tool use denied` | Terminal resolution of either `Checking tool registry` or `Using tool: <display>` when Access, input validation, target resolution, persistence, or the in-flight guard refuses before/during use. |
| `Tool available: <display>` | The tool is registered, its input and target are sound, and Access has passed. Shown once per invocation, right before `Using tool: <display>`. |
| `Using tool: <display>` | The handler is about to run. Display name from `TOOL_DISPLAY_NAMES` (`google_docs` → `Google Docs`, `google_drive` → `Google Drive`, otherwise the opaque tool id). |

### Tool operation activity and result labels

Each registered operation declares `activityLabel` (shown while the handler runs) and `resultLabel` (shown only on a verified `succeeded`). Every other canonical outcome state is labelled state-faithfully by the invocation boundary, never as a success:

| Tool | Operation | `activityLabel` | `resultLabel` |
|------|-----------|-----------------|---------------|
| `google_docs` | `google_docs.create_and_verify` | `Creating document` | `Document created` |
| `google_docs` | `google_docs.update_and_verify` | `Updating document` | `Document updated` |
| `google_docs` | `google_docs.format_and_verify` | `Formatting document` | `Document formatted` |
| `google_drive` | `google_drive.ensure_folder` | `Ensuring folder exists` | `Folder ready` |
| `google_drive` | `google_drive.reply_to_comment` | `Replying to the comment` | `Reply posted` |

Terminal labels by outcome state:

| Outcome state | Terminal label |
|---------------|----------------|
| `succeeded` | `<resultLabel>` (+ ` — <url>` when `remote_resource.url` is non-empty) |
| `failed` | `<Display> operation failed` |
| `partially_completed` | `<Display> operation partially completed` |
| `unverified` | `<Display> operation unverified` |
| `denied` | `<Display> operation denied` |

A `succeeded` outcome may append a verified remote-resource URL; no other state may. `succeeded` requires `verified: true` plus the remote resource id — read-back verification passed before the label is worn.

### Web search (`src/runtime/research/webSearch.ts`)

| Step | Meaning |
|------|---------|
| `Using tool: Tavily` | Reported once per run via `reportLiveStepOnce` — a research run fans out into several parallel searches, so one line covers the whole fan-out (never "Using tool: Tavily ×3"). |
| `Searching the web` | Reported per search via `reportLiveStep`; adjacent calls merge as `Searching the web ×N`. |
| `Searching the web — <domain>` | Terminal resolution of `Searching the web`: the public site of the top result, domain only — never the query, full link, or page text. The single approved exception to fixed-map labels. |
| `Searching the web — nothing found` | Terminal for `success_no_results`. |
| `Searching the web — not completed` | Terminal for `provider_unavailable` / `provider_failure` / `invalid_input` — a search that never completed is never shown as "nothing found". |

A request that never reaches the provider (invalid input, missing key, Access refusal, run/day ceiling) reports **nothing** for these two lines.

### Research review stage (`src/runtime/research/executor.ts`)

| Step | Meaning |
|------|---------|
| `Reviewing search results` | Reported after `gatherDimensionEvidence` completes — the evidence has been gathered and coverage assessed. |
| `Research sources retrieved` | Terminal resolution when at least one source was found (`webResultCount > 0`). Never claimed when there are zero results. |

### Skill stages (`src/platform/skillRegistry.ts`, listener registered in `src/runtime/liveStatus.ts`)

| Step | Meaning |
|------|---------|
| `Resolving skill: <id>` | The Registry resolved the Skill by exact id. |
| `Verifying skill: <id>` | The Registry integrity-verified the Skill (SHA-256 digest match). |
| `Applying skill: <id>` | A single Skill's handler is executing. Reported only for stages that genuinely execute; never the Skill's content, prompt, or methodology. |
| `Applying skills: a, b, c` | One line for a whole parallel wave (Strategy's concurrent plan). Per-Skill reports inside a wave are suppressed via `withoutSkillApplyReports` so the wave does not read as sequential execution. |

### Notion (`src/notion.ts`, `authorize()` chokepoint)

| Step | Meaning |
|------|---------|
| `Reading <source>` | A Notion read against a governed source's fixed name (e.g. "Reading Payments"), after Access permits it — never a page title or record content. |
| `Writing to <source>` | A Notion create against a governed source's fixed name. |
| `Updating <source>` | A Notion update against a governed source's fixed name. |

A denial reports **nothing**: `evaluateAccess` runs first, and `reportLiveStep` is called only after Access permits the operation.

## Security

Labels are drawn from controlled sources only: governed source names, registered AI task names, registered Tool operation ids, fixed stage wording, and (one approved exception) a search's top-result domain. No credential, page title, record content, client text, query, prompt, or model output ever reaches the feed.
