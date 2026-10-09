/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";

import { resolveOrganization, type OrganizationContext } from "./organization";
import { resolveActionExecution } from "./actionResolution";
import { workContractForRequest, type WorkContract, type WorkRequest } from "./workContract";
import type { ActionDefinition } from "../hats/actionRegistry";
import type { HatManifest, UnitManifest } from "../units/unitManifest";
import { validateHatManifest } from "../units/unitManifest";
import { findUnitManifest, getUnitManifests } from "../units/registry";
import { resolveSkill, type SkillId } from "../platform/skillRegistry";

/**
 * Resolution-boundary tests (ENIG Operating Model, §16: Organization
 * determinism + fail-closed; Action Resolution exactly-one / zero /
 * multiple / precedence / Responsibility mismatch / undeclared; Skills
 * exact / missing / invalid / undeclared; the resolved Action Execution
 * Context the Worker consumes; and the Handoff destination as a fact).
 *
 * Everything here runs against the real resolvers -- no AI provider call is
 * ever permitted (the network guard below makes any provider attempt an
 * immediate test failure), which is the structural proof that neither
 * boundary can classify, rank, or "confidently pick" anything.
 */

const DUTY = "toy_responsibility";

function makeAction(name: string, extra: Partial<ActionDefinition<string>> = {}): ActionDefinition<string> {
  return {
    name,
    responsibility: DUTY,
    consequence: "internal",
    requiresApproval: false,
    applicability: {
      mode: "all",
      conditions: [{ source: "work", field: "origin", operator: "equals", value: "direct_request" }],
    },
    description: `Toy action ${name}.`,
    ...extra,
  };
}

function makeHat(name: string, actions: ActionDefinition<string>[], responsibilityId = DUTY): HatManifest<string> {
  return {
    name,
    responsibility: "Handles toy work for this test.",
    responsibilityId,
    actions,
    readHandler: async (_env, actionName) => `handled:${actionName}`,
    entryHandler: async (_env, state) => state,
    awaitingHandlers: {},
  };
}

function makeManifest(hats: Record<string, HatManifest<string>>): UnitManifest {
  return {
    unit: "Business Development",
    hats,
    intakeClassificationTaskId: "business_development.intake_classification",
    intakeIntroLine: "You route incoming toy requests.",
    actionClassificationTaskId: "business_development.hat_action_decision",
  };
}

function contractFor(
  context: Partial<WorkRequest["current_context"]> = {},
  requested_outcome = "do the toy thing",
): WorkContract {
  return workContractForRequest({
    requested_outcome,
    current_context: { mode: "cowork", origin: "direct_request", ...context },
  });
}

function orgFor(overrides: Partial<OrganizationContext> = {}): OrganizationContext {
  return {
    business_function: null,
    unit: "Business Development",
    specialization: null,
    hat: "Toy Hat",
    responsibility: DUTY,
    ...overrides,
  };
}

