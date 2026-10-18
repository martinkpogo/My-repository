/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";

import { resolveOrganization } from "./organization";
import { workContractForRequest, type WorkContract, type WorkRequest } from "./workContract";
import type { RelationshipDefinition } from "../hats/relationships";
import type { ActionDefinition } from "../hats/actionRegistry";
import type { HatManifest, UnitManifest } from "../units/unitManifest";

/**
 * Organization-boundary conformance tests for the manifest relationship
 * extension (UnitManifest.hatRelationships): the order-of-authority step
 * that lets a Unit resolve several validated intake candidates through its
 * OWN registered relationships instead of failing closed on ambiguity.
 *
 * Same discipline as resolution.test.ts: the real resolver, a toy manifest
 * (not any real Unit's), no AI provider call ever -- the network guard
 * below makes any provider attempt an immediate test failure, which is the
 * structural proof that this step consults no model, no request text, and
 * no Unit-specific branch. The relationship evaluation itself is
 * hats/relationships.ts's pure resolveCandidateRelationships (its own
 * reason codes are covered in relationships.test.ts); what is asserted
 * here is how the Organization boundary invokes it and what it records.
 */

const DUTY = "toy_responsibility";

function makeAction(name: string): ActionDefinition<string> {
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
  };
}

function makeHat(name: string, responsibilityId = DUTY): HatManifest<string> {
  return {
    name,
    responsibility: "Handles toy work for this test.",
    responsibilityId,
    actions: [makeAction(`do_${name.toLowerCase()}`)],
    readHandler: async (_env, actionName) => `handled:${actionName}`,
    entryHandler: async (_env, state) => state,
    awaitingHandlers: {},
  };
}

function makeManifest(hats: Record<string, HatManifest<string>>, hatRelationships?: RelationshipDefinition<string>[]): UnitManifest {
  return {
    unit: "Business Development",
    hats,
    intakeClassificationTaskId: "business_development.intake_classification",
    intakeIntroLine: "You route incoming toy requests.",
    actionClassificationTaskId: "business_development.hat_action_decision",
    ...(hatRelationships ? { hatRelationships } : {}),
  };
}

/** Three Hats, so single-Hat ownership never resolves and a tie genuinely needs deciding. */
function threeHatManifest(hatRelationships?: RelationshipDefinition<string>[]): UnitManifest {
  return makeManifest(
    { Alpha: makeHat("Alpha", "alpha_duty"), Beta: makeHat("Beta", "beta_duty"), Gamma: makeHat("Gamma", "gamma_duty") },
    hatRelationships,
  );
}

function contractFor(context: Partial<WorkRequest["current_context"]> = {}, requested_outcome = "do the toy thing"): WorkContract {
  return workContractForRequest({
    requested_outcome,
    current_context: { mode: "cowork", origin: "direct_request", ...context },
  });
}

const UNCONDITIONAL: RelationshipDefinition<string>[] = [
  { id: "toy__alpha-beta", from: "Alpha", to: "Beta", conditional: false, description: "Alpha establishes direction before Beta executes it." },
];

const CONDITIONAL: RelationshipDefinition<string>[] = [
  { id: "toy__alpha-beta-conditional", from: "Alpha", to: "Beta", conditional: true, description: "Alpha precedes Beta only when establishing direction." },
];

const CONFLICTING: RelationshipDefinition<string>[] = [
  { id: "toy__alpha-beta", from: "Alpha", to: "Beta", conditional: false, description: "Alpha establishes direction before Beta executes it." },
  { id: "toy__alpha-gamma", from: "Alpha", to: "Gamma", conditional: false, description: "Alpha establishes direction before Gamma executes it." },
];

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

// --- Several candidates: declared relationships decide ------------------------

