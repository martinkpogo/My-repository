# ENIG STUDIO SOP: DESIGN JOBS

**Status:** DRAFT. Not in force until Martin approves it. **Price list as of 24 Nov 2026.** Governing model: Design Jobs Operating Model (ENIG HQ / Business-Wide Operating Models), LOG-1351. Canonical text: the "ENIG Studio SOP" Notion page under Isolated Sales: Operating Specification. This file is the Claude Project's working copy and must match it.

## 0. When this applies

- Stand-alone design jobs sold as ENIG Studio: social media posts, logos, labels, packaging, and their add-ons.
- For design jobs this SOP governs wherever a skill or the Static Reference says otherwise (including "never state a price"). For everything else the Project Instruction and skills apply unchanged.
- An enquiry that may be consultancy (a business problem, not a design item): ask Martin which path. Never guess.

## 1. Never

- Quote an item not in §2, a blank price, or a price-list date that differs from §2.
- Send, write or change a status without Martin's approval of the exact action.
- Write a name, email, phone, web address, place or brand into any Notion record (Notes and Current_understanding included).
- Decline an enquiry without Martin's decision.
- Let AI set or change a price. Only Martin adjusts a price, and his reason is recorded.
- Pay or commit money for Martin, or place a print order before the print cost is paid.

## 2. Price list (GHS, starting prices)

| Item | Included | Price | Revisions | Delivery |
|---|---|---|---|---|
| Basic logo | 1 idea, simple wordmark or icon, final files | 500 | 1 | 1 working day |
| Full logo | 2–3 ideas, research, final files in every format | 1,500 | 2 | 3–5 working days |
| Single post | 1 design, final files | 250 | 1 | 1 working day |
| 5-post pack | 5 designs, final files | 1,000 | 1 per post | 1–2 working days |
| 10-post pack | 10 designs, final files | 1,800 | 1 per post | 2–3 working days; may be two halves (5 in 1–2 days, the rest by day 3) |
| Starter label | Front only, one product, one size, client's existing logo and text, print-ready file | 400 | 1 | 1–2 working days |
| Standard label | Front and back, one product, one size, 2 ideas, print-ready file and mock-up | 800 | 2 | 2–3 working days |
| Full packaging | Box, pouch or bag, every side, on the printer's template, print-ready file and mock-up | 1,800 | 2 | 5–7 working days |
| Whole product range | Several products or sizes | Martin quotes | — | Agreed per job |

- **Copywriting add-on (posts only):** +50 single · +200 for 5 · +300 for 10. Copy approved before design; 1 copy revision; client confirms every fact; marketing copy only (the client supplies legal or regulated text).
- **Printing add-on (only for designs ENIG Studio made):** print cost passed through and paid 100% up front. Coordination fee: GHS 100 for the first GHS 500 of print cost, + 10% of the part from 500 to 2,000, + 7% of the part from 2,000 to 10,000, + 5% of the part above 10,000. Each extra trip GHS 100.
- **Extra revisions and out-of-scope work:** GHS 150 an hour, minimum 1 hour; hours estimate approved first.
- **Minimum job value:** GHS 250.
- **Work not taken:** websites, photography, detailed illustration, running social media accounts.
- **Busy week:** Martin may give a longer delivery time, but only before the deposit is paid.

## 3. Calculations (always shown line by line to Martin)

- Quote total: each item × quantity + add-ons + printing fee (when printing is known).
- Printing fee: show each band, e.g. `100 + 10% × 1,000 = 200`. Check against: 200 → 100 · 1,500 → 200 · 5,000 → 460 · 20,000 → 1,310.
- Deposit and Balance: design total ÷ 2, rounded to 2 decimals; any rounding difference goes to the Balance. The print cost is not part of the 50/50 split.
- Quote gross amounts. Withholding tax is recorded at payment by the Payments Clerk.

## 4. Steps

**S1. Recognise.** Read the enquiry (Gmail or pasted). List what is asked against §2. Classify: Design job · Mixed (some items not taken) · Not taken (§5) · Below minimum (§5) · Not on the list or whole product range (ask Martin) · Possibly consultancy (ask Martin).

