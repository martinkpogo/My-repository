---
name: sales-enquiry
description: ENIG Isolated Sales intake for a brand-new sales enquiry (connected Gmail or pasted text), and for recording new client evidence from correspondence against an existing Matter. Use when a new enquiry, lead or prospect email arrives, or Martin asks to "log this enquiry," "find the Entity for this," "set up a Matter," or "match this to an existing client." Matches or establishes the Entity + Registry pair and the Matter, and writes identity-safe Matter evidence, each only on Martin's approval. Never qualifies, changes a status, or creates or offers a Handoff. Part of the `enig-sales` plugin.
---

# sales-enquiry — steps

Rules: the Project Instruction (§n). Facts: the Project doc `enig-static-reference.md` (Ref, already in context). Exact calls: `references/notion-calls.md` in this skill's folder (Calls). Labelling: `references/evidence-examples.md` in this skill's folder (Examples). Current decisions: the Ref section "Current decisions". If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Do not skip, merge or reorder steps. Where a step says STOP, end your turn and report.

**Never in this skill:** assess fit · state or suggest a price or budget · change a Status (only create at Lead / Open) · create, offer or mention a Handoff · create a Call Notes record · predict an ENT-n or MAT-n · write a name, email, phone, web address or place anywhere outside the Registry.

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Stage end state:** Entity at Lead, Matter at Open, evidence recorded, one log entry.

