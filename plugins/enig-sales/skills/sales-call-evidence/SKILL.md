---
name: sales-call-evidence
description: Collect, attribute, and classify call evidence; determine Commercial Value Evidence (CVE); enforce Call Notes approval/versioning and provenance safeguards. No governed writes or external actions.
---
# sales-call-evidence

## Purpose
Evaluate call evidence against governed requirements, determine Commercial Value Evidence (CVE) outcome, and enforce Call Notes safeguards using only provided/accessible evidence.

## Required inputs (use only provided/accessible evidence)
Only use evidence and source material actually provided or legitimately accessible. Do not invent client history, qualification outcomes, investment ranges, approvals, or record state.

## Evidence classification and attribution
For each item:
1. **Source attribution** — Record source identifier/path and provenance.
2. **Classification** — Classify as Verified fact | Client-reported (unverified) | Assumption | Hypothesis | Unknown.
3. **Traceability** — Every verified fact must have traceable source reference; unverified items must not be promoted to facts.

## Commercial Value Evidence (CVE) determination
Determine one of:
- **Satisfied** — Required evidence elements present with traceable sources per canonical requirements.
- **Not Satisfied** — Required elements missing or contradicted such that CVE cannot be satisfied.
- **Insufficient Evidence** — Evidence provided is incomplete; specific gaps listed with what would close them.

Do not fabricate values. If information missing, mark Insufficient Evidence and list gaps.

## Call Notes safeguards (BD-5)
- **Canonical source**: The approved Call Notes record’s "Note" is canonical evidence.
- **Temporary compatibility**: Retain the existing Handoff CVE copy as temporary compatibility data only until both Strategy and Finance consumers have migrated, integration tests pass, and Martin approves removal. Treat it as compatibility data, not an independent source of truth.
- **Approval hash**: Preserve the six-field Call Notes approval hash contract. The hash covers metadata, not the "Note" content.
- **Versioning**: Changes to approved Note content require a governed new Version and re-approval.
- **Provenance & identity safety**: Enforce attribution and identity-safety rules. Do not leak sensitive identifiers beyond what is permitted.
- **Separation of authority**: Finance retains authority to determine whether evidence is sufficient for pricing. This skill does not override that authority.

## Rules
- No governed writes or external actions.
- Distinguish instruction-level guidance from technical enforcement.
- If a safeguard cannot be reliably enforced within Claude.ai chat, state the limitation explicitly.
- CVE/Call Notes/Handoff implementation details beyond this scope remain pending; do not expand scope.
- Preserve existing plugin structure and tests.

Source basis: Isolated Sales Operating Specification, Project Instruction, Static Reference (provided), BD-5.
