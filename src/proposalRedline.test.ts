import test from "node:test";
import assert from "node:assert/strict";
import { buildProposalDocLayout, buildProposalDocStyleRequests, diffWords } from "./proposalRedline";

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

// The canonical layout fixture, mirroring buildProposalContent's own output
// shape: a PROPOSAL title line, numbered ALL-CAPS section headings, "Label:"
// lines, "- " bullets, "  - " nested bullets -- with unicode (em dash, emoji,
// accented letters) to prove every range counts UTF-16 code units, exactly
// like the Docs API.
const CONTENT = [
  "PROPOSAL \u2014 Audit & Advisory \ud83d\ude80",
  "",
  "1. PROPOSAL IDENTIFICATION",
  "Proposal ID: PROP-7",
  "Entity_Token: E-20",
  "",
  "2. SCOPE AND DELIVERABLES",
  "In scope:",
  "- Audit the ledger",
  "- Review controls \u00c9lev\u00e9",
  "",
  "3. APPROACH / METHOD",
  "Workstream 1: Fieldwork",
  "  Objective: Cover every account",
  "  Activities:",
  "  - Sample the ledger",
  "- Report: a written report",
].join("\n");
/** v2 edits one bullet both ways -- a word removed AND words added, so the redline carries del AND add marks. */
const V2_CONTENT = CONTENT.replace("Audit the ledger", "Audit every ledger carefully");

test("buildProposalDocLayout: blocks are derived from the content's own structure with whole-paragraph ranges; the redline zone is never blockified", () => {
  const l = buildProposalDocLayout("PROP-7", [
    { version: 1, content: CONTENT },
    { version: 2, content: V2_CONTENT },
  ]);
  const slice = (b: { start: number; end: number }) => l.text.slice(b.start - 1, b.end - 1);

  let prevEnd = 0;
  for (const b of l.blocks) {
    assert.ok(b.start >= 1 && b.end <= l.text.length + 1 && b.start >= prevEnd, `range [${b.start}, ${b.end}] is in bounds and ordered`);
    prevEnd = b.end;
    assert.strictEqual(l.text[b.end - 2], "\n", `block ${b.kind} covers its terminating newline`);
  }
  const byLine = (line: string) => l.blocks.find((b) => slice(b) === `${line}\n`);
  assert.strictEqual(l.blocks[0].kind, "heading", "the Doc's own version heading is first");
  assert.strictEqual(byLine("PROPOSAL \u2014 Audit & Advisory \ud83d\ude80")!.kind, "title");
  assert.strictEqual(byLine("1. PROPOSAL IDENTIFICATION")!.kind, "sectionHeading");
  assert.strictEqual(byLine("In scope:")!.kind, "paragraph");
  assert.strictEqual(byLine("- Audit every ledger carefully")!.kind, "bullet");
  assert.strictEqual(byLine("- Review controls \u00c9lev\u00e9")!.kind, "bullet");
  assert.strictEqual(byLine("  - Sample the ledger")!.kind, "subBullet");
  assert.strictEqual(byLine("Changes")!.kind, "heading");
  assert.strictEqual(byLine("v2 compared with v1")!.kind, "revisionHeading");

  const changesAt = l.text.indexOf("Changes\n");
  for (const b of l.blocks) {
    if (b.start > changesAt) {
      assert.ok(["paragraph", "heading", "revisionHeading"].includes(b.kind), `no structural ${b.kind} block in the redline zone`);
    }
  }

  const marks = (kind: string) => l.styles.filter((s) => s.kind === kind).map((s) => l.text.slice(s.start - 1, s.end - 1));
  assert.ok(marks("label").includes("In scope:") && marks("label").includes("Entity_Token:") && marks("label").includes("Workstream 1:") && marks("label").includes("Objective:"), JSON.stringify(marks("label")));
  assert.ok(marks("add").some((a) => a.includes("carefully")), "the redline's added word is still marked add");
});

test("buildProposalDocLayout: a v1-only layout already carries the canonical blocks -- no redline is required to trigger styling", () => {
  const l = buildProposalDocLayout("PROP-1", [{ version: 1, content: CONTENT }]);
  assert.ok(!l.text.includes("Changes"));
  assert.ok(l.blocks.some((b) => b.kind === "title"));
  assert.ok(l.blocks.some((b) => b.kind === "sectionHeading"));
  assert.ok(l.blocks.some((b) => b.kind === "bullet"));
  assert.ok(l.blocks.some((b) => b.kind === "subBullet"));
});

