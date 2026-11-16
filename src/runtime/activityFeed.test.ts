import test from "node:test";
import assert from "node:assert";
import type { Env } from "../types";
import {
  MAX_COMPLETED_OPERATIONS,
  withLiveOperation,
  withLiveStatus,
  type LiveStatusDetailSink,
  type OperationFeed,
} from "./liveStatus";
import { MAX_INTERMEDIATE_EDITS, renderWorkStatus, startWorkStatus, finishWorkStatus, workStatusLiveSink, type WorkStatusHolder } from "./workStatus";
import { createPage, queryDataSource } from "../notion";
import { userLookupContext, workSessionContext, AccessDeniedError } from "../access";
import { aiOperationOutcome, defaultPolicyExecutor } from "../ai/policy";
import { searchOperationOutcome } from "./research/webSearch";
import { pageReadOperationOutcome } from "./research/webPageRead";
import { invokeTool } from "./toolRegistry";
import { GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, GOOGLE_DOCS_TOOL_ID } from "./tools/googleDocsTool";
import { runStrategySkillCycle } from "../units/strategy/strategySkillCycle";

/**
 * #369 -- the outcome-driven live activity feed, on the ONE universal live
 * run (src/runtime/liveStatus.ts). Every test here goes through a real
 * chokepoint or the real run: no reporting handle is passed by a caller.
 */

function fakeEnv(extra: Partial<Env> = {}): Env {
  return {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_GROUP_CHAT_ID: "-100",
    WORKSPACE_TOPIC_ID: "604",
    NOTION_TOKEN: "n",
    NOTION_VERSION: "2025-09-03",
    PAYMENTS_DATA_SOURCE_ID: "pay-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "log-ds",
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
    ...extra,
  } as Env;
}

type Call = { method: string; body: any };

