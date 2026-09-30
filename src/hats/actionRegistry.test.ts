import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchAction, findAction, validateActionDefinition, type ActionDefinition } from "./actionRegistry";

// ---------------------------------------------------------------------------
// Toy action set -- proves the mechanism works for a generic Unit, without
// deciding or wiring any real Unit's action list beyond Business
// Development (see businessDevelopmentManifest.ts).
// ---------------------------------------------------------------------------

type ToyAction = "lookup_status" | "hold_for_evidence" | "update_record" | "commit_external_change";

/**
 * The toy Hat's Responsibility. Every Action below serves it, which is the
 * relationship `validateHatManifest` enforces for a real Hat -- an Action
 * declares the duty it serves, and that duty must be its own Hat's.
 */
const TOY_RESPONSIBILITY = "toy_responsibility";

const TOY_REGISTRY: ActionDefinition<ToyAction>[] = [
  { name: "lookup_status", responsibility: TOY_RESPONSIBILITY, consequence: "read", requiresApproval: false, description: "Read-only status lookup, no side effects." },
  { name: "hold_for_evidence", responsibility: TOY_RESPONSIBILITY, consequence: "internal", requiresApproval: false, description: "May pause on missing evidence; mutates execution state only, never approval-gated." },
  { name: "update_record", responsibility: TOY_RESPONSIBILITY, consequence: "write", requiresApproval: false, description: "Mutates governed state; not privileged." },
  { name: "commit_external_change", responsibility: TOY_RESPONSIBILITY, consequence: "write", requiresApproval: true, description: "Mutates governed state and is privileged -- needs Martin's sign-off." },
];

test("dispatchAction: a registered read action runs the read handler immediately and returns its reply", async () => {
  let handlerCalledWith: [ToyAction, string] | undefined;
  const result = await dispatchAction<ToyAction>(
    "lookup_status",
    "what's the status of MAT-20",
    TOY_REGISTRY,
    async (actionName, text) => {
      handlerCalledWith = [actionName, text];
      return "MAT-20 is Qualified.";
    },
  );
  assert.deepEqual(result, { kind: "read", reply: "MAT-20 is Qualified." });
  assert.deepEqual(handlerCalledWith, ["lookup_status", "what's the status of MAT-20"]);
});

test("dispatchAction: an internal action never invokes the read handler and never requires approval", async () => {
  let handlerCalled = false;
  const result = await dispatchAction<ToyAction>(
    "hold_for_evidence",
    "still gathering evidence",
    TOY_REGISTRY,
    async () => {
      handlerCalled = true;
      return "should never be reached";
    },
  );
  assert.deepEqual(result, { kind: "continuable", action: "hold_for_evidence", consequence: "internal", requiresApproval: false });
  assert.equal(handlerCalled, false, "internal actions must never run the read handler -- they stay on the WorkSession/entry-handler pipeline");
});

test("dispatchAction: a write action that STATES requiresApproval: false is unprivileged -- 'write' never implies gated", async () => {
  const result = await dispatchAction<ToyAction>("update_record", "set the price to 500", TOY_REGISTRY, async () => "unreachable");
  assert.deepEqual(result, { kind: "continuable", action: "update_record", consequence: "write", requiresApproval: false });
});

test("dispatchAction: a write action explicitly marked requiresApproval: true signals the caller to gate on approval", async () => {
  const result = await dispatchAction<ToyAction>("commit_external_change", "email the client", TOY_REGISTRY, async () => "unreachable");
  assert.deepEqual(result, { kind: "continuable", action: "commit_external_change", consequence: "write", requiresApproval: true });
});

test("dispatchAction: an unregistered action name fails closed with null, never guessing a consequence level", async () => {
  let handlerCalled = false;
  const result = await dispatchAction<ToyAction>(
    "delete_everything",
    "irrelevant",
    TOY_REGISTRY,
    async () => {
      handlerCalled = true;
      return "unreachable";
    },
  );
  assert.equal(result, null);
  assert.equal(handlerCalled, false);
});

test("dispatchAction: an internal action that declares requiresApproval: true fails closed by throwing, never silently downgraded or upgraded", async () => {
  const invalidRegistry: ActionDefinition<"broken">[] = [
    { name: "broken", responsibility: TOY_RESPONSIBILITY, consequence: "internal", requiresApproval: true, description: "Invalid combination -- internal must never gate on approval." },
  ];
  await assert.rejects(
    () => dispatchAction<"broken">("broken", "irrelevant", invalidRegistry, async () => "unreachable"),
    /declared consequence "internal" but requiresApproval is true/,
  );
});

test("validateActionDefinition: accepts a well-formed Action of every consequence level", () => {
  for (const action of TOY_REGISTRY) {
    assert.equal(validateActionDefinition(action), null, `${action.name} should validate`);
  }
});

test("validateActionDefinition: fails closed on an Action that names no Responsibility", () => {
  const noDuty = { name: "undutiful", consequence: "write", requiresApproval: false, description: "Serves nothing it declares." } as unknown as ActionDefinition<string>;
  assert.match(validateActionDefinition(noDuty) ?? "", /must declare the organizational Responsibility it serves/);
});

test("validateActionDefinition: fails closed on a non-boolean requiresApproval rather than reading omission as false", () => {
  const omitted = { name: "undecided", responsibility: TOY_RESPONSIBILITY, consequence: "write", description: "Never said whether it is privileged." } as unknown as ActionDefinition<string>;
  assert.match(validateActionDefinition(omitted) ?? "", /requiresApproval must be stated explicitly/);
});

test("validateActionDefinition: fails closed on a read action that declares requiresApproval: true", () => {
  const readGate: ActionDefinition<string> = { name: "peek_then_gate", responsibility: TOY_RESPONSIBILITY, consequence: "read", requiresApproval: true, description: "A read has no governed effect to approve." };
  assert.match(validateActionDefinition(readGate) ?? "", /declared consequence "read" but requiresApproval is true/);
});

test("validateActionDefinition: fails closed on an unknown consequence, and on an unknown Skill id", () => {
  const oddConsequence = { name: "sideways", responsibility: TOY_RESPONSIBILITY, consequence: "sideways", requiresApproval: false, description: "Not a level." } as unknown as ActionDefinition<string>;
  assert.match(validateActionDefinition(oddConsequence) ?? "", /unknown consequence "sideways"/);

  const unknownSkill = { name: "needs_a_skill", responsibility: TOY_RESPONSIBILITY, consequence: "write", requiresApproval: false, description: "Requires a Skill that is not in the registry.", skill_requirements: [{ skill_id: "no_such_skill" }] } as unknown as ActionDefinition<string>;
  assert.match(validateActionDefinition(unknownSkill) ?? "", /unknown Skill id "no_such_skill"/);
});

test("validateActionDefinition: fails closed on a blank name", () => {
  const blank: ActionDefinition<string> = { name: "   ", responsibility: TOY_RESPONSIBILITY, consequence: "write", requiresApproval: false, description: "Nameless." };
  assert.match(validateActionDefinition(blank) ?? "", /non-empty registered name/);
});

test("findAction: returns the matching definition or undefined for an unregistered name", () => {
  assert.deepEqual(findAction("lookup_status", TOY_REGISTRY), TOY_REGISTRY[0]);
  assert.equal(findAction("nonexistent", TOY_REGISTRY), undefined);
});
