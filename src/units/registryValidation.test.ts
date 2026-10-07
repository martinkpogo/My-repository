import test from "node:test";
import assert from "node:assert";

import { buildUnitRegistry, getUnitManifests } from "./registry";
import { salesManifest } from "./sales/salesManifest";
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
