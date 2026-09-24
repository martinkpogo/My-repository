/**
 * Business Development's in-flight opportunity state -- execution state
 * for the discover -> research -> assess -> qualify -> develop funnel
 * shared (with domain-specific action names) across all three BD Hats.
 * Per Architect's Action Registry correction, this is execution/
 * continuation state, not governed business state: it exists so
 * qualify_opportunity (and its Partnership/Growth equivalents) can pause
 * on missing evidence and resume later without losing what was already
 * gathered -- it does not by itself represent a privileged commitment.
 */
export interface BDOpportunityState {
  /** Which of the three parallel BD Hats this opportunity belongs to -- the manifest resolves the Hat; this records which one produced the state, for resume/display. */
  hatFamily: "opportunity_development" | "partnership_development" | "growth_market_development";
  /** The original candidate signal/description this opportunity was discovered from. */
  signal: string;
  /** Evidence gathered so far across discover/research/assess -- appended to, never overwritten, so a resumed qualification sees everything gathered before the hold. */
  evidence: string[];
  /** Set when qualify_* returns Held -- what's still missing before qualification can proceed. Cleared once the missing evidence is supplied and qualification re-runs. */
  missingEvidence?: string[];
  /** The most recent qualification outcome, if qualify_* has run at least once. */
  qualification?: "Qualified" | "Held" | "Blocked";
  /** Rationale for the most recent qualification outcome -- preserved for resume/audit, not just shown once and discarded. */
  qualificationRationale?: string;
  /** Set once develop_* has run: stakeholders, value hypothesis, route, dependencies, risks, next step, as free text pending a more structured shape once develop_* is actually implemented. */
  developedState?: string;
}
