import test from "node:test";
import assert from "node:assert";
import {
  CURRENT_WORKER_RUNTIME,
  SKILL_IDS,
  SUPPORTED_SKILL_PACKAGE_FORMAT,
  SkillResolutionError,
  getSkillPackage,
  resolveSkill,
  verifySkillIntegrity,
} from "./skillRegistry";

/** The registry-resolved methodology body for a Skill -- the same content an Action's execution receives. */
const skillContent = (id: Parameters<typeof resolveSkill>[0]): string => resolveSkill(id).content;

/**
 * Covers the repo-native Skill model (migrated 2026-09-28 from the retired
 * Notion-backed SkillDefinition/SKILL_REGISTRY/getSkill arrangement -- see
 * skillRegistry.ts's own doc comment). The minimum contract is now just
 * id -> methodology content string, so these tests assert the content
 * itself, not registry metadata (pageId/sensitivity/requiredDataSources/
 * validation) that no longer exists because no runtime code ever read it.
 *
 * The package-resolution conformance tests at the bottom of this file cover
 * the OTHER registered metadata that DOES still exist and is load-bearing
 * -- the SkillPackage descriptor (version/status/workerRuntime/format/
 * integritySha256) resolveSkill validates fail-closed before any methodology
 * may be followed.
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

// --- package-resolution conformance (exact Skill resolution, fail-closed) ----
//
// The content tests above cover the methodology body; these cover the OTHER
// half of resolveSkill's contract -- the package descriptor validation
// (format -> status -> runtime, plus integrity) that decides whether a
// registered Skill may be followed at all. getSkillPackage returns the live
// registered descriptor, which is what lets these tests exercise each
// refusal branch without adding a test-only injection point to production
// code; every mutation is restored in a finally block so the registry's real
// state is untouched for every later test in this file and in the suite.

test("Skill conformance: every registered package resolves positively -- exact id, registered version, active status, current Worker runtime, supported format, and a passing integrity check", async () => {
  for (const id of SKILL_IDS) {
    const pkg = getSkillPackage(id);
    assert.strictEqual(pkg.status, "active", `${id} must be registered active`);
    assert.strictEqual(pkg.workerRuntime, CURRENT_WORKER_RUNTIME, `${id} must be approved for this Worker runtime`);
    assert.strictEqual(pkg.format, SUPPORTED_SKILL_PACKAGE_FORMAT, `${id} must use the supported package format`);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `${id} must carry a real semantic version, never a placeholder`);

    const resolved = resolveSkill(id);
    assert.strictEqual(resolved.id, id, "resolution is exact -- no substitution of another Skill");
    assert.strictEqual(resolved.version, pkg.version, "the resolved version must be the registered one, never fabricated");
    assert.strictEqual(typeof resolved.content, "string");
    await verifySkillIntegrity(id);
  }
});

test("Skill conformance: a Skill id outside the closed registry fails closed -- no closest-match, no substituted methodology", () => {
  assert.throws(() => resolveSkill("market_research_playbook" as any), SkillResolutionError);
  assert.throws(() => resolveSkill("" as any), SkillResolutionError);
});

test("Skill conformance: a non-active (retired/draft) Skill is refused instead of silently resolved", () => {
  const pkg = getSkillPackage("research_signal") as { status: string };
  const original = pkg.status;
  try {
    for (const status of ["retired", "draft"]) {
      pkg.status = status;
      assert.throws(() => resolveSkill("research_signal"), new RegExp(`is ${status}, not active`), `a ${status} Skill must not resolve`);
    }
  } finally {
    pkg.status = original;
  }
});

test("Skill conformance: a package approved for a different Worker runtime is refused -- no silent downgrade to an unapproved runtime", () => {
  const pkg = getSkillPackage("research_signal") as { workerRuntime: string };
  const original = pkg.workerRuntime;
  try {
    pkg.workerRuntime = "enig-worker-v0";
    assert.throws(() => resolveSkill("research_signal"), /approved for Worker runtime/);
  } finally {
    pkg.workerRuntime = original;
  }
});

test("Skill conformance: an unsupported package format is refused", () => {
  const pkg = getSkillPackage("research_signal") as { format: string };
  const original = pkg.format;
  try {
    pkg.format = "enig-skill-legacy-v0";
    assert.throws(() => resolveSkill("research_signal"), /unsupported package format/);
  } finally {
    pkg.format = original;
  }
});

test("Skill conformance: integrity verification passes for the real registry and refuses when the registered digest no longer matches the content", async () => {
  const pkg = getSkillPackage("research_signal") as { integritySha256: string };
  const original = pkg.integritySha256;
  try {
    await verifySkillIntegrity("research_signal");
    pkg.integritySha256 = "0".repeat(64);
    await assert.rejects(() => verifySkillIntegrity("research_signal"), /integrity failed/);
  } finally {
    pkg.integritySha256 = original;
  }
  await verifySkillIntegrity("research_signal");
});

test("Skill conformance: a package with no registered integrity digest is refused -- never verified by assumption", async () => {
  const pkg = getSkillPackage("research_signal") as { integritySha256: string };
  const original = pkg.integritySha256;
  try {
    pkg.integritySha256 = "";
    await assert.rejects(() => verifySkillIntegrity("research_signal"), /no registered integrity digest/);
  } finally {
    pkg.integritySha256 = original;
  }
});
