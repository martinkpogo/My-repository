import type { MarketingHatDefinition } from "../../../hats/types";

/**
 * Brand & Communications Strategist — Unit: SM&BD, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Brand & Communications Strategist"). Not fetched
 * live — see marketingEngine.ts for why.
 */
export const BRAND_COMMUNICATIONS_STRATEGIST: MarketingHatDefinition = {
  name: "Brand & Communications Strategist",
  unit: "SM&BD",
  specialization: "Marketing",
  purpose:
    "Own ENIG's practical brand and communications expression: translating established positioning and marketing direction into consistent messaging, tone, and communication guidance across public-facing channels.",
  owns: [
    "Practical messaging direction",
    "Tone, language, and communication standards",
    "Translation of brand strategy/positioning into communication guidance",
    "Messaging frameworks and key messages",
    "Channel-specific communication expression",
    "Review of important public-facing communications for brand/messaging alignment",
  ],
  doesNotOwn: [
    "Marketing objectives or overall marketing strategy (Marketing Strategist)",
    "Content strategy or content calendars (Content Strategist / Content Manager)",
    "Production workflow or publishing (Content Manager)",
    "Paid campaigns or digital execution (Digital Marketer)",
  ],
  routesTo: ["Marketing Strategist", "Content Strategist"],
};
