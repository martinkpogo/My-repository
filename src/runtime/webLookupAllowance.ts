import type { Env } from "../types";
import { currentRun, reportLiveStep } from "./liveStatus";
import { kvGet, kvPut } from "../kvStore";
import { sendMessage, type InlineButton } from "../telegram";

/**
 * The ceilings on universal web research (Martin, 2026-11-11): RUN_LIMIT
 * lookups per run and DAILY_LIMIT per day, counted at the one place every
 * web search passes through (executeSearch). A ceiling never stops work
 * silently: the live status says so, and the run ends with one card --
 * 🔎 Research more (gaps only) or ✅ That's enough, or at the daily ceiling
 * "Allow 50 more today" -- so Martin, not the AI, decides when a job is
 * worth more searching. Kept import-light so the search code can use it
 * without loading the research tool.
 */

export const RUN_LIMIT = 10;
export const RUN_EXTENSION = 10;
export const DAILY_LIMIT = 200;
export const DAILY_EXTENSION = 50;
export const WEB_RESEARCH_CALLBACK = "webresearch";
/** Work-scoped research buttons (option B): "continue" to draft, "deep" to start Deep Research. Handled by the Work itself. */
export const RESEARCH_WORK_CALLBACK = "researchwork";

const CARD_TTL_SECONDS = 2 * 24 * 60 * 60;


function todayKey(): string {
  return `web_research_count:${new Date().toISOString().slice(0, 10)}`;
}