/** Any network access during a pure resolution is a test failure -- no provider may be consulted. */
function forbidNetwork(t: any) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    throw new Error(`network access during pure resolution: ${String(url)}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

// --- Organization resolution: determinism + fail-closed ---------------------

test("resolveOrganization: the same contract always produces the same Organization (deterministic)", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("one")]) });
  const contract = contractFor({ addressed_hat: "Toy Hat" });

  const first = resolveOrganization(contract, manifest);
  const second = resolveOrganization(contract, manifest);

  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.kind, "resolved");
});

test("resolveOrganization: a multi-Hat Unit addressed to none of its Hats fails closed instead of defaulting to one", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    Alpha: makeHat("Alpha", [makeAction("alpha_task")], "alpha_duty"),
    Beta: makeHat("Beta", [makeAction("beta_task")], "beta_duty"),
  });

  const result = resolveOrganization(contractFor({ interpreted_hats: [] }), manifest);

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "ambiguous_ownership");
});

test("resolveOrganization: an addressee naming a Hat the Unit does not declare fails closed with the canonical message", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("one")]) });

  const result = resolveOrganization(contractFor({ addressed_hat: "Ghost Hat" }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "unknown_hat");
  assert.strictEqual(result.detail, '"Ghost Hat" isn\'t a registered Business Development Hat.');
});

test("resolveOrganization: exactly one validated intake-interpretation candidate resolves -- and records that an interpretation was consulted", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    Alpha: makeHat("Alpha", [makeAction("alpha_task")], "alpha_duty"),
    Beta: makeHat("Beta", [makeAction("beta_task")], "beta_duty"),
  });

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Beta"] }), manifest);

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.organization.hat, "Beta");
  assert.strictEqual(result.evidence.resolved_from, "intake_interpretation");
  assert.strictEqual(result.evidence.interpretation_consulted, true);
});

test("resolveOrganization: two interpretation candidates fail closed -- a model's proposal never picks between them", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    Alpha: makeHat("Alpha", [makeAction("alpha_task")], "alpha_duty"),
    Beta: makeHat("Beta", [makeAction("beta_task")], "beta_duty"),
  });

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "ambiguous_ownership");
});

test("resolveOrganization: an interpretation naming a Hat the Unit does not declare is rejected, never substituted", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    Alpha: makeHat("Alpha", [makeAction("alpha_task")], "alpha_duty"),
    Beta: makeHat("Beta", [makeAction("beta_task")], "beta_duty"),
  });

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Ghost Hat"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "ambiguous_ownership");
});

test("resolveOrganization: a single-Hat Unit resolves structurally, with no interpretation consulted", (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("one")]) });

  const result = resolveOrganization(contractFor(), manifest);

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.organization.hat, "Toy Hat");
  assert.strictEqual(result.evidence.resolved_from, "single_hat_ownership");
  assert.strictEqual(result.evidence.interpretation_consulted, false);
});

test("resolveOrganization: no registered manifest fails closed -- resolution never invents an organizational context", (t) => {
  forbidNetwork(t);

  const result = resolveOrganization(contractFor({ addressed_unit: "Creative & Design" }), undefined);

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "missing_manifest");
});

test("resolveOrganization: every registered Unit resolves every one of its declared Hats by explicit address (manifest sweep)", (t) => {
  forbidNetwork(t);

  let hatsChecked = 0;
  for (const [unit, manifest] of Object.entries(getUnitManifests())) {
    assert.ok(manifest, `Unit ${unit} is registered without a manifest`);
    for (const hatName of Object.keys(manifest.hats)) {
      const result = resolveOrganization(contractFor({ addressed_unit: unit, addressed_hat: hatName }), manifest);
      assert.strictEqual(result.kind, "resolved", `${unit}/${hatName} must resolve by explicit address`);
      if (result.kind !== "resolved") continue;
      assert.strictEqual(result.organization.unit, unit);
      assert.strictEqual(result.organization.hat, hatName);
      assert.strictEqual(
        result.organization.responsibility,
        manifest.hats[hatName].responsibilityId,
        `${unit}/${hatName} must resolve to its own declared Responsibility`,
      );
      hatsChecked++;
    }
  }
  assert.ok(hatsChecked >= 10, `expected the sweep to cover every registered Hat (saw ${hatsChecked})`);
});

// --- Organization resolution: the Handoff destination is a fact -------------

test("resolveOrganization: a Handoff destination resolves as a fact -- no interpretation, no AI call, no default (Sales sweep)", (t) => {
  forbidNetwork(t);
  const manifest = findUnitManifest("Sales");
  assert.ok(manifest, "Sales must be registered");
  const salesHats = Object.keys(manifest.hats);
  assert.ok(salesHats.length > 1, "this test is only meaningful for a multi-Hat Unit");

  for (const hatName of salesHats) {
    const contract = contractFor({
      origin: "handoff_pickup",
      handoff: { handoffId: "handoff-1", toUnit: "Sales", toHat: hatName },
    });
    const result = resolveOrganization(contract, manifest);
    assert.strictEqual(result.kind, "resolved", `Handoff To Hat ${hatName} is a fact and must resolve`);
    if (result.kind !== "resolved") continue;
    assert.strictEqual(result.evidence.resolved_from, "handoff_destination");
    assert.strictEqual(result.evidence.interpretation_consulted, false);
    assert.strictEqual(result.organization.hat, hatName);
    assert.deepStrictEqual(result.evidence.evaluated.handoff_destination, {
      to_unit: "Sales",
      to_hat: hatName,
    });
  }
});

test("resolveOrganization: a Handoff that names no Hat for a multi-Hat Unit fails closed rather than guessing", (t) => {
  forbidNetwork(t);
  const manifest = findUnitManifest("Sales");
  assert.ok(manifest);

  const result = resolveOrganization(
    contractFor({ origin: "handoff_pickup", handoff: { handoffId: "handoff-2", toUnit: "Sales", toHat: null } }),
    manifest,
  );

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "ambiguous_ownership");
});

test("resolveOrganization: a Handoff destination naming an undeclared Hat cannot be redirected to another Hat", (t) => {
  forbidNetwork(t);
  const manifest = findUnitManifest("Sales");
  assert.ok(manifest);

  const result = resolveOrganization(
    contractFor({ origin: "handoff_pickup", handoff: { handoffId: "handoff-3", toUnit: "Sales", toHat: "Ghost Hat" } }),
    manifest,
  );

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "unknown_hat");
});

test("resolveOrganization: a Handoff addressed to a different Unit than the manifest fails closed (unit_mismatch)", (t) => {
  forbidNetwork(t);
  const manifest = findUnitManifest("Finance");
  assert.ok(manifest);

  const result = resolveOrganization(
    contractFor({ origin: "handoff_pickup", handoff: { handoffId: "handoff-4", toUnit: "Strategy", toHat: null } }),
    manifest,
  );

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "unit_mismatch");
});

// --- Action Resolution: exactly one, with auditable evidence ----------------

test("resolveActionExecution: exactly one context-applicable Action resolves, carrying complete auditable evidence", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [makeAction("only_task")]),
  });
  const organization = orgFor();

  const result = await resolveActionExecution(manifest, organization, contractFor());

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  const { execution } = result;
  assert.strictEqual(execution.action.action_id, "only_task");
  assert.strictEqual(execution.action.responsibility, DUTY);
  assert.strictEqual(execution.organization.hat, "Toy Hat");
  // Evidence shape (§11/§16): responsibility, manifest, manifest_version,
  // evaluated_conditions, results, precedence_used, resolved_action,
  // resolved_action_version -- all present, none invented.
  assert.strictEqual(execution.evidence.responsibility, DUTY);
  assert.deepStrictEqual(execution.evidence.manifest, { unit: "Business Development", hat: "Toy Hat" });
  assert.strictEqual(execution.evidence.manifest_version, null, "no canonical manifest version exists -- null, not invented");
  assert.strictEqual(execution.evidence.resolved_action, "only_task");
  assert.strictEqual(execution.evidence.resolved_action_version, null, "no canonical Action version exists -- null, not invented");
  assert.strictEqual(execution.evidence.precedence_used, null, "exactly-one resolution uses no precedence");
  assert.ok(execution.evidence.evaluated_conditions.length > 0, "every evaluated condition is recorded");
  const evaluated = execution.evidence.evaluated_conditions[0];
  assert.strictEqual(evaluated.action, "only_task");
  assert.strictEqual(evaluated.actual, "direct_request", "the actual value tested against is recorded");
  assert.strictEqual(evaluated.result, true);
  assert.deepStrictEqual(execution.evidence.results, { only_task: true });
});

test("resolveActionExecution: pure -- resolves with no AI/provider call of any kind (network guard)", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("only_task")]) });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "resolved", "resolution must succeed without any provider access");
});

test("resolveActionExecution: the same inputs always produce the same resolution (deterministic)", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("a_task"), makeAction("b_task")]) });
  const contract = contractFor();

  const first = await resolveActionExecution(manifest, orgFor(), contract);
  const second = await resolveActionExecution(manifest, orgFor(), contract);

  assert.deepStrictEqual(first, second);
});

test("resolveActionExecution: an interpretation naming an Action this Hat does not expose fails closed (undeclared_action)", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("known_task", {
        applicability: {
          mode: "any",
          conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "known_task" }],
        },
      }),
    ]),
  });
  const contract = contractFor({ requested_action: "invented_task" });

  const result = await resolveActionExecution(manifest, orgFor(), contract);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "undeclared_action");
  assert.match(result.detail, /invented_task/);
  assert.match(result.detail, /manifest-exposed Actions/);
});

test("resolveActionExecution: a requested_action that matches a declared condition exactly resolves it, and is recorded as input (never as authority)", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("known_task", {
        applicability: {
          mode: "any",
          conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "known_task" }],
        },
      }),
      makeAction("other_task", {
        applicability: {
          mode: "any",
          conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "other_task" }],
        },
      }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor({ requested_action: "known_task" }));

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.execution.action.action_id, "known_task");
  assert.strictEqual(result.execution.inputs.requested_action, "known_task", "the interpretation is recorded as an input");
});

// --- Action Resolution: fail-closed paths -----------------------------------

test("resolveActionExecution: zero applicable Actions fail closed (zero_applicable) -- never the first or closest Action", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("entry_task", {
        applicability: {
          mode: "all",
          conditions: [{ source: "work", field: "origin", operator: "equals", value: "handoff_pickup" }],
        },
      }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor({ origin: "direct_request" }));

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "zero_applicable");
  assert.match(result.detail, /fails closed rather than picking one/);
});

test("resolveActionExecution: context that cannot decide alone asks for an interpretation (need_interpretation) -- only when declared", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("named_task", {
        applicability: {
          mode: "any",
          conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "named_task" }],
        },
      }),
    ]),
  });

  const interpreted = await resolveActionExecution(manifest, orgFor(), contractFor());
  assert.strictEqual(interpreted.kind, "need_interpretation");

  // Without a requested_action condition, the same context is a plain
  // zero-applicable failure -- interpretation is never demanded when no
  // Action could ever name it.
  const structuralOnly = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("origin_task", {
        applicability: {
          mode: "all",
          conditions: [{ source: "work", field: "origin", operator: "equals", value: "handoff_pickup" }],
        },
      }),
    ]),
  });
  const failed = await resolveActionExecution(structuralOnly, orgFor(), contractFor());
  assert.strictEqual(failed.kind, "failed");
  assert.strictEqual(failed.kind === "failed" ? failed.reason : "", "zero_applicable");
});

test("resolveActionExecution: a failed interpretation (requested_action null) fails closed rather than asking again", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("named_task", {
        applicability: {
          mode: "any",
          conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "named_task" }],
        },
      }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor({ requested_action: null }));

  assert.strictEqual(result.kind, "failed");
  assert.strictEqual(result.kind === "failed" ? result.reason : "", "zero_applicable");
});

test("resolveActionExecution: several applicable Actions without precedence fail closed (multiple_applicable) -- never the first one", async (t) => {
  forbidNetwork(t);
  const shared = {
    mode: "all" as const,
    conditions: [{ source: "work" as const, field: "origin" as const, operator: "equals" as const, value: "direct_request" }],
  };
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("first_task", { applicability: shared }),
      makeAction("second_task", { applicability: shared }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "multiple_applicable");
  assert.match(result.detail, /first_task, second_task/);
  assert.match(result.detail, /requires exactly one/);
});

test("resolveActionExecution: an explicit declared precedence resolves multiple applicable Actions, and records which precedence decided", async (t) => {
  forbidNetwork(t);
  const shared = {
    mode: "all" as const,
    conditions: [{ source: "work" as const, field: "origin" as const, operator: "equals" as const, value: "direct_request" }],
  };
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("lower_priority", { applicability: { ...shared, precedence: 7 } }),
      makeAction("deciding", { applicability: { ...shared, precedence: 1 } }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.execution.action.action_id, "deciding");
  assert.strictEqual(result.execution.evidence.precedence_used, "declared precedence 1");
});

test("resolveActionExecution: an Organization context whose Responsibility is not this Hat's own fails closed (responsibility_mismatch)", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("only_task")]) });
  const organization = orgFor({ responsibility: "somebody_elses_duty" });

  const result = await resolveActionExecution(manifest, organization, contractFor());

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "responsibility_mismatch");
});

test("resolveActionExecution: an Action serving a different Responsibility than the resolved one is never applicable (responsibility_mismatch)", async (t) => {
  forbidNetwork(t);
  // A manifest defect: the Action's Responsibility differs from the Hat's.
  // Resolution must not resolve it under the Hat it didn't declare for.
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [makeAction("only_task", { responsibility: "other_duty" })]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "responsibility_mismatch");
});

test("resolveActionExecution: a Hat the manifest does not declare fails closed (hat_not_declared), as does a missing manifest", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("only_task")]) });

  const unknownHat = await resolveActionExecution(manifest, orgFor({ hat: "Ghost Hat" }), contractFor());
  assert.strictEqual(unknownHat.kind, "failed");
  assert.strictEqual(unknownHat.kind === "failed" ? unknownHat.reason : "", "hat_not_declared");

  const missing = await resolveActionExecution(undefined, orgFor(), contractFor());
  assert.strictEqual(missing.kind, "failed");
  assert.strictEqual(missing.kind === "failed" ? missing.reason : "", "missing_manifest");
});

test("resolveActionExecution: every registered Unit resolves exactly one Action for a direct request, or explicitly asks for an interpretation (manifest sweep)", async (t) => {
  forbidNetwork(t);

  let resolved = 0;
  let needInterpretation = 0;
  for (const [unit, manifest] of Object.entries(getUnitManifests())) {
    assert.ok(manifest, `Unit ${unit} is registered without a manifest`);
    for (const [hatName, hat] of Object.entries(manifest.hats)) {
      assert.strictEqual(validateHatManifest(hat), null, `${unit}/${hatName} manifest must be well-formed`);

      const organizationResult = resolveOrganization(
        contractFor({ addressed_unit: unit, addressed_hat: hatName }),
        manifest,
      );
      assert.strictEqual(organizationResult.kind, "resolved", `${unit}/${hatName} must resolve an Organization`);
      if (organizationResult.kind !== "resolved") continue;

      const result = await resolveActionExecution(
        manifest,
        organizationResult.organization,
        contractFor({ addressed_unit: unit, addressed_hat: hatName }),
      );
      assert.ok(
        result.kind === "resolved" || result.kind === "need_interpretation",
        `${unit}/${hatName} must resolve exactly one Action or explicitly require an interpretation (got ${result.kind}${
          result.kind === "failed" ? `: ${result.reason} -- ${result.detail}` : ""
        })`,
      );
      if (result.kind !== "resolved") {
        needInterpretation++;
        continue;
      }
      const action = hat.actions.find((candidate) => candidate.name === result.execution.action.action_id);
      assert.ok(action, `${unit}/${hatName}: resolved Action must be manifest-exposed`);
      assert.strictEqual(
        result.execution.action.responsibility,
        hat.responsibilityId,
        `${unit}/${hatName}: the resolved Action must serve the Hat's own Responsibility`,
      );
      resolved++;
    }
  }
  assert.ok(resolved > 0 && needInterpretation > 0, `expected a mix of resolved and interpretation-requiring Hats (resolved=${resolved}, need_interpretation=${needInterpretation})`);
});

