> 📌 **Canonical** (LOG-1140, 2026-10-19; supersedes the LOG-1117 text of 2026-10-18). Corrected by LOG-1165 (2026-11-10). This page is the authoritative text of `enig-static-reference.md`. The Claude Project file is a working copy and must match it. Change this page only through a logged Decision or Change, then update the copy. Its "Log reviewed through" line is the plugin's log-check baseline.

---

# ENIG STATIC REFERENCE: ISOLATED SALES

## Purpose and use

This file says **where things are** and holds the **static facts** Isolated Sales needs: links, IDs, field names, options, formats and the current governing position. Look things up here instead of searching for them.

- How Isolated Sales operates (authority, approvals, solve-first, the four hard stops): the Project Instruction.
- How each task is done: the enig-sales plugin (skills, `references/`, `scripts/`).
- What governs: the Activity & Decision Log and the canonical Notion contracts linked below.

A fact here is not proof that a system works or that a record exists. If a fact here conflicts with a linked contract or a newer Log decision, the contract or decision wins; report the discrepancy and update this file once it is resolved.

## Where things are

### Stage → skill

| Stage | Invoke | What it produces |
| --- | --- | --- |
| New enquiry; Entity + Registry pair; Matter; new evidence on an existing Matter | `sales-enquiry` | Approved Entity, Registry row, Matter, Matter evidence |
| Client email and call scheduling | `sales-correspondence` | Approved email or Gmail draft; approved calendar action |
| Call preparation | `sales-call-prep` | Call brief in chat |
| Completed-call evidence; canonical Call Notes | `sales-call-evidence` | Approved `Current_understanding`; one canonical Call Notes record per completed call, with the Commercial Value Evidence block in its `Note` |
| Fit assessment | `sales-fit-assessment` | Qualified / More Information Required / Not Qualified, with the path to close any gap, in chat |
| Progression and Sales → Strategy Handoff | `sales-progression` | Entity Prospect, Matter Qualified, thin Work Handoff, Decision log entry |
| Proposal release | `sales-proposal-release` | Client document and/or email from the Approved Version |
| Client agreement (CSA); Proposal Accepted; signature and Payment rows | `sales-agreement` | Approved CSA document and email; Agreements record; Deposit and Balance Payment rows |

### How-to → plugin file

Each skill carries its own copy of these files beside its `SKILL.md`.

| Need | Plugin file |
| --- | --- |
| Exact Notion calls: lookups, log check, writes, Call Notes create, `Sources` link | `references/notion-calls.md` |
| Evidence labelling, `Current_understanding` template, VE format, fit line format | `references/evidence-examples.md` |
| Seven-line identity-safety read-through; TEST RUN compatibility checks | `references/checks.md` |
| Token and title validation | `scripts/validate_token.py` |
| Identity-leakage scan (`--identity`) | `scripts/scan_identity_leakage.py` |
| Call Notes ID, `record_approval` marker build and read-back verify | `scripts/call_notes_attestation.py` |
| Commercial Value Evidence block (for the Call Notes `Note`), Handoff `source_boundary_check` marker, `Sources` link, read-back verify | `scripts/handoff_attestation.py` |

All scripts are read-only: they never call Notion, Gmail or Calendar.

### Canonical Notion pages

Open these by URL. Do not search for copies.

| Page | URL |
| --- | --- |
| Entity contract | https://www.notion.so/3cecb004e58381a9b95ee6ab79a3e5f3 |
| Matter contract | https://www.notion.so/3d1cb004e58381cb8ba8e3817e51f454 |
| Handoff contract | https://www.notion.so/3cecb004e58381f2b7a0fe0baf611818 |
| Proposal contract | https://www.notion.so/3cecb004e58381be81dedfb022e36232 |
| Call Notes contract | https://www.notion.so/3edcb004e5838182b2aaeab95a8e3a84 |
| Universal Role Contract | https://www.notion.so/3cecb004e58381ee8f1ef0d58532f4aa |
| Business-Wide Operating Principles | https://www.notion.so/3cecb004e5838151b17ccde1a8255566 |
| LOG-1110 (canonical Call Notes workflow authorised) | https://www.notion.so/3fbcb004e58381c4bba9db48331fded3 |
| Isolated Sales: Operating Specification (canonical text of the Project Instruction, this file and the plugin specification) | https://www.notion.so/3fdcb004e583819cbb62c0f9b24e21a7 |
| LOG-1117 (Operating Specification made canonical) | https://www.notion.so/3fdcb004e5838103b50eecd0eaeaf330 |
| LOG-1140 (evidence lives once; solve first, four hard stops) | https://www.notion.so/3fecb004e58381dfbfc8c1952d3692b6 |
| CSA contract | https://www.notion.so/3cecb004e583816a9720fec8486352fe |
| Payment contract | https://www.notion.so/413cb004e58381f9956fca59bbb74368 |
| Client Service Agreement Template | https://www.notion.so/413cb004e58381f48673fab4361d34f3 |
| LOG-1164 (G3/U6 resolved: CSA and post-release Proposal Status) | https://www.notion.so/413cb004e58381108e60f22294827e0a |
| ENIG Consultancy Profile (canonical description of the business, LOG-1150) | https://www.notion.so/401cb004e58381429e27c3e7087b8546 |

