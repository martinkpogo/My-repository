import test from "node:test";
import assert from "node:assert";
import { maybeSendMorningBrief, morningBriefDueDate, readMorningBriefSchedule, spaceBriefLines } from "./morningBrief";
import { ENIG_HAT_DEFINITION_PAGE_ID, getChatHistory } from "./chat";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "./governance";
import type { Env } from "./types";

/**
 * ENIG's morning brief: when it is due (Martin's schedule -- 10:00
 * Africa/Accra, every day except Sunday), that it is sent at most once per
 * local day, that it lands in the Workspace topic and ENIG's history there,
 * and that it fails closed to an Operations notice instead of a brief.
 */

function createMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

const GOVERNANCE_CACHE = {
  [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "purpose: Keep Martin oriented. morning_brief: lead with approvals.",
  [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
};

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_GROUP_CHAT_ID: "-100",
    WORKSPACE_TOPIC_ID: "604",
    OPERATIONS_TOPIC_ID: "588",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-ds",
    AI_MODEL_LIGHT: "test-light-model",
    AI_MODEL_PRIMARY: "test-primary-model",
    MORNING_BRIEF_TIMEZONE: "Africa/Accra",
    MORNING_BRIEF_HOUR: "10",
    MORNING_BRIEF_DAYS: "Mon,Tue,Wed,Thu,Fri,Sat",
    STATE_KV: createMockKv(GOVERNANCE_CACHE) as any,
    AI: { run: async () => ({ response: "Waiting on you: nothing. Where we are: MAT-12 Qualified. Next: review MAT-12." }) } as any,
    ...overrides,
  } as Env;
}

/** Fakes Notion (empty data sources; any page read fails) and records every Telegram send. */
function mockFetch(t: any): Array<{ chat_id: number; message_thread_id?: number; text: string }> {
  const sent: Array<{ chat_id: number; message_thread_id?: number; text: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
    }
    if (/\/data_sources\/[^/]+\/query/.test(u)) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return sent;
}

const schedule = readMorningBriefSchedule(fakeEnv())!;

test("schedule: Martin's configuration parses; a missing or invalid part disables the brief", () => {
  assert.ok(schedule);
  assert.strictEqual(schedule.timeZone, "Africa/Accra");
  assert.strictEqual(schedule.hour, 10);
  assert.ok(!schedule.days.has("Sun"));
  assert.strictEqual(readMorningBriefSchedule(fakeEnv({ MORNING_BRIEF_HOUR: undefined })), null);
  assert.strictEqual(readMorningBriefSchedule(fakeEnv({ MORNING_BRIEF_HOUR: "25" })), null);
  assert.strictEqual(readMorningBriefSchedule(fakeEnv({ MORNING_BRIEF_DAYS: "" })), null);
  assert.strictEqual(readMorningBriefSchedule(fakeEnv({ MORNING_BRIEF_TIMEZONE: "Not/AZone" })), null);
});

test("schedule: due from 10:00 Accra Monday to Saturday, never before 10:00, never on Sunday", () => {
  // 2026-11-09 is a Monday; Accra is UTC+0.
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-09T09:59:00Z"), schedule), null);
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-09T10:00:00Z"), schedule), "2026-11-09");
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-09T22:30:00Z"), schedule), "2026-11-09");
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-14T10:30:00Z"), schedule), "2026-11-14", "Saturday");
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-15T10:30:00Z"), schedule), null, "Sunday");
});

test("schedule: uses the configured time zone's local hour and date, not UTC", () => {
  const tokyo = readMorningBriefSchedule(fakeEnv({ MORNING_BRIEF_TIMEZONE: "Asia/Tokyo" }))!;
  // 01:30 UTC Monday = 10:30 Monday in Tokyo (UTC+9).
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-09T01:30:00Z"), tokyo), "2026-11-09");
  // 23:30 UTC Saturday = 08:30 Sunday in Tokyo: Sunday, and before 10:00.
  assert.strictEqual(morningBriefDueDate(new Date("2026-11-14T23:30:00Z"), tokyo), null);
});

test("send: posts ENIG's brief to the Workspace topic once per day, and records it in ENIG's history", async (t) => {
  const sent = mockFetch(t);
  const env = fakeEnv();
  const now = new Date("2026-11-09T10:05:00Z");

  await maybeSendMorningBrief(env, now);
  await maybeSendMorningBrief(env, new Date("2026-11-09T10:35:00Z"));

  assert.strictEqual(sent.length, 1, "a second tick the same day sends nothing");
  assert.strictEqual(sent[0].chat_id, -100);
  assert.strictEqual(sent[0].message_thread_id, 604);
  assert.match(sent[0].text, /^☀️ Morning brief — 2026-11-09\n\nWaiting on you: nothing\./);
  const history = await getChatHistory(env, -100, 604);
  assert.strictEqual(history.length, 2);
  assert.match(history[0].content, /situation: morning_brief/);
  assert.match(history[1].content, /MAT-12 Qualified/);
});

test("send: nothing is sent before the hour or on Sunday", async (t) => {
  const sent = mockFetch(t);
  const env = fakeEnv();
  await maybeSendMorningBrief(env, new Date("2026-11-09T09:30:00Z"));
  await maybeSendMorningBrief(env, new Date("2026-11-15T10:30:00Z"));
  assert.strictEqual(sent.length, 0);
});

test("send: fails closed to one Operations notice, with no AI call, when ENIG's definition is unreadable", async (t) => {
  const sent = mockFetch(t);
  let aiCalled = false;
  const env = fakeEnv({
    STATE_KV: createMockKv() as any, // no cached governance; page reads 404
    AI: {
      run: async () => {
        aiCalled = true;
        return { response: "should not happen" };
      },
    } as any,
  });

  await maybeSendMorningBrief(env, new Date("2026-11-09T10:05:00Z"));
  await maybeSendMorningBrief(env, new Date("2026-11-09T10:35:00Z"));

  assert.strictEqual(aiCalled, false);
  assert.strictEqual(sent.length, 1, "one notice, not one per tick");
  assert.strictEqual(sent[0].message_thread_id, 588, "to Operations, not Workspace");
  assert.match(sent[0].text, /No morning brief today \(2026-11-09\): ENIG couldn't read its Notion definition/);
});

test("send: disabled when the Workspace topic is not configured", async (t) => {
  const sent = mockFetch(t);
  await maybeSendMorningBrief(fakeEnv({ WORKSPACE_TOPIC_ID: undefined }), new Date("2026-11-09T10:05:00Z"));
  assert.strictEqual(sent.length, 0);
});

test("format: every line of the brief is separated by one blank line, words unchanged", () => {
  const brief = "Waiting on you\n- Strategy Analyst — ENT-25 · MAT-26\n- Sales Executive — ENT-25 · MAT-26  \n\n\nNot moving\n- HO-93 · Sales → Strategy · Held\nNext steps\n1. Review MAT-26.";
  assert.strictEqual(
    spaceBriefLines(brief),
    "Waiting on you\n\n- Strategy Analyst — ENT-25 · MAT-26\n\n- Sales Executive — ENT-25 · MAT-26\n\nNot moving\n\n- HO-93 · Sales → Strategy · Held\n\nNext steps\n\n1. Review MAT-26.",
  );
  assert.strictEqual(spaceBriefLines("Nothing needs you today."), "Nothing needs you today.");
});
