# ENIG Sales — checks

Read this before any approval request (§1) and in any TEST RUN (§2).

## 1. Seven-line identity-safety read-through

Do this before **every** approval request, after the drafts are final and the scan has run. Report all seven lines in the approval message, each with its actual result: `Pass`, `Fail`, `Borderline` or `Not applicable`, then ` — <reason>`.

1. **Titles** — bare token plus a generic label; no names anywhere in a title, including `Resolution_ID`.
2. **Governed fields outside the Registry** — no names, company or brand names, locations, emails, phones, web addresses or document titles. (Client email or document text addressed to the client: check instead that no internal token — ENT-n, MAT-n, PROP-n, HO-n, CSA-n, PAY-n, RES-n, CN-… — appears in it.)
3. **Combinations** — no two or three details that together identify the client; never sector + location + size. A figure next to a narrow sector is `Borderline`.
4. **Evidence labels** — client numbers and reasons are CS or VE, never CF; client-suggested causes are HYP.
5. **Budget wording** — investment words exactly as stated; an unresolved discussion is never turned into a range. No price, quote or budget of ours.
6. **Registry accuracy** — the Registry row matches the source; `Resolution_Status` is left to Martin. `Not applicable` when no Registry row is written or used.
7. **Automated scan** — the result line of `scan_identity_leakage.py --identity …` for governed text, `handoff_attestation.py source-boundary` for a Handoff, or `scan_identity_leakage.py --client-facing` for text addressed to the client. Any hard fail blocks the request.

Rules:
- Never claim the read-through ran without showing the seven lines.
- Any `Fail` → redraft and run again before asking. Never present an unresolved hard fail as a pass.
- `Not applicable` needs a reason; it is never used for lines 2 or 7.
- Client-facing text (an email, invite, the Proposal document or the agreement) is meant to carry the client's identity: lines 1, 3 and 6 are usually `Not applicable`; line 2 checks for internal tokens; line 5 checks that no price, quote, budget or commitment beyond what Martin confirmed appears (for a released Proposal or an agreement: none beyond the Approved Version).

## 2. TEST RUN compatibility checks

In a TEST RUN, report on each of these from the installed plugin and live records, as verified, not verified, or not applicable to the stage:

1. The Call Notes writer (`call_notes_attestation.py`) produces the contract's six-field `record_approval` marker with ENT-n / MAT-n tokens, never page IDs.
2. Substantive call content goes only into `Note`, never the page body; the `Note` ends with the Commercial Value Evidence block.
3. Martin's explicit approval is required independently of the marker (`build` refuses without `--approved-by-martin`; the skill asks first).
4. The Handoff carries `token:entity:` / `token:matter:` entries and the one canonical Call Notes link in `Sources`, writes no `Entity_Token` / `Matter_Token`, and does not copy the narrative.
5. The Handoff carries a Passed `source_boundary_check` marker in `Reason` and the compatibility copy of the Commercial Value Evidence block in `Verified Facts & Sources`; `handoff_attestation.py verify` passes on the read-back.
6. Routine reads, preparation and validation complete without needless approval requests.
7. `sales-progression` keeps the sequence (G1 → source check → Entity → Matter → Handoff → log) and stops on any failure.
8. `sales-proposal-release` checks all four release conditions, the token chain and the Registry row, preserves the Approved Version, sends only on approval, and sets Proposal Status Sent at Delivered.
9. `sales-agreement` builds only from the live Template and the exact Approved Version, sends only on approval, and records Signed only on Martin's confirmation.
10. The plugin's files and script paths match what its skills and README name (`python3 scripts/selftest.py` passes).
11. The Log holds no Decision newer than the Project doc's baseline that changes U1 or another open area.
