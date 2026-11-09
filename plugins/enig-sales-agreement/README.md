# ENIG Sales — Agreements (enig-sales-agreement 1.0.0)

A companion to **enig-sales** (3.2.x). It adds one skill, `sales-agreement`, and changes nothing in enig-sales. Fold it into enig-sales as 3.3.0 later, under the Isolated Sales Project's plugin maintenance authority.

**Governs it:** LOG-1164 (G3/U6 resolved, 2026-11-09) · the CSA contract (ENIG HQ / 5. Data / CSA) · the Payment contract (ENIG HQ / 5. Data / Payment) · the Client Service Agreement Template (Business-Wide Operating Models) · the Isolated Sales Project Instruction and Static Reference.

| Part | Martin says | Governed writes (each on Martin's approval of the exact content) |
|---|---|---|
| A | "MAT-n accepted" | Proposal `Status` → Accepted |
| B | "Prepare the agreement for MAT-n" | Agreements row (Draft → Sent); the client document and email |
| C | "MAT-n agreement signed" | Agreements row → Signed; the Deposit and Balance Payment rows (Due) |

Never: pricing, terms, scope or timeline changes; an invented timeline; identity in Notion; marking a Payment Paid.

**Still needed in enig-sales:** `sales-proposal-release` step 8 should also set Proposal `Status` = Sent when Artifact Status becomes Delivered (LOG-1164). Until then, part A accepts a released Proposal whose Status is still Draft.

## Scripts (read-only; never call Notion, Gmail or Drive)

- `check_client_text.py` — fails if client-facing text carries an internal token (ENT-, MAT-, PROP-, HO-, CSA-, PAY-, LOG-, RES-, CN-).
- `scan_identity_leakage.py`, `validate_token.py` — copied unchanged from enig-sales 3.1.0.
- `selftest.py` — package checks. Run before release: `python3 scripts/selftest.py`.

Root `scripts/` and `references/` are the source of truth; the skill carries identical copies (Claude chat drops plugin-root files).

## Connectors
Notion, Google Drive and Gmail account-level connectors. `.mcp.json` is intentionally empty; this plugin holds no credentials.
