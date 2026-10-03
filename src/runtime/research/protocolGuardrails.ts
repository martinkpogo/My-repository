import { RESEARCH_PROTOCOL_IDS, RESEARCH_PROTOCOL_REGISTRY, type ResearchProtocolId } from "./protocols";

/**
 * Deterministic correction layer on top of AI protocol selection.
 * Confirmed live: a research question fundamentally about market
 * structure/demand ("market and industry intelligence for a
 * strategy-led consultancy... market structure, demand, buyers, service
 * packaging... trends, Ghana vs Africa") was classified as [Competitive
 * Research, Customer / Audience Research] -- Market / Industry
 * Research, the protocol the question was actually centered on, was
 * silently dropped. The selection prompt already instructs the model not
 * to do this; nothing enforced it.
 *
 * Ownership split (Core Structure v2.4): the SIGNALS are
 * PROTOCOL-OWNED -- each protocol declares its own applicability
 * criteria as `applicabilitySignals`/`primaryWhenApplicable` in
 * protocols.ts. The EVALUATION stays EXECUTOR-OWNED -- this
 * module, applied by the research executor's selection stage for every protocol
 * the same way. No individual protocol evaluates, rejects, or reorders
 * itself.
 *
 * These patterns are purely ADDITIVE and never remove a protocol the AI
 * selected -- a broad market question that also explicitly asks about
 * competitors legitimately activates both (per the research executor's "multiple
 * protocols" contract); the bug was omission, not over-selection, so the
 * fix is insurance against omission, not a second opinion that overrides
 * the AI on everything.
 */

/**
 * Applies the deterministic guardrails to an AI-selected protocol list.
 * Any protocol whose declared applicability signal matches the question
 * and isn't already selected is added. A protocol declaring
 * `primaryWhenApplicable` additionally gets promoted to index 0 (primary)
 * whenever its own signal matches -- per the governance contract, a broad
 * market question must have Market / Industry as the PRIMARY protocol,
 * not merely present alongside others.
 */
export function applyProtocolSelectionGuardrails(question: string, aiSelected: ResearchProtocolId[]): ResearchProtocolId[] {
  const result = [...aiSelected];

  for (const id of RESEARCH_PROTOCOL_IDS) {
    const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
    const matched = (procedure.applicabilitySignals ?? []).some((signal) => signal.test(question));
    if (matched && !result.includes(id)) {
      result.push(id);
    }
  }

  for (const id of RESEARCH_PROTOCOL_IDS) {
    const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
    if (!procedure.primaryWhenApplicable) continue;
    const matched = (procedure.applicabilitySignals ?? []).some((signal) => signal.test(question));
    if (!matched) continue;

    const idx = result.indexOf(id);
    if (idx > 0) {
      result.splice(idx, 1);
      result.unshift(id);
    } else if (idx === -1) {
      result.unshift(id);
    }
  }

  return result;
}
