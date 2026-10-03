import test from "node:test";
import assert from "node:assert";
import { resolveSkill } from "./skillRegistry";

/** The registry-resolved methodology body for a Skill -- the same content an Action's execution receives. */
const skillContent = (id: Parameters<typeof resolveSkill>[0]): string => resolveSkill(id).content;

/**
 * Covers the repo-native Skill model (migrated 2026-09-28 from the retired
 * Notion-backed SkillDefinition/SKILL_REGISTRY/getSkill arrangement -- see
 * skillRegistry.ts's own doc comment). The minimum contract is now just
 * id -> methodology content string, so these tests assert the content
 * itself, not registry metadata (pageId/sensitivity/requiredDataSources/
 * validation) that no longer exists because no runtime code ever read it.
 */

test("resolveSkill content: research_signal returns its own evidence-discipline methodology, distinct from the other two Skills", () => {
  const content = skillContent("research_signal");
  assert.match(content, /research-signal/);
  assert.match(content, /Only use evidence actually given/);
  assert.match(content, /Distinguish observation from diagnosis/);
});

test("resolveSkill content: opportunity_qualification_gate returns its own threshold-discipline methodology, distinct from research_signal", () => {
  const content = skillContent("opportunity_qualification_gate");
  assert.match(content, /opportunity-qualification-gate/);
  assert.match(content, /hold -- never infer/);
  assert.doesNotMatch(content, /observation from diagnosis/);
});

test("resolveSkill content: opportunity_forward_planning returns its own grounding-discipline methodology, distinct from the other two Skills", () => {
  const content = skillContent("opportunity_forward_planning");
  assert.match(content, /opportunity-forward-planning/);
  assert.match(content, /Build only from what's already established/);
  assert.doesNotMatch(content, /threshold discipline/);
});

test("resolveSkill content: every Skill's content is distinct (no accidental duplicate registration)", () => {
  const ids = ["research_signal", "opportunity_qualification_gate", "opportunity_forward_planning"] as const;
  const contents = ids.map((id) => skillContent(id));
  assert.strictEqual(new Set(contents).size, contents.length, "every Skill must resolve to distinct content");
});

test("resolveSkill content: is a plain synchronous lookup -- no Promise returned", () => {
  const result = skillContent("research_signal");
  assert.strictEqual(typeof result, "string");
});
