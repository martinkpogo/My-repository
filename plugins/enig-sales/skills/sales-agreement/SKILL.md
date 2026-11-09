---
name: sales-agreement
description: ENIG Isolated Sales client agreements (CSA), after a released Proposal. Use when Martin says "MAT-n accepted," "prepare the agreement for MAT-n," "send the agreement," or "MAT-n agreement signed." Marks the Proposal Accepted on Martin's confirmation, builds the Client Service Agreement from the approved Template and the exact Approved Version (identity substituted into the client document only), sends it on Martin's approval of the exact email, and records it Signed on his confirmation, offering the 50% Deposit and Balance Payment rows. Never prices, changes terms or scope, invents a timeline, writes identity into Notion, or marks a Payment Paid. Part of the `enig-sales` plugin.
---

# sales-agreement — steps

Rules: the Project Instruction (§n). Facts: the Project doc `enig-static-reference.md` (Ref). Governing contracts: CSA (ENIG HQ / 5. Data / CSA), Payment (ENIG HQ / 5. Data / Payment), Proposal. Exact calls: `references/notion-calls.md` in this skill's folder (Calls); the Agreements, Payments and Template locations below. If a step conflicts with the Instruction, follow the Instruction and report the conflict.

Follow the steps in order. Where a step says STOP, end your turn and report.

**Never in this skill:** change price, currency, scope, deliverables, timeline or any Template term · compute anything except the 50/50 split of the Proposal's Quoted Price · invent a timeline the Approved Version does not state · write identity into any Notion record · mark an Agreement Signed without Martin's confirmation of a signed PDF or written email acceptance · create any Payment row other than the two in step 9 · set a Payment `Paid` · change Drive sharing or permissions · send without Martin's approval of the exact email · create a Handoff.

**Errors (Project Instruction §5–§6):** a failed read → retry up to twice, then solve first and offer ways forward. A failed write, or one whose outcome is unknown → hard stop 4: find out what took effect, never repeat it, and offer a resume plan from the failed step. Lookups use only the search, fetch and backlinks calls in Calls (§9); never `notion-query-data-sources`.

**Locations**
- Agreements: `collection://6b71106b-5cbe-4bd3-831e-2c1dd96d0a34` (fields: `Agreement` title `MAT-n agreement`, `CSA_ID`, `Matter_Token`, `Proposal_Token`, `Proposal_Version`, `Status` Draft/Sent/Signed/Cancelled, `Document_Reference` URL, `Sent_Date`, `Signed_Date`, `Signature_Evidence` Signed PDF/Email acceptance).
- Payments: `collection://703a276e-2183-4f89-9627-9625b099a851` (fields: `Payment` title, `Matter_Token`, `Proposal_Token`, `Type` Deposit/Balance/Other, `Amount`, `Currency` GHS/USD, `Status` Due/Paid/Waived, `Due_Date`, `Paid_Date`, `Method`, `WHT_Deducted`, `Invoice_Number`, `Notes`).
- Template: Notion page `413cb004-e583-81f4-8673-fab4361d34f3` ("Client Service Agreement Template"), fetched live every run.

**Stage end states:** (A) Proposal Accepted · (B) Agreement Sent · (C) Agreement Signed with Deposit and Balance rows Due. One log entry per completed stage.

