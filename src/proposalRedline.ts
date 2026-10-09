/**
 * Redline layout for a Proposal's single Google Doc: the current version as
 * clean text on top (exactly what Martin approves), then one "what changed"
 * section per revision, newest first, with removed text marked for strike-
 * through and added text marked as added. Pure text + style ranges -- no
 * Google or Notion I/O -- so the layout is testable and the Doc is only a
 * readable view of the hashed Proposal Content, never its source of truth.
 *
 * The canonical Proposal layout is derived from the content's OWN structure
 * (buildProposalContent's title line, numbered ALL-CAPS section headings,
 * "- " bullets, "  - " nested bullets and "Label: value" lines) and never
 * changes a word of it: `blocks` carry paragraph-level styling only and
 * `styles` carry inline styling only. The redline zone below "Changes"
 * keeps its word-level del/add marks and is never bulletized or re-headed.
 */
export type DiffKind = "same" | "del" | "add";
export interface DiffSegment {
  kind: DiffKind;
  text: string;
}
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
export interface ProposalDocLayout {
  text: string;
  styles: DocStyleRange[];
  blocks: DocBlockRange[];
}

/** Above this many token comparisons the diff falls back to whole-text removed/added rather than risk the Worker's CPU limit. */
const MAX_DIFF_CELLS = 4_000_000;

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function push(out: DiffSegment[], kind: DiffKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** Word-level diff (longest common subsequence) of `before` -> `after`. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const out: DiffSegment[] = [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    push(out, "del", before);
    push(out, "add", after);
    return out;
  }
  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j] ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(out, "same", a[i]);
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      push(out, "del", a[i++]);
    } else {
      push(out, "add", b[j++]);
    }
  }
  while (i < a.length) push(out, "del", a[i++]);
  while (j < b.length) push(out, "add", b[j++]);
  return out;
}