export async function readDaily(env: Env): Promise<{ used: number; limit: number }> {
  try {
    const raw = await kvGet(env, todayKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return { used: Number(parsed.used) || 0, limit: Number(parsed.limit) || DAILY_LIMIT };
  } catch {
    return { used: 0, limit: DAILY_LIMIT };
  }
}

export async function writeDaily(env: Env, value: { used: number; limit: number }): Promise<void> {
  await kvPut(env, todayKey(), JSON.stringify(value), { expirationTtl: CARD_TTL_SECONDS }).catch((err) => console.error("webResearch: daily count not saved", err));
}

export type LookupAllowance = { ok: true } | { ok: false; reason: "run_limit" | "daily_limit" };

/**
 * Called by executeSearch before every web search: counts it against the
 * run's ceiling and the day's. Outside a run only the daily ceiling applies.
 */
export async function takeWebLookup(env: Env): Promise<LookupAllowance> {
  const run = currentRun();
  if (run) {
    const limit = run.searchLimit || RUN_LIMIT;
    if (run.searches >= limit) {
      noteLimit(env, "run_limit");
      return { ok: false, reason: "run_limit" };
    }
  }
  const daily = await readDaily(env);
  if (daily.used >= daily.limit) {
    noteLimit(env, "daily_limit");
    return { ok: false, reason: "daily_limit" };
  }
  await writeDaily(env, { used: daily.used + 1, limit: daily.limit });
  if (run) run.searches++;
  return { ok: true };
}

const limitNoted = new WeakSet<object>();
export interface RunGaps {
  question: string;
  gaps: string[];
  reason?: "run_limit" | "daily_limit" | "providers_busy";
  /** For providers_busy: when a provider is expected back, and how far the job got. */
  retryAt?: string;
  completed?: number;
  total?: number;
  /** True when the owning Work will resume the research on its own alarm. */
  resumesAutomatically?: boolean;
}
export const runGaps = new WeakMap<object, RunGaps>();

function noteLimit(env: Env, reason: "run_limit" | "daily_limit"): void {
  const run = currentRun();
  if (!run) return;
  const gaps = runGaps.get(run) ?? { question: "", gaps: [] };
  gaps.reason = reason;
  runGaps.set(run, gaps);
  reportLiveStep(reason === "run_limit" ? "Web search limit for this job reached" : "Daily web search limit reached");
  armLimitCard(env, run);
}

function armLimitCard(env: Env, run: NonNullable<ReturnType<typeof currentRun>>): void {
  if (limitNoted.has(run)) return;
  limitNoted.add(run);
  run.endHooks.push(() => postLimitCard(env, run));
}

/**
 * Research was interrupted because every eligible search provider is busy
 * (BD-15). The run ends with one card saying so plainly -- research paused,
 * how far it got, when providers are expected back -- so an incomplete job is
 * never mistaken for a finished one. Outside a run there is no card.
 */
export function noteResearchInterrupted(env: Env, question: string, outcome: { retryAt?: string; completedOperations: number; totalOperations: number; resumesAutomatically?: boolean }): void {
  const run = currentRun();
  if (!run) return;
  const gaps = runGaps.get(run) ?? { question, gaps: [] };
  gaps.question = gaps.question || question;
  gaps.reason = "providers_busy";
  if (outcome.retryAt) gaps.retryAt = outcome.retryAt;
  gaps.completed = outcome.completedOperations;
  gaps.total = outcome.totalOperations;
  gaps.resumesAutomatically = outcome.resumesAutomatically === true;
  runGaps.set(run, gaps);
  reportLiveStep("Web research paused: search providers busy");
  armLimitCard(env, run);
}

/** True when research in the CURRENT run paused because providers were busy -- the Hat should hold its draft (option B). */
export function researchPausedInRun(): boolean {
  const run = currentRun();
  return Boolean(run && runGaps.get(run)?.reason === "providers_busy");
}

/** "14:05 UTC" for a retry time, or null when none is known. */
export function retryTimeLabel(retryAt: string | undefined): string | null {
  const ms = retryAt ? Date.parse(retryAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** After a run that hit a ceiling: one card offering more research on the gaps only, or more searches today. */
async function postLimitCard(env: Env, run: NonNullable<ReturnType<typeof currentRun>>): Promise<void> {
  const info = runGaps.get(run);
  if (!info) return;
  const id = crypto.randomUUID().slice(0, 12);
  await kvPut(env, `web_research_card:${id}`, JSON.stringify({ question: info.question, gaps: info.gaps }), { expirationTtl: CARD_TTL_SECONDS });
  const gapText = info.gaps.length ? `\n\nNot yet established:\n${info.gaps.slice(0, 5).map((g) => `• ${g}`).join("\n")}` : "";
  const buttons: InlineButton[][] =
    info.reason === "daily_limit"
      ? [[{ text: `Allow ${DAILY_EXTENSION} more today`, callback_data: `${WEB_RESEARCH_CALLBACK}:${id}:allow` }, { text: "✅ That's enough", callback_data: `${WEB_RESEARCH_CALLBACK}:${id}:done` }]]
      : [[{ text: `🔎 Research more (${RUN_EXTENSION} more)`, callback_data: `${WEB_RESEARCH_CALLBACK}:${id}:more` }, { text: "✅ That's enough", callback_data: `${WEB_RESEARCH_CALLBACK}:${id}:done` }]];
  if (info.reason === "providers_busy") {
    const when = retryTimeLabel(info.retryAt);
    const progress = info.total ? ` ${info.completed ?? 0} of ${info.total} searches are done and saved.` : "";
    const text = `⏸ Web research paused: the search providers are busy (rate-limited or temporarily down), so this step could not use it yet.${progress}${when ? ` They should be back around ${when}.` : ""} ${info.resumesAutomatically ? `Research resumes on its own${when ? ` around ${when}` : ""} from where it stopped, and you'll get a message when it is complete.` : "Research continues from where it stopped the next time this work researches the same question."}`;
    const workId = run.access?.kind === "work_session" ? run.access.workId : undefined;
    const busyButtons: InlineButton[][] = [
      [{ text: "🔎 Try research again", callback_data: `${WEB_RESEARCH_CALLBACK}:${id}:more` }, { text: "✅ That's enough", callback_data: `${WEB_RESEARCH_CALLBACK}:${id}:done` }],
      // Deep Research is only ever started by Martin's explicit tap (BD-16).
      ...(workId ? [[{ text: "🔬 Deep research", callback_data: `${RESEARCH_WORK_CALLBACK}:${workId}:deep` }]] : []),
    ];
    await sendMessage(env, run.target.chatId, text, busyButtons, run.target.threadId);
    return;
  }
  const head = info.reason === "daily_limit" ? `The daily web search limit (${(await readDaily(env)).limit}) was reached, so the answer above used what was found so far.` : `The web search limit for that job (${RUN_LIMIT}) was reached, so the answer above used what was found so far.`;
  await sendMessage(env, run.target.chatId, `${head}${gapText}`, buttons, run.target.threadId);
}

