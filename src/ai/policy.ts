import type { AITask, TaskPolicy } from "./types";

export const TASK_POLICIES: Record<AITask, TaskPolicy> = {
  workspace_routing: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_LIGHT" },
  },
  specialization_classification: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_LIGHT" },
  },
  marketing_intake_stage1: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_LIGHT" },
  },
  marketing_hat_decision: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
  sales_entity_extraction: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_LIGHT" },
  },
  sales_matter_drafting: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_LIGHT" },
  },
  sales_call_prep: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
  sales_qualification: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
  sales_intervention_proposal: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
  sales_proposal_drafting: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
  finance_pricing_judgment: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
  general_chat: {
    primary: { provider: "workers-ai", modelKey: "AI_MODEL_PRIMARY" },
  },
};
