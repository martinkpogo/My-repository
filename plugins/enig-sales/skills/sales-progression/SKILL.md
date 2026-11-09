---
name: sales-progression
description: Executes ENIG's approved Sales progression event inside Isolated Sales. Use after `sales-fit-assessment` when Martin wants to progress a Matter ("progress MAT-n," "move this to Prospect," "hand this to Strategy"). Shows one progression package — the assessment, Entity Lead → Prospect, Matter Open → Qualified, the complete Sales → Strategy Work Handoff and the log entry — and executes it only on Martin's single explicit approval naming the MAT-n, with no second approval for the Handoff. Checks the live contracts first (gate G1) and stops on any failure. There is no Sales → Sales Handoff. Part of the `enig-sales` plugin.
---

# sales-progression — steps

Rules: the Project Instruction (§n). Facts — Handoff field values, progression sequence, contract links: the Project doc `enig-static-reference.md` (Ref, already in context). Exact calls: `references/notion-calls.md` in this skill's folder (Calls). Current decisions: the Ref section "Current decisions". If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Canonical basis: LOG-987, LOG-1140 (thin Handoff; evidence lives once, in Call Notes) and LOG-1149 (Entity and Matter travel as `Sources` token entries). Isolated Sales executes both transitions and creates the Sales → Strategy Work Handoff; Runtime Sales performs neither transition. Usually runs in the same chat as `sales-fit-assessment`.

Follow the sections in order. Where a step says STOP, end your turn and report.

**Never in this skill:** execute anything before Martin's approval naming the MAT-n · retry a failed write · create a second Handoff · create a Sales → Sales Handoff or a Handoff to any Unit other than Strategy · put pricing or budget content in the Handoff · write `Entity_Token` / `Matter_Token` (retired, LOG-1149).

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

