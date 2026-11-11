import test from "node:test";
import assert from "node:assert";
import type { Env, WorkState } from "../../types";
import { handlePaymentApproval, handleRecordPaymentRequest, parsePaidDate, parsePaymentReport, PAYMENTS_CLERK_DEFINITION_PAGE_ID } from "./paymentsClerk";
import { financeManifest } from "./financeManifest";
import { findCallbackHandler } from "../unitManifest";
import { updatePage, select } from "../../notion";
import { AccessDeniedError, workSessionContext } from "../../access";

/**
 * Payments Clerk (Finance, 2026-11-11): reads Martin's payment report with
 * fixed rules, finds the one Due Payment row, stages the exact change on a
 * card, and sets the row to Paid only on Martin's tap -- with every stop
 * rule (missing parts, no/duplicate Due row, wrong currency, row changed
 * since the card) and the "ask" on an amount that does not match.
 */

const TODAY = "2026-11-12";
const MARTIN = "Finance, MAT-32 deposit paid, GHS 6,000, bank transfer, 12 Nov, WHT 300, invoice INV-014.";
const PAY_DS = "pay-ds";
const LOG_DS = "log-ds";

function fakeEnv(governance: string | null = "hat: Payments Clerk"): Env {
  return {
    NOTION_TOKEN: "t",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_GROUP_CHAT_ID: "-100",
    WORKSPACE_TOPIC_ID: "604",
    PAYMENTS_DATA_SOURCE_ID: PAY_DS,
    ACTIVITY_LOG_DATA_SOURCE_ID: LOG_DS,
    STATE_KV: {
      get: async (key: string) => (key === `governance:${PAYMENTS_CLERK_DEFINITION_PAGE_ID}` ? governance : null),
      put: async () => {},
      delete: async () => {},
    } as any,
  } as Env;
}

function fakeState(): WorkState {
  return { workId: "work-pay-1", chatId: -100, threadId: 604, unit: "Finance", hat: "Payments Clerk", actionName: "record_payment", stage: "new" } as WorkState;
}

interface Row {
  id: string;
  number: number;
  matter: string;
  type: string;
  status: string;
  currency: string;
  amount: number | null;
  paidDate?: string | null;
  method?: string | null;
  wht?: number | null;
  invoice?: string;
}

function props(r: Row) {
  return {
    Payment: { title: [{ plain_text: `${r.matter} ${r.type.toLowerCase()}` }] },
    Payment_ID: { unique_id: { prefix: "PAY", number: r.number } },
    Matter_Token: { rich_text: [{ plain_text: r.matter }] },
    Type: { select: { name: r.type } },
    Status: { select: { name: r.status } },
    Currency: { select: { name: r.currency } },
    Amount: { number: r.amount },
    Due_Date: { date: { start: "2026-11-10" } },
    Paid_Date: { date: r.paidDate ? { start: r.paidDate } : null },
    Method: { select: r.method ? { name: r.method } : null },
    WHT_Deducted: { number: r.wht ?? null },
    Invoice_Number: { rich_text: r.invoice ? [{ plain_text: r.invoice }] : [] },
  };
}

