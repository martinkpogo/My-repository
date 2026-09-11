import type { MarketingHatDefinition } from "../types";

/**
 * Content Strategist — Unit: SM&BD, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Content Strategist"). Not fetched live — see
 * marketingEngine.ts for why.
 */
export const CONTENT_STRATEGIST: MarketingHatDefinition = {
  name: "Content Strategist",
  unit: "SM&BD",
  specialization: "Marketing",
  purpose:
    "Own ENIG's content strategy: what content should be created, why, for whom, and how it serves agreed marketing objectives, translating Marketing Strategy and Brand & Communications guidance into actionable content direction.",
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
    "What marketing needs to accomplish (Marketing Strategist)",
    "Established brand positioning, tone, or messaging standards (Brand & Communications Strategist)",
    "Calendars, scheduling, contributor coordination, production workflow, publication (Content Manager)",
    "Digital distribution or paid execution (Digital Marketer)",
  ],
  routesTo: ["Content Manager"],
};
