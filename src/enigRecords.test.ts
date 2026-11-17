import test from "node:test";
import assert from "node:assert";
import {
  clearEnigRecordsCache,
  consumeRecordsOffer,
  ENIG_RECORDS_CALLBACK,
  getCachedEnigRecords,
  offerRecordsRead,
  RECORDS_CACHE_TTL_MS,
  RECORDS_NOT_READ_CONTEXT,
  RECORDS_NOT_READ_LOG,
  RECORDS_NOT_READ_RULE,
  recordsLikelyNeeded,
  recordsOfferText,
  setCachedEnigRecords,
  stripReadLine,
} from "./enigRecords";
import type { Env } from "./types";

/**
 * Databases are read only when the request needs them (Martin, 2026-11-17):
 * the deterministic check that decides "read now", the READ line ENIG writes
 * when it needs records it was not given, the one question Martin taps, and
 * the in-memory TTL cache that keeps a rapid follow-up from re-reading.
 */

function createMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function fakeEnv(initial: Record<string, string> = {}): Env {
  return { STATE_KV: createMockKv(initial) as any } as Env;
}

test("recordsLikelyNeeded: an obvious status/money/recent-activity question reads straight away", () => {
  for (const message of [
    "where are we?",
    "any overdue invoices?",
    "how many open handoffs?",
    "what's the status of MAT-12?",
    "any payments due this week?",
    "what did we decide yesterday?",
    "which approvals are pending?",
    "any new leads in the pipeline?",
  ]) {
    assert.ok(recordsLikelyNeeded(message), `"${message}" plainly needs records`);
  }
});

test("recordsLikelyNeeded: a plain request to be told the state reads straight away", () => {
  for (const message of ["show me the pipeline", "status", "catch me up on the leads", "give me a summary of open proposals", "ENIG, list the pending approvals"]) {
    assert.ok(recordsLikelyNeeded(message), `"${message}" plainly asks for the state`);
  }
});

test("recordsLikelyNeeded: a request for work never reads, even when it uses a records word -- it routes to the owning Hat", () => {
  for (const message of [
    "draft a post to attract leads",
    "write a brief for the proposal",
    "create a campaign to update our leads",
    "can you draft a LinkedIn post about our latest case study?",
    "please prepare a proposal for MAT-12",
    "I want you to plan a launch for this month",
    "help me write a follow-up to the open leads",
    "find leads in Lagos",
    "ENIG, develop a pricing strategy for the pipeline",
    "we need more leads this month",
    "a post about how we track payments",
  ]) {
    assert.ok(!recordsLikelyNeeded(message), `"${message}" is work or a statement, not a status question`);
  }
});

test("recordsLikelyNeeded: an ordinary message reads nothing -- the offer, not the query, is what comes next", () => {
  for (const message of ["hi ENIG", "thanks, that helps", "what do you think about our positioning?", "create a campaign offering free consultancy", "ok"]) {
    assert.ok(!recordsLikelyNeeded(message), `"${message}" does not plainly need records`);
  }
});

test("stripReadLine: removes the READ line and reports the ask; a plain reply is untouched", () => {
  assert.deepStrictEqual(stripReadLine("READ: overdue invoices"), { text: "", requested: true });
  assert.deepStrictEqual(stripReadLine("Let me check.\nREAD: overdue invoices"), { text: "Let me check.", requested: true });
  assert.deepStrictEqual(stripReadLine("read: the handoffs"), { text: "", requested: true }, "case-insensitive");
  assert.deepStrictEqual(stripReadLine("You have 2 approvals waiting."), { text: "You have 2 approvals waiting.", requested: false });
});

test("the no-records rule: never claims a read, asks with the READ line, and says what Martin's tap does", () => {
  assert.match(RECORDS_NOT_READ_RULE, /no database was read for this reply/i);
  assert.match(RECORDS_NOT_READ_RULE, /Never claim a database was read when it was not/);
  assert.match(RECORDS_NOT_READ_RULE, /READ: <a few words naming what you need>/);
  assert.match(RECORDS_NOT_READ_RULE, /Read records \/ Not now/);
  assert.match(RECORDS_NOT_READ_RULE, /only his tap re-runs this turn with the records actually read/);
  // The context slots the rule travels in must say the same thing, so a
  // reply can never imply a snapshot or a log line was provided.
  assert.match(RECORDS_NOT_READ_CONTEXT, /NO LIVE RECORDS READ THIS TURN/);
  assert.match(RECORDS_NOT_READ_LOG, /NOT READ this turn/);
});

test("recordsOfferText: the runtime writes the question, never ENIG -- one fixed sentence", () => {
  assert.strictEqual(recordsOfferText(), "This needs the live records, which ENIG has not read. Read them now?");
});

test("offerRecordsRead: one Read-records and one Not-now button, bound to this offer", async () => {
  const buttons = await offerRecordsRead(fakeEnv(), -100, 604, "how many open handoffs?");
  assert.strictEqual(buttons.length, 1);
  assert.strictEqual(buttons[0][0].text, "📊 Read records");
  assert.strictEqual(buttons[0][1].text, "Not now");
  assert.ok(buttons[0][0].callback_data.startsWith(`${ENIG_RECORDS_CALLBACK}:`));
});

test("consumeRecordsOffer: a tap yields Martin's original message, once, only from the chat/thread it was offered in", async () => {
  const env = fakeEnv();
  const id = (await offerRecordsRead(env, -100, 604, "how many open handoffs?"))[0][0].callback_data.split(":")[1];

  assert.deepStrictEqual(await consumeRecordsOffer(env, id, "yes", -100, 604), { kind: "read", text: "how many open handoffs?" });
  assert.deepStrictEqual(await consumeRecordsOffer(env, id, "yes", -100, 604), { kind: "unavailable" }, "a second tap reads nothing");

  const declinedId = (await offerRecordsRead(env, -100, 604, "x"))[0][1].callback_data.split(":")[1];
  assert.deepStrictEqual(await consumeRecordsOffer(env, declinedId, "no", -100, 604), { kind: "declined" });

  const otherChatId = (await offerRecordsRead(env, -100, 604, "x"))[0][0].callback_data.split(":")[1];
  assert.deepStrictEqual(await consumeRecordsOffer(env, otherChatId, "yes", -100, 999), { kind: "unavailable" }, "another thread is refused");

  assert.deepStrictEqual(await consumeRecordsOffer(env, "000000000000", "yes", -100, 604), { kind: "unavailable" }, "an unknown offer reads nothing");
});

test("the read cache: a fresh hit serves the same read, an expired one does not, and clearing starts cold", () => {
  clearEnigRecordsCache();
  assert.strictEqual(getCachedEnigRecords(), undefined, "cold cache");

  setCachedEnigRecords("SNAP", "ACT", 1_000);
  assert.deepStrictEqual(getCachedEnigRecords(1_000 + RECORDS_CACHE_TTL_MS - 1), { snapshot: "SNAP", activity: "ACT", expiresAt: 1_000 + RECORDS_CACHE_TTL_MS });
  assert.strictEqual(getCachedEnigRecords(1_000 + RECORDS_CACHE_TTL_MS), undefined, "expired exactly at the TTL");

  clearEnigRecordsCache();
  assert.strictEqual(getCachedEnigRecords(), undefined, "cleared");
});