function mockNotion(t: any, rows: Row[], opts: { failPatch?: boolean } = {}) {
  const calls = { queries: 0, patches: [] as any[], logs: [] as any[], telegram: [] as any[] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (url.includes("api.telegram.org")) {
      calls.telegram.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.telegram.length } }), { status: 200 });
    }
    if (url.includes(`/v1/data_sources/${PAY_DS}/query`)) {
      calls.queries++;
      const [m, ty] = body.filter.and;
      const results = rows.filter((r) => r.matter === m.rich_text.equals && r.type === ty.select.equals).map((r) => ({ id: r.id, url: `https://notion.so/${r.id}`, properties: props(r) }));
      return new Response(JSON.stringify({ results, has_more: false }), { status: 200 });
    }
    const page = url.match(/\/v1\/pages\/([^/?]+)$/);
    if (page) {
      const row = rows.find((r) => r.id === page[1]);
      if (!row) return new Response("{}", { status: 404 });
      if (init?.method === "PATCH") {
        calls.patches.push(body.properties);
        if (opts.failPatch) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
        const p = body.properties;
        if (p.Status) row.status = p.Status.select.name;
        if (p.Paid_Date) row.paidDate = p.Paid_Date.date.start;
        if (p.Method) row.method = p.Method.select.name;
        if (p.WHT_Deducted) row.wht = p.WHT_Deducted.number;
        if (p.Invoice_Number) row.invoice = p.Invoice_Number.rich_text[0].text.content;
      }
      return new Response(JSON.stringify({ id: row.id, url: `https://notion.so/${row.id}`, parent: { type: "data_source_id", data_source_id: PAY_DS }, properties: props(row) }), { status: 200 });
    }
    if (url.endsWith("/v1/pages") && init?.method === "POST") {
      calls.logs.push(body);
      return new Response(JSON.stringify({ id: `log-${calls.logs.length}`, url: "https://notion.so/log" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const dueDeposit = (over: Partial<Row> = {}): Row => ({ id: "row-1", number: 5, matter: "MAT-32", type: "Deposit", status: "Due", currency: "GHS", amount: 6000, ...over });
const lastText = (calls: { telegram: any[] }) => String(calls.telegram.at(-1)?.text ?? "");
const logText = (log: any) => JSON.stringify(log);

// ---------------------------------------------------------------- parsing

test("parse: Martin's own sentence reads every field, with no AI call", () => {
  assert.deepStrictEqual(parsePaymentReport(MARTIN, TODAY), {
    problems: [],
    matter: "MAT-32",
    type: "Deposit",
    wht: 300,
    invoice: "INV-014",
    amount: 6000,
    currency: "GHS",
    method: "Bank transfer",
    paidDate: "2026-11-12",
  });
});

test("parse: other wordings -- amount after the currency word, mobile money, USD, no WHT, no invoice", () => {
  const r = parsePaymentReport("MAT-7 balance came in, 1,250.50 USD via momo on 2026-11-03", TODAY);
  assert.deepStrictEqual(
    { m: r.matter, t: r.type, a: r.amount, c: r.currency, me: r.method, d: r.paidDate, w: r.wht, i: r.invoice, p: r.problems },
    { m: "MAT-7", t: "Balance", a: 1250.5, c: "USD", me: "Mobile money", d: "2026-11-03", w: undefined, i: undefined, p: [] },
  );
});

test("parse: a missing date defaults to today and says so; a future date is refused", () => {
  const r = parsePaymentReport("MAT-32 deposit GHS 6000 bank transfer", TODAY);
  assert.strictEqual(r.paidDate, TODAY);
  assert.strictEqual(r.paidDateDefaulted, true);
  const f = parsePaymentReport("MAT-32 deposit GHS 6000 bank transfer on 2026-12-01", TODAY);
  assert.match(f.problems.join(" "), /not in the future/);
});

test("parse: missing or ambiguous parts are listed, never guessed", () => {
  const r = parsePaymentReport("deposit and balance paid, 6000, MAT-3 and MAT-4", TODAY);
  const problems = r.problems.join(" | ");
  assert.match(problems, /exactly one Matter/);
  assert.match(problems, /only one of deposit or balance/);
  assert.match(problems, /amount with its currency/);
  assert.match(problems, /how it was paid/);
  assert.strictEqual(r.matter, undefined);
  assert.strictEqual(r.amount, undefined);
});

test("parse: dates -- 'Nov 12', 'yesterday', and a yearless date that would be in the future is last year's", () => {
  assert.strictEqual(parsePaidDate("paid Nov 12", TODAY).date, "2026-11-12");
  assert.strictEqual(parsePaidDate("paid yesterday", TODAY).date, "2026-11-11");
  assert.strictEqual(parsePaidDate("paid 28 Dec", "2027-01-02").date, "2026-12-28");
  assert.match(String(parsePaidDate("paid 2026-02-30", TODAY).problem), /not a valid date/);
});

// ---------------------------------------------------------------- staging

test("entry: one Due row, gross amount matches -- shows the exact change on a card and writes nothing", async (t) => {
  const calls = mockNotion(t, [dueDeposit()]);
  const state = await handleRecordPaymentRequest(fakeEnv(), fakeState(), MARTIN, TODAY);
  assert.strictEqual(state.stage, "awaiting_payment_approval");
  assert.strictEqual(calls.patches.length, 0);
  assert.strictEqual(state.finance?.pendingPayment?.amountCheck, "gross");
  const card = lastText(calls);
  for (const line of ["Record payment — MAT-32 deposit", "PAY-5", "Status: Due → Paid", "Paid date: — → 2026-11-12", "Method: — → Bank transfer", "WHT deducted: — → 300", "Invoice number: — → INV-014", "matches the row's Amount"]) {
    assert.ok(card.includes(line), `card shows "${line}"`);
  }
  const buttons = calls.telegram.at(-1).reply_markup.inline_keyboard[0];
  assert.deepStrictEqual(buttons.map((b: any) => b.callback_data), ["paymentrecord:work-pay-1:approve", "paymentrecord:work-pay-1:reject"]);
  assert.strictEqual(buttons[0].text, "✅ Record");
});

test("entry: net amount (received + WHT = the row's Amount) also matches", async (t) => {
  const calls = mockNotion(t, [dueDeposit()]);
  const state = await handleRecordPaymentRequest(fakeEnv(), fakeState(), "Finance, MAT-32 deposit, GHS 5,700 received, WHT 300, bank transfer", TODAY);
  assert.strictEqual(state.finance?.pendingPayment?.amountCheck, "net");
  assert.match(lastText(calls), /5,700 received \+ WHT 300 = GHS 6,000/);
});

test("entry: an amount that does not match ASKS -- 'Record anyway', the gap shown, the Amount never changed", async (t) => {
  const calls = mockNotion(t, [dueDeposit()]);
  const state = await handleRecordPaymentRequest(fakeEnv(), fakeState(), "Finance, MAT-32 deposit, GHS 5,000, bank transfer", TODAY);
  assert.strictEqual(state.stage, "awaiting_payment_approval");
  assert.strictEqual(state.finance?.pendingPayment?.amountCheck, "mismatch");
  assert.match(lastText(calls), /row's Amount is GHS 6,000 \(a gap of GHS 1,000\)\. The row's Amount will not change\. Record it as Paid anyway\?/);
  assert.strictEqual(calls.telegram.at(-1).reply_markup.inline_keyboard[0][0].text, "✅ Record anyway");
});

test("entry: stops (no card) when the row is already Paid", async (t) => {
  const paid = mockNotion(t, [dueDeposit({ status: "Paid", paidDate: "2026-11-01" })]);
  let s = await handleRecordPaymentRequest(fakeEnv(), fakeState(), MARTIN, TODAY);
  assert.strictEqual(s.stage, "cancelled");
  assert.match(lastText(paid), /already recorded as Paid on 2026-11-01/);
  assert.strictEqual(s.finance?.pendingPayment, undefined);
});

test("entry: stops when there is no row at all, pointing at signing", async (t) => {
  const calls = mockNotion(t, []);
  const s = await handleRecordPaymentRequest(fakeEnv(), fakeState(), MARTIN, TODAY);
  assert.strictEqual(s.stage, "cancelled");
  assert.match(lastText(calls), /no Due deposit row for MAT-32/);
});

test("entry: stops when two Due rows match", async (t) => {
  const calls = mockNotion(t, [dueDeposit(), dueDeposit({ id: "row-2", number: 6 })]);
  const s = await handleRecordPaymentRequest(fakeEnv(), fakeState(), MARTIN, TODAY);
  assert.strictEqual(s.stage, "cancelled");
  assert.match(lastText(calls), /2 Due deposit rows \(PAY-5, PAY-6\)/);
});

test("entry: stops when the currency differs from the row's", async (t) => {
  const calls = mockNotion(t, [dueDeposit({ currency: "USD" })]);
  const s = await handleRecordPaymentRequest(fakeEnv(), fakeState(), MARTIN, TODAY);
  assert.strictEqual(s.stage, "cancelled");
  assert.match(lastText(calls), /PAY-5 is in USD, but you reported GHS/);
});

test("entry: stops before reading Payments when a required part is missing", async (t) => {
  const calls = mockNotion(t, [dueDeposit()]);
  const s = await handleRecordPaymentRequest(fakeEnv(), fakeState(), "Finance, MAT-32 deposit paid", TODAY);
  assert.strictEqual(s.stage, "cancelled");
  assert.strictEqual(calls.queries, 0);
  assert.match(lastText(calls), /I need the amount with its currency/);
});

test("entry: fails closed when the Payments Clerk's Notion definition is unreadable", async (t) => {
  const calls = mockNotion(t, [dueDeposit()]);
  const env = fakeEnv(null);
  // getGovernance falls back to Notion when nothing is cached; make that read fail too.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => (String(input).includes(PAYMENTS_CLERK_DEFINITION_PAGE_ID.replace(/-/g, "")) || String(input).includes(PAYMENTS_CLERK_DEFINITION_PAGE_ID) ? new Response("{}", { status: 404 }) : original(input, init))) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const s = await handleRecordPaymentRequest(env, fakeState(), MARTIN, TODAY);
  assert.strictEqual(s.stage, "cancelled");
  assert.strictEqual(calls.queries, 0);
  assert.match(lastText(calls), /couldn't read the Payments Clerk's definition/);
});

// ---------------------------------------------------------------- approval

async function staged(t: any, rows: Row[], opts?: { failPatch?: boolean }) {
  const calls = mockNotion(t, rows, opts);
  const state = await handleRecordPaymentRequest(fakeEnv(), fakeState(), MARTIN, TODAY);
  return { calls, state };
}

test("approve: writes exactly the shown change, reads it back, logs it and confirms", async (t) => {
  const rows = [dueDeposit()];
  const { calls, state } = await staged(t, rows);
  const done = await handlePaymentApproval(fakeEnv(), state, true);
  assert.strictEqual(done.stage, "complete");
  assert.deepStrictEqual(calls.patches, [
    {
      Status: { select: { name: "Paid" } },
      Paid_Date: { date: { start: "2026-11-12" } },
      Method: { select: { name: "Bank transfer" } },
      WHT_Deducted: { number: 300 },
      Invoice_Number: { rich_text: [{ text: { content: "INV-014" } }] },
    },
  ]);
  assert.strictEqual(rows[0].amount, 6000, "Amount untouched");
  assert.ok(!("Amount" in calls.patches[0]) && !("Currency" in calls.patches[0]) && !("Type" in calls.patches[0]));
  assert.match(lastText(calls), /MAT-32 deposit \(PAY-5\) recorded as Paid on 2026-11-12/);
  assert.match(lastText(calls), /can start once its agreement is Signed/);
  assert.ok(calls.logs.some((l) => /Payment recorded: MAT-32 deposit \(PAY-5\)/.test(logText(l))));
  assert.strictEqual(done.finance?.pendingPayment, undefined);
});

test("approve: the card's Record button reaches the Payments Clerk through the manifest's callback handler", async (t) => {
  const { calls, state } = await staged(t, [dueDeposit()]);
  const handler = findCallbackHandler("paymentrecord", financeManifest.hats["Payments Clerk"]);
  assert.ok(handler);
  await handler!(fakeEnv(), state, true, "approve");
  assert.strictEqual(calls.patches.length, 1);
});

test("cancel: writes nothing and says the row is unchanged", async (t) => {
  const { calls, state } = await staged(t, [dueDeposit()]);
  const done = await handlePaymentApproval(fakeEnv(), state, false);
  assert.strictEqual(done.stage, "cancelled");
  assert.strictEqual(calls.patches.length, 0);
  assert.match(lastText(calls), /Cancelled\. MAT-32 deposit \(PAY-5\) is unchanged/);
});

test("replay: a second tap after the first is a no-op", async (t) => {
  const { calls, state } = await staged(t, [dueDeposit()]);
  await handlePaymentApproval(fakeEnv(), state, true);
  await handlePaymentApproval(fakeEnv(), state, true);
  assert.strictEqual(calls.patches.length, 1);
  assert.match(lastText(calls), /no pending payment on this card/);
});

test("approve: a row that changed after the card was sent is not written", async (t) => {
  const rows = [dueDeposit()];
  const { calls, state } = await staged(t, rows);
  rows[0].status = "Waived";
  const done = await handlePaymentApproval(fakeEnv(), state, true);
  assert.strictEqual(calls.patches.length, 0);
  assert.strictEqual(done.stage, "cancelled");
  assert.match(lastText(calls), /changed after the card was sent \(its Status is now Waived, not Due\)/);
});

test("approve: a failed write is logged as a Blocker and the card can be tapped again", async (t) => {
  const { calls, state } = await staged(t, [dueDeposit()], { failPatch: true });
  const done = await handlePaymentApproval(fakeEnv(), state, true);
  assert.strictEqual(calls.patches.length, 1);
  assert.ok(done.finance?.pendingPayment, "restaged for a fresh tap");
  assert.match(lastText(calls), /write to MAT-32 deposit \(PAY-5\) failed/);
  assert.ok(calls.logs.some((l) => /Blocker/.test(logText(l))));
});

test("Access: a Payment update under record_payment without Martin's approval proof is refused", async (t) => {
  mockNotion(t, [dueDeposit()]);
  await assert.rejects(() => updatePage(fakeEnv(), "row-1", { Status: select("Paid") }, workSessionContext(fakeState())), AccessDeniedError);
});

// ---------------------------------------------------------------- routing

test("routing: a bare 'Finance, ...' payment message resolves to Payments Clerk / record_payment once Stage 1 names it", async (t) => {
  const { tryResolveUnitAction } = await import("../dispatch");
  mockNotion(t, []);
  const env = {
    ...fakeEnv(),
    // Stage 1 (which Hat), then Chat's Stage 2 (which Action of that Hat).
    AI: {
      run: (() => {
        const replies = [{ candidates: ["Payments Clerk"], establishing: true, reason: "records a received payment" }, { action: "record_payment" }];
        let i = 0;
        return async () => ({ response: JSON.stringify(replies[Math.min(i++, replies.length - 1)]) });
      })(),
    } as any,
    AI_MODEL_LIGHT: "test-light",
    AI_MODEL_PRIMARY: "test-primary",
  } as Env;
  const result = await tryResolveUnitAction(env, financeManifest, { chatId: -100, threadId: 604 }, MARTIN);
  assert.strictEqual(result.kind, "continue");
  assert.strictEqual((result as any).hat, "Payments Clerk");
  assert.strictEqual((result as any).actionName, "record_payment");
});

test("routing: naming the Hat directly skips Stage 1 (only Chat's Stage 2 action check runs)", async (t) => {
  const { tryResolveUnitAction } = await import("../dispatch");
  mockNotion(t, []);
  let aiCalls = 0;
  const env = { ...fakeEnv(), AI: { run: async () => (aiCalls++, { response: JSON.stringify({ action: "record_payment" }) }) } as any, AI_MODEL_LIGHT: "l", AI_MODEL_PRIMARY: "p" } as Env;
  const result = await tryResolveUnitAction(env, financeManifest, { chatId: -100, threadId: 604 }, MARTIN, "Payments Clerk");
  assert.strictEqual((result as any).hat, "Payments Clerk");
  assert.strictEqual((result as any).actionName, "record_payment");
  assert.strictEqual(aiCalls, 1);
});

test("routing: Cowork resolves the named Payments Clerk's one Action structurally, with no AI call at all", async (t) => {
  const { resolveUnitRequest } = await import("../dispatch");
  mockNotion(t, []);
  let aiCalls = 0;
  const env = { ...fakeEnv(), AI: { run: async () => (aiCalls++, { response: "{}" }) } as any, AI_MODEL_LIGHT: "l", AI_MODEL_PRIMARY: "p" } as Env;
  const result = await resolveUnitRequest(env, financeManifest, { chatId: -100, threadId: 604 } as any, MARTIN, "Payments Clerk");
  assert.strictEqual((result as any).actionName, "record_payment");
  assert.strictEqual(aiCalls, 0);
});