## Before step 1
1. Find this skill's folder (its `scripts/` and `references/` sit beside this SKILL.md):
   `find / -maxdepth 9 -path '*sales-enquiry/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`
   `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and tell Martin the plugin scripts can't be found. Never replace a script with a manual check, and never say a check ran when it did not.
2. Read `<SKILL>/references/notion-calls.md` and `evidence-examples.md` once each.
3. Load tools with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Notion__notion-search,mcp__Notion__notion-fetch,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-create-pages,mcp__Notion__notion-update-page,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it; still missing → STOP and say which. Then call `notion-get-tool-access` with `{}` once (Calls §0). Add `mcp__Gmail__get_thread,mcp__Gmail__search_threads` only if the enquiry is in Gmail.
4. **TEST RUN** in Martin's message: follow Project Instruction §11. Write nothing.

## Choose the mode
- **A. New enquiry** → steps 1–14.
- **B. New evidence for an existing Matter** (labelled by `sales-correspondence` earlier in this chat, with its MAT-n) → steps 2, 3, then Matter by Calls §7, then 10, 11, 12 (Gate C only), 13 (update, not create), 14. Do not touch the Entity or Registry.

## Steps

### 1. Log check
Make Calls §1 exactly against the Project doc's "Log reviewed through" baseline. No newer Decision → continue. A newer one → summarise it and continue once Martin confirms it does not change this work (§10).

### 2. Receive
Take the latest relevant Gmail message, or the pasted text exactly as given. Write the locator now:
- Gmail: `Gmail thread <id>, message <id>, <YYYY-MM-DD>`
- Pasted: `Pasted enquiry, received <YYYY-MM-DD>`

### 3. Sort in chat
Make two lists.
- **Identity** (Registry and chat only): every person's name, the organisation's name, emails, phones, addresses, web addresses, places.
- **Evidence**: everything else, each item labelled with the Examples labelling table. Budget words: quote them exactly as CS. No budget words: `(UQ) Investment range or boundary.`

### 4. Registry match
Calls §2: email, then contact full name, then organisation name (skip if none given, and say so). Stop searching at the first hit.

### 5. Entity match
Calls §3, by `<Entity_type> <sector>` only. Never search by name. Run `validate_token.py entity-title "<title>"` on each result. A failing title is a flagged record for Gate A. Do not repair it.

### 6. Confirm "no match" and find the next Resolution_ID
Always run this, even if steps 4 and 5 found something (a missed match creates a duplicate client).
- **6a.** Calls §4: read the whole Registry (search-based; 50 results means it may be incomplete) and list every candidate and every malformed Resolution_ID for Gate A.
- **6b.** Calls §5: compute the next Resolution_ID from that same read.

### 7–12. Build ONE approval message
Steps 7–11 prepare it; step 12 sends it. Never ask for approval across several messages.

**7. Gate A — Match.** A table: enquiry identity | Registry candidates (ENT-n, Resolution_Status) | Entity candidates (token, descriptor) | flagged malformed records. Ask: "Existing ENT-n, or new?" A candidate row marked Needs Review: say so. Never choose for Martin.

**8. Gate B — New Entity + Registry pair** (only when there is no match).
- Entity: `Entity Record` = `ENT-n (<Entity_type> – <sector>)` (Notion fills the n), `Entity_type`, `Status` Lead, `Business_context` per Ref.
- Registry: every field in Ref. `Resolution_ID` from 6b. Identity copied exactly as written in the source. Organisation name not given: follow Ref (empty `Real_Name`, note, raise it here). `Resolution_Status`: write "Martin to choose: Confirmed or Needs Review".

**9. Matter check.** New Entity → new Matter. Matched Entity → Calls §8 with its page URL, compare stated needs: same ask → reuse that MAT-n (mode B fields); different ask → new Matter; can't tell → ask in Gate C.

**10. Gate C — Matter.**
- `Matter`: `MAT-n – <non-identifying descriptor>`
- `Entity`: the ENT-n (from Gate B, or matched)
- `Status`: Open
- `Stated_need`: one or two sentences, `(CS, <role>)`.
- `Current_understanding`: the Examples template exactly — every heading, `- (CLASS)` bullets, last line `Last updated <YYYY-MM-DD>, from <locator>.`
- `Evidence_source`: the locator only.
- `Next_action`: `Intake recorded; awaiting correspondence or sales call.`
- Mode B or a reused Matter: show the full new value of every changed field, not only the added lines.

**11. Sanitize.**
1. Write every governed text (Entity title, Business_context, Matter title, the four Matter fields) to `draft.txt`.
2. Run `python3 <SKILL>/scripts/scan_identity_leakage.py draft.txt --identity "<string>" "<string>" …` with every identity string: each person's full name, first name and surname (the client, referrers, anyone named), organisation and trading names, emails, phones, web addresses, social handles, and places from step 3. One quoted argument per string.
3. Exit 1 → remove only the identity and run again. Never delete a figure. Two failed redrafts → STOP and show Martin the hits.
4. WARN lines → re-read each named phrase; fix it if it names anyone.
5. Write the seven-line read-through from `references/checks.md` §1 (`1. Pass — …`). Any Fail → redraft.

**12. Send the approval message.** Gate A, Gate B (if new), Gate C, the scan result line, the seven read-through lines. End with:
> Approve by naming each gate, e.g. "Approve A new, B with Confirmed, C". To change anything, tell me what — I'll show the whole message again.

STOP and wait.
- Approval must name the gate. "OK", "looks good" or silence is not approval: ask which gates.
- Any edit → redo steps 10–12 and show everything again.

### 13. Write and verify (only the gates Martin approved, in this order)
After each write, read the page back once by its URL and compare every field with the approved draft. Error or mismatch → STOP and report exactly what exists and what does not. Never retry a create.
Notion may return `Entity_ID` / `Matter_ID` as a bare number (e.g. `27`). The token is that number with its prefix: `ENT-27`, `MAT-27`. Never guess the number before Notion returns it.
1. **Entity:** create with `Status` Lead → take the ENT-n Notion returns → build the title → `validate_token.py entity-title "<title>"` → set the title → read back.
2. **Registry:** `validate_token.py entity "<ENT-n>"` → create the row with `Entity_ID` = that ENT-n, `Resolution_ID` from 6b (`validate_token.py resolution`), `Resolution_Status` as Martin chose → read back.
3. **Matter:** create at Open with the Entity relation → take the MAT-n → build the title → `validate_token.py matter-title "<title>"` → set the title → read back. Mode B: update only the approved fields.
Keep every returned page URL.

### 14. Log and stop
One log entry: `Type` Activity, `Area` Sales, `Outcome` Complete, `Entry` = `Sales intake · ENT-n at Lead, MAT-n at Open` (or `Evidence updated on MAT-n`). No names anywhere in it.
Tell Martin what now exists (tokens and links) and name the next stage: `sales-correspondence`, or `sales-call-prep` once a call is booked. Do not offer or mention a Handoff.

## Notes
- Identity or a malformed token in an existing record: flag it to Martin, don't copy it, don't repair it unless asked (§7).
- Fit, pricing, proposal, "hand this to Strategy": finish intake, then name the stage or Unit that owns it (§3).
