import test from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

// Units are meant to be worked on without affecting each other. What crosses
// a Unit boundary is a Handoff (a record), whose shared formats live in
// src/handoffContracts -- never one Unit importing another Unit's code.
//
// There is no exception: Strategy reads the approved Call Notes record through
// src/records/callNotes (a governed Business Object that no single Unit owns --
// Isolated Sales creates it; Runtime reads it), not through Sales's code.
//
// These tests inspect PRODUCTION source under src/, so they hold whether or not
// any given test file is itself isolated. See
// docs/concurrent-development.md for the ownership model these enforce.

const SRC = join(__dirname, "..");
const UNITS_DIR = join(SRC, "units");

/** Every Unit implementation directory under src/units, discovered rather than hardcoded so a new Unit is covered the day it appears. */
const UNIT_NAMES = readdirSync(UNITS_DIR).filter((n) => statSync(join(UNITS_DIR, n)).isDirectory());

/** Generic infrastructure that must stay Unit-free. Composed against Units only through the shared contracts directly in src/units/. */
const GENERIC_DIRS = ["runtime", "platform", "dataBoundary", "ai", "records", "handoffContracts"];

const ALLOWED = new Set<string>();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/**
 * Every module specifier a file imports or re-exports, covering the four
 * forms TypeScript/ESM actually accepts: `import ... from`, `export ... from`,
 * dynamic `import("...")`, and CommonJS `require("...")`.
 *
 * Block comments are stripped first. These files carry very large doc comments
 * that quote code, so prose such as `src/units/registry.ts -> ...` would
 * otherwise be read as a real edge and the guard would fire on documentation
 * rather than on a defect.
 */
export function importedSpecifiers(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const specs = new Set<string>();
  // `[^;'"]*?` spans a multi-line import list but stops at a statement end, so
  // one statement can never bleed into the next.
  for (const m of withoutComments.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g)) {
    specs.add(m[1]);
  }
  for (const m of withoutComments.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.add(m[1]);
  }
  return [...specs];
}

/**
 * The Unit a specifier resolves INTO, or undefined.
 *
 * Path resolution -- not string matching -- is the point. The earlier guard
 * pattern-matched `../<word>/`, which silently passed `../../units/sales/x`
 * (a file one level deeper) and `./units/sales/x`, so an import could be added
 * at either depth without any test noticing. Resolving the specifier against
 * the importing file's directory and then asking which Unit directory it lands
 * in is depth-independent, so those forms are caught the same as any other.
 */
export function unitReachedBy(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // package import, not a Unit edge
  const resolved = normalize(join(dirname(fromFile), specifier));
  const parts = relative(SRC, resolved).split("/");
  const at = parts.indexOf("units");
  if (at === -1) return undefined;
  const candidate = parts[at + 1];
  return UNIT_NAMES.includes(candidate) ? candidate : undefined;
}

test("No Unit's production code imports another Unit's code (Handoff formats live in src/handoffContracts)", () => {
  const found = new Set<string>();
  for (const file of walk(UNITS_DIR)) {
    const rel = relative(UNITS_DIR, file);
    const own = rel.split("/")[0];
    if (!UNIT_NAMES.includes(own)) continue; // shared files directly in src/units
    for (const spec of importedSpecifiers(readFileSync(file, "utf8"))) {
      const reached = unitReachedBy(file, spec);
      if (reached !== undefined && reached !== own) found.add(`${rel} -> ${reached} (via "${spec}")`);
    }
  }
  const unexpected = [...found].filter((f) => !ALLOWED.has(f));
  assert.deepStrictEqual(
    unexpected,
    [],
    `cross-Unit imports (move the shared format to src/handoffContracts): ${unexpected.join("; ")}`,
  );
});

test("Generic infrastructure imports no Unit implementation -- only the shared contracts in src/units/", () => {
  // A Unit implementation is anything under src/units/<Unit>/. What generic
  // code may depend on instead is the shared surface directly in src/units/
  // (unitManifest, registry, dispatch, awaitingDispatch, unitOperations): the
  // sanctioned composition points that already name no Unit. This is what
  // keeps a Marketing session from colliding with a Sales session inside the
  // runtime both of them need.
  const found = new Set<string>();
  for (const dir of GENERIC_DIRS) {
    const full = join(SRC, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of walk(full)) {
      for (const spec of importedSpecifiers(readFileSync(file, "utf8"))) {
        const reached = unitReachedBy(file, spec);
        if (reached !== undefined) found.add(`${relative(SRC, file)} -> ${reached} (via "${spec}")`);
      }
    }
  }
  const unexpected = [...found].filter((f) => !ALLOWED.has(f));
  assert.deepStrictEqual(
    unexpected,
    [],
    `generic infrastructure must compose with Units only through src/units/' shared contracts (declare the Unit-specific fact on its UnitManifest instead): ${unexpected.join("; ")}`,
  );
});

