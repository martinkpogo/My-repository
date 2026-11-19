/**
 * Test fixture: ONE in-memory Google Doc, faithful enough to serve the
 * read-backs the Google Docs operations VERIFY against.
 *
 * Every Google Docs test fake previously modelled a document as a bare
 * string of text, which could only ever prove "the text came back". Now
 * that a write and an interrupted attempt are verified against the COMPLETE
 * document specification (text AND declared paragraph/inline styling), the
 * fakes must be able to show styling too -- otherwise a correct
 * implementation fails its own tests and an unstyled body would read as
 * verified. This fixture is the single place that models a document body:
 *
 *  - `applyRequests` executes a real Docs `batchUpdate` request list in
 *    order, faithfully (delete/insert splice the body; paragraph-style,
 *    bullet and text-style requests honour their `fields` masks and
 *    ranges), so a fake that lets a pass through ends up showing exactly
 *    what that pass declared;
 *  - `toDocumentJson` renders the body in the real API's paragraph/run
 *    shape (startIndex/endIndex, namedStyleType, bullet, indentStart,
 *    per-run textStyle), which the production readers
 *    (`extractDocText`, `readGoogleDocBody`, `parseGoogleDocStyling`)
 *    parse back;
 *  - `applyLayout`/`fakeDocShowingLayout` apply the ONE production mapping
 *    (`buildDocStyleRequests`) so "already styled" can only ever mean "the
 *    declared specification was applied" -- there is deliberately no
 *    second styling vocabulary in this file, only a faithful server.
 *
 * Paragraphs are derived from the body text, and the body ALWAYS ends in
 * the API's protected final newline (every paragraph's content includes its
 * terminator, including the last -- Google refuses to delete the last
 * newline of a Body), which is what makes index-based read-back
 * verification behave against these fakes exactly as it does against the
 * real API.
 */
import { buildDocStyleRequests, type GoogleDocLayout } from "../googleDocSpec";

/** One body paragraph: its exact text (newline included) plus the styling it carries. */
interface FakeParagraph {
  /** The paragraph's own text, always including its terminating newline (the body's protected final one included). */
  text: string;
  namedStyleType: string;
  bulleted: boolean;
  indentStartPt: number;
}

/** One text run over a 1-based, end-exclusive Doc index range. */
interface FakeTextRun {
  start: number;
  end: number;
  bold: boolean;
  strikethrough: boolean;
  underline: boolean;
}

export interface FakeGoogleDocOptions {
  /** The body the document starts with (defaults to an empty document). */
  text?: string;
}

const DEFAULT_STYLE = { namedStyleType: "NORMAL_TEXT", bulleted: false, indentStartPt: 0 } as const;

/**
 * Splits a body into paragraphs. A real Body ALWAYS ends with a protected
 * newline: every paragraph's `textRun.content` includes its own terminator,
 * including the last one -- the Docs API refuses to delete "the last newline
 * character of a Body" (HTTP 400) and an end-of-segment insert lands
 * "immediately before the last newline". A body given without that newline
 * (a freshly created Doc holding only its inserted content) therefore gains
 * it here, which is what makes the production `endIndex - 1` delete remove
 * exactly the content and leave the protected newline standing.
 */
function splitIntoParagraphs(text: string): FakeParagraph[] {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const lines = body.split("\n");
  return lines.slice(0, -1).map((line) => ({ text: `${line}\n`, ...DEFAULT_STYLE }));
}

/** The 1-based Doc index each paragraph starts at. */
function paragraphStarts(paragraphs: readonly FakeParagraph[]): number[] {
  const starts: number[] = [];
  let index = 1;
  for (const paragraph of paragraphs) {
    starts.push(index);
    index += paragraph.text.length;
  }
  return starts;
}

