import type { ResearchProtocolId } from "./protocols";

/**
 * Deterministic correction layer on top of AI protocol selection. Confirmed
 * live: a research question fundamentally about market structure/demand
 * ("market and industry intelligence for a strategy-led consultancy...
 * market structure, demand, buyers, service packaging... trends, Ghana vs
 * Africa") was classified as [Competitive Intelligence, Customer / Audience
 * Intelligence] -- Market / Industry Intelligence, the protocol the
 * question was actually centered on, was silently dropped. The
 * protocol-selection prompt already instructs the model not to do this;
 * nothing enforced it.
 *
 * These patterns are purely ADDITIVE and never remove a protocol the AI
 * selected -- a broad market question that also explicitly asks about
 * competitors legitimately activates both (per the Unit's own "multiple
 * protocols" contract); the bug was omission, not over-selection, so the
 * fix is insurance against omission, not a second opinion that overrides
 * the AI on everything.
 */
const PROTOCOL_SIGNAL_PATTERNS: Partial<Record<ResearchProtocolId, RegExp>> = {
  market_industry: /\b(market (size|structure|demand|growth|dynamics|conditions|share)|industry (dynamics|conditions|structure|trends|benchmarks?)|demand conditions|market for|growth (rate|trends)|market benchmarks?)\b/i,
  competitive: /\b(competitors?|competition|competitive (landscape|positioning|analysis|crowding)|rivals?|substitutes?|market positioning|observable offers?)\b/i,
  customer_audience: /\b(customers?|buyers?|audience(s)?|purchase drivers?|customer (needs?|perceptions?|behaviour|behavior)|public feedback|user reviews?)\b/i,
};

/**
 * Applies the deterministic guardrails to an AI-selected protocol list.
 * Any protocol whose signal pattern matches the question and isn't
 * already selected is added. Market / Industry Intelligence additionally
 * gets promoted to index 0 (primary) whenever its own signal matches --
 * per the governance contract, a broad market question must have it as
 * the PRIMARY protocol, not merely present alongside others.
 */
export function applyProtocolSelectionGuardrails(question: string, aiSelected: ResearchProtocolId[]): ResearchProtocolId[] {
  const result = [...aiSelected];

  for (const [id, pattern] of Object.entries(PROTOCOL_SIGNAL_PATTERNS) as [ResearchProtocolId, RegExp][]) {
    if (pattern.test(question) && !result.includes(id)) {
      result.push(id);
    }
  }

  const marketPattern = PROTOCOL_SIGNAL_PATTERNS.market_industry!;
  if (marketPattern.test(question)) {
    const idx = result.indexOf("market_industry");
    if (idx > 0) {
      result.splice(idx, 1);
      result.unshift("market_industry");
    } else if (idx === -1) {
      result.unshift("market_industry");
    }
  }

  return result;
}