test("The Unit-boundary guard itself is not evadable by import form or path depth", () => {
  // The failure this whole file exists to prevent is a guard that quietly stops
  // matching. Lock the extractor against the shapes that previously slipped
  // through, and against the two forms it must keep ignoring.
  assert.strictEqual(unitReachedBy("src/units/sales/x.ts", "../strategy/y"), "strategy");
  assert.strictEqual(unitReachedBy("src/units/sales/x.ts", "../sales/y"), "sales"); // own Unit, allowed
  assert.strictEqual(unitReachedBy("src/runtime/tools/x.ts", "../../units/strategy/y"), "strategy"); // deeper
  // A `./` sibling import from a shared composition file is the form the old
  // `../<word>/` pattern could never see, and the one that would let a shared
  // file quietly bind itself to one Unit.
  assert.strictEqual(unitReachedBy("src/units/dispatch.ts", "./sales/salesState"), "sales");
  // A file inside a Unit subdirectory needs three ups to reach another Unit;
  // asserting it here keeps the resolution honest rather than assumed.
  assert.strictEqual(unitReachedBy("src/units/sales/sub/x.ts", "../../../units/finance/y"), "finance");
  assert.strictEqual(unitReachedBy("src/units/sales/sub/x.ts", "../tokenSafeProposal"), "sales"); // own Unit from a subdir
  assert.strictEqual(unitReachedBy("src/units/sales/x.ts", "node:fs"), undefined); // package import
  assert.strictEqual(unitReachedBy("src/units/sales/x.ts", "../unitManifest"), undefined); // shared contract, not a Unit

  // Multi-line import + re-export + dynamic import are all seen.
  const specs = importedSpecifiers(
    ['import {', '  a,', '  b,', '} from "./units/finance/financeState";', 'export { c } from "../units/strategy/strategyState";', 'const m = await import("./units/marketing/marketingState");'].join("\n"),
  );
  assert.ok(specs.includes("./units/finance/financeState"), `multi-line import missed: ${specs.join(", ")}`);
  assert.ok(specs.includes("../units/strategy/strategyState"), `re-export missed: ${specs.join(", ")}`);
  assert.ok(specs.includes("./units/marketing/marketingState"), `dynamic import missed: ${specs.join(", ")}`);

  // Doc-comment prose quoting a path is not an import edge.
  assert.deepStrictEqual(importedSpecifiers("/** See src/units/registry.ts -> src/units/sales/x.ts */\nexport const a = 1;"), []);
});

test("The neutral contracts module imports no Unit", () => {
  for (const file of walk(join(__dirname))) {
    assert.ok(
      !importedSpecifiers(readFileSync(file, "utf8")).some((s) => unitReachedBy(file, s) !== undefined),
      `${file} must not import a Unit`,
    );
  }
});

test("The generic Worker's Handoff discovery and pickup scheduling name no Unit", () => {
  for (const file of ["checkHandoffs.ts", "sessionRouting.ts"]) {
    const text = readFileSync(join(SRC, file), "utf8");
    assert.ok(
      !/from\s+["']\.\/units\/(sales|strategy|finance|marketing|businessDevelopment)\//.test(text),
      `${file} must not import a Unit's code -- Unit specifics are declared on its manifest (handoffPickup)`,
    );
    assert.ok(!/["'](sales_proposal|sales_call_notes)["']/.test(text), `${file} must not carry Unit-specific pickup kinds`);
  }
});

test("The Call Notes record module imports no Unit", () => {
  const dir = join(SRC, "records");
  for (const file of walk(dir)) {
    assert.ok(
      !importedSpecifiers(readFileSync(file, "utf8")).some((s) => unitReachedBy(file, s) !== undefined),
      `${file} must not import a Unit`,
    );
  }
});

test("WorkSession carries no Sales code -- what Sales lets a caller do to a Work is declared on its manifest (UnitManifest.operations)", () => {
  const session = readFileSync(join(SRC, "session.ts"), "utf8");
  assert.ok(!/units\/sales\//.test(session), "session.ts must not import Sales code");
  for (const name of [
    "handleProposalDocComment",
    "syncProposalDocApprovalCycle",
    "handleProposalDocFormatting",
    "requestProposalDocClarification",
    "proposeLeadOpportunity",
  ]) {
    assert.ok(!session.includes(name), `session.ts must not define ${name} -- it is a Sales operation, run through runUnitOperation`);
  }
  assert.ok(session.includes("async runUnitOperation("), "the one generic entry exists");
});
