import test from "node:test";
import assert from "node:assert";
import type { Env } from "../types";
import { MAX_EDITS, reportLiveStep, withLiveStatus, yieldLiveStatusToHat, type LiveStatusDetailSink } from "./liveStatus";
import { workLiveOutcome, workLiveStatusTarget, workStatusLiveSink, startWorkStatus, type WorkStatusHolder } from "./workStatus";
import { queryDataSource } from "../notion";
import { workSessionContext } from "../access";

/**
 * Universal live status (2026-11-11): any run reports what it is doing from
 * the shared chokepoints -- quiet for 2 seconds, one message per run,
 * deleted on success, kept with ⏸ / ⛔ otherwise, inside a fixed Telegram
 * budget, never blocking the run, never carrying content.
 */

function fakeEnv(): Env {
  return {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_GROUP_CHAT_ID: "-100",
    WORKSPACE_TOPIC_ID: "604",
    NOTION_TOKEN: "n",
    NOTION_VERSION: "2025-09-03",
    PAYMENTS_DATA_SOURCE_ID: "pay-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "log-ds",
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
  } as Env;
}

type Call = { method: string; body: any };

function mockTelegram(t: any, opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop()!;
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : {} });
      if (opts.fail) return new Response(JSON.stringify({ ok: false }), { status: 500 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }
    if (url.includes("/v1/data_sources/pay-ds/query")) {
      return new Response(JSON.stringify({ results: [{ id: "p1", properties: { Payment: { title: [{ plain_text: "SECRET CLIENT TITLE" }] } } }], has_more: false }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const target = { chatId: -100, threadId: 604, header: "Payments Clerk — MAT-32" };
const texts = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => String(c.body.text ?? ""));

test("always shown: even a run that takes no time shows its first step at once, then removes it on success", async (t) => {
  const calls = mockTelegram(t);
  const result = await withLiveStatus(fakeEnv(), target, async () => {
    reportLiveStep("Reading Payments");
    await flush();
    return "answer";
  });
  await flush();
  assert.strictEqual(result, "answer");
  assert.match(texts(calls, "sendMessage")[0], /⏳ Reading Payments/);
  assert.strictEqual(calls.at(-1)!.method, "deleteMessage");
});

test("a run that reports no step sends nothing", async (t) => {
  const calls = mockTelegram(t);
  await withLiveStatus(fakeEnv(), target, async () => "ok");
  await flush();
  assert.strictEqual(calls.length, 0);
});

test("edits: the trailing timer sends the latest state even when the clock has not advanced (Worker clocks only move on I/O)", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout"] }); // Date NOT advanced: the frozen-clock case
  await withLiveStatus(fakeEnv(), target, async () => {
    reportLiveStep("Reading Payments");
    await flush();
    reportLiveStep("Writing to Payments");
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.match(texts(calls, "editMessageText").at(-1) ?? "", /⏳ Writing to Payments/);
    return { stage: "awaiting_x" };
  }, (s) => workLiveOutcome(s as any));
});

test("a run: one message, edited in place with the steps, deleted when it succeeds", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await withLiveStatus(fakeEnv(), target, async () => {
    reportLiveStep("Reading Payments");
    reportLiveStep("Reading Payments");
    t.mock.timers.tick(2000);
    await flush();
    reportLiveStep("Writing to Payments");
    t.mock.timers.tick(1000);
    reportLiveStep("Writing to the Activity Log");
    await flush();
    return "ok";
  });
  await flush();
  const sent = texts(calls, "sendMessage");
  assert.strictEqual(sent.length, 1, "exactly one status message");
  assert.match(sent[0], /🧭 Payments Clerk — MAT-32/);
  assert.match(sent[0], /⏳ Reading Payments ×2/);
  const edits = texts(calls, "editMessageText");
  assert.ok(edits.length >= 1);
  assert.match(edits.at(-1)!, /✓ Writing to Payments\n⏳ Writing to the Activity Log/);
  assert.deepStrictEqual(calls.at(-1), { method: "deleteMessage", body: { chat_id: -100, message_id: 42 } }, "a successful run removes its status");
  assert.strictEqual(calls.find((c) => c.method === "sendMessage")!.body.message_thread_id, 604, "shown in the run's own topic");
});

test("waiting: a run that stops for Martin keeps its status, ending ⏸", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await withLiveStatus(
    fakeEnv(),
    target,
    async () => {
      reportLiveStep("Reading Payments");
      t.mock.timers.tick(2000);
      await flush();
      return { stage: "awaiting_payment_approval" };
    },
    (s) => workLiveOutcome(s as any),
  );
  await flush();
  assert.ok(!calls.some((c) => c.method === "deleteMessage"));
  assert.match(texts(calls, "editMessageText").at(-1)!, /✓ Reading Payments\n⏸ Waiting for your reply or approval\./);
});

