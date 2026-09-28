import type { SensitivityLevel } from "../dataBoundary/types";
import type { DataSourceId } from "./dataSourceRegistry";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../governance";

/**
 * The Skill Registry (ENIG Operating Model design doc, "Platform layer"
 * -- Stage 1 of the confirmed build order). A catalog of skill id ->
 * Notion page id -> eligible sensitivity tier, loaded through the
 * existing `getGovernance` (live-fetched, cached, fail-closed). A
 * pipeline calls `fetch_skill` by id (see primitives.ts); shared skills
 * stop needing duplicate copies across Units.
 *
 * Extended for the `research-signal` proof (Build order Step 2, Skills
 * architecture assessment) with the structured half of a Skill
 * Definition -- required primitives, an output-contract note, and named
 * validation rules -- so a Skill declares its own shape without becoming
 * a live interpreter. A Skill's structured fields here are documentation
 * and a typed contract two Hat pipelines can both be checked against;
 * they do not make this registry a dynamic executor (see the design
 * doc's "confirmed shape instead: primitives as a shared function
 * library, pipelines as ordinary code" -- unchanged by this extension).
 * A Skill never declares authority, Data Source *access* (only, where
 * relevant, which kind of Data Source its methodology expects to be
 * handed -- resolved fresh per invoking Hat, never by the Skill itself;
 * see primitives.ts's fresh-per-call resolution invariant), consequence
 * level, or approval requirement -- those remain the invoking Action's
 * own declared properties, per the OS-analogy review's Persona/Skill
 * separation.
 */
export type SkillId = "universal_role_contract" | "research_signal";

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
  /**
   * The kind(s) of Data Source this Skill's methodology expects to be
   * handed as evidence, if any are fixed -- documentation only, never an
   * access grant (Data Source eligibility is resolved by the Kernel per
   * invoking Hat before this methodology is ever applied). Empty when a
   * Skill is deliberately evidence-source-agnostic -- e.g. `research-signal`
   * is invoked by Hats supplying genuinely different kinds of evidence
   * (Martin's own request text, web search results), so declaring a fixed
   * source here would be false precision.
   */
  requiredDataSources?: readonly DataSourceId[];
  /** The primitive(s) a pipeline typically composes to use this Skill -- documentation only, never enforced here (dispatchAction/the primitives themselves remain the actual enforcement). */
  requiredPrimitives?: readonly PrimitiveName[];
  /**
   * What this Skill's methodology governs about the output, distinct from
   * the output's actual shape -- the shape (a JSON schema, a specific
   * field set) is the invoking action's own instruction, supplied
   * alongside this Skill's fetched content as that call's `situation`,
   * never duplicated or hardcoded here.
   */
  outputContract: string;
  /** Named invariants this Skill's methodology enforces -- a short, reviewable list, not free prose duplicating the Notion page's own content. */
  validation?: readonly string[];
}

export type PrimitiveName = "read_record" | "fetch_skill" | "search" | "generate" | "request_approval" | "write_record";

export const SKILL_REGISTRY: Readonly<Record<SkillId, SkillDefinition>> = {
  universal_role_contract: {
    id: "universal_role_contract",
    pageId: UNIVERSAL_ROLE_CONTRACT_PAGE_ID,
    sensitivity: "business_sensitive",
    description: "Kernel document -- applies automatically to every Hat in every Unit (evidence rule, authority, stop conditions).",
    requiredPrimitives: ["fetch_skill"],
    outputContract: "Cross-cutting behavioral rules injected into every persona's prompt as generate()'s `behavior` part, never as `skillContent` -- this is the one Skill every pipeline fetches for that role, not a task-specific methodology.",
  },
  /**
   * research-signal (Notion: ENIG HQ / 4. Skills / research-signal,
   * https://app.notion.com/p/3e9cb004e58381cb8e42fcdbc8ca1201) -- the
   * first Skill built to prove genuine cross-Hat reuse per the OS-analogy
   * review's own five-part test. Its methodology (only use evidence
   * actually given; distinguish observation from diagnosis; never
   * fabricate a specific fact; name gaps rather than guess them;
   * attribute honestly; a confident tone is not evidence) is the shared
   * discipline behind Business Development Opportunity Development's
   * `discover_opportunity`/`research_opportunity` (evidence supplied
   * directly in Martin's own request text, no external search) and
   * Sales's Lead Generation Specialist `evaluateCandidates` (evidence
   * supplied as public web search results). Deliberately does NOT declare
   * a fixed requiredDataSources -- the two Hats supply genuinely
   * different kinds of evidence, and forcing one here would misrepresent
   * what the methodology actually requires (evidence, of whatever
   * provenance the invoking Hat is authorized to gather).
   */
  research_signal: {
    id: "research_signal",
    pageId: "3e9cb004-e583-81cb-8e42-fcdbc8ca1201",
    sensitivity: "business_sensitive",
    description: "Interpret raw evidence about an external subject with a disciplined observation-vs-diagnosis distinction -- never fabricating a fact the evidence doesn't contain. Reused across Business Development's Opportunity Development and Sales's Lead Generation Specialist, each supplying different evidence under different authority.",
    requiredDataSources: [],
    requiredPrimitives: ["fetch_skill", "generate"],
    outputContract: "Governed by the invoking action's own instruction (its own JSON schema or structured output description), supplied as that call's `situation` -- this Skill's methodology constrains how that output is derived from evidence, never its shape.",
    validation: [
      "only_use_evidence_actually_given",
      "distinguish_observation_from_diagnosis",
      "never_fabricate_a_specific_fact",
      "name_gaps_rather_than_guess_them",
      "attribute_claims_honestly",
      "confident_tone_is_not_evidence",
    ],
  },
};

export function getSkill(id: SkillId): SkillDefinition {
  const skill = SKILL_REGISTRY[id];
  if (!skill) {
    throw new Error(`getSkill: "${id}" is not a registered skill.`);
  }
  return skill;
}
