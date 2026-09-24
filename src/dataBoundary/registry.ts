import type { SemanticTaskId } from "./types";

export interface SemanticTaskDefinition {
  id: SemanticTaskId;
  name: string;
  description: string;
}

export const SEMANTIC_TASK_REGISTRY: Readonly<Record<SemanticTaskId, SemanticTaskDefinition>> = {
  "routing.enquiry_classification": {
    id: "routing.enquiry_classification",
    name: "Routing Enquiry Classification",
    description: "Classifies incoming enquiries to identify the destination Unit and Hat.",
  },
  "routing.marketing_specialization_check": {
    id: "routing.marketing_specialization_check",
    name: "Routing Marketing Specialization Check",
    description: "Checks if a request requires Marketing specialization, as opposed to Sales, when no dedicated topic already signals which.",
  },
  "chat.general_reply": {
    id: "chat.general_reply",
    name: "General Chat Reply",
    description: "Provides free-form conversational replies for Unit staff personas.",
  },
  "marketing.intake_classification": {
    id: "marketing.intake_classification",
    name: "Marketing Intake Classification",
    description: "Stage 1 candidate Hat identification for Marketing specialization tasks.",
  },
  "marketing.hat_action_decision": {
    id: "marketing.hat_action_decision",
    name: "Marketing Hat Action Decision",
    description: "Determines whether to draft, route, or clarify within a Marketing Hat.",
  },
  "routing.research_specialization_check": {
    id: "routing.research_specialization_check",
    name: "Routing Research Specialization Check",
    description: "Checks if a request is a genuine Research & Intelligence research question, as opposed to general chat, when no dedicated topic already signals which.",
  },
  "research.context_relevance": {
    id: "research.context_relevance",
    name: "Research Context Relevance",
    description: "Interprets what a research question means in relation to the authorized Research-Safe Consultancy Context category, before protocol selection. Establishes relevance only -- never a strategic, diagnostic, or downstream decision.",
  },
  "research.protocol_selection": {
    id: "research.protocol_selection",
    name: "Research Protocol Selection",
    description: "Identifies which R&I research protocol(s) a research question requires, or surfaces ambiguity rather than guessing.",
  },
  "research.plan_generation": {
    id: "research.plan_generation",
    name: "Research Plan Generation",
    description: "Generates a bounded, protocol-specific set of research sub-questions grounded in each selected protocol's own method and evidence requirements.",
  },
  "research.synthesis": {
    id: "research.synthesis",
    name: "Research Synthesis",
    description: "Executes the selected research protocol(s) and synthesizes source-linked evidence into Evidence/Finding/Implication/Limitation output.",
  },
  "research.handoff_routing": {
    id: "research.handoff_routing",
    name: "Research Handoff Routing",
    description: "Decides whether completed research should be automatically handed off to another Unit's Hat as direct input to its own work.",
  },
  "sales.enquiry_extraction": {
    id: "sales.enquiry_extraction",
    name: "Sales Enquiry Detail Extraction",
    description: "Extracts contact and organisation details from incoming sales enquiries.",
  },
  "sales.matter_summary_drafting": {
    id: "sales.matter_summary_drafting",
    name: "Sales Matter Summary Drafting",
    description: "Summarizes enquiry details into a short Matter title and stated need.",
  },
  "sales.call_prep_briefing": {
    id: "sales.call_prep_briefing",
    name: "Sales Call Prep Briefing",
    description: "Drafts a sales call prep briefing based on governance and enquiry context.",
  },
  "sales.commercial_evidence_extraction": {
    id: "sales.commercial_evidence_extraction",
    name: "Sales Commercial-Value Evidence Extraction",
    description:
      "Extracts structured commercial-value evidence (financial consequence, value at stake, cost of inaction, desired measurable outcome, evidence source/type/quality) from enquiry text and call notes, per the Commercial Value & Pricing Operating Model. Never infers a value not attributable to the supplied text.",
  },
  "sales.call_qualification": {
    id: "sales.call_qualification",
    name: "Sales Call Qualification Assessment",
    description: "Evaluates the five canonical qualification conditions from call notes.",
  },
  "sales.commercial_evidence_extraction_handoff": {
    id: "sales.commercial_evidence_extraction_handoff",
    name: "Sales Commercial-Value Evidence Extraction (Handoff)",
    description:
      "Same extraction as sales.commercial_evidence_extraction, restricted to the token-safe Handoff-pickup path: the isolated Sales Executive Claude project's already de-identified call notes (Section 6A), never raw enquiry/call-notes text.",
  },
  "sales.call_qualification_handoff": {
    id: "sales.call_qualification_handoff",
    name: "Sales Call Qualification Assessment (Handoff)",
    description:
      "Same qualification assessment as sales.call_qualification, restricted to the token-safe Handoff-pickup path: the isolated Sales Executive Claude project's already de-identified call notes (Section 6A), never raw enquiry/call-notes text.",
  },
  "sales.proposal_drafting": {
    id: "sales.proposal_drafting",
    name: "Sales Proposal Drafting",
    description: "Generates initial client-facing Draft Proposal from quote and context.",
  },
  "sales.proposal_revision": {
    id: "sales.proposal_revision",
    name: "Sales Proposal Revision",
    description: "Revises Draft Proposal according to human feedback while holding pricing bounds.",
  },
  "finance.quote_judgment": {
    id: "finance.quote_judgment",
    name: "Finance Quote Judgment",
    description: "Judges value-based price and pricing rationale from intervention context.",
  },
  "strategy.diagnosis": {
    id: "strategy.diagnosis",
    name: "Strategy Analyst Diagnosis",
    description:
      "Diagnoses a supplied business situation (Symptom -> Problem -> Cause -> Constraint -> Consequence), frames the strategic problem, and develops options/a recommended direction only where evidence supports one. Never asserts causation without sufficient support; never treats supplied input as fact merely because another Hat/Unit supplied it.",
  },
  "strategy.handoff_routing": {
    id: "strategy.handoff_routing",
    name: "Strategy Handoff Routing",
    description:
      "Decides whether a completed Strategy diagnosis should be handed off to another Unit (Research & Intelligence, Marketing, Sales, or Finance) as its next responsibility, per the Strategy Analyst Hat Definition's own handoff_rules -- never guesses when the destination is unclear.",
  },
  "strategy.proposal_drafting": {
    id: "strategy.proposal_drafting",
    name: "Strategy Intervention Proposal Drafting",
    description:
      "Expands a completed, causation-disciplined Strategy diagnosis into the complete Strategic Intervention Proposal (strategic opportunity/objective/direction, proposed intervention with workstreams, deliverables, phased timeline, scope, assumptions, dependencies, risks/constraints, expected business effect, success criteria) Martin reviews for Approve/Refine/Reject. Never manufactures precision the diagnosis doesn't support; marks an unsupportable timeline Indicative rather than Confirmed.",
  },
  "lead.discovery_classification": {
    id: "lead.discovery_classification",
    name: "Lead Discovery Signal Classification",
    description:
      "Screens a redacted, source-attributed discovery signal for whether it describes a genuine, in-scope lead -- never sees the discovered identity/contact itself, only the sanitized evidence description.",
  },
  "lead.discovery_signal_evaluation": {
    id: "lead.discovery_signal_evaluation",
    name: "Autonomous Lead Discovery Signal Evaluation",
    description:
      "Evaluates web-search results found by scheduled proactive discovery against the canonical Acquisition Criteria (operating business, problem signal, business consequence, ENIG relevance, consultancy-readiness, reachability, evidence threshold). Operates only on public, source-attributed search result content -- never fabricates a decision-maker, contact, or fact not present in that content.",
  },
  "action.google_doc_intake": {
    id: "action.google_doc_intake",
    name: "Google Doc Intake Classification & Parameter Extraction",
    description: "Extracts document title and content parameters from natural-language requests for controlled Google Doc creation.",
  },
  "action.google_doc_comment_edit": {
    id: "action.google_doc_comment_edit",
    name: "Google Doc Comment-Triggered Edit Interpretation",
    description:
      "Given the exact text a Google Docs comment is anchored to and the comment's own instruction, determines the specific replacement text -- never which text to target (that comes from the comment's own anchor, not the AI), and never invents content beyond what the comment reasonably implies.",
  },
  "action.google_sheet_intake": {
    id: "action.google_sheet_intake",
    name: "Google Sheet Intake Classification & Parameter Extraction",
    description:
      "Extracts a sheet title and initial header/data rows from natural-language requests for controlled Google Sheet creation (e.g. a content calendar).",
  },
  "action.google_sheet_comment_edit": {
    id: "action.google_sheet_comment_edit",
    name: "Google Sheet Comment-Triggered Edit Interpretation",
    description:
      "Given the exact cell content a Google Sheets comment is anchored to and the comment's own instruction, determines the specific replacement value for that cell -- never which cell to target (that comes from the comment's own anchor, not the AI), and never invents content beyond what the comment reasonably implies.",
  },
  "lead.discovery_ondemand_intake": {
    id: "lead.discovery_ondemand_intake",
    name: "Lead Generation Specialist On-Demand Discovery Intake",
    description:
      "Classifies whether a Workspace message is asking Lead Generation Specialist to proactively discover new potential opportunities, as opposed to a specific enquiry, a named-company research request, or unrelated chat -- and extracts the requested count and problem-signal focus, never a company name, decision-maker, or contact.",
  },
  "lead.discovery_ondemand_query_generation": {
    id: "lead.discovery_ondemand_query_generation",
    name: "Lead Generation Specialist On-Demand Search Strategy Generation",
    description:
      "Generates web search queries for an on-demand discovery request, grounded in the canonical Acquisition Criteria and Martin's stated focus -- same non-diagnostic discipline as the fixed scheduled-discovery query set, never presupposing a negative diagnosis or naming a specific organisation.",
  },
  "business_development.intake_classification": {
    id: "business_development.intake_classification",
    name: "Business Development Intake Classification",
    description: "Stage 1 candidate Hat identification among Business Development's three parallel Hats.",
  },
  "business_development.hat_action_decision": {
    id: "business_development.hat_action_decision",
    name: "Business Development Hat Action Decision",
    description: "Stage 2: picks which of the resolved Hat's own declared actions a request needs, per the generic Action Registry.",
  },
  "business_development.opportunity_qualification": {
    id: "business_development.opportunity_qualification",
    name: "Business Development Opportunity Qualification",
    description: "Applies the evidence threshold for Qualified / Held / Blocked to an in-flight BD opportunity's gathered evidence.",
  },
  "business_development.discover_opportunity": {
    id: "business_development.discover_opportunity",
    name: "Business Development Discover Opportunity",
    description: "Identifies a candidate BD opportunity from a signal, market, organisation, or relationship in Martin's request text.",
  },
  "business_development.research_opportunity": {
    id: "business_development.research_opportunity",
    name: "Business Development Research Opportunity",
    description: "Organizes and analyzes evidence for a named opportunity signal from Martin's own supplied facts, never fabricating unstated evidence.",
  },
  "business_development.assess_opportunity": {
    id: "business_development.assess_opportunity",
    name: "Business Development Assess Opportunity",
    description: "Determines whether a researched signal has a substantive reason for ENIG to pursue it, across strategic/commercial relevance, capability fit, evidence quality, and material unknowns.",
  },
  "business_development.develop_opportunity": {
    id: "business_development.develop_opportunity",
    name: "Business Development Develop Opportunity",
    description: "Drafts stakeholders, value hypothesis, route, dependencies, risks, and next step for a qualified BD opportunity, pending Martin's approval.",
  },
  "business_development.determine_next_move": {
    id: "business_development.determine_next_move",
    name: "Business Development Determine Next Move",
    description: "Identifies the next concrete action required to advance an active BD opportunity, pending Martin's approval.",
  },
  "business_development.discover_partner": {
    id: "business_development.discover_partner",
    name: "Business Development Discover Partner",
    description: "Identifies a candidate strategic relationship or partnership from a signal in Martin's request text.",
  },
  "business_development.research_partner": {
    id: "business_development.research_partner",
    name: "Business Development Research Partner",
    description: "Organizes and analyzes evidence for a named partner/relationship from Martin's own supplied facts, never fabricating unstated evidence.",
  },
  "business_development.assess_partnership": {
    id: "business_development.assess_partnership",
    name: "Business Development Assess Partnership",
    description: "Determines whether a researched partnership has a substantive reason for ENIG to pursue it, across mutual value, strategic fit, and relationship viability.",
  },
  "business_development.qualify_partnership": {
    id: "business_development.qualify_partnership",
    name: "Business Development Qualify Partnership",
    description: "Applies the evidence threshold for Qualified / Held / Blocked to an in-flight partnership's gathered evidence.",
  },
  "business_development.develop_partnership": {
    id: "business_development.develop_partnership",
    name: "Business Development Develop Partnership",
    description: "Drafts stakeholders, value proposition, relationship model, route, dependencies, and risks for a qualified partnership, pending Martin's approval.",
  },
  "business_development.discover_growth_opportunity": {
    id: "business_development.discover_growth_opportunity",
    name: "Business Development Discover Growth Opportunity",
    description: "Identifies a candidate market, channel, offering, or growth direction from a signal in Martin's request text.",
  },
  "business_development.research_market": {
    id: "business_development.research_market",
    name: "Business Development Research Market",
    description: "Organizes and analyzes evidence for a named market/industry/segment/channel from Martin's own supplied facts, never fabricating unstated evidence.",
  },
  "business_development.assess_market_opportunity": {
    id: "business_development.assess_market_opportunity",
    name: "Business Development Assess Market Opportunity",
    description: "Determines whether a researched growth/market signal has a substantive reason for ENIG to pursue it, across market attractiveness, strategic/commercial relevance, and capability fit.",
  },
  "business_development.qualify_growth_opportunity": {
    id: "business_development.qualify_growth_opportunity",
    name: "Business Development Qualify Growth Opportunity",
    description: "Applies the evidence threshold for Qualified / Held / Blocked to an in-flight growth opportunity's gathered evidence.",
  },
  "business_development.develop_growth_opportunity": {
    id: "business_development.develop_growth_opportunity",
    name: "Business Development Develop Growth Opportunity",
    description: "Drafts value hypothesis, requirements, route, dependencies, and risks for a qualified growth opportunity, pending Martin's approval.",
  },
};

export function isSemanticTaskId(id: unknown): id is SemanticTaskId {
  return typeof id === "string" && id in SEMANTIC_TASK_REGISTRY;
}

export function getSemanticTaskDefinition(id: SemanticTaskId): SemanticTaskDefinition | undefined {
  return SEMANTIC_TASK_REGISTRY[id];
}
