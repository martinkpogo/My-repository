/**
 * The neutral Google Doc DOCUMENT SPECIFICATION -- the shared Google Docs
 * Tool's input vocabulary and the mapping from it to provider requests
 * (ENIG HQ > 6. Tools > Google Docs, canonical specification).
 *
 * Ownership split, exactly as the specification states:
 *
 *  - the RESOLVED ACTION owns `document_specification`: the business
 *    content, its sections and ordering, the structure (`blocks`), the inline
 *    styling (`styles`) and the presentation intent (`presentation`). The
 *    specification is DECLARATIVE DATA -- text plus validated ranges -- never
 *    executable code and never a raw provider API request;
 *  - THIS module (Tool side) owns input validation, the supported-operation
 *    mapping (a specification's blocks/styles -> the Docs batchUpdate
 *    requests), execution support and read-back verification helpers. It
 *    contains no Proposal logic, no template choice and no default structure:
 *    it maps exactly what it is given and refuses what it cannot support.
 *
 * Everything here is pure (no Google or Notion I/O), so the mapping, the
 * validation and the presentation step are all testable in isolation. The
 * proposal-specific DECISION of what a Proposal Doc should look like stays
 * with the Sales Action's builder (`src/proposalRedline.ts`), which produces
 * a specification for this vocabulary to execute.
 */
import { restoreIdentityPlaceholdersWithRanges } from "./ai/identityRedaction";

/** Inline styling for one text range: bold headings/labels, struck removed text, underlined added text. */
export type DocStyleKind = "heading" | "del" | "add" | "label";

export interface DocStyleRange {
  /** Doc index, 1-based, UTF-16 code units (what the Docs API counts). */
  start: number;
  end: number;
  kind: DocStyleKind;
}

/** Paragraph-level styling for one whole paragraph, including its terminating newline. */
export type DocBlockKind = "title" | "heading" | "revisionHeading" | "sectionHeading" | "paragraph" | "bullet" | "subBullet";

export interface DocBlockRange {
  /** Doc index, 1-based UTF-16 units: the first character of the paragraph. */
  start: number;
  /** Exclusive end: just past the paragraph's terminating newline, as the Docs API requires for paragraph-level requests. */
  end: number;
  kind: DocBlockKind;
}

/** A fully resolved document body: the exact text plus the structure and styling the Action declared for it. */
export interface GoogleDocLayout {
  text: string;
  styles: DocStyleRange[];
  blocks: DocBlockRange[];
}

/**
 * The Action's presentation requirements for this write. A Google Doc is a
 * final internal, human-readable draft, so an Action that assembled its
 * specification over PROTECTED content (the stored/WorkState/provider-bound
 * form) declares `restore_identity_placeholders: true` and the Tool applies
 * the one shared restoration at the write, remapping the declared ranges onto
 * the restored text. The instruction is never inferred: an Action that does
 * not declare it gets its text written verbatim.
 */
export interface DocumentPresentation {
  restore_identity_placeholders: boolean;
}

/**
 * The declarative specification an Action hands the Tool: required `text`,
 * optional paragraph `blocks` and inline `styles` (what the document must
 * show), and optional `presentation` requirements. Unsupported instructions
 * are a validation failure, never a silent drop.
 */
export interface DocumentSpecification {
  text: string;
  styles?: DocStyleRange[];
  blocks?: DocBlockRange[];
  presentation?: DocumentPresentation;
}

const STYLE_KINDS: readonly DocStyleKind[] = ["heading", "del", "add", "label"];
const BLOCK_KINDS: readonly DocBlockKind[] = ["title", "heading", "revisionHeading", "sectionHeading", "paragraph", "bullet", "subBullet"];

/** Bound on declared ranges: beyond this a specification is not a document description but a payload. */
const MAX_RANGES = 10_000;

/** The fields a specification may carry, in canonical order (used in the defect messages). */
const SPEC_FIELDS = ["text", "styles", "blocks", "presentation"];

