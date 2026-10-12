import test from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Units are meant to be worked on without affecting each other. What crosses
// a Unit boundary is a Handoff (a record), whose shared formats live in
// src/handoffContracts -- never one Unit importing another Unit's code. This
// test fails if a production file under src/units/<A>/ imports from
// src/units/<B>/.
//
// There is no exception: Strategy reads the approved Call Notes record through
// src/records/callNotes (a governed Business Object that no single Unit owns --
// Isolated Sales creates it; Runtime reads it), not through Sales's code.

const UNITS_DIR = join(__dirname, "..", "units");
const ALLOWED = new Set<string>();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

test("No Unit's production code imports another Unit's code (Handoff formats live in src/handoffContracts)", () => {
  const unitNames = readdirSync(UNITS_DIR).filter((n) => statSync(join(UNITS_DIR, n)).isDirectory());
  const found = new Set<string>();
  for (const file of walk(UNITS_DIR)) {
    const rel = relative(UNITS_DIR, file);
    const own = rel.split("/")[0];
    if (!unitNames.includes(own)) continue; // shared files directly in src/units
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/from\s+["']\.\.\/(\w+)\//g)) {
      if (unitNames.includes(m[1]) && m[1] !== own) found.add(`${rel} -> ${m[1]}`);
    }
  }
  const unexpected = [...found].filter((f) => !ALLOWED.has(f));
  assert.deepStrictEqual(unexpected, [], `cross-Unit imports (move the shared format to src/handoffContracts): ${unexpected.join("; ")}`);
  });

test("The neutral contracts module imports no Unit", () => {
  for (const file of walk(join(__dirname))) {
    assert.ok(!/from\s+["'][^"']*\/units\//.test(readFileSync(file, "utf8")), `${file} must not import a Unit`);
  }
});

test("The generic Worker's Handoff discovery and pickup scheduling name no Unit", () => {
  const SRC = join(__dirname, "..");
  for (const file of ["checkHandoffs.ts", "sessionRouting.ts"]) {
    const text = readFileSync(join(SRC, file), "utf8");
    assert.ok(!/from\s+["']\.\/units\/(sales|strategy|finance|marketing|businessDevelopment)\//.test(text), `${file} must not import a Unit's code -- Unit specifics are declared on its manifest (handoffPickup)`);
    assert.ok(!/["'](sales_proposal|sales_call_notes)["']/.test(text), `${file} must not carry Unit-specific pickup kinds`);
  }
});

test("The Call Notes record module imports no Unit", () => {
  const dir = join(__dirname, "..", "records");
  for (const file of walk(dir)) {
    assert.ok(!/from\s+["'][^"']*\/units\//.test(readFileSync(file, "utf8")), `${file} must not import a Unit`);
  }
});