test("failed: a thrown run ends ⛔ naming the step it stopped at, and the error is rethrown unchanged", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const boom = new Error("boom");
  await assert.rejects(
    () =>
      withLiveStatus(fakeEnv(), target, async () => {
        reportLiveStep("Writing to Payments");
        t.mock.timers.tick(2000);
        await flush();
        throw boom;
      }),
    (err) => err === boom,
  );
  await flush();
  assert.match(texts(calls, "editMessageText").at(-1)!, /✗ Writing to Payments\n⛔ Stopped at: Writing to Payments\./);
});

test("budget: however many steps, at most 1 send + MAX_EDITS edits + 1 final call", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await withLiveStatus(fakeEnv(), target, async () => {
    for (let i = 0; i < 60; i++) {
      reportLiveStep(`Step ${i}`);
      t.mock.timers.tick(1000);
      await flush();
    }
    return "ok";
  });
  await flush();
  assert.strictEqual(texts(calls, "sendMessage").length, 1);
  assert.ok(texts(calls, "editMessageText").length <= MAX_EDITS, `edits ${texts(calls, "editMessageText").length}`);
  assert.strictEqual(calls.filter((c) => c.method === "deleteMessage").length, 1);
  assert.ok(calls.length <= 1 + MAX_EDITS + 1);
});

test("never blocking: Telegram failing on every call does not change the run's result", async (t) => {
  mockTelegram(t, { fail: true });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const result = await withLiveStatus(fakeEnv(), target, async () => {
    reportLiveStep("Reading Payments");
    t.mock.timers.tick(5000);
    await flush();
    return 7;
  });
  assert.strictEqual(result, 7);
});

test("one message per run: a nested run joins the open one", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await withLiveStatus(fakeEnv(), target, async () =>
    withLiveStatus(fakeEnv(), { ...target, header: "inner" }, async () => {
      reportLiveStep("Reading Matters");
      t.mock.timers.tick(2000);
      await flush();
      return "ok";
    }),
  );
  await flush();
  const sent = texts(calls, "sendMessage");
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Payments Clerk — MAT-32/);
});

test("outside any run, reporting a step is a no-op", async (t) => {
  const calls = mockTelegram(t);
  reportLiveStep("Reading Payments");
  yieldLiveStatusToHat();
  await flush();
  assert.strictEqual(calls.length, 0);
});

test("a Hat's own named status leads: the live run sends nothing and records what ran under the Hat's step -- kept after the step finishes", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const { advanceWorkStatus, finishWorkStatus } = await import("./workStatus");
  await withLiveStatus(
    fakeEnv(),
    target,
    async () => {
      await startWorkStatus(fakeEnv(), holder, "Marketing Strategist", "Marketing Strategist — task", "Deciding within ownership");
      t.mock.timers.tick(3500);
      reportLiveStep("Thinking (Web Research Check)");
      reportLiveStep("Searching the web");
      reportLiveStep("Searching the web");
      reportLiveStep("Searching the web");
      await flush();
      assert.deepStrictEqual(holder.workStatus?.trail, ["Thinking (Web Research Check)", "Searching the web ×3"]);
      await advanceWorkStatus(fakeEnv(), holder, "Writing the draft");
      await finishWorkStatus(fakeEnv(), holder, "⏸ Needs clarification -- the question is below.", "succeeded");
      return "ok";
    },
    () => "succeeded",
    workStatusLiveSink(fakeEnv(), holder),
  );
  await flush();
  assert.strictEqual(texts(calls, "sendMessage").length, 1, "only the Hat's own message");
  assert.ok(!calls.some((c) => c.method === "deleteMessage"), "the Hat's message is the Hat's to finish");
  assert.match(texts(calls, "editMessageText").at(-1)!, /✓ Deciding within ownership\n✓ Thinking \(Web Research Check\)\n✓ Searching the web ×3\n✓ Writing the draft\n⏸ Needs clarification/);
});

