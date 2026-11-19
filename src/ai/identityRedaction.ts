/**
 * Mandatory, fail-closed identity protection for every AI-bound prompt, with
 * a local restoration step for final internal output.
 *
 * Distinct from and in addition to the DataBoundaryEvaluator's sensitivity
 * transformations: sensitivity gates *whether* a segment may reach a
 * provider at all, while this gates *what the consultancy and its operator
 * are called* once it does. Applied unconditionally to every provider (not
 * just workers-ai) -- protecting the two names costs nothing even against a
 * fully trusted provider, and the guarantee is stronger for never having a
 * provider-conditional bypass.
 *
 * Two halves, one capability (Martin's decision, 2026-11-18):
 *
 *  1. Provider-bound representation. `redactIdentityTerms` replaces the two
 *     real names with opaque, stable placeholders -- "[ENIG_CONSULTANCY]" and
 *     "[ENIG_OPERATOR]" -- so a provider never receives the real names while
 *     the text still reads as natural language about a specific consultancy
 *     and a specific person. The placeholders are ordinary tokens, so they
 *     survive primary/fallback providers, multi-step AI workflows and any
 *     intermediate AI-generated content passed between providers, and
 *     `redactIdentityTerms` is idempotent over them (it never rewrites its
 *     own placeholder).
 *  2. Final internal output. `restoreIdentityPlaceholders` turns the
 *     placeholders back into "ENIG" and "Martin" for text about to be shown
 *     to the operator. It is the ONLY restoration function, deliberately
 *     separate from redaction so each caller states which boundary it is at:
 *     stored records, intermediate AI payloads and anything that may be sent
 *     to a provider again keep the protected representation.
 *     `restoreIdentityPlaceholdersWithRanges` is that same restoration for
 *     callers whose text carries index ranges (the Google Docs document
 *     specification): it restores with the ONE function above and shifts the
 *     ranges onto the restored text, refusing rather than guessing when a
 *     range would split a placeholder. It adds no second restoration rule.
 *
 * The guarantee this exists to provide: redact() is best-effort (a plain
 * word-boundary substitution can miss an unusual phrasing), so it is never
 * trusted alone. findLeftoverBannedTerms() re-scans the redacted text
 * immediately before it's sent, and AiPolicyExecutor treats any match there
 * as a hard stop -- the call is blocked, not sent with a residual leak. That
 * scan is independent of the placeholders: it looks for the real names, so a
 * restoration that leaked back into a provider payload would still be caught.
 */

interface BannedTerm {
  /** Human-readable label for logs/alerts. */
  label: string;
  pattern: RegExp;
  /** The opaque placeholder the real value is replaced by on the way out. */
  replacement: string;
}

/**
 * The two placeholders, exported so tests and the restoration step can name
 * them instead of spelling the strings out again.
 */
export const IDENTITY_PLACEHOLDERS = {
  consultancy: "[ENIG_CONSULTANCY]",
  operator: "[ENIG_OPERATOR]",
} as const;

// Word-boundary + case-insensitive: catches "ENIG's" -> "[ENIG_CONSULTANCY]'s"
// (the trailing "'s" isn't part of the match, so possessives fall out
// correctly with no special-casing) and "Martin" mid-sentence, without
// over-matching inside an unrelated identifier that happens to contain the
// same letters glued to other word characters (e.g. "enig_hq_ops_bot" is
// one token to \b and won't match "ENIG" alone; "enig-agent" would, but
// that internal service name never appears in prompt content). The same
// precision rule keeps the placeholders themselves intact: "_" is a word
// character, so \bENIG\b never matches inside "[ENIG_CONSULTANCY]" or
// "[ENIG_OPERATOR]" -- protection is idempotent and never corrupts its own
// output.
const BANNED_TERMS: BannedTerm[] = [
  { label: "ENIG", pattern: /\bENIG\b/gi, replacement: IDENTITY_PLACEHOLDERS.consultancy },
  { label: "Martin", pattern: /\bMartin\b/gi, replacement: IDENTITY_PLACEHOLDERS.operator },
];

/**
 * The inverse mapping, used only by `restoreIdentityPlaceholders` at a final
 * internal-presentation boundary. Each pattern matches the exact bracketed
 * token (case-insensitively, so a provider that lowercased a placeholder is
 * still restored) and nothing else: a partial, malformed or unknown
 * placeholder-like span is left byte-for-byte untouched rather than guessed
 * at, so restoration can never damage unrelated content.
 */
const PLACEHOLDER_RESTORATIONS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\[ENIG_CONSULTANCY\]/gi, value: "ENIG" },
  { pattern: /\[ENIG_OPERATOR\]/gi, value: "Martin" },
];

/** Replaces the real names with their opaque placeholders (provider-bound form). */
export function redactIdentityTerms(text: string): string {
  let result = text;
  for (const term of BANNED_TERMS) {
    result = result.replace(term.pattern, term.replacement);
  }
  return result;
}

