import test from "node:test";
import assert from "node:assert";
import { lightSearchSection } from "./lightSearchSkill";
import { buildResearchPlanPromptParts } from "./researchPlan";
import { buildSynthesisPromptParts } from "./researchRuntime";
import { verifySkillIntegrity } from "../../platform/skillRegistry";

// The Light Search method lives in the light_search Skill, not in the
// Research Runtime (Research Runtime decision, Martin 15 Nov 2026).

test("light_search is a registered Skill whose content matches its registered SHA-256", async () => {
  await assert.doesNotReject(() => verifySkillIntegrity("light_search"));
});

test("every section the Research Runtime reads exists, and a missing one fails closed", () => {
  for (const id of ["interpretation-relevance", "interpretation-selection", "plan-dimensions", "synthesis-output-contract", "synthesis-evidence-rule"]) {
    assert.ok(lightSearchSection(id).length > 50, id);
    assert.ok(!lightSearchSection(id).includes("\n## "), `${id} must not run into the next section`);
  }
  assert.throws(() => lightSearchSection("no-such-section"));
});

test("the assembled prompts carry the Skill's method text unchanged", () => {
  const plan = buildResearchPlanPromptParts("CATEGORY", "RELEVANCE", ["market_industry"]);
  assert.ok(plan.skillContent!.includes(lightSearchSection("plan-dimensions")));
  assert.ok(plan.skillContent!.includes("generate 2-4 specific research sub-questions"));
  const synth = buildSynthesisPromptParts("ROLE", "URC", ["market_industry"], true);
  assert.ok(synth.skillContent!.includes(lightSearchSection("synthesis-output-contract")));
  assert.ok(synth.skillContent!.includes(lightSearchSection("synthesis-evidence-rule")));
  // Machinery stays in the runtime: what web access the model has, and the response format.
  assert.ok(synth.skillContent!.includes("YOU ONLY HAVE THE LIVE WEB SEARCH RESULTS SUPPLIED BELOW"));
  assert.ok(synth.context!.includes("RESPONSE FORMAT"));
});
