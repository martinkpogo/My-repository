import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchAction, findAction, type ActionDefinition } from "./actionRegistry";

// ---------------------------------------------------------------------------
// Toy action set -- proves the mechanism works for a generic Unit, without
// deciding or wiring any real Unit's action list beyond Business
// Development (see businessDevelopmentManifest.ts).
// ---------------------------------------------------------------------------

type ToyAction = "lookup_status" | "hold_for_evidence" | "update_record" | "commit_external_change";

const TOY_REGISTRY: ActionDefinition<ToyAction>[] = [
  { name: "lookup_status", consequence: "read", description: "Read-only status lookup, no side effects." },
  { name: "hold_for_evidence", consequence: "internal", description: "May pause on missing evidence; mutates execution state only, never approval-gated." },
  { name: "update_record", consequence: "write", description: "Mutates governed state; not privileged." },
  { name: "commit_external_change", consequence: "write", requiresApproval: true, description: "Mutates governed state and is privileged -- needs Martin's sign-off." },
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

test("dispatchAction: a write action with no requiresApproval defaults to unprivileged (false), not automatically gated", async () => {
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
    { name: "broken", consequence: "internal", requiresApproval: true, description: "Invalid combination -- internal must never gate on approval." },
  ];
  await assert.rejects(
    () => dispatchAction<"broken">("broken", "irrelevant", invalidRegistry, async () => "unreachable"),
    /declared consequence "internal" but requiresApproval is true/,
  );
});

test("findAction: returns the matching definition or undefined for an unregistered name", () => {
  assert.deepEqual(findAction("lookup_status", TOY_REGISTRY), TOY_REGISTRY[0]);
  assert.equal(findAction("nonexistent", TOY_REGISTRY), undefined);
});
