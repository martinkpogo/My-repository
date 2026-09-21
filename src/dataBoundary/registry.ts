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
};

export function isSemanticTaskId(id: unknown): id is SemanticTaskId {
  return typeof id === "string" && id in SEMANTIC_TASK_REGISTRY;
}

export function getSemanticTaskDefinition(id: SemanticTaskId): SemanticTaskDefinition | undefined {
  return SEMANTIC_TASK_REGISTRY[id];
}
