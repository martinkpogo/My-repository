import test from "node:test";
import assert from "node:assert";
import { ALL_HATS } from "../hats/registry";
import { findUnitManifest, getUnitManifests } from "../units/registry";

/**
 * Regression coverage for the retirement of Research & Intelligence as an
 * organizational Unit. Research is reusable runtime infrastructure
 * (src/runtime/research, src/runtime/evidence) and reusable methodology (the
 * `research_signal` Skill); it is never a Unit, a Hat, a Handoff destination,
 * or a routing target. These tests exist so that none of those can quietly come
 * back under the old name or under a renamed alias.
 */

const RETIRED_UNIT = "Research & Intelligence";
const RETIRED_HAT = "Research & Intelligence Analyst";

test("no Research & Intelligence Unit manifest is registered", () => {
  assert.ok(!(RETIRED_UNIT in getUnitManifests()), "the Unit registry must not key a manifest by the retired Unit");
  assert.strictEqual(findUnitManifest(RETIRED_UNIT as any), undefined);
  for (const manifest of Object.values(getUnitManifests())) {
    assert.notStrictEqual(manifest!.unit as string, RETIRED_UNIT);
    assert.ok(!(RETIRED_HAT in manifest!.hats), `${manifest!.unit} must not declare the retired Hat`);
  }
});

test("no Research & Intelligence Hat is registered, and no registered Hat belongs to a Unit by that name or to any research-flavoured alias", () => {
  assert.ok(!ALL_HATS.some((h) => h.name === RETIRED_HAT), "the retired Hat must not be registered");
  assert.ok(!ALL_HATS.some((h) => h.unit === RETIRED_UNIT), "no Hat may belong to the retired Unit");
  assert.ok(!ALL_HATS.some((h) => /research/i.test(h.unit)), "no Hat may belong to a research-named Unit under any alias");
});

test("the retired Unit's manifest and callback prefix are not registered on any Hat", () => {
  for (const manifest of Object.values(getUnitManifests())) {
    for (const hat of Object.values(manifest!.hats)) {
      assert.ok(!hat.callbackHandlers || !("researchhandoff" in hat.callbackHandlers), `${hat.name} must not own the researchhandoff callback`);
      assert.ok(!hat.actions.some((a) => a.responsibility === "produce_research_packages"), `${hat.name} must not declare the retired Responsibility`);
    }
  }
});

function sourceFiles(dir: string, fs: typeof import("node:fs"), path: typeof import("node:path")): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, fs, path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no production code names the retired Unit or Hat, or any retired R&I entry point, outside comments", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const srcDir = path.join(import.meta.dirname, "..");
  const retiredSymbols = [
    RETIRED_UNIT,
    RETIRED_HAT,
    "discoverPendingResearchHandoffs",
    "runResearchPickup",
    "researchManifest",
    "dispatchResearchHat",
    "researchPackageActions",
    "produce_research_packages",
    "researchhandoff",
    "pendingResearchHandoff",
  ];
  for (const file of sourceFiles(srcDir, fs, path)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const symbol of retiredSymbols) {
      assert.ok(!code.includes(symbol), `${path.relative(srcDir, file)} must not reference retired symbol "${symbol}"`);
    }
  }
});

test("no src/units/research module exists -- research is not an organizational module", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  assert.ok(!fs.existsSync(path.join(import.meta.dirname, "..", "units", "research")));
});

test("no Handoff discovery loop targets the retired Unit, and no Telegram topic maps to it", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const checkHandoffs = fs.readFileSync(path.join(import.meta.dirname, "..", "checkHandoffs.ts"), "utf8");
  assert.ok(!/To Unit[^\n]*Research/.test(checkHandoffs), "checkHandoffs must not query Handoffs addressed to the retired Unit");
  assert.ok(!/discoverPending(?!Finance|Sales|Marketing|Strategy)[A-Za-z]*Handoffs/.test(checkHandoffs), "only discovery loops for real current Units exist");

  const wrangler = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "wrangler.toml"), "utf8");
  assert.ok(!wrangler.includes(RETIRED_UNIT), "wrangler.toml must not carry a topic for the retired Unit");
});
