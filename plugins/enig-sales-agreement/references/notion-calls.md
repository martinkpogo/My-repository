# ENIG Sales — exact tool calls

Copy these calls exactly, replacing only the `<…>` values. Every call below was run against the live workspace on 2026-10-05.

**Why views and search, not filtered queries.** On Martin's Notion plan, `notion-query-data-sources` in `rows` or `sql` mode has a usage cap. `view` mode and `notion-search` have no cap. So every lookup here uses a saved view or search. Never use `rows` or `sql` mode.

**Any tool error → STOP.** That includes `usage_limit_reached`, a missing tool, or an error naming a property or view. Quote the error to Martin, say which step it blocked, change nothing, and wait. Never guess past a failed call.

## 0. Setup (every skill, before step 1)

**Find this skill's folder.** In Claude chat, each plugin skill is mounted as its own folder and only files inside it are available, so every skill carries its own `scripts/` and `references/`. Run, with the skill's name:
```bash
find / -maxdepth 9 -path '*<skill-name>/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1
```
The skill folder is that path minus `/scripts/validate_token.py`. Call it `<SKILL>`. No result: STOP and tell Martin the plugin scripts can't be found. Never replace a script with a manual check.

The static facts are in the Project doc `enig-static-reference.md`, already in context. Read `<SKILL>/references/evidence-examples.md` when the skill drafts evidence.

**Load tools.** The tool-loading tool may be called `ToolSearch` or `tool_search`. Make one call with the `select:` list your skill gives. If any listed tool is not returned, make one keyword search for each missing tool (e.g. `notion query data sources`). Still missing → STOP and tell Martin which tool is unavailable.

**Check Notion access once.** Call `notion-get-tool-access` with `{}`. If `search`, `fetch` or `query_data_sources` is not available, STOP and report it. (`query_data_sources` showing `available_with_limit` is fine: only view mode is used.)

## Saved views (static)

| View | URL | Sorted / filtered |
|---|---|---|
| Log — Claude · Decisions newest first | `view://3f0cb004-e583-81df-8f2f-000cabb2edb9` | Type = Decision, Log ID newest first |
| Registry — Claude · Registry by Resolution_ID | `view://3f0cb004-e583-81ed-b51b-000c0c260061` | Resolution_ID newest first |
| Matters — Default view | `view://80ea3d70-32d7-4a99-86fa-e1a1f819221f` | none |
| Proposals — Default view | `view://0fea0902-588c-4c48-90f1-6b6a4dd02303` | none |

**Reading a whole view:** when a response has `"has_more": true`, call again with `"start_cursor": "<next_cursor>"` and the same `view_url`, until `has_more` is false.

## 1. Log check — newest Decision entries
Tool: `notion-query-data-sources`
```json
{"data": {"mode": "view", "view_url": "view://3f0cb004-e583-81df-8f2f-000cabb2edb9", "page_size": 3}}
```
Compare the first result's `Log ID` with **Last known Decision Log ID** in the Project doc `enig-static-reference.md` (section "Current decisions").
- Equal → continue.
- Higher → STOP. Report that entry's Log ID, Entry and Decisions text to Martin. Do not continue until he answers.

## 2. Registry — search by identity (stop at the first hit)
Tool: `notion-search`
```json
{"query": "<email>", "data_source_url": "collection://b737c4c4-9416-42f0-b733-1145bdde31f0", "page_size": 10}
```
Then the same with `"query": "<contact full name>"`, then `"query": "<organisation name>"`. Skip the organisation search if no organisation name is given, and say so.

## 3. Entity — search by descriptor (never by name)
Tool: `notion-search`
```json
{"query": "<Entity_type> <sector>", "data_source_url": "collection://437248f7-f6d8-4e70-873b-7b1eb0fdc519", "page_size": 10}
```
Example query: `Organisation agro-processing`.

## 4. Registry — read it all (confirms "no match" and finds the next Resolution_ID)
Tool: `notion-query-data-sources`
```json
{"data": {"mode": "view", "view_url": "view://3f0cb004-e583-81ed-b51b-000c0c260061", "page_size": 100}}
```
Read every page (follow `next_cursor`). Then, in chat:
- **Confirm "no match":** a row is a candidate if its `Email` equals the enquiry's email (ignore case), or its `Real_Name` or `Contact_Name` contains the contact's surname or the organisation name (ignore case). Any candidate → Gate A.
- **Malformed IDs:** run `validate_token.py resolution "<Resolution_ID>"` on each row. List every failure as a flagged record in Gate A. Do not repair it.

## 5. Next Resolution_ID
From the §4 read: take the number right after `RES-` at the start of every `Resolution_ID` (count malformed ones too: `RES-001-…` counts as 1). Next ID = highest number + 1, three digits (`RES-004`). Check it with `validate_token.py resolution`.

## 6. Registry — row for one Entity
Use the §4 read if this chat already has it; otherwise make the §4 call. Pick the rows whose `Entity_ID` equals the ENT-n exactly. None → STOP and say so. More than one → STOP and ask Martin which is right.

## 7. Matter — by MAT-n
Use `notion-fetch` with the Matter URL if you have it. Otherwise:
1. `notion-search` with `{"query": "<MAT-n>", "data_source_url": "collection://0e68feef-224d-433d-a813-0f6ec5e1c036", "page_size": 10}`.
2. Keep only the result whose title starts with `<MAT-n> –` (MAT-n, a space, an en dash). `MAT-2` must not match `MAT-27`.
3. None → read the Matters view (`view://80ea3d70-32d7-4a99-86fa-e1a1f819221f`, all pages) and look for that title. Still none → STOP and say so.
4. `notion-fetch` the matching page.

## 8. Matters — all Matters for one Entity
Read the Matters view (`view://80ea3d70-32d7-4a99-86fa-e1a1f819221f`, `page_size` 100, all pages). Keep the rows whose `Entity` list contains the Entity's page URL.

## 9. Proposal — by MAT-n
1. Read the Proposals view (`view://0fea0902-588c-4c48-90f1-6b6a4dd02303`, `page_size` 100, all pages).
2. Keep the rows whose `Matter Token` equals the MAT-n exactly.
3. None → STOP and say so. More than one → STOP and ask Martin which one.

## Writes
Create pages with `notion-create-pages` and change them with `notion-update-page`, using field names and option values exactly as `enig-static-reference.md` lists them. After every write, read the page back once (`notion-fetch` by its URL) and compare it field by field with what Martin approved. Any error or mismatch: STOP and report exactly what exists. Never retry a create.
