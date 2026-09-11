import type { MarketingHatName } from "./types";

export type MarketingAmbiguityReasonCode =
  | "NO_PLAUSIBLE_HATS"
  | "NO_REGISTERED_RELATIONSHIP"
  | "MULTIPLE_CONFLICTING_RELATIONSHIPS"
  | "CONDITIONAL_ESTABLISHING_REQUIRED"
  | "CLASSIFICATION_FAILED";

export interface MarketingRelationshipDefinition {
  id: string;
  from: MarketingHatName;
  to: MarketingHatName;
  conditional: boolean;
  description: string;
}

export const REGISTERED_MARKETING_RELATIONSHIPS: MarketingRelationshipDefinition[] = [
  {
    id: "REL_MS_CS",
    from: "Marketing Strategist",
    to: "Content Strategist",
    conditional: true,
    description: "Marketing Strategist defines marketing strategy before Content Strategist defines content strategy.",
  },
  {
    id: "REL_MS_BCS",
    from: "Marketing Strategist",
    to: "Brand & Communications Strategist",
    conditional: true,
    description: "Marketing Strategist defines marketing direction before Brand & Communications Strategist defines messaging guidance.",
  },
  {
    id: "REL_MS_DM",
    from: "Marketing Strategist",
    to: "Digital Marketer",
    conditional: true,
    description: "Marketing Strategist defines campaign objectives and channels before Digital Marketer executes digital campaigns.",
  },
  {
    id: "REL_BCS_CS",
    from: "Brand & Communications Strategist",
    to: "Content Strategist",
    conditional: true,
    description: "Brand & Communications Strategist establishes tone/messaging guidance before Content Strategist defines content pillars/briefs.",
  },
  {
    id: "REL_CS_CM",
    from: "Content Strategist",
    to: "Content Manager",
    conditional: true,
    description: "Content Strategist creates content briefs before Content Manager coordinates production workflow.",
  },
  {
    id: "REL_CM_DM",
    from: "Content Manager",
    to: "Digital Marketer",
    conditional: true,
    description: "Content Manager prepares and schedules content assets before Digital Marketer distributes them.",
  },
];

export interface Stage2ResolutionResult {
  resolved: boolean;
  hat?: MarketingHatName;
  relationshipId?: string;
  reason?: string;
  reasonCode?: MarketingAmbiguityReasonCode;
}

/**
 * Pure, deterministic, request-text-free Stage 2 resolver for Marketing Hat candidate relationships.
 * Fails closed on ambiguity, missing registered relationships, or unresolved conditional establishing flags.
 */
export function resolveMarketingCandidateRelationships(
  candidates: MarketingHatName[],
  establishing?: boolean,
): Stage2ResolutionResult {
  const uniqueCandidates = Array.from(new Set(candidates));

  if (uniqueCandidates.length === 0) {
    return {
      resolved: false,
      reason: "No plausible candidate Hats identified.",
      reasonCode: "NO_PLAUSIBLE_HATS",
    };
  }

  if (uniqueCandidates.length === 1) {
    return {
      resolved: true,
      hat: uniqueCandidates[0],
    };
  }

  const matchingRelationships = REGISTERED_MARKETING_RELATIONSHIPS.filter(
    (rel) => uniqueCandidates.includes(rel.from) && uniqueCandidates.includes(rel.to),
  );

  if (matchingRelationships.length === 0) {
    return {
      resolved: false,
      reason: `No registered sequential relationship exists between candidates: ${uniqueCandidates.join(", ")}.`,
      reasonCode: "NO_REGISTERED_RELATIONSHIP",
    };
  }

  if (matchingRelationships.length === 1) {
    const rel = matchingRelationships[0];
    if (rel.conditional) {
      if (establishing === true) {
        return {
          resolved: true,
          hat: rel.from,
          relationshipId: rel.id,
        };
      } else if (establishing === false) {
        return {
          resolved: true,
          hat: rel.to,
          relationshipId: rel.id,
        };
      } else {
        return {
          resolved: false,
          relationshipId: rel.id,
          reason: `Relationship ${rel.id} between ${rel.from} and ${rel.to} is conditional and requires explicit establishing state.`,
          reasonCode: "CONDITIONAL_ESTABLISHING_REQUIRED",
        };
      }
    } else {
      return {
        resolved: true,
        hat: rel.to,
        relationshipId: rel.id,
      };
    }
  }

  const resolvedHats = new Set<MarketingHatName>();
  for (const rel of matchingRelationships) {
    if (rel.conditional) {
      if (establishing === true) {
        resolvedHats.add(rel.from);
      } else if (establishing === false) {
        resolvedHats.add(rel.to);
      } else {
        return {
          resolved: false,
          reason: "Multiple conditional relationships require explicit establishing state.",
          reasonCode: "CONDITIONAL_ESTABLISHING_REQUIRED",
        };
      }
    } else {
      resolvedHats.add(rel.to);
    }
  }

  if (resolvedHats.size === 1) {
    const hat = Array.from(resolvedHats)[0];
    return {
      resolved: true,
      hat,
      relationshipId: matchingRelationships.map((r) => r.id).join(","),
    };
  }

  return {
    resolved: false,
    reason: `Candidates (${uniqueCandidates.join(", ")}) match multiple conflicting registered relationships.`,
    reasonCode: "MULTIPLE_CONFLICTING_RELATIONSHIPS",
  };
}

/**
 * Pure function that maps Stage 2 resolution result / failure state to a machine-readable reason code.
 */
export function selectMarketingAmbiguityReasonCode(
  result: Stage2ResolutionResult | null | undefined,
): MarketingAmbiguityReasonCode {
  if (!result) {
    return "CLASSIFICATION_FAILED";
  }
  if (result.reasonCode) {
    return result.reasonCode;
  }
  if (result.reason?.includes("No plausible candidate")) {
    return "NO_PLAUSIBLE_HATS";
  }
  if (result.reason?.includes("No registered sequential relationship")) {
    return "NO_REGISTERED_RELATIONSHIP";
  }
  if (result.reason?.includes("conflicting registered relationships")) {
    return "MULTIPLE_CONFLICTING_RELATIONSHIPS";
  }
  if (result.reason?.includes("requires explicit establishing state")) {
    return "CONDITIONAL_ESTABLISHING_REQUIRED";
  }
  return "CLASSIFICATION_FAILED";
}
