import type { Env } from "../../types";
import { generate } from "../../ai";
import type { AccessContext } from "../../access";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { executeSearch, type SearchOutcome } from "./webSearch";
import { readWebPage, unsafeUrlReason, type PageReadOutcome } from "./webPageRead";

// ---------------------------------------------------------------------------
// Skill-guided research rounds on the Research Runtime (Research Runtime
// decision, Martin 15 Nov 2026; build step 3).
//
// The Worker, following a research Skill, decides each round's operations;
// this module is MACHINERY only. Each round:
//   1. one AI step (task research.skill_step) runs under the Skill's method
//      and answers in a fixed JSON shape: the next batch of operations, the
//      evidence notes it can now support, and whether it is done;
//   2. the runtime validates that answer against the round limits and the
//      Tools' own input rules, then dispatches the whole batch IN PARALLEL to
//      the canonical handlers -- executeSearch and readWebPage, which evaluate
//      Access before every request and enforce ENIG's allowances;
//   3. results are bounded and handed back to the next step.
// It never decides what to search, what to read or when the method is
// satisfied, and it holds no methodology of its own. Rounds are batched, not
// one operation at a time (HO-86).
//
// Notes are provenance-checked: a note is kept only if its URL was actually
// retrieved in this job AND its quote literally appears in what was
// retrieved from that URL. Anything else is dropped as unverifiable.
//
// Not built here (build step 4): per-round checkpoints, the 7-day notes
// cache, and the deep_research Skill that is this module's first consumer.
// ---------------------------------------------------------------------------

export type ResearchOperation = { type: "search"; query: string } | { type: "read_page"; url: string };

export interface EvidenceNote {
  fact: string;
  quote: string;
  url: string;
}

/** The limits one research mode runs within. Enforced here; the Skill decides how to use them. */
export interface RoundLimits {
  maxRounds: number;
  /** Searches allowed in each round, by round index. */
  searchesPerRound: readonly number[];
  pagesPerRound: number;
  maxPages: number;
  /** Bounded notes: at most this many per page, and this many characters each. */
  maxNotesPerSource: number;
  maxNoteChars: number;
  /** Bounded characters of each result handed back to the step. */
  maxResultChars: number;
}

/** BD-16 limits for Deep Research: 3 rounds, 12 searches (6, 4, 2), 12 pages (5 per round), notes of about 600 characters with up to 6 facts per page. */
export const DEEP_RESEARCH_LIMITS: RoundLimits = {
  maxRounds: 3,
  searchesPerRound: [6, 4, 2],
  pagesPerRound: 5,
  maxPages: 12,
  maxNotesPerSource: 6,
  maxNoteChars: 600,
  maxResultChars: 2500,
};

export interface StepAnswer {
  operations: ResearchOperation[];
  notes: EvidenceNote[];
  done: boolean;
}

export const SKILL_STEP_RESPONSE_FORMAT = [
  "=== RESPONSE FORMAT (execution mechanics -- not part of the method above) ===",
  `Return JSON exactly matching this shape:
{
  "operations": [{"type": "search", "query": "<a concrete searchable question>"} | {"type": "read_page", "url": "<a URL that appeared in the results below>"}],
  "notes": [{"fact": "<one fact the evidence supports>", "quote": "<the exact words from the result that support it>", "url": "<the URL it came from>"}],
  "done": true | false
}
Return an empty "operations" list with "done": true when the method's completion criteria are met. Every note's quote is checked against the text actually retrieved from its URL and dropped if it does not literally appear there.`,
].join("\n\n");