test("several validated candidates resolve through a declared unconditional relationship, recording source and relationship id", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"] }), manifest);

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.organization.hat, "Beta", "the unconditional relationship's `to` Hat must win");
  assert.strictEqual(result.evidence.resolved_from, "registered_relationship");
  assert.strictEqual(result.evidence.interpretation_consulted, true, "the relationship step consumes interpretation candidates");
  assert.strictEqual(result.evidence.relationship_id, "toy__alpha-beta", "the deciding registered relationship must be recorded, not implied");
  assert.deepStrictEqual(result.evidence.evaluated.interpreted_hats, ["Alpha", "Beta"]);
});

test("establishing has no effect on an unconditional relationship -- same input, same resolved Hat", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const establishing = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"], interpreted_establishing: true }), manifest);
  const notEstablishing = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"], interpreted_establishing: false }), manifest);

  assert.deepStrictEqual(establishing, notEstablishing);
  assert.strictEqual(establishing.kind === "resolved" ? establishing.organization.hat : "", "Beta");
});

test("a conditional relationship resolves by the interpretation's establishing value, in both directions", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(CONDITIONAL);

  const establishing = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"], interpreted_establishing: true }), manifest);
  assert.strictEqual(establishing.kind, "resolved");
  if (establishing.kind === "resolved") {
    assert.strictEqual(establishing.organization.hat, "Alpha", "establishing direction is the `from` Hat's responsibility");
    assert.strictEqual(establishing.evidence.resolved_from, "registered_relationship");
    assert.strictEqual(establishing.evidence.relationship_id, "toy__alpha-beta-conditional");
  }

  const executing = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"], interpreted_establishing: false }), manifest);
  assert.strictEqual(executing.kind, "resolved");
  if (executing.kind === "resolved") {
    assert.strictEqual(executing.organization.hat, "Beta", "executing within established direction is the `to` Hat's responsibility");
    assert.strictEqual(executing.evidence.relationship_id, "toy__alpha-beta-conditional");
  }
});

// --- Fail-closed outcomes -----------------------------------------------------

test("a conditional relationship with no explicit establishing value fails closed with the resolver's reason code", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(CONDITIONAL);

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "ambiguous_ownership");
  assert.match(result.detail, /CONDITIONAL_ESTABLISHING_REQUIRED/, "the fail-closed reason code must be reported, not swallowed");
  assert.match(result.detail, /Alpha, Beta/, "the candidates that could not be decided must be named");
});

test("candidates with no registered relationship between them fail closed with NO_REGISTERED_RELATIONSHIP", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Beta", "Gamma"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "ambiguous_ownership");
  assert.match(result.detail, /NO_REGISTERED_RELATIONSHIP/);
});

test("several candidates matching conflicting registered relationships fail closed with MULTIPLE_CONFLICTING_RELATIONSHIPS", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(CONFLICTING);

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta", "Gamma"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "ambiguous_ownership");
  assert.match(result.detail, /MULTIPLE_CONFLICTING_RELATIONSHIPS/);
});

test("a manifest that declares no relationships keeps the unchanged fail-closed behaviour for several candidates", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest();

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "ambiguous_ownership");
  assert.strictEqual(
    result.detail,
    "Business Development intake resolved 2 possible Hats (Alpha, Beta) -- ambiguity stops rather than picking one",
    "without a declared relationship list, ambiguity must stop exactly as before this extension existed",
  );
});

// --- Candidate validation happens first ---------------------------------------

test("an unregistered candidate never reaches relationship evaluation -- a registered remainder still resolves directly", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const filtered = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Ghost Hat"] }), manifest);
  assert.strictEqual(filtered.kind, "resolved");
  if (filtered.kind === "resolved") {
    assert.strictEqual(filtered.organization.hat, "Alpha", "filtering to one registered candidate resolves through the unchanged single-candidate rule");
    assert.strictEqual(filtered.evidence.resolved_from, "intake_interpretation");
    assert.strictEqual(filtered.evidence.relationship_id, undefined, "no relationship was consulted for a single candidate");
  }

  const mixed = resolveOrganization(contractFor({ interpreted_hats: ["Ghost Hat", "Alpha", "Beta"] }), manifest);
  assert.strictEqual(mixed.kind, "resolved");
  if (mixed.kind === "resolved") {
    assert.strictEqual(mixed.organization.hat, "Beta", "the unregistered name is filtered out before relationships are evaluated");
    assert.strictEqual(mixed.evidence.resolved_from, "registered_relationship");
    assert.strictEqual(mixed.evidence.relationship_id, "toy__alpha-beta");
  }
});

