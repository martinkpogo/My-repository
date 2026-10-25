# Requirements mapping — sales-call-evidence (Issue #362)

**Canonical sources** (fetched live 2026-10-25):

- **OS** — Isolated Sales: Operating Specification — https://app.notion.com/p/3fdcb004e583819cbb62c0f9b24e21a7
- **PI** — Project Instruction (LOG-1140) — https://app.notion.com/p/3fdcb004e5838114b332d47aea09fb63
- **SR** — Static Reference (LOG-1140) — https://app.notion.com/p/3fdcb004e583814a8feef9b7df1f6982
- **BD-5** — Commercial Value Evidence belongs in Call Notes, not duplicated in Handoffs (Active) — https://app.notion.com/p/403cb004e583817e83f3f7837b2865e4

**Enforcement levels.** Everything covered here is *instruction-level* (skill text read by the model in Claude.ai chat) plus *repository-level* (tests that pin the written contract). Neither is runtime/technical enforcement: no code in this repository executes the skill, and the runtime evaluator, attestation scripts and fail-closed writers live outside this scope.

| # | Requirement | Source | Coverage | Where | Level |
|---|---|---|---|---|---|
| 1 | Evidence attribution: every substantive claim grounded in an identifiable source; verified facts traceable; unverified never promoted | PI §8; SR Evidence classes | Full | SKILL.md "Evidence classification and attribution" items 2–3 | Instruction + test |
| 2 | Classification uses the exact canonical evidence classes CF/CS/SO/INF/HYP/UQ/VE — no invented categories | SR Evidence classes | Full | SKILL.md item 1 | Instruction + test |
| 3 | Value-evidence discipline: investment range recorded exactly as stated; U1 unresolved; no invented threshold | PI §8; SR Known remaining issues (U1) | Full | SKILL.md item 4 | Instruction |
| 4 | CVE `Satisfied`: numerical value at stake or cost of inaction + non-assumption evidence type + attributable source + period | SR Qualification conditions ("Commercial Value Evidence determination") | Full | SKILL.md "CVE determination", `Satisfied` bullet | Instruction + test + reference decision table |
| 5 | CVE `Not Satisfied`: only when evidence contradicts the condition — never for absence | SR CVE determination; BD-5 item 3 | Full | SKILL.md `Not Satisfied` bullet | Instruction + test + reference decision table |
| 6 | CVE `Insufficient Evidence`: missing, unsupported or inconclusive evidence; gaps listed | BD-5 item 3 | Full | SKILL.md `Insufficient Evidence` bullet | Instruction + test + reference decision table |
| 7 | Outcomes must not bypass other qualification conditions or Martin's progression approval | BD-5 item 3 | Full | SKILL.md CVE closing line; "Separation of authority" | Instruction + test |
| 8 | Determination mirrors the Runtime deterministic evaluator; Martin attests on approval | SR CVE determination; BD-5 item 2 | Full | SKILL.md CVE preamble | Instruction + test |
| 9 | Call Notes creation requires Martin's explicit approval of that exact action; one canonical record per completed call | PI §4.2; SR Governing decisions (LOG-1110) | Full | SKILL.md "One canonical record, approved creation" | Instruction + test |
| 10 | `Note` is the canonical substantive evidence; Strategy and Finance read `Note`, never the page body | SR Call Notes; BD-5 item 1 | Full | SKILL.md "Canonical source" | Instruction + test |
| 11 | CVE block written into `Note` **before** approval; block delimiters and deterministic JSON keys (`determination`, `evidenceText`, `evidence`) | SR Call Notes | Full | SKILL.md "CVE block before approval" | Instruction + test |
| 12 | Six-field `record_approval` approval-hash contract preserved; covers metadata including `Version`, not `Note` content; legacy eight-field rejected | BD-5 item 4; SR Call Notes | Full | SKILL.md "Approval hash" | Instruction + test |
| 13 | Any change to approved `Note` content requires governed new `Version` + re-approval; new records `Version` 1 / Status `Ready` | BD-5 item 4; SR Call Notes | Full | SKILL.md "Versioning" | Instruction + test |
| 14 | Provenance: determinations and evidence items stay traceable to their source | PI §8 | Full | SKILL.md "Provenance" | Instruction |
| 15 | Handoff carries `source_boundary_check` + one Call Notes `Sources` link; does not repeat narrative/evidence items | SR Handoffs; BD-5 item 1 | Full | SKILL.md "Handoff compatibility" | Instruction + test |
| 16 | Temporary Handoff CVE copy retained as compatibility data (not a source of truth) until both consumers migrate + integration tests pass + Martin approves removal | BD-5 Temporary migration exception; PI §8 | Full | SKILL.md "Handoff compatibility" | Instruction + test |
| 17 | Identity safety: token-only references outside the Registry; identity-safe evidence text; read-through before any write | PI §7 | Full | SKILL.md "Identity safety" | Instruction + test |
| 18 | Finance retains authority over evidence sufficiency for pricing | BD-5 item 2; PI §3 | Full | SKILL.md "Separation of authority" | Instruction + test |
| 19 | No governed writes / no external actions from the skill | Issue scope; foundation convention | Full | SKILL.md "Rules" | Instruction + test |
| 20 | Instruction-level safeguards must not be presented as technical enforcement; chat-unenforceable safeguards stated as limitations | Issue §5 | Full | SKILL.md "Rules" | Instruction + test |

## Uncovered (out of this issue's scope — reported, not implemented)

| Item | Why uncovered |
|---|---|
| Runtime/technical enforcement of any safeguard above (deterministic CVE evaluator execution, six-field hash build/verify, fail-closed Call Notes/Handoff writers, identity-scan hard-fail) | Runtime Sales/Strategy/Finance code and installed-plugin scripts are explicitly out of scope for #362; enforcement exists in the runtime/scripts, not in skill text |
| Integration tests verifying the canonical `Note` flow for Strategy/Finance consumers | Runtime consumer code out of scope; a stated BD-5 precondition for removing the Handoff copy |
| Removal of the temporary Handoff CVE copy | Explicitly deferred: BD-5 requires both consumers migrated + integration tests + Martin's approval |
| Call Notes field schema and the six-field hash contract changes | No-change scope — documented, not altered |
| `sales-fit-assessment`, `sales-progression`, `sales-proposal-release`, `sales-enquiry`, `sales-correspondence` | Next skill groups; no-change scope for #362 |
| Per-skill `references/` (3 files) and `scripts/` (4 files) copies as in installed plugin 3.2.1 | Repository foundation convention (issue #324) ships `SKILL.md` per skill; shared files tracked separately |
| Claude.ai-chat technical prevention of identity leaks, duplicate records, or unapproved writes | Cannot be technically enforced in chat prompts; only instruction-level + the runtime gates above |

## Limitations and unresolved items

- **Chat enforcement:** the skill is read by the model; nothing technical stops a model in Claude.ai chat from deviating. The skill states this explicitly rather than claiming enforcement.
- **CVE determination mapping open item:** OS "Open items at adoption" records that the mapping *Supported → Satisfied, Contradicted → Not Satisfied, otherwise Insufficient Evidence* awaits Martin's confirmation. The CVE rule implemented here is the SR/BD-5 evaluator wording, which does not depend on that confirmation.
- **U1 investment-range rule** remains unresolved in canonical sources; the skill records ranges verbatim and never invents a threshold.

## Next recommended skill group

`sales-fit-assessment` — it consumes this skill's evidence classification and CVE determination and is the immediate consumer of the qualification-condition ratings.