/** What one operation accepts: `create` writes body text only, `layout` operations also execute structure and styling. */
export interface DocumentSpecificationOptions {
  allow_layout: boolean;
}

/**
 * Validates a `document_specification` exactly: an object with precisely the
 * declared fields, non-empty text, well-formed 1-based ranges that address
 * that text, kinds from the supported vocabulary, and a presentation object
 * with only the declared instruction. An instruction this operation does not
 * support (a `create` that carries `styles`/`blocks`) is an explicit failure,
 * never a silently discarded instruction. Returns the typed specification or
 * the defect that made it invalid.
 */
export function parseDocumentSpecification(value: unknown, options: DocumentSpecificationOptions): DocumentSpecification | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "document_specification must be an object";
  const record = value as Record<string, unknown>;
  const allowed = options.allow_layout ? SPEC_FIELDS : ["text", "presentation"];
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) {
    return options.allow_layout
      ? `document_specification has unknown field "${unknownKey}" -- it is exactly ${allowed.join(", ")}`
      : `document_specification carries "${unknownKey}", which this operation does not support -- an unsupported instruction fails explicitly and is never silently discarded (this operation executes ${allowed.join(", ")})`;
  }
  if (typeof record.text !== "string" || record.text.trim().length === 0) return "document_specification.text must be a non-empty string";

  let styles: DocStyleRange[] | undefined;
  if (record.styles !== undefined) {
    const parsed = parseRanges(record.styles, STYLE_KINDS, "styles", record.text.length);
    if (typeof parsed === "string") return parsed;
    styles = parsed as DocStyleRange[];
  }
  let blocks: DocBlockRange[] | undefined;
  if (record.blocks !== undefined) {
    const parsed = parseRanges(record.blocks, BLOCK_KINDS, "blocks", record.text.length);
    if (typeof parsed === "string") return parsed;
    blocks = parsed as DocBlockRange[];
  }

  let presentation: DocumentPresentation | undefined;
  if (record.presentation !== undefined) {
    const presentationValue = record.presentation;
    if (typeof presentationValue !== "object" || presentationValue === null || Array.isArray(presentationValue)) {
      return "document_specification.presentation must be an object";
    }
    const presentationRecord = presentationValue as Record<string, unknown>;
    const unknownPresentationKey = Object.keys(presentationRecord).find((key) => key !== "restore_identity_placeholders");
    if (unknownPresentationKey !== undefined) {
      return `document_specification.presentation has unknown field "${unknownPresentationKey}" -- it is exactly restore_identity_placeholders`;
    }
    if (typeof presentationRecord.restore_identity_placeholders !== "boolean") {
      return "document_specification.presentation.restore_identity_placeholders must be a boolean";
    }
    presentation = { restore_identity_placeholders: presentationRecord.restore_identity_placeholders };
  }

  return { text: record.text, ...(styles ? { styles } : {}), ...(blocks ? { blocks } : {}), ...(presentation ? { presentation } : {}) };
}

/** Validates one range array: exact entry shape, integer 1-based bounds inside the text, kinds from the operation's vocabulary, bounded count. */
function parseRanges(
  value: unknown,
  kinds: readonly string[],
  field: string,
  textLength: number,
): { start: number; end: number; kind: string }[] | string {
  if (!Array.isArray(value)) return `document_specification.${field} must be an array`;
  if (value.length > MAX_RANGES) return `document_specification.${field} carries more than ${MAX_RANGES} entries -- a document specification of that size is not a document description`;
  const ranges: { start: number; end: number; kind: string }[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `document_specification.${field}[${i}] must be an object with {start, end, kind}`;
    const record = entry as Record<string, unknown>;
    const unexpected = Object.keys(record).find((key) => key !== "start" && key !== "end" && key !== "kind");
    if (unexpected !== undefined) return `document_specification.${field}[${i}] has unknown field "${unexpected}" -- each entry is exactly {start, end, kind}`;
    if (typeof record.start !== "number" || !Number.isInteger(record.start) || record.start < 1) {
      return `document_specification.${field}[${i}].start must be an integer >= 1 (1-based Docs index)`;
    }
    if (typeof record.end !== "number" || !Number.isInteger(record.end) || record.end <= record.start) {
      return `document_specification.${field}[${i}].end must be an integer greater than start`;
    }
    if (record.end > textLength + 1) {
      return `document_specification.${field}[${i}] ends at ${record.end}, past the end of the declared text (${textLength} code units)`;
    }
    if (typeof record.kind !== "string" || !kinds.includes(record.kind)) {
      return `document_specification.${field}[${i}].kind must be one of ${kinds.join(", ")}`;
    }
    ranges.push({ start: record.start, end: record.end, kind: record.kind });
  }
  return ranges;
}

