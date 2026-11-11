import test from "node:test";
import assert from "node:assert";
import type { Env } from "../types";
import type { AiTask } from "../ai/types";
import { augmentTaskWithWebResearch, callerSensitivity, handleWebResearchCallback, scrubResearchQuestion, WEB_RESEARCH_TASKS } from "./webResearch";
import { DAILY_LIMIT, RUN_LIMIT, takeWebLookup } from "./webLookupAllowance";
import { withLiveStatus, currentRun } from "./liveStatus";
import { systemContext } from "../access";
import { executeSearch } from "./research/webSearch";

/**
 * Universal web research (2026-11-11): any Hat's output step may get public
 * web findings, decided by the AI, under shared guardrails -- identity-free
 * questions, the calling step's own sensitivity, read-only, and ceilings of
 * 10 per run / 200 per day that end with a card Martin controls.
 */

function kv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
}
function fakeEnv(store = kv()): Env {
  return { TELEGRAM_BOT_TOKEN: "t", TAVILY_API_KEY: "k", STATE_KV: store as any } as Env;
}
function task(taskId: string, extra: Partial<AiTask> = {}): AiTask {
  return {
    taskId,
    type: "text",
    boundaryContext: { segments: [{ type: "system", content: "persona", provenance: "p" }, { type: "user", content: "can marketing go online and tell me what businesses need", provenance: "u" }] },
    messages: [
      { role: "system", content: "persona" },
      { role: "user", content: "can marketing go online and tell me what businesses need" },
    ],
    ...extra,
  } as AiTask;
}
function mockTelegram(t: any) {
  const calls: { method: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      calls.push({ method: url.split("/").pop()!, body: init?.body ? JSON.parse(init.body) : {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}
const target = { chatId: -100, threadId: 604, header: "ENIG" };
const research = async () => ({ digest: "- SMEs in Ghana struggle to explain what they do (https://example.org/a)", gaps: ["No data on pricing"] });

test("scrub: record tokens, emails, phones and links never reach a search", () => {
  assert.strictEqual(
    scrubResearchQuestion("What do MAT-32 and ENT-31 clients like ama@acme.com (+233 24 000 0000) see on https://acme.com about branding?"),
    "What do and clients like ( ) see on about branding?",
  );
});

test("eligibility: Hat output steps only -- never routing, extraction, qualification, Finance pricing, verification or research itself", () => {
  for (const id of ["chat.general_reply", "marketing.hat_action_decision", "strategy.diagnosis", "business_development.develop_growth_opportunity"]) assert.ok(WEB_RESEARCH_TASKS.has(id as any), id);
  for (const id of ["chat.data_lookup", "routing.enquiry_classification", "sales.enquiry_extraction", "sales.call_qualification", "finance.quote_judgment", "work.result_verification", "research.synthesis", "runtime.research_need", "finance.intake_classification"]) assert.ok(!WEB_RESEARCH_TASKS.has(id as any), id);
});

test("sensitivity: the check is held to the calling step's EFFECTIVE level -- no stricter, no looser", () => {
  assert.strictEqual(callerSensitivity(task("chat.general_reply")), "client_confidential", "unstamped: the task's own level");
  const enig = task("chat.general_reply", { boundaryContext: { segments: [{ type: "system", content: "x", provenance: "s", sensitivity: "business_sensitive" }, { type: "user", content: "y", provenance: "u", sensitivity: "business_sensitive" }] } } as any);
  assert.strictEqual(callerSensitivity(enig), "business_sensitive", "ENIG's chat is stamped business_sensitive, so its check is too");
  const mixed = task("marketing.hat_action_decision", { boundaryContext: { segments: [{ type: "system", content: "x", provenance: "s" }, { type: "user", content: "y", provenance: "u", sensitivity: "client_confidential" }] } } as any);
  assert.strictEqual(callerSensitivity(mixed), "client_confidential", "the highest effective segment wins");
});

test("not eligible, or no run: the task is returned untouched and nothing is decided", async () => {
  let decided = 0;
  const deps = { decide: async () => (decided++, "x".repeat(20)), research };
  const t1 = task("finance.quote_judgment");
  assert.strictEqual(await augmentTaskWithWebResearch(fakeEnv(), t1, deps), t1);
  const t2 = task("chat.general_reply");
  assert.strictEqual(await augmentTaskWithWebResearch(fakeEnv(), t2, deps), t2, "outside a run there is no Access context, so no research");
  assert.strictEqual(decided, 0);
});

test("needed: findings are added to the step as labelled external context; the question went out identity-free", async (t) => {
  mockTelegram(t);
  let asked = "";
  const out = await withLiveStatus(fakeEnv(), target, async () =>
    augmentTaskWithWebResearch(fakeEnv(), task("chat.general_reply"), {
      decide: async () => "What do businesses like MAT-32 in Ghana struggle with in branding?",
      research: async (_e, q) => ((asked = q), research()),
    }),
    () => "succeeded",
    undefined,
    { access: systemContext() },
  );
  assert.ok(!/MAT-32/.test(asked), "no record token in the question");
  assert.match(out.messages[0].content, /=== WEB RESEARCH \(public sources, gathered just now\) ===[\s\S]*SMEs in Ghana[\s\S]*NOT evidence about any client/);
  assert.deepStrictEqual(out.boundaryContext.segments.at(-1), { type: "system", content: out.messages[0].content.slice(out.messages[0].content.indexOf("=== WEB RESEARCH")), provenance: "runtime:web_research", sensitivity: "public_sourced" });
});

test("not needed: the step runs exactly as before", async (t) => {
  mockTelegram(t);
  const t0 = task("chat.general_reply");
  const out = await withLiveStatus(fakeEnv(), target, async () => augmentTaskWithWebResearch(fakeEnv(), t0, { decide: async () => null, research }), () => "succeeded", undefined, { access: systemContext() });
  assert.strictEqual(out, t0);
});

test("ceiling: 10 lookups per run; the 11th is refused, the status says so, and the run ends with a Research more card", async (t) => {
  const calls = mockTelegram(t);
  const env = fakeEnv();
  const results: boolean[] = [];
  await withLiveStatus(env, target, async () => {
    for (let i = 0; i < RUN_LIMIT + 1; i++) results.push((await takeWebLookup(env)).ok);
    return "ok";
  }, () => "succeeded", undefined, { access: systemContext() });
  assert.deepStrictEqual(results, [...Array(RUN_LIMIT).fill(true), false]);
  const card = calls.find((c) => c.method === "sendMessage" && /web search limit for that job \(10\)/.test(c.body.text));
  assert.ok(card, "a limit card is posted after the run");
  assert.deepStrictEqual(card!.body.reply_markup.inline_keyboard[0].map((b: any) => b.text), ["🔎 Research more (10 more)", "✅ That's enough"]);
  assert.ok(calls.some((c) => /Web search limit for this job reached/.test(c.body.text ?? "")), "the live status names the limit");
});

test("ceiling: at 200 a day the search is refused and the card offers 'Allow 50 more today'; tapping it raises the limit", async (t) => {
  const calls = mockTelegram(t);
  const day = `web_research_count:${new Date().toISOString().slice(0, 10)}`;
  const store = kv({ [day]: JSON.stringify({ used: DAILY_LIMIT, limit: DAILY_LIMIT }) });
  const env = fakeEnv(store);
  let r: any;
  await withLiveStatus(env, target, async () => ((r = await takeWebLookup(env)), "ok"), () => "succeeded", undefined, { access: systemContext() });
  assert.deepStrictEqual(r, { ok: false, reason: "daily_limit" });
  const card = calls.find((c) => c.body.reply_markup)!;
  const allow = card.body.reply_markup.inline_keyboard[0][0];
  assert.strictEqual(allow.text, "Allow 50 more today");
  const [, id, value] = allow.callback_data.split(":");
  assert.match(await handleWebResearchCallback(env, id, value, -100, 604), /limit now 250/);
  assert.strictEqual(JSON.parse(store.store.get(day)!).limit, 250);
});

test("cards: That's enough does nothing; an expired card says so", async () => {
  const env = fakeEnv(kv({ "web_research_card:abc": JSON.stringify({ question: "q", gaps: [] }) }));
  assert.match(await handleWebResearchCallback(env, "abc", "done", -100, 604), /no more research/);
  assert.match(await handleWebResearchCallback(env, "nope", "more", -100, 604), /expired/);
});

test("executeSearch: a search past the run's ceiling is never made, and says why", async (t) => {
  let tavily = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    if (String(input).includes("tavily")) tavily++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const env = fakeEnv();
  const outcome = await withLiveStatus(env, target, async () => {
    const run = currentRun()!;
    run.searches = RUN_LIMIT;
    return executeSearch(env, { query: "branding challenges for SMEs" } as any, systemContext());
  }, () => "succeeded", undefined, { access: systemContext() });
  assert.deepStrictEqual(outcome, { kind: "provider_unavailable", reason: "the web search limit for this job was reached" });
  assert.strictEqual(tavily, 0);
});

test("one check and at most one research run per run: later Hat steps in the same run reuse the findings", async (t) => {
  mockTelegram(t);
  let decided = 0;
  let researched = 0;
  const deps = { decide: async () => (decided++, "What do SMEs in Ghana struggle with in branding?"), research: async () => (researched++, research()) };
  const outs = await withLiveStatus(fakeEnv(), target, async () => [
    await augmentTaskWithWebResearch(fakeEnv(), task("strategy.business_diagnosis"), deps),
    await augmentTaskWithWebResearch(fakeEnv(), task("strategy.brand_diagnosis"), deps),
    await augmentTaskWithWebResearch(fakeEnv(), task("strategy.specialist_synthesis"), deps),
  ], () => "succeeded", undefined, { access: systemContext() });
  assert.strictEqual(decided, 1);
  assert.strictEqual(researched, 1);
  for (const o of outs) assert.match(o.messages[0].content, /=== WEB RESEARCH/);
});
