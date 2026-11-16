import type { UnitManifest } from "../units/unitManifest";

/**
 * Test fixture: the Result contract (BD-8) a Unit's own manifest declares for
 * an Action -- read from the manifest, never written by hand -- so a fixture
 * that needs a satisfied review installs exactly the expectedResult and
 * completionCriteria production loads live. Throws when the declaration is
 * absent, so a manifest that drops its contract fails these tests loudly
 * instead of silently passing a gate that has nothing to enforce.
 */
export function declaredResultContract(
  manifest: UnitManifest,
  actionName: string,
): { expectedResult: string; completionCriteria: readonly string[] } {
  for (const hat of Object.values(manifest.hats)) {
    const action = hat.actions.find((a) => a.name === actionName);
    if (action) {
      if (!action.expectedResult?.trim() || !action.completionCriteria?.length) {
        throw new Error(`${manifest.unit}/${hat.name}/${actionName} declares no BD-8 Result contract (expectedResult + completionCriteria)`);
      }
      return { expectedResult: action.expectedResult, completionCriteria: action.completionCriteria };
    }
  }
  throw new Error(`${manifest.unit} declares no Action named "${actionName}" anywhere on its manifest`);
}
