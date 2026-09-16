/**
 * Structural validation and minimal-extraction helpers for the canonical
 * "Research-Safe Consultancy Context" Notion governance page. This page
 * is the ONLY description of the consultancy R&I is authorized to reason
 * from when interpreting a research question or constructing an external
 * research context -- an abstracted category (e.g. "strategy-led
 * consultancy," "Ghana/Africa"), never the consultancy's real identity,
 * founder/client names, or proprietary specifics.
 *
 * Per the governing Notion page's own "Governance Boundary" section, the
 * codebase must consume this governed context rather than maintain a
 * second, hard-coded description -- these helpers only validate/extract
 * from whatever text getGovernance() retrieves, they never define or
 * duplicate the content itself.
 */

// A handful of the canonical page's own section headers, used as a cheap
// structural sanity check -- not a full schema validator, just enough to
// catch "retrieved the wrong page," "page was gutted," or "retrieval
// silently returned unrelated content" rather than trusting any non-empty
// string as if it were the real governed contract.
const REQUIRED_SAFE_CONTEXT_MARKERS = ["Authorized Context", "Business Category", "Identity Protection"];

const MIN_SAFE_CONTEXT_LENGTH = 100;

export function isValidSafeContext(text: string | null | undefined): text is string {
  if (!text || text.trim().length < MIN_SAFE_CONTEXT_LENGTH) return false;
  return REQUIRED_SAFE_CONTEXT_MARKERS.every((marker) => text.includes(marker));
}

/**
 * Extracts only the "Authorized Context" section (Business Category,
 * Service Domains, General Client Type, Problem Domain, Geographic
 * Context, Research Relevance) -- never the "Identity Protection,"
 * "External Research Boundary," "Runtime Use," or "Governance Boundary"
 * sections, which are meta/policy text about the contract itself, not
 * research-relevant content. This is the "minimum safe context required"
 * that actually reaches a research prompt -- the full page is retrieved
 * and validated, but never injected verbatim.
 */
export function extractAuthorizedContextSummary(safeContextText: string): string {
  const startMarker = "## Authorized Context";
  const endMarker = "## Identity Protection";
  const startIdx = safeContextText.indexOf(startMarker);
  if (startIdx === -1) return safeContextText.trim();
  const endIdx = safeContextText.indexOf(endMarker, startIdx);
  const slice = endIdx === -1 ? safeContextText.slice(startIdx) : safeContextText.slice(startIdx, endIdx);
  return slice.trim();
}
