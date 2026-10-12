/**
 * Strategy's cross-Unit Handoff contract -- the Strategic Intervention
 * Proposal shape and the curated boundary representation Strategy hands to
 * Finance and Sales. It lives here, not in the Strategy Unit, so Finance and
 * Sales depend on this neutral contract rather than on Strategy's
 * implementation (docs/enig-operating-model.md, "Module boundaries").
 * Moved verbatim from src/units/strategy/strategyAnalyst.ts; behaviour is
 * unchanged.
 */

/**
 * The complete Strategic Intervention Proposal Martin reviews for
 * Approve/Refine/Reject -- a runtime/work-state artifact (see
 * WorkState.strategyProposal), not a Notion database object or a new
 * Business Object. Developed from an already causation-disciplined
 * StrategyDiagnosisResult via developStrategyProposal, never generated in
 * place of the diagnosis step. Detailed enough for Martin to evaluate what
 * ENIG proposes to do, and specified enough for Finance to price without
 * having to redesign the intervention -- see buildStrategyBoundaryRepresentation.
 */
export interface StrategyProposal {
  proposalId: string;
  proposalVersion: number;

  executiveSummary: {
    businessSituation: string;
    strategicProblem: string;
    recommendedDirection: string;
    proposedIntervention: string;
    expectedBusinessEffect: string;
    decisionRequired: string;
  };

  businessContext: {
    entityContext: string;
    businessObjectives: string;
    relevantMarketContext: string;
    relevantAudienceOrCustomerContext: string;
    currentState: string;
    engagementTrigger: string;
    relevantCommercialContext: string;
    evidence: string[];
  };

  strategicChallenge: {
    businessObjective: string;
    observedSituation: string;
    strategicQuestion: string;
    whyItMatters: string;
  };

  diagnosis: {
    symptom: string;
    problem: string;
    causes: string[];
    constraints: string[];
    consequences: string[];
    evidence: string[];
    diagnosticConclusion: string;
  };

  strategicOpportunity: {
    opportunity: string;
    basis: string;
    relevanceToBusinessObjective: string;
    opportunityConditions: string[];
  };

  strategicObjective: {
    objective: string;
    intendedChange: string;
    businessAlignment: string;
    measurementDirection: string;
  };

  recommendedDirection: {
    direction: string;
    rationale: string;
    strategicLogic: string;
    alternativesConsidered: string[];
    selectionBasis: string;
  };

  proposedIntervention: {
    interventionName: string;
    interventionSummary: string;
    workstreams: Array<{
      name: string;
      objective: string;
      activities: string[];
      output: string;
      dependencies: string[];
      acceptanceCriteria: string[];
    }>;
  };

  deliverables: Array<{
    name: string;
    description: string;
    format: string;
    acceptanceCriteria: string[];
  }>;

  timeline: {
    status: "Indicative" | "Confirmed";
    totalDuration: string;
    phases: Array<{
      name: string;
      duration: string;
      activities: string[];
      outputs: string[];
      dependencies: string[];
      reviewPoint: string;
    }>;
  };

  entityInputs: {
    requiredInformation: string[];
    requiredDocuments: string[];
    requiredAccess: string[];
    requiredStakeholderParticipation: string[];
    requiredDecisions: string[];
  };

  assumptions: Array<{
    assumption: string;
    basis: string;
    materiality: string;
  }>;

  dependencies: Array<{
    dependency: string;
    owner: string;
    impactIfUnavailable: string;
  }>;

  risksAndConstraints: {
    risks: Array<{
      risk: string;
      potentialEffect: string;
      mitigationOrResponse: string;
    }>;
    constraints: Array<{
      constraint: string;
      implication: string;
    }>;
  };

  expectedBusinessEffect: {
    intendedEffects: string[];
    measurableEffects: string[];
    effectsRequiringBaseline: string[];
    limitations: string[];
  };

  successCriteria: Array<{
    criterion: string;
    measurement: string;
    evidenceRequired: string;
  }>;

