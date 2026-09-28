import test from "node:test";
import assert from "node:assert";
import { getSkill, SKILL_REGISTRY } from "./skillRegistry";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../governance";

test("getSkill: an unregistered id fails closed with a clear error", () => {
  assert.throws(() => getSkill("nonexistent" as any), /not a registered skill/);
});

test("getSkill: universal_role_contract resolves to governance.ts's canonical page id", () => {
  const skill = getSkill("universal_role_contract");
  assert.strictEqual(skill.pageId, UNIVERSAL_ROLE_CONTRACT_PAGE_ID);
});

test("Every registered skill declares a non-empty description and sensitivity", () => {
  for (const id of Object.keys(SKILL_REGISTRY) as (keyof typeof SKILL_REGISTRY)[]) {
    const skill = SKILL_REGISTRY[id];
    assert.ok(skill.description.trim().length > 0, `${id} must have a description`);
    assert.ok(skill.sensitivity, `${id} must declare a sensitivity tier`);
  }
});