test("a live message already shown gives way when a Hat opens its own named status", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const holder: WorkStatusHolder = { chatId: -100, workId: "w1" };
  const sink: LiveStatusDetailSink = workStatusLiveSink(fakeEnv(), holder);
  await withLiveStatus(
    fakeEnv(),
    target,
    async () => {
      reportLiveStep("Reading Handoffs");
      t.mock.timers.tick(2000);
      await flush();
      await startWorkStatus(fakeEnv(), holder, "Strategy Analyst", "Strategy Analyst — MAT-32", "Reading the Handoff");
      await flush();
      return "ok";
    },
    () => "succeeded",
    sink,
  );
  await flush();
  assert.strictEqual(calls.filter((c) => c.method === "deleteMessage").length, 1, "the live message is removed once");
  assert.strictEqual(texts(calls, "sendMessage").length, 2, "the live message, then the Hat's own");
});

test("chokepoint: a Notion read inside a run reports the source's fixed name -- never the page title", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const state = { workId: "w1", chatId: -100, unit: "Finance", hat: "Payments Clerk", actionName: "record_payment" } as any;
  await withLiveStatus(fakeEnv(), target, async () => {
    await queryDataSource(fakeEnv(), "pay-ds", workSessionContext(state));
    t.mock.timers.tick(2000);
    await flush();
    return "ok";
  }, () => "waiting");
  await flush();
  const all = calls.map((c) => JSON.stringify(c.body)).join("\n");
  assert.match(texts(calls, "sendMessage")[0], /Reading Payments/);
  assert.ok(!all.includes("SECRET CLIENT TITLE"), "no record content ever reaches the status");
});

test("work runs: header and outcome come from the Work's own fields", () => {
  assert.deepStrictEqual(workLiveStatusTarget({ chatId: 1, threadId: 2, hat: "Payments Clerk", unit: "Finance", actionName: "record_payment", matterToken: "MAT-32" } as any), {
    chatId: 1,
    threadId: 2,
    header: "Payments Clerk — MAT-32",
  });
  assert.strictEqual(workLiveStatusTarget({ chatId: 1, unit: "Finance", actionName: "record_payment" } as any).header, "Finance — record payment");
  assert.strictEqual(workLiveOutcome({ stage: "complete" } as any), "succeeded");
  assert.strictEqual(workLiveOutcome({ stage: "complete", awaiting: "x" } as any), "waiting");
  assert.strictEqual(workLiveOutcome({ stage: "awaiting_lead_approval" } as any), "waiting");
});

test("chokepoint: an AI call inside a run reports the registered task's name -- never the prompt", async (t) => {
  const calls = mockTelegram(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { defaultPolicyExecutor } = await import("../ai/policy");
  await withLiveStatus(fakeEnv(), target, async () => {
    // No provider is configured in this Env, so nothing is sent anywhere; the step is still the call starting.
    await defaultPolicyExecutor.executeTaskWithOutcome(fakeEnv(), {
      taskId: "finance.intake_classification",
      boundaryContext: { segments: [{ type: "user", content: "PRIVATE PROMPT TEXT", provenance: "test" }] },
      type: "json",
      messages: [{ role: "user", content: "PRIVATE PROMPT TEXT" }],
    } as any);
    t.mock.timers.tick(2000);
    await flush();
    return "ok";
  }, () => "waiting");
  await flush();
  const all = calls.map((c) => JSON.stringify(c.body)).join("\n");
  assert.match(texts(calls, "sendMessage")[0], /Thinking \(Finance Intake Classification\)/);
  assert.ok(!all.includes("PRIVATE PROMPT TEXT"));
});
