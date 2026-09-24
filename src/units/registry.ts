import type { Unit } from "../types";
import type { UnitManifest } from "./unitManifest";
import { businessDevelopmentManifest } from "./businessDevelopment/businessDevelopmentManifest";

/**
 * The Unit Registry (ENIG Operating Model design doc, "The Unit
 * Registry") -- statically imports every manifest-based Unit into one
 * lookup table. This is the one file that changes when a manifest-based
 * Unit is added or removed: one import, one entry. Cloudflare Workers
 * has no runtime filesystem, so this cannot be literal auto-discovery.
 *
 * Only Units actually built on the manifest pattern appear here.
 * Sales/Marketing/Strategy/Finance/R&I are NOT registered -- they
 * continue running through their existing hand-written dispatchCowork
 * branches/WorkSession methods/handleTextReply switch cases, per the
 * design doc's staged rollout (new Units first, migrate existing ones
 * only once the pattern is proven). A Partial<Record<...>> lookup, not a
 * total one, reflects that directly: most Units simply aren't here yet.
 */
export const UNIT_MANIFESTS: Partial<Record<Unit, UnitManifest>> = {
  "Business Development": businessDevelopmentManifest,
};

export function findUnitManifest(unit: Unit): UnitManifest | undefined {
  return UNIT_MANIFESTS[unit];
}
