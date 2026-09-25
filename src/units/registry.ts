import type { Unit } from "../types";
import type { UnitManifest } from "./unitManifest";
import { businessDevelopmentManifest } from "./businessDevelopment/businessDevelopmentManifest";
import { salesManifest } from "./sales/salesManifest";
import { marketingManifest } from "./marketing/marketingManifest";

/**
 * The Unit Registry (ENIG Operating Model design doc, "The Unit
 * Registry") -- statically imports every manifest-based Unit into one
 * lookup table. This is the one file that changes when a manifest-based
 * Unit is added or removed: one import, one entry. Cloudflare Workers
 * has no runtime filesystem, so this cannot be literal auto-discovery.
 *
 * Only Units actually built on the manifest pattern appear here.
 * Strategy/Finance/R&I are NOT registered -- they continue running
 * through their existing hand-written dispatchCowork branches/WorkSession
 * methods/handleTextReply switch cases, per the design doc's staged
 * rollout (new Units first, migrate existing ones only once the pattern
 * is proven). Sales and Marketing ARE registered, but only partially:
 *
 * - Sales -- see salesManifest.ts's own doc comment: it declares Lead
 *   Generation Specialist only, never Sales Executive, which stays on its
 *   own live-Notion-fetched pattern.
 * - Marketing -- see marketingManifest.ts's own doc comment: it covers
 *   only post-Hat-resolution execution (the declared "handle_request"
 *   action each of its 5 Hats runs once a Hat is already known). Stage
 *   1/2 Hat resolution stays in src/hats/executionEngine.ts's own
 *   classifyCandidateHats + relationship-based tie-breaking, which has no
 *   equivalent in this registry's generic resolveHat -- registering
 *   marketingManifest here is for discoverability/consistency, not
 *   because dispatchCowork's Marketing branch (still its own hardcoded
 *   branch, unchanged) ever calls findUnitManifest("Marketing") itself.
 *
 * A Partial<Record<...>> lookup, not a total one, reflects that most
 * Units (and parts of Sales/Marketing) simply aren't here yet.
 */
export const UNIT_MANIFESTS: Partial<Record<Unit, UnitManifest>> = {
  "Business Development": businessDevelopmentManifest,
  Sales: salesManifest,
  Marketing: marketingManifest,
};

export function findUnitManifest(unit: Unit): UnitManifest | undefined {
  return UNIT_MANIFESTS[unit];
}