test("an interpretation naming only unregistered Hats fails closed without ever consulting relationships", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Ghost Hat", "Ghast Hat"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "ambiguous_ownership");
  assert.match(result.detail, /names none of them unambiguously/);
  assert.ok(!result.detail.includes("relationship"), "the failure must come from candidate validation, not from relationship evaluation");
});

test("a single validated candidate never consults relationships, even when the manifest declares them", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(contractFor({ interpreted_hats: ["Beta"], interpreted_establishing: true }), manifest);

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.organization.hat, "Beta");
  assert.strictEqual(result.evidence.resolved_from, "intake_interpretation");
  assert.strictEqual(result.evidence.relationship_id, undefined);
});

// --- Order of authority is preserved ------------------------------------------

test("an explicitly addressed Hat wins -- the relationship step never overrides an addressee", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(contractFor({ addressed_hat: "Beta", interpreted_hats: ["Alpha", "Beta"] }), manifest);

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.organization.hat, "Beta");
  assert.strictEqual(result.evidence.resolved_from, "explicit_address");
  assert.strictEqual(result.evidence.interpretation_consulted, false);
  assert.strictEqual(result.evidence.relationship_id, undefined);
});

test("a Handoff destination Hat wins -- relationships are never consulted for a destination fact", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(
    contractFor({ handoff: { handoffId: "handoff-1", toUnit: "Business Development", toHat: "Alpha" }, interpreted_hats: ["Alpha", "Beta"] }),
    manifest,
  );

  assert.strictEqual(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.strictEqual(result.organization.hat, "Alpha");
  assert.strictEqual(result.evidence.resolved_from, "handoff_destination");
  assert.strictEqual(result.evidence.relationship_id, undefined);
});

test("a Handoff that names no Hat fails closed on multi-Hat ownership instead of falling through to relationships", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);

  const result = resolveOrganization(contractFor({ handoff: { handoffId: "handoff-2", toUnit: "Business Development" }, interpreted_hats: ["Alpha", "Beta"] }), manifest);

  assert.strictEqual(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.strictEqual(result.reason, "ambiguous_ownership");
  assert.match(result.detail, /Handoff destination/);
  assert.ok(!result.detail.includes("relationship"), "a destination gap must stop here; relationships only break intake-interpretation ties");
});

// --- Purity / determinism ------------------------------------------------------

test("resolution is deterministic and request-text-free: the same contract repeats, and outcome text never changes the answer", (t) => {
  forbidNetwork(t);
  const manifest = threeHatManifest(UNCONDITIONAL);
  const contract = contractFor({ interpreted_hats: ["Alpha", "Beta"] });

  const first = resolveOrganization(contract, manifest);
  const second = resolveOrganization(contract, manifest);
  assert.deepStrictEqual(first, second);

  const otherText = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"] }, "an entirely different requested outcome"), manifest);
  assert.deepStrictEqual(otherText, first, "the relationship step must not read request text -- only declared data and validated candidates decide");

  const otherEstablishing = resolveOrganization(contractFor({ interpreted_hats: ["Alpha", "Beta"] }, "still a different outcome"), threeHatManifest(CONDITIONAL));
  assert.strictEqual(otherEstablishing.kind, "failed");
  if (otherEstablishing.kind === "failed") {
    assert.strictEqual(otherEstablishing.reason, "ambiguous_ownership");
    assert.match(otherEstablishing.detail, /CONDITIONAL_ESTABLISHING_REQUIRED/, "without an establishing value a conditional relationship stays unresolvable regardless of text");
  }
});
