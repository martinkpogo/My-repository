import type { Env } from "./types";
import type { NotionProperties, NotionPage } from "./notion";
import { createPage, richText, updatePage } from "./notion";
import type { AccessContext } from "./access";
import { buildMarker, markerFieldEntries, markerPattern, type MarkerEvidence } from "./markerChannel";
import {
  HANDOFF_SOURCES_PROPERTY,
  extractHandoffSources,
  handoffRouteRequiresEntityMatter,
  handoffSourceRouteContract,
  type HandoffSourceRouteContract,
} from "./handoffSources";

/**
 * Single runtime enforcement point for the canonical Handoff identity-write
 * boundary: every Handoff field that becomes another Unit's AI input
 * context may identify the Entity/Matter ONLY by an opaque operational
 * reference -- the operational Entity/Matter tokens a contracted `Sources`
 * payload carries as opaque token entries (or, at write time, the caller's
 * own operational tokens) -- never a real
 * Entity/company name, a real contact name, an
 * email address, a phone number, or any other detail that identifies who
 * they actually are. Real identity may be read while preparing a Handoff;
 * it must be resolved to tokens (or to exact canonical page references)
 * before anything is WRITTEN to one. See
 * handoff-writing-rules.yaml (the manual-operator equivalent of this rule)
 * and the HO-58 incident it documents -- this module is the same rule
 * enforced in code for every runtime write path, so it no longer depends on
 * every producer applying the discipline by hand.
 *
 * **The separate `Entity_Token`/`Matter_Token` Handoff properties are
 * retired: this module neither writes nor reads them, and no runtime path
 * treats them as an identity authority.** A write must still establish HOW
 * this Handoff's identity travels (never nothing at all), and it does so
 * three ways: with a contracted `Sources` payload whose opaque token
 * entries and canonical artifact references the pickup validates in full,
 * fail-closed, in `resolveHandoffSources`; with the caller's operational
 * identity tokens when the payload carries no `Sources` (that route's
 * pickup then has no reference to resolve and refuses the Handoff -- this
 * gate refuses only a payload carrying NEITHER); or, for a route declared
 * generic by its contract, with no Entity/Matter at all. What never
 * changes: no protected field may carry real identity, the checks
 * that were performed are the only ones recorded as performed, and a
 * Handoff with no operational reference of any kind is refused before any
 * Notion call.
 *
 * Every Unit that creates or updates a Handoff must go through
 * createHandoff/updateHandoff below rather than calling notion.ts's
 * createPage/updatePage against HANDOFFS_DATA_SOURCE_ID directly -- one
 * enforcement point, not one per Unit.
 */

/** Every Handoff field that becomes another Unit's AI input context -- the protected set this boundary applies to. `Sources` carries direct artifact URLs whose pretty-URL slugs are derived from page titles, so the URL text is checked exactly like any other protected field: real identity must never travel into one. */
export const PROTECTED_HANDOFF_FIELDS = [
  "Handoff",
  "Reason",
  "Required Next Action",
  "Expected Output",
  "Acceptance Criteria",
  "Assumptions",
  "Open Questions",
  "Verified Facts & Sources",
  "Work Completed",
  "Sources",
] as const;

export class HandoffWriteViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffWriteViolationError";
  }
}

/**
 * The direct-page `Sources` property (src/handoffSources.ts) is writable
 * since Phase 2: the live Handoffs database carries it as a rich-text
 * property (schema change approved by the Architect), and this is the only
 * write path that may persist it -- one enforcement point, not one per
 * Unit.
 *
 * Write-side validation here is DETERMINISTIC (no fetches, so a transient
 * page-read issue can never fail an otherwise valid write): the payload
 * must parse into at least one entry -- an opaque token or an exact direct
 * reference (a Notion page link or a recognized direct Google Docs/Sheets
 * URL -- no duplicates, no title-matched or searchable text), the Handoff's
 * recorded route must have a source route contract, every artifact
 * reference's type must be one that contract permits, and the opaque token
 * entries must satisfy exactly that contract's separate token requirements.
 * Identity-safety of the URL/token text itself is covered by
 * `Sources` membership in PROTECTED_HANDOFF_FIELDS below (the primary
 * identity control runs over it on every create and update). The FULL
 * binding validation -- exact page fetch, real parent database, token
 * resolution through the authorized operational stores, lifecycle, approval
 * attestation, Google registration binding -- runs fail-closed at pickup,
 * in resolveHandoffSources, before any consumer treats a reference as
 * evidence.
 */
/**
 * @param contracts Optional route-contract table, threaded through from
 * `createHandoff`'s existing seam so the WRITE gate and the read-side
 * resolution gate always consult the SAME table. Production callers pass
 * none, which means `HANDOFF_SOURCE_ROUTE_CONTRACTS` -- the table a pickup
 * will refuse against.
 */