### Data sources and Sales' remit

| Object | Data source | Isolated Sales may |
| --- | --- | --- |
| Entity | `collection://437248f7-f6d8-4e70-873b-7b1eb0fdc519` | Match; create after approval; Lead → Prospect in approved progression |
| Matters | `collection://0e68feef-224d-433d-a813-0f6ec5e1c036` | Match; create after approval; update evidence after approval; Open → Qualified in approved progression |
| Identity Resolution Registry | `collection://b737c4c4-9416-42f0-b733-1145bdde31f0` | Read for matching and release; create with a new Entity after approval |
| Call Notes | `collection://a2bf0fa6-7fd5-47ab-b5f2-1fc599f2d164` | Read; create canonical records after approval |
| Handoffs | `collection://935cff62-de01-4920-9743-782c7d210455` | Create the approved Sales → Strategy Work Handoff; Concern where authorised |
| Proposals | `collection://3b7bf0fa-7664-4ef1-a91b-282316696b6c` | Read; set `Artifact Reference` and `Artifact Status` in release; set `Status` Sent at Delivered, Accepted on Martin's confirmation, Inactive on his instruction |
| Agreements | `collection://6b71106b-5cbe-4bd3-831e-2c1dd96d0a34` | Create and update after approval |
| Payments | `collection://703a276e-2183-4f89-9627-9625b099a851` | Create the Deposit and Balance rows at signing, after approval; never mark Paid |
| Activity & Decision Log | `collection://423e7f93-5f9d-435d-856a-e183120d3d8f` | Append one stage entry per completed stage |

The remit does not override contracts, approvals or access controls.

## Governing decisions and current position

- **LOG-1110** (2026-10-16), refined by LOG-1140. Isolated Sales may create one canonical, source-grounded Call Notes record per completed call, including each follow-up, after Martin's explicit approval. Call Notes is the canonical store of completed-call evidence; the Matter holds the approved current understanding.
- **LOG-1117** (2026-10-18). The "Isolated Sales: Operating Specification" pages are canonical; Project files and the installed plugin are working copies.
- **Current governing decision: LOG-1140** (2026-10-19). **Evidence lives once; Handoffs carry the link. Solve first; four hard stops.**
  - The Commercial Value Evidence block is written once, inside the canonical Call Notes record's `Note`, before the record is approved (the approval attestation is hash-bound).
  - The Sales → Strategy Handoff carries the `source_boundary_check` marker in `Reason` and one `Sources` link to that Call Notes record. It does not repeat the call narrative, the CF/VE/INF/HYP/UQ items or the Commercial Value Evidence block (target state; see the compatibility copy below).
  - The Strategy → Finance Handoff forwards the same `Sources` link. Finance prices the approved intervention.
  - Runtime dependency **not deployed** (checked 2026-11-10 against the live Runtime code): Strategy reads the block only from the Handoff's `Verified Facts & Sources`. Until the change on branch `ccr-cec148fd-inw5vk` (commit `460e9f0`) is deployed, every thin Handoff carries the compatibility copy (Project Instruction §8).
  - Operating style: solve first; only the four hard stops in the Project Instruction stop an action.
