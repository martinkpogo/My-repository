import type { Env } from "./types";
import { runEnigTurn } from "./chat";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { kvGet, kvPut } from "./kvStore";

/**
 * ENIG's morning brief (the `morning_brief` situation on the canonical
 * Operations — ENIG Hat Definition): once a day, unprompted, ENIG sends
 * Martin the brief in the Workspace topic.
 *
 * A scheduled NOTIFICATION, not an Action: it starts no Work, writes no
 * governed record and needs no approval -- the same shape as the
 * stale-handoff digest. It rides the Worker's ONE existing cron (every 30
 * minutes, wrangler.toml) and throttles itself to once per local day, so
 * no second scheduler exists. Schedule (hour, timezone, days) is non-secret
 * configuration in wrangler.toml [vars]; what the brief says comes live
 * from ENIG's Notion definition via runEnigTurn.
 *
 * The brief is recorded in the Workspace thread's chat history, so Martin
 * replying "tell me more about the second one" continues with ENIG in
 * context. Fails closed: if ENIG's definition is unreadable or the
 * provider returns nothing, no brief is sent that day and one line goes to
 * the Operations topic instead.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface MorningBriefSchedule {
  timeZone: string;
  hour: number;
  days: ReadonlySet<string>;
}

/** Reads the schedule from configuration; null (brief disabled) when any part is missing or invalid. */
export function readMorningBriefSchedule(env: Env): MorningBriefSchedule | null {
  const timeZone = env.MORNING_BRIEF_TIMEZONE?.trim();
  const hour = Number(env.MORNING_BRIEF_HOUR);
  const days = (env.MORNING_BRIEF_DAYS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => (WEEKDAYS as readonly string[]).includes(d));
  if (!timeZone || !Number.isInteger(hour) || hour < 0 || hour > 23 || days.length === 0) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return null;
  }
  return { timeZone, hour, days: new Set(days) };
}

/** The local calendar date ("YYYY-MM-DD") whose brief is due at `now`, or null when none is due. */
export function morningBriefDueDate(now: Date, schedule: MorningBriefSchedule): string | null {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  if (!schedule.days.has(parts.weekday)) return null;
  if (Number(parts.hour) < schedule.hour) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const BRIEF_SITUATION =
  "Scheduled morning brief (situation: morning_brief). Martin has not written; this is ENIG's own unprompted daily brief. Produce the morning_brief exactly as your Hat Definition specifies.";

/**
 * Called from the Worker's scheduled handler on every cron tick. Sends at
 * most one brief per local day; every other call returns without doing
 * anything. The day is claimed before generating, so overlapping ticks or a
 * failed send never produce a second brief.
 */
export async function maybeSendMorningBrief(env: Env, now: Date = new Date()): Promise<void> {
  const schedule = readMorningBriefSchedule(env);
  if (!schedule) return;
  const chatId = env.TELEGRAM_GROUP_CHAT_ID ? Number(env.TELEGRAM_GROUP_CHAT_ID) : undefined;
  const threadId = env.WORKSPACE_TOPIC_ID ? Number(env.WORKSPACE_TOPIC_ID) : undefined;
  if (chatId === undefined || threadId === undefined) {
    console.error("morningBrief: TELEGRAM_GROUP_CHAT_ID or WORKSPACE_TOPIC_ID missing -- no brief sent");
    return;
  }

  const dueDate = morningBriefDueDate(now, schedule);
  if (!dueDate) return;
  const sentKey = `enig_morning_brief:${dueDate}`;
  if (await kvGet(env, sentKey)) return;
  await kvPut(env, sentKey, now.toISOString(), { expirationTtl: 3 * 24 * 60 * 60 });

  const brief = await runEnigTurn(env, chatId, threadId, BRIEF_SITUATION);
  if (!brief) {
    const reason = brief === null ? "ENIG couldn't read its Notion definition (Operations — ENIG)" : "no AI provider returned a brief";
    await sendOperationsMessage(env, `⚠️ No morning brief today (${dueDate}): ${reason}. Nothing was started.`).catch((err) =>
      console.error("morningBrief: failed to report the missed brief to Operations", err),
    );
    return;
  }
  await sendMessage(env, chatId, `☀️ Morning brief — ${dueDate}\n\n${brief}`, undefined, threadId);
}