/** The document body a validated specification resolves to, or why it cannot be resolved faithfully. */
export type MaterializedDocument = { ok: true; layout: GoogleDocLayout } | { ok: false; reason: string };

/**
 * Resolves a validated specification into the exact body the operation
 * writes and verifies: the declared text with the declared presentation
 * applied. When the Action declared `restore_identity_placeholders`, the one
 * shared restoration runs here -- at the final internal-presentation boundary
 * of the write itself -- and the declared style/block ranges are remapped
 * onto the restored text by the same function. A range that would split a
 * placeholder is refused (fail-closed), never approximated.
 */
export function materializeDocumentSpecification(specification: DocumentSpecification): MaterializedDocument {
  const styles = specification.styles ?? [];
  const blocks = specification.blocks ?? [];
  if (!specification.presentation?.restore_identity_placeholders) {
    return { ok: true, layout: { text: specification.text, styles, blocks } };
  }
  const restoredStyles = restoreIdentityPlaceholdersWithRanges(specification.text, styles);
  if (!restoredStyles.ok) return { ok: false, reason: `document_specification.styles cannot be applied: ${restoredStyles.reason}` };
  const restoredBlocks = restoreIdentityPlaceholdersWithRanges(specification.text, blocks);
  if (!restoredBlocks.ok) return { ok: false, reason: `document_specification.blocks cannot be applied: ${restoredBlocks.reason}` };
  return { ok: true, layout: { text: restoredStyles.text, styles: restoredStyles.ranges, blocks: restoredBlocks.ranges } };
}

/** Paragraph styling per block kind: the ONE table the Tool maps a specification's blocks onto. */
const PARAGRAPH_STYLES: Record<DocBlockKind, { namedStyleType: string; spaceAbovePt: number; spaceBelowPt: number; indentStartPt?: number }> = {
  title: { namedStyleType: "TITLE", spaceAbovePt: 0, spaceBelowPt: 10 },
  heading: { namedStyleType: "HEADING_2", spaceAbovePt: 12, spaceBelowPt: 6 },
  revisionHeading: { namedStyleType: "HEADING_3", spaceAbovePt: 12, spaceBelowPt: 6 },
  sectionHeading: { namedStyleType: "HEADING_1", spaceAbovePt: 14, spaceBelowPt: 6 },
  paragraph: { namedStyleType: "NORMAL_TEXT", spaceAbovePt: 0, spaceBelowPt: 6 },
  bullet: { namedStyleType: "NORMAL_TEXT", spaceAbovePt: 0, spaceBelowPt: 2 },
  subBullet: { namedStyleType: "NORMAL_TEXT", spaceAbovePt: 0, spaceBelowPt: 2, indentStartPt: 36 },
};

const INLINE_STYLE_REQUEST: Record<DocStyleKind, { textStyle: Record<string, unknown>; fields: string }> = {
  heading: { textStyle: { bold: true }, fields: "bold" },
  label: { textStyle: { bold: true }, fields: "bold" },
  del: { textStyle: { strikethrough: true, foregroundColor: { color: { rgbColor: { red: 0.8, green: 0.1, blue: 0.1 } } } }, fields: "strikethrough,foregroundColor" },
  add: { textStyle: { underline: true, foregroundColor: { color: { rgbColor: { red: 0.05, green: 0.5, blue: 0.2 } } } }, fields: "underline,foregroundColor" },
};