function validateHandoffSourcesWrite(
  properties: NotionProperties,
  operation: string,
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): void {
  const raw = (properties as Record<string, unknown>)[HANDOFF_SOURCES_PROPERTY];
  if (raw === undefined || raw === null) return;
  const extraction = extractHandoffSources(properties);
  if (!extraction.ok) {
    throw new HandoffWriteViolationError(`the Handoff ${operation} payload carries an unusable "${HANDOFF_SOURCES_PROPERTY}" property: ${extraction.reason}`);
  }
  if (extraction.mode !== "sources") return; // unreachable: a present property extracts as "sources" or refuses
  const fromUnit = selectName(properties["From Unit"]) ?? "";
  const toUnit = selectName(properties["To Unit"]) ?? "";
  const routeKey = `${fromUnit || "(none)"}->${toUnit || "(none)"}`;
  const contract = handoffSourceRouteContract(fromUnit, toUnit, contracts);
  if (!contract) {
    throw new HandoffWriteViolationError(
      `the Handoff ${operation} payload carries "${HANDOFF_SOURCES_PROPERTY}", but route "${routeKey}" has no Handoff source route contract -- which sources may travel a route is an explicit contract decision, so an uncontracted route is refused rather than guessed.`,
    );
  }
  for (const ref of extraction.refs) {
    const type = ref.kind === "google" ? ref.type : undefined;
    if (!type) continue; // a Notion reference's type comes from its real parent data source, decided at pickup -- permission re-checked there per-type; an opaque token entry is governed below, never by this artifact check
    const permitted = contract.required.includes(type) || contract.optional.includes(type);
    if (contract.prohibited.includes(type) || !permitted) {
      throw new HandoffWriteViolationError(
        `the Handoff ${operation} payload carries a ${type} reference in "${HANDOFF_SOURCES_PROPERTY}" that route "${routeKey}" does not permit -- the pickup would refuse it anyway, so it is refused here instead of creating a record that fails validation on arrival.`,
      );
    }
  }
  // Opaque token entries are governed by the contract's TOKEN requirements,
  // separately from the artifact table above. Both directions fail closed
  // here for the same reason the artifact check does: the pickup refuses
  // these payloads identically, so the write refuses first rather than
  // creating a Handoff that cannot travel its route.
  const declared = extraction.tokens;
  if (declared.entityToken && !contract.requiresEntityToken) {
    throw new HandoffWriteViolationError(
      `the Handoff ${operation} payload carries an opaque Entity token in "${HANDOFF_SOURCES_PROPERTY}" that route "${routeKey}" does not require -- a route that does not deal in Entity identity refuses the token rather than writing one it would never read.`,
    );
  }
  if (declared.matterToken && !contract.requiresMatterToken) {
    throw new HandoffWriteViolationError(
      `the Handoff ${operation} payload carries an opaque Matter token in "${HANDOFF_SOURCES_PROPERTY}" that route "${routeKey}" does not require -- a route that does not deal in Matter identity refuses the token rather than writing one it would never read.`,
    );
  }
  if (contract.requiresEntityToken && !declared.entityToken) {
    throw new HandoffWriteViolationError(
      `the Handoff ${operation} payload's "${HANDOFF_SOURCES_PROPERTY}" property carries no opaque Entity token, and route "${routeKey}" requires one -- the pickup refuses this payload, so it is refused before the write instead of after it.`,
    );
  }
  if (contract.requiresMatterToken && !declared.matterToken) {
    throw new HandoffWriteViolationError(
      `the Handoff ${operation} payload's "${HANDOFF_SOURCES_PROPERTY}" property carries no opaque Matter token, and route "${routeKey}" requires one -- the pickup refuses this payload, so it is refused before the write instead of after it.`,
    );
  }
}

/**
 * The identity this write is being validated against. entityToken/
 * matterToken are the caller's operational reference for checks 1 & 2 of
 * the source-boundary contract; they are OPTIONAL here because the write
 * path no longer universally requires them (see the module header): a
 * caller with no tokens passes none, and the write is then accepted only
 * if the payload itself carries a contracted `Sources` reference or the
 * route is declared generic -- never if there is no operational reference
 * of any kind. The display-name/contact fields are supplied only when the
 * calling Unit actually
 * knows them (e.g. Sales, which resolves real identity earlier in its own
 * flow) -- a Unit that operates purely on tokens (Strategy, Finance)
 * has nothing to pass here, and correctly so: it never learned a real name
 * to begin with, per the closed-context contract in dataBoundary/policy.ts.
 */
export interface HandoffIdentity {
  entityToken?: string;
  matterToken?: string;
  entityName?: string;
  matterName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
}

// Deliberately narrow, not a generic PII scanner (see AGENTS.md's guidance
// against introducing one) -- these two patterns exist only as a secondary
// net alongside the identity-comparison checks below, which are the primary
// control. An email address is unambiguous. A phone number pattern is kept
// narrow (a leading "+" international prefix, or a 10-digit local number
// starting with 0) specifically so it doesn't false-positive on ordinary
// business figures like currency amounts, dates, or ranges.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_PATTERN = /(\+\d[\d\s\-().]{6,16}\d)|(\b0\d{9}\b)/;

