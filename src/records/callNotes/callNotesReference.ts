import { plainText, type NotionPage } from "../../notion";
import type { CallNotesApprovalRecord } from "./callNotesMarker";

/**
 * The two Call Notes primitives that answer "which record does this Handoff
 * reference?" and "what are the located record's own registry fields?" --
 * factored into this leaf module so every reader of the reference grammar
 * shares ONE implementation without import cycles: `callNotesRecord.ts`
 * (Sales's consume path), `handoffSources.ts` (the direct-page Sources
 * resolver's free-text consistency check), and Strategy's read-only
 * evidence retrieval (via callNotesRecord's re-exports) all resolve to
 * exactly this code. Moving these here changes no behavior: they are
 * verbatim from callNotesRecord.ts, which re-exports them for its existing
 * importers.
 */

/** The free-text fields a call-notes Handoff's own `Call_Notes_ID` reference is read from. */
const REFERENCE_FIELDS = ["Reason", "Handoff"] as const;

/**
 * The reference grammar, matching `requiredCategory:\s*call_notes`'s style of
 * "a key, a separator, a value" on the Handoff's free text.
 *
 * `[ \t]*` (not `\s*`) before the value matters: `\s` would let the pattern
 * swallow the newline after an empty reference and report the NEXT line's text
 * as the id, turning a malformed reference into a plausible one. Value capture
 * stops at the end of the line so a reference embedded in a sentence still
 * yields exactly what follows the key, and nothing before it.
 */
const CALL_NOTES_REFERENCE_PATTERN = /Call_Notes_ID[ \t]*[:=][ \t]*([^\r\n]*)/;

/** A reference is a single token; longer than this is malformed rather than an id. */
const MAX_REFERENCE_LENGTH = 200;

/**
 * Whether the Handoff's free text MENTIONS a `Call_Notes_ID` reference at
 * all -- regardless of whether the value is usable. Exported so the
 * direct-page Sources resolver (src/handoffSources.ts) can distinguish "the
 * free-text transport is absent" (benign beside a Sources property) from
 * "the free-text transport is present but broken" (a conflict beside a
 * Sources property, refused rather than ignored), using THIS grammar rather
 * than a second copy of the regex.
 */
export function mentionsCallNotesReference(properties: Record<string, any>): boolean {
  for (const field of REFERENCE_FIELDS) {
    const raw = plainText(properties?.[field]);
    if (raw && CALL_NOTES_REFERENCE_PATTERN.test(raw)) return true;
  }
  return false;
}

export type CallNotesReference =
  | { ok: true; callNotesId: string }
  | { ok: false; reason: string };

/**
 * Reads the `Call_Notes_ID` reference a call-notes Handoff carries.
 *
 * Fail-closed on every way the reference can be unusable:
 *
 *   - **missing** -- neither free-text field mentions the key at all;
 *   - **empty** -- the key is present with no value after it;
 *   - **malformed** -- the value contains whitespace (a reference is one
 *     token, so `CN-007 (see below)` is not an id) or is absurdly long;
 *   - **ambiguous** -- the two fields record two DIFFERENT ids. Repeating the
 *     same id in both is not ambiguous and is accepted.
 *
 * It never falls back to `Entity_Token`/`Matter_Token` or to anything else on
 * the Handoff: those identify WHICH Entity and Matter the work concerns, not
 * which record to read, and inferring one from the other would be inventing a
 * lookup the record itself does not establish.
 *
 * `Verified Facts & Sources` is deliberately NOT searched. It is the Handoff's
 * substantive payload field, and this slice's whole point is that its content
 * is no longer authoritative about Call Notes -- using it as the place a
 * reference is looked up would keep one foot in the path being retired.
 */
export function extractCallNotesReference(
  properties: Record<string, any>,
): CallNotesReference {
  const found: string[] = [];

  for (const field of REFERENCE_FIELDS) {
    const raw = plainText(properties?.[field]);
    if (!raw) continue;

    const match = CALL_NOTES_REFERENCE_PATTERN.exec(raw);
    if (!match) continue;

    const value = match[1].trim();
    if (!value) {
      return { ok: false, reason: `the Handoff's ${field} records Call_Notes_ID with no value -- a reference with nothing after it is refused rather than looked up by any other means.` };
    }
    if (/\s/.test(value)) {
      return { ok: false, reason: `the Handoff's ${field} records a malformed Call_Notes_ID ("${value.slice(0, MAX_REFERENCE_LENGTH)}") -- a Call Notes reference is a single whitespace-free token.` };
    }
    if (value.length > MAX_REFERENCE_LENGTH) {
      return { ok: false, reason: `the Handoff's ${field} records a Call_Notes_ID longer than ${MAX_REFERENCE_LENGTH} characters, which is malformed rather than an id.` };
    }
    found.push(value);
  }

  if (found.length === 0) {
    return {
      ok: false,
      reason: `the Handoff carries no Call_Notes_ID reference in its ${REFERENCE_FIELDS.join(" or ")} -- there is no governed Call Notes record to read, and the Handoff's own narrative is not used as one.`,
    };
  }

  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    return { ok: false, reason: `the Handoff records conflicting Call_Notes_ID references (${distinct.join(", ")}) -- which record to consume is ambiguous, so nothing is read.` };
  }

  return { ok: true, callNotesId: distinct[0] };
}

/**
 * Reads the located Call Notes record's own registry fields for validation.
 *
 * `entity`/`matter` carry the Handoff's opaque Entity/Matter tokens, which
 * is what the binding gate established the record's relations ARE: the
 * relations were compared to the pages those tokens resolve to, so the tokens
 * are this record's own Entity and Matter references by that check, and they
 * are also the representation the approved marker shape (`entity=E-47
 * matter=M-12`) and this repository's own fixtures use. The fields'
 * representation is an open contract question `callNotesMarker.ts` explicitly
 * leaves open -- if the creation authority ever hashes a different
 * representation, `fields_hash` disagrees and validation fails closed rather
 * than guessing.
 */
export function readApprovalRecord(
  page: NotionPage,
  entityToken: string,
  matterToken: string,
): { ok: true; record: CallNotesApprovalRecord } | { ok: false; reason: string } {
  const properties = page.properties ?? {};

  const callNotesId = plainText(properties["Call Notes ID"]).trim();
  if (!callNotesId) {
    return { ok: false, reason: "the located Call Notes record carries no Call Notes ID title, so it cannot be identified." };
  }

  const version = properties.Version?.number;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    // Read straight off the number property rather than through plainText()
    // and a parse: plainText() would render a missing Version as "" and
    // Number("") is 0, which would silently present an unversioned record as
    // Version 0 instead of refusing it.
    return { ok: false, reason: "the located Call Notes record's Version property is missing or is not a non-negative integer, so no exact current Version can be bound." };
  }

  const callDate = properties["Call Date"]?.date?.start;
  return {
    ok: true,
    record: {
      callNotesId,
      entity: entityToken.trim(),
      matter: matterToken.trim(),
      callDate: typeof callDate === "string" ? callDate : "",
      callType: plainText(properties["Call Type"]),
      version,
    },
  };
}
