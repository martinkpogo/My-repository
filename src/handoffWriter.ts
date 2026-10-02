import type { Env } from "./types";
import type { NotionProperties, NotionPage } from "./notion";
import { createPage, richText, updatePage } from "./notion";
import type { AccessContext } from "./access";

/**
 * Single runtime enforcement point for the canonical Handoff identity-write
 * boundary: every Handoff field that becomes another Unit's AI input
 * context may identify the Entity/Matter ONLY by its opaque Entity_Token /
 * Matter_Token -- never a real Entity/company name, a real contact name, an
 * email address, a phone number, or any other detail that identifies who
 * they actually are. Real identity may be read while preparing a Handoff;
 * it must be resolved to tokens before anything is WRITTEN to one. See
 * handoff-writing-rules.yaml (the manual-operator equivalent of this rule)
 * and the HO-58 incident it documents -- this module is the same rule
 * enforced in code for every runtime write path, so it no longer depends on
 * every producer applying the discipline by hand.
 *
 * Every Unit that creates or updates a Handoff must go through
 * createHandoff/updateHandoff below rather than calling notion.ts's
 * createPage/updatePage against HANDOFFS_DATA_SOURCE_ID directly -- one
 * enforcement point, not one per Unit.
 */

/** Every Handoff field that becomes another Unit's AI input context -- the protected set this boundary applies to. */
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
] as const;

export class HandoffWriteViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffWriteViolationError";
  }
}

/**
 * The identity this write is being validated against. entityToken/
 * matterToken are required on creation (see createHandoff). The display-
 * name/contact fields are supplied only when the calling Unit actually
 * knows them (e.g. Sales, which resolves real identity earlier in its own
 * flow) -- a Unit that operates purely on tokens (Strategy, Finance, R&I)
 * has nothing to pass here, and correctly so: it never learned a real name
 * to begin with, per the closed-context contract in dataBoundary/policy.ts.
 */
export interface HandoffIdentity {
  entityToken: string;
  matterToken: string;
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
      return `Handoff field "${fieldName}" contains ${label} ("${needle!.trim()}") -- identity must be carried only as Entity_Token/Matter_Token, never written into a Handoff field.`;
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

function assertTokensPresent(identity: HandoffIdentity): void {
  if (!identity.entityToken?.trim()) {
    throw new HandoffWriteViolationError("Entity_Token is required to create a Handoff and cannot be empty.");
  }
  if (!identity.matterToken?.trim()) {
    throw new HandoffWriteViolationError("Matter_Token is required to create a Handoff and cannot be empty.");
  }
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
   * The five named checks this result covers. Empty only for the
   * direct_request exemption (no Sales -> Strategy Handoff exists, so there
   * is nothing for the five checks to attest to -- represented honestly as
   * no checks, never as a fabricated five-check Passed).
   */
  checks: SourceBoundaryCheckName[];
  identityFieldsChecked: KnownIdentityField[];
}

/**
 * The sanctioned durable marker channel for a Sales -> Strategy
 * source-boundary attestation: a machine-readable bracket group appended to
 * the Handoff's own `Reason` free text -- the same convention already used
 * for the `requiredCategory: call_notes` marker (see checkHandoffs.ts), so
 * no Notion schema change, no second record, and no new subsystem. The
 * marker is written as part of the Handoff creation payload itself (a
 * single atomic create), which is what binds it to this Handoff: it exists
 * on exactly the record it was computed for, and its operational
 * Entity/Matter references must equal that record's own Entity_Token /
 * Matter_Token when read back. It carries no real-world identity: only the
 * result, the binding references, the five named checks, and which
 * known-identity FIELDS were compared (field names, never values).
 */
const SOURCE_BOUNDARY_MARKER_PATTERN = /\[source_boundary_check ([^\]]*)\]/;
const SOURCE_BOUNDARY_MARKER_FIELD_PATTERN = /(\w+)=([^\s\]]*)/g;

/** Parse-time whitelist for the marker's `fields=` list -- names only, see KnownIdentityField. */
const KNOWN_IDENTITY_FIELD_NAMES: readonly KnownIdentityField[] = ["entityName", "matterName", "contactName", "email", "phone"];

/** Builds the explicit, machine-readable source-boundary marker written into a Handoff's Reason at creation. */
export function buildSourceBoundaryMarker(
  identity: HandoffIdentity,
  result: SourceBoundaryResult,
  identityFieldsChecked: KnownIdentityField[],
): string {
  return (
    `[source_boundary_check result=${result}` +
    ` entity=${identity.entityToken.trim()}` +
    ` matter=${identity.matterToken.trim()}` +
    ` checks=${SOURCE_BOUNDARY_CHECKS.join(",")}` +
    ` fields=${identityFieldsChecked.join(",")}]`
  );
}

/** The outcome of reading a Handoff's recorded source-boundary evidence. */
export type SourceBoundaryEvidence = { ok: true; attestation: HandoffSourceBoundaryAttestation } | { ok: false; reason: string };

