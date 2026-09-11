import type { MarketingHatDefinition } from "../types";

/**
 * Content Manager — Unit: SM&BD, Specialization: Marketing.
 * Transcribed one-time from the canonical, Martin-approved Hat Definition
 * page already in Notion (ENIG HQ > 2. Units & Hats > "Sales, Marketing &
 * Business Development — Content Manager"). Not fetched live — see
 * marketingEngine.ts for why.
 */
export const CONTENT_MANAGER: MarketingHatDefinition = {
  name: "Content Manager",
  unit: "SM&BD",
  specialization: "Marketing",
  purpose:
    "Own the operational management of ENIG's content workflow: converting approved content strategy and briefs into an executable workflow, coordinating production through review, approval, and publication.",
  owns: [
    "Converting approved content strategy/briefs into executable workflow",
    "Content calendar and scheduling coordination",
    "Tracking deadlines and status",
    "Coordinating contributors from brief through production, review, approval, publication",
    "Ensuring outputs meet brief, format, and timing requirements",
    "Coordinating approvals",
    "Content library and publication history",
    "Tracking workflow issues",
    "Publication coordination and handoff to Digital Marketer",
  ],
  doesNotOwn: [
    "Marketing strategy (Marketing Strategist)",
    "Brand/messaging strategy (Brand & Communications Strategist)",
    "Content strategy (Content Strategist)",
    "Digital marketing execution (Digital Marketer)",
    "Human visual production (Martin)",
  ],
  routesTo: ["Digital Marketer"],
};
