---
name: sales-call-evidence
description: Collect, attribute, and classify completed-call evidence; determine Commercial Value Evidence (CVE); enforce Call Notes creation, approval, versioning, and provenance safeguards. No governed writes or external actions.
---
# sales-call-evidence

## Purpose

Turn a completed call's evidence into an attributed, classified, identity-safe record package and determine Commercial Value Evidence (CVE) against the approved evaluator rule — using only provided or legitimately accessible evidence.

## Required inputs (use only provided/accessible evidence)

Only use evidence and source material actually provided or legitimately accessible. Do not invent client history, qualification outcomes, investment ranges, approvals, or record state. A gap is reported as a gap, never filled with a guess.

## Evidence classification and attribution

1. **Canonical evidence classes only** — Classify every item with exactly the canonical classes: `CF` confirmed fact (independently corroborated) · `CS` client statement (attributed by role) · `SO` sales observation · `INF` inference · `HYP` hypothesis to test (includes every client-suggested cause) · `UQ` unresolved question · `VE` value evidence (figure, unit, period, source, class, uncertainty). Do not invent, substitute, or collapse categories.
2. **Source attribution** — Ground every substantive claim in an identifiable source. Every `CF` carries a traceable source reference; `CS` stays attributed by role and uncorroborated; an inference repeated never becomes a fact.
3. **Traceability** — Unverified items are never promoted to `CF`. An assumption or inference alone is not an allowed evidence type for a `Satisfied` determination.
4. **Value-evidence discipline** — Record an investment range exactly as the client stated it and leave U1 unresolved; never invent a threshold.
5. **Identity safety** — Outside the Registry, refer to clients only by token (`ENT-n` / `MAT-n`). Evidence text prepared for any record must be identity-safe: no names, contact details, or identifying combinations of facts beyond what the authorised object and field permit, and the identity read-through the stage requires must pass before any write.

## Commercial Value Evidence (CVE) determination

Apply the approved evaluator rule exactly. It mirrors the Runtime deterministic evaluator; Martin attests the determination when he approves the record.

- **`Satisfied`** — a **numerical value at stake or cost of inaction** has a **non-assumption evidence type**, an **attributable source**, and a **period** the value applies to. All elements must be present and traceable.
- **`Not Satisfied`** — the available evidence **contradicts** the condition. State the contradiction and its sources. Missing or incomplete evidence is never `Not Satisfied`.
- **`Insufficient Evidence`** — the evidence is **missing, unsupported, or inconclusive** (for example: no numerical value, no period, no attributable source, assumption-only). This is the correct outcome whenever required elements are absent. List each specific gap and what evidence would resolve it.

These outcomes must not bypass the other qualification conditions or Martin's progression approval. Do not fabricate values.

## Call Notes safeguards (BD-5)

- **One canonical record, approved creation** — One canonical Call Notes record per completed call (each follow-up included), created only after Martin's explicit approval of that exact creation.
- **Canonical source** — The approved Call Notes record's `Note` is the only substantive evidence content. Completed-call evidence belongs canonically there; Strategy and Finance read the `Note` property, never the page body.
- **CVE block before approval** — When the call holds value evidence, the `=== COMMERCIAL VALUE EVIDENCE === … === END COMMERCIAL VALUE EVIDENCE ===` block (deterministic JSON: `determination`, `evidenceText`, `evidence`) is written into `Note` **before** the record is approved.
- **Approval hash** — Preserve the six-field `record_approval` approval-hash contract (metadata fields, including the record's `Version`); it does **not** hash `Note` content. Legacy eight-field markers are rejected.
- **Versioning** — New records start at `Version` 1, Status `Ready`. Any change to approved `Note` content — including adding the CVE block later — requires a governed new `Version` and re-approval. `Ready → Consumed` belongs to the authorised Runtime Hat, not to this skill.
- **Provenance** — Every determination and evidence item stays traceable to its source.

## Handoff compatibility (temporary, per BD-5)

- The Sales → Strategy Handoff carries the `source_boundary_check` attestation and its `Sources` link to the canonical Call Notes record (one Call Notes link per Handoff); it does not repeat the call narrative or the evidence items.
- **Temporary compatibility copy** — Retain the existing Handoff CVE copy during the explicitly approved migration period. It is compatibility data for the Strategy and Finance consumers, not an independent source of truth, and never authoritative over the Call Notes `Note`.
- Do not remove the Handoff copy until **both** consumers have migrated, integration tests verify the canonical `Note` flow, **and** Martin approves removal.

## Separation of authority

Finance retains authority to determine whether evidence is sufficient for pricing. This skill does not override that authority, the other qualification conditions, or Martin's progression approval.

## Rules

- No governed writes and no external actions: this skill analyses and prepares in chat; record creation, progression, and Handoff happen only through their existing approval gates.
- These are instruction-level safeguards, not technical enforcement. If a safeguard cannot be reliably enforced within Claude.ai chat, state that limitation explicitly rather than claiming enforcement.
- CVE/Call Notes/Handoff runtime implementation details beyond this scope remain pending; do not expand scope.
- Preserve existing plugin structure and tests.

Source basis: Isolated Sales Operating Specification (Project Instruction §§4, 7, 8), Static Reference (Evidence classes, Qualification conditions, Call Notes, Handoffs), and BD-5 — provided by Martin. Where a working copy differs from the canonical pages, the canonical pages win.
