import test from "node:test";
import assert from "node:assert/strict";
import { buildProposalDocLayout, diffWords } from "./proposalRedline";

test("diffWords: unchanged text is 'same', removed words 'del', new words 'add'", () => {
  const segs = diffWords("The fee is GHS 8000 per day.", "The fee is GHS 9600 per day.");
  assert.deepStrictEqual(segs.filter((s) => s.kind === "del").map((s) => s.text), ["8000"]);
  assert.deepStrictEqual(segs.filter((s) => s.kind === "add").map((s) => s.text), ["9600"]);
  assert.strictEqual(segs.filter((s) => s.kind !== "del").map((s) => s.text).join(""), "The fee is GHS 9600 per day.");
  assert.strictEqual(segs.filter((s) => s.kind !== "add").map((s) => s.text).join(""), "The fee is GHS 8000 per day.");
});

test("buildProposalDocLayout: version 1 is just the clean text under a heading, no changes section", () => {
  const l = buildProposalDocLayout("PROP-1", [{ version: 1, content: "Scope A." }]);
  assert.strictEqual(l.text, "PROP-1 v1 -- current version\nScope A.\n");
  assert.deepStrictEqual(l.styles, [{ start: 1, end: 1 + "PROP-1 v1 -- current version".length, kind: "heading" }]);
});

test("buildProposalDocLayout: later versions put the clean current text first and a redline per revision, newest first; style ranges point at the exact text", () => {
  const l = buildProposalDocLayout("PROP-1", [
    { version: 1, content: "Scope A. Fee 100." },
    { version: 2, content: "Scope A. Fee 200." },
    { version: 3, content: "Scope B. Fee 200." },
  ]);
  assert.ok(l.text.startsWith("PROP-1 v3 -- current version\nScope B. Fee 200.\n"));
  assert.ok(l.text.indexOf("v3 compared with v2") < l.text.indexOf("v2 compared with v1"), "newest revision first");
  const slice = (kind: string) => l.styles.filter((r) => r.kind === kind).map((r) => l.text.slice(r.start - 1, r.end - 1));
  assert.ok(slice("del").includes("100.") && slice("add").includes("200."), "v2 vs v1 marks 100. removed and 200. added");
  assert.ok(slice("del").includes("A.") && slice("add").includes("B."), "v3 vs v2 marks the scope change");
  assert.ok(slice("heading").includes("Changes"));
});
