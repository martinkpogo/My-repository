---
name: sales-fit-assessment
description: Isolated Sales fit assessment for an ENIG Matter after the sales call. Use when Martin asks "is this a fit," "assess fit," "does this qualify," "can we progress MAT-n," or wants the outcome after call evidence has been captured. Rates the five canonical qualification conditions against the call evidence held in this chat and the Matter summary, keeps evidence separate from inference, preserves the unresolved investment-range condition (U1), and returns Qualified, More Information Required, or Not Qualified. Never delegated to Runtime Sales; changes no status and never creates or offers a Handoff. Part of the `enig-sales` plugin.
---

# sales-fit-assessment — steps

Rules: the Project Instruction (§n). Facts — the five conditions, ratings, outcomes, specialization scope: the Project doc `enig-static-reference.md` (Ref, already in context). Line format and labelling: `references/evidence-examples.md` (Examples). If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Where a step says STOP, end your turn and report.

**Never in this skill:** change a Status · create, offer or mention a Handoff · suggest a price, budget or range · treat INF or HYP as enough for Supported · propose an override.

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Stage end state:** an assessment in chat and one log entry. Usually runs in the same chat as `sales-call-evidence`; it can also run later from the approved Call Notes records.

## Before step 1
1. Find this skill's folder (its `scripts/` and `references/` sit beside this SKILL.md):
   `find / -maxdepth 9 -path '*sales-fit-assessment/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`
   `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and tell Martin the plugin scripts can't be found.
2. Read `<SKILL>/references/notion-calls.md` and `evidence-examples.md` once each (skip any already read in this chat).
3. Load tools only if needed with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Notion__notion-fetch,mcp__Notion__notion-search,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-create-pages,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it; still missing → STOP and say which. Then call `notion-get-tool-access` with `{}` once (Calls §0).
4. **TEST RUN** in Martin's message: follow Project Instruction §11.

## Steps

### 1. Inputs
Confirm the MAT-n. Use the Matter already read in this chat; fetch it only if it hasn't been (§9).
Evidence comes from three places only:
- the call evidence structured earlier in this chat;
- the `Note` of each approved Call Notes record for this Matter (Calls §10) — never a page body;
- the Matter's approved `Current_understanding`.
Not Gmail, other projects' memory, Logs or Handoffs. Anything missing is a gap, not something to reconstruct.
No call evidence in this chat, no Call Notes record and nothing on the Matter → `sales-call-evidence` runs first; offer it.

### 2. Rate each condition
Use the Examples fit-assessment line format, one line per condition:
`<n>. <condition> — <rating>. Evidence: (<CLASS>) <item>, <locator>. Gap: <what is missing, or "none">.`

Rating rules:
| Evidence for the condition | Rating |
|---|---|
| CS, VE, CF or SO that fully meets it | Supported |
| Some evidence, but part is missing | Partial |
| Nothing, or only INF / HYP | Not evidenced |
| Evidence that goes against it | Contradicted |
| Condition 1 and the specialization scope can't be read | Not assessable |

- **Condition 1:** rate the client's underlying problem, not the requested deliverable, against the specialization scope in Ref (the canonical `specialization_scope` from Business-Wide Operating Principles). A request for a logo is not itself within or outside scope; the problem behind it is what you rate. If that section cannot be read, mark the condition **Not assessable**.
- **Condition 3:** rate both parts — attributable numerical value at stake, and a numerical investment range or boundary (U1). Record a stated range exactly as stated, "no fixed budget" as said, and an absent range as Not evidenced. Never infer a range from vague language, and never compute or suggest an amount. Show each part on its own line; the condition is Supported only when both parts are.

### 3. Report alongside
Without letting it decide the outcome: requested deliverable vs. underlying problem; what changed; consequence of inaction; desired outcome; decision process by role; risks.

### 4. Outcome
Apply the Ref rule mechanically:
- all five Supported → **Qualified**;
- any Contradicted, or fit implausible → **Not Qualified**;
- otherwise (any Partial, Not evidenced or Not assessable) → **More Information Required**, naming each gap and the next diagnostic step.

### 5. Escalate unsupported conditions
For each condition that is not Supported, say plainly: "Condition <n> is not met on the evidence. The decision is Martin's." An override is his alone and must follow §6: explicit, naming each condition it covers, logged as a Decision. Never propose one, and never word the result as if one had been given.

### 6. Log
One log entry: `Type` Activity, `Area` Sales, `Outcome` Complete, `Entry` = `Fit assessed for MAT-n: <outcome>`. No names.

### 7. Next stage
- Qualified, or an explicit override from Martin → `sales-progression`.
- More Information Required → a new chat for `sales-correspondence` or `sales-call-prep`.
- Not Qualified → the decision is Martin's.

Never create or offer a Handoff from this skill.
