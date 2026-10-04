import type { Env } from "../../types";
import { plainText, queryDataSource, relationIds } from "../../notion";
import type { AccessContext } from "../../access";
import { resolveEntityMatterFromTokens } from "../../identityResolution";
import { callNotesEvidenceText, extractCallNotesReference, readApprovalRecord } from "../sales/callNotesRecord";
import { stripCommercialValueEvidenceBlock } from "../sales/commercialValueEvidence";
import { parseRecordApprovalMarker } from "../sales/callNotesMarker";

/**
 * Strategy's evidence-retrieval order (ENIG Core Structure v3.0) and its
 * read-only consumption of an approved Call Notes record.
 *
 * **The order, exactly once, in this order:**
 *
 *   1. **The current approved Handoff evidence.** The Handoff's own
 *      `Verified Facts & Sources`, falling back to `Reason` when that field
 *      is absent. This is the sending Unit's recorded, source-boundary-
 *      attested account and it always wins when it is substantive.
 *   2. **Approved sanitized Call Notes**, but ONLY when order 1 yields no
 *      substantive evidence. Read here, read-only and idempotently, by
 *      Strategy itself -- there is no Runtime Sales evidence-processing
 *      worker in this path, and nothing is consumed or transitioned.
 *   3. **Any other explicitly governed approved source, if one exists.**
 *      None exists today, so this is a deliberate no-op documented here
 *      rather than a speculative lookup: inventing a third source would be
 *      adding a data boundary, which is not this change's to add.
 *   4. **Clarification Needed**, and only for a fact that is still
 *      unresolved. The reason names the exact unresolved fact and why it
 *      materially affects the decision -- never a generic request for more
 *      background, which would only invite a fill.
 *
 * **Call Notes are evidence, not a second authority.** Reading them adds
 * material the diagnosis may be grounded in; it never overrides, reopens or
 * re-decides anything the Handoff already records, it never grants access,
 * and it never substitutes for an approval. The record's own `Approval
 * Attestation` is re-hashed here against the record's registry fields exactly
 * as Sales' consuming path does -- validation of a recorded procedural
 * attestation, and deliberately no claim about the Evidence Package contents.
 *
 * **Why this read does not consume.** `retrieveAndConsumeCallNotes` (Sales)
 * transitions `Ready -> Consumed`, which is correct for a single-shot
 * consumption. Strategy's pickup is retryable: a Held Handoff returns to
 * Pending and is re-picked-up once Martin clarifies, and the diagnosis must
 * be able to re-read the same approved evidence on every attempt. Consuming
 * it here would break that loop and strand the Handoff. So the status gate
 * accepts `Ready` or `Consumed` (idempotent for this reader), refuses
 * `Superseded` and unset (no approved current evidence), and performs no
 * write at all. Sales' own consume semantics are untouched.
 */

/** Why the Call Notes evidence could not be used, once it was even reachable. */
export type StrategyCallNotesEvidence =
  | {
      ok: true;
      /** The record's eight canonical registry fields -- the governed representation of its evidence. */
      evidenceText: string;
      callNotesId: string;
      status: string;
    }
  | { ok: false; reason: string };

/**
 * Order 1's substantive test.
 *
 * The real-world thin-context failure this exists for: a Handoff whose whole
 * `Verified Facts & Sources` is a `Call_Notes_ID` reference. It is
 * technically non-empty, so the closed-context contract passed and the
 * diagnosis ran on a database reference as if it were a business situation.
 * A reference *points at* evidence; it is not evidence.
 *
 * Everything else counts as substantive here -- this test removes only
 * `Call_Notes_ID` reference lines and the labelled structured Commercial
 * Value Evidence block, and nothing else, because deciding that some other
 * *narrative* is "too thin" would be a judgment about evidence quality that
 * belongs to the diagnosis and its gates, not to retrieval. The structured
 * block is removed for the same structural reason a reference line is: it
 * POINTS AT / RECORDS a determination, it is not the business situation the
 * diagnosis is about, and a Handoff whose only content is one would
 * otherwise reach the diagnosis as if the JSON were the situation.
 */
export function hasSubstantiveEvidence(text: string): boolean {
  if (!text.trim()) return false;
  const withoutReference = stripCommercialValueEvidenceBlock(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*Call_Notes_ID[ \t]*[:=]/.test(line))
    .join("\n");
  return withoutReference.trim().length > 0;
}

/**
 * Order 2: read the Handoff's referenced Call Notes record, read-only.
 *
 * Gates, in order, each failing closed with NO write anywhere:
 *
 *   1. **Reference** -- a `Call_Notes_ID` in the Handoff's `Reason` or
 *      `Handoff` free text, by the same grammar Sales uses. Never inferred
 *      from Entity/Matter.
 *   2. **Identity binding targets** -- the Handoff's tokens resolved to real
 *      records, so the record's relations have something to be checked
 *      against. A Handoff whose own tokens are broken reports that, rather
 *      than being dressed up as a missing-record problem.
 *   3. **Exact lookup** -- one query on the authoritative store matching the
 *      reference exactly. Zero or multiple matches are both refusals.
 *   4. **Status and binding** -- `Ready` or `Consumed` (read-only, so
 *      already-consumed still carries approved evidence), never
 *      `Superseded` or unset; and the record's `Entity`/`Matter` relations
 *      must be exactly what gate 2 resolved.
 *   5. **Attestation** -- re-validated against the record's own registry
 *      fields by `parseRecordApprovalMarker`, so the record read here is the
 *      approved one and this exact field set.
 *
 * Deliberately NOT done here: writing anything, creating a record, retrieving
 * or verifying an Evidence Package, re-running an approval flow, minting an
 * ApprovalProof, or scanning content for identity (the source-boundary
 * attestation is consumed from the Handoff by the caller's own separate
 * gate and is not re-performed here).
 */