function extractPropertyText(value: unknown): string {
  const v = value as { title?: unknown[]; rich_text?: unknown[] } | undefined;
  if (!v) return "";
  const parts = (v.title ?? v.rich_text) as Array<{ text?: { content?: string }; plain_text?: string }> | undefined;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => p.plain_text ?? p.text?.content ?? "").join("");
}

/** The known-identity fields this module's checks can compare against -- see HandoffIdentity. Never a real value itself, only ever used to name which field(s) a check used/found. */
export type KnownIdentityField = "entityName" | "matterName" | "contactName" | "email" | "phone";

/**
 * The single low-level "does this text contain this known identity value"
 * primitive -- shared by findViolation's per-Handoff-field check and, for
 * the bounded Strategy Proposal known-identity check (see
 * strategyAnalyst.ts's checkStrategyProposalForKnownIdentity), the same
 * comparison applied to a Proposal's serialized content. One implementation,
 * not two that could drift apart. Matching semantics are unchanged from
 * findViolation's own pre-existing behavior: case-insensitive substring for
 * name/email (with a length>=3 guard on names against short-needle false
 * positives), digit-normalized substring for phone.
 */
export function textContainsIdentityValue(text: string, value: string | undefined, kind: "name" | "email" | "phone"): boolean {
  if (!text.trim()) return false;
  const trimmed = value?.trim();
  if (!trimmed) return false;
  if (kind === "phone") {
    const phoneDigits = trimmed.replace(/\D/g, "");
    return phoneDigits.length >= 7 && text.replace(/\D/g, "").includes(phoneDigits);
  }
  if (kind === "name" && trimmed.length < 3) return false; // same short-needle guard findViolation has always applied
  return text.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Which of the known-identity fields on `identity` actually have a value --
 * i.e. which ones findViolation/textContainsIdentityValue actually exercise
 * for this identity object, as opposed to being silently skipped for being
 * absent. Used to record what a known-identity check actually covered
 * (never the values themselves) -- see WorkState.strategySourceBoundaryAttestation.
 */
export function identityFieldsPresent(identity: HandoffIdentity): KnownIdentityField[] {
  const fields: KnownIdentityField[] = [];
  if (identity.entityName?.trim()) fields.push("entityName");
  if (identity.matterName?.trim()) fields.push("matterName");
  if (identity.contactName?.trim()) fields.push("contactName");
  if (identity.email?.trim()) fields.push("email");
  if (identity.phone?.trim()) fields.push("phone");
  return fields;
}

/**
 * Checks a single protected field's resolved text against the known
 * identity. Returns a violation reason, or null if the field is clean.
 * Identity-name comparison is the primary control (per the "use the
 * authoritative identity already available" requirement) -- the generic
 * email/phone patterns are a secondary net, not the primary mechanism.
 */
function findViolation(fieldName: string, text: string, identity: HandoffIdentity): string | null {
  if (!text.trim()) return null;

  const namedChecks: Array<[string | undefined, string]> = [
    [identity.entityName, "the real Entity/company name"],
    [identity.matterName, "the real Matter name"],
    [identity.contactName, "a known contact's real name"],
  ];
  for (const [needle, label] of namedChecks) {
    if (textContainsIdentityValue(text, needle, "name")) {
      return `Handoff field "${fieldName}" contains ${label} ("${needle!.trim()}") -- identity must be carried only as opaque operational tokens in "${HANDOFF_SOURCES_PROPERTY}", never written into a Handoff field.`;
    }
  }

  if (textContainsIdentityValue(text, identity.email, "email")) {
    return `Handoff field "${fieldName}" contains a known contact's email address -- never write contact details into a Handoff field.`;
  }
  if (textContainsIdentityValue(text, identity.phone, "phone")) {
    return `Handoff field "${fieldName}" contains a known contact's phone number -- never write contact details into a Handoff field.`;
  }

  if (EMAIL_PATTERN.test(text)) {
    return `Handoff field "${fieldName}" contains what looks like an email address -- never write contact details into a Handoff field.`;
  }
  if (PHONE_PATTERN.test(text)) {
    return `Handoff field "${fieldName}" contains what looks like a phone number -- never write contact details into a Handoff field.`;
  }

  return null;
}

/**
 * The same identity check validateHandoffProperties applies per Handoff
 * field, exposed for other token-safe canonical records (e.g. the Runtime
 * Sales Proposal) that must hold the identical boundary. Returns a violation
 * reason, or null if the text is clean.
 */
export function findIdentityViolation(fieldName: string, text: string, identity: HandoffIdentity): string | null {
  return findViolation(fieldName, text, identity);
}

/**
 * Validates every protected field present in `properties` against the
 * supplied identity. Throws HandoffWriteViolationError on the first
 * violation found -- fail closed, never a partial/silent redaction.
 */
export function validateHandoffProperties(properties: NotionProperties, identity: HandoffIdentity): void {
  for (const field of PROTECTED_HANDOFF_FIELDS) {
    const value = (properties as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const text = extractPropertyText(value);
    const violation = findViolation(field, text, identity);
    if (violation) throw new HandoffWriteViolationError(violation);
  }
}

/**
 * The write's operational-reference gate: a Handoff must name HOW its
 * Entity/Matter identity travels -- identity tokens, a contracted
 * `Sources` payload (fully validated at pickup), or a route declared
 * generic -- and is refused outright when it names none of them. This is
 * exactly the protection the old unconditional token requirement gave,
 * expressed in terms of what actually identifies a Handoff now: nothing
 * about "is there real identity in this record" is weakened, because a
 * `Sources` payload still names the canonical records by exact page id and
 * is validated fail-closed before any consumer acts on it.
 */
function assertOperationalReference(input: { operation: string; identity: HandoffIdentity; carriesSources: boolean; routeIsGeneric: boolean; routeKey: string }): void {
  if (input.identity.entityToken?.trim() && input.identity.matterToken?.trim()) return;
  if (input.carriesSources || input.routeIsGeneric) return;
  throw new HandoffWriteViolationError(
    `the Handoff ${input.operation} payload carries no operational Entity/Matter reference: neither identity tokens were supplied nor a "${HANDOFF_SOURCES_PROPERTY}" payload, and route "${input.routeKey}" is not declared generic -- refusing to write a Handoff with nothing to bind its context to.`,
  );
}

/**
 * The five named checks of the canonical source_boundary_check contract a
 * Sales -> Strategy Handoff's sender must establish BEFORE the Handoff may
 * be written with Status Pending. The names are fixed contract vocabulary:
 * machine-readable, stable, and never carrying a value of any kind.
 */
export const SOURCE_BOUNDARY_CHECKS = [
  "operational_entity_reference_present",
  "operational_matter_reference_present",
  "identity_bearing_content_removed",
  "identity_resolution_registry_data_not_transferred",
  "handoff_context_identity_safe",
] as const;

export type SourceBoundaryCheckName = (typeof SOURCE_BOUNDARY_CHECKS)[number];

/**
 * The two checks that attest an operational Entity/Matter reference, and
 * the three content checks every write path establishes. A write carries
 * identity tokens -> all five are established and recorded (the legacy
 * shape, unchanged). A write with NO identity tokens records only the
 * content checks: checks 1 & 2 are then established on the receiving side
 * by its own resolution of the Handoff's canonical `Sources`
 * (`resolveHandoffSources`), which is a stricter check than the sender's
 * assertion -- never claimed here for a check this write did not perform.
 */
const REFERENCE_CHECKS: readonly SourceBoundaryCheckName[] = ["operational_entity_reference_present", "operational_matter_reference_present"];

const CONTENT_CHECKS: readonly SourceBoundaryCheckName[] = SOURCE_BOUNDARY_CHECKS.filter((c) => !(REFERENCE_CHECKS as readonly string[]).includes(c));

/** The explicit source-boundary result -- never a generic boolean such as `identitySafe: true`. */
export type SourceBoundaryResult = "Passed" | "Failed";

/**
 * What createHandoff's own source-boundary check established for a given
 * Handoff -- the explicit `result` (Passed/Failed), the five named checks
 * that result covers, and which known-identity fields (per
 * identityFieldsPresent) were available and compared -- never the values
 * themselves -- plus the id of the Handoff record it belongs to.
 *
 * DURABLE TRANSPORT: for a Sales -> Strategy Handoff the same evidence is
 * written INTO the Handoff itself at creation (the marker channel, see
 * buildSourceBoundaryMarker) -- that record is the authoritative,
 * fail-closed evidence source for a receiving Strategy execution in a
 * FRESH session, which has no shared WorkState. WorkState's
 * `strategySourceBoundaryAttestation` copy (set by the creating Unit, see
 * salesExecutive.ts's handleInterventionText) remains a same-session
 * convenience/audit copy only; it is not the transport, and missing durable
 * evidence must never be inferred as Passed from the absence of
 * identity-bearing content.
 */
export interface HandoffSourceBoundaryAttestation {
  handoffId: string;
  checked: true;
  /**
   * The explicit result of the source-boundary check. createHandoff only
   * ever RETURNS "Passed": a "Failed" or unverifiable check throws before
   * the Handoff is written, so no Pending Sales -> Strategy Handoff can
   * exist without an established Passed result. "Failed" remains a legal
   * RECORDED value on a Handoff written by a manual/external sender;
   * parseSourceBoundaryMarker rejects it fail-closed on the receiving side.
   */
  result: SourceBoundaryResult;
  /**
   * The named checks this result covers -- exactly the checks this write
   * established (see REFERENCE_CHECKS/CONTENT_CHECKS): all five when the
   * write carried operational identity tokens, the three content checks
   * when it carried none (checks 1 & 2 are then established by the
   * receiving execution's own resolution of the Handoff's canonical
   * `Sources`, never claimed by a sender that performed no such check).
   * Empty for the direct_request exemption (no Sales -> Strategy Handoff
   * exists, so there is nothing for the checks to attest to -- represented
   * honestly as no checks, never as a fabricated Passed).
   */
  checks: SourceBoundaryCheckName[];
  identityFieldsChecked: KnownIdentityField[];
}

/**
 * The source-boundary attestation marker: one named type within the shared
 * durable marker channel (`src/markerChannel.ts`), appended to the Handoff's
 * own `Reason` free text -- the same convention already used for the
 * `requiredCategory: call_notes` marker (see checkHandoffs.ts), so no Notion
 * schema change, no second record, and no new subsystem. The marker is
 * written as part of the Handoff creation payload itself (a single atomic
 * create), which is what binds it to this Handoff: it exists on exactly the
 * record it was computed for, and it must agree with that record's own
 * operational binding when read back. Two binding forms, both durable:
 *
 *   - **Identity form** (the Handoff's write carried operational
 *     identity tokens): `entity=<token> matter=<token>`, bound at pickup to
 *     the operational Entity/Matter references the receiving execution
 *     resolved for this Handoff -- from its canonical `Sources` when it is
 *     a source-based Handoff, from its legacy token fields otherwise. The
 *     properties themselves are never what binds it.
 *   - **Sources form** (a source-based write with no identity tokens):
 *     `refs=<page/file ids>`, bound at pickup to the EXACT ids the
 *     receiving execution's own resolution validated, so the marker travels
 *     with the very references it was computed for.
 *
 * It carries no real-world identity: only the result, the binding
 * references, the named checks actually established by this write (all five
 * when identity tokens bound it; the three content checks when the
 * references bind it, since checks 1 & 2 are then established by the
 * receiver's resolution rather than by the sender), and which
 * known-identity FIELDS were compared (field names, never values).
 *
 * The grammar itself (bracket group, `key=value` pairs) is shared with the
 * Call Notes `record_approval` marker and lives in `src/markerChannel.ts`;
 * only this type's field vocabulary and checks are owned here.
 */
const SOURCE_BOUNDARY_MARKER_NAME = "source_boundary_check";
const SOURCE_BOUNDARY_MARKER_PATTERN = markerPattern(SOURCE_BOUNDARY_MARKER_NAME);

/** Parse-time whitelist for the marker's `fields=` list -- names only, see KnownIdentityField. */
const KNOWN_IDENTITY_FIELD_NAMES: readonly KnownIdentityField[] = ["entityName", "matterName", "contactName", "email", "phone"];

/**
 * Builds the explicit, machine-readable source-boundary marker written into
 * a Handoff's Reason at creation, in whichever binding form that write can
 * honestly establish (forms described above): both operational identity
 * tokens (identity form, all five checks), neither -- in which case the
 * exact canonical source references the payload declares (sources form,
 * content checks only, checks 1 & 2 established by the receiver's own
 * resolution), or -- only reachable when a caller outside createHandoff
 * builds a marker by hand, since createHandoff refuses a partially tokened
 * write before it gets here, and a source-based write carries sourceIds --
 * a partial identity form recorded as exactly what it is, which the
 * receiver refuses fail-closed at binding. Throws rather than writing a
 * marker bound to nothing at all.
 */
export function buildSourceBoundaryMarker(
  identity: HandoffIdentity,
  result: SourceBoundaryResult,
  identityFieldsChecked: KnownIdentityField[],
  sourceBinding?: { sourceIds: readonly string[] },
): string {
  const entityToken = identity.entityToken?.trim() ?? "";
  const matterToken = identity.matterToken?.trim() ?? "";
  const ids = (sourceBinding?.sourceIds ?? []).map((id) => id.trim()).filter(Boolean);
  const entries: Array<[string, string]> = [["result", result]];
  let checks: SourceBoundaryCheckName[];
  if (entityToken && matterToken) {
    entries.push(["entity", entityToken], ["matter", matterToken]);
    checks = [...SOURCE_BOUNDARY_CHECKS];
  } else if (ids.length > 0) {
    entries.push(["refs", [...ids].sort().join(",")]);
    checks = [...CONTENT_CHECKS];
  } else if (entityToken || matterToken) {
    entries.push(["entity", entityToken], ["matter", matterToken]);
    checks = [...CONTENT_CHECKS];
  } else {
    throw new HandoffWriteViolationError(
      "a source-boundary marker must be bound to something this Handoff's receiver can verify -- neither operational identity tokens nor canonical source references are present, so no attestation is written.",
    );
  }
  entries.push(["checks", checks.join(",")], ["fields", identityFieldsChecked.join(",")]);
  return buildMarker(SOURCE_BOUNDARY_MARKER_NAME, entries);
}

/** The outcome of reading a Handoff's recorded source-boundary evidence. */
export type SourceBoundaryEvidence = MarkerEvidence<HandoffSourceBoundaryAttestation>;

/**
 * Reads and validates the durable source-boundary attestation a sender
 * recorded on a Handoff (buildSourceBoundaryMarker's marker channel).
 * This is CONSUMPTION of recorded evidence by the receiving execution --
 * it re-runs no boundary check, scans no content, and queries no identity
 * registry. Missing, malformed, Failed, or unbound evidence all return
 * { ok: false } with a non-sensitive reason so the caller can fail closed;
 * absence of identity-bearing content is never treated as proof the check
 * happened. `expected` binds the marker to the Handoff being read: its own
 * id plus whichever binding this execution established for it -- the
 * operational Entity/Matter references it resolved (`entityToken`/
 * `matterToken`, the identity form) and/or the exact source references its
 * own resolution validated (`sourceIds`, the sources form). A marker is
 * accepted only when its recorded checks are the ones its binding form can
 * evidence: an identity form must carry all five, a sources form the three
 * content checks (the receiver establishes checks 1 & 2 itself, from the
 * same resolution that produced `sourceIds`).
 */
export function parseSourceBoundaryMarker(
  reasonText: string,
  expected: { handoffId: string; entityToken?: string; matterToken?: string; sourceIds?: readonly string[] },
): SourceBoundaryEvidence {
  const match = SOURCE_BOUNDARY_MARKER_PATTERN.exec(reasonText ?? "");
  if (!match) {
    return { ok: false, reason: "no source_boundary_check attestation marker is recorded on this Handoff" };
  }
  const fields = new Map<string, string>(markerFieldEntries(match[1]));
  const result = fields.get("result");
  if (result !== "Passed" && result !== "Failed") {
    return { ok: false, reason: "the recorded source_boundary_check result is missing or malformed" };
  }
  if (result === "Failed") {
    return { ok: false, reason: "the recorded source_boundary_check result is Failed" };
  }
  const entity = fields.get("entity") ?? "";
  const matter = fields.get("matter") ?? "";
  const refs = fields.get("refs") ?? "";
  let requiredChecks: readonly SourceBoundaryCheckName[] = SOURCE_BOUNDARY_CHECKS;
  if (entity || matter) {
    // Identity form: bound to operational Entity/Matter references.
    if (!entity || !matter) {
      return { ok: false, reason: "the recorded attestation carries no operational Entity/Matter reference" };
    }
    if (entity !== expected.entityToken || matter !== expected.matterToken) {
      return { ok: false, reason: "the recorded attestation is not bound to this Handoff's operational Entity/Matter references" };
    }
  } else if (refs) {
    // Sources form: bound to the exact references this execution resolved.
    const recorded = refs.split(",").filter(Boolean).sort();
    const resolved = (expected.sourceIds ?? []).map((id) => id.trim()).filter(Boolean).sort();
    if (resolved.length === 0) {
      return { ok: false, reason: "the recorded attestation binds to canonical source references this execution did not resolve" };
    }
    if (recorded.join(",") !== resolved.join(",")) {
      return { ok: false, reason: "the recorded attestation is not bound to this Handoff's canonical source references" };
    }
    requiredChecks = CONTENT_CHECKS;
  } else {
    return { ok: false, reason: "the recorded attestation carries no operational Entity/Matter reference" };
  }
  const recordedChecks = (fields.get("checks") ?? "").split(",").filter(Boolean);
  const missingChecks = requiredChecks.filter((c) => !recordedChecks.includes(c));
  if (missingChecks.length > 0) {
    return { ok: false, reason: `the recorded attestation does not evidence the required check(s): ${missingChecks.join(", ")}` };
  }
  const identityFields = (fields.get("fields") ?? "").split(",").filter(Boolean);
  const unknownFields = identityFields.filter((f) => !(KNOWN_IDENTITY_FIELD_NAMES as readonly string[]).includes(f));
  if (unknownFields.length > 0) {
    return { ok: false, reason: "the recorded attestation names unknown known-identity fields" };
  }
  return {
    ok: true,
    attestation: {
      handoffId: expected.handoffId,
      checked: true,
      result: "Passed",
      checks: [...requiredChecks],
      identityFieldsChecked: identityFields as KnownIdentityField[],
    },
  };
}

/** Extracts a Notion select property's name for destination-fact checks (e.g. From Unit/To Unit). */
function selectName(value: unknown): string | undefined {
  const v = value as { select?: { name?: unknown } } | undefined;
  return typeof v?.select?.name === "string" ? v.select.name : undefined;
}

/**
 * The single production path for creating a Handoff. Validates the
 * identity boundary -- an operational Entity/Matter reference of some
 * sanctioned kind, and no prohibited identity in any protected field --
 * BEFORE calling notion.ts's createPage -- atomic from the application's
 * perspective: validate, then create, never create-then-repair. Throws
 * HandoffWriteViolationError on any violation; callers must treat that as a
 * fail-closed refusal to write, not something to catch and silently work
 * around.
 *
 * The operational reference is no longer ALWAYS the two token values: a
 * payload carrying a contracted `Sources` reference, or travelling a route
 * declared generic, writes without them (see the module header). The
 * source-boundary attestation records exactly the checks this write
 * established, and the returned `checks` list says the same -- a subset is
 * never dressed up as five.
 *
 * Returns both the created page and the source-boundary attestation for
 * exactly the identity this call validated against -- computed once, here,
 * rather than each calling Unit re-deriving identityFieldsPresent(identity)
 * by hand (previously only salesExecutive.ts did this, duplicating logic
 * that belongs with the check itself).
 *
 * `contracts` is a TEST SEAM (the same one `resolveHandoffSources` takes)
 * so a test can exercise the generic-route write path against a route
 * declared generic without editing the production contract table. Production
 * callers never pass it; omitting it resolves against
 * `HANDOFF_SOURCE_ROUTE_CONTRACTS` exactly as production does.
 */
export async function createHandoff(
  env: Env,
  properties: NotionProperties,
  identity: HandoffIdentity,
  access: AccessContext,
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): Promise<{ page: NotionPage; sourceBoundaryAttestation: HandoffSourceBoundaryAttestation }> {
  // A `Sources` payload is validated first, fail-closed: exact direct
  // references on a contracted route whose contract permits each Google
  // reference's type -- refused before anything else, so no write attempt
  // ever reaches Notion with a payload the pickup would refuse anyway.
  validateHandoffSourcesWrite(properties, "create", contracts);
  const fromUnit = selectName(properties["From Unit"]) ?? "";
  const toUnit = selectName(properties["To Unit"]) ?? "";
  const routeKey = `${fromUnit || "(none)"}->${toUnit || "(none)"}`;
  const sourcesExtraction = extractHandoffSources(properties);
  const carriesSources = sourcesExtraction.ok && sourcesExtraction.mode === "sources";
  const sourceIds = carriesSources
    ? sourcesExtraction.refs
        .filter((ref) => ref.kind !== "token")
        .map((ref) => (ref.kind === "notion" ? ref.pageId : ref.fileId))
    : [];
  const routeIsGeneric = !handoffRouteRequiresEntityMatter(fromUnit, toUnit, contracts);

  // Source-boundary checks 1 & 2 -- established first, fail closed: a
  // Handoff with no operational Entity/Matter reference never reaches
  // createPage. Tokens are still the basis for both checks when supplied;
  // when they are not, a contracted `Sources` payload (validated in full at
  // pickup, where the receiving side establishes checks 1 & 2 from that
  // resolution) or a declared-generic route is the sanctioned reference
  // instead. Nothing about the refusal for a payload carrying NEITHER is
  // relaxed.
  assertOperationalReference({ operation: "create", identity, carriesSources, routeIsGeneric, routeKey });
  const entityToken = identity.entityToken?.trim() ?? "";
  const matterToken = identity.matterToken?.trim() ?? "";
  const declared = carriesSources ? sourcesExtraction.tokens : undefined;
  if (declared) {
    // Caller-supplied tokens never override or contradict what the payload
    // declares -- the receiver binds to what is actually written, so a
    // disagreement is a refusal rather than something one transport wins.
    if (declared.entityToken && entityToken && declared.entityToken !== entityToken) {
      throw new HandoffWriteViolationError(
        `the Handoff create payload's operational Entity token is "${declared.entityToken}", but the caller supplied "${entityToken}" -- contradictory bindings are refused rather than written.`,
      );
    }
    if (declared.matterToken && matterToken && declared.matterToken !== matterToken) {
      throw new HandoffWriteViolationError(
        `the Handoff create payload's operational Matter token is "${declared.matterToken}", but the caller supplied "${matterToken}" -- contradictory bindings are refused rather than written.`,
      );
    }
  }
  // The operational Entity/Matter reference THIS write actually carries: the
  // token entries its own `Sources` payload declares when it has a payload,
  // otherwise the caller's operational tokens. It is what the durable marker
  // binds to and what checks 1 & 2 attest, so a marker can never be bound to
  // a reference the Handoff does not carry.
  const operationalEntityToken = declared?.entityToken || entityToken;
  const operationalMatterToken = declared?.matterToken || matterToken;
  const hasIdentityTokens = Boolean(operationalEntityToken && operationalMatterToken);
  const established = new Set<SourceBoundaryCheckName>();
  if (hasIdentityTokens) {
    established.add("operational_entity_reference_present");
    established.add("operational_matter_reference_present");
  }

  // Check 4 -- canonical structural guarantee, NOT a scan: this write path
  // performs no identity resolution of any kind. The only identity input is
  // the caller-supplied HandoffIdentity (see HandoffIdentity's doc), and
  // real-world identity lives exclusively in the Identity Resolution
  // Registry, which this Worker's Handoff write path never touches (see
  // identityResolution.ts and dataBoundary/policy.ts). Recording that
  // structural fact explicitly -- no IRR query, no second identity-safety
  // subsystem.
  established.add("identity_resolution_registry_data_not_transferred");

  // Check 3 -- the existing validation, unchanged: throws HandoffWriteViolationError
  // (fail closed) on the first identity-bearing value in any protected field.
  validateHandoffProperties(properties, identity);
  established.add("identity_bearing_content_removed");
  const identityFieldsChecked = identityFieldsPresent(identity);

  // What THIS write's attestation may claim: the content checks always,
  // the reference checks only when identity tokens were supplied (see
  // REFERENCE_CHECKS).
  const attestedChecks: SourceBoundaryCheckName[] = hasIdentityTokens ? [...SOURCE_BOUNDARY_CHECKS] : [...CONTENT_CHECKS];

  const isSalesToStrategy = fromUnit === "Sales" && toUnit === "Strategy";
  if (isSalesToStrategy) {
    // Durable evidence, part of THIS creation event: the explicit Passed
    // attestation travels inside the Handoff record itself, in Reason (the
    // sanctioned free-text marker channel -- same convention as
    // requiredCategory), so a receiving Strategy execution in a fresh
    // session reads evidence instead of inferring it. Bound to this
    // Handoff by its operational Entity/Matter references (or, with no
    // identity tokens, by the exact canonical source references the payload
    // declares); no real-world identity: result, binding, and the named
    // checks only.
    const marker = buildSourceBoundaryMarker(
      { ...identity, entityToken: operationalEntityToken, matterToken: operationalMatterToken },
      "Passed",
      identityFieldsChecked,
      { sourceIds },
    );
    const existingReason = extractPropertyText(properties.Reason).trim();
    properties.Reason = richText(existingReason ? `${existingReason} ${marker}` : marker);
    // Check 5 -- the full Handoff context (now including the marker text
    // itself) must pass the same identity validation before it may be
    // written. Order matters: the marker claims Passed, and it can only
    // persist if this final validation -- and therefore every check --
    // succeeds before createPage runs. A violation here throws, so a
    // Handoff can never persist evidence whose result was not established.
    validateHandoffProperties(properties, identity);
  }
  established.add("handoff_context_identity_safe");

  // Fail-closed default: if ANY check this attestation claims cannot be
  // established, no Handoff is written at all -- in particular, no Pending
  // Sales -> Strategy Handoff without an explicitly established Passed
  // result. Checks 1 & 2 make an unestablished pair only when identity
  // tokens were absent, and then they are deliberately NOT among the
  // claimed checks (the receiver establishes them from its own resolution
  // of this payload's sources instead).
  const unestablished = attestedChecks.filter((c) => !established.has(c));
  if (unestablished.length > 0) {
    throw new HandoffWriteViolationError(
      `source-boundary check(s) could not be established before write: ${unestablished.join(", ")} -- refusing to create the Handoff.`,
    );
  }

  // `access` is threaded straight through to notion.ts's createPage, which
  // is what actually evaluates it. This module's own validation is
  // deliberately unchanged and is NOT a substitute for it: identity safety
  // (what may be written) and authorization (whether this execution may
  // write at all, and with whose approval) are two different questions
  // answered by two different boundaries. Both run, in that order.
  const page = await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, properties, access);
  return {
    page,
    sourceBoundaryAttestation: {
      handoffId: page.id,
      checked: true,
      result: "Passed",
      checks: attestedChecks.filter((c) => established.has(c)),
      identityFieldsChecked,
    },
  };
}

/**
 * The single production path for updating a Handoff. Applies the same
 * protected-field validation as createHandoff whenever the update touches
 * one of those fields. `identity` is optional because many lifecycle
 * updates (Status transitions, a system-generated Open Questions reason)
 * carry no client identity at all and the calling Unit may not have one to
 * supply (Strategy/Finance never learn a real name) -- the generic
 * email/phone patterns still apply even without it. Existing legitimate
 * lifecycle updates (Status -> Closed, Work Completed, etc.) continue to
 * work exactly as before; this only rejects a write that fails validation.
 */
export async function updateHandoff(
  env: Env,
  handoffId: string,
  properties: NotionProperties,
  access: AccessContext,
  identity?: HandoffIdentity,
): Promise<NotionPage> {
  validateHandoffSourcesWrite(properties, "update");
  validateHandoffProperties(properties, identity ?? { entityToken: "", matterToken: "" });
  return updatePage(env, handoffId, properties, access);
}
