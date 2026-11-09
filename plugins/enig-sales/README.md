# ENIG Sales

ENIG's Isolated Sales Executive workspace: the only ENIG environment that holds real client identity. One skill per Sales stage.

**Where things live**
- **Rules:** the Sales Project Instruction (canonical: Notion, Isolated Sales: Operating Specification).
- **Static facts and current decisions:** `enig-static-reference.md` in the Sales Project, always in context (canonical: the Static Reference page).
- **Exact Notion calls** (search, fetch and backlinks only): `references/notion-calls.md`.
- **Labelling rules, Current_understanding template, CVE record, worked example:** `references/evidence-examples.md`.
- **Seven-line read-through and TEST RUN checks:** `references/checks.md`.
- **Steps:** the skills below. Skills hold steps only; where a skill and the Instruction conflict, the Instruction wins.
- **Connectors:** `CONNECTORS.md`.

## Skills, in stage order

| Skill | Stage | Governed writes (each on Martin's approval of the exact content) |
|---|---|---|
| `sales-enquiry` | New enquiry; Entity + Registry and Matter; Matter evidence (mode B) | Entity + Registry row, Matter, Matter evidence |
| `sales-correspondence` | Client email and scheduling | Email send or Gmail draft; calendar action |
| `sales-call-prep` | Brief for Martin's call | None |
| `sales-call-evidence` | Completed-call evidence; canonical Call Notes record | `Matter.Current_understanding`; one Ready Call Notes record (Note + CVE block + `record_approval` marker) |
| `sales-fit-assessment` | Five conditions → outcome | None |
| `sales-progression` | Lead → Prospect, Open → Qualified, thin Sales → Strategy Handoff | All, on one approval naming the MAT-n; G1 check first |
| `sales-proposal-release` | Identity substitution and release of the approved Proposal Version | Artifact Reference / Status; Proposal Status Sent; document and email |
| `sales-agreement` | Proposal Accepted; client agreement (CSA); signature and Payment rows | Proposal Status Accepted; Agreements record; document and email; Deposit and Balance Payment rows |

Every skill writes one identity-safe Activity & Decision Log entry per completed stage.

## Scripts (read-only; they never call Notion, Gmail, Drive or Calendar)

| Script | What it does |
|---|---|
| `validate_token.py` | ENT-n / MAT-n / RES-nnn / HO-n tokens and the Entity / Matter title formats. |
| `scan_identity_leakage.py` | Hard-fails on emails, phones, web addresses and any `--identity` string; soft-warns on possible names. `--client-facing` instead hard-fails only on internal ENIG tokens. |
| `call_notes_attestation.py` | `new-id` (CN-<uuid>); `build` the six-field `record_approval` marker (refuses without `--approved-by-martin`); `verify` a read-back record. |
| `handoff_attestation.py` | `source-boundary` (five checks → the `source_boundary_check` marker); `cve` (the Commercial Value Evidence block); `sources` (the `token:` entries and the one Call Notes link); `verify` a read-back Handoff. |
| `selftest.py` | Package checks: copy parity, script behaviour, required files. Run before every release. |

The two attestation scripts are checked against the ENIG Runtime's own readers in the Runtime repository (`src/isolatedSalesPluginConformance.test.ts`, run in PR Validation): their markers, block and `Sources` text are byte-identical to what the Runtime builds and accepts.

Claude chat mounts each skill as its own folder and drops plugin-root files, so every skill carries an identical copy of `scripts/` and `references/`. The root copies are the source of truth: edit them, re-copy into each skill, and run `selftest.py`, which fails if any copy differs.

## Not in this plugin

Pricing, estimates, budgets or quotes (Finance); diagnosis or intervention design (Strategy); Proposal authoring (Runtime Sales); any Sales → Sales Handoff; marking a Payment Paid.

Unresolved, fail closed: U1 investment-range rule.

## Changes in 3.3.0

Rebuilt from the canonical Isolated Sales specification, because the only copy available to the builder was 3.1.0 and the 3.2.x package was not retrievable. It supersedes 3.2.2 and the separate `enig-sales-agreement` 1.0.0 (uninstall that one).

- **Notion access:** search, fetch and backlinks only (Project Instruction §9, LOG-1141); no `notion-query-data-sources`, no saved views.
- **Errors:** solve first; only the four hard stops stop an action (LOG-1140).
- **Call Notes (LOG-1110, LOG-1140):** `sales-call-evidence` creates one canonical Ready record per completed call: identity-safe `Note` ending with the Commercial Value Evidence block, six-field `record_approval` marker, verified on read-back. The G2 block is gone.
- **Thin Handoff (LOG-1140, LOG-1149):** `sales-progression` writes the Entity and Matter only as `token:` entries in `Sources` with one Call Notes link, never the retired `Entity_Token` / `Matter_Token`; the `source_boundary_check` marker in `Reason`; and the compatibility copy of the CVE block in `Verified Facts & Sources` (Project Instruction §8 — the deployed Strategy reader still requires it). Verified on read-back.
- **Agreements (LOG-1164):** new `sales-agreement`; `sales-proposal-release` sets Proposal Status Sent at Delivered.
- **Log check:** baseline read from the Project doc's "Log reviewed through" line, not a hard-coded entry.
- **New scripts:** `call_notes_attestation.py`, `handoff_attestation.py`; `scan_identity_leakage.py` gains `--client-facing`. `check_call_notes_fields.py` (G2-era) is removed.
- **Project Instruction section references** updated to the current numbering.

**Known canonical drift, not changed by this package:** the Static Reference still lists `Entity_Token` / `Matter_Token` among the Handoff fields and says the CVE block is not written into the Handoff, and its "Log reviewed through" line stops at LOG-1140. The skills follow LOG-1149, Project Instruction §8 and the Runtime; update the Static Reference through a logged Change.
