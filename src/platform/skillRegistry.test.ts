import test from "node:test";
import assert from "node:assert";
import { getSkill, SKILL_REGISTRY } from "./skillRegistry";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../governance";

const RESEARCH_SIGNAL_PAGE_ID = "3e9cb004-e583-81cb-8e42-fcdbc8ca1201";

test("getSkill: an unregistered id fails closed with a clear error", () => {
  assert.throws(() => getSkill("nonexistent" as any), /not a registered skill/);
});

test("getSkill: universal_role_contract resolves to governance.ts's canonical page id", () => {
  const skill = getSkill("universal_role_contract");
  assert.strictEqual(skill.pageId, UNIVERSAL_ROLE_CONTRACT_PAGE_ID);
});

test("Every registered skill declares a non-empty description, sensitivity, and output contract", () => {
  for (const id of Object.keys(SKILL_REGISTRY) as (keyof typeof SKILL_REGISTRY)[]) {
    const skill = SKILL_REGISTRY[id];
    assert.ok(skill.description.trim().length > 0, `${id} must have a description`);
    assert.ok(skill.sensitivity, `${id} must declare a sensitivity tier`);
    assert.ok(skill.outputContract.trim().length > 0, `${id} must declare an output contract`);
  }
});

test("getSkill: research_signal resolves to its own real Notion page, distinct from universal_role_contract", () => {
  const skill = getSkill("research_signal");
  assert.strictEqual(skill.pageId, RESEARCH_SIGNAL_PAGE_ID);
  assert.notStrictEqual(skill.pageId, UNIVERSAL_ROLE_CONTRACT_PAGE_ID);
});

test("research_signal declares no fixed Data Source -- evidence provenance is caller-supplied, never a Skill-level access grant", () => {
  const skill = getSkill("research_signal");
  assert.deepStrictEqual(skill.requiredDataSources, []);
});

test("research_signal declares its evidence-discipline invariants as named validation rules, not free prose", () => {
  const skill = getSkill("research_signal");
  assert.ok(skill.validation && skill.validation.length >= 4, "research_signal must declare its core evidence-discipline invariants");
  assert.ok(skill.validation!.includes("never_fabricate_a_specific_fact"));
  assert.ok(skill.validation!.includes("distinguish_observation_from_diagnosis"));
});