export async function readApprovedCallNotesEvidence(
  env: Env,
  handoffProperties: Record<string, any>,
  tokens: { entityToken: string; matterToken: string },
  access: AccessContext,
): Promise<StrategyCallNotesEvidence> {
  const refuse = (detail: string): StrategyCallNotesEvidence => ({ ok: false, reason: detail });

  // ---- Gate 1: the Handoff's own reference -------------------------------
  const reference = extractCallNotesReference(handoffProperties);
  if (!reference.ok) return refuse(reference.reason);

  // ---- Gate 2: what the Handoff's Entity/Matter refer to -----------------
  const resolved = await resolveEntityMatterFromTokens(env, tokens.entityToken, tokens.matterToken);
  if (!resolved) {
    return refuse(
      `the Handoff's Entity_Token "${tokens.entityToken || "(empty)"}" / Matter_Token "${tokens.matterToken || "(empty)"}" did not resolve to a real, related Entity/Matter record, so the Call Notes record's Entity and Matter relations cannot be verified -- without that check any record would do.`,
    );
  }

  // ---- Gate 3: exact lookup ---------------------------------------------
  if (!env.CALL_NOTES_DATA_SOURCE_ID) {
    return refuse(
      "CALL_NOTES_DATA_SOURCE_ID is not configured, so the authoritative Call Notes store cannot be read.",
    );
  }

  const matches = await queryDataSource(
    env,
    env.CALL_NOTES_DATA_SOURCE_ID,
    access,
    { property: "Call Notes ID", title: { equals: reference.callNotesId } },
    { pageSize: 100 },
  );

  if (matches.length === 0) {
    return refuse(`no Call Notes record has Call_Notes_ID "${reference.callNotesId}" -- an exact match is required and no other record is considered.`);
  }
  if (matches.length > 1) {
    return refuse(`${matches.length} Call Notes records carry Call_Notes_ID "${reference.callNotesId}" -- the reference does not identify exactly one record, so none is read.`);
  }
  const located = matches[0];

  // ---- Gate 4: Status and Entity/Matter binding --------------------------
  const status = plainText(located.properties?.Status);
  if (status !== "Ready" && status !== "Consumed") {
    return refuse(
      `Call Notes record ${located.id} reports Status "${status || "(empty)"}" -- only a Ready or Consumed record carries current approved evidence (Consumed is still readable because this path never writes; Superseded or unset is no approved current evidence).`,
    );
  }

  const entityRelations = relationIds(located.properties?.Entity);
  if (entityRelations.length !== 1 || entityRelations[0] !== resolved.entityId) {
    return refuse(
      `Call Notes record ${located.id} carries Entity relation [${entityRelations.join(", ") || "none"}] but the Handoff's Entity resolves to ${resolved.entityId} -- the record is not bound to this Work's Entity.`,
    );
  }

  const matterRelations = relationIds(located.properties?.Matter);
  if (matterRelations.length !== 1 || matterRelations[0] !== resolved.matterId) {
    return refuse(
      `Call Notes record ${located.id} carries Matter relation [${matterRelations.join(", ") || "none"}] but the Handoff's Matter resolves to ${resolved.matterId} -- the record is not bound to this Work's Matter.`,
    );
  }

  const registry = readApprovalRecord(located, tokens.entityToken, tokens.matterToken);
  if (!registry.ok) return refuse(registry.reason);

  // ---- Gate 5: the recorded approval attestation -------------------------
  const attestation = await parseRecordApprovalMarker(
    plainText(located.properties?.["Approval Attestation"]),
    registry.record,
  );
  if (!attestation.ok) return refuse(attestation.reason);

  return {
    ok: true,
    evidenceText: callNotesEvidenceText(registry.record),
    callNotesId: registry.record.callNotesId,
    status,
  };
}

/**
 * Order 4: the Clarification Needed reason.
 *
 * Names the exact unresolved fact (the situation evidence itself, plus why
 * the governed record could not supply it) and why it materially affects the
 * decision -- without it there is no grounded Symptom -> Problem -> Cause ->
 * Constraint -> Consequence to diagnose, and a proposal built on an invented
 * situation would be exactly what LOG-976's discipline already refuses.
 * Deliberately does not ask for "more context" in general: a general request
 * invites a fill rather than a resolution.
 */
export function strategyClarificationReason(
  handoffEvidence: string,
  callNotesRefusal: string,
): string {
  const observed = handoffEvidence.trim()
    ? `The Handoff's own evidence holds only a Call_Notes_ID reference, which points at evidence rather than being evidence.`
    : `The Handoff carries no evidence of its own at all.`;
  const refusal = callNotesRefusal.trim();
  return [
    "Clarification needed: the business situation this diagnosis is about has not been established -- that is the exact unresolved fact.",
    observed,
    `The approved Call Notes evidence could not be read either: ${refusal.endsWith(".") ? refusal : `${refusal}.`}`,
    "This materially affects the decision because every downstream judgment -- what the Problem is, what causes it, what direction a recommendation may take, and whether one is supported at all -- must be grounded in recorded evidence; without the situation itself there is nothing to ground them in, and no proposal could be defended or approved on an assumed one.",
  ].join(" ");
}