function mockFetch(t: any, notion: (url: string) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      calls.push({ method: url.split("/").pop()!, body: init?.body ? JSON.parse(init.body) : {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }
    if (url.includes("api.notion.com")) return notion(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
const target = { chatId: -100, threadId: 604, header: "Payments Clerk — MAT-32" };
const texts = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => String(c.body.text ?? ""));
const PAYMENTS_STATE = { workId: "w1", chatId: -100, unit: "Finance", hat: "Payments Clerk", actionName: "record_payment" } as any;
const OK_QUERY = () => new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });

/** A sink onto a Hat's own status that also records every feed it is given. */
function recordingSink(env: Env, holder: WorkStatusHolder): { sink: LiveStatusDetailSink; feeds: OperationFeed[] } {
  const inner = workStatusLiveSink(env, holder);
  const feeds: OperationFeed[] = [];
  return {
    feeds,
    sink: {
      ...inner,
      setOperations: (feed) => {
        feeds.push(feed);
        inner.setOperations!(feed);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Notion chokepoint: real queryDataSource / createPage through Access
// ---------------------------------------------------------------------------

test("Notion: a read that succeeds, then one Notion rejects, show their actual outcomes -- and the error reaches the caller unchanged", async (t) => {
  let fail = false;
  const calls = mockFetch(t, () => (fail ? new Response("boom", { status: 500 }) : OK_QUERY()));
  const env = fakeEnv();
  await assert.rejects(
    withLiveStatus(env, target, async () => {
      await queryDataSource(env, "pay-ds", workSessionContext(PAYMENTS_STATE));
      fail = true;
      await queryDataSource(env, "pay-ds", workSessionContext(PAYMENTS_STATE));
    }),
    /Notion API \/data_sources\/pay-ds\/query failed: 500 boom/,
  );
  await flush();
  const last = [...texts(calls, "sendMessage"), ...texts(calls, "editMessageText")].at(-1)!;
  assert.match(last, /✓ Reading Payments\n✗ Reading Payments — failed/);
  assert.match(last, /⛔ Stopped/);
});

test("Notion: 401/403 is shown as refused, not failed", async (t) => {
  const calls = mockFetch(t, () => new Response("no", { status: 403 }));
  const env = fakeEnv();
  await assert.rejects(withLiveStatus(env, target, () => queryDataSource(env, "pay-ds", workSessionContext(PAYMENTS_STATE))));
  await flush();
  assert.match([...texts(calls, "sendMessage"), ...texts(calls, "editMessageText")].at(-1)!, /⛔ Reading Payments — refused/);
});

test("Notion: an Access denial is reported once as refused, nothing reaches Notion, and the AccessDeniedError is rethrown unchanged", async (t) => {
  let notionCalls = 0;
  const calls = mockFetch(t, () => {
    notionCalls++;
    return OK_QUERY();
  });
  const env = fakeEnv();
  await assert.rejects(
    withLiveStatus(env, target, () => createPage(env, "pay-ds", {}, userLookupContext("w1"))),
    (err: unknown) => err instanceof AccessDeniedError,
  );
  await flush();
  assert.strictEqual(notionCalls, 0);
  const last = [...texts(calls, "sendMessage"), ...texts(calls, "editMessageText")].at(-1)!;
  assert.match(last, /⛔ Writing to Payments — refused/);
  assert.strictEqual(last.split("\n").filter((l) => /^⛔ Writing to Payments/.test(l)).length, 1, "reported once");
});

// ---------------------------------------------------------------------------
// The run itself: concurrency, order, nesting, bounds, budget, isolation
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("Hat status: concurrent operations each show ⏳ together; finishes are listed in the order they finished, with their outcomes", async (t) => {
  mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const { sink, feeds } = recordingSink(env, holder);
  const a = deferred<string>();
  const b = deferred<string>();
  await withLiveStatus(env, target, async () => {
    await startWorkStatus(env, holder, "Strategy Analyst", "Strategy Analyst — MAT-1", "Running Strategy Skills");
    const first = withLiveOperation("Applying Skill: business_strategy", () => a.promise, () => "succeeded");
    const second = withLiveOperation("Applying Skill: brand_strategy", () => b.promise, () => "failed");
    assert.deepStrictEqual(feeds.at(-1)!.running.map((r) => r.label), ["Applying Skill: business_strategy", "Applying Skill: brand_strategy"]);
    assert.match(renderWorkStatus(holder.workStatus!), /⏳ Applying Skill: business_strategy\n⏳ Applying Skill: brand_strategy/);
    b.resolve("x");
    await second;
    a.resolve("y");
    await first;
    return "ok";
  }, () => "waiting", sink);
  assert.deepStrictEqual(
    feeds.at(-1)!.completed.map((c) => [c.label, c.outcome]),
    [
      ["Applying Skill: brand_strategy", "failed"],
      ["Applying Skill: business_strategy", "succeeded"],
    ],
    "completion order, not start order",
  );
  assert.match(renderWorkStatus(holder.workStatus!), /✗ Applying Skill: brand_strategy — failed\n✓ Applying Skill: business_strategy/);
});

test("nesting: a chokepoint inside an operation is a detail of it, never a second operation", async (t) => {
  mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const { sink, feeds } = recordingSink(env, holder);
  await withLiveStatus(env, target, async () => {
    await startWorkStatus(env, holder, "H", "H — task", "Step");
    await withLiveOperation("Applying Skill: business_strategy", () => queryDataSource(env, "pay-ds", workSessionContext(PAYMENTS_STATE)));
    return "ok";
  }, () => "waiting", sink);
  assert.deepStrictEqual(feeds.at(-1)!.completed.map((c) => c.label), ["Applying Skill: business_strategy"]);
  assert.deepStrictEqual(holder.workStatus?.trail, ["Reading Payments"], "the inner read is the operation's detail line");
});

test("an operation still running when the run ends is shown as not confirmed, never as done", async (t) => {
  const calls = mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  const never = new Promise<void>(() => undefined);
  await withLiveStatus(env, target, async () => {
    void withLiveOperation("Running google_docs: google_docs.create_and_verify", () => never);
    await flush();
    return "ok";
  }, () => "waiting");
  await flush();
  const last = texts(calls, "editMessageText").at(-1) ?? texts(calls, "sendMessage").at(-1)!;
  assert.match(last, /\? Running google\\_docs: google\\_docs.create\\_and\\_verify — not confirmed/);
  assert.match(last, /⏸ Waiting/);
});

test("bounded: repeats merge, and only the latest finished entries are listed, with a count of the earlier ones", async (t) => {
  mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const { sink, feeds } = recordingSink(env, holder);
  await withLiveStatus(env, target, async () => {
    await startWorkStatus(env, holder, "H", "H — task", "Step");
    for (let i = 0; i < 3; i++) await withLiveOperation("Reading Matters", async () => "x");
    for (let i = 0; i < 12; i++) await withLiveOperation(`Op ${i}`, async () => "x");
    return "ok";
  }, () => "waiting", sink);
  const feed = feeds.at(-1)!;
  assert.strictEqual(feed.completed.length, MAX_COMPLETED_OPERATIONS);
  assert.strictEqual(feed.earlier, 7, "the 3 merged reads count as 3 earlier operations, plus the 4 oldest ops");
  const text = renderWorkStatus(holder.workStatus!);
  assert.match(text, /… 7 earlier\n✓ Op 4\n/);
  assert.ok(!text.includes("Reading Matters"), "dropped entries are summarised, not listed");
});

test("budget: however many operations, a Hat's message gets at most 1 send + MAX_INTERMEDIATE_EDITS edits + 1 final edit", async (t) => {
  const calls = mockFetch(t, OK_QUERY);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const env = fakeEnv();
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  await withLiveStatus(env, target, async () => {
    await startWorkStatus(env, holder, "H", "H — task", "Step");
    for (let i = 0; i < 40; i++) {
      await withLiveOperation(`Op ${i}`, async () => "x");
      t.mock.timers.tick(5000);
      await flush();
    }
    await finishWorkStatus(env, holder, "✅ Done", "succeeded");
    return "ok";
  }, () => "succeeded", workStatusLiveSink(env, holder));
  await flush();
  assert.strictEqual(texts(calls, "sendMessage").length, 1);
  assert.ok(texts(calls, "editMessageText").length <= MAX_INTERMEDIATE_EDITS + 1, `edits: ${texts(calls, "editMessageText").length}`);
});

test("isolation: a reporting failure never changes an operation's result or error", async (t) => {
  mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const broken: LiveStatusDetailSink = {
    ...workStatusLiveSink(env, holder),
    setOperations: () => {
      throw new Error("sink broke");
    },
  };
  const result = await withLiveStatus(env, target, async () => {
    await startWorkStatus(env, holder, "H", "H — task", "Step");
    const ok = await withLiveOperation("Op", async () => 7);
    await assert.rejects(withLiveOperation("Op2", async () => {
      throw new RangeError("the real error");
    }), RangeError);
    return ok;
  }, () => "waiting", broken);
  assert.strictEqual(result, 7);
});

test("outside a run an operation just runs: same value, same error, nothing reported", async () => {
  assert.strictEqual(await withLiveOperation("Op", async () => 3), 3);
  await assert.rejects(withLiveOperation("Op", async () => {
    throw new TypeError("x");
  }), TypeError);
});

// ---------------------------------------------------------------------------
// AI, search, page read and Tool chokepoints
// ---------------------------------------------------------------------------

test("AI: a call no provider can answer ends failed; a gate refusal is denied; a result is succeeded", async (t) => {
  const calls = mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  await withLiveStatus(env, target, async () => {
    await defaultPolicyExecutor.executeTaskWithOutcome(env, {
      taskId: "finance.intake_classification",
      boundaryContext: { segments: [{ type: "user", content: "PRIVATE", provenance: "test" }] },
      type: "json",
      messages: [{ role: "user", content: "PRIVATE" }],
    } as any);
    return "ok";
  }, () => "waiting");
  await flush();
  const last = [...texts(calls, "sendMessage"), ...texts(calls, "editMessageText")].at(-1)!;
  assert.match(last, /✗ Working out what the Finance message is — failed/);
  assert.ok(!last.includes("PRIVATE"));
  assert.strictEqual(aiOperationOutcome({ ok: false, cause: "outbound_gate_blocked", gateReasons: [] }), "denied");
  assert.strictEqual(aiOperationOutcome({ ok: true } as any), "succeeded");
});

test("search and page read: outcomes map to what actually happened", () => {
  assert.strictEqual(searchOperationOutcome({ kind: "success_no_results" }), "succeeded");
  assert.strictEqual(searchOperationOutcome({ kind: "internal_allowance_exhausted", reason: "x" }), "denied");
  assert.strictEqual(searchOperationOutcome({ kind: "interrupted", reason: "x" }), "failed");
  assert.strictEqual(pageReadOperationOutcome({ kind: "empty_page", reason: "x" }), "partially_completed");
  assert.strictEqual(pageReadOperationOutcome({ kind: "blocked_by_site", reason: "x" }), "failed");
  assert.strictEqual(pageReadOperationOutcome({ kind: "internal_allowance_exhausted", reason: "x" }), "denied");
});

test("Tool: a registered operation refused at its input contract is reported as refused, by its registered ids only", async (t) => {
  const calls = mockFetch(t, OK_QUERY);
  const env = fakeEnv();
  const outcome = await withLiveStatus(env, target, () => invokeTool(env, { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, input: "SECRET INPUT" as any }, workSessionContext(PAYMENTS_STATE)), () => "waiting");
  await flush();
  assert.strictEqual(outcome.state, "denied", "the invocation's own outcome is unchanged");
  const last = [...texts(calls, "sendMessage"), ...texts(calls, "editMessageText")].at(-1)!;
  assert.match(last, /⛔ Running google\\_docs: google\\_docs.create\\_and\\_verify — refused/);
  assert.ok(!last.includes("SECRET INPUT"));
});

// ---------------------------------------------------------------------------
// Strategy: the real skill cycle, with no reporting handle passed in
// ---------------------------------------------------------------------------

test("Strategy skill cycle: each planned Skill is its own parallel operation with its real outcome, and its AI call is not listed twice", async (t) => {
  mockFetch(t, OK_QUERY);
  const env = fakeEnv({
    AI_MODEL_PRIMARY: "m",
    AI_MODEL_LIGHT: "m-light",
    AI: {
      run: async (_m: unknown, o: any) => {
        const all = (o?.messages ?? []).map((m: any) => String(m.content)).join("\n");
        if (all.includes("bounded Strategy Skill: `business_strategy`")) return { response: JSON.stringify({ sufficient: true, finding: "f", evidenceLimitation: "l", implication: "i" }) };
        if (all.includes("bounded Strategy Skill: `brand_strategy`")) return { response: JSON.stringify({ sufficient: false, blockedReason: "missing evidence" }) };
        if (all.includes('"plan"')) return { response: JSON.stringify({ interpretation: "x", plan: [{ skillId: "business_strategy", question: "q1" }, { skillId: "brand_strategy", question: "q2" }], rationale: "r" }) };
        return { response: "{}" };
      },
    } as any,
  });
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const { sink, feeds } = recordingSink(env, holder);
  const skills = { declared: ["strategy_analysis", "business_strategy", "brand_strategy"], get: () => ({ content: "method" }) } as any;
  await withLiveStatus(env, target, async () => {
    await startWorkStatus(env, holder, "Strategy Analyst", "Strategy Analyst — MAT-1", "Diagnosing");
    await runStrategySkillCycle({ env, strategyQuestion: "Why is growth flat?", strategyContext: "A services business with flat growth.", skills });
    return "ok";
  }, () => "waiting", sink);
  assert.ok(feeds.some((f) => f.running.filter((r) => r.label.startsWith("Applying Skill")).length === 2), "both Skills were running at the same time");
  const completed = feeds.at(-1)!.completed.map((c) => [c.label, c.outcome]);
  assert.ok(completed.some(([l, o]) => l === "Applying Skill: business_strategy" && o === "succeeded"));
  assert.ok(completed.some(([l, o]) => l === "Applying Skill: brand_strategy" && o === "failed"));
  assert.ok(!completed.some(([l]) => /Business Diagnosis|Brand Diagnosis/i.test(String(l))), "the Skill's own AI call is not a second entry");
});
