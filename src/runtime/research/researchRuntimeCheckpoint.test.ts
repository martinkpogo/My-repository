import test from "node:test";
import assert from "node:assert";
import { runResearchSkill, RESEARCH_CHECKPOINT_MAX_AGE_MS, RESEARCH_PAUSE_LIMIT_MS } from "./researchRuntime";
import { discoveryCronContext } from "../../access";
import type { Env } from "../../types";
import type { ResearchCheckpoint, ResearchCheckpointStore } from "./types";
import { MAX_RESEARCH_CHECKPOINTS, workStatePersistence } from "../workPersistence";

// Durable research continuation (BD-15, issue #338; canonical Search spec,
// research_continuation): a compact checkpoint after each successful
// operation, resume without repeating completed work, interrupted research
// kept visibly incomplete, and Martin's 24-hour pause / 7-day age limits.

const SAFE_CONTEXT_PAGE = `## Purpose
A controlled, sanitized description of the consultancy.
## Authorized Context
### Business Category
- Strategy-led consultancy.
### Service Domains
- Business strategy
- Positioning
### General Client Type
- Businesses
### Problem Domain
- Positioning
### Geographic Context
- Primary: Ghana
## Identity Protection
The research runtime must not be given or infer from this context:
- Client identities
## External Research Boundary
- Do not include the organization's identity in external research queries.
## Governance Boundary
This page is the canonical source.`;

const QUESTION = "What positioning problems do growing Ghanaian SMEs report?";
const Q_A = "How do Ghanaian SMEs describe their positioning?";
const Q_B = "What evidence shows SMEs struggle to differentiate?";

interface Counters {
  interpret: number;
  plan: number;
  synthesis: number;
  searches: string[];
}

function harness(opts: { failQueries?: Set<string>; synthesisBroken?: boolean } = {}) {
  const kv = new Map<string, string>([
    ["governance:413cb004-e583-81aa-8dc0-d1e1576022db", SAFE_CONTEXT_PAGE.padEnd(200, " ")],
    ["governance:413cb004-e583-817d-bdca-ede843a85033", "Research role contract text."],
    ["governance:3cecb004-e583-81ee-8f1e-f0d58532f4aa", "Universal role contract text."],
  ]);
  const counters: Counters = { interpret: 0, plan: 0, synthesis: 0, searches: [] };
  const ai = {
    run: async (_model: unknown, o: any) => {
      const system = String(o?.messages?.[0]?.content ?? "");
      const respond = (v: unknown) => ({ response: typeof v === "string" ? v : JSON.stringify(v) });
      if (system.includes("You interpret a research question and select research protocol(s)")) {
        counters.interpret++;
        return respond({ relevance: "A positioning question for a strategy-led consultancy.", protocols: ["Customer / Audience Research"], ambiguous: false, reason: "Audience." });
      }
      if (system.includes("You generate a bounded research plan")) {
        counters.plan++;
        return respond({ dimensions: [{ subQuestion: Q_A }, { subQuestion: Q_B }] });
      }
      if (system.includes("research runtime — the selected research protocol")) {
        counters.synthesis++;
        if (opts.synthesisBroken) return respond("not json at all");
        return respond({ sources: [], evidence: [], findings: [], implications: [], limitations: [{ statement: "Evidence was thin." }] });
      }
      throw new Error(`unexpected AI call: ${system.slice(0, 60)}`);
    },
  };
  const env = {
    AI: ai,
    TAVILY_API_KEY: "t",
    STATE_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    NOTION_VERSION: "2025-09-03",
    NOTION_TOKEN: "n",
    AI_MODEL_PRIMARY: "m",
    AI_MODEL_LIGHT: "m-light",
  } as unknown as Env;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("tavily")) throw new Error(`unexpected request to ${url}`);
    const query = JSON.parse(String(init?.body ?? "{}")).query as string;
    counters.searches.push(query);
    if (opts.failQueries?.has(query)) {
      // Answered last, so the provider-wide cooldown it starts cannot race
      // ahead of the concurrent successful search (searches run in parallel).
      await new Promise((r) => setTimeout(r, 25));
      return new Response("busy", { status: 429 });
    }
    return new Response(JSON.stringify({ results: [{ title: `About ${query}`, url: `https://example.org/${counters.searches.length}`, content: "Evidence text." }] }), { status: 200 });
  }) as typeof fetch;
  return { env, kv, counters, fetchImpl };
}

