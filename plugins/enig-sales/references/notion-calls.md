# ENIG Sales — exact tool calls

Copy these calls exactly, replacing only the `<…>` values.

**Search, fetch and backlinks only.** The Project Instruction (§9) prohibits `notion-query-data-sources` and `notion-query-multiple-data-sources`. Never load or call them, in any mode. Every lookup below uses `notion-search` scoped to one data source, `notion-fetch` by exact URL, or `notion-list-page-backlinks`.

**Search is not a database query.** It can miss rows. Where completeness matters (a "no match" claim, the next Resolution_ID, the log check), the call below says how to detect an incomplete result; if completeness cannot be shown, say so and solve first (Project Instruction §5). In a TEST RUN, report every lookup as search-based.

**Tool errors.** A failed read may be retried up to twice (Project Instruction §9). Never retry a create or update. A failed write, or a write whose outcome is unknown, is hard stop 4: find out what took effect first, then offer a resume plan. Any other error (a usage limit, a missing tool, an error naming a property, a read still failing) → quote it to Martin, say which step it blocked, and offer the way forward. Never guess past a failed call.

## 0. Setup (every skill, before step 1)

**Find this skill's folder.** In Claude chat each plugin skill is mounted as its own folder and only files inside it are available, so every skill carries its own `scripts/` and `references/`. Run, with the skill's name:

```
find / -maxdepth 9 -path '*<skill-name>/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1
```

The skill folder is that path minus `/scripts/validate_token.py`. Call it `<SKILL>`. No result: tell Martin the plugin scripts can't be found and continue only read-only work. Never replace a script with a manual check for a governed write.

The static facts are in the Project doc `enig-static-reference.md`, already in context. Read `<SKILL>/references/evidence-examples.md` when the skill drafts evidence, and `<SKILL>/references/checks.md` before any approval request.

**Load tools.** The tool-loading tool may be called `ToolSearch` or `tool_search`. Make one call with the `select:` list your skill gives. If any listed tool is not returned, make one keyword search for each missing tool (e.g. `notion search`). Still missing → tell Martin which tool is unavailable and offer the fallback (Project Instruction §5).

**Check Notion access once.** Call `notion-get-tool-access` with `{}`. If `search` or `fetch` is not available, report it.

## Data sources (from the Project doc)

| Object | `data_source_url` |
|---|---|
| Entity | `collection://437248f7-f6d8-4e70-873b-7b1eb0fdc519` |
| Matters | `collection://0e68feef-224d-433d-a813-0f6ec5e1c036` |
| Identity Resolution Registry | `collection://b737c4c4-9416-42f0-b733-1145bdde31f0` |
| Call Notes | `collection://a2bf0fa6-7fd5-47ab-b5f2-1fc599f2d164` |
| Handoffs | `collection://935cff62-de01-4920-9743-782c7d210455` |
| Proposals | `collection://3b7bf0fa-7664-4ef1-a91b-282316696b6c` |
| Agreements | `collection://6b71106b-5cbe-4bd3-831e-2c1dd96d0a34` |
| Payments | `collection://703a276e-2183-4f89-9627-9625b099a851` |
| Activity & Decision Log | `collection://423e7f93-5f9d-435d-856a-e183120d3d8f` |

## 1. Log check — governing decisions newer than the Project doc's baseline

The baseline is the **"Log reviewed through LOG-n (YYYY-MM-DD)"** line in `enig-static-reference.md`. Read its LOG number and date. Look for later Decisions.

Tool: `notion-search`, four calls, each with this filter (the date is the baseline date):

```
{"query": "<term>", "data_source_url": "collection://423e7f93-5f9d-435d-856a-e183120d3d8f", "page_size": 25, "filters": {"created_date_range": {"start_date": "<baseline YYYY-MM-DD>"}}}
```

Terms: `Decision`, `Sales`, `Call Notes`, `Handoff`.

- Skip results whose title starts with a routine stage prefix from the Project doc ("Sales intake ·", "Correspondence", "Sales call scheduled", "Call prep brief", "Call evidence recorded", "Call Notes record created", "Evidence updated", "Fit assessed", "Proposal released", "Proposal accepted", "Agreement sent", "Agreement signed", "Sales progression ·").
- `notion-fetch` every other result once and read `Type`, `Log ID`, `Entry`, `Decisions`.
- Any `Type` = Decision with a Log ID above the baseline → summarise it to Martin (Log ID, Entry, Decisions) and continue only once he confirms it does not change this work (Project Instruction §10). Decisions the Project doc already names (e.g. under "Known remaining issues") count as reviewed.
- None → continue, and say the check was search-based.

## 2. Registry — search by identity (stop at the first hit)

Tool: `notion-search`

```
{"query": "<email>", "data_source_url": "collection://b737c4c4-9416-42f0-b733-1145bdde31f0", "page_size": 10}
```

Then the same with `"query": "<contact full name>"`, then `"query": "<organisation name>"`. Skip the organisation search if no organisation name is given, and say so. `notion-fetch` each hit to read its fields.

## 3. Entity — search by descriptor (never by name)

Tool: `notion-search`

```
{"query": "<Entity_type> <sector>", "data_source_url": "collection://437248f7-f6d8-4e70-873b-7b1eb0fdc519", "page_size": 10}
```

Example query: `Organisation agro-processing`.

## 4. Registry — every row (confirms "no match" and finds the next Resolution_ID)

Tool: `notion-search`

```
{"query": "RES", "data_source_url": "collection://b737c4c4-9416-42f0-b733-1145bdde31f0", "page_size": 50, "max_highlight_length": 0}
```

