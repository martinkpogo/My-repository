import type { Env } from "./types";
import type { NotionProperties, NotionPage } from "./notion";
import { createPage, updatePage } from "./notion";

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

/**
 * Checks a single protected field's resolved text against the known
 * identity. Returns a violation reason, or null if the field is clean.
 * Identity-name comparison is the primary control (per the "use the
 * authoritative identity already available" requirement) -- the generic
 * email/phone patterns are a secondary net, not the primary mechanism.
 */
function findViolation(fieldName: string, text: string, identity: HandoffIdentity): string | null {
  if (!text.trim()) return null;
  const haystack = text.toLowerCase();

  const namedChecks: Array<[string | undefined, string]> = [
    [identity.entityName, "the real Entity/company name"],
    [identity.matterName, "the real Matter name"],
    [identity.contactName, "a known contact's real name"],
  ];
  for (const [needle, label] of namedChecks) {
    const trimmed = needle?.trim();
    // Guard against a too-short needle (e.g. a single-letter/word name)
    // matching incidentally inside unrelated text.
    if (trimmed && trimmed.length >= 3 && haystack.includes(trimmed.toLowerCase())) {
      return `Handoff field "${fieldName}" contains ${label} ("${trimmed}") -- identity must be carried only as Entity_Token/Matter_Token, never written into a Handoff field.`;
    }
  }

  if (identity.email && haystack.includes(identity.email.trim().toLowerCase())) {
    return `Handoff field "${fieldName}" contains a known contact's email address -- never write contact details into a Handoff field.`;
  }
  if (identity.phone) {
    const phoneDigits = identity.phone.replace(/\D/g, "");
    if (phoneDigits.length >= 7 && text.replace(/\D/g, "").includes(phoneDigits)) {
      return `Handoff field "${fieldName}" contains a known contact's phone number -- never write contact details into a Handoff field.`;
    }
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
 * The single production path for creating a Handoff. Validates the
 * identity boundary (tokens required, no prohibited identity in any
 * protected field) BEFORE calling notion.ts's createPage -- atomic from the
 * application's perspective: validate, then create, never create-then-
 * repair. Throws HandoffWriteViolationError on any violation; callers must
 * treat that as a fail-closed refusal to write, not something to catch and
 * silently work around.
 */
export async function createHandoff(env: Env, properties: NotionProperties, identity: HandoffIdentity): Promise<NotionPage> {
  assertTokensPresent(identity);
  validateHandoffProperties(properties, identity);
  return createPage(env, env.HANDOFFS_DATA_SOURCE_ID, properties);
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
  identity?: HandoffIdentity,
): Promise<NotionPage> {
  validateHandoffProperties(properties, identity ?? { entityToken: "", matterToken: "" });
  return updatePage(env, handoffId, properties);
}
