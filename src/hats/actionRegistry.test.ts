import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchAction, findAction, type ActionDefinition } from "./actionRegistry";

// ---------------------------------------------------------------------------
// Toy action set -- proves the mechanism works for a generic Unit, without
// deciding or wiring any real Unit's action list (Sales/Marketing/Strategy/
// Finance action lists remain an open product decision).
// ---------------------------------------------------------------------------

type ToyAction = "lookup_status" | "update_record";

const TOY_REGISTRY: ActionDefinition<ToyAction>[] = [
  { name: "lookup_status", consequence: "read", description: "Read-only status lookup, no side effects." },
  { name: "update_record", consequence: "write", description: "Mutates governed state." },
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

test("dispatchAction: a registered write action never invokes the read handler -- it only signals dispatch", async () => {
  let handlerCalled = false;
  const result = await dispatchAction<ToyAction>(
    "update_record",
    "set the price to 500",
    TOY_REGISTRY,
    async () => {
      handlerCalled = true;
      return "should never be reached";
    },
  );
  assert.deepEqual(result, { kind: "write", action: "update_record" });
  assert.equal(handlerCalled, false, "write actions must never run the read handler -- writes stay on the existing WorkSession/approval pipeline");
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

test("findAction: returns the matching definition or undefined for an unregistered name", () => {
  assert.deepEqual(findAction("lookup_status", TOY_REGISTRY), TOY_REGISTRY[0]);
  assert.equal(findAction("nonexistent", TOY_REGISTRY), undefined);
});