test("buildProposalDocStyleRequests: style-only requests with valid indexes -- never a text mutation", () => {
  const l = buildProposalDocLayout("PROP-7", [
    { version: 1, content: CONTENT },
    { version: 2, content: V2_CONTENT },
  ]);
  const requests = buildProposalDocStyleRequests(l) as any[];
  for (const r of requests) {
    assert.ok(r.updateTextStyle || r.updateParagraphStyle || r.createParagraphBullets, "only style requests");
    assert.ok(!r.insertText && !r.deleteContentRange && !r.replaceAllText, "never a text mutation");
    const range = (r.updateTextStyle ?? r.updateParagraphStyle ?? r.createParagraphBullets).range;
    assert.ok(range.startIndex >= 1 && range.endIndex <= l.text.length + 1, "every range is inside the text");
  }
  const para = (line: string) => requests.find((r) => r.updateParagraphStyle && l.text.slice(r.updateParagraphStyle.range.startIndex - 1, r.updateParagraphStyle.range.endIndex - 1) === `${line}\n`);
  assert.strictEqual(para("PROPOSAL \u2014 Audit & Advisory \ud83d\ude80").updateParagraphStyle.paragraphStyle.namedStyleType, "TITLE");
  assert.strictEqual(para("1. PROPOSAL IDENTIFICATION").updateParagraphStyle.paragraphStyle.namedStyleType, "HEADING_1");
  assert.strictEqual(para("Changes").updateParagraphStyle.paragraphStyle.namedStyleType, "HEADING_2");
  const nested = para("  - Sample the ledger").updateParagraphStyle;
  assert.strictEqual(nested.paragraphStyle.namedStyleType, "NORMAL_TEXT");
  assert.strictEqual(nested.paragraphStyle.indentStart.magnitude, 36, "nested bullets are indented");
  const bullets = requests.filter((r) => r.createParagraphBullets).map((r) => l.text.slice(r.createParagraphBullets.range.startIndex - 1, r.createParagraphBullets.range.endIndex - 1));
  assert.ok(bullets.includes("- Audit every ledger carefully\n") && bullets.includes("- Review controls \u00c9lev\u00e9\n") && bullets.includes("  - Sample the ledger\n"), JSON.stringify(bullets));
  const inline = requests.filter((r) => r.updateTextStyle && r.updateTextStyle.fields !== "bold,strikethrough,underline");
  assert.ok(inline.some((r) => r.updateTextStyle.fields === "strikethrough,foregroundColor"), "removed text still struck through");
  assert.ok(inline.some((r) => r.updateTextStyle.fields === "underline,foregroundColor"), "added text still underlined");
  const bolds = inline.filter((r) => r.updateTextStyle.fields === "bold").map((r) => l.text.slice(r.updateTextStyle.range.startIndex - 1, r.updateTextStyle.range.endIndex - 1));
  assert.ok(bolds.includes("In scope:"), "labels are bolded inline");
});

// Regression for the live PROP-6 v4 rewrite failure (HTTP 400): batchUpdate
// validates every request against the Docs API v1 schema and rejects the whole
// batch for one unknown field name or one invalid enum value. These two shapes
// were the confirmed cause -- `updateParagraphStyle` carried `textStyle`
// (the updateTextStyle field name) instead of `paragraphStyle`, and the bullet
// preset carried `BULLET_PRESET_TYPE_DISC_CIRCLE_SQUARE`, which is not a
// `BulletGlyphPreset` value. The allowed keys and enum values below are taken
// verbatim from the Docs API v1 discovery schema, so this test fails if either
// shape ever drifts back to a request Google would reject.
test("buildProposalDocStyleRequests: every request matches the Docs API v1 schema -- updateParagraphStyle uses paragraphStyle and bulletPreset is a real BulletGlyphPreset value", () => {
  const l = buildProposalDocLayout("PROP-7", [
    { version: 1, content: CONTENT },
    { version: 2, content: V2_CONTENT },
  ]);
  const requests = buildProposalDocStyleRequests(l) as any[];

  // The exact property sets of the Docs API v1 request messages (discovery schema).
  const allowedKeys: Record<string, string[]> = {
    updateTextStyle: ["range", "textStyle", "fields"],
    updateParagraphStyle: ["range", "paragraphStyle", "fields"],
    createParagraphBullets: ["range", "bulletPreset"],
  };
  const bulletGlyphPresets = [
    "BULLET_GLYPH_PRESET_UNSPECIFIED",
    "BULLET_DISC_CIRCLE_SQUARE",
    "BULLET_DIAMONDX_ARROW3D_SQUARE",
    "BULLET_CHECKBOX",
    "BULLET_ARROW_DIAMOND_DISC",
    "BULLET_STAR_CIRCLE_SQUARE",
    "BULLET_ARROW3D_CIRCLE_SQUARE",
    "BULLET_LEFTTRIANGLE_DIAMOND_DISC",
    "BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE",
    "BULLET_DIAMOND_CIRCLE_SQUARE",
    "NUMBERED_DECIMAL_ALPHA_ROMAN",
    "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS",
    "NUMBERED_DECIMAL_NESTED",
    "NUMBERED_UPPERALPHA_ALPHA_ROMAN",
    "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL",
    "NUMBERED_ZERODECIMAL_ALPHA_ROMAN",
  ];

  for (const [i, r] of requests.entries()) {
    const kind = Object.keys(r)[0];
    assert.ok(allowedKeys[kind], `requests[${i}] is a known request type (got ${kind})`);
    assert.deepStrictEqual(
      Object.keys(r[kind]).sort(),
      [...allowedKeys[kind]].sort(),
      `requests[${i}].${kind} carries exactly the documented fields -- a stray/misnamed field is a whole-batch HTTP 400`,
    );
    if (kind === "updateParagraphStyle") {
      assert.strictEqual(r[kind].textStyle, undefined, "updateParagraphStyle must NOT carry the updateTextStyle-only textStyle field");
      assert.ok(r[kind].paragraphStyle.namedStyleType, "the paragraph style is nested under paragraphStyle");
    }
    if (kind === "createParagraphBullets") {
      assert.ok(bulletGlyphPresets.includes(r[kind].bulletPreset), `requests[${i}].bulletPreset ${r[kind].bulletPreset} must be a BulletGlyphPreset value`);
      assert.strictEqual(r[kind].bulletPreset, "BULLET_DISC_CIRCLE_SQUARE", "the canonical disc/circle/square preset");
    }
  }
});
