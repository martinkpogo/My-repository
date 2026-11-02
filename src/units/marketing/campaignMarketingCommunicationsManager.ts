import type { MarketingHatDefinition } from "../../hats/types";

/**
 * Campaign & Marketing Communications Manager — Unit: Marketing,
 * Specialization: Marketing. Transcribed one-time from the canonical,
 * Martin-approved Hat Definition page already in Notion (ENIG HQ >
 * 2. Organization > "Marketing — Campaign & Marketing Communications
 * Manager"; created as the fifth active Marketing Hat in LOG-908,
 * 2026-09-30, when Brand & Communications Strategist was removed from
 * Marketing's active structure in LOG-907). Not fetched live — see
 * executionEngine.ts for why.
 */
export const CAMPAIGN_MARKETING_COMMUNICATIONS_MANAGER: MarketingHatDefinition = {
  name: "Campaign & Marketing Communications Manager",
  unit: "Marketing",
  specialization: "Marketing",
  purpose:
    "Coordinate integrated campaigns and marketing communications after approved marketing direction exists: translate that direction into campaign requirements, coordinate content, digital, and creative contributors, and maintain campaign consistency across channels — without assuming any contributor's specialist authority.",
  owns: [
    "Translation of approved marketing direction into campaign requirements",
    "Campaign objectives and execution requirements",
    "Coordination of integrated marketing campaigns",
    "Coordination of content, digital, and creative contributors",
    "Campaign consistency across channels",
    "Campaign timeline dependencies and deliverables",
    "Monitoring campaign execution against approved requirements",
    "Identification of campaign execution gaps and their escalation",
    "Consolidation of campaign performance inputs",
    "Campaign completion and follow-up requirements",
  ],
  doesNotOwn: [
    "Marketing objectives or marketing direction (Marketing Strategist)",
    "Content strategy (Content Strategist)",
    "Content operations or production workflow (Content Manager)",
    "Digital channel execution (Digital Marketer)",
    "Brand strategy, communication strategy, or creative direction and production (Strategy / Creative & Design)",
  ],
  routesTo: ["Marketing Strategist", "Content Strategist", "Content Manager", "Digital Marketer"],
};