## Before you start
1. Find this skill's folder (its `scripts/` and `references/` sit beside this SKILL.md):
   `find / -maxdepth 9 -path '*sales-progression/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`
   `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and tell Martin the plugin scripts can't be found. Never replace a script with a manual check.
2. Read `<SKILL>/references/notion-calls.md`, `evidence-examples.md` and `checks.md` once each (skip any already read in this chat).
3. Load tools with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Notion__notion-fetch,mcp__Notion__notion-search,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-create-pages,mcp__Notion__notion-update-page,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it; still missing → STOP and say which. Then call `notion-get-tool-access` with `{}` once (Calls §0).
4. **TEST RUN** in Martin's message: follow Project Instruction §11. Build and show the package; execute nothing.

## 1. Preconditions (all must pass)
1. **Assessment.** A fit assessment for this MAT-n exists in this chat with outcome Qualified, or Martin has given an explicit override naming each condition it covers (§4.4). Otherwise STOP and run `sales-fit-assessment`.
2. **Log check** (§10). Make Calls §1 exactly against the Project doc's "Log reviewed through" baseline. No newer Decision → continue. A newer one → summarise it, and continue once Martin confirms it does not change this progression (§10).
3. **States.** Use the Matter already read in this chat; fetch the Entity by its relation. Expected: Entity Lead, Matter Open. Already advanced (Entity Prospect, or Matter Qualified) → skip the transitions already done and complete only what is missing (§5); say which. Any other state → report it and ask Martin.
4. **Tokens.** Run `validate_token.py entity-title "<Entity Record title>"` and `validate_token.py matter-title "<Matter title>"` on the titles exactly as Notion holds them. A non-zero exit → report it to Martin as a legacy violation and STOP. (The `Entity_ID` / `Matter_ID` fields may come back as a bare number such as `27`; the token is `ENT-27` / `MAT-27`. Use the title's token, never a number on its own.)

## 2. Build the package (shown as one item)
1. **The assessment**, with every gap and any override exactly as Martin stated it.
2. **The transitions:** ENT-n Lead → Prospect; MAT-n Open → Qualified.
3. **The Call Notes source.** List the Matter's Call Notes (Calls §10). The route accepts one link: one record → use it; several → Martin names the one to reference; none → offer `sales-call-evidence` first (the thin Handoff depends on it). Read its `Note` and copy its Commercial Value Evidence block exactly (no block → offer a new Call Notes Version via `sales-call-evidence`; never write one here).
4. **The complete Handoff**, exactly as it will be written — the Ref "Sales → Strategy Work Handoff values (thin)" table, with the Calls "Sales → Strategy Handoff create" requirements:
   - `Handoff` = `Sales→Strategy · ENT-n / MAT-n`; `Type` Work; From Sales / Sales Executive; To Strategy / Strategy Analyst; `Status` Pending.
   - **No `Entity_Token` / `Matter_Token`** (retired, LOG-1149).
   - `Sources` = `python3 <SKILL>/scripts/handoff_attestation.py sources --entity <ENT-n> --matter <MAT-n> --call-notes <Call Notes page URL>`, exactly as printed.
   - `Work Completed` = one or two lines: Sales stages completed, the fit outcome, the referenced Call Notes ID.
   - `Verified Facts & Sources` = `Evidence: see Sources (CN-…).`, only facts not in the Call Notes record (with locators), then the copied Commercial Value Evidence block, byte-for-byte (the compatibility copy, Project Instruction §8).
   - `Assumptions` / `Open Questions` = only INF / HYP and UQ items not in the Call Notes record; otherwise `See Sources.`
   - `Required Next Action`, `Expected Output`, `Acceptance Criteria` = the Ref values.
   - `Reason` = `Martin approved progression on <YYYY-MM-DD>; diagnosis and intervention design are required` (+ any override, named by condition), then the `source_boundary_check` marker printed by the source-boundary check below.
5. **The log entry:** `Type` Decision, `Area` Sales, `Outcome` Active, identity-safe, recording the approval date and any override.

Then the source-boundary check over every Handoff text field except `Sources` (and the log text):
1. Write them to `draft.txt`.
2. `python3 <SKILL>/scripts/handoff_attestation.py source-boundary --text-file draft.txt --entity <ENT-n> --matter <MAT-n> --entity-name "<registered name>" --contact-name "<contact>" --email "<email>" --phone "<phone>" --identity "<other names, places, handles>" …` — give each identity value known in this chat; leave out options with no value.
3. It prints the `source_boundary_check` marker only when all five checks pass. FAIL → remove only the identity and run again. Still failing after two redrafts → hard stop 2: show Martin the phrases.
4. WARN lines → re-read each named phrase.
5. Write the seven-line read-through from `references/checks.md` §1 (line 7 = the source-boundary result line).

## 3. Approval
Show the whole package, the scan result line and the seven read-through lines. Ask for Martin's one explicit approval in this chat naming the `MAT-n`, e.g. "Approved — progress MAT-33". That approval covers items 1–4 exactly as shown; there is no second approval for the Handoff. STOP and wait.
- "OK", "go ahead" or "yes" without the MAT-n is not approval: ask him to name the MAT-n.
- An edit request → revise and show the whole package again (§4.3).

## 4. Execute (only after that approval)
Do these in order. After each, read the page back once and compare with the approved package.
1. **G1 check.** Fetch the Entity contract and the Matter contract by their Ref links. Proceed only if both transitions are assigned to Isolated Sales. If not → STOP, show the approved package, and report that governance does not authorise execution. Execute nothing.
2. Entity `Status` Lead → Prospect → read back.
3. Matter `Status` Open → Qualified → read back.
4. Create the Sales → Strategy Handoff exactly as approved → read back every field. Run `validate_token.py handoff "<HO-n>"` on the returned ID. Then write the read-back `Reason`, `Verified Facts & Sources` and `Sources` to files and run `python3 <SKILL>/scripts/handoff_attestation.py verify --entity <ENT-n> --matter <MAT-n> --reason-file … --vfs-file … --sources-file … --call-notes <Call Notes page id>`. FAIL → hard stop 4: report exactly what exists; never edit or recreate the Handoff. Keep the URL and HO-n.
5. Write the log entry → read back.

Any failure → STOP and report exactly which steps completed and which did not. Never roll forward, never retry blindly, never create a second Handoff to compensate.

## 5. Stop
Report: ENT-n Prospect, MAT-n Qualified, HO-n Pending (verify PASS), log written, with links. The Matter now moves through Strategy → Finance → Runtime Sales. Isolated Sales acts next at `sales-proposal-release`, in a new chat. Never create a Sales → Sales Handoff, or a Handoff to any Unit other than Strategy.
