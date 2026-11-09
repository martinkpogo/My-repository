---
name: sales-call-prep
description: "Prepares Martin for an upcoming ENIG sales call inside Isolated Sales, for an Entity/Matter that already exists. Use when Martin asks to \"prep me for the call,\" \"get me ready for the call with this client,\" or \"what do we still need to learn on the call.\" Reads the one Matter, its Registry row and its Gmail thread once, and produces a brief in chat only: what is known (with evidence classes), the evidence each canonical qualification condition still lacks, and the questions that would surface it. Never scores or qualifies, never suggests a price, budget or indicative amount, never fabricates missing evidence, and never creates or offers a Handoff. Part of the `enig-sales` plugin."
---

# sales-call-prep — steps

Rules: the Project Instruction (§n). Facts — qualification conditions, specialization scope, data sources: the Project doc `enig-static-reference.md` (Ref, already in context). Exact calls: `references/notion-calls.md` in this skill's folder (Calls). Labelling: `references/evidence-examples.md` in this skill's folder (Examples). If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Where a step says STOP, end your turn and report.

**Never in this skill:** rate a condition or give an outcome · suggest a price, budget or indicative amount · fill a gap with a guess · write anything to Notion except the log entry · create, offer or mention a Handoff.

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Stage end state:** a brief in chat and one log entry. Martin conducts the call; this stage only prepares him.

## Before step 1
1. Find this skill's folder (its `scripts/` and `references/` sit beside this SKILL.md):
   `find / -maxdepth 9 -path '*sales-call-prep/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`
   `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and tell Martin the plugin scripts can't be found.
2. Read `<SKILL>/references/notion-calls.md` and `evidence-examples.md` once each.
3. Load tools with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Notion__notion-fetch,mcp__Notion__notion-search,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-create-pages,mcp__Gmail__get_thread,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it; still missing → STOP and say which. Then call `notion-get-tool-access` with `{}` once (Calls §0).
4. **TEST RUN** in Martin's message: follow Project Instruction §11.

## Steps

### 1. Identify the Matter
Get the MAT-n from Martin. Fetch by URL if known, otherwise Calls §7. No Matter → STOP; `sales-enquiry` runs first. Unclear which Matter → STOP and ask.

### 2. Who is attending
Take the Entity page from the Matter's `Entity` relation, fetch it, and read its ENT-n. Then Calls §6 with that ENT-n, once. Use the name, organisation and contact role in the brief only. No row, or `Resolution_Status` is Needs Review → say so and ask Martin who is attending. Identity stays in chat; never write it anywhere.

### 3. Gather evidence
Use the Matter's `Stated_need`, `Current_understanding`, `Evidence_source` and `Next_action`.
- `Evidence_source` names a Gmail thread → read that thread once (`get_thread`).
- It says "Pasted enquiry" → there is no thread. Ask Martin to paste any recent emails that matter.
Read the `Note` of each approved Call Notes record for this Matter (Calls §10) — never a page body. Do not use other projects' memory, Logs or Handoffs for evidence.

### 4. Flag unrecorded evidence
Client statements in the thread that are not on the Matter: list each with its class and locator, and tell Martin they can be recorded before the call with `sales-enquiry` mode B.

### 5. Write the brief in chat
Use exactly these headings. Label every item with its class.

```
Call brief — MAT-n

Attending
- <name>, <role>, <organisation>   (chat only)

Need and problem
- Stated need: (CS) …
- Underlying problem as currently understood: (CS)/(HYP)/(UQ) …

What is evidenced vs only stated
- Evidenced (CF/VE): …
- Stated only (CS): …
- Inferred or hypothesised (INF/HYP): …

Gaps by condition   (gaps only — never a rating)
1. within_specialization — the call must learn: <what about the underlying problem, against the Ref specialization scope>
2. allows_diagnosis_first — missing: …
3. commercial_value_evidence — missing: <numerical value at stake>; <the client's own investment range or boundary (U1)>
4. open_to_ballpark_amount_and_time — missing: …
5. ready_to_commit_required_resources — missing: …

Questions for Martin to ask
- What changed? / What happens if nothing changes? / What outcome do you want?
- Who decides, and how? (roles)
- <numerical value at stake>
- What range or boundary would you consider reasonable for this? (ask; never propose one — U1)
- Would you be open to us diagnosing before any solution is fixed?
- What time, access and people could you commit?

Risks and unknowns
- (UQ) …
```

### 6. Log and stop
One log entry: `Type` Activity, `Area` Sales, `Outcome` Complete, `Entry` = `Call prep brief prepared for MAT-n`. No names.
Name the next stage: `sales-call-evidence`, after Martin's call. Do not offer or mention a Handoff.

## Notes
- Martin wants a figure to communicate on the call: that is his or Finance's decision; leave it out of the brief (§3).
- A gap stays a gap; never fill one with a plausible guess (§5).
- Scheduling is `sales-correspondence` step 8, not this skill.
