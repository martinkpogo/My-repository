/**
 * Shared Hat types — specifically the code-native Marketing Hat shape.
 * Sales Executive and the Finance Value-Based Pricing Assessor have no
 * equivalent type here: their Hat Definitions are fetched live from
 * Notion at runtime (see governance.ts), not represented as code data.
 */

export type MarketingHatName =
  | "Marketing Strategist"
  | "Campaign & Marketing Communications Manager"
  | "Content Strategist"
  | "Content Manager"
  | "Digital Marketer";

/**
 * A Hat's usual next step: which Hat usually does the next part, and what for.
 *
 * This is guidance, not a rigid process. A Hat does its own part of what
 * Martin asked for now and suggests the next step after he approves; it only
 * hands on the whole request when the request is wholly another Hat's work.
 * The target and its purpose travel together so the model knows what the next
 * Hat is for instead of guessing from a bare name.
 *
 * Generic on purpose: every Unit's Hat definition can carry one of these.
 * Marketing is the first to declare them in code; other Units can follow.
 */
export interface HatHandover<H extends string = string> {
  /** The Hat that usually does the next part. */
  toHat: H;
  /** What that Hat usually does with it, phrased so it reads after "to ...". */
  forWhat: string;
}

/**
 * Preserves the conceptual hierarchy Unit -> Specialization -> Hat (per
 * Notion's Core Structure: every Hat's required_fields include both unit
 * and specialization) as explicit fields, matching the shape of the
 * canonical Hat Definition pages these were transcribed from.
 */
export interface MarketingHatDefinition {
  name: MarketingHatName;
  unit: "Marketing";
  specialization: "Marketing";
  purpose: string;
  owns: string[];
  doesNotOwn: string[];
  /**
   * The Hats this Hat usually hands the next part to, and what for. Replaces
   * the former bare `routesTo` name list: the target and its purpose travel
   * together. A usual next step, not a required process -- and the authorized
   * routing targets for a whole-request handoff are exactly these Hats.
   */
  handsOverTo: HatHandover<MarketingHatName>[];
}