/**
 * The complete styling a resolved layout asks for, as Docs batchUpdate
 * requests: clear any carried inline formatting, set one named paragraph
 * style per paragraph (explicitly resetting every paragraph so a rewrite is
 * deterministic even if a previous body carried heading styles), bulletize
 * the bullet paragraphs, then the inline marks -- bold headings and labels,
 * struck removed text, underlined added text. Style-only by construction:
 * no request here inserts, deletes or replaces a single character of text.
 *
 * Every request uses the exact Docs API v1 `Request` shape, which is not
 * interchangeable between update requests: `updateTextStyle` carries
 * `textStyle`/`fields`, while `updateParagraphStyle` carries
 * `paragraphStyle`/`fields` (there is no `textStyle`). `bulletPreset` must be
 * one of the `BulletGlyphPreset` values; the canonical disc/circle/square
 * preset is `BULLET_DISC_CIRCLE_SQUARE`. An unknown field name or enum value
 * is rejected by batchUpdate as a whole with HTTP 400, so these names are
 * load-bearing, not cosmetic.
 */
export function buildDocStyleRequests(layout: GoogleDocLayout): unknown[] {
  const requests: unknown[] = [];
  requests.push({
    updateTextStyle: {
      range: { startIndex: 1, endIndex: 1 + layout.text.length },
      textStyle: { bold: false, strikethrough: false, underline: false },
      fields: "bold,strikethrough,underline",
    },
  });
  for (const b of layout.blocks) {
    const p = PARAGRAPH_STYLES[b.kind];
    const paragraphStyle: Record<string, unknown> = {
      namedStyleType: p.namedStyleType,
      spaceAbove: { magnitude: p.spaceAbovePt, unit: "PT" },
      spaceBelow: { magnitude: p.spaceBelowPt, unit: "PT" },
    };
    let fields = "namedStyleType,spaceAbove,spaceBelow";
    if (p.indentStartPt) {
      paragraphStyle.indentStart = { magnitude: p.indentStartPt, unit: "PT" };
      fields += ",indentStart";
    }
    requests.push({ updateParagraphStyle: { range: { startIndex: b.start, endIndex: b.end }, paragraphStyle, fields } });
  }
  for (const b of layout.blocks) {
    if (b.kind === "bullet" || b.kind === "subBullet") {
      requests.push({ createParagraphBullets: { range: { startIndex: b.start, endIndex: b.end }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    }
  }
  for (const r of layout.styles) {
    requests.push({ updateTextStyle: { range: { startIndex: r.start, endIndex: r.end }, ...INLINE_STYLE_REQUEST[r.kind] } });
  }
  return requests;
}

/**
 * The paragraph signature each block of a resolved layout must actually show
 * in the Doc: the named style it asks for, whether it is bulleted, and its
 * start indent. Derived from the SAME table the style requests use, so the
 * expected styling and the applied styling can never drift apart. Used by
 * every read-back verification of a document specification -- a write is
 * verified against it, and an interrupted attempt is reconciled against it,
 * because text alone can never show whether styles were applied.
 */
export function expectedDocParagraphStyles(
  layout: GoogleDocLayout,
): { kind: DocBlockKind; namedStyleType: string; bulleted: boolean; indentStartPt: number }[] {
  return layout.blocks.map((block) => {
    const paragraph = PARAGRAPH_STYLES[block.kind];
    return {
      kind: block.kind,
      namedStyleType: paragraph.namedStyleType,
      bulleted: block.kind === "bullet" || block.kind === "subBullet",
      indentStartPt: paragraph.indentStartPt ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Read-back verification: what a document ACTUALLY shows, and whether it
// shows the declared specification. These are the observed shapes a Docs
// read-back is parsed into and the ONE matcher every write and every
// reconciliation uses -- so "verified" can only ever mean "the document
// shows the specification that was declared", and no second formatting
// vocabulary or duplicated verification logic can creep in beside it.
// ---------------------------------------------------------------------------

/** One paragraph's ACTUAL styling, as a document read-back reports it. */
export interface ObservedDocParagraph {
  /** The paragraph's own 1-based Doc index (the structural element's `startIndex`). */
  start: number;
  /** The named style the paragraph carries ("TITLE", "HEADING_1", "HEADING_2", "HEADING_3", "NORMAL_TEXT", ...). */
  namedStyleType: string;
  /** True when the paragraph carries a bullet. */
  bulleted: boolean;
  /** The paragraph's actual start indent, in points (0 when unset). */
  indentStartPt: number;
  /** The paragraph's own text, including its terminating newline. Needed to tell the body's required trailing empty paragraph from a real one. */
  text: string;
}

/** One text run's ACTUAL inline styling, over its own Doc index range (1-based UTF-16 units, end exclusive). */
export interface ObservedDocTextStyle {
  start: number;
  end: number;
  bold: boolean;
  strikethrough: boolean;
  underline: boolean;
}

/** The complete read-back of a document: the text it spells out plus the styling it actually shows. */
export interface ObservedDocStyling {
  text: string;
  paragraphs: ObservedDocParagraph[];
  runs: ObservedDocTextStyle[];
}

/** True when the text runs actually carry the inline marks the layout declares over their exact ranges. */
function inlineMarksMatch(observed: readonly ObservedDocTextStyle[], layout: GoogleDocLayout): boolean {
  const covered = (range: { start: number; end: number }, mark: (run: ObservedDocTextStyle) => boolean): boolean => {
    const overlapping = observed.filter((run) => run.start < range.end && run.end > range.start);
    if (overlapping.length === 0) return false;
    return overlapping.every((run) => mark(run));
  };
  return layout.styles.every((style) => {
    if (style.kind === "heading" || style.kind === "label") return covered(style, (run) => run.bold);
    if (style.kind === "del") return covered(style, (run) => run.strikethrough);
    return covered(style, (run) => run.underline);
  });
}

/**
 * True when a document read-back actually shows the styling this resolved
 * layout declares: every declared block resolves to the paragraph that
 * starts at its index, and that paragraph carries the named style, bullet
 * and indent the SAME mapping table the style requests came from derives;
 * plus every declared inline mark actually present over its exact range.
 *
 * Matching is by BLOCK INDEX rather than by paragraph position, because a
 * layout may legitimately leave paragraphs undeclared (the blank separator
 * lines between zones, the API's own required trailing empty paragraph).
 * Text equality -- checked separately by every caller -- pins the paragraph
 * structure itself, so index-matching each declared block verifies every
 * declared requirement and nothing that was not declared. A block whose
 * paragraph cannot be found fails closed: nothing is assumed about styling
 * that cannot be located.
 */
export function observedStylingMatches(layout: GoogleDocLayout, observed: ObservedDocStyling): boolean {
  const expected = expectedDocParagraphStyles(layout);
  for (let i = 0; i < layout.blocks.length; i++) {
    const block = layout.blocks[i];
    const paragraph = observed.paragraphs.find((candidate) => block.start >= candidate.start && block.start < candidate.start + candidate.text.length);
    if (!paragraph) return false;
    const want = expected[i];
    if (paragraph.namedStyleType !== want.namedStyleType) return false;
    if (paragraph.bulleted !== want.bulleted) return false;
    // Google stores points as exact values here, but compare with a hair of
    // tolerance so a unit conversion cannot read as a mismatch.
    if (Math.abs(paragraph.indentStartPt - want.indentStartPt) > 0.5) return false;
  }
  return inlineMarksMatch(observed.runs, layout);
}
