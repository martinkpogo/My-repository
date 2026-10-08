/**
 * Redline layout for a Proposal's single Google Doc: the current version as
 * clean text on top (exactly what Martin approves), then one "what changed"
 * section per revision, newest first, with removed text marked for strike-
 * through and added text marked as added. Pure text + style ranges -- no
 * Google or Notion I/O -- so the layout is testable and the Doc is only a
 * readable view of the hashed Proposal Content, never its source of truth.
 */
export type DiffKind = "same" | "del" | "add";
export interface DiffSegment {
  kind: DiffKind;
  text: string;
}
export type DocStyleKind = "heading" | "del" | "add";
export interface DocStyleRange {
  /** Doc index, 1-based, UTF-16 code units (what the Docs API counts). */
  start: number;
  end: number;
  kind: DocStyleKind;
}
export interface ProposalDocLayout {
  text: string;
  styles: DocStyleRange[];
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

/**
 * Builds the Doc body. `versions` are every version's Proposal Content in
 * order; the last is the current one. Version 1 alone has no changes section.
 */
export function buildProposalDocLayout(proposalId: string, versions: { version: number; content: string }[]): ProposalDocLayout {
  let text = "";
  const styles: DocStyleRange[] = [];
  const at = () => text.length + 1;
  const heading = (line: string) => {
    styles.push({ start: at(), end: at() + line.length, kind: "heading" });
    text += `${line}\n`;
  };
  const current = versions[versions.length - 1];
  heading(`${proposalId} v${current.version} -- current version`);
  text += `${current.content}\n`;
  if (versions.length > 1) {
    text += "\n";
    heading("Changes");
    text += "Removed text is struck through (red); added text is underlined (green). The text above is the clean current version.\n";
    for (let k = versions.length - 1; k >= 1; k--) {
      text += "\n";
      heading(`v${versions[k].version} compared with v${versions[k - 1].version}`);
      for (const seg of diffWords(versions[k - 1].content, versions[k].content)) {
        if (seg.kind !== "same") styles.push({ start: at(), end: at() + seg.text.length, kind: seg.kind });
        text += seg.text;
      }
      text += "\n";
    }
  }
  return { text, styles };
}