/** A numbered ALL-CAPS section heading exactly as buildProposalContent emits them (e.g. "12. ASSUMPTIONS, DEPENDENCIES, RISKS AND EXCLUSIONS"). */
const SECTION_HEADING_LINE = /^\d{1,3}\. [A-Z0-9][A-Z0-9 ,/()&'.\u2014-]*$/;
/** A "Label: value" line -- the label run (indent excluded, colon included) is bolded; digits and underscores are part of real labels ("Entity_Token", "Workstream 1"). */
const LABEL_LINE = /^(\s{0,2})([A-Za-z][A-Za-z0-9_ &/()'’.\u2014-]{1,60}):(?=\s|$)/;

/**
 * Scans `chunk` (whose every line ends in "\n" unless it is the final line
 * without one) into paragraph blocks starting at Docs index `base`. Each
 * block's range covers the whole paragraph INCLUDING its terminating
 * newline -- exactly what updateParagraphStyle / createParagraphBullets
 * require. With a `classify` function the chunk is treated as structured
 * content (blocks classified, label runs bolded); without one every line is
 * a plain `paragraph` reset. UTF-16-safe: JS string indexing counts the
 * same UTF-16 code units the Docs API counts.
 */
function scanParagraphs(
  chunk: string,
  base: number,
  blocks: DocBlockRange[],
  styles: DocStyleRange[],
  classify: ((line: string, isFirstLine: boolean) => DocBlockKind) | null,
): void {
  let pos = 0;
  let first = true;
  while (pos < chunk.length) {
    const nl = chunk.indexOf("\n", pos);
    const lineEnd = nl === -1 ? chunk.length : nl;
    const line = chunk.slice(pos, lineEnd);
    const start = base + pos;
    const end = start + line.length + (nl === -1 ? 0 : 1);
    blocks.push({ start, end, kind: classify ? classify(line, first) : "paragraph" });
    if (classify) {
      const label = line.match(LABEL_LINE);
      if (label) styles.push({ start: start + label[1].length, end: start + label[0].length, kind: "label" });
    }
    first = false;
    pos = lineEnd + 1;
  }
}

/** Block classification for the clean current-version zone only -- the redline zone below never gets structural blocks. */
function currentZoneBlockKind(line: string, isFirstLine: boolean): DocBlockKind {
  if (isFirstLine) return "title";
  if (line.startsWith("- ")) return "bullet";
  if (line.startsWith("  - ")) return "subBullet";
  if (SECTION_HEADING_LINE.test(line)) return "sectionHeading";
  return "paragraph";
}

/**
 * Builds the Doc body. `versions` are every version's Proposal Content in
 * order; the last is the current one. Version 1 alone has no changes section.
 */
export function buildProposalDocLayout(proposalId: string, versions: { version: number; content: string }[]): ProposalDocLayout {
  let text = "";
  const styles: DocStyleRange[] = [];
  const blocks: DocBlockRange[] = [];
  const at = () => text.length + 1;
  const heading = (line: string, kind: DocBlockKind) => {
    styles.push({ start: at(), end: at() + line.length, kind: "heading" });
    blocks.push({ start: at(), end: at() + line.length + 1, kind });
    text += `${line}\n`;
  };
  const current = versions[versions.length - 1];
  heading(`${proposalId} v${current.version} -- current version`, "heading");
  scanParagraphs(`${current.content}\n`, at(), blocks, styles, currentZoneBlockKind);
  text += `${current.content}\n`;
  if (versions.length > 1) {
    text += "\n";
    heading("Changes", "heading");
    const explanation = "Removed text is struck through (red); added text is underlined (green). The text above is the clean current version.";
    blocks.push({ start: at(), end: at() + explanation.length + 1, kind: "paragraph" });
    text += `${explanation}\n`;
    for (let k = versions.length - 1; k >= 1; k--) {
      text += "\n";
      heading(`v${versions[k].version} compared with v${versions[k - 1].version}`, "revisionHeading");
      const diffStart = at();
      let diffLength = 0;
      for (const seg of diffWords(versions[k - 1].content, versions[k].content)) {
        if (seg.kind !== "same") styles.push({ start: at(), end: at() + seg.text.length, kind: seg.kind });
        text += seg.text;
        diffLength += seg.text.length;
      }
      blocks.push({ start: diffStart, end: diffStart + diffLength + 1, kind: "paragraph" });
      text += "\n";
    }
  }
  return { text, styles, blocks };
}

/** Paragraph styling per block kind: the ONE canonical Proposal layout. */
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
 * The complete canonical styling for a layout as Docs batchUpdate requests:
 * clear any carried inline formatting, set one named paragraph style per
 * paragraph (explicitly resetting every paragraph so a rewrite is
 * deterministic even if a previous body carried heading styles), bulletize
 * the bullet paragraphs, then the inline marks -- bold headings and labels,
 * struck removed text, underlined added text. Style-only by construction:
 * no request here inserts, deletes or replaces a single character of text.
 */
export function buildProposalDocStyleRequests(layout: ProposalDocLayout): unknown[] {
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
    const textStyle: Record<string, unknown> = {
      namedStyleType: p.namedStyleType,
      spaceAbove: { magnitude: p.spaceAbovePt, unit: "PT" },
      spaceBelow: { magnitude: p.spaceBelowPt, unit: "PT" },
    };
    let fields = "namedStyleType,spaceAbove,spaceBelow";
    if (p.indentStartPt) {
      textStyle.indentStart = { magnitude: p.indentStartPt, unit: "PT" };
      fields += ",indentStart";
    }
    requests.push({ updateParagraphStyle: { range: { startIndex: b.start, endIndex: b.end }, textStyle, fields } });
  }
  for (const b of layout.blocks) {
    if (b.kind === "bullet" || b.kind === "subBullet") {
      requests.push({ createParagraphBullets: { range: { startIndex: b.start, endIndex: b.end }, bulletPreset: "BULLET_PRESET_TYPE_DISC_CIRCLE_SQUARE" } });
    }
  }
  for (const r of layout.styles) {
    requests.push({ updateTextStyle: { range: { startIndex: r.start, endIndex: r.end }, ...INLINE_STYLE_REQUEST[r.kind] } });
  }
  return requests;
}