// --- Skill resolution: exact / missing / invalid / undeclared ---------------

test("resolveActionExecution: declared Skills resolve by exact id, verified against the registered digest", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("skilled_task", { skill_requirements: [{ skill_id: "research_signal" }] }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.execution.skills.length, 1);
  const skill = result.execution.skills[0];
  assert.strictEqual(skill.skill_id, "research_signal", "the exact declared id -- no substitute");
  assert.strictEqual(skill.resolved_version, "1.0.0");
  assert.strictEqual(skill.compatibility_status, "compatible", "resolution throws otherwise");
  assert.strictEqual(skill.integrity_status, "verified", "resolution verifies the digest otherwise");
  assert.strictEqual(skill.package_location, null);
  assert.strictEqual(skill.content, resolveSkill("research_signal").content, "the carried package is the Registry-validated content");
});

test("resolveActionExecution: a missing (unregistered) Skill fails closed -- never a partial or substituted set", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("skilled_task", {
        // One valid requirement plus one nothing is registered under:
        // the whole resolution must fail, not return the valid half.
        skill_requirements: [
          { skill_id: "research_signal" },
          { skill_id: "ghost_skill" as SkillId },
        ],
      }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "skill_resolution_failed");
  assert.match(result.detail, /no Skill is registered under the id "ghost_skill"/);
});

