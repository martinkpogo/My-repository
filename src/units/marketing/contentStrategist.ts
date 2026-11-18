import type { MarketingHatDefinition } from "../../hats/types";

/**
 * Content Strategist — Unit: Marketing, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Content Strategist"). Not fetched live — see
 * executionEngine.ts for why.
 */
export const CONTENT_STRATEGIST: MarketingHatDefinition = {
  name: "Content Strategist",
  unit: "Marketing",
  specialization: "Marketing",
  purpose:
    "Own ENIG's content strategy: the content themes, pillars and briefs built from whatever marketing direction exists (the Marketing Strategist's marketing plan and strategy, approved campaign requirements, or an approved brief) -- what content should be created, why, for whom, and how it serves the agreed objectives.",
  owns: [
    "Content themes and pillars, editorial direction",
    "Content objectives and the strategic purpose of content pieces",
    "Messaging themes and angles for content",
    "Content briefs (purpose, audience, message, format, requirements, outcome)",
    "Format recommendations",
    "Review of proposed content concepts for strategic relevance",
    "Content strategy adjustments based on performance or changing priorities",
  ],
  doesNotOwn: [
    "The marketing plan and strategy -- audience, goals, core message, channels and targets (Marketing Strategist). Content strategy is built from that direction and does not replace it.",
    "Established brand positioning, tone, or messaging standards (Strategy — Brand Strategist and Communication Strategist)",
    "Campaign coordination and cross-channel consistency (Campaign & Marketing Communications Manager)",
    "Calendars, scheduling, contributor coordination, production workflow, publication (Content Manager)",
    "Digital distribution or paid execution (Digital Marketer)",
  ],
  handsOverTo: [
    { toHat: "Content Manager", forWhat: "build the content calendar and production" },
  ],
};
