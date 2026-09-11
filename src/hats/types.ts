/**
 * Shared Hat types — specifically the code-native Marketing Hat shape.
 * Sales Executive and the Finance Value-Based Pricing Assessor have no
 * equivalent type here: their Hat Definitions are fetched live from
 * Notion at runtime (see governance.ts), not represented as code data.
 */

export type MarketingHatName =
  | "Marketing Strategist"
  | "Brand & Communications Strategist"
  | "Content Strategist"
  | "Content Manager"
  | "Digital Marketer";

/**
 * Preserves the conceptual hierarchy Unit -> Specialization -> Hat (per
 * Notion's Core Structure: every Hat's required_fields include both unit
 * and specialization) as explicit fields, matching the shape of the
 * canonical Hat Definition pages these were transcribed from.
 */
export interface MarketingHatDefinition {
  name: MarketingHatName;
  unit: "SM&BD";
  specialization: "Marketing";
  purpose: string;
  owns: string[];
  doesNotOwn: string[];
  /** Code-enforced allow-list of Hats this Hat may propose a transition to. */
  routesTo: MarketingHatName[];
}