/** Validates a step's answer against the round's limits. Operations over a limit are dropped (the step is told on the next round), never silently run. */
export function parseStepAnswer(raw: unknown, limits: RoundLimits, round: number, pagesSoFar: number, retrievedUrls: ReadonlySet<string>): { answer: StepAnswer; refused: string[] } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "the research step returned no usable answer" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.operations) || typeof r.done !== "boolean") return { error: "the research step's answer is not in the required shape" };
  const refused: string[] = [];
  const operations: ResearchOperation[] = [];
  let searches = 0;
  let pages = 0;
  const searchCap = limits.searchesPerRound[round] ?? 0;
  const pageCap = Math.min(limits.pagesPerRound, Math.max(0, limits.maxPages - pagesSoFar));
  for (const op of r.operations as unknown[]) {
    const o = (op && typeof op === "object" ? op : {}) as Record<string, unknown>;
    if (o.type === "search" && typeof o.query === "string" && o.query.trim()) {
      if (searches >= searchCap) {
        refused.push(`search over this round's limit of ${searchCap}`);
        continue;
      }
      searches++;
      operations.push({ type: "search", query: redactIdentityTerms(o.query.trim()) });
    } else if (o.type === "read_page" && typeof o.url === "string") {
      const url = o.url.trim();
      if (!retrievedUrls.has(url)) {
        refused.push(`read_page for a URL that did not appear in the results (${url.slice(0, 80)})`);
        continue;
      }
      const unsafe = unsafeUrlReason(url);
      if (unsafe) {
        refused.push(`read_page refused: ${unsafe}`);
        continue;
      }
      if (pages >= pageCap) {
        refused.push(`page read over this round's limit of ${pageCap}`);
        continue;
      }
      pages++;
      operations.push({ type: "read_page", url });
    } else {
      refused.push("an operation that is neither a search nor a page read");
    }
  }
  const notes: EvidenceNote[] = Array.isArray(r.notes)
    ? (r.notes as unknown[])
        .map((n) => (n && typeof n === "object" ? (n as Record<string, unknown>) : {}))
        .filter((n) => typeof n.fact === "string" && typeof n.quote === "string" && typeof n.url === "string")
        .map((n) => ({ fact: String(n.fact).slice(0, limits.maxNoteChars), quote: String(n.quote).slice(0, limits.maxNoteChars), url: String(n.url).trim() }))
    : [];
  return { answer: { operations, notes, done: r.done }, refused };
}

export interface OperationResult {
  operation: ResearchOperation;
  outcome: SearchOutcome["kind"] | PageReadOutcome["kind"];
  /** Bounded text handed back to the step; for a search, its results; for a page, its text. */
  text: string;
  /** URLs this operation retrieved, with the text retrieved from each (for provenance checks). */
  retrieved: Array<{ url: string; text: string }>;
  retryAt?: string;
}

