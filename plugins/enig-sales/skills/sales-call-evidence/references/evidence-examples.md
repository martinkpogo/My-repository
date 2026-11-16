# Evidence labelling — rules, template, worked example

Read this whenever a skill drafts Matter evidence, call evidence, a fit assessment or Handoff text.

## Labelling table

| What you have | Label |
|---|---|
| Something the client said about their business | CS, with the speaker's role: `(CS, Managing Director)` |
| A number the client gave (revenue, %, enquiries, loss) | VE, written in the VE format below. Its class is CS. Never CF. |
| What the client thinks the cause or the fix is | HYP: `(HYP) Client-suggested cause: … To test.` |
| Something independently checked (document, public record you can cite) | CF, with the locator |
| What Martin or you observed on a call | SO |
| A conclusion you drew | INF — never enough to make a condition Supported |
| Something that matters but was not stated | UQ |
| Budget words ("no fixed budget yet", "around GHS 30,000") | CS, quoted exactly, then `Recorded as stated; not treated as a confirmed investment range or boundary.` |
| No budget words at all | `(UQ) Investment range or boundary.` |

**Never:**
- upgrade a class (CS → CF, HYP → CS, INF → CS);
- round, convert or estimate a figure;
- write "no budget", "budget unknown", "low budget" or any range of your own;
- treat pipeline or hoped-for sales as value at stake;
- delete a figure to make text identity-safe — remove only the identity.

## VE format

`(VE) <figure as stated>. Unit: <unit>. Period: <period or "not stated">. Source: <client statement (role), locator>. Class: CS. Uncertainty: <what is approximate or missing>.`

## Current_understanding template

Section headings on their own line, items as `- (CLASS) …` bullets, one blank line between sections. Use every heading, in this order. A section with nothing known gets one `(UQ)` line.

```
Stated need
- (CS, <role>) …

Underlying problem as understood
- (CS) …
- (HYP) Client-suggested cause: … To test.
- (UQ) …

Value evidence
- (VE) <figure>. Unit: … Period: … Source: … Class: CS. Uncertainty: …

Investment indication
- (CS) "<exact words>". Recorded as stated; not treated as a confirmed investment range or boundary.
  — or, if no budget words —
- (UQ) Investment range or boundary.

Decision process
- (CS) <roles only> …
- (UQ) …

Constraints
- (CS) …

Unknowns
- (UQ) …

Last updated <YYYY-MM-DD>, from <locator>.
```

## Worked example (fictional test client, 2026-10-05)

**Source (pasted enquiry, identity removed):** the Managing Director of a mid-sized agro-processing business supplying packaged grains to supermarkets says two major retail buyers moved to a competitor over the last year; feedback was that the brand "feels dated" next to newer suppliers; those two accounts were roughly 30% of revenue; "we think we need a new logo and packaging, but honestly we're not sure that's the real issue"; "no fixed budget yet, but we want to move within the next quarter."

**Correct Current_understanding:**

```
Stated need
- (CS, Managing Director) Wants help working out what is actually going wrong in how customers see the business; has considered a new logo and packaging but is unsure that is the real issue.

Underlying problem as understood
- (CS) Two major retail buyers moved to a competitor over the last year.
- (CS) Feedback received was that the brand "feels dated" next to newer suppliers.
- (HYP) Client-suggested cause: dated logo and packaging. To test.
- (UQ) Whether perception caused the account losses, or other factors did.

Value evidence
- (VE) Sales to the two lost accounts were roughly 30% of revenue. Unit: share of total revenue. Period: not stated; losses occurred over the last year. Source: client statement (Managing Director), Pasted enquiry, received 2026-10-05. Class: CS. Uncertainty: "roughly"; revenue base, currency and absolute figures not stated.

Investment indication
- (CS) "No fixed budget yet." Recorded as stated; not treated as a confirmed investment range or boundary.
- (UQ) Investment range or boundary.

Decision process
- (CS) Enquiry sent by the Managing Director.
- (UQ) Other decision-makers and approval route.

Constraints
- (CS) Wants to move within the next quarter.

Unknowns
- (UQ) Absolute revenue and value of the lost accounts.
- (UQ) Timing of each account loss.
- (UQ) Whether "move within the next quarter" means a decision, a start or completion.

Last updated 2026-10-05, from Pasted enquiry, received 2026-10-05.
```

**Mistakes this example avoids:**

| Wrong | Right |
|---|---|
| `(CS) Client needs a new logo and packaging.` | `(HYP) Client-suggested cause: dated logo and packaging. To test.` |
| `(CF) Lost accounts were 30% of revenue.` | `(VE) … roughly 30% … Class: CS.` |
| `(CS) No budget.` | `(CS) "No fixed budget yet." Recorded as stated; …` |
| `(CS) No investment range was given.` | `(UQ) Investment range or boundary.` |
| `(CS) Kojo, the MD, said …` | `(CS, Managing Director) …` |
| `Agro-processor in Kumasi with 120 staff` | `Agro-processing; packaged grain products supplied to supermarket retail buyers.` |

## Commercial Value Evidence record (for `handoff_attestation.py cve`)

Build `evidence.json` from the VE items only, copying figures exactly as labelled. Never invent, round or re-estimate.

```
{"determination": "Satisfied | Not Satisfied | Insufficient Evidence",
 "evidenceText": "<one or two identity-safe sentences naming the figure, its source by role, and its period>",
 "evidence": {"financialConsequence": "…",
              "valueAtStake": {"value": <number>, "currency": "<as stated>", "period": "<as stated>", "evidenceType": "client_estimated", "source": "<role, locator>", "limitations": "…"},
              "uncertainty": "…"}}
```

`evidence` is `null` when the call held no value evidence. `evidenceType` is one of `directly_measured`, `client_estimated`, `derived`, `assumption`; a client's figure is `client_estimated`. The determination follows the Project doc's rule (Satisfied only with a non-assumption figure, an attributable source and a period); Martin attests it when he approves the Call Notes record.

## Fit-assessment line format

`<n>. <condition name> — <Supported | Partial | Not evidenced | Contradicted | Not assessable>. Evidence: (<CLASS>) <item>, <locator>. Gap: <what is missing, or "none">.`

Example: `3. commercial_value_evidence — Partial. Evidence: (VE) roughly 30% of revenue lost with two accounts, Pasted enquiry, received 2026-10-05. Gap: no numerical investment range or boundary (U1); "No fixed budget yet" recorded as stated.`