**S2. Records.** Run the existing `sales-enquiry` intake (Entity, Registry, Matter). In the same approval message, propose `Engagement_Type` = Design job on the new Matter. A returning client gets a new Matter linked to the existing Entity.

**S3. Brief.** Check what is needed to quote: item(s), quantity, sizes or formats, deadline, existing logo or brand files, whether copy is needed, and for printing the quantity, material, finish and delivery. Ask for everything missing in one draft reply for Martin's approval.

**S4. Quote.** Present to Martin in one message: the line-by-line calculation (§3), the price-list date and the delivery time; the quote email draft including the §6 terms; and one Matter update — `Current_understanding` = "Design job: {items}, GHS {total}, price list 24 Nov 2026. Quote sent {date}." and `Next_action` = "Quote sent; awaiting client acceptance." Martin approves the exact email, or adjusts the price with a reason (recorded in Current_understanding). Then send it and write the update.

**S5. Acceptance.** When the client accepts in writing (email, or WhatsApp text Martin pastes), present one conversion package for a single approval:

1. Payment `MAT-n deposit`: Matter_Token, Type Deposit, Amount = half, Currency, Status Due, Due_Date today, Notes "Design job: {items}, price list 24 Nov 2026".
2. Payment `MAT-n balance`: the same with Type Balance, Due_Date empty, Notes "Due on delivery".
3. Matter: Status Converted; `Evidence_source` gains the acceptance locator (`Gmail thread {id}, message {id}, {date}` or `WhatsApp acceptance pasted, {date}`).
4. Entity: Lead or Prospect → Client (no change if already Client).
5. Log: Type Activity, Area Sales, Outcome Complete, Entry "ENIG Studio · job won · MAT-n".

Then draft the deposit request for Martin. Work starts when the deposit is paid and the brief is complete.

**S6. Printing (if any).** Get the printer's price from Martin; quote print cost + fee (§3) in a separate approved email. Create the print-cost Payment (Type Other, Status Due, Notes "Print cost") on Martin's approval. No print order until it is Paid and the client has approved the final proof in writing.

**S7. Payments.** Martin records payments as Paid through the Payments Clerk in Telegram, as today. This SOP never sets a Payment to Paid.

**S8. Close.** When the work is delivered and the Balance is Paid, propose: Matter Status Closed, `Next_action` "Delivered and paid.", and a log entry "ENIG Studio · job closed · MAT-n".

## 5. Not taken or below minimum

1. Tell Martin why and offer three reply drafts: polite decline · decline with a referral · offer what ENIG Studio does (for below minimum: a single post or the hourly minimum).
2. Martin chooses and approves the exact reply.
3. No Entity, Registry or Matter. One log entry: Type Activity, Area Sales, Outcome Complete, Entry "ENIG Studio · declined · {work type}" (work type only, never who).

Mixed enquiry: normal S2–S5 for the items taken; the quote email politely excludes the rest.

## 6. ENIG Studio terms (in every quote email)

- What is included and the number of revisions, as quoted. Extra rounds or changes outside the scope are GHS 150 an hour, estimated and agreed first.
- 50% deposit before work starts; 50% balance on delivery.
- The delivery time starts once the deposit and the full brief are received. Time waiting for the client's feedback does not count.
- Printing: the print cost is paid in full before ordering; the client approves the final proof in writing; printed colours may vary slightly from the screen; the printer's deadline is an estimate.
- Copywriting: the client approves the copy before design and confirms every fact.
- Replying "yes, accepted" to this quote is your agreement to these terms.

## 7. Open item

Whole product range and other per-job quotes need a formal agreement. That process is not defined here yet: stop and ask Martin.

## 8. Notion calls (keep to these)

- Reads: none for rules. Only what the `sales-enquiry` intake already does, plus one fetch of the Matter at S5 and S8.
- Writes: S2 Engagement_Type (1) · S4 Matter update (1) · S5 package (2 Payments + Matter + Entity + Log = 5) · S8 (Matter + Log = 2) · §5 decline (1 Log).

## 9. Maintaining this file

Change the canonical Notion page first, through a logged Decision or Change, then copy it here. When a price changes, update §2 and the "Price list as of" date in both. Never name an individual record here.
