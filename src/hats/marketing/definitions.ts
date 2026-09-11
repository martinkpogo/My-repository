/**
 * Code-native canonical definitions for the five Marketing specialization
 * Hats, all within the existing SM&BD Unit (per the Unit's own Notion
 * definition: "Marketing — owns market-facing communication, campaigns,
 * and related marketing responsibilities as Hats are defined"). No new
 * Unit or Specialization is introduced.
 *
 * Transcribed directly from the canonical Hat Definition pages already
 * authored and Martin-approved in Notion (ENIG HQ > 2. Units & Hats,
 * "Digital Marketer Hat defined" / "Marketing Strategist Hat defined"
 * Activity Log entries, LOG-242 and its siblings) — this is a one-time
 * transcription, not a live fetch. Unlike Sales Executive and Finance,
 * Marketing Hats do not call getGovernance() for their own Hat
 * Definition at runtime: per this build's explicit direction, Notion is
 * not the runtime source of truth for these Hat definitions. The
 * Universal Role Contract remains an exception — it is existing,
 * already-shared infrastructure every Hat inherits, and is still fetched
 * via governance.ts like every other Hat.
 */

export type MarketingHatName =
  | "Marketing Strategist"
  | "Brand & Communications Strategist"
  | "Content Strategist"
  | "Content Manager"
  | "Digital Marketer";

export interface MarketingHatDefinition {
  name: MarketingHatName;
  purpose: string;
  owns: string[];
  doesNotOwn: string[];
  /**
   * Explicit, code-enforced allow-list of Hats this Hat may propose a
   * transition to. An AI-proposed target outside this list is rejected
   * (treated as ambiguous / stopped) rather than trusted — this is the
   * technical gate against one Hat silently absorbing, or misrouting
   * into, another Hat's responsibility.
   */
  routesTo: MarketingHatName[];
}

export const MARKETING_HAT_NAMES: MarketingHatName[] = [
  "Marketing Strategist",
  "Brand & Communications Strategist",
  "Content Strategist",
  "Content Manager",
  "Digital Marketer",
];

export const MARKETING_HATS: Record<MarketingHatName, MarketingHatDefinition> = {
  "Marketing Strategist": {
    name: "Marketing Strategist",
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
  },
  "Brand & Communications Strategist": {
    name: "Brand & Communications Strategist",
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
  },
  "Content Strategist": {
    name: "Content Strategist",
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
  },
  "Content Manager": {
    name: "Content Manager",
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
  },
  "Digital Marketer": {
    name: "Digital Marketer",
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
  },
};

/** Short, flat summary of every Marketing Hat — used for intake classification, never the full detail. */
export function marketingHatSummaryList(): string {
  return MARKETING_HAT_NAMES.map((name) => {
    const hat = MARKETING_HATS[name];
    return `- ${name}: ${hat.purpose}`;
  }).join("\n");
}
