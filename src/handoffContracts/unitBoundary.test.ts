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
// ONE documented exception remains: Strategy reads the approved Call Notes
// record through Sales's reader (callNotesRecord / callNotesMarker). Call
// Notes is a governed Business Object, not a Handoff format, and that reader
// depends on Sales internals (callNotesLifecycle, tokenSafeProposal's hash),
// so moving it is a separate, larger step. Listed here so it cannot widen.

const UNITS_DIR = join(__dirname, "..", "units");
const ALLOWED = new Set(["strategy/strategyEvidence.ts -> sales"]);

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
  assert.deepStrictEqual([...found].sort(), [...ALLOWED].sort(), "the documented exception must still exist -- remove it from ALLOWED when it is gone");
});

test("The neutral contracts module imports no Unit", () => {
  for (const file of walk(join(__dirname))) {
    assert.ok(!/from\s+["'][^"']*\/units\//.test(readFileSync(file, "utf8")), `${file} must not import a Unit`);
  }
});
