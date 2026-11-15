import test from "node:test";
import assert from "node:assert";
import { DEEP_RESEARCH_LIMITS, parseStepAnswer, runSkillRounds, verifyNotes } from "./skillRounds";
import { discoveryCronContext } from "../../access";

// Skill-guided research rounds (Research Runtime decision, build step 3):
// the Skill decides, the runtime validates, dispatches in parallel and
// provenance-checks -- and never decides the method itself.

const CTX = discoveryCronContext();
const PAGE_TEXT = "Growing SMEs in Accra say customers cannot tell what makes them different. ".repeat(8);

function memoryKv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
}

function harness(steps: unknown[], opts: { searchStatus?: number } = {}) {
  const seen: string[] = [];
  const env = {
    TAVILY_API_KEY: "t",
    STATE_KV: memoryKv(),
    AI_MODEL_PRIMARY: "m",
    AI_MODEL_LIGHT: "m-light",
    AI: {
      run: async (_m: unknown, o: any) => {
        seen.push(String(o?.messages?.[1]?.content ?? ""));
        const next = steps.shift();
        if (next === undefined) throw new Error("unexpected extra research step");
        return { response: JSON.stringify(next) };
      },
    },
  } as any;
  const requests: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("api.tavily.com/search")) {
      if (opts.searchStatus) return new Response("", { status: opts.searchStatus });
      const q = JSON.parse(String(init?.body)).query;
      return new Response(JSON.stringify({ results: [{ title: `Result for ${q}`, url: "https://news.example/sme", content: "SMEs struggle to differentiate." }] }));
    }
    if (url.startsWith("https://news.example/")) return new Response(`<html><body><p>${PAGE_TEXT}</p></body></html>`, { headers: { "content-type": "text/html" } });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { env, seen, requests, fetchImpl };
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const input = { skillContent: "METHOD: search, read the best page, note facts, finish.", question: "What positioning problems do Accra SMEs report?", context: "A strategy-led consultancy.", limits: DEEP_RESEARCH_LIMITS };

test("the Skill-guided step directs the rounds: search, then read a page it found, then finish -- with provenance-checked notes", async () => {
  const h = harness([
    { operations: [{ type: "search", query: "Accra SME positioning problems" }], notes: [], done: false },
    { operations: [{ type: "read_page", url: "https://news.example/sme" }], notes: [], done: false },
    { operations: [], notes: [{ fact: "SMEs say customers cannot tell them apart", quote: "customers cannot tell what makes them different", url: "https://news.example/sme" }], done: true },
  ]);
  const outcome = await withFetch(h.fetchImpl, () => runSkillRounds(h.env, input, CTX));
  assert.strictEqual(outcome.status, "completed");
  if (outcome.status !== "completed") return;
  assert.strictEqual(outcome.notes.length, 1);
  assert.strictEqual(outcome.operations, 2);
  assert.ok(h.requests.some((u) => u.includes("api.tavily.com/search")));
  assert.ok(h.requests.includes("https://news.example/sme"));
  assert.ok(h.seen[1].includes("RESULTS FROM LAST ROUND"), "each step sees the previous round's results");
});

test("a note whose quote does not appear in what was retrieved is dropped as unverifiable", async () => {
  const h = harness([
    { operations: [{ type: "search", query: "q" }], notes: [], done: false },
    { operations: [], notes: [{ fact: "Invented", quote: "92% of SMEs plan a rebrand", url: "https://news.example/sme" }], done: true },
  ]);
  const outcome = await withFetch(h.fetchImpl, () => runSkillRounds(h.env, input, CTX));
  assert.strictEqual(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.strictEqual(outcome.notes.length, 0);
    assert.strictEqual(outcome.droppedNotes, 1);
  }
});

test("the step cannot read a URL that never appeared in its results, and is told so on the next round", async () => {
  const h = harness([
    { operations: [{ type: "read_page", url: "https://elsewhere.example/" }], notes: [], done: false },
    { operations: [], notes: [], done: true },
  ]);
  const outcome = await withFetch(h.fetchImpl, () => runSkillRounds(h.env, input, CTX));
  assert.strictEqual(outcome.status, "completed");
  assert.deepStrictEqual(h.requests, [], "nothing was fetched");
});

test("operations over a round's limit are refused, never silently run", () => {
  const ops = Array.from({ length: 9 }, (_, i) => ({ type: "search", query: `q${i}` }));
  const parsed = parseStepAnswer({ operations: ops, notes: [], done: false }, DEEP_RESEARCH_LIMITS, 0, 0, new Set());
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.strictEqual(parsed.answer.operations.length, 6);
  assert.strictEqual(parsed.refused.length, 3);
});

test("rounds are bounded: after the last operation round the step must finish", async () => {
  const keepGoing = { operations: [{ type: "search", query: "again" }], notes: [], done: false };
  const h = harness([keepGoing, keepGoing, keepGoing, keepGoing]);
  const outcome = await withFetch(h.fetchImpl, () => runSkillRounds(h.env, input, CTX));
  assert.strictEqual(outcome.status, "completed");
  assert.strictEqual(h.requests.filter((u) => u.includes("api.tavily.com/search")).length, 1, "repeat searches are served from the cache");
  assert.strictEqual(h.seen.length, 4, "three operation rounds plus one final step -- never more");
});

test("busy providers stop the job as interrupted -- nothing concluded from partial evidence", async () => {
  const h = harness([{ operations: [{ type: "search", query: "q" }], notes: [], done: false }], { searchStatus: 429 });
  const outcome = await withFetch(h.fetchImpl, () => runSkillRounds(h.env, input, CTX));
  assert.strictEqual(outcome.status, "interrupted");
});

test("an answer in the wrong shape blocks the job rather than being guessed at", async () => {
  const h = harness([{ nonsense: true }]);
  const outcome = await withFetch(h.fetchImpl, () => runSkillRounds(h.env, input, CTX));
  assert.strictEqual(outcome.status, "blocked");
});

test("notes are capped per source", () => {
  const retrieved = new Map([["https://a.example/", "alpha beta gamma delta"]]);
  const many = Array.from({ length: 10 }, () => ({ fact: "f", quote: "beta", url: "https://a.example/" }));
  assert.strictEqual(verifyNotes(many, retrieved, DEEP_RESEARCH_LIMITS, []).kept.length, DEEP_RESEARCH_LIMITS.maxNotesPerSource);
});
