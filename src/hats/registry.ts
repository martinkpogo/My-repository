import type { MarketingHatDefinition, MarketingHatName } from "./types";
import { MARKETING_STRATEGIST } from "../units/marketing/marketingStrategist";
import { BRAND_COMMUNICATIONS_STRATEGIST } from "../units/marketing/brandCommunicationsStrategist";
import { CONTENT_STRATEGIST } from "../units/marketing/contentStrategist";
import { CONTENT_MANAGER } from "../units/marketing/contentManager";
import { DIGITAL_MARKETER } from "../units/marketing/digitalMarketer";

/**
 * Canonical Hat registration/discovery — the metadata needed to locate
 * and select a Hat. This file's one responsibility: name every active
 * Hat once, and expose the data needed to pick between them. It does not
 * contain execution lifecycle logic — see executionEngine.ts for the
 * mechanics that run once a Marketing Hat has been selected.
 *
 * The implementations themselves live in their Unit/Specialization
 * directory under src/units/ (this file only references and aggregates
 * them, never duplicates their logic).
 *
 * Sales Executive and the Finance Value-Based Pricing Assessor fetch
 * their Hat Definition live from Notion at runtime (see governance.ts)
 * and have no code-native owns/doesNotOwn data — they're registered here
 * as plain identity records for discovery/completeness, exactly matching
 * what already exists about them in code today. Nothing about how
 * router.ts or session.ts invoke them changes: this registry does not
 * become a new authority layer for Sales/Finance, it only names them.
 */

export interface HatIdentity {
  name: string;
  unit: string;
  specialization?: string;
}

// Specialization values match the current canonical Notion routing table
// (ENIG - Sales Project Instructions' routing.incoming_enquiry/
// routing.proactive_lead_discovery blocks) exactly -- Sales Progression and
// Lead Discovery are the two specializations the Sales workspace routes to,
// each owned by its own Hat below.
export const SALES_EXECUTIVE: HatIdentity = { name: "Sales Executive", unit: "Sales", specialization: "Sales Progression" };
// Distinct from Sales Executive: runs in the shared Worker (not isolated),
// closed-context, and only ever produces Lead records -- never an Entity,
// never a qualification, never a proposal/quote. See leadDiscovery.ts.
export const LEAD_GENERATION_SPECIALIST: HatIdentity = { name: "Lead Generation Specialist", unit: "Sales", specialization: "Lead Discovery" };
export const VALUE_BASED_PRICING_ASSESSOR: HatIdentity = { name: "Value-Based Pricing Assessor", unit: "Finance" };
export const RESEARCH_INTELLIGENCE_ANALYST: HatIdentity = {
  name: "Research & Intelligence Analyst",
  unit: "Research & Intelligence",
  specialization: "Research Intelligence",
};

export const MARKETING_HAT_REGISTRY: Record<MarketingHatName, MarketingHatDefinition> = {
  "Marketing Strategist": MARKETING_STRATEGIST,
  "Brand & Communications Strategist": BRAND_COMMUNICATIONS_STRATEGIST,
  "Content Strategist": CONTENT_STRATEGIST,
  "Content Manager": CONTENT_MANAGER,
  "Digital Marketer": DIGITAL_MARKETER,
};

export const MARKETING_HAT_NAMES = Object.keys(MARKETING_HAT_REGISTRY) as MarketingHatName[];

/** One canonical registration per active Hat, across every Unit. */
export const ALL_HATS: HatIdentity[] = [
  SALES_EXECUTIVE,
  LEAD_GENERATION_SPECIALIST,
  VALUE_BASED_PRICING_ASSESSOR,
  RESEARCH_INTELLIGENCE_ANALYST,
  ...MARKETING_HAT_NAMES.map((name) => MARKETING_HAT_REGISTRY[name] as HatIdentity),
];

export function isMarketingHat(hat?: string): hat is MarketingHatName {
  return typeof hat === "string" && (MARKETING_HAT_NAMES as string[]).includes(hat);
}

/** Short, flat summary of every Marketing Hat — used for intake classification, never the full per-Hat detail. */
export function marketingHatSummaryList(): string {
  return MARKETING_HAT_NAMES.map((name) => `- ${name}: ${MARKETING_HAT_REGISTRY[name].purpose}`).join("\n");
}
