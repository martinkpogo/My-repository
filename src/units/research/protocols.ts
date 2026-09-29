/**
 * Runtime representation of the six canonical Research & Intelligence
 * Procedure contracts (Core Structure v2.4).
 *
 * Governance source of truth is Notion -- "ENIG HQ > 4. Capability
 * Packages & Skills" -- where the six canonical Procedures are defined.
 * This file is the repository's deterministic runtime copy of those
 * contracts: the Worker never fetches the Notion Procedure pages during a
 * research execution (that would put governance retrieval on the hot
 * path and make execution untestable offline). It is therefore NOT an
 * independent governance system -- where the canonical definition and
 * this file disagree, the canonical definition wins and this file is the
 * bug to fix.
 *
 * A Procedure is a contract consumed by the shared Capability Package
 * executor (`capabilityPackage.ts`) -- never its own execution path.
 * Procedures are selected per request and executed by one shared
 * pipeline (protocol selection -> plan -> evidence gathering -> synthesis
 * -> Evidence & Source Validation -> delivery); there is no
 * per-Procedure engine, Hat, Unit, or Workspace. The former R&I Unit and
 * R&I Analyst Hat are retired organizational structures (Core Structure
 * v2.4); the `Research & Intelligence` unit/hat strings still present in
 * the codebase are routing/registry labels for the existing manifest and
 * Workspace stream, not capability ownership.
 *
 * Terminology: the runtime identifiers still say "protocol"
 * (`ResearchProtocolId`, `selectedResearchProtocols`,
 * `research.protocol_selection`) so WorkState fields, SemanticTaskIds,
 * and existing records stay stable. Throughout this file and the Package
 * they mean "Procedure".
 */

export type ResearchProtocolId =
  | "business_company"
  | "market_industry"
  | "competitive"
  | "customer_audience"
  | "environmental_regulatory"
  | "evidence_validation";

/**
 * One canonical Procedure contract as the Package executor consumes it.
 *
 * Field ownership follows Core Structure v2.4:
 * - `id`/`name`/`purpose`/`method`/`evidenceRequirements`/
 *   `interpretationConstraints`/`applicabilitySignals`/
 *   `primaryWhenApplicable` are PROCEDURE-OWNED: they say what this
 *   Procedure is for and what it constrains.
 * - Everything the executor does with them (selection, planning,
 *   searching, synthesising, validating, routing, fail-closed stops) is
 *   CAPABILITY-PACKAGE-OWNED and lives outside this file.
 *
 * Descriptors are data only -- deliberately no `run`/`execute` member of
 * any kind, so a Procedure can never become a second execution mechanism.
 */
export interface ResearchProtocolDefinition {
  /** Stable canonical id -- preserved across the Unit -> Capability Package migration. */
  id: ResearchProtocolId;
  /** Canonical Procedure name (display/selection identity). */
  name: string;
  /** Canonical Procedure purpose -- what this Procedure is for; consumed by the Package's selection stage. */
  purpose: string;
  /** Protocol-specific method: how the shared executor investigates once this Procedure is selected. Consumed by plan + synthesis. */
  method: string;
  /** Classes of evidence this Procedure's findings must rest on. Consumed by plan + synthesis. */
  evidenceRequirements: string;
  /**
   * Protocol-specific interpretation constraints from the canonical
   * Procedure definition -- injected into the plan and synthesis prompts
   * for the selected Procedure(s) only, never applied package-wide.
   */
  interpretationConstraints: string[];
  /**
   * Applicability signal(s) the Package's deterministic selection
   * guardrail evaluates against the incoming question (procedure-owned
   * criteria, package-owned evaluation -- see protocolGuardrails.ts).
   * Procedures without a signal are selected by the AI classification
   * stage alone, still fail-closed on ambiguity.
   */
  applicabilitySignals?: RegExp[];
  /**
   * Procedure declares it must be the PRIMARY Procedure whenever its own
   * applicability signal matches (the governance rule that a broad
   * market question has Market / Industry first, not merely alongside).
   */
  primaryWhenApplicable?: boolean;
}