## Before step 1
1. Find this skill's folder: `find / -maxdepth 9 -path '*sales-agreement/scripts/validate_token.py' -not -path '/proc/*' 2>/dev/null | head -1`. `<SKILL>` = that path minus `/scripts/validate_token.py`. No result: STOP and say the plugin scripts can't be found.
2. Read `<SKILL>/references/notion-calls.md` and `checks.md` once each.
3. Load tools with one `ToolSearch` call: `select:mcp__Notion__notion-fetch,mcp__Notion__notion-search,mcp__Notion__notion-list-page-backlinks,mcp__Notion__notion-update-page,mcp__Notion__notion-create-pages,mcp__Google_Drive__create_file,mcp__Google_Drive__read_file_content,mcp__Gmail__send_message,mcp__Gmail__create_draft,mcp__Notion__notion-get-tool-access`. Any missing → one keyword search; still missing → STOP and say which. Call `notion-get-tool-access` with `{}` once.
4. **TEST RUN** in Martin's message: follow Project Instruction §11. Create, send and write nothing.

Pick the part from Martin's request: "accepted" → A; "prepare/send the agreement" → B; "signed" → C.

## A. Proposal accepted (U6)

### 1. Fetch the Proposal
Calls §9 with the MAT-n. More than one → ask which. Checklist in chat:
- `Approval Status = Approved: Pass/Fail`
- `Approved Version = Version: Pass/Fail`
- `Artifact Status = Delivered: Pass/Fail`
- `Status = Sent: Pass/Fail` (a Proposal released before LOG-1164 may still show Draft; say so and continue only if Artifact Status is Delivered)
Any other Fail → STOP and say which.

### 2. Approval request
Show: the change `Status → Accepted`, and the acceptance evidence Martin cites (email thread or message locator — never a name in the record). End with: "Approve by saying 'Approve MAT-n accepted'." STOP.

### 3. Write and log
Set Proposal `Status` = Accepted. Read back once. Log: `Type` Activity, `Area` Sales, `Outcome` Complete, `Entry` = `Proposal accepted for MAT-n`, `Activity / Event` naming the evidence locator. Offer part B.

## B. Prepare and send the agreement

### 4. Check the trigger and for an existing agreement
Fetch the Proposal (Calls §9): `Status = Accepted`, `Approval Status = Approved`, `Approved Version = Version`. Any Fail → STOP (offer part A if only Status is short).
Find the agreement (Calls §11). A Draft or Sent row exists → resume from its state; a Signed row exists → STOP (already signed). Cancelled rows are ignored.

### 5. Verify the chain and resolve identity
1. `python3 <SKILL>/scripts/validate_token.py entity "<Entity Token>"` and `... matter "<Matter Token>"`.
2. Fetch the Matter (Calls §7) and confirm its Entity is the Entity Token.
3. Fetch the Registry row for the ENT-n (Calls §6). It must be Confirmed. Missing, more than one, or Needs Review → solve first (§5): ask Martin to confirm it, or use identity he gives in chat for this document only. Never guess identity.
Any token mismatch → STOP; change nothing.

### 6. Build the document
1. Fetch the Template page. Missing or empty → STOP.
2. Fill the brackets only:
   - Parties: the Registry `Real_Name` (registered name) and address. No address in the Registry → ask Martin for it, for this document only.
   - What this covers: `PROP-n`, the Approved Version, its date.
   - Scope: the scope and deliverables sections of the Approved Version, word for word.
   - Price: the Proposal's `Quoted Price` and its currency exactly as the Approved Version states them.
   - Timeline: as the Approved Version states it. **No timeline in the Approved Version → STOP**: Runtime Sales must produce a new Version; never write one.
3. Every other Template word stays exactly as fetched.
4. Create the Drive document (`create_file`). Do not change sharing or permissions.

### 7. Approval request
Show the exact email (recipient, subject, body) and the document link. Then the checks:
- `python3 <SKILL>/scripts/scan_identity_leakage.py - --client-facing` on the document text, then on the email: no internal tokens in client text: Pass/Fail
- `python3 <SKILL>/scripts/scan_identity_leakage.py -` on the Agreements record values you will write, with `--identity` set to the client's name, contact name, email and phone: no hard failures: Pass/Fail
- `Only brackets filled; every Template term unchanged: Pass/Fail`
- `Scope, price and timeline match the Approved Version exactly: Pass/Fail`
- `Agreements record holds tokens and a link only: Pass/Fail`
- the seven-line read-through from `references/checks.md` §1 (client-facing rules for the document and email)
End with: "Approve by saying 'Approve agreement for MAT-n'." STOP.

### 8. Record and send
1. Create the Agreements row: `Agreement` `MAT-n agreement`, `Matter_Token`, `Proposal_Token`, `Proposal_Version` (the Approved Version), `Status` Draft, `Document_Reference` (the document URL only). Read back.
2. Send the approved email (attaching or linking the document as the tools allow; if neither, `create_draft` and tell Martin to attach and send — never claim a send).
3. Once the send is confirmed: `Status` Sent, `Sent_Date` today. Read back.
4. Log: `Entry` = `Agreement sent for MAT-n`. Remind Martin: work starts only once the agreement is signed and the deposit is paid.

## C. Agreement signed

### 9. Confirm signature and prepare payments
Trigger: Martin says the agreement for MAT-n is signed and says how (signed PDF returned, or written acceptance by email), with its locator.
1. Fetch the Agreements row (Calls §11): must be `Status` Sent. Check Payments for MAT-n (Calls §12): Deposit or Balance rows already there → show them and ask Martin before creating any. Otherwise → STOP and say its state.
2. Fetch the Proposal for `Quoted Price` and currency. Compute `Deposit = Balance = Quoted Price ÷ 2` (round to the currency's two decimals; any rounding difference goes to the Balance). This is the only arithmetic allowed.
3. Show, for one approval:
   - Agreements row: `Status` Signed, `Signed_Date`, `Signature_Evidence` (Signed PDF / Email acceptance); a signed PDF's Drive link may replace `Document_Reference` (link only).
   - Payment 1: `Payment` `MAT-n deposit`, `Matter_Token`, `Proposal_Token`, `Type` Deposit, `Amount`, `Currency`, `Status` Due, `Due_Date` today, `Invoice_Number` if Martin gives one.
   - Payment 2: `Payment` `MAT-n balance`, same tokens, `Type` Balance, `Amount`, `Currency`, `Status` Due, `Due_Date` empty (due on completion of delivery), `Notes` `Due on completion of delivery`.
   - `scan_identity_leakage.py -` over every value of the three records, with `--identity` as in step 7: no hard failures: Pass/Fail. Tokens, amounts and dates only; no names in any field, Notes included.
   End with: "Approve by saying 'Approve signed agreement for MAT-n'." STOP.

### 10. Write and log
Update the Agreements row, then create the two Payment rows. Read each back once. A failed write → hard stop 4: find what took effect before anything else. Log: `Entry` = `Agreement signed for MAT-n`. Tell Martin: work may start once the Deposit row is marked Paid (he records the payment; this skill never marks it Paid).

## STOP at
- Any request to change price, scope, terms or timeline (Finance or a new Proposal Version).
- An Approved Version without a timeline.
- Marking Signed without Martin naming the signature evidence.
- Any write the CSA or Payment contract does not provide for.
