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
    id: "brand-communications-strategist__positioning",
    from: "Marketing Strategist",
    to: "Brand & Communications Strategist",
    conditional: false,
    description:
      "Overall marketing positioning established by Marketing Strategist before Brand & Communications Strategist translates that positioning into communication guidance.",
  },
  {
    id: "content-strategist__brand-guidance",
    from: "Brand & Communications Strategist",
    to: "Content Strategist",
    conditional: false,
    description:
      "Established brand and communications guidance that Content Strategist relies on when defining content direction.",
  },
  {
    id: "content-manager__content-strategy",
    from: "Content Strategist",
    to: "Content Manager",
    conditional: false,
    description:
      "Established content strategy that Content Manager relies on when turning content direction into executable workflow.",
  },
  {
    id: "digital-marketer__overall-marketing-strategy",
    from: "Marketing Strategist",
    to: "Digital Marketer",
    conditional: true,
    description:
      "Overall marketing strategy (objectives, target audiences/priority markets, campaign strategy, strategic channel recommendations) that Digital Marketer executes within — established or changed only when a request actually sets or redefines that direction, not by routine execution such as campaign targeting, budget adjustments within an approved strategy, placements, scheduling, or performance/tactical optimization.",
  },
  {
    id: "digital-marketer__strategic-channel-mix",
    from: "Marketing Strategist",
    to: "Digital Marketer",
    conditional: true,
    description:
      "Strategic channel mix decisions (determining which channels to use vs running an assigned channel) owned by Marketing Strategist that Digital Marketer relies on when executing digital campaigns.",
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