function memoryStore() {
  const saved = new Map<string, ResearchCheckpoint>();
  const store: ResearchCheckpointStore = {
    load: async (id) => (saved.has(id) ? structuredClone(saved.get(id)) : undefined),
    save: async (cp) => void saved.set(cp.job_id, structuredClone(cp)),
  };
  return { saved, store, only: () => [...saved.values()][0] };
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

const CTX = discoveryCronContext();

test("an interrupted search stops the job as `interrupted` -- nothing is synthesized from partial evidence -- and the checkpoint keeps the completed search", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const { store, only } = memoryStore();
  const outcome = await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));

  assert.strictEqual(outcome.status, "interrupted");
  if (outcome.status !== "interrupted") return;
  assert.strictEqual(outcome.completedOperations, 1);
  assert.strictEqual(outcome.totalOperations, 2);
  assert.ok(outcome.retryAt, "the provider's cooldown end is reported");
  assert.strictEqual(h.counters.synthesis, 0, "incomplete research is never synthesized as if complete");

  const cp = only();
  assert.strictEqual(cp.status, "interrupted");
  assert.strictEqual(cp.question, QUESTION);
  assert.deepStrictEqual(cp.plan?.map((d) => d.subQuestion), [Q_A, Q_B]);
  assert.strictEqual(cp.operations[0].status, "completed_with_results");
  assert.ok(cp.operations[0].evidence_ref?.startsWith("web_search_cache:"), "evidence is referenced in the existing search cache");
  assert.strictEqual(cp.operations[1].status, "interrupted");
  assert.strictEqual(cp.current_interrupted_operation, 1);
  assert.deepStrictEqual(cp.remaining_operations, [1]);
  assert.strictEqual(cp.synthesis_status, "pending");
});

test("resuming the same job repeats no completed work: no new interpretation, no new plan, and only the interrupted search is made", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const { store, only } = memoryStore();
  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  assert.deepStrictEqual(h.counters.searches, [Q_A, Q_B]);

  // The provider is back: its cooldown has ended and it no longer refuses.
  h.kv.delete("search_provider_cooldown:tavily");
  const back = harness();
  const resumedEnv = { ...h.env, AI: back.env.AI } as Env;
  const outcome = await withFetch(back.fetchImpl, () => runResearchSkill(resumedEnv, { question: QUESTION, context: "", checkpoints: store }, CTX));

  assert.strictEqual(outcome.status, "completed");
  assert.strictEqual(back.counters.interpret, 0, "the saved interpretation is reused");
  assert.strictEqual(back.counters.plan, 0, "the approved plan is reused, so the same dimensions are searched");
  assert.deepStrictEqual(back.counters.searches, [Q_B], "the completed search is read back from evidence storage, not repeated");
  assert.strictEqual(back.counters.synthesis, 1);
  const cp = only();
  assert.strictEqual(cp.status, "completed");
  assert.strictEqual(cp.synthesis_status, "completed");
  assert.strictEqual(cp.validation_status, "passed");
  assert.deepStrictEqual(cp.remaining_operations, []);
});

test("after the 24-hour pause limit, an interrupted job is synthesized from what was gathered, the unfinished search reported as a limitation", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const { store, saved, only } = memoryStore();
  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  const cp = only();
  cp.created_at = new Date(Date.now() - RESEARCH_PAUSE_LIMIT_MS - 60_000).toISOString();
  saved.set(cp.job_id, cp);
  h.kv.delete("search_provider_cooldown:tavily");

  const outcome = await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  assert.strictEqual(outcome.status, "completed");
  assert.strictEqual(h.counters.synthesis, 1);
  assert.strictEqual(only().status, "completed");
});

