/**
 * Mandatory, fail-closed identity redaction for every AI-bound prompt.
 *
 * Distinct from and in addition to the DataBoundaryEvaluator's sensitivity
 * transformations: sensitivity gates *whether* a segment may reach a
 * provider at all, while this gates *what the business is called* once it
 * does. Applied unconditionally to every provider (not just workers-ai) --
 * redacting a business name costs nothing even against a fully trusted
 * provider, and the guarantee is stronger for never having a provider-
 * conditional bypass.
 *
 * The guarantee this exists to provide: redact() is best-effort (a plain
 * word-boundary substitution can miss an unusual phrasing), so it is never
 * trusted alone. findLeftoverBannedTerms() re-scans the redacted text
 * immediately before it's sent, and AiPolicyExecutor treats any match there
 * as a hard stop -- the call is blocked, not sent with a residual leak.
 */

interface BannedTerm {
  /** Human-readable label for logs/alerts. */
  label: string;
  pattern: RegExp;
  replacement: string;
}

// Word-boundary + case-insensitive: catches "ENIG's" -> "the business's"
// (the trailing "'s" isn't part of the match, so possessives fall out
// correctly with no special-casing) and "Martin" mid-sentence, without
// over-matching inside an unrelated identifier that happens to contain the
// same letters glued to other word characters (e.g. "enig_hq_ops_bot" is
// one token to \b and won't match "ENIG" alone; "enig-agent" would, but
// that internal service name never appears in prompt content).
const BANNED_TERMS: BannedTerm[] = [
  { label: "ENIG", pattern: /\bENIG\b/gi, replacement: "the business" },
  { label: "Martin", pattern: /\bMartin\b/gi, replacement: "the operator" },
];

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
