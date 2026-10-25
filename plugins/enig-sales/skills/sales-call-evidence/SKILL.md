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
1. **Source attribution** — Record source identifier/path and provenance. Every verified fact must have an attributable source.
2. **Classification** — Classify as Verified fact | Client-reported (unverified) | Assumption | Hypothesis | Unknown.
3. **Traceability** — Every verified fact must have traceable source reference; unverified items must not be promoted to facts. An assumption alone is not sufficient as allowed evidence for Satisfied.

## Commercial Value Evidence (CVE) determination
Apply the approved rule exactly:

- **Satisfied** — All required evidence elements are present, including **(a) a numeric value at stake or cost of inaction**, **(b) an allowed evidence type other than an assumption** (e.g., a verified/documented fact or approved source per canonical categories), **(c) an attributable source**, and **(d) a period** (timeframe the value applies to). All elements must be traceable.
- **Not Satisfied** — Available evidence **contradicts** the requirement (not merely missing). State the contradiction and sources.
- **Insufficient Evidence** — Evidence is missing, incomplete, untraceable, or does not establish whether the requirement is met. **This is the correct outcome when required elements are absent.** State the specific gaps and what evidence would resolve them (e.g., missing numeric value, missing period, missing attributable source, assumption-only). Do not default to Not Satisfied for absence.

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
- Distinguish instruction-level guidance from technical enforcement. Written instructions do not provide technical enforcement.
- If a safeguard cannot be reliably enforced within Claude.ai chat, state the limitation explicitly.
- CVE/Call Notes/Handoff implementation details beyond this scope remain pending; do not expand scope.
- Preserve existing plugin structure and tests.

Source basis: Isolated Sales Operating Specification, Project Instruction, Static Reference (provided), BD-5.
