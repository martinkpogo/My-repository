/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDocStyleRequests,
  expectedDocParagraphStyles,
  materializeDocumentSpecification,
  parseDocumentSpecification,
} from "./googleDocSpec";

/**
 * The shared Google Docs Tool's document-specification contract (ENIG HQ >
 * 6. Tools > Google Docs): the Tool validates exactly what the resolved
 * Action supplies, maps it to supported provider operations, refuses an
 * unsupported instruction explicitly, and applies only the presentation the
 * Action declared -- with the declared ranges kept faithful across the one
 * shared identity restoration.
 */

const TEXT = "PROP-1 v1 -- current version\nScope: two workshops\n- Ship it\n";

const VALID_SPEC = {
  text: TEXT,
  styles: [
    { start: 1, end: 30, kind: "heading" },
    { start: 31, end: 36, kind: "label" },
    { start: TEXT.length - 9, end: TEXT.length - 1, kind: "add" },
  ],
  blocks: [
    { start: 1, end: 30, kind: "heading" },
    { start: 31, end: 51, kind: "paragraph" },
    { start: 52, end: TEXT.length + 1, kind: "bullet" },
  ],
  presentation: { restore_identity_placeholders: true },
};

test("parseDocumentSpecification: a well-formed specification with structure, styling and presentation is accepted unchanged", () => {
  const parsed = parseDocumentSpecification(VALID_SPEC, { allow_layout: true });
  assert.notEqual(typeof parsed, "string", typeof parsed === "string" ? parsed : "");
  assert.deepEqual(parsed, VALID_SPEC);
});

test("parseDocumentSpecification: the contract is exact -- non-objects, blank text, unknown fields and malformed ranges are refused with a reason", () => {
  const defects: [unknown, RegExp][] = [
    ["a string", /must be an object/],
    [null, /must be an object/],
    [{ styles: [] }, /text must be a non-empty string/],
    [{ text: "   " }, /text must be a non-empty string/],
    [{ text: TEXT, extra: 1 }, /unknown field "extra"/],
    [{ text: TEXT, styles: "bold" }, /styles must be an array/],
    [{ text: TEXT, styles: [{ start: 0, end: 4, kind: "heading" }] }, /start must be an integer >= 1/],
    [{ text: TEXT, styles: [{ start: 5, end: 5, kind: "heading" }] }, /end must be an integer greater than start/],
    [{ text: TEXT, styles: [{ start: 1, end: TEXT.length + 9, kind: "heading" }] }, /past the end of the declared text/],
    [{ text: TEXT, styles: [{ start: 1, end: 4, kind: "shout" }] }, /kind must be one of heading, del, add, label/],
    [{ text: TEXT, blocks: [{ start: 1, end: 4, kind: "paragraph", note: "x" }] }, /unknown field "note"/],
    [{ text: TEXT, presentation: { restore_identity_placeholders: "yes" } }, /must be a boolean/],
    [{ text: TEXT, presentation: { redact_names: true } }, /unknown field "redact_names"/],
  ];
  for (const [value, expected] of defects) {
    const parsed = parseDocumentSpecification(value, { allow_layout: true });
    assert.equal(typeof parsed, "string", `${JSON.stringify(value)} must be refused`);
    assert.match(parsed as string, expected, `defect for ${JSON.stringify(value)}`);
  }
});

test("parseDocumentSpecification: an instruction this operation does not support fails explicitly -- it is never silently discarded", () => {
  const withStyles = parseDocumentSpecification({ text: TEXT, styles: VALID_SPEC.styles }, { allow_layout: false });
  assert.equal(typeof withStyles, "string");
  assert.match(withStyles as string, /carries "styles", which this operation does not support/);
  assert.match(withStyles as string, /never silently discarded/);

  const withBlocks = parseDocumentSpecification({ text: TEXT, blocks: VALID_SPEC.blocks }, { allow_layout: false });
  assert.equal(typeof withBlocks, "string");
  assert.match(withBlocks as string, /carries "blocks", which this operation does not support/);

  // Text plus presentation is exactly what a body-only operation executes.
  const textOnly = parseDocumentSpecification({ text: TEXT, presentation: { restore_identity_placeholders: true } }, { allow_layout: false });
  assert.notEqual(typeof textOnly, "string");
});

