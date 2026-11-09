---
name: sales-correspondence
description: ENIG Isolated Sales client correspondence and scheduling. Use when Martin pastes an email and asks what it means or how to reply, refers to a thread in connected Gmail, wants a draft, or needs to propose or book call times. Flags a brand-new enquiry for `sales-enquiry` instead of answering it. Drafts every email and calendar action for Martin's approval of the exact action; never states a price, quote or delivery commitment, never judges fit, never writes Entity/Matter records, never creates or offers a Handoff, and never sends a Proposal (`sales-proposal-release`). Part of the `enig-sales` plugin.
---

# sales-correspondence — steps

Rules: the Project Instruction (§n). Facts: the Project doc `enig-static-reference.md` (Ref, already in context). Exact calls: `references/notion-calls.md` in this skill's folder (Calls). Labelling: `references/evidence-examples.md` in this skill's folder (Examples). If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Where a step says STOP, end your turn and report.

**Never in this skill:** state or hint at a price, quote, budget, delivery date or capability promise · judge fit · write Entity, Matter, Registry, Call Notes, Proposals or Handoffs · create, offer or mention a Handoff · send a Proposal · send or book anything Martin has not approved in its exact form.

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Stage end state:** an approved email sent (no attachment) or sitting as a Gmail draft for Martin's attachment, and/or an approved calendar action done; new client evidence labelled in chat; one log entry.

## Before step 1
1. Find this skill's folder (its `scripts/` and `references/` sit beside this SKILL.md):
   `find / -maxdepth 9 -path '*sales-correspondence/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`
   `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and tell Martin the plugin scripts can't be found.
2. Read `<SKILL>/references/evidence-examples.md` once.
3. Load tools with one call to `ToolSearch` (it may be named `tool_search`): `select:mcp__Gmail__get_thread,mcp__Gmail__search_threads,mcp__Gmail__send_message,mcp__Gmail__create_draft,mcp__Gmail__reply,mcp__Notion__notion-create-pages,mcp__Notion__notion-fetch,mcp__Notion__notion-get-tool-access`. Any tool not returned → one keyword search for it; still missing → STOP and say which. Then call `notion-get-tool-access` with `{}` once (Calls §0). Calendar work only: also run `ToolSearch` with the query `calendar` (or `calendly`). No calendar tool → follow the missing-connector rule in `CONNECTORS.md`.
4. **TEST RUN** in Martin's message: follow Project Instruction §11. Send, draft and book nothing.

## Steps

### 1. Receive
Read the one Gmail thread once (`get_thread`, the whole thread, so earlier promises and questions are visible), or take the pasted text exactly as given. Gmail not reachable → ask Martin to paste the email and any earlier messages that matter.

### 2. New-enquiry check
First contact (no prior thread, a self-introduction, a broad "are you a fit" ask) → STOP. Say it looks like a new enquiry and that `sales-enquiry` comes first. Draft a short holding acknowledgment only if Martin explicitly asks for one.

### 3. Sort each ask
Put every question or request in the email into one of three groups:
| Group | What to do in the reply |
|---|---|
| Answerable directly | Answer it. |
| Pricing- or commitment-adjacent (a number, date, capability or availability promise) | Acknowledge it; say Martin will follow up. Never fill in the number, date or promise. |
| Needs an attachment | Name the attachment; step 7 makes a draft. |
A price-list request gets exactly the §8 wording: ENIG doesn't use a standard price list; pricing follows once the need is understood.

### 4. Label new evidence
List new client statements relevant to the Matter in chat, each with its class (Examples labelling table) and the Gmail thread/message locator. Do not write them from this skill. To record them, run `sales-enquiry` mode B with the MAT-n in this same chat.

### 5. Draft the email
Recipient, subject, plain-text body (no HTML entities such as `&amp;`), the §8 sign-off (Martin Kpogo, Founder, ENIG), attachments named. Match Martin's voice; ask if unsure. No internal token (ENT-n, MAT-n, HO-n, RES-n) ever appears in client text.

### 6. Approval request
Show the complete email: recipient, subject, body, attachments. Then three check lines:
- `No price, budget or amount: Pass/Fail`
- `No internal token: Pass/Fail`
- `No commitment beyond what Martin confirmed: Pass/Fail`
Any Fail → redraft first. End with: "Approve this email by saying 'Approve email'." STOP and wait. An edit request → revise and show the whole email again (§4.3).

### 7. Execute (only after "Approve email" or an equally explicit go-ahead naming the email)
- **No attachment needed:** send the approved email as plain text (`reply` in the thread, or `send_message`). No send tool → say so and give Martin the approved text.
- **Attachment needed:** `create_draft` with recipient, subject and body. Attach nothing yourself. Tell Martin to attach the file(s) and send it.
- Read the sent message or draft back once. Confirm in one line: sent, or draft waiting for an attachment.

### 8. **Scheduling** (only when a call time is booked or offered through a calendar tool)
1. Read availability from Google Calendar free/busy or Calendly. Never invent availability.
2. Draft the exact action with every field: tool, title, date, time, zone (Accra/GMT), duration (about 45 minutes), attendees, link, description. For a change or cancellation, show the current event beside the proposed one. No price, scope, fit judgement or internal token in invite text.
3. Ask for approval of that exact action: "Approve this calendar action by saying 'Approve booking'." Approving an email does not approve a calendar action, and the reverse. STOP and wait.
4. Execute exactly the approved action, read it back once, and confirm. Any failure: STOP and report the exact state; never create a second event to compensate.
5. A Calendly link inside an email still needs that email's own approval (steps 5–7).

### 9. Log and stop
One log entry (`Type` Activity, `Area` Sales, `Outcome` Complete) referencing the MAT-n Martin gave in chat (ask if none), e.g. `Correspondence sent for MAT-n` or `Sales call scheduled for MAT-n on <YYYY-MM-DD>`. Copy nothing from Gmail or the calendar into it.
Name the next stage: `sales-call-prep` once a call is booked, or `sales-enquiry` mode B in this chat if evidence was labelled. Do not offer or mention a Handoff.

## Notes
- Requests to quote, promise a date, judge the lead, draft a proposal or SOW, or send a Proposal: say which stage or Unit owns it and leave it (§3).
- The one Notion touch in this skill is the log entry in step 9.
