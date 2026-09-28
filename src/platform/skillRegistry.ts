import type { SensitivityLevel } from "../dataBoundary/types";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../governance";

/**
 * The Skill Registry (ENIG Operating Model design doc, "Platform layer"
 * -- Stage 1 of the confirmed build order). A catalog of skill id ->
 * Notion page id -> eligible sensitivity tier, loaded through the
 * existing `getGovernance` (live-fetched, cached, fail-closed). A
 * pipeline calls `fetch_skill` by id (see primitives.ts); shared skills
 * stop needing duplicate copies across Units.
 *
 * Deliberately seeded with only the Universal Role Contract for now --
 * per Migration path Step 2 (Business Development as the first Unit
 * migrated onto the Platform layer), BD's own Hat-specific methodology
 * content gets registered here as real Notion skill pages are created
 * for it, not invented speculatively ahead of that real migration.
 */
export type SkillId = "universal_role_contract";

export interface SkillDefinition {
  id: SkillId;
  pageId: string;
  /**
   * Sensitivity floor for including this skill's content in a generate()
   * prompt -- advisory metadata for whoever builds a pipeline. The actual
   * enforced gate is generate()'s own SemanticTaskId classification, not
   * this field; it exists so a pipeline author can see at a glance
   * whether a skill is safe to combine with a given task's sensitivity
   * without having to open the Notion page first.
   */
  sensitivity: SensitivityLevel;
  description: string;
}

export const SKILL_REGISTRY: Readonly<Record<SkillId, SkillDefinition>> = {
  universal_role_contract: {
    id: "universal_role_contract",
    pageId: UNIVERSAL_ROLE_CONTRACT_PAGE_ID,
    sensitivity: "business_sensitive",
    description: "Kernel document -- applies automatically to every Hat in every Unit (evidence rule, authority, stop conditions).",
  },
};

export function getSkill(id: SkillId): SkillDefinition {
  const skill = SKILL_REGISTRY[id];
  if (!skill) {
    throw new Error(`getSkill: "${id}" is not a registered skill.`);
  }
  return skill;
}