test("a checkpoint older than 7 days is not resumed: the job starts again with a fresh interpretation and plan", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const { store, saved, only } = memoryStore();
  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  const cp = only();
  cp.created_at = new Date(Date.now() - RESEARCH_CHECKPOINT_MAX_AGE_MS - 60_000).toISOString();
  saved.set(cp.job_id, cp);
  h.kv.delete("search_provider_cooldown:tavily");

  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  assert.strictEqual(h.counters.interpret, 2);
  assert.strictEqual(h.counters.plan, 2);
});

test("a failed synthesis keeps the gathered evidence: the retry goes straight to synthesis with no search at all", async () => {
  const broken = harness({ synthesisBroken: true });
  const { store, only } = memoryStore();
  const first = await withFetch(broken.fetchImpl, () => runResearchSkill(broken.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  assert.strictEqual(first.status, "blocked");
  if (first.status === "blocked") assert.strictEqual(first.code, "SYNTHESIS_FAILED");
  assert.strictEqual(only().synthesis_status, "failed");
  assert.strictEqual(only().status, "blocked");

  const fixed = harness();
  const env = { ...broken.env, AI: fixed.env.AI } as Env;
  const second = await withFetch(fixed.fetchImpl, () => runResearchSkill(env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  assert.strictEqual(second.status, "completed");
  assert.deepStrictEqual(fixed.counters.searches, [], "completed searches are never repeated because a later step failed");
  assert.strictEqual(fixed.counters.plan, 0);
});

test("the checkpoint is compact: it references evidence but holds no result payloads", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const { store, only } = memoryStore();
  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  const json = JSON.stringify(only());
  assert.ok(!json.includes("Evidence text."), "no snippet text in the checkpoint");
  assert.ok(!json.includes("https://example.org/"), "no result URLs in the checkpoint -- they live in evidence storage");
});

test("outside a Work (no checkpoint store) an interruption is still reported as `interrupted`, never as completed", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const outcome = await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "" }, CTX));
  assert.strictEqual(outcome.status, "interrupted");
  assert.strictEqual(h.counters.synthesis, 0);
});

test("a different question is a different job: its checkpoint is never used for another", async () => {
  const h = harness({ failQueries: new Set([Q_B]) });
  const { store, saved } = memoryStore();
  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: QUESTION, context: "", checkpoints: store }, CTX));
  h.kv.delete("search_provider_cooldown:tavily");
  await withFetch(h.fetchImpl, () => runResearchSkill(h.env, { question: `${QUESTION} In Accra?`, context: "", checkpoints: store }, CTX));
  assert.strictEqual(saved.size, 2);
  assert.strictEqual(h.counters.interpret, 2);
});

// --- WorkSession-side storage ---

test("the Work's checkpoint store saves onto WorkState and flushes durably on every save", async () => {
  let flushes = 0;
  const state = { workId: "w1" } as any;
  const store = workStatePersistence(state, async () => {
    flushes++;
  }).research!;
  const cp: ResearchCheckpoint = {
    job_id: "job-1",
    question: QUESTION,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "interrupted",
    operations: [],
    remaining_operations: [],
    synthesis_status: "pending",
    validation_status: "pending",
  };
  await store.save(cp);
  assert.strictEqual(flushes, 1);
  assert.strictEqual(state.researchCheckpoints["job-1"].status, "interrupted");
  assert.strictEqual((await store.load("job-1"))?.question, QUESTION);
});

test("a Work keeps at most MAX_RESEARCH_CHECKPOINTS, dropping finished checkpoints before an unfinished one", async () => {
  const state = { workId: "w1" } as any;
  const store = workStatePersistence(state, async () => undefined).research!;
  const make = (id: string, status: ResearchCheckpoint["status"], minutesAgo: number): ResearchCheckpoint => ({
    job_id: id,
    question: id,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    status,
    operations: [],
    remaining_operations: [],
    synthesis_status: "pending",
    validation_status: "pending",
  });
  await store.save(make("oldest-interrupted", "interrupted", 100));
  for (let i = 0; i < MAX_RESEARCH_CHECKPOINTS; i++) await store.save(make(`done-${i}`, "completed", 50 - i));
  const kept = Object.keys(state.researchCheckpoints);
  assert.strictEqual(kept.length, MAX_RESEARCH_CHECKPOINTS);
  assert.ok(kept.includes("oldest-interrupted"), "an unfinished job is not dropped while finished ones remain");
});