test("resolveActionExecution: an integrity-invalid Skill fails closed (registered digest mismatch)", async (t) => {
  forbidNetwork(t);
  const subtle = crypto.subtle as any;
  const hadOwn = Object.prototype.hasOwnProperty.call(subtle, "digest");
  const original = subtle.digest;
  // Tamper with the digest mechanism: every hash now mismatches the
  // registered package digest, which must refuse resolution.
  subtle.digest = async () => new Uint8Array(0);
  t.after(() => {
    if (hadOwn) subtle.digest = original;
    else delete subtle.digest;
  });

  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("skilled_task", { skill_requirements: [{ skill_id: "research_signal" }] }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "skill_resolution_failed");
  assert.match(result.detail, /integrity failed/);
});

test("resolveActionExecution: an Action declaring no Skills carries none -- a Worker can never invoke an undeclared Skill", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({ "Toy Hat": makeHat("Toy Hat", [makeAction("plain_task")]) });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor());

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.deepStrictEqual(result.execution.skills, []);
});

// --- The resolved Action Execution Context the Worker consumes --------------

test("resolved Action Execution Context is self-sufficient: the Worker selects nothing (no Unit, Hat, Responsibility, Action, Skill, approval or permission choice)", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("privileged_task", { consequence: "write", requiresApproval: true }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor({}, "privileged work"));

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  const execution = result.execution;
  assert.strictEqual(execution.work_id, null, "the Work does not exist yet; the caller stamps it on creation");
  assert.strictEqual(execution.organization.unit, "Business Development");
  assert.strictEqual(execution.organization.hat, "Toy Hat");
  assert.strictEqual(execution.organization.responsibility, DUTY);
  assert.strictEqual(execution.action.action_id, "privileged_task");
  assert.strictEqual(execution.action.responsibility, execution.organization.responsibility, "Action serves the resolved Responsibility");
  assert.strictEqual(execution.action.definition_source, "unit_manifest");
  assert.strictEqual(execution.approval_state.required, true, "approval requirement resolved from the Action definition, not asserted");
  assert.deepStrictEqual(execution.access_context, {
    kind: "work_session",
    unit: "Business Development",
    hat: "Toy Hat",
    action: "privileged_task",
  });
  assert.strictEqual(execution.inputs.requested_outcome, "privileged work");
  assert.strictEqual(execution.inputs.origin, "direct_request");
  assert.strictEqual(execution.inputs.mode, "cowork");
  // This toy Action declares no Tool operation, so tool_context is null
  // (never invented); per-Action data classification still has no mechanism.
  // A declaration would be recorded here as the Action's allowlist -- a
  // record, never a grant: permission stays with the invocation boundary.
  assert.strictEqual(execution.tool_context, null);
  assert.strictEqual(execution.data_context, null);
  assert.strictEqual(execution.preconditions, null);
  assert.strictEqual(execution.expected_result, null);
  assert.strictEqual(execution.completion_criteria, null);
  assert.strictEqual(execution.evidence.resolved_action, "privileged_task");
});

test("resolveActionExecution: a declared Tool operation is recorded verbatim in tool_context -- the Action's allowlist, never a grant", async (t) => {
  forbidNetwork(t);
  const manifest = makeManifest({
    "Toy Hat": makeHat("Toy Hat", [
      makeAction("tool_task", {
        consequence: "write",
        tool_operations: [{ tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false }],
      }),
    ]),
  });

  const result = await resolveActionExecution(manifest, orgFor(), contractFor({}, "tool work"));

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.deepStrictEqual(result.execution.tool_context, {
    permitted_operations: [{ tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false }],
  });
});
