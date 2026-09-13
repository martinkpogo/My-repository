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
    description: "Checks if a request requires Marketing specialization within SM&BD.",
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
  "sales.call_qualification": {
    id: "sales.call_qualification",
    name: "Sales Call Qualification Assessment",
    description: "Evaluates the four canonical qualification conditions from call notes.",
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
};

export function isSemanticTaskId(id: unknown): id is SemanticTaskId {
  return typeof id === "string" && id in SEMANTIC_TASK_REGISTRY;
}

export function getSemanticTaskDefinition(id: SemanticTaskId): SemanticTaskDefinition | undefined {
  return SEMANTIC_TASK_REGISTRY[id];
}
