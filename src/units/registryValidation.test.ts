import test from "node:test";
import assert from "node:assert";

import { buildUnitRegistry, getUnitManifests } from "./registry";
import { salesManifest } from "./sales/salesManifest";
import { financeManifest } from "./finance/financeManifest";
import type { UnitManifest } from "./unitManifest";

/**
 * Covers WP8's contract: the Unit registry runs `validateHatManifest` over
 * every Hat of every Unit manifest where it assembles the table, so a
 * malformed manifest throws at registry build -- with the Unit, Hat and
 * message -- and fails the test/deploy gate rather than surfacing on a
 * live request mid-run. Fixtures derive from the real Sales manifest with
 * one deliberate defect each; the real registry must build cleanly (no
 * current manifest may be "fixed" to pass -- a failure there is a real
 * defect to report, not to paper over).
 */

function withSalesExecutiveHat(mutate: (hat: UnitManifest["hats"][string]) => UnitManifest["hats"][string]): UnitManifest {
  const seHat = salesManifest.hats["Sales Executive"];
  return {
    ...salesManifest,
    hats: {
      ...salesManifest.hats,
      "Sales Executive": mutate(seHat),
    },
  };
}

test("registry build: a manifest with a duplicate Action throws at build, naming Unit, Hat and message", () => {
  const broken = withSalesExecutiveHat((hat) => ({
    ...hat,
    actions: [...hat.actions, hat.actions[0]],
  }));
  assert.throws(
    () => buildUnitRegistry({ Sales: broken }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('Unit "Sales"'), `must name the Unit, got: ${message}`);
      assert.ok(message.includes('Hat "Sales Executive"'), `must name the Hat, got: ${message}`);
      assert.ok(message.includes("declared more than once"), `must carry validateHatManifest's message, got: ${message}`);
      return true;
    },
    "a duplicate Action is a manifest defect and must fail the registry build",
  );
});

test("registry build: an Action whose Responsibility is not its Hat's throws at build, naming Unit, Hat and message", () => {
  const broken = withSalesExecutiveHat((hat) => {
    const [first, ...rest] = hat.actions;
    return {
      ...hat,
      actions: [{ ...first, responsibility: "not-the-responsibility-this-hat-owns" }, ...rest],
    };
  });
  assert.throws(
    () => buildUnitRegistry({ Sales: broken }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('Unit "Sales"'), `must name the Unit, got: ${message}`);
      assert.ok(message.includes('Hat "Sales Executive"'), `must name the Hat, got: ${message}`);
      assert.ok(message.includes("not the Responsibility this Hat owns"), `must carry validateHatManifest's message, got: ${message}`);
      return true;
    },
    "a Responsibility mismatch must fail the registry build",
  );
});

test("registry build: a Hat with no Actions throws at build, naming Unit, Hat and message", () => {
  const broken = withSalesExecutiveHat((hat) => ({ ...hat, actions: [] }));
  assert.throws(
    () => buildUnitRegistry({ Sales: broken }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('Unit "Sales"'), `must name the Unit, got: ${message}`);
      assert.ok(message.includes('Hat "Sales Executive"'), `must name the Hat, got: ${message}`);
      assert.ok(message.includes("at least one Action"), `must carry validateHatManifest's message, got: ${message}`);
      return true;
    },
    "an empty Action list must fail the registry build",
  );
});

test("registry build: defects across Hats are all reported in one throw (every Hat is visited once)", () => {
  const brokenSales = withSalesExecutiveHat((hat) => ({ ...hat, actions: [] }));
  const brokenStrategy: UnitManifest = {
    ...salesManifest,
    unit: "Strategy",
    hats: { "Sales Executive": { ...salesManifest.hats["Sales Executive"], actions: [] } },
  };
  assert.throws(
    () => buildUnitRegistry({ Sales: brokenSales, Strategy: brokenStrategy }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('Unit "Sales"'), `must report the Sales defect, got: ${message}`);
      assert.ok(message.includes('Unit "Strategy"'), `must report the Strategy defect too -- all Hats are visited once, got: ${message}`);
      return true;
    },
    "one build reports every malformed Hat, not just the first",
  );
});

test("registry build: the real registry builds cleanly -- every Hat of every registered Unit validates", () => {
  const registry = getUnitManifests();
  assert.deepStrictEqual(
    Object.keys(registry).sort(),
    ["Business Development", "Finance", "Marketing", "Sales", "Strategy"],
    "the five registered Units all build",
  );
});