/** Runs one round's batch in parallel through the canonical Tool handlers. Access denials propagate (never caught). */
export async function dispatchOperations(env: Env, operations: readonly ResearchOperation[], access: AccessContext, limits: RoundLimits): Promise<OperationResult[]> {
  return Promise.all(
    operations.map(async (operation): Promise<OperationResult> => {
      if (operation.type === "search") {
        const outcome = await executeSearch(env, { query: operation.query }, access);
        if (outcome.kind === "success_with_results") {
          const retrieved = outcome.results.map((r) => ({ url: r.url, text: `${r.title} ${r.snippet}` }));
          const text = outcome.results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`).join("\n").slice(0, limits.maxResultChars);
          return { operation, outcome: outcome.kind, text, retrieved };
        }
        return { operation, outcome: outcome.kind, text: "", retrieved: [], ...(outcome.kind === "interrupted" && outcome.retry_at ? { retryAt: outcome.retry_at } : {}) };
      }
      const outcome = await readWebPage(env, { url: operation.url }, access);
      if (outcome.kind === "success") {
        return { operation, outcome: outcome.kind, text: outcome.result.text.slice(0, limits.maxResultChars), retrieved: [{ url: operation.url, text: outcome.result.text }] };
      }
      return { operation, outcome: outcome.kind, text: "", retrieved: [], ...(outcome.kind === "interrupted" && outcome.retry_at ? { retryAt: outcome.retry_at } : {}) };
    }),
  );
}

/** Keeps only notes whose URL was retrieved in this job and whose quote literally appears in what was retrieved from it; caps notes per source. */
export function verifyNotes(notes: readonly EvidenceNote[], retrieved: ReadonlyMap<string, string>, limits: RoundLimits, existing: readonly EvidenceNote[]): { kept: EvidenceNote[]; dropped: number } {
  const perSource = new Map<string, number>();
  for (const n of existing) perSource.set(n.url, (perSource.get(n.url) ?? 0) + 1);
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const kept: EvidenceNote[] = [];
  let dropped = 0;
  for (const note of notes) {
    const source = retrieved.get(note.url);
    if (!source || !note.quote.trim() || !norm(source).includes(norm(note.quote))) {
      dropped++;
      continue;
    }
    const count = perSource.get(note.url) ?? 0;
    if (count >= limits.maxNotesPerSource) {
      dropped++;
      continue;
    }
    perSource.set(note.url, count + 1);
    kept.push(note);
  }
  return { kept, dropped };
}

export type SkillRoundsOutcome =
  | { status: "completed"; notes: EvidenceNote[]; rounds: number; operations: number; droppedNotes: number }
  | { status: "interrupted"; notes: EvidenceNote[]; rounds: number; reason: string; retryAt?: string }
  | { status: "blocked"; reason: string };

export interface SkillRoundsInput {
  /** The research Skill's methodology content, already resolved and integrity-verified by the caller. */
  skillContent: string;
  /** The identity-scrubbed research question. */
  question: string;
  /** Framing context the step may use (e.g. the authorized research category); never treated as a source. */
  context: string;
  limits: RoundLimits;
}

/**
 * Runs the rounds: step -> validated batch -> parallel dispatch -> results
 * back to the next step, until the step says done, returns no operations,
 * or the round limit is reached. An operation interrupted because providers
 * are busy stops the job as `interrupted` (nothing is concluded from partial
 * evidence); the caller owns persistence and resume.
 */
export async function runSkillRounds(env: Env, input: SkillRoundsInput, access: AccessContext): Promise<SkillRoundsOutcome> {
  const notes: EvidenceNote[] = [];
  const retrieved = new Map<string, string>();
  let lastResults: OperationResult[] = [];
  let refusedLastRound: string[] = [];
  let pages = 0;
  let operationsRun = 0;
  let droppedNotes = 0;

  for (let round = 0; round <= input.limits.maxRounds; round++) {
    const finalStep = round === input.limits.maxRounds;
    const situation = [
      `RESEARCH QUESTION: ${input.question}`,
      `ROUND ${round + 1} of at most ${input.limits.maxRounds + 1} steps. ${finalStep ? "This is the final step: request no operations; record notes and finish." : `This round you may request up to ${input.limits.searchesPerRound[round] ?? 0} searches and ${Math.min(input.limits.pagesPerRound, input.limits.maxPages - pages)} page reads.`}`,
      refusedLastRound.length ? `NOT RUN LAST ROUND (over a limit or invalid): ${refusedLastRound.join("; ")}` : "",
      lastResults.length
        ? `RESULTS FROM LAST ROUND:\n${lastResults.map((r) => `[${r.operation.type === "search" ? `search "${r.operation.query}"` : `read ${r.operation.url}`} -> ${r.outcome}]\n${r.text}`).join("\n\n")}`
        : "No operations have run yet.",
      notes.length ? `NOTES SO FAR:\n${notes.map((n) => `- ${n.fact} (${n.url})`).join("\n")}` : "No notes yet.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const raw = await generate(env, {
      taskId: "research.skill_step",
      mode: "json",
      parts: {
        persona: "You are carrying out one step of a research method for a strategy-led consultancy, using only public sources that are retrieved for you. Never assume, infer or introduce any company name, person, proprietary detail or fact that is not in the retrieved results.",
        skillContent: ["=== RESEARCH METHOD (the Skill you follow) ===", input.skillContent].join("\n\n"),
        context: [input.context ? `=== FRAMING (not a source) ===\n${input.context}` : "", SKILL_STEP_RESPONSE_FORMAT].filter(Boolean).join("\n\n"),
        situation,
      },
      maxTokens: 2048,
    });
    const parsed = parseStepAnswer(raw, input.limits, round, pages, new Set(retrieved.keys()));
    if ("error" in parsed) return { status: "blocked", reason: parsed.error };

    const verified = verifyNotes(parsed.answer.notes, retrieved, input.limits, notes);
    notes.push(...verified.kept);
    droppedNotes += verified.dropped;
    refusedLastRound = parsed.refused;

    if (finalStep || parsed.answer.done || parsed.answer.operations.length === 0) {
      return { status: "completed", notes, rounds: round, operations: operationsRun, droppedNotes };
    }

    lastResults = await dispatchOperations(env, parsed.answer.operations, access, input.limits);
    operationsRun += lastResults.length;
    pages += lastResults.filter((r) => r.operation.type === "read_page").length;
    for (const r of lastResults) for (const item of r.retrieved) retrieved.set(item.url, `${retrieved.get(item.url) ?? ""}\n${item.text}`);

    const interrupted = lastResults.filter((r) => r.outcome === "interrupted");
    if (interrupted.length) {
      const retryAt = interrupted.map((r) => r.retryAt).filter((t): t is string => Boolean(t)).sort()[0];
      return {
        status: "interrupted",
        notes,
        rounds: round + 1,
        reason: `${interrupted.length} of ${lastResults.length} operations in round ${round + 1} could not run because providers are busy. Nothing was concluded from the partial evidence.`,
        ...(retryAt ? { retryAt } : {}),
      };
    }
  }
  return { status: "completed", notes, rounds: input.limits.maxRounds, operations: operationsRun, droppedNotes };
}
