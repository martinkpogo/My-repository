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
  reason?: "run_limit" | "daily_limit";
}
export const runGaps = new WeakMap<object, RunGaps>();

function noteLimit(env: Env, reason: "run_limit" | "daily_limit"): void {
  const run = currentRun();
  if (!run) return;
  const gaps = runGaps.get(run) ?? { question: "", gaps: [] };
  gaps.reason = reason;
  runGaps.set(run, gaps);
  reportLiveStep(reason === "run_limit" ? "Web search limit for this job reached" : "Daily web search limit reached");
  if (limitNoted.has(run)) return;
  limitNoted.add(run);
  run.endHooks.push(() => postLimitCard(env, run));
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
  const head = info.reason === "daily_limit" ? `The daily web search limit (${(await readDaily(env)).limit}) was reached, so the answer above used what was found so far.` : `The web search limit for that job (${RUN_LIMIT}) was reached, so the answer above used what was found so far.`;
  await sendMessage(env, run.target.chatId, `${head}${gapText}`, buttons, run.target.threadId);
}

