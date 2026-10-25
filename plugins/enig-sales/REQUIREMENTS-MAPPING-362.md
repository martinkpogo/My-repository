# Requirements mapping — sales-call-evidence (Issue #362)

Sources: Operating Specification, Project Instruction, Static Reference, BD-5

| Requirement | Coverage | SKILL.md instruction / gap |
|---|---|---|
| Evidence attribution and classification | Full | "Evidence classification and attribution" — source, classification, traceability |
| CVE determination (Satisfied/Not Satisfied/Insufficient Evidence) | Full | "Commercial Value Evidence (CVE) determination" — three outcomes, gaps listed |
| Call Notes approval and versioning | Full | "Call Notes safeguards" — versioning requires new Version and re-approval |
| Approved Note canonical | Full | "Canonical source: The approved Call Notes record’s \"Note\" is canonical evidence." |
| Six-field approval hash | Full | "Preserve the six-field Call Notes approval hash contract. The hash covers metadata, not the \"Note\" content." |
| Handoff CVE copy temporary compatibility | Full | "Retain the existing Handoff CVE copy as temporary compatibility data only..." |
| Provenance and identity safety | Full | "Provenance & identity safety" section |
| Finance authority for pricing sufficiency | Full | "Separation of authority: Finance retains authority to determine whether evidence is sufficient for pricing." |
| No governed writes/external actions | Full | "Rules" section |
| Distinguish instruction vs technical enforcement | Full | "If a safeguard cannot be reliably enforced within Claude.ai chat, state the limitation explicitly." |

Uncovered: Items requiring runtime enforcement or Notion schema changes remain out of scope for this skill.