- 50 results returned → the list may be incomplete: tell Martin the Registry can't be read in full by search, and ask him to confirm the match decision.
- `notion-fetch` every result once. A row is a **candidate** if its `Email` equals the enquiry's email (ignore case), or its `Real_Name` or `Contact_Name` contains the contact's surname or the organisation name (ignore case). Any candidate → Gate A.
- **Malformed IDs:** run `validate_token.py resolution "<Resolution_ID>"` on each title. List every failure as a flagged record in Gate A. Do not repair it.

## 5. Next Resolution_ID

From the §4 read: take the number right after `RES-` at the start of every `Resolution_ID` (count malformed ones too: `RES-001-…` counts as 1). Next ID = highest number + 1, three digits (`RES-006`). Check it with `validate_token.py resolution`.

## 6. Registry — row for one Entity

`notion-search` with `{"query": "<ENT-n>", "data_source_url": "collection://b737c4c4-9416-42f0-b733-1145bdde31f0", "page_size": 10}`, then `notion-fetch` each result. Keep rows whose `Entity_ID` equals the ENT-n exactly (`ENT-2` must not match `ENT-27`). None → use the §4 read. Still none → say so and solve first. More than one → ask Martin which is right.

## 7. Matter — by MAT-n

Use `notion-fetch` with the Matter URL if you have it. Otherwise:
1. `notion-search` with `{"query": "<MAT-n>", "data_source_url": "collection://0e68feef-224d-433d-a813-0f6ec5e1c036", "page_size": 10}`.
2. Keep only the result whose title starts with `<MAT-n> –` (MAT-n, a space, an en dash). `MAT-2` must not match `MAT-27`.
3. None → the same search with `"query": "MAT"`, `"page_size": 50`, and look for that title. Still none → say so.
4. `notion-fetch` the matching page.

## 8. Matters — all Matters for one Entity

Tool: `notion-list-page-backlinks`

```
{"page_id": "<Entity page URL or id>", "types": ["property_mention"], "page_size": 100}
```

Keep backlinks whose `property.name` is `Entity` and whose source title starts with `MAT-`. Follow `next_cursor` until it is absent. `notion-fetch` each kept Matter.

## 9. Proposal — by MAT-n

1. `notion-search` with `{"query": "<MAT-n>", "data_source_url": "collection://3b7bf0fa-7664-4ef1-a91b-282316696b6c", "page_size": 25}`; `notion-fetch` each result.
2. Keep the rows whose `Matter Token` equals the MAT-n exactly.
3. None → ask Martin for the Proposal URL. More than one → ask Martin which one.

## 10. Call Notes — every record for one Matter

Tool: `notion-list-page-backlinks`

```
{"page_id": "<Matter page URL or id>", "types": ["property_mention"], "page_size": 100}
```

Keep backlinks whose `property.name` is `Matter` and whose source title starts with `CN-`. `notion-fetch` each. Read only the `Note` property for content; never the page body.

## 11. Agreement — by MAT-n

`notion-search` with `{"query": "<MAT-n> agreement", "data_source_url": "collection://6b71106b-5cbe-4bd3-831e-2c1dd96d0a34", "page_size": 10}`; `notion-fetch` each result. Keep rows whose `Matter_Token` equals the MAT-n exactly. Ignore `Cancelled` rows. More than one other row → ask Martin which one.

## 12. Payments — by MAT-n

`notion-search` with `{"query": "<MAT-n>", "data_source_url": "collection://703a276e-2183-4f89-9627-9625b099a851", "page_size": 25}`; `notion-fetch` each result. Keep rows whose `Matter_Token` equals the MAT-n exactly.

## Writes

Create pages with `notion-create-pages` and change them with `notion-update-page`, using field names and option values exactly as `enig-static-reference.md` and the live schema list them. After every write, read the page back once (`notion-fetch` by its URL) and compare it field by field with what Martin approved. Any error or mismatch: hard stop 4 — report exactly what exists. Never retry a create.

**Call Notes create** (`sales-call-evidence` only, after Martin's approval). Parent `collection://a2bf0fa6-7fd5-47ab-b5f2-1fc599f2d164`. Properties, and no page body content:

```
{"Call Notes ID": "<CN-…>", "Entity": "[\"<Entity page URL>\"]", "Matter": "[\"<Matter page URL>\"]",
 "date:Call Date:start": "<YYYY-MM-DD>", "date:Call Date:is_datetime": 0, "Call Type": "<option>",
 "Note": "<approved note, ending with the Commercial Value Evidence block>", "Approval Attestation": "<record_approval marker>", "Status": "Ready", "Version": 1}
```

**Sales → Strategy Handoff create** (`sales-progression` only, after Martin's approval). Parent `collection://935cff62-de01-4920-9743-782c7d210455`. The values come from the Project doc's "Sales → Strategy Work Handoff values" table, with these Runtime requirements (LOG-1149, Project Instruction §8):

- **No `Entity_Token` / `Matter_Token` properties.** Those columns are retired. The Entity and Matter travel only as `token:` entries in `Sources`.
- `Sources` = exactly the output of `handoff_attestation.py sources --entity <ENT-n> --matter <MAT-n> --call-notes <Call Notes page URL>`: three lines — `token:entity:ENT-n`, `token:matter:MAT-n`, `https://www.notion.so/<32-hex id>`. Never an extra link, a database or view link, or a link with a readable slug.
- `Reason` ends with the `source_boundary_check` marker from `handoff_attestation.py source-boundary`.
- `Verified Facts & Sources` = `Evidence: see Sources (CN-…).`, any facts not in the Call Notes record, then the **compatibility copy** of the Commercial Value Evidence block, byte-for-byte the block in the Call Notes `Note`. The Runtime's Strategy reader still reads the block from this field and holds the Handoff without it.
- After the create, run `handoff_attestation.py verify` on `Reason`, `Verified Facts & Sources` and `Sources` exactly as read back.
