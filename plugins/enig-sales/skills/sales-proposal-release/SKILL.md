---
name: sales-proposal-release
description: "Releases an approved ENIG Proposal to the client from Isolated Sales. Use when Martin says \"release the proposal for MAT-n\", \"build the proposal document\" or \"draft the proposal email\", or a Proposal reaches Artifact Status Pending Identity Resolution. Verifies the record, resolves identity from a Confirmed Registry row, builds the document and email from the Approved Version only, sends on Martin's approval of the exact email and sets Status Sent. Never prices or edits substance."
---

# sales-proposal-release — steps

Rules: the Project Instruction (§n). Facts — Proposal fields, the release trigger, the Proposal Status rule (G3/U6 resolved, LOG-1164): the Project doc `enig-static-reference.md` (Ref, already in context). Exact calls: `references/notion-calls.md` in this skill's folder (Calls). If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Where a step says STOP, end your turn and report.

**Never in this skill:** change price, scope, intervention, rationale, terms or wording · set Proposal `Status` to anything but Sent (Accepted and Inactive belong to `sales-agreement` and Martin) · write identity into any Notion record · change Drive sharing or permissions · send without Martin's approval of the exact email · prepare or send an agreement (`sales-agreement`) · create a Handoff — there is no Sales → Sales Handoff; Runtime Sales returns work only through the Proposal record.

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Stage end state:** the approved Version delivered to the client with identity substituted; Artifact Status Delivered and Proposal Status Sent (or Artifact Status Created, waiting on Martin's attachment and send); one log entry.

## Before step 1
1. Find this skill's folder (its `scripts/` and `references/` sit beside this SKILL.md):
   `find / -maxdepth 9 -path '*sales-proposal-release/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`
   `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and tell Martin the plugin scripts can't be found.
2. Read `<SKILL>/references/notion-calls.md` once.
3. Load tools with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Notion__notion-fetch,mcp__Notion__notion-search,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-update-page,mcp__Notion__notion-create-pages,mcp__Google_Drive__copy_file,mcp__Google_Drive__create_file,mcp__Google_Drive__read_file_content,mcp__Gmail__send_message,mcp__Gmail__create_draft,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it; still missing → STOP and say which. Then call `notion-get-tool-access` with `{}` once (Calls §0).
4. **TEST RUN** in Martin's message: follow Project Instruction §11. Build nothing in Drive; send nothing.

## Steps

### 1. Fetch the Proposal and check the trigger
Calls §9 with the MAT-n. More than one → STOP and ask which. Then write this checklist in chat:
- `Approval Status = Approved: Pass/Fail`
- `Approved Version = Version: Pass/Fail`
- `Artifact Status = Pending Identity Resolution: Pass/Fail`
- `Artifact Action stated: Pass/Fail`
Any Fail → STOP and say which. Chat discussion is never Proposal approval.

### 2. Verify the chain
1. `validate_token.py entity "<Entity Token>"` and `validate_token.py matter "<Matter Token>"`.
2. Fetch the Matter (Calls §7) and confirm its Entity is the Entity Token.
3. Fetch the Proposal's `Handoff` relation and confirm its `Sources` carries `token:matter:<MAT-n>` for the same MAT-n (LOG-1149; a Handoff written before LOG-1149 may still show it in the old `Matter_Token` field instead).
Any mismatch → STOP; change nothing.

### 3. Resolve identity
Calls §6 with the ENT-n. The row must be Confirmed. Missing, more than one, or Needs Review → STOP. Identity goes only into the client document and email, never back into the Proposal or any governed record.

### 4. Build
Do what `Artifact Action` states (Drive document and/or email). Substitute identity into the Approved Version only: names, salutation, addressee, contact details. Nothing else changes. If a substantive change seems needed → STOP: Runtime Sales must produce a new Version for Martin's approval. Do not change Drive sharing or permissions. The upstream Version approval covers this build; it does not cover sending.

### 5. Record Created
Set `Artifact Reference` to a locator only (file or draft URL, never an identifying title) and `Artifact Status` = Created. Read back once.

### 6. Approval request
Show the exact email: recipient, subject, body, and the document it carries. Then:
- `Only identity substituted; substance unchanged: Pass/Fail`
- `No internal token in client text: Pass/Fail`
End with: "Approve by saying 'Approve proposal email for MAT-n'." Wait for explicit approval of that exact email (§4.2). STOP.

### 7. Send (§4.2)
The document can be attached by the available tools, or no attachment is needed → send it. Otherwise → `create_draft`, tell Martin to attach the document and send it, and do not claim it was sent.

### 8. Record Delivered
Once a send is confirmed (by the tool, or by Martin for a draft he sent), set `Artifact Status` = Delivered and Proposal `Status` = Sent in one update (LOG-1164), and read back once.

### 9. Log and stop
One log entry: `Type` Activity, `Area` Sales, `Outcome` Complete, `Entry` = `Proposal released for MAT-n`. No names. Next stage: when the client accepts, `sales-agreement` ("MAT-n accepted").

## STOP at
- Any request to reopen qualification, pricing, the quote or the intervention.
- Any write the Proposal record does not already provide for.
