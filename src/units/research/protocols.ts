/**
 * Canonical R&I research protocol registry, transcribed from Notion's
 * "Research & Intelligence" Unit page and the Research & Intelligence
 * Analyst Hat Definition. Protocols are execution modes inside the single
 * R&I execution capability -- never separate Hats, runtimes, or Telegram
 * topics (per the Unit's own Notion contract: "A separate Hat may be
 * introduced only when live work demonstrates a materially different
 * capability... that cannot effectively be grouped with the existing
 * Hat"). A research request may activate one protocol or several at once.
 */

export type ResearchProtocolId =
  | "business_company"
  | "market_industry"
  | "competitive"
  | "customer_audience"
  | "environmental_regulatory"
  | "evidence_validation";

export interface ResearchProtocolDefinition {
  id: ResearchProtocolId;
  name: string;
  method: string;
  evidenceRequirements: string;
}

export const RESEARCH_PROTOCOL_REGISTRY: Record<ResearchProtocolId, ResearchProtocolDefinition> = {
  business_company: {
    id: "business_company",
    name: "Business / Company Intelligence",
    method:
      "Investigate an organisation, its situation, structure, offer, operating context, and relevant business evidence.",
    evidenceRequirements:
      "Official company filings, published financial reports, corporate disclosures, or verified primary organizational documentation.",
  },
  market_industry: {
    id: "market_industry",
    name: "Market / Industry Intelligence",
    method:
      "Investigate market structure, industry dynamics, demand conditions, shifts, benchmarks, and relevant external forces.",
    evidenceRequirements:
      "Industry research reports, benchmark data, market statistics, trade association publications, or regulatory market studies.",
  },
  competitive: {
    id: "competitive",
    name: "Competitive Intelligence",
    method:
      "Investigate direct and indirect competitors, substitutes, positioning, observable offers, pricing where available, communication, and competitive gaps or crowding.",
    evidenceRequirements:
      "Observable competitor product pages, verified public pricing sheets, official feature comparison documentation, or direct offer material.",
  },
  customer_audience: {
    id: "customer_audience",
    name: "Customer / Audience Intelligence",
    method:
      "Investigate customer or audience characteristics, behaviour, needs, purchase drivers, perceptions, pain points, language, reviews, and public feedback.",
    evidenceRequirements:
      "Public customer reviews, verified user feedback, audience surveys, case studies, or published usage statistics.",
  },
  environmental_regulatory: {
    id: "environmental_regulatory",
    name: "Environmental / Regulatory Intelligence",
    method:
      "Investigate relevant economic, technological, regulatory, policy, social, or other external conditions affecting the question.",
    evidenceRequirements:
      "Legislative texts, regulatory agency releases, official economic indicators, policy whitepapers, or authoritative industry policy analyses.",
  },
  evidence_validation: {
    id: "evidence_validation",
    name: "Evidence & Source Validation",
    method:
      "Validate provenance, dates, relevance, consistency, source quality, and support for material claims across the research process. May run alongside another protocol rather than standing alone.",
    evidenceRequirements:
      "Primary source verification, publication timestamp verification, cross-source consistency checks, and domain authority assessment.",
  },
};

export const RESEARCH_PROTOCOL_IDS = Object.keys(RESEARCH_PROTOCOL_REGISTRY) as ResearchProtocolId[];

export function isResearchProtocolId(id: string): id is ResearchProtocolId {
  return (RESEARCH_PROTOCOL_IDS as string[]).includes(id);
}

/** Short, flat summary of every protocol -- used for protocol-selection classification, never full per-protocol detail. */
export function researchProtocolSummaryList(): string {
  return RESEARCH_PROTOCOL_IDS.map((id) => `- ${RESEARCH_PROTOCOL_REGISTRY[id].name}: ${RESEARCH_PROTOCOL_REGISTRY[id].method}`).join("\n");
}

/** Full per-protocol method text for only the selected protocols -- given to the synthesis stage, never all six. */
export function researchProtocolDetail(ids: ResearchProtocolId[]): string {
  return ids.map(
    (id) =>
      `- ${RESEARCH_PROTOCOL_REGISTRY[id].name}: ${RESEARCH_PROTOCOL_REGISTRY[id].method}\n  Evidence requirements: ${RESEARCH_PROTOCOL_REGISTRY[id].evidenceRequirements}`,
  ).join("\n");
}

function normalizeProtocolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Maps a model-returned protocol name back to its canonical id, tolerant
 * of minor phrasing variance (case, partial match) since the model is
 * asked to return the protocol's display name, not its internal id.
 * Returns null for anything that doesn't clearly match one of the six
 * registered protocols -- callers must treat that as "couldn't
 * determine," never guess a nearest neighbor. Shared by protocol
 * selection (researchAnalyst.ts) and research-plan generation
 * (researchPlan.ts), which both need to resolve a model-returned protocol
 * name the same way.
 */
export function nameToProtocolId(name: string): ResearchProtocolId | null {
  const normalized = normalizeProtocolName(name);
  if (!normalized) return null;
  const match = RESEARCH_PROTOCOL_IDS.find((id) => {
    const canonical = normalizeProtocolName(RESEARCH_PROTOCOL_REGISTRY[id].name);
    // Substring containment is only trusted once the normalized name is
    // long enough to be a real match rather than a trivial/empty-string
    // false positive (every string "contains" "").
    return canonical === normalized || (normalized.length >= 8 && (canonical.includes(normalized) || normalized.includes(canonical)));
  });
  return match ?? null;
}