test("materializeDocumentSpecification: without a presentation instruction the declared body is executed verbatim", () => {
  const parsed = parseDocumentSpecification({ text: "[ENIG_OPERATOR] wrote this.\n", styles: [{ start: 1, end: 28, kind: "heading" }] }, { allow_layout: true });
  assert.notEqual(typeof parsed, "string");
  const materialized = materializeDocumentSpecification(parsed as Exclude<typeof parsed, string>);
  assert.ok(materialized.ok, materialized.ok ? "" : materialized.reason);
  assert.equal(materialized.layout.text, "[ENIG_OPERATOR] wrote this.\n", "no restoration happens unless the Action asks for it");
  assert.deepEqual(materialized.layout.styles, [{ start: 1, end: 28, kind: "heading" }]);
});

test("materializeDocumentSpecification: the declared restoration runs and every declared range is remapped onto the restored text", () => {
  const protectedText = "[ENIG_OPERATOR] should review this.\nScope: workshops\n";
  const spec = {
    text: protectedText,
    // The heading line and its paragraph block both cover the placeholder.
    styles: [{ start: 1, end: 36, kind: "heading" as const }],
    blocks: [{ start: 1, end: 36, kind: "title" as const }],
    presentation: { restore_identity_placeholders: true },
  };
  const materialized = materializeDocumentSpecification(spec);
  assert.ok(materialized.ok, materialized.ok ? "" : materialized.reason);
  assert.equal(materialized.layout.text, "Martin should review this.\nScope: workshops\n");
  // "[ENIG_OPERATOR]" (15 units) -> "Martin" (6): everything after it moves by 9.
  assert.deepEqual(materialized.layout.styles, [{ start: 1, end: 27, kind: "heading" }]);
  assert.deepEqual(materialized.layout.blocks, [{ start: 1, end: 27, kind: "title" }]);
  for (const range of [...materialized.layout.styles, ...materialized.layout.blocks]) {
    assert.ok(range.end <= materialized.layout.text.length + 1, "a remapped range never runs past the restored text");
  }
  assert.equal(
    materialized.layout.text.slice(materialized.layout.styles[0].start - 1, materialized.layout.styles[0].end - 1),
    "Martin should review this.",
    "the remapped range still addresses exactly the text it was meant to style",
  );
});

test("materializeDocumentSpecification: a range that would split a placeholder is refused, never approximated", () => {
  const materialized = materializeDocumentSpecification({
    text: "abc[ENIG_OPERATOR]def",
    styles: [{ start: 5, end: 9, kind: "del" }],
    presentation: { restore_identity_placeholders: true },
  });
  assert.equal(materialized.ok, false);
  assert.match(materialized.ok ? "" : materialized.reason, /splits an identity placeholder/);
  assert.match(materialized.ok ? "" : materialized.reason, /styles/);
});

test("buildDocStyleRequests: a resolved specification maps to style-only Docs requests, one per declared block and inline mark", () => {
  const parsed = parseDocumentSpecification(VALID_SPEC, { allow_layout: true });
  assert.notEqual(typeof parsed, "string");
  const materialized = materializeDocumentSpecification(parsed as Exclude<typeof parsed, string>);
  assert.ok(materialized.ok, materialized.ok ? "" : materialized.reason);

  const requests = buildDocStyleRequests(materialized.layout) as any[];
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.ok(request.updateTextStyle || request.updateParagraphStyle || request.createParagraphBullets, "only style requests");
    assert.ok(!request.insertText && !request.deleteContentRange, "never a text mutation");
  }
  const paragraphKinds = requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle.paragraphStyle.namedStyleType);
  assert.deepEqual(paragraphKinds, ["HEADING_2", "NORMAL_TEXT", "NORMAL_TEXT"], "one named style per declared block, in the declared order");
  assert.ok(
    requests.some((r) => r.createParagraphBullets && r.createParagraphBullets.bulletPreset === "BULLET_DISC_CIRCLE_SQUARE"),
    "the declared bullet block is bulletized with the accepted preset",
  );

  const expected = expectedDocParagraphStyles(materialized.layout);
  assert.deepEqual(
    expected.map((p) => p.namedStyleType),
    paragraphKinds,
    "the verification table and the request table can never drift apart",
  );
  assert.equal(expected[2].bulleted, true);
});