/**
 * Reads and validates the durable source-boundary attestation a sender
 * recorded on a Handoff (buildSourceBoundaryMarker's marker channel).
 * This is CONSUMPTION of recorded evidence by the receiving execution --
 * it re-runs no boundary check, scans no content, and queries no identity
 * registry. Missing, malformed, Failed, or unbound evidence all return
 * { ok: false } with a non-sensitive reason so the caller can fail closed;
 * absence of identity-bearing content is never treated as proof the check
 * happened. `expected` binds the marker to the Handoff being read: its own
 * id and its own operational Entity/Matter references.
 */
export function parseSourceBoundaryMarker(
  reasonText: string,
  expected: { handoffId: string; entityToken: string; matterToken: string },
): SourceBoundaryEvidence {
  const match = SOURCE_BOUNDARY_MARKER_PATTERN.exec(reasonText ?? "");
  if (!match) {
    return { ok: false, reason: "no source_boundary_check attestation marker is recorded on this Handoff" };
  }
  const fields = new Map<string, string>();
  for (const [, key, value] of match[1].matchAll(SOURCE_BOUNDARY_MARKER_FIELD_PATTERN)) {
    fields.set(key, value);
  }
  const result = fields.get("result");
  if (result !== "Passed" && result !== "Failed") {
    return { ok: false, reason: "the recorded source_boundary_check result is missing or malformed" };
  }
  if (result === "Failed") {
    return { ok: false, reason: "the recorded source_boundary_check result is Failed" };
  }
  const entity = fields.get("entity") ?? "";
  const matter = fields.get("matter") ?? "";
  if (!entity || !matter) {
    return { ok: false, reason: "the recorded attestation carries no operational Entity/Matter reference" };
  }
  if (entity !== expected.entityToken || matter !== expected.matterToken) {
    return { ok: false, reason: "the recorded attestation is not bound to this Handoff's operational Entity/Matter references" };
  }
  const recordedChecks = (fields.get("checks") ?? "").split(",").filter(Boolean);
  const missingChecks = SOURCE_BOUNDARY_CHECKS.filter((c) => !recordedChecks.includes(c));
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
      checks: [...SOURCE_BOUNDARY_CHECKS],
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
 * identity boundary (tokens required, no prohibited identity in any
 * protected field) BEFORE calling notion.ts's createPage -- atomic from the
 * application's perspective: validate, then create, never create-then-
 * repair. Throws HandoffWriteViolationError on any violation; callers must
 * treat that as a fail-closed refusal to write, not something to catch and
 * silently work around.
 *
 * Returns both the created page and the source-boundary attestation for
 * exactly the identity this call validated against -- computed once, here,
 * rather than each calling Unit re-deriving identityFieldsPresent(identity)
 * by hand (previously only salesExecutive.ts did this, duplicating logic
 * that belongs with the check itself).
 */
export async function createHandoff(
  env: Env,
  properties: NotionProperties,
  identity: HandoffIdentity,
  access: AccessContext,
): Promise<{ page: NotionPage; sourceBoundaryAttestation: HandoffSourceBoundaryAttestation }> {
  // Source-boundary checks 1 & 2 -- established first, fail closed: a
  // Handoff with no operational Entity/Matter reference never reaches
  // createPage. Not weakened; this IS the basis for both checks.
  assertTokensPresent(identity);
  const established = new Set<SourceBoundaryCheckName>();
  if (identity.entityToken.trim()) established.add("operational_entity_reference_present");
  if (identity.matterToken.trim()) established.add("operational_matter_reference_present");

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

  const isSalesToStrategy =
    selectName(properties["From Unit"]) === "Sales" && selectName(properties["To Unit"]) === "Strategy";
  if (isSalesToStrategy) {
    // Durable evidence, part of THIS creation event: the explicit Passed
    // attestation travels inside the Handoff record itself, in Reason (the
    // sanctioned free-text marker channel -- same convention as
    // requiredCategory), so a receiving Strategy execution in a fresh
    // session reads evidence instead of inferring it. Bound to this
    // Handoff by its operational Entity/Matter references; no real-world
    // identity: result, binding, and the five named checks only.
    const marker = buildSourceBoundaryMarker(identity, "Passed", identityFieldsChecked);
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

  // Fail-closed default: if ANY required check cannot be established, no
  // Handoff is written at all -- in particular, no Pending Sales -> Strategy
  // Handoff without an explicitly established Passed result.
  const unestablished = SOURCE_BOUNDARY_CHECKS.filter((c) => !established.has(c));
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
      checks: [...SOURCE_BOUNDARY_CHECKS],
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
 * supply (Strategy/Finance/R&I never learn a real name) -- the generic
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
  validateHandoffProperties(properties, identity ?? { entityToken: "", matterToken: "" });
  return updatePage(env, handoffId, properties, access);
}