/** The paragraph containing a 0-based flat-text offset (the last paragraph carries an offset at/after the end). */
function paragraphIndexAt(paragraphs: readonly FakeParagraph[], offset: number): number {
  let acc = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const length = paragraphs[i].text.length;
    if (offset >= acc && offset < acc + length) return i;
    acc += length;
  }
  return paragraphs.length - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export class FakeGoogleDoc {
  private paragraphs: FakeParagraph[];
  private runs: FakeTextRun[] = [];

  constructor(options: FakeGoogleDocOptions = {}) {
    this.paragraphs = splitIntoParagraphs(options.text ?? "");
  }

  /** The body text -- exactly what the production text readers extract from `toDocumentJson()`. */
  get text(): string {
    return this.paragraphs.map((paragraph) => paragraph.text).join("");
  }

  /**
   * Replaces the body wholesale -- the seam a test uses to simulate a
   * hand-edited (drifted) document. The text is replaced and every
   * paragraph returns to the default style, as a body nobody styled would
   * show.
   */
  setText(next: string): void {
    this.paragraphs = splitIntoParagraphs(next);
    this.runs = [];
  }

  /** Executes a real Docs batchUpdate request list, in order, exactly as the API would apply it. */
  applyRequests(requests: readonly unknown[]): void {
    for (const request of requests) this.applyRequest(request);
  }

  /**
   * Applies a layout's styling through the ONE production mapping, so a
   * document "already showing" a layout shows precisely what
   * `buildDocStyleRequests` declares -- never a hand-written approximation.
   */
  applyLayout(layout: GoogleDocLayout): void {
    this.applyRequests(buildDocStyleRequests(layout));
  }

  /** The `GET /documents/:id` response body, in the real API's paragraph/run shape. */
  toDocumentJson(): { body: { content: unknown[] } } {
    const content: unknown[] = [];
    let index = 1;
    for (const paragraph of this.paragraphs) {
      const startIndex = index;
      const endIndex = startIndex + paragraph.text.length;
      content.push({
        startIndex,
        endIndex,
        paragraph: {
          namedStyleType: paragraph.namedStyleType,
          ...(paragraph.bulleted ? { bullet: {} } : {}),
          ...(paragraph.indentStartPt
            ? { paragraphStyle: { indentStart: { magnitude: paragraph.indentStartPt, unit: "PT" } } }
            : {}),
          elements: this.renderElements(paragraph.text, startIndex, endIndex),
        },
      });
      index = endIndex;
    }
    return { body: { content } };
  }

  private applyRequest(request: unknown): void {
    if (typeof request !== "object" || request === null) return;
    const record = request as Record<string, any>;
    if (record.deleteContentRange?.range) {
      this.splice(record.deleteContentRange.range.startIndex ?? 1, record.deleteContentRange.range.endIndex ?? 1, "");
    }
    if (record.insertText) {
      // A location-less insert is an end-of-segment insert: the real API
      // places it immediately before the body's protected final newline.
      const at =
        record.insertText.location?.index ??
        (record.insertText.endOfSegmentLocation ? this.text.length : 1);
      this.splice(at, at, String(record.insertText.text ?? ""));
    }
    if (record.updateParagraphStyle) this.applyParagraphStyle(record.updateParagraphStyle);
    if (record.createParagraphBullets) this.setBullets(record.createParagraphBullets.range, true);
    if (record.deleteParagraphBullets) this.setBullets(record.deleteParagraphBullets.range, false);
    if (record.updateTextStyle) this.applyTextStyle(record.updateTextStyle);
  }

  /** Replaces the doc range [startIndex, endIndex) with `insert`, carrying paragraph styles to their surviving paragraphs and rebasing the runs. */
  private splice(startIndex: number, endIndex: number, insert: string): void {
    const flat = this.text;
    const from = clamp(startIndex - 1, 0, flat.length);
    const to = clamp(endIndex - 1, from, flat.length);
    const oldParagraphs = this.paragraphs;
    const oldRuns = this.runs;
    const newFlat = flat.slice(0, from) + insert + flat.slice(to);

    const rebased: FakeParagraph[] = [];
    let offset = 0;
    for (const paragraph of splitIntoParagraphs(newFlat)) {
      const text = paragraph.text;
      // Map this new paragraph's start back to where it came from: text
      // before the edit keeps its offset, text after it shifts by the edit's
      // delta, and text born inside the inserted run inherits the paragraph
      // at the insertion point (what Google shows for inserted text).
      const newStart = offset;
      let oldOffset: number;
      if (newStart < from) oldOffset = newStart;
      else if (newStart >= from + insert.length) oldOffset = newStart - insert.length + (to - from);
      else oldOffset = from;
      const origin = oldParagraphs.length > 0 ? oldParagraphs[paragraphIndexAt(oldParagraphs, oldOffset)] : null;
      rebased.push({
        text,
        namedStyleType: origin?.namedStyleType ?? DEFAULT_STYLE.namedStyleType,
        bulleted: origin?.bulleted ?? DEFAULT_STYLE.bulleted,
        indentStartPt: origin?.indentStartPt ?? DEFAULT_STYLE.indentStartPt,
      });
      offset += text.length;
    }
    this.paragraphs = rebased;

    // Runs: those before the edit survive, those after it shift by the
    // delta, and any overlapping the replaced range are gone with its text.
    const delta = insert.length - (to - from);
    this.runs = [
      ...oldRuns.filter((run) => run.end <= from),
      ...oldRuns.filter((run) => run.start >= to).map((run) => ({ ...run, start: run.start + delta, end: run.end + delta })),
    ].sort((a, b) => a.start - b.start);
  }

  /** The paragraph indices a paragraph-level request's range selects (range end exclusive; zero-length paragraphs count only when the range starts on them). */
  private paragraphIndicesIn(range: { startIndex?: number; endIndex?: number } | undefined): number[] {
    const from = range?.startIndex ?? 1;
    const to = range?.endIndex ?? Number.MAX_SAFE_INTEGER;
    const starts = paragraphStarts(this.paragraphs);
    const picked: number[] = [];
    this.paragraphs.forEach((paragraph, index) => {
      const start = starts[index];
      const end = start + paragraph.text.length;
      const selected =
        paragraph.text.length === 0 ? start >= from && start < to : start < to && end > from;
      if (selected) picked.push(index);
    });
    return picked;
  }

  private applyParagraphStyle(request: {
    range?: { startIndex?: number; endIndex?: number };
    paragraphStyle?: { namedStyleType?: unknown; indentStart?: { magnitude?: unknown } };
    fields?: unknown;
  }): void {
    const mask = new Set(String(request.fields ?? "").split(",").map((field) => field.trim()).filter(Boolean));
    for (const index of this.paragraphIndicesIn(request.range)) {
      const paragraph = this.paragraphs[index];
      if (mask.has("namedStyleType") && typeof request.paragraphStyle?.namedStyleType === "string") {
        paragraph.namedStyleType = request.paragraphStyle.namedStyleType;
      }
      if (mask.has("indentStart")) {
        const magnitude = request.paragraphStyle?.indentStart?.magnitude;
        paragraph.indentStartPt = typeof magnitude === "number" ? magnitude : 0;
      }
    }
  }

  private setBullets(range: { startIndex?: number; endIndex?: number } | undefined, bulleted: boolean): void {
    for (const index of this.paragraphIndicesIn(range)) this.paragraphs[index].bulleted = bulleted;
  }

  private applyTextStyle(request: {
    range?: { startIndex?: number; endIndex?: number };
    textStyle?: { bold?: unknown; strikethrough?: unknown; underline?: unknown };
    fields?: unknown;
  }): void {
    const docEnd = this.text.length + 1;
    const from = clamp(request.range?.startIndex ?? 1, 1, docEnd);
    const to = clamp(request.range?.endIndex ?? docEnd, from, docEnd);
    if (to <= from) return;
    const mask = new Set(String(request.fields ?? "").split(",").map((field) => field.trim()).filter(Boolean));
    const flagsAt = (point: number): { bold: boolean; strikethrough: boolean; underline: boolean } => {
      for (const run of this.runs) {
        if (run.start <= point && point < run.end) {
          return { bold: run.bold, strikethrough: run.strikethrough, underline: run.underline };
        }
      }
      return { bold: false, strikethrough: false, underline: false };
    };

    // Split the range at its own boundaries and every run boundary inside
    // it, then apply the fields mask to each resulting segment -- exactly
    // how the API honours `fields` over `range`.
    const boundaries = new Set<number>([from, to]);
    for (const run of this.runs) {
      for (const edge of [run.start, run.end]) if (edge > from && edge < to) boundaries.add(edge);
    }
    const edges = [...boundaries].sort((a, b) => a - b);
    const middle: FakeTextRun[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const start = edges[i];
      const end = edges[i + 1];
      const flags = flagsAt(start);
      if (mask.has("bold")) flags.bold = request.textStyle?.bold === true;
      if (mask.has("strikethrough")) flags.strikethrough = request.textStyle?.strikethrough === true;
      if (mask.has("underline")) flags.underline = request.textStyle?.underline === true;
      middle.push({ start, end, ...flags });
    }
    this.runs = [
      ...this.runs.filter((run) => run.end <= from),
      ...middle,
      ...this.runs.filter((run) => run.start >= to).map((run) => ({ ...run })),
    ].sort((a, b) => a.start - b.start);
    this.mergeRuns();
  }

  /** Coalesces adjacent runs that carry identical flags (the API reports one run per style segment). */
  private mergeRuns(): void {
    const merged: FakeTextRun[] = [];
    for (const run of this.runs) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.end === run.start &&
        previous.bold === run.bold &&
        previous.strikethrough === run.strikethrough &&
        previous.underline === run.underline
      ) {
        previous.end = run.end;
      } else {
        merged.push({ ...run });
      }
    }
    this.runs = merged;
  }

  private runAt(point: number): FakeTextRun | null {
    for (const run of this.runs) if (run.start <= point && point < run.end) return run;
    return null;
  }

  /** Splits a paragraph's text into the per-run elements the API reports, carrying each run's inline marks. */
  private renderElements(text: string, paragraphStart: number, paragraphEnd: number): unknown[] {
    if (text.length === 0) return [];
    const boundaries = new Set<number>([paragraphStart, paragraphEnd]);
    for (const run of this.runs) {
      for (const edge of [run.start, run.end]) {
        if (edge > paragraphStart && edge < paragraphEnd) boundaries.add(edge);
      }
    }
    const edges = [...boundaries].sort((a, b) => a - b);
    const elements: unknown[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const start = edges[i];
      const end = edges[i + 1];
      const run = this.runAt(start);
      const marked = run && (run.bold || run.strikethrough || run.underline);
      elements.push({
        textRun: {
          content: this.text.slice(start - 1, end - 1),
          ...(marked
            ? {
                textStyle: {
                  ...(run!.bold ? { bold: true } : {}),
                  ...(run!.strikethrough ? { strikethrough: true } : {}),
                  ...(run!.underline ? { underline: true } : {}),
                },
              }
            : {}),
        },
      });
    }
    return elements;
  }
}

/** A Doc that already shows EXACTLY this layout -- its text with every declared style applied through the production mapping. */
export function fakeDocShowingLayout(layout: GoogleDocLayout): FakeGoogleDoc {
  const doc = new FakeGoogleDoc({ text: layout.text });
  doc.applyLayout(layout);
  return doc;
}
