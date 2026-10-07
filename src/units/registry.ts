import type { Unit } from "../types";
import { validateHatManifest, type UnitManifest } from "./unitManifest";
import { businessDevelopmentManifest } from "./businessDevelopment/businessDevelopmentManifest";
import { salesManifest } from "./sales/salesManifest";
import { marketingManifest } from "./marketing/marketingManifest";
import { strategyManifest } from "./strategy/strategyManifest";
import { financeManifest } from "./finance/financeManifest";

/**
 * The Unit Registry (ENIG Operating Model design doc, "The Unit
 * Registry") -- statically imports every manifest-based Unit into one
 * lookup table. This is the one file that changes when a manifest-based
 * Unit is added or removed: one import, one entry. Cloudflare Workers
 * has no runtime filesystem, so this cannot be literal auto-discovery.
 *
 * Only Units actually built on the manifest pattern appear here. Every
 * Unit except Creative & Design and Operations (both undefined -- see the
 * design doc's rollout order) is registered now, but several only
 * partially:
 *
 * - Business Development -- fully migrated: all three Hats, every
 *   chokepoint (entryHandler/readHandler/awaitingHandlers/
 *   callbackHandlers) genuinely wired, no hardcoded BD case remains
 *   anywhere in session.ts.
 * - Sales -- see salesManifest.ts's own doc comment: both Lead Generation
 *   Specialist and Sales Executive are declared (Sales Executive is a
 *   thin wrap around handleIncomingEnquiry, unchanged); LGS's /lead
 *   command and cron-triggered discovery deliberately stay outside the
 *   manifest (see docs/enig-operating-model.md's Open questions).
 * - Marketing -- see marketingManifest.ts's own doc comment: fully
 *   migrated, all five Hats, every chokepoint including all three
 *   approval-callback prefixes. Stage 1/2 Hat resolution stays in
 *   src/hats/executionEngine.ts's own classifyCandidateHats +
 *   relationship-based tie-breaking, which has no equivalent in this
 *   registry's generic resolveHat -- registering marketingManifest here
 *   is for discoverability/consistency and its callbackHandlers'
 *   genuine dispatch, not because dispatchCowork's Marketing branch
 *   (still its own hardcoded branch, unchanged) ever calls
 *   findUnitManifest("Marketing") for Hat resolution itself.
 * - Strategy, Finance -- each a single-Hat Unit, same thin-wrap shape: one
 *   declared action wrapping handleDirectRequest unchanged, plus that one
 *   approval-callback prefix (strategyhandoff/quote respectively).
 *   handlePickup (Handoff-originated) stays entirely outside each manifest
 *   for both -- its Handoff-specific context construction has no
 *   equivalent in handleDirectRequest's free-text Matter-token resolution,
 *   so folding it into the same declared action would be semantically
 *   wrong, not just inconvenient. See each manifest's own doc comment.
 *
 * A Partial<Record<...>> lookup, not a total one, reflects that Creative
 * & Design and Operations simply don't exist yet.
 *
 * WHY THE TABLE IS BUILT LAZILY (do not "simplify" this back to a top-level
 * object literal):
 *
 * There is a genuine cycle here. src/access.ts is the enforcement boundary and
 * must resolve a Work's Action against the real registry rather than believing
 * the caller -- so access.ts imports this module. Every Unit's manifest in turn
 * builds its Access contexts by calling workSessionContext() /
 * mintApprovalProofForWork() from access.ts, so every manifest imports access.ts
 * too. That gives
 *
 *     access.ts -> registry.ts -> <each manifest> -> access.ts
 *
 * A top-level `export const UNIT_MANIFESTS = { Sales: salesManifest, ... }`
 * reads each manifest's binding during module evaluation. When the cycle is
 * entered from inside a manifest's own evaluation -- which is exactly what
 * happens when a manifest module, or anything that reaches one, is the entry
 * point (e.g. `tsx --test src/units/finance/financeManifest.test.ts`) -- the
 * manifest being read is still in its temporal dead zone and the load dies with
 * "Cannot access 'financeManifest' before initialization".
 *
 * Building the table on first lookup instead means nothing reads a manifest
 * binding until every module in the cycle has finished evaluating, so ESM's
 * live bindings resolve normally. The registry's contents are unchanged: it is
 * still these six statically imported manifests, and still the one place that
 * changes when a manifest-based Unit is added or removed.
 */
let manifestTable: Partial<Record<Unit, UnitManifest>> | undefined;

/**
 * Build a Unit registry table: run `validateHatManifest` over every Hat of
 * every Unit manifest once, and return the table only if all of them are
 * well-formed (WP8). On any defect this throws with the Unit, Hat and
 * message for each failing Hat, so a malformed manifest fails the test run
 * and the deploy gate (and, via `src/index.ts`'s module-scope
 * `getUnitManifests()` call, isolate boot) -- never a live request
 * mid-run.
 *
 * The real registry is built through here on first `getUnitManifests()`;
 * the registry validation test builds deliberately broken fixture tables
 * through here to prove the throw. Because the caller memoizes only a
 * returned table, a build that throws can never be cached -- every later
 * lookup re-raises instead of serving a bad registry.
 *
 * WHY THIS IS NOT IN registry.ts'S OWN MODULE BODY: reading a manifest
 * binding during this module's evaluation is exactly the TDZ hazard the
 * lazy table above exists to avoid (the `access.ts` cycle entered from a
 * manifest's own evaluation), so validation necessarily runs where the
 * table is assembled, not at this file's top level. `src/index.ts` -- the
 * Worker entry -- calls `getUnitManifests()` at module scope, which is
 * production's module load: validation runs before any request the
 * isolate ever serves.
 */
export function buildUnitRegistry(manifests: Partial<Record<Unit, UnitManifest>>): Partial<Record<Unit, UnitManifest>> {
  const defects: string[] = [];
  for (const [unit, manifest] of Object.entries(manifests)) {
    if (!manifest) continue;
    for (const [hatName, hat] of Object.entries(manifest.hats)) {
      const defect = validateHatManifest(hat);
      if (defect) defects.push(`Unit "${unit}", Hat "${hatName}": ${defect}`);
    }
  }
  if (defects.length > 0) {
    throw new Error(`Invalid Unit registry manifest(s):\n${defects.join("\n")}`);
  }
  return manifests;
}

/**
 * Every registered manifest, built on first access.
 *
 * Exported for discoverability and for registry-level assertions; prefer
 * findUnitManifest where a single Unit is wanted.
 */
export function getUnitManifests(): Partial<Record<Unit, UnitManifest>> {
  if (manifestTable === undefined) {
    manifestTable = buildUnitRegistry({
      "Business Development": businessDevelopmentManifest,
      Sales: salesManifest,
      Marketing: marketingManifest,
      Strategy: strategyManifest,
      Finance: financeManifest,
    });
  }
  return manifestTable;
}

export function findUnitManifest(unit: Unit): UnitManifest | undefined {
  return getUnitManifests()[unit];
}
