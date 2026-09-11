import type { MarketingHatDefinition } from "../types";

/**
 * Digital Marketer — Unit: SM&BD, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Digital Marketer"; see Activity Log "Digital
 * Marketer Hat defined", LOG-242). Not fetched live — see
 * marketingEngine.ts for why.
 */
export const DIGITAL_MARKETER: MarketingHatDefinition = {
  name: "Digital Marketer",
  unit: "SM&BD",
  specialization: "Marketing",
  purpose:
    "Execute ENIG's approved digital marketing strategy: manage digital campaigns and distribution, and use performance evidence to optimize digital activity, without taking ownership of marketing strategy, brand messaging, content strategy, or human production.",
  owns: [
    "Execution of approved digital marketing strategy",
    "Digital campaign planning within approved strategy",
    "Digital distribution of approved content",
    "Paid advertising within approved objectives, budgets, audiences, and authority",
    "Targeting, placements, and scheduling",
    "Digital presence management",
    "Performance monitoring and tactical optimization",
    "Reporting and learning",
  ],
  doesNotOwn: [
    "Overall marketing strategy (Marketing Strategist)",
    "Redefining the strategic channel mix (Marketing Strategist)",
    "Brand/messaging strategy (Brand & Communications Strategist)",
    "Content strategy (Content Strategist)",
    "Content workflow (Content Manager)",
    "Human visual production (Martin)",
    "Material spend without the required human approval",
  ],
  routesTo: ["Marketing Strategist", "Content Strategist", "Brand & Communications Strategist"],
};