export const RESEARCH_PROTOCOL_REGISTRY: Record<ResearchProtocolId, ResearchProtocolDefinition> = {
  business_company: {
    id: "business_company",
    name: "Business / Company Intelligence",
    purpose:
      "Establish what is publicly documented about a named organisation -- its situation, structure, offer, operating context, and material business evidence -- for the research need raised by the invoking Responsibility.",
    method:
      "Investigate an organisation, its situation, structure, offer, operating context, and relevant business evidence.",
    evidenceRequirements:
      "Official company filings, published financial reports, corporate disclosures, or verified primary organizational documentation.",
    interpretationConstraints: [
      "Anchor the work on the specific organisation named in the question -- never a generic company profile.",
      "Use the organisation's own authoritative records where applicable; label secondary commentary as commentary, not as the organisation's position.",
    ],
  },
  market_industry: {
    id: "market_industry",
    name: "Market / Industry Intelligence",
    purpose:
      "Establish what the evidence shows about the structure, dynamics, demand, benchmarks, growth, and external forces of the market or industry the question is about.",
    method: "Investigate market structure, industry dynamics, demand conditions, growth, shifts, benchmarks, and relevant external forces.",
    evidenceRequirements:
      "Industry research reports, benchmark data, market statistics, trade association publications, or regulatory market studies.",
    interpretationConstraints: [
      "State the geography and the time period behind time-sensitive market evidence (size, demand, growth), and treat each figure as of its stated period.",
    ],
    applicabilitySignals: [
      /\b(market (size|structure|demand|growth|dynamics|conditions|share)|industry (dynamics|conditions|structure|trends|benchmarks?)|demand conditions|market for|growth (rate|trends)|market benchmarks?)\b/i,
    ],
    primaryWhenApplicable: true,
  },
  competitive: {
    id: "competitive",
    name: "Competitive Intelligence",
    purpose:
      "Establish what is observable about the competitors and substitutes relevant to the question -- their offers, positioning, public pricing where evidenced, and the gaps or crowding they reveal.",
    method:
      "Investigate direct and indirect competitors, substitutes, positioning, observable offers, pricing where available, communication, and competitive gaps or crowding.",
    evidenceRequirements:
      "Observable competitor product pages, verified public pricing sheets, official feature comparison documentation, or direct offer material.",
    interpretationConstraints: [
      "Every inference must be traceable to an observation in the evidence (an observed offer, page, price, or statement).",
      "Never name or invent a competitor that is not evidenced in the supplied material.",
    ],
    applicabilitySignals: [
      /\b(competitors?|competition|competitive (landscape|positioning|analysis|crowding)|rivals?|substitutes|market positioning|observable offers?)\b/i,
    ],
  },
  customer_audience: {
    id: "customer_audience",
    name: "Customer / Audience Intelligence",
    purpose:
      "Establish what the evidence shows about the customers or audience relevant to the question -- their characteristics, behaviour, needs, purchase drivers, perceptions, pain points, language, and public feedback.",
    method:
      "Investigate customer or audience characteristics, behaviour, needs, purchase drivers, perceptions, pain points, language, reviews, and public feedback.",
    evidenceRequirements:
      "Public customer reviews, verified user feedback, audience surveys, case studies, or published usage statistics.",
    interpretationConstraints: [
      "Distinguish observation from inference: report what customers or audiences actually said or did, and label any inference as an inference.",
      "Do not generalise beyond the evidence -- never extend a narrow sample into a claim about the whole audience.",
    ],
    applicabilitySignals: [
      /\b(customers?|buyers?|audience(s)?|purchase drivers?|customer (needs?|perceptions?|behaviour|behavior)|public feedback|user reviews?)\b/i,
    ],
  },
  environmental_regulatory: {
    id: "environmental_regulatory",
    name: "Environmental / Regulatory Intelligence",
    purpose:
      "Establish the external conditions relevant to the question -- economic, technological, regulatory, policy, and social -- each with its jurisdiction and time period.",
    method:
      "Investigate relevant economic, technological, regulatory, policy, social, or other external conditions affecting the question.",
    evidenceRequirements:
      "Legislative texts, regulatory agency releases, official economic indicators, policy whitepapers, or authoritative industry policy analyses.",
    interpretationConstraints: [
      "State the jurisdiction and the time period each condition belongs to.",
      "Distinguish proposed, historical, and current conditions -- never present a proposal as an enacted requirement.",
    ],
  },
  evidence_validation: {
    id: "evidence_validation",
    name: "Evidence & Source Validation",
    purpose:
      "Research the provenance, dates, relevance, consistency, source quality, and support for material claims behind the evidence this request relies on. May run alongside another Procedure rather than standing alone.",
    method:
      "Validate provenance, dates, relevance, consistency, source quality, and support for material claims across the research process. May run alongside another protocol rather than standing alone.",
    evidenceRequirements:
      "Primary source verification, publication timestamp verification, cross-source consistency checks, and domain authority assessment.",
    interpretationConstraints: [
      "This Procedure researches source quality; it does not replace the Package's universal Evidence & Source Validation gate, which runs on every execution before any result is delivered.",
    ],
  },
};

export const RESEARCH_PROTOCOL_IDS = Object.keys(RESEARCH_PROTOCOL_REGISTRY) as ResearchProtocolId[];

export function isResearchProtocolId(id: string): id is ResearchProtocolId {
  return (RESEARCH_PROTOCOL_IDS as string[]).includes(id);
}

/** Short, flat summary of every Procedure (name + purpose) -- consumed by the Package's selection stage, never full per-protocol detail. */
export function researchProtocolSummaryList(): string {
  return RESEARCH_PROTOCOL_IDS.map((id) => `- ${RESEARCH_PROTOCOL_REGISTRY[id].name}: ${RESEARCH_PROTOCOL_REGISTRY[id].purpose}`).join("\n");
}

/**
 * Full per-protocol method/evidence/constraint detail for only the
 * selected Procedures -- given to the Package's plan and synthesis
 * stages, never all six.
 */
export function researchProtocolDetail(ids: ResearchProtocolId[]): string {
  return ids
    .map((id) => {
      const procedure = RESEARCH_PROTOCOL_REGISTRY[id];
      const constraints = procedure.interpretationConstraints.length
        ? `\n  Operating constraints:\n${procedure.interpretationConstraints.map((constraint) => `    - ${constraint}`).join("\n")}`
        : "";
      return `- ${procedure.name}: ${procedure.method}\n  Evidence requirements: ${procedure.evidenceRequirements}${constraints}`;
    })
    .join("\n");
}

function normalizeProtocolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Maps a model-returned Procedure name back to its canonical id,
 * tolerant of minor phrasing variance (case, partial match) since the
 * model is asked to return the Procedure's display name, not its
 * internal id. Returns null for anything that doesn't clearly match one
 * of the six registered Procedures -- callers must treat that as "couldn't
 * determine," never guess a nearest neighbor. Shared by protocol
 * selection (capabilityPackage.ts) and research-plan generation
 * (researchPlan.ts), which both need to resolve a model-returned
 * Procedure name the same way.
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