  commercialScope: {
    included: string[];
    excluded: string[];
    expectedResources: string[];
    expectedDuration: string;
    clientResponsibilities: string[];
    downstreamUnitResponsibilities: string[];
  };

  strategicRecommendation: {
    recommendation: string;
    rationale: string;
    evidenceBasis: string[];
    conditionsOfApproval: string[];
  };
}

/** Opens the Strategy-authored block within a Handoff's "Verified Facts & Sources" text -- see serializeStrategyBoundaryRepresentation. */
export const STRATEGY_BOUNDARY_START = "=== STRATEGY BOUNDARY REPRESENTATION ===";
/** Closes the Strategy-authored block -- see STRATEGY_BOUNDARY_START. */
export const STRATEGY_BOUNDARY_END = "=== END STRATEGY BOUNDARY REPRESENTATION ===";

/**
 * The deliberate, curated cross-Unit boundary representation of an approved
 * Strategy Proposal -- exactly the fields Finance's pricing judgment and
 * Sales's client-facing proposal composition actually consume (per the
 * Strategy -> Finance -> Sales boundary-routing inspection this
 * implements), never a blind serialization of the complete StrategyProposal.
 * Deliberately excludes businessContext and strategicRecommendation, which
 * stay Strategy-internal -- neither Finance's nor Sales's own consumption
 * logic has ever referenced them.
 *
 * This type, and everything built from it below, makes a claim about
 * BOUNDARY ROUTING only: which fields cross the Unit boundary, and how they
 * are carried. It makes NO claim that the included content is free of real
 * entity/contact identity -- that is the separate, still-open question
 * verifyStrategyProposalTokenSafety's own doc comment describes, untouched
 * by this type.
 */
export type StrategyBoundaryRepresentation = Pick<
  StrategyProposal,
  | "proposalId"
  | "proposalVersion"
  | "executiveSummary"
  | "strategicChallenge"
  | "strategicOpportunity"
  | "diagnosis"
  | "strategicObjective"
  | "recommendedDirection"
  | "proposedIntervention"
  | "deliverables"
  | "timeline"
  | "entityInputs"
  | "assumptions"
  | "dependencies"
  | "risksAndConstraints"
  | "expectedBusinessEffect"
  | "successCriteria"
  | "commercialScope"
>;

/** Selects the boundary fields (see StrategyBoundaryRepresentation) from an approved Strategy Proposal. */
export function buildStrategyBoundaryRepresentation(proposal: StrategyProposal): StrategyBoundaryRepresentation {
  return {
    proposalId: proposal.proposalId,
    proposalVersion: proposal.proposalVersion,
    executiveSummary: proposal.executiveSummary,
    strategicChallenge: proposal.strategicChallenge,
    strategicOpportunity: proposal.strategicOpportunity,
    diagnosis: proposal.diagnosis,
    strategicObjective: proposal.strategicObjective,
    recommendedDirection: proposal.recommendedDirection,
    proposedIntervention: proposal.proposedIntervention,
    deliverables: proposal.deliverables,
    timeline: proposal.timeline,
    entityInputs: proposal.entityInputs,
    assumptions: proposal.assumptions,
    dependencies: proposal.dependencies,
    risksAndConstraints: proposal.risksAndConstraints,
    expectedBusinessEffect: proposal.expectedBusinessEffect,
    successCriteria: proposal.successCriteria,
    commercialScope: proposal.commercialScope,
  };
}

/**
 * Serializes the boundary representation as deterministic JSON (a fixed key
 * order, from the object literal above -- never derived from Object.keys on
 * AI-produced input) wrapped in explicit start/end markers, so a downstream
 * Unit can locate and parse exactly this block within a larger Handoff field
 * without ambiguity (see extractLabeledBlock), and a human reading the
 * Handoff directly in Notion can see plainly where Strategy's own material
 * starts and ends.
 */
export function serializeStrategyBoundaryRepresentation(rep: StrategyBoundaryRepresentation): string {
  return `${STRATEGY_BOUNDARY_START}\n${JSON.stringify(rep)}\n${STRATEGY_BOUNDARY_END}`;
}
