import type { MarketingHatDefinition } from "../../../hats/types";

/**
 * Marketing Strategist — Unit: SM&BD, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Marketing Strategist"; see Activity Log "Marketing
 * Strategist Hat defined"). Not fetched live — see marketingEngine.ts for why.
 */
export const MARKETING_STRATEGIST: MarketingHatDefinition = {
  name: "Marketing Strategist",
  unit: "SM&BD",
  specialization: "Marketing",
  purpose:
    "Own ENIG's marketing direction: who marketing must reach, what it must achieve, and the strategic approach required, while coordinating the specialist Marketing Hats without absorbing their distinct responsibilities.",
  owns: [
    "Target audiences and priority markets",
    "Marketing objectives",
    "Marketing strategy and campaign strategy",
    "Strategic purpose of major marketing initiatives and campaigns",
    "Strategic channel mix (which channels are used, not how a channel is run)",
    "Coordination of the Marketing specialist Hats against agreed strategy",
    "Marketing performance review and strategic adjustments",
  ],
  doesNotOwn: [
    "Brand messaging, tone, or communication standards (Brand & Communications Strategist)",
    "Content pillars, editorial direction, content briefs, or content strategy (Content Strategist)",
    "Content production/publication workflow (Content Manager)",
    "Digital distribution, paid advertising, channel operations, or digital optimization (Digital Marketer)",
  ],
  routesTo: ["Content Strategist", "Brand & Communications Strategist", "Digital Marketer"],
};
