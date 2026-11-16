---
name: sales-call-evidence
description: "ENIG Isolated Sales completed-call evidence from Read.ai (or a fallback recorder) or pasted notes. Use when Martin brings a call recording, a meeting report or call notes, or says \"log this call\" or \"capture call notes\". Matches the call to an existing Matter and, on Martin's one approval, updates Current_understanding and creates one canonical Call Notes record (identity-safe Note with the Commercial Value Evidence block, verified approval marker). Never assesses fit or creates a Handoff."
---

# sales-call-evidence — steps

Rules: the Project Instruction (§n). Facts — Call Notes fields, the CVE determination rule, evidence classes: the Project doc `enig-static-reference.md` (Ref, already in context). Exact calls: `references/notion-calls.md` (Calls). Labelling, the Current_understanding template and the CVE record: `references/evidence-examples.md` (Examples). Read-through: `references/checks.md` (Checks). Governing: LOG-1110 and LOG-1140 — one canonical, approved Call Notes record per completed call; evidence lives once, in its `Note`. If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Where a step says STOP, end your turn and report.

**Never in this skill:** create a Matter or Entity · change a Status · rate fit · create, offer or mention a Handoff · put content in a Call Notes page body · paste a raw transcript into Notion · write identity into any field · build a marker before Martin's approval · edit an existing Call Notes record (a correction is a new Version with governed authorisation, not an overwrite).

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Stage end state:** the call's evidence labelled in this chat; on approval, the Matter's `Current_understanding` updated and one Ready Call Notes record created and verified; one log entry.

## Before step 1
1. Find this skill's folder: `find / -maxdepth 9 -path '*sales-call-evidence/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`. `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: tell Martin the plugin scripts can't be found; continue read-only work only.
2. Read `<SKILL>/references/notion-calls.md`, `evidence-examples.md` and `checks.md` once each.
3. Load tools with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Read_AI__list_meetings,mcp__Read_AI__get_meeting_by_id,mcp__Notion__notion-fetch,mcp__Notion__notion-search,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-update-page,mcp__Notion__notion-create-pages,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it. Then call `notion-get-tool-access` with `{}` once (Calls §0). Read.ai missing → try the fallbacks in `CONNECTORS.md` order, or ask Martin to paste the notes.
4. **TEST RUN** in Martin's message: follow Project Instruction §11. Write nothing; label `build` output as simulated.

## Steps

### 1. Receive
Read the one call from Read.ai (or the fallback recorder you name to Martin), or take pasted transcript/notes exactly as given. Write down:
- the locator: `Read.ai meeting <id>` or `Pasted call notes, received <YYYY-MM-DD>`;
- the actual call date (YYYY-MM-DD). Not stated → ask Martin; never use the receipt date as the call date;
- the call type: one of Discovery, Sales, Qualification, Follow-up, Review, Other.

### 2. Sort in chat
Two lists: **identity** (names, organisation, contacts, places) and **evidence**. Label every evidence item with the Examples labelling table. Client figures are VE (class CS). Pipeline is context, not impact. Investment words exactly as said; "no fixed budget" as said; none → `(UQ) Investment range or boundary.`

### 3. Match the Matter
Get the MAT-n from Martin. Fetch by URL if known, otherwise Calls §7. Show the Matter beside the call's identity details and ask Martin to confirm it is the right one. Fetch the Entity from the Matter's `Entity` relation and read both tokens from the titles; run `validate_token.py entity-title` and `matter-title` on them. No Matter → offer `sales-enquiry` first. Several possible Matters → ask.
List existing Call Notes for the Matter (Calls §10). A record for this same call already exists → STOP: a correction is a new Version and needs Martin's governed authorisation.

### 4. Draft the Call Notes `Note`
The `Note` is the only substantive content (Ref "Call Notes"). Required sections `call_context` and `evidence`; use the optional sections that apply, as headings: business context · stated problems · objectives · current state · desired state · pain points · constraints · requirements · value evidence · decision process · stakeholders (by role, involvement, authority) · existing solutions · client statements · sales observations · confirmed facts · unresolved questions · follow-up items. Every item labelled. Stakeholders by role only.

### 5. Build the Commercial Value Evidence block
1. Write `evidence.json` from the VE items only, per the Examples "Commercial Value Evidence record" (determination by the Ref rule; `evidence: null` when the call held no value evidence).
2. `python3 <SKILL>/scripts/handoff_attestation.py cve --json-file evidence.json`. FAIL → fix the record (never a figure) and run again.
3. Append the printed block, unchanged, as the last lines of the `Note`.

### 6. Draft the Matter summary
Write the full new `Current_understanding` in the Examples template (every heading, `- (CLASS)` bullets, `Last updated <YYYY-MM-DD>, from <locator>.`). Merge it with what the field already holds; keep earlier evidence unless the call corrects it, and say what changed. Change `Next_action` only if the position changed, as a factual position.

### 7. Sanitize
1. Write the `Note` and the Matter fields to `draft.txt`.
2. `python3 <SKILL>/scripts/scan_identity_leakage.py draft.txt --identity "<string>" "<string>" …` with every identity string from step 2: each person's full name, first name and surname, organisation and trading names, emails, phones, web addresses, social handles, places. One quoted argument per string.
3. Exit 1 → remove only the identity and run again. Never delete a figure. Still failing after two redrafts → show Martin the hits and suggest neutral wording (hard stop 2).
4. WARN lines → re-read each named phrase; fix it if it names anyone.
5. Write the seven-line read-through from Checks §1.

### 8. Approval request (one approval, two writes)
Show: the MAT-n; the exact new `Current_understanding` (and `Next_action`, if changed); the exact Call Notes record — `Call Notes ID` (from `call_notes_attestation.py new-id`), Entity and Matter (tokens and pages), `Call Date`, `Call Type`, the full `Note`, `Status` Ready, `Version` 1; the scan result line; the seven read-through lines. End with: "Approve by saying 'Approve evidence for MAT-n'." STOP.
An edit request → revise and show it all again. This approval covers only these two writes.

### 9. Write and verify
1. Only now: `python3 <SKILL>/scripts/call_notes_attestation.py build --record <CN-…> --entity <ENT-n> --matter <MAT-n> --call-date <YYYY-MM-DD> --call-type <option> --version 1 --approved-by-martin`. FAIL → STOP and report; never hand-build a marker.
2. Update the Matter with exactly the approved text (`notion-update-page`). Read it back once and compare.
3. Create the Call Notes record with the Calls "Call Notes create" payload: the approved values, the `Note`, the marker in `Approval Attestation`, no page body. Read it back once.
4. `python3 <SKILL>/scripts/call_notes_attestation.py verify --marker "<Approval Attestation as read back>" --record … --entity … --matter … --call-date "<Call Date as read back>" --call-type "<as read back>" --version <as read back>`. Also confirm the read-back `Entity` / `Matter` relations point to the pages of ENT-n / MAT-n, and that the `Note` still ends with the block exactly as approved. Any FAIL or mismatch → hard stop 4: report exactly what exists; never edit or recreate the record.

### 10. Log and stop
One log entry: `Type` Activity, `Area` Sales, `Outcome` Complete, `Entry` = `Call Notes record created for MAT-n (<CN-…>)`. No names.
Name the next stage: `sales-fit-assessment`. Do not offer or mention a Handoff.

## Notes
- Requests beyond evidence capture (follow-up drafts, "is this worth pursuing", scope, pricing): name the stage or Unit that owns it (§3).
- Never paste the raw transcript or recording into Notion in any form (§7).