/** Returns the labels of any banned term still present, or [] if clean. */
export function findLeftoverBannedTerms(text: string): string[] {
  const found: string[] = [];
  for (const term of BANNED_TERMS) {
    // Each pattern is `g`-flagged and stateful (lastIndex) -- construct a
    // fresh RegExp per test so repeated calls don't skip matches.
    const probe = new RegExp(term.pattern.source, term.pattern.flags);
    if (probe.test(text)) found.push(term.label);
  }
  return found;
}

/**
 * Restores the real names for FINAL INTERNAL OUTPUT ONLY -- text about to be
 * shown to the operator (the Telegram presentation boundary, `telegram.ts`).
 *
 * Deliberately not applied in the AI layer: an intermediate AI payload, a
 * stored record, a Handoff or a Proposal's token-safe content keeps the
 * protected representation, so it can never be forwarded to a provider with
 * the real names in it. Anything restored here is protected again by
 * `redactIdentityTerms` if it is ever sent back out, because the executor
 * redacts every message unconditionally.
 *
 * Safe by construction: missing placeholders (nothing to do), repeated calls
 * (idempotent), partially restored text (only the surviving token is
 * replaced), and malformed or unknown placeholder-like spans (left exactly
 * as they are -- never partially rewritten, never confused with real
 * content). Only the exact bracketed tokens are matched, so no unrelated word
 * is touched.
 */
export function restoreIdentityPlaceholders(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { pattern, value } of PLACEHOLDER_RESTORATIONS) {
    // Fresh RegExp per call: the module-level patterns are `g`-flagged and
    // must never carry state between callers.
    result = result.replace(new RegExp(pattern.source, pattern.flags), value);
  }
  return result;
}

/** A 1-based, end-exclusive index range over a document's text (the shape every Docs style/block range uses). */
export interface IndexRange {
  start: number;
  end: number;
}

/**
 * The one placeholder occurrence, as the remap needs it: its span in the
 * protected text and how much shorter (negative) or longer (positive) it
 * becomes once restored.
 */
interface PlaceholderOccurrence {
  start: number;
  end: number;
  delta: number;
}

/** Every placeholder occurrence in `text`, oldest first (fresh RegExp per pattern: they are `g`-flagged and must never carry state). */
function placeholderOccurrences(text: string): PlaceholderOccurrence[] {
  const occurrences: PlaceholderOccurrence[] = [];
  for (const { pattern, value } of PLACEHOLDER_RESTORATIONS) {
    const probe = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = probe.exec(text)) !== null) {
      occurrences.push({ start: match.index, end: match.index + match[0].length, delta: value.length - match[0].length });
      if (match[0].length === 0) probe.lastIndex += 1; // defensive: these patterns cannot match empty, but never spin
    }
  }
  return occurrences.sort((a, b) => a.start - b.start);
}

/**
 * Restores the real names in `text` AND remaps index ranges that describe
 * the protected text onto the restored text -- the same single restoration,
 * so a range never has to be recomputed by a second identity mechanism.
 *
 * A restoration shortens the text ("[ENIG_OPERATOR]" is 15 code units,
 * "Martin" is 6), so every range boundary after a restored placeholder moves
 * by the accumulated delta; boundaries before it do not move, and a boundary
 * sitting exactly where a placeholder ends moves with it. A range that would
 * SPLIT a placeholder (a boundary strictly inside it) is refused rather than
 * guessed at: no partial range is ever rewritten, and the caller fails closed
 * instead of styling or verifying a span that no longer addresses what it
 * was meant to address.
 *
 * Returns the restored text with the remapped ranges, or the reason the
 * ranges could not be remapped faithfully.
 */
export function restoreIdentityPlaceholdersWithRanges<T extends IndexRange>(
  text: string,
  ranges: readonly T[],
): { ok: true; text: string; ranges: T[] } | { ok: false; reason: string } {
  const occurrences = placeholderOccurrences(text);
  // Boundary coordinates are 0-based (position p in the range coordinate
  // system sits just before character p+1), which is how the spans above are
  // recorded.
  const splits = (boundary: number): boolean => occurrences.some((o) => o.start < boundary && boundary < o.end);
  const shift = (boundary: number): number =>
    boundary + occurrences.reduce((delta, o) => (o.end <= boundary ? delta + o.delta : delta), 0);

  const remapped: T[] = [];
  for (const range of ranges) {
    const start = range.start - 1;
    const end = range.end - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
      return { ok: false, reason: `range ${range.start}-${range.end} does not address the protected text (length ${text.length})` };
    }
    if (splits(start) || splits(end)) {
      return { ok: false, reason: `range ${range.start}-${range.end} splits an identity placeholder -- it cannot be remapped onto the restored text` };
    }
    remapped.push({ ...range, start: shift(start) + 1, end: shift(end) + 1 });
  }
  return { ok: true, text: restoreIdentityPlaceholders(text), ranges: remapped };
}
