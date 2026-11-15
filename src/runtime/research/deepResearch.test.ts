import test from "node:test";
import assert from "node:assert";
import { runDeepResearchSkill } from "./researchRuntime";
import { discoveryCronContext } from "../../access";
import { verifySkillIntegrity } from "../../platform/skillRegistry";
import type { ResearchCheckpoint, ResearchCheckpointStore } from "./types";

// Deep Research on the Research Runtime (BD-16, build step 4): the
// deep_research Skill directs the rounds; the runtime supplies safe context,
// checkpoints, notes-only synthesis and the validation gate.

const SAFE = `## Purpose
A controlled, sanitized description of the consultancy.
## Authorized Context
### Business Category
- Strategy-led consultancy.
### Service Domains
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

const PAGE = "Growing SMEs in Accra say customers cannot tell what makes them different. ".repeat(8);
const QUOTE = "customers cannot tell what makes them different";
const URL_ = "https://news.example/sme";

function harness(steps: unknown[], opts: { searchStatus?: () => number } = {}) {
  const kv = new Map<string, string>([
    ["governance:413cb004-e583-81aa-8dc0-d1e1576022db", SAFE.padEnd(200, " ")],
    ["governance:413cb004-e583-817d-bdca-ede843a85033", "Research role contract text."],
    ["governance:3cecb004-e583-81ee-8f1e-f0d58532f4aa", "Universal role contract text."],
  ]);
  const counts = { steps: 0, synthesis: 0, searches: 0, pages: 0 };
  const env = {
    TAVILY_API_KEY: "t",
    NOTION_VERSION: "2025-09-03",
    NOTION_TOKEN: "n",
    AI_MODEL_PRIMARY: "m",
    AI_MODEL_LIGHT: "m-light",
    STATE_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) },
    AI: {
      run: async (_m: unknown, o: any) => {
        const system = String(o?.messages?.[0]?.content ?? "");
        if (system.includes("carrying out one step of a research method")) {
          counts.steps++;
          const next = steps.shift();
          if (next === undefined) throw new Error("unexpected extra research step");
          return { response: JSON.stringify(next) };
        }
        if (system.includes("research runtime — the selected research protocol")) {
          counts.synthesis++;
          return {
            response: JSON.stringify({
              sources: [{ id: "s1", source: "news.example", sourceType: "secondary", url: URL_, passage: QUOTE, claimSupported: "differentiation", validationStatus: "validated" }],
              evidence: [{ id: "e1", statement: "SMEs report customers cannot tell them apart", sourceIds: ["s1"] }],
              findings: [{ id: "f1", statement: "Differentiation is a reported problem", evidenceIds: ["e1"] }],
              implications: [],
              limitations: [],
            }),
          };
        }
        throw new Error(`unexpected AI call: ${system.slice(0, 60)}`);
      },
    },
  } as any;
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("api.tavily.com/search")) {
      counts.searches++;
      const status = opts.searchStatus?.() ?? 200;
      if (status !== 200) return new Response("", { status });
      return new Response(JSON.stringify({ results: [{ title: "SME study", url: URL_, content: "SMEs struggle to differentiate." }] }));
    }
    if (url === URL_) {
      counts.pages++;
      return new Response(`<html><body><p>${PAGE}</p></body></html>`, { headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { env, kv, counts, fetchImpl };
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

function memoryStore() {
  const saved = new Map<string, ResearchCheckpoint>();
  const store: ResearchCheckpointStore = { load: async (id) => (saved.has(id) ? structuredClone(saved.get(id)) : undefined), save: async (cp) => void saved.set(cp.job_id, structuredClone(cp)) };
  return { saved, store };
}

const CTX = discoveryCronContext();
const Q = "What positioning problems do Accra SMEs report?";
const STEPS = () => [
  { operations: [{ type: "search", query: "Accra SME positioning problems" }], notes: [], done: false },
  { operations: [{ type: "read_page", url: URL_ }], notes: [], done: false },
  { operations: [], notes: [{ fact: "SMEs say customers cannot tell them apart", quote: QUOTE, url: URL_ }], done: true },
];

test("deep_research is a registered Skill whose content matches its registered SHA-256", async () => {
  await assert.doesNotReject(() => verifySkillIntegrity("deep_research"));
});

test("Deep Research: the Skill directs search -> page read -> notes, and synthesis is built from the verified notes and passes the evidence gate", async () => {
  const h = harness(STEPS());
  const outcome = await withFetch(h.fetchImpl, () => runDeepResearchSkill(h.env, { question: Q, context: "" }, CTX));
  assert.strictEqual(outcome.status, "completed");
  assert.strictEqual(h.counts.steps, 3);
  assert.strictEqual(h.counts.pages, 1);
  assert.strictEqual(h.counts.synthesis, 1);
});

test("Deep Research resumes an interrupted round without repeating any AI step or completed operation", async () => {
  let busy = true;
  const first = harness(STEPS(), { searchStatus: () => (busy ? 429 : 200) });
  const { store, saved } = memoryStore();
  const r1 = await withFetch(first.fetchImpl, () => runDeepResearchSkill(first.env, { question: Q, context: "", checkpoints: store }, CTX));
  assert.strictEqual(r1.status, "interrupted");
  assert.strictEqual(first.counts.steps, 1, "only the first step ran");
  const cp = [...saved.values()][0];
  assert.deepStrictEqual(cp.rounds?.operations[0], [{ type: "search", query: "Accra SME positioning problems" }], "the batch was recorded before it ran");
  assert.strictEqual(cp.rounds?.next_round, 0);

  busy = false;
  first.kv.delete("search_provider_cooldown:tavily");
  const remaining = STEPS().slice(1);
  const second = harness(remaining);
  const env2 = { ...first.env, AI: second.env.AI };
  const r2 = await withFetch(second.fetchImpl, () => runDeepResearchSkill(env2, { question: Q, context: "", checkpoints: store }, CTX));
  assert.strictEqual(r2.status, "completed");
  assert.strictEqual(second.counts.steps, 2, "the first step is not repeated -- its recorded batch is dispatched again");
  assert.strictEqual(second.counts.searches, 1, "only the interrupted search runs");
  assert.strictEqual([...saved.values()][0].status, "completed");
});

test("notes live in the 7-day notes cache, not in the checkpoint", async () => {
  const h = harness(STEPS());
  const { store, saved } = memoryStore();
  await withFetch(h.fetchImpl, () => runDeepResearchSkill(h.env, { question: Q, context: "", checkpoints: store }, CTX));
  const cp = [...saved.values()][0];
  assert.ok(!JSON.stringify(cp).includes(QUOTE), "no note text in the checkpoint");
  assert.ok(h.kv.get(cp.rounds!.notes_ref)?.includes(QUOTE), "notes are in the notes cache under the checkpoint's reference");
});