test("registry build: a callback prefix declared by two different Units throws at build, naming both Units and the prefix", () => {
  const financeHat = financeManifest.hats["Value-Based Pricing Assessor"];
  const quotePrefix = Object.keys(financeHat.callbackHandlers ?? {})[0];
  const quoteHandler = financeHat.callbackHandlers![quotePrefix];
  assert.strictEqual(quotePrefix, "quote", "Finance owns the quote prefix -- the fixture relies on it");
  const overlapping = withSalesExecutiveHat((hat) => ({ ...hat, callbackHandlers: { [quotePrefix]: quoteHandler } }));

  assert.throws(
    () => buildUnitRegistry({ Sales: overlapping, Finance: financeManifest }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('Unit "Sales"'), `must name the first owner, got: ${message}`);
      assert.ok(message.includes('Unit "Finance"'), `must name the second owner, got: ${message}`);
      assert.ok(message.includes(`"${quotePrefix}"`), `must name the prefix, got: ${message}`);
      assert.ok(message.includes("exactly one owning Unit"), `must state the invariant, got: ${message}`);
      return true;
    },
    "a prefix crossing a Unit boundary would let one Unit's stale button act on another Unit's Work",
  );
});

test("registry build: no prefix in the real registry crosses a Unit boundary -- the invariant stale-button refusal depends on", () => {
  const ownerOf = new Map<string, string>();
  for (const [unit, manifest] of Object.entries(getUnitManifests())) {
    for (const hat of Object.values(manifest.hats)) {
      for (const prefix of Object.keys(hat.callbackHandlers ?? {})) {
        const owner = ownerOf.get(prefix);
        if (owner === undefined) ownerOf.set(prefix, unit);
        else assert.strictEqual(owner, unit, `prefix "${prefix}" is declared by ${owner} and ${unit} -- a stale button could cross between them`);
      }
    }
  }
  assert.ok(ownerOf.size >= 5, `several business prefixes must be registered, got ${ownerOf.size}`);
  assert.strictEqual(ownerOf.get("quote"), "Finance");
  assert.strictEqual(ownerOf.get("sprop"), "Strategy");
  assert.strictEqual(ownerOf.get("salesprop"), "Sales");
});

test("registry build: an Action declaring a Tool operation that is not registered in the Tool Registry throws at build, naming the Unit, Hat, Action and operation", () => {
  const withUndeclaredTool = withSalesExecutiveHat((hat) => ({
    ...hat,
    actions: hat.actions.map((action) =>
      action.name === "proposal_submit"
        ? { ...action, tool_operations: [{ tool_id: "google_docs", operation_id: "google_docs.frobnicate", required: false }] }
        : action,
    ),
  }));

  assert.throws(
    () => buildUnitRegistry({ Sales: withUndeclaredTool }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('Unit "Sales"'), `must name the Unit, got: ${message}`);
      assert.ok(message.includes('"Sales Executive"'), `must name the Hat, got: ${message}`);
      assert.ok(message.includes('"proposal_submit"'), `must name the Action, got: ${message}`);
      assert.ok(message.includes("google_docs.frobnicate"), `must name the operation, got: ${message}`);
      assert.ok(message.includes("not registered in the Tool Registry"), ` must state the invariant, got: ${message}`);
      return true;
    },
    "a declaration naming an unregistered operation must fail at assembly, before production requests are served",
  );
});

test("registry build: the real registry's Tool declarations all resolve to registered operations, and its own Tool Registry is structurally sound", () => {
  const registered = ["google_docs.create_and_verify", "google_docs.update_and_verify", "google_drive.ensure_folder"];
  let declared = 0;
  for (const manifest of Object.values(getUnitManifests())) {
    for (const hat of Object.values(manifest.hats)) {
      for (const action of hat.actions) {
        for (const declaration of action.tool_operations ?? []) {
          declared += 1;
          const operationId = declaration.operation_id;
          assert.ok(
            registered.includes(operationId),
            `every declaration must name one of the registered Google Workspace operations (${registered.join(", ")}), got ${operationId}`,
          );
          assert.strictEqual(declaration.required, false, "the review Doc is permitted, never required, for every declaring Proposal Action");
        }
      }
    }
  }
  assert.strictEqual(declared, 9, `proposal_draft, proposal_submit and proposal_approve must each declare the three registered Google Workspace operations, got ${declared}`);
  // getUnitManifests() itself runs buildUnitRegistry over the real manifests;
  // reaching this line without a throw is the proof the real registry -- with
  // its Tool declarations and the Tool Registry integrity check -- assembles cleanly.
  assert.ok(Object.keys(getUnitManifests()).length >= 5);
});
