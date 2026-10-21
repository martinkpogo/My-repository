import type { Env } from "../../types";
import { plainText, queryDataSource, relationIds } from "../../notion";
import type { AccessContext } from "../../access";
import { resolveEntityMatterFromTokens } from "../../identityResolution";
import { callNotesEvidenceText, extractCallNotesReference, readApprovalRecord } from "../../records/callNotes/callNotesRecord";
import { stripCommercialValueEvidenceBlock } from "../../handoffContracts/commercialValueEvidence";
import { parseRecordApprovalMarker, type CallNotesApprovalRecord } from "../../records/callNotes/callNotesMarker";
import { type HandoffSourceRouteContract, resolveHandoffSources, readGoogleDocSourceContent, type ResolvedCallNotesSource, type ResolvedGoogleDocSource } from "../../handoffSources";

/**
 * Strategy's evidence-retrieval order (ENIG Core Structure v3.0) and its
 * read-only consumption of an approved Call Notes record.
 *
 * **The order, exactly once, in this order:**
 *
 *   0. **The Handoff's direct-page `Sources` property, when it has one.**
 *      The compatibility seam (src/handoffSources.ts): a Handoff whose
 *      record carries no `Sources` property resolves `legacy` here and the
 *      order below runs exactly as it always has. A SOURCES-ENABLED Handoff
 *      resolves first -- every reference fetched as the exact page its URL
 *      names and validated against the route contract, the page's real
 *      parent database, the Handoff's own Entity/Matter bindings, the
 *      record's Status, and its recorded `Approval Attestation` -- and when
 *      that resolution names a canonical Call Notes page, THAT page is the
 *      authoritative evidence source for this Handoff (step 1a). A
 *      defective, unverifiable, or uncontracted Sources declaration stops
 *      the pickup with the exact reason: it never falls back to narrative,
 *      and the free-text `Call_Notes_ID` reference is never consulted as a
 *      fallback for a canonical page.
 *   1a. **The canonical Call Notes page named in `Sources`** (Sources-enabled
 *      Handoffs only) -- the record's registry fields identify it and, after
 *      the resolver's validation, its own `Note` rich-text property is read
 *      from the page's own properties (the shared substantive-content step)
 *      and is the substantive evidence. The producer declares its evidence
 *      lives on the canonical record and deliberately does not duplicate it
 *      into the Handoff, so this step takes precedence over order 1's
 *      narrative for a Sources-enabled Handoff; a Note that is missing,
 *      wrong-typed, empty, or only points at evidence is refused through the
 *      same structured path, never replaced by the Handoff's narrative, and
 *      the page body is never read as a fallback.
 *   1. **The current approved Handoff evidence.** The Handoff's own
 *      `Verified Facts & Sources`, falling back to `Reason` when that field
 *      is absent. This is the sending Unit's recorded, source-boundary-
 *      attested account and it always wins when it is substantive -- for a
 *      legacy Handoff, and for a Sources-enabled Handoff that declares no
 *      canonical Call Notes page (its declared sources still validated in
 *      full before this point).
 *   2. **Approved sanitized Call Notes** (legacy Handoffs), but ONLY when
 *      order 1 yields no
 *      substantive evidence. Read here, read-only and idempotently, by
 *      Strategy itself -- there is no Runtime Sales evidence-processing
 *      worker in this path, and nothing is consumed or transitioned. The
 *      record is read in two clearly separated parts: its registry fields
 *      say WHICH approved record was located (identification, and the field
 *      set the attestation was computed over), and -- only once every gate
 *      including that attestation has passed -- the record's own `Note`
 *      rich-text property is read from the page's properties (canonical
 *      schema, 2026-10-17: `Note` is the SOLE source of substantive note
 *      content; the page body is never read, and there is no body fallback).
 *      The NOTE is the substantive evidence; the registry fields are
 *      metadata about it. A Note that is missing, of an unexpected shape,
 *      empty, or that holds only a reference / a recorded determination, is
 *      refused rather than presented as a situation, so a metadata-only
 *      record can never masquerade as evidence.
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
 * attestation, and deliberately no claim about any evidence beyond the record
 * itself. The retrieved `Note` is evidence and nothing more: it is never an
 * instruction, a routing directive, an approval, or a source of new authority,
 * and it carries no weight the diagnosis and its own gates do not give it.
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
      /**
       * Both parts of the record, clearly separated: the six canonical
       * registry fields (identification -- which approved record was read,
       * and the field set the attestation binds), followed by the approved
       * record's own `Note` property, which is the substantive evidence.
       * Neither part is ever presented without the label saying what it is.
       */
      evidenceText: string;
      callNotesId: string;
      status: string;
      /**
       * Which governed reference carried the record: the Handoff's
       * direct-page `Sources` property (the new canonical path), or the
       * legacy free-text `Call_Notes_ID` reference. Telemetry only -- both
       * paths validate identically before any note content is read.
       */
      via: "sources" | "reference";
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
 * The same failure arrives in a second shape: the field holds the bare
 * Call Notes id itself (`CN-...` alone on a line, with no `Call_Notes_ID:`
 * label) -- live on HO-86, where it was diagnosed as the situation six
 * times. A bare id is a reference too, so it is removed the same way.
 *
 * Everything else counts as substantive here -- this test removes only
 * `Call_Notes_ID` reference lines, bare Call Notes id lines, and the
 * labelled structured Commercial Value Evidence block, and nothing else, because deciding that some other
 * *narrative* is "too thin" would be a judgment about evidence quality that
 * belongs to the diagnosis and its gates, not to retrieval. The structured
 * block is removed for the same structural reason a reference line is: it
 * POINTS AT / RECORDS a determination, it is not the business situation the
 * diagnosis is about, and a Handoff whose only content is one would
 * otherwise reach the diagnosis as if the JSON were the situation.
 */