- **Log reviewed through LOG-1164 (2026-11-09).** Reflected here: LOG-1141 (lookups by search, fetch and backlinks), LOG-1149 (Handoff tokens move into `Sources`) and LOG-1164 (G3/U6 resolved). No Isolated Sales rule change: LOG-1150–1154, LOG-1161 and LOG-1163 (Kernel, Operating Principles and Consultancy Profile; LOG-1152's written-agreement requirement is implemented by LOG-1164); LOG-1148 concerns Runtime Lead Generation only. LOG-1155: build decisions now go to the Build Decision Record; this Log continues for operations. The rest are Discoveries, Activities and Blockers. (Earlier: LOG-1118–1139 held no rule change.)

### Known remaining issues

- **U1 — investment-range rule:** the numerical rule is unresolved. Never invent a threshold or treat an unconfirmed range as established.
- **G3 / U6 — resolved 2026-11-09 (LOG-1164).** Isolated Sales sets Proposal `Status`: **Sent** when the release reaches Artifact Status Delivered; **Accepted** only on Martin's explicit confirmation that the client accepted ("MAT-n accepted"), with the acceptance email or message noted; **Inactive** only on Martin's instruction (declined or expired). `Under Revision` stays with Runtime Sales. The CSA release path is the `sales-agreement` skill. Work starts only when the agreement is Signed and the Deposit Payment is Paid.
- **Call Notes writer:** plugin **3.3.0** (rebuilt 2026-11-09 from the canonical specification) writes the six-field marker and the Handoff marker, block and `Sources`, pinned byte-for-byte to the Runtime readers by `src/isolatedSalesPluginConformance.test.ts` in PR Validation. First live record: `CN-7cdf89bd-4da6-4a56-bc2a-e6be7e124734` (2026-10-19, MAT-30, written by 3.2.x).
- **Legacy Call Notes record** `CN-a7f2d9c1-4e15-42b8-9d8f-3c6b1a2f5e8d`: content in the page body, `Note` empty, old attestation format, identity in the body. Do not migrate or edit it without review and explicit authorisation.
- **HO-90 (MAT-30):** Closed 2026-10-19. Strategy proposal approved (LOG-1131); Finance quoted GHS 19,200 (LOG-1134) from the Commercial Value Evidence block added by hand on Martin's approval (procedural attestation, not Sales-generated); Runtime Sales created PROP-7 v1 (LOG-1139). Next Isolated Sales step for MAT-30: `sales-proposal-release`.
- **One Call Notes source per Handoff:** the Sales → Strategy route accepts at most one Call Notes link in `Sources`. When a Matter has several records, Martin names the one to reference.
- **Runtime integration access:** the "ENIG Agent Runtime" Notion integration must be connected to the Call Notes database (connected 2026-10-19), or Strategy refuses the source with a 404.

### Progression authority

Isolated Sales owns fit assessment and progression (Entity and Matter contracts). After Martin approves progression for a named MAT-n, Isolated Sales performs Entity Lead → Prospect and Matter Open → Qualified as one governed event, then creates the Sales → Strategy Work Handoff. Runtime Sales performs neither the assessment nor the transitions. There is no Sales → Sales Handoff.

## Tokens and identifiers

| Object | Token | Notes |
| --- | --- | --- |
| Entity | `ENT-n` | Notion may return a bare number; prefix it |
| Matter | `MAT-n` | Same |
| Handoff | `HO-n` | Same |
| Activity & Decision Log | `LOG-n` | Same |
| Registry row | `RES-nnn` | Three digits; not auto-numbered (next = highest + 1) |
| Call Notes | `CN-<unique-id>` | Generated by the plugin |

A Handoff carries the Entity and Matter only as `token:entity:ENT-n` / `token:matter:MAT-n` entries in `Sources` (LOG-1149). The `Entity_Token` / `Matter_Token` properties are retired; older Handoffs may still show them. `E-47` / `M-12` in live field descriptions are obsolete examples.

## Records: fields, options and formats

### Entity

- Fields: `Entity Record` (title), `Entity_ID`, `Entity_type` (Individual, Organisation), `Status` (Lead, Prospect, Client, Inactive), `Business_context`.
- Title: `ENT-n (<Entity_type> – <sector descriptor>)`, en dash. New Entities start at Lead.
- `Business_context`: sector and type of work only. No names, towns, regions, founding years, staff numbers, named buyers, brands or identifying products.

### Matter

- Fields: `Matter` (title), `Matter_ID`, `Entity` (relation), `Status` (Open, Qualified, Commercial Development, Proposal, Converted, Closed), `Stated_need`, `Current_understanding`, `Evidence_source`, `Next_action`.
- Title: `MAT-n – <non-identifying descriptor>`, en dash. New Matters start at Open.
- `Evidence_source` is a locator: `Gmail thread <id>, message <id>, <YYYY-MM-DD>` or `Pasted enquiry, received <YYYY-MM-DD>`.
- `Next_action` states the factual position, never a recommendation and never "awaiting handoff". Intake default: `Intake recorded; awaiting correspondence or sales call.`

### Identity Resolution Registry

- Fields: `Resolution_ID` (title, `RES-nnn`), `Entity_ID` (text `ENT-n`), `Entity_Type`, `Real_Name`, `Contact_Name`, `Email`, `Phone`, `Additional_Contact_Channel`, `Resolution_Source`, `Resolution_Status` (Confirmed, Needs Review), `Notes`.
- `Resolution_Status` is always Martin's choice.
- Organisation name absent from the source: leave `Real_Name` empty and write `Organisation name not stated in source` in `Notes`.
- The Registry is the only identity-bearing object.

### Call Notes

- Fields: `Call Notes ID` (title), `Entity` (relation), `Matter` (relation), `Call Date` (date only), `Call Type` (Discovery, Sales, Qualification, Follow-up, Review, Other), `Note`, `Approval Attestation`, `Status` (Ready, Consumed), `Version` (number), `Created At`, `Updated At`.
- `Note` is the only substantive content: the labelled, identity-safe call evidence, followed — when the call holds value evidence — by the Commercial Value Evidence block (`=== COMMERCIAL VALUE EVIDENCE === … === END COMMERCIAL VALUE EVIDENCE ===`, deterministic JSON: `determination`, `evidenceText`, `evidence`). Write the block **before** approval. Adding it later means a new Version and re-approval.
- New records: Version 1, Status Ready. Ready → Consumed belongs to the authorised Runtime Hat.
- Approval attestation: six-field `record_approval` marker per the Call Notes contract, built and verified by `scripts/call_notes_attestation.py`. Legacy eight-field markers are rejected.
- Strategy and Finance read the `Note` property only, never the page body.

### Handoffs

- Fields: `Handoff` (title), `Handoff ID`, `Type` (Work, Concern), `From Unit`, `To Unit`, `From Hat`, `To Hat`, `Reason`, `Work Completed`, `Verified Facts & Sources`, `Sources`, `Assumptions`, `Open Questions`, `Required Next Action`, `Expected Output`, `Acceptance Criteria`, `Status` (Pending, Picked-up, Held, Closed).
- Units: Strategy, Research & Intelligence, Creative & Design, Finance, Operations, Sales, Marketing, Business Development.
- `Reason` carries the `source_boundary_check` marker. `Sources` holds, one per line: `token:entity:ENT-n`, `token:matter:MAT-n`, and one `https://www.notion.so/<id>` link to the canonical Call Notes page (LOG-1149; built by `handoff_attestation.py sources`). `Verified Facts & Sources` carries a byte-for-byte **compatibility copy** of the Commercial Value Evidence block from the Call Notes `Note`: the deployed Strategy reader still reads it there and holds the Handoff without it (Project Instruction §8). The Call Notes copy remains authoritative.
- Source route contracts: `Sales->Strategy` and `Strategy->Finance` each allow one optional `call_notes` source; `handoffs` is prohibited.

**Sales → Strategy Work Handoff values (thin)**

| Field | Value |
| --- | --- |
| `Handoff` | `Sales→Strategy · ENT-n / MAT-n` |
| `Type` | Work |
| `From Unit` / `From Hat` | Sales / Sales Executive |
| `To Unit` / `To Hat` | Strategy / Strategy Analyst |
| `Reason` | `Martin approved progression on <YYYY-MM-DD>; diagnosis and intervention design are required`  • the marker (+ any override, named by condition) |
| `Work Completed` | One or two lines: Sales stages completed, fit outcome, referenced Call Notes ID |
| `Verified Facts & Sources` | `Evidence: see Sources (CN-…).` plus only facts that are **not** in the Call Notes record, with locators, then the compatibility copy of the Commercial Value Evidence block |
| `Sources` | `token:entity:ENT-n`, `token:matter:MAT-n` and the canonical Call Notes link |
| `Assumptions` | Only INF / HYP items not in the Call Notes record; otherwise `See Sources.` |
| `Open Questions` | Only UQ items not in the Call Notes record; otherwise `See Sources.` |
| `Required Next Action` | `Diagnose; design an intervention for Martin's approval` |
| `Expected Output` | Diagnosis and intervention recommendation with a measurement baseline |
| `Acceptance Criteria` | Traceable chain from evidence to diagnosis to intervention; no pricing or budget content |
| `Status` | Pending |

### Proposals

- Fields: `Proposal` (title), `Proposal ID`, `Approval Status` (Draft, Pending Approval, Approved), `Version`, `Approved Version`, `Artifact Status` (Not Requested, Pending Identity Resolution, Created, Delivered, Held), `Artifact Action`, `Artifact Reference` (URL), `Status` (Draft, Sent, Under Revision, Accepted, Inactive), `Quoted Price`, `Quote Rationale`, `Proposal Content`, `Entity Token`, `Matter Token`, `Handoff` (relation), `Evidence / Source` (URL).
- Release trigger (all four): Approval Status Approved; Approved Version = Version; Artifact Status Pending Identity Resolution; Artifact Action stated.

### Activity & Decision Log

- Fields: `Entry` (title), `Log ID`, `Type` (Activity, Decision, Change, Discovery, Blocker), `Area`, `Activity / Event`, `Decisions`, `Decision Rationale`, `Next Actions`, `Outcome` (Active, Complete, Blocked).
- Routine stage: Type Activity, Area Sales, Outcome Complete. Progression: Type Decision, Outcome Active.
- Stage title prefixes: `Sales intake · …`, `Correspondence …`, `Sales call scheduled …`, `Call prep brief …`, `Call evidence recorded …`, `Call Notes record created …`, `Evidence updated …`, `Fit assessed …`, `Proposal released …`, `Proposal accepted …`, `Agreement sent …`, `Agreement signed …`, `Sales progression · ENT-n / MAT-n`.

## Specialization scope

From the Business-Wide Operating Principles (the page wins on any conflict): ENIG solves real business problems of positioning, perception and how a business communicates. Diagnosis comes first; the intervention follows from it. Visual brand identity design is one possible intervention, only when the diagnosis supports it, never the default.

## Qualification conditions

The Entity contract governs Lead → Prospect. Each condition is rated Supported, Partial, Not evidenced or Contradicted (condition 1 may be Not assessable if the scope cannot be read).

| # | Condition | Met when |
| --- | --- | --- |
| 1 | `within_specialization` | The underlying problem (not the requested deliverable) falls within the specialization scope |
| 2 | `allows_diagnosis_first` | The client will allow diagnosis before a solution is fixed |
| 3 | `commercial_value_evidence` | Attributable numerical value at stake **and** a numerical investment range or boundary management would consider reasonable (U1 unresolved) |
| 4 | `open_to_ballpark_amount_and_time` | The client is open to the indicative investment and time communicated in the sales conversation |
| 5 | `ready_to_commit_required_resources` | The client is prepared to commit budget, time, attention, access and participation |

Outcomes: **Qualified** = all five Supported. **More Information Required** = any Partial, Not evidenced or Not assessable. **Not Qualified** = any Contradicted, or fit implausible. Missing evidence blocks qualification; inference never fills a gap.

**Commercial Value Evidence determination** (for the block): `Satisfied` when a numerical value at stake or cost of inaction has a non-assumption evidence type, an attributable source and a period; otherwise `Insufficient Evidence` (or `Not Satisfied` when the evidence contradicts it). Mirrors the Runtime evaluator; Martin attests the determination when he approves the record.

## Evidence classes

| Class | Meaning |
| --- | --- |
| CF | Confirmed fact, independently corroborated |
| CS | Client statement, attributed by role |
| SO | Sales observation |
| INF | Inference |
| HYP | Hypothesis to test (includes every client-suggested cause) |
| UQ | Unresolved question |
| VE | Value evidence: figure, unit, period, source, class, uncertainty |

Labelling rules and templates: `references/evidence-examples.md`.

## Maintaining this file

Keep it to locations and facts. Procedures belong in the plugin; operating rules belong in the Project Instruction. The canonical text is the "Static Reference" Notion page (LOG-1117, LOG-1140): change it there first, through a logged Decision or Change, then copy it here. When the Log changes a fact, update the matching section and the "Log reviewed through" line; the plugin's log check uses that line as its baseline, so a new Decision pauses intake and progression until this line is updated.
