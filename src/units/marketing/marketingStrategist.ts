import type { MarketingHatDefinition } from "../../hats/types";

/**
 * Marketing Strategist — Unit: Marketing, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Marketing Strategist"; see Activity Log "Marketing
 * Strategist Hat defined"). Not fetched live — see executionEngine.ts for why.
 */
export const MARKETING_STRATEGIST: MarketingHatDefinition = {
  name: "Marketing Strategist",
  unit: "Marketing",
  specialization: "Marketing",
  purpose:
    "Own ENIG's marketing plan and strategy: the audience, goals, core message, channels and targets, and the strategic approach required -- including when content will later be built from it. Coordinate the specialist Marketing Hats without absorbing their distinct responsibilities.",
  owns: [
    "The marketing plan and strategy: audience, goals, core message, channels and targets",
    "Target audiences and priority markets",
    "Marketing objectives",
    "Marketing strategy and campaign strategy",
    "Strategic purpose of major marketing initiatives and campaigns",
    "Strategic channel mix (which channels are used, not how a channel is run)",
    "Coordination of the Marketing specialist Hats against agreed strategy",
    "Marketing performance review and strategic adjustments",
  ],
  doesNotOwn: [
    "Content strategy -- the content themes, pillars and briefs built from the marketing direction (Content Strategist). Owning the marketing plan and strategy is not limited by content later being built from it.",
    "Brand messaging, tone, or communication standards (Strategy — Brand Strategist and Communication Strategist)",
    "Content production/publication workflow (Content Manager)",
    "Digital distribution, paid advertising, channel operations, or digital optimization (Digital Marketer)",
  ],
  handsOverTo: [
    { toHat: "Content Strategist", forWhat: "turn it into content themes and briefs" },
    { toHat: "Campaign & Marketing Communications Manager", forWhat: "coordinate a campaign" },
    { toHat: "Digital Marketer", forWhat: "handle channel execution" },
  ],
};
