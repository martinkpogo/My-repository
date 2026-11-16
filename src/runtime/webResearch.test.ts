import test from "node:test";
import assert from "node:assert";
import type { Env } from "../types";
import type { AiTask } from "../ai/types";
import { augmentTaskWithWebResearch, callerSensitivity, deepResearchProposalInRun, handleWebResearchCallback, parseDeepProposal, researchHeldInRun, RESEARCH_NEED_INSTRUCTIONS, scrubResearchQuestion, WEB_RESEARCH_TASKS } from "./webResearch";
import { DAILY_LIMIT, RUN_LIMIT, noteResearchInterrupted, takeWebLookup } from "./webLookupAllowance";
import { getResearchCheckpointStore, installStatePersistence } from "./workPersistence";
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
  assert.deepStrictEqual(outcome, { kind: "internal_allowance_exhausted", reason: "the web search limit for this job was reached" });
  assert.strictEqual(tavily, 0);
});

test("executeSearch: with fallback providers enabled, an exhausted job allowance still asks NO provider -- fallback cannot bypass ENIG's own allowance", async (t) => {
  const providerCalls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (/tavily|exa\.ai|serper/.test(url)) providerCalls.push(url);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const env = { ...fakeEnv(), EXA_API_KEY: "e", SERPER_API_KEY: "s", SEARCH_FALLBACK_PROVIDERS: "exa,serper", SEARCH_MONTHLY_BUDGET_EXA: "100" } as Env;
  const outcome = await withLiveStatus(env, target, async () => {
    const run = currentRun()!;
    run.searches = RUN_LIMIT;
    return executeSearch(env, { query: "branding challenges for SMEs" } as any, systemContext());
  }, () => "succeeded", undefined, { access: systemContext() });
  assert.strictEqual(outcome.kind, "internal_allowance_exhausted");
  assert.deepStrictEqual(providerCalls, []);
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

test("a Work's Access context is taken at the moment of use, so a Hat resolved during the run is the one searches run under", async (t) => {
  mockTelegram(t);
  const state: any = { workId: "w1", chatId: -100, unit: "Marketing", hat: "Marketing", actionName: "handle_request" };
  const { workSessionContext } = await import("../access");
  let used: any;
  await withLiveStatus(fakeEnv(), target, async () => {
    state.hat = "Content Strategist"; // Marketing's intake resolves the Hat after the run opens
    await augmentTaskWithWebResearch(fakeEnv(), task("marketing.hat_action_decision"), {
      decide: async () => "What do growing businesses struggle with in communication?",
      research: async (_e, _q, access) => ((used = access), research()),
    });
    return "ok";
  }, () => "succeeded", undefined, { access: () => workSessionContext(state) });
  assert.strictEqual(used.hat, "Content Strategist");
});

test("research question stays on the request's subject (Martin, 2026-11-13): a problem businesses have is researched as THEIR problem, not their customers'", async () => {
  const { RESEARCH_NEED_INSTRUCTIONS } = await import("./webResearch");
  assert.match(RESEARCH_NEED_INSTRUCTIONS, /stay on the exact subject the request asks about/);
  assert.match(RESEARCH_NEED_INSTRUCTIONS, /not their customers' behaviour or the market in general/);
  assert.match(RESEARCH_NEED_INSTRUCTIONS, /identity-free/, "the identity rule is unchanged");
});

test("research check (Martin, 2026-11-13): a reasoning model gets room to answer, and a request for market evidence always needs research", async () => {
  const { RESEARCH_NEED_INSTRUCTIONS, RESEARCH_NEED_MAX_TOKENS } = await import("./webResearch");
  assert.ok(RESEARCH_NEED_MAX_TOKENS >= 600, "200 left Groq's reasoning no room: it answered with 0 characters");
  assert.match(RESEARCH_NEED_INSTRUCTIONS, /ALWAYS needs web research/);
  assert.match(RESEARCH_NEED_INSTRUCTIONS, /Say no for questions about ENIG's own records/, "the exclusions are unchanged");
});

test("research cache (Martin, 2026-11-14, option C): the same question within 24 hours reuses the saved findings with no AI call or search; the key is a hash, never the question", async () => {
  const { researchOnline, RESEARCH_CACHE_TTL_SECONDS } = await import("./webResearch");
  const { hashContent } = await import("../contentHash");
  assert.strictEqual(RESEARCH_CACHE_TTL_SECONDS, 24 * 60 * 60);
  const key = "web_research_cache:" + (await hashContent("what positioning problems do ghana smes face"));
  const store = kv({ [key]: JSON.stringify({ digest: "saved findings (source: example.org)", gaps: ["no sector data"] }) });
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("no network in this test");
  }) as any;
  try {
    const result = await researchOnline(fakeEnv(store), "  What positioning problems do Ghana SMEs   face ", systemContext());
    assert.deepStrictEqual(result, { digest: "saved findings (source: example.org)", gaps: ["no sector data"] });
    assert.strictEqual(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("research cache: an unreadable saved entry is a miss, never used as findings", async () => {
  const { hashContent } = await import("../contentHash");
  const key = "web_research_cache:" + (await hashContent("q for a broken cache entry"));
  const store = kv({ [key]: JSON.stringify({ digest: 42 }) });
  const { researchOnline } = await import("./webResearch");
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("no network in this test");
  }) as any;
  try {
    const result = await researchOnline(fakeEnv(store), "q for a broken cache entry", systemContext()).catch(() => null);
    assert.strictEqual(result, null, "the real run is attempted and, with no network, cannot complete");
    assert.ok(fetches > 0, "the broken entry was not used: the real research run was attempted");
  } finally {
    globalThis.fetch = original;
  }
});

test("interrupted research (providers busy): the run ends with a paused card that says how far it got and when providers are back -- never a completed answer", async (t) => {
  const calls = mockTelegram(t);
  const env = fakeEnv();
  await withLiveStatus(env, target, async () => {
    noteResearchInterrupted(env, "what do SMEs struggle with", { retryAt: "2026-11-14T14:05:00.000Z", completedOperations: 3, totalOperations: 5 });
    return "ok";
  }, () => "succeeded", undefined, { access: systemContext() });
  const card = calls.find((c) => c.method === "sendMessage" && /^⏸ Web research paused/.test(c.body.text));
  assert.ok(card, "a paused card is posted after the run");
  assert.ok(/3 of 5 searches are done and saved/.test(card!.body.text));
  assert.ok(/14:05 UTC/.test(card!.body.text));
  assert.ok(/could not use it yet/.test(card!.body.text), "the card says this step could not use the research yet");
  assert.deepStrictEqual(card!.body.reply_markup.inline_keyboard[0].map((b: any) => b.text), ["🔎 Try research again", "✅ That's enough"]);
  assert.ok(calls.some((c) => /Web research paused: search providers busy/.test(c.body.text ?? "")), "the live status names the pause");
});

test("research checkpoints: the store is the executing Work's own -- found only while that Work's persistence is installed", () => {
  assert.strictEqual(getResearchCheckpointStore("work-not-running"), undefined);
  assert.strictEqual(getResearchCheckpointStore(undefined), undefined);
  const { release } = installStatePersistence("work-running");
  try {
    assert.ok(getResearchCheckpointStore("work-running"), "a running Work has a checkpoint store");
  } finally {
    release();
  }
  assert.strictEqual(getResearchCheckpointStore("work-running"), undefined, "released with the Work's execution");
});

test("option B: the Work's checkpoint store exposes scheduleResume, passing the paused job to WorkSession's scheduler", async () => {
  const scheduled: unknown[] = [];
  const { workStatePersistence } = await import("./workPersistence");
  const store = workStatePersistence({ workId: "w" } as any, async () => undefined, async (p) => void scheduled.push(p)).research!;
  await store.scheduleResume!({ question: "what do SMEs struggle with", mode: "light_search", retryAt: "2026-11-15T14:05:00.000Z" });
  assert.deepStrictEqual(scheduled, [{ question: "what do SMEs struggle with", mode: "light_search", retryAt: "2026-11-15T14:05:00.000Z" }]);
  assert.strictEqual(workStatePersistence({ workId: "w" } as any, async () => undefined).research!.scheduleResume, undefined, "no scheduler, no resume");
});

test("option B: when the Work will resume research itself, the paused card says so and names the time", async (t) => {
  const calls = mockTelegram(t);
  const env = fakeEnv();
  await withLiveStatus(env, target, async () => {
    noteResearchInterrupted(env, "q", { retryAt: "2026-11-15T14:05:00.000Z", completedOperations: 1, totalOperations: 2, resumesAutomatically: true });
    return "ok";
  }, () => "succeeded", undefined, { access: systemContext() });
  const card = calls.find((c) => c.method === "sendMessage" && /^⏸ Web research paused/.test(c.body.text));
  assert.ok(/resumes on its own around 14:05 UTC/.test(card!.body.text));
  assert.ok(/message when it is complete/.test(card!.body.text));
});

test("option B: researchPausedInRun is true only after this run's research paused", async (t) => {
  mockTelegram(t);
  const { researchPausedInRun } = await import("./webLookupAllowance");
  const env = fakeEnv();
  const seen = await withLiveStatus(env, target, async () => {
    const before = researchPausedInRun();
    noteResearchInterrupted(env, "q", { completedOperations: 0, totalOperations: 2 });
    return [before, researchPausedInRun()];
  }, () => "succeeded", undefined, { access: systemContext() });
  assert.deepStrictEqual(seen, [false, true]);
  assert.strictEqual(researchPausedInRun(), false, "outside a run nothing is paused");
});

test("option B: Continue feeds the completed findings into the run -- the step uses them without deciding or researching again", async (t) => {
  mockTelegram(t);
  const { seedRunResearchFindings, saveDeepResearchFindings } = await import("./webResearch");
  const env = fakeEnv();
  await saveDeepResearchFindings(env, "what do SMEs struggle with", { digest: "- SMEs cannot explain their difference (https://example.org/a)", gaps: [] });
  let decided = false;
  const out = await withLiveStatus(env, target, async () => {
    assert.strictEqual(await seedRunResearchFindings(env, "what do SMEs struggle with"), true);
    return augmentTaskWithWebResearch(env, task("chat.general_reply"), { decide: async () => ((decided = true), "another question"), research });
  }, () => "succeeded", undefined, { access: systemContext() });
  assert.strictEqual(decided, false, "no new research decision");
  assert.ok(out.messages[0].content.includes("SMEs cannot explain their difference"));
});

test("option B: seeding with nothing saved returns false (Continue refuses rather than drafting without research)", async (t) => {
  mockTelegram(t);
  const { seedRunResearchFindings } = await import("./webResearch");
  const env = fakeEnv();
  const seeded = await withLiveStatus(env, target, async () => seedRunResearchFindings(env, "never researched"), () => "succeeded", undefined, { access: systemContext() });
  assert.strictEqual(seeded, false);
});

// Deep research is proposed, never run, by the check (Martin, 16 Nov 2026).

const DEEP = {
  needed_for: "Designing the free-consultation campaign to build a mailing list",
  topic: "Which free offers get SMEs to join a consultancy's mailing list?",
  brief: [
    { question: "Who is it for?", answer: "SMEs considering branding help" },
    { question: "Contact?", answer: "ama@acme.com or MAT-32" },
    { question: "", answer: "dropped: no question" },
  ],
};

test("parseDeepProposal keeps a well-formed, scrubbed brief and drops malformed parts", () => {
  const p = parseDeepProposal(DEEP)!;
  assert.strictEqual(p.neededFor, DEEP.needed_for);
  assert.strictEqual(p.topic, DEEP.topic);
  assert.deepStrictEqual(p.lines[0], { question: "Who is it for?", answer: "SMEs considering branding help" });
  assert.ok(!p.lines.some((l) => /@|MAT-32/.test(l.answer)), "tokens and emails are scrubbed");
  assert.strictEqual(p.lines.length, 2, "a line with no question is dropped");
  assert.strictEqual(parseDeepProposal({ needed_for: "x", topic: DEEP.topic }), undefined, "too short: nothing proposed");
  assert.strictEqual(parseDeepProposal("deep please"), undefined);
  assert.strictEqual(parseDeepProposal({ ...DEEP, brief: Array.from({ length: 9 }, (_, i) => ({ question: `Question ${i}?`, answer: "an answer" })) })!.lines.length, 5, "at most five lines");
  assert.match(RESEARCH_NEED_INSTRUCTIONS, /ALSO propose Deep Research/);
});

async function inRun(offers: boolean, decide: any, researchFn: any = research) {
  let proposal: unknown;
  let held: unknown;
  await withLiveStatus(
    fakeEnv(),
    target,
    async () => {
      await augmentTaskWithWebResearch(fakeEnv(), task("marketing.hat_action_decision"), { decide, research: researchFn });
      proposal = deepResearchProposalInRun();
      held = researchHeldInRun();
    },
    () => "succeeded",
    undefined,
    { access: systemContext(), offersDeepResearch: () => offers },
  );
  return { proposal, held };
}

test("a deep proposal is recorded only where the Work can hold its draft for it; light research still runs either way", async (t) => {
  mockTelegram(t);
  const parsed = parseDeepProposal(DEEP)!;
  let researched = 0;
  const counting = async () => (researched++, research());
  const offered = await inRun(true, async () => ({ question: "What free offers do SMEs sign up for?", deep: parsed }), counting);
  assert.deepStrictEqual(offered.proposal, { ...parsed, lightQuestion: "What free offers do SMEs sign up for?" });
  assert.strictEqual(offered.held, "deep_proposed", "the Hat is told to hold its draft");
  const refused = await inRun(false, async () => ({ question: "What free offers do SMEs sign up for?", deep: parsed }), counting);
  assert.strictEqual(refused.proposal, undefined, "a Work that cannot hold (or already had one) gets no proposal");
  assert.strictEqual(refused.held, null);
  assert.strictEqual(researched, 2, "light research is automatic in both runs");
  const plain = await inRun(true, async () => "What free offers do SMEs sign up for?");
  assert.strictEqual(plain.proposal, undefined, "a plain light question proposes nothing");
});

test("no deep proposal when the light research itself paused", async (t) => {
  mockTelegram(t);
  const paused = await inRun(true, async () => ({ question: "What free offers do SMEs sign up for?", deep: parseDeepProposal(DEEP)! }), async () => {
    noteResearchInterrupted(fakeEnv(), "q", { completedOperations: 1, totalOperations: 3 });
    return null;
  });
  assert.strictEqual(paused.proposal, undefined);
  assert.strictEqual(paused.held, "paused");
});
