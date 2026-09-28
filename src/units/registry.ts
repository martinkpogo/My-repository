import type { Unit } from "../types";
import type { UnitManifest } from "./unitManifest";
import { businessDevelopmentManifest } from "./businessDevelopment/businessDevelopmentManifest";
import { salesManifest } from "./sales/salesManifest";
import { marketingManifest } from "./marketing/marketingManifest";
import { strategyManifest } from "./strategy/strategyManifest";
import { researchManifest } from "./research/researchManifest";
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
 * - Strategy, Research & Intelligence, Finance -- each a single-Hat Unit,
 *   same thin-wrap shape: one declared action wrapping handleDirectRequest
 *   unchanged, plus that one approval-callback prefix
 *   (strategyhandoff/researchhandoff/quote respectively). handlePickup
 *   (Handoff-originated) stays entirely outside each manifest for all
 *   three -- its Handoff-specific context construction has no equivalent
 *   in handleDirectRequest's free-text Matter-token resolution, so
 *   folding it into the same declared action would be semantically
 *   wrong, not just inconvenient. See each manifest's own doc comment.
 *
 * A Partial<Record<...>> lookup, not a total one, reflects that Creative
 * & Design and Operations simply don't exist yet.
 */
export const UNIT_MANIFESTS: Partial<Record<Unit, UnitManifest>> = {
  "Business Development": businessDevelopmentManifest,
  Sales: salesManifest,
  Marketing: marketingManifest,
  Strategy: strategyManifest,
  "Research & Intelligence": researchManifest,
  Finance: financeManifest,
};

export function findUnitManifest(unit: Unit): UnitManifest | undefined {
  return UNIT_MANIFESTS[unit];
}