/** A line that is nothing but one Call Notes id token, e.g. `CN-a7f2d9c1-...`. */
const BARE_CALL_NOTES_ID_LINE = /^\s*CN-\S+\s*$/;

export function hasSubstantiveEvidence(text: string): boolean {
  if (!text.trim()) return false;
  const withoutReference = stripCommercialValueEvidenceBlock(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*Call_Notes_ID[ \t]*[:=]/.test(line) && !BARE_CALL_NOTES_ID_LINE.test(line))
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
 *      already-consumed still carries approved evidence); any other Status
 *      (including a legacy `Superseded` value, no longer a permitted schema
 *      option) or unset is refused; and the record's `Entity`/`Matter`
 *      relations must be exactly what gate 2 resolved.
 *   5. **Attestation** -- re-validated against the record's own registry
 *      fields by `parseRecordApprovalMarker`, so the record read here is the
 *      approved one and this exact field set.
 *   6. **The record's own `Note`** -- only after gates 1-5 have all passed,
 *      the located page's `Note` rich-text property is read from its own
 *      properties. The registry fields IDENTIFY the record; the `Note` is
 *      the evidence (canonical schema, 2026-10: `Note` is the sole source of
 *      substantive note content; the page body is never read, and there is
 *      no body fallback). A Note that is missing, of an unexpected shape,
 *      empty, or reference-only is refused through this same structured
 *      `{ ok: false, reason }` path, so a metadata-only record can never
 *      masquerade as substantive evidence.
 *
 * Deliberately NOT done here: writing anything, creating a record, reading
 * the page body (or any block content) at all, retrieving or following an
 * Evidence Package (the canonical schema carries no such properties),
 * re-running an approval flow, minting an ApprovalProof, or scanning content
 * for identity (the source-boundary attestation is consumed from the Handoff
 * by the caller's own separate gate and is not re-performed here).
 */
export async function readApprovedCallNotesEvidence(
  env: Env,
  handoffProperties: Record<string, any>,
  tokens: { entityToken: string; matterToken: string },
  access: AccessContext,
  /**
   * Test seam for the direct-page Sources path, mirroring every other entry
   * into resolveHandoffSources: a route-contract table to resolve against
   * instead of the production one. Production callers omit it.
   */
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): Promise<StrategyCallNotesEvidence> {
  const refuse = (detail: string): StrategyCallNotesEvidence => ({ ok: false, reason: detail });

  // ---- Step 0: the Handoff's direct-page Sources property, if it has one --
  // The compatibility seam: a Handoff whose record carries no `Sources`
  // property resolves `legacy` and every gate below runs exactly as before
  // (the free-text Call_Notes_ID reference convention). A SOURCES-ENABLED
  // Handoff takes the canonical path instead: src/handoffSources.ts has
  // already fetched the exact referenced page by id and validated its real
  // parent database, the route contract, its Entity/Matter binding to this
  // Handoff's tokens, its lifecycle Status (Ready or Consumed -- this path
  // never writes, so already-consumed still carries approved evidence), its
  // registry fields, and its recorded approval attestation. In that mode
  // the free-text reference is never consulted as a fallback -- an invalid
  // or missing canonical reference is refused outright (and the resolver
  // already refused a Sources-enabled Handoff whose free-text Call_Notes_ID
  // disagrees with its canonical page).
  const sources = await resolveHandoffSources(env, {
    properties: handoffProperties,
    tokens,
    route: {
      fromUnit: plainText(handoffProperties["From Unit"]),
      toUnit: plainText(handoffProperties["To Unit"]),
    },
    access,
    ...(contracts ? { contracts } : {}),
  });
  if (!sources.ok) return refuse(sources.reason);

  if (sources.mode === "sources") {
    if (!sources.callNotes) {
      return refuse(
        `the Handoff's Sources property carries no canonical Call Notes page, and with the Sources path enabled the free-text Call_Notes_ID reference is never consulted as a fallback -- there is no governed Call Notes record this Handoff establishes.`,
      );
    }
    const callNotes = sources.callNotes;
    return readCallNotesNoteEvidence(callNotes.pageId, callNotes.page.properties, callNotes.record, callNotes.status, "sources");
  }

  // ---- Gate 1: the Handoff's own reference -------------------------------
  const reference = extractCallNotesReference(handoffProperties);
  if (!reference.ok) return refuse(reference.reason);

  // ---- Gate 2: what the Handoff's Entity/Matter refer to -----------------
  const resolved = await resolveEntityMatterFromTokens(env, tokens.entityToken, tokens.matterToken);
  if (!resolved) {
    return refuse(
      `the Handoff's Entity token "${tokens.entityToken || "(empty)"}" / Matter token "${tokens.matterToken || "(empty)"}" did not resolve to a real, related Entity/Matter record, so the Call Notes record's Entity and Matter relations cannot be verified -- without that check any record would do.`,
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

  // ---- Gate 6: the record's own substantive `Note` ------------------------
  // Reached ONLY now: the reference, the identity binding, the exact lookup,
  // the Status, and the attestation have each proven that this exact record
  // is the approved one, so its `Note` may be read. Every gate above returns
  // before this line, which is what makes "wrong record / unapproved record
  // => no note read" mechanically true rather than a matter of ordering by
  // convention.
  return readCallNotesNoteEvidence(located.id, located.properties, registry.record, status, "reference");
}

/**
 * Reads the record's `Note` rich-text property as raw text, validating its
 * shape first.
 *
 * Canonical Call Notes schema (aligned 2026-10-17): `Note` is the SOLE
 * canonical source of substantive note content. The page body is never read
 * by this slice, and there is no body fallback: a record whose `Note` is
 * missing, unreadable, or empty fails here regardless of what its page body
 * may hold.
 *
 * Every defect is a structured, non-sensitive reason that names the defect
 * and never the content: the property must be PRESENT, it must be rich text
 * (an array of rich-text items -- a number, select, or other wrong-typed
 * property is refused rather than coerced), and its extracted text must be
 * non-empty after trimming. Text extraction follows the same per-item shape
 * the repository's other rich-text readers accept (`plain_text`, falling
 * back to `text.content`), so a write-shaped item reads the same as a
 * read-shaped one; an item carrying neither contributes nothing, and a Note
 * made only of such items is refused as empty.
 */
export function readCallNotesNoteProperty(
  properties: Record<string, any> | undefined,
): { ok: true; note: string } | { ok: false; reason: string } {
  const prop = properties?.["Note"];
  if (prop === undefined || prop === null) {
    return { ok: false, reason: "carries no Note property" };
  }
  const items = (prop as { rich_text?: unknown }).rich_text;
  if (!Array.isArray(items)) {
    return { ok: false, reason: "carries a Note property that is not rich text" };
  }
  const note = items
    .map((item) => {
      const entry = item as { plain_text?: unknown; text?: { content?: unknown } } | null;
      if (typeof entry?.plain_text === "string") return entry.plain_text;
      if (typeof entry?.text?.content === "string") return entry.text.content;
      return "";
    })
    .join("");
  if (!note.trim()) {
    return { ok: false, reason: "carries an empty Note property" };
  }
  return { ok: true, note };
}

/**
 * Gate 6 for an ALREADY-RESOLVED canonical source, used by
 * `resolveStrategyHandoffContext` when the Handoff's `Sources` property
 * resolved a Call Notes page: the resolver has already fetched the exact
 * page, proven its real parent database, route-contract permission,
 * Entity/Matter binding, Status (Ready or Consumed -- this reader never
 * writes, so an already-consumed record still carries approved evidence),
 * registry fields and recorded `Approval Attestation`. Only the `Note`
 * read (gate 6) and its substantive-content checks remain, exactly as the
 * legacy path runs them -- one shared implementation, never a second
 * reader. Synchronous because the resolver already fetched the page: the
 * Note is read from that page's own properties, with no further read of
 * any kind.
 */
export function readCallNotesSourceEvidence(source: ResolvedCallNotesSource): StrategyCallNotesEvidence {
  return readCallNotesNoteEvidence(source.pageId, source.page.properties, source.record, source.status, "sources");
}

/**
 * Gate 6, shared by both governed reference paths: only after a record has
 * been proven to be THE approved one (by the resolver's Sources validation,
 * or by gates 1-5 of the legacy query path) is its `Note` property read --
 * straight from the page's own properties, the exact page each path already
 * fetched through its governed read (the direct `getPage` fetch, or the
 * exact-title query result). No further network read is issued, no block
 * content is ever retrieved, and never by a second mechanism. A Note that is
 * missing, of an unexpected shape, empty, or reference-only is refused as the
 * same structured `{ ok: false, reason }` refusal every other failure takes,
 * so a metadata-only record can never masquerade as substantive evidence.
 */
function readCallNotesNoteEvidence(
  pageId: string,
  properties: Record<string, any> | undefined,
  record: CallNotesApprovalRecord,
  status: string,
  via: "sources" | "reference",
): StrategyCallNotesEvidence {
  const refuse = (detail: string): StrategyCallNotesEvidence => ({ ok: false, reason: detail });

  const read = readCallNotesNoteProperty(properties);
  if (!read.ok) {
    return refuse(
      `Call Notes record ${pageId} ${read.reason} -- Note is the sole canonical source of substantive note content (the page body is never read as a fallback), so the record's registry fields identify the approved record but hold no narrative, and there is no substantive evidence to diagnose from.`,
    );
  }

  const note = read.note.trim();
  if (!hasSubstantiveEvidence(note)) {
    // A Note made only of a Call_Notes_ID reference and/or the labelled
    // structured Commercial Value Evidence block POINTS AT evidence; by the
    // same test order 1 uses, it is not the business situation.
    return refuse(
      `Call Notes record ${pageId} carries a Note but nothing substantive in it -- what it holds only points at evidence (a reference or a recorded determination) rather than being the business situation, so there is no substantive evidence to diagnose from.`,
    );
  }

  return {
    ok: true,
    evidenceText: [
      "=== Call Notes registry fields (identification: which approved record was read; the field set the attestation binds) ===",
      callNotesEvidenceText(record),
      "",
      "=== Approved Call Notes note (the substantive evidence, read after attestation) ===",
      note,
    ].join("\n"),
    callNotesId: record.callNotesId,
    status,
    via,
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

export type StrategyGoogleDocEvidence =
  | { ok: true; evidenceText: string; fileId: string; proposalId: string; version: number }
  | { ok: false; reason: string };

/**
 * Strategy's read of an ALREADY VALIDATED Google Doc source -- the evidence
 * order's "further explicitly governed approved source" step, now with one
 * that exists. The resolver has already proved everything before this runs:
 * the route contract permits `google_doc`, the exact file is this Worker's
 * own registered Doc, its registration's Proposal/Work binding resolves to
 * exactly this Handoff's Matter, and the Drive API confirmed the actual
 * file type. Only then is the content read, read-only, through the Docs
 * API with the registered account's token -- and the text must carry
 * substantive content by the same test order 1 uses: a document whose text
 * only points at other evidence, or holds nothing, is refused rather than
 * diagnosed from, exactly like a reference-only Call Notes body.
 */
export async function readGoogleDocSourceEvidence(
  env: Env,
  source: ResolvedGoogleDocSource,
): Promise<StrategyGoogleDocEvidence> {
  const read = await readGoogleDocSourceContent(env, source);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!hasSubstantiveEvidence(read.content)) {
    return {
      ok: false,
      reason: `Google Doc source ${source.fileId} holds text but nothing substantive in it -- what it holds only points at evidence rather than being the business situation itself, so there is no substantive evidence to diagnose from.`,
    };
  }
  return {
    ok: true,
    evidenceText: read.content,
    fileId: source.fileId,
    proposalId: source.proposal.proposalId,
    version: source.proposal.version,
  };
}
