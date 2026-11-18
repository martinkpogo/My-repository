import type { MarketingHatDefinition } from "../../hats/types";

/**
 * Digital Marketer — Unit: Marketing, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Digital Marketer"; see Activity Log "Digital
 * Marketer Hat defined", LOG-242). Not fetched live — see executionEngine.ts
 * for why.
 */
export const DIGITAL_MARKETER: MarketingHatDefinition = {
  name: "Digital Marketer",
  unit: "Marketing",
  specialization: "Marketing",
  purpose:
    "Run and optimise ENIG's approved digital marketing channels: manage digital campaigns and distribution, use performance evidence to optimise digital activity, and report performance back to Marketing Strategist -- without taking ownership of marketing strategy, brand messaging, content strategy, or human production.",
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
    "Brand/messaging strategy (Strategy — Brand Strategist and Communication Strategist)",
    "Content strategy (Content Strategist)",
    "Content workflow (Content Manager)",
    "Human visual production (Martin)",
    "Material spend without the required human approval",
  ],
  handsOverTo: [
    { toHat: "Marketing Strategist", forWhat: "report performance back" },
    { toHat: "Content Strategist", forWhat: "define the content direction when the work needs it" },
    { toHat: "Campaign & Marketing Communications Manager", forWhat: "coordinate the campaign when the work needs it" },
  ],
};
