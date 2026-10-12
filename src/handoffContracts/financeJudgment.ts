/**
 * The markers around Finance's commercial-judgment block inside a Handoff
 * field -- the cross-Unit contract Sales parses and Finance writes. Neutral
 * so Sales depends on this contract, not on Finance's implementation.
 * Moved verbatim from src/units/finance/valueBasedPricingAssessor.ts.
 */

/** Opens Finance's own commercial-judgment block within the Finance -> Sales Handoff's combined "Verified Facts & Sources" text -- see handleQuoteApproval. */
export const FINANCE_JUDGMENT_START = "=== FINANCE COMMERCIAL JUDGMENT ===";
/** Closes Finance's commercial-judgment block -- see FINANCE_JUDGMENT_START. */
export const FINANCE_JUDGMENT_END = "=== END FINANCE COMMERCIAL JUDGMENT ===";
