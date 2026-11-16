import type { Env, WorkState } from "../../types";
import { getPage, plainText, queryDataSource, richText, select, number, uniqueId, updatePage, type NotionPage } from "../../notion";
import { mintApprovalProofForWork, workSessionContext } from "../../access";
import { getGovernance } from "../../governance";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage, type HatMessageTarget } from "../../telegram";
import { financeOf } from "./financeState";
import { PAYMENTS_CLERK_HAT_NAME, PAYMENT_CALLBACK_PREFIX } from "./paymentsClerkNames";

/**
 * Finance's Payments Clerk (2026-11-11): records a payment Martin reports as
 * received by setting the matching Due Payment row to Paid -- only after he
 * approves the exact change on one card.
 *
 * The Payment contract (ENIG HQ / 5. Data / Payment) is the authority: the
 * Runtime may set a Due Payment to Paid only through this Hat's
 * record_payment Action, after Martin approves the exact change. So this
 * module:
 *   - reads Martin's message with fixed rules, never an AI call: what is
 *     written to a Payment is never decided by a model;
 *   - never creates a Payment row and never changes Amount, Currency, Type
 *     or Matter_Token;
 *   - handles Due -> Paid only (Waived, refunds and reversals stay manual);
 *   - stops and says why when the Matter, type, amount, currency or method is
 *     missing or ambiguous, when there is no single Due row, or when the
 *     currency differs; and ASKS (Martin's 2026-11-11 choice) when the amount
 *     reported does not match the row's Amount, gross or net of WHT;
 *   - writes tokens, amounts and dates only.
 * The Hat's canonical definition is read live before anything is staged and
 * the Work fails closed if it is unreadable.
 */

export { PAYMENTS_CLERK_HAT_NAME, PAYMENT_CALLBACK_PREFIX } from "./paymentsClerkNames";
export const PAYMENTS_CLERK_DEFINITION_PAGE_ID = "415cb004-e583-811c-b429-fdaf471e0499";

export type PaymentType = "Deposit" | "Balance";
export type PaymentCurrency = "GHS" | "USD";
export type PaymentMethod = "Mobile money" | "Bank transfer" | "Other";

/** What Martin's message says, read with fixed rules. Missing required parts are listed, never guessed. */
export interface PaymentReport {
  matter?: string;
  type?: PaymentType;
  amount?: number;
  currency?: PaymentCurrency;
  method?: PaymentMethod;
  paidDate?: string;
  paidDateDefaulted?: boolean;
  wht?: number;
  invoice?: string;
  problems: string[];
}

/** The staged change Martin approves. Tokens, amounts and dates only. */
export interface PendingPayment {
  pageId: string;
  paymentId: string;
  matter: string;
  type: PaymentType;
  currency: PaymentCurrency;
  rowAmount: number;
  reportedAmount: number;
  paidDate: string;
  method: PaymentMethod;
  wht?: number;
  invoice?: string;
  amountCheck: "gross" | "net" | "mismatch";
}

const CURRENCY_WORDS: [RegExp, PaymentCurrency][] = [
  [/^(ghs|gh₵|ghc|ghc|cedis?|₵)$/i, "GHS"],
  [/^(usd|us\$|\$|dollars?)$/i, "USD"],
];
const CURRENCY_TOKEN = String.raw`(GHS|GH₵|GHC|₵|cedis?|USD|US\$|\$|dollars?)`;
const AMOUNT_TOKEN = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function toCurrency(word: string): PaymentCurrency | undefined {
  for (const [re, c] of CURRENCY_WORDS) if (re.test(word.trim())) return c;
  return undefined;
}

function toAmount(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function isoDate(y: number, m: number, d: number): string | undefined {
  const date = new Date(Date.UTC(y, m, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

/** Reads the paid date: ISO, "12 Nov [2026]", "Nov 12 [2026]", "today", "yesterday". A date without a year that would be in the future is read as last year's. */
export function parsePaidDate(text: string, today: string): { date?: string; found: boolean; problem?: string } {
  const lower = text.toLowerCase();
  const [ty, tm, td] = today.split("-").map(Number);
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = isoDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return d ? { date: d, found: true } : { found: true, problem: `"${iso[0]}" is not a valid date` };
  }
  if (/\btoday\b/.test(lower)) return { date: today, found: true };
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(Date.UTC(ty, tm - 1, td - 1));
    return { date: d.toISOString().slice(0, 10), found: true };
  }
  const monthAlt = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*`;
  const dm = lower.match(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${monthAlt}\.?(?:,?\s+(\d{4}))?\b`));
  const md = dm ? null : lower.match(new RegExp(String.raw`\b${monthAlt}\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`));
  let day: number | undefined, month: number | undefined, year: number | undefined;
  if (dm) {
    day = Number(dm[1]);
    month = MONTHS.indexOf(dm[2].slice(0, 3));
    year = dm[3] ? Number(dm[3]) : undefined;
  } else if (md) {
    month = MONTHS.indexOf(md[1].slice(0, 3));
    day = Number(md[2]);
    year = md[3] ? Number(md[3]) : undefined;
  } else {
    return { found: false };
  }
  let date = isoDate(year ?? ty, month, day);
  if (!date) return { found: true, problem: "the date paid is not a valid date" };
  if (year === undefined && date > today) date = isoDate(ty - 1, month, day);
  return { date, found: true };
}

/** Reads Martin's payment report with fixed rules. Never calls an AI provider. */
export function parsePaymentReport(text: string, today: string): PaymentReport {
  const report: PaymentReport = { problems: [] };
  let rest = ` ${text} `;

  const matters = [...new Set([...text.matchAll(/\bMAT-(\d+)\b/gi)].map((m) => `MAT-${m[1]}`))];
  if (matters.length === 1) report.matter = matters[0];
  else report.problems.push(matters.length === 0 ? "the Matter token (MAT-n)" : `exactly one Matter (found ${matters.join(", ")})`);

  const types = [...new Set([...text.matchAll(/\b(deposit|balance)\b/gi)].map((m) => m[1].toLowerCase()))];
  if (types.length === 1) report.type = types[0] === "deposit" ? "Deposit" : "Balance";
  else report.problems.push(types.length === 0 ? "whether it is the deposit or the balance" : "only one of deposit or balance");

  // WHT and the invoice reference are taken out first, so their numbers are never read as the amount paid.
  const whtRe = new RegExp(String.raw`\b(?:WHT|withholding(?:\s+tax)?)\b[^\d\n]{0,25}?${AMOUNT_TOKEN}`, "i");
  const wht = rest.match(whtRe);
  if (wht) {
    report.wht = toAmount(wht[1]);
    rest = rest.replace(wht[0], " ");
  }
  const inv = rest.match(/\b(?:invoice|inv)\b(?:\s*(?:no\.?|number|ref(?:erence)?|#|:))*\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)/i) ?? rest.match(/\b(INV-[A-Za-z0-9\-\/]+)/i);
  if (inv && /\d/.test(inv[1])) {
    report.invoice = inv[1].toUpperCase();
    rest = rest.replace(inv[0], " ");
  }

  const before = [...rest.matchAll(new RegExp(String.raw`${CURRENCY_TOKEN}\s?${AMOUNT_TOKEN}`, "gi"))].map((m) => ({ c: toCurrency(m[1]), a: toAmount(m[2]) }));
  const after = [...rest.matchAll(new RegExp(String.raw`${AMOUNT_TOKEN}\s?${CURRENCY_TOKEN}`, "gi"))].map((m) => ({ c: toCurrency(m[2]), a: toAmount(m[1]) }));
  const amounts = [...before, ...after].filter((x) => x.c !== undefined && Number.isFinite(x.a) && x.a > 0);
  const distinct = [...new Map(amounts.map((x) => [`${x.c}:${x.a}`, x])).values()];
  if (distinct.length === 1) {
    report.amount = distinct[0].a;
    report.currency = distinct[0].c;
  } else {
    report.problems.push(distinct.length === 0 ? "the amount with its currency (e.g. GHS 6,000 or USD 500)" : "exactly one amount paid (found several)");
  }

  const lower = text.toLowerCase();
  const methods: PaymentMethod[] = [];
  if (/\bbank\b|\btransfer\b/.test(lower)) methods.push("Bank transfer");
  if (/\bmobile\s+money\b|\bmomo\b/.test(lower)) methods.push("Mobile money");
  if (/\bcash\b|\bcheque\b|\bcheck\b|\bcard\b/.test(lower)) methods.push("Other");
  if (methods.length === 1) report.method = methods[0];
  else report.problems.push(methods.length === 0 ? "how it was paid (bank transfer, mobile money, or other: cash, cheque or card)" : "only one payment method");

  const paid = parsePaidDate(text, today);
  if (paid.problem) report.problems.push(paid.problem);
  else if (paid.date) {
    if (paid.date > today) report.problems.push(`a date paid that is not in the future (read ${paid.date})`);
    else report.paidDate = paid.date;
  } else {
    report.paidDate = today;
    report.paidDateDefaulted = true;
  }
  return report;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function target(state: WorkState): HatMessageTarget {
  return { chatId: state.chatId, threadId: state.threadId, hat: PAYMENTS_CLERK_HAT_NAME, workId: state.workId };
}

function dateStart(prop: any): string {
  return prop?.date?.start ? String(prop.date.start).slice(0, 10) : "";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function stop(env: Env, state: WorkState, message: string): Promise<WorkState> {
  state.stage = "cancelled";
  await sendWorkspaceHatMessage(env, target(state), message);
  return state;
}

const EXAMPLE = "Finance, MAT-32 deposit paid, GHS 6,000, bank transfer, 12 Nov, WHT 300, invoice INV-014";

/**
 * record_payment's entry: read the report, find the one Due row, and stage
 * the exact change on one approval card. Writes nothing.
 */
export async function handleRecordPaymentRequest(env: Env, state: WorkState, text: string, today: string = todayUtc()): Promise<WorkState> {
  const definition = await getGovernance(env, PAYMENTS_CLERK_DEFINITION_PAGE_ID, "Finance — Payments Clerk");
  if (!definition) {
    return stop(env, state, "I couldn't read the Payments Clerk's definition in Notion (Finance — Payments Clerk), so nothing was recorded. Try again shortly.");
  }
  const paymentsId = env.PAYMENTS_DATA_SOURCE_ID;
  if (!paymentsId) {
    return stop(env, state, "No Payments database is configured for this environment, so nothing was recorded.");
  }

  const report = parsePaymentReport(text, today);
  if (report.problems.length > 0) {
    return stop(env, state, `I need ${report.problems.join("; ")} before I can record this. Nothing was recorded.\n\nSend it again in one message, for example:\n${EXAMPLE}`);
  }
  const { matter, type, amount, currency, method, paidDate } = report as Required<Pick<PaymentReport, "matter" | "type" | "amount" | "currency" | "method" | "paidDate">>;

  const rows = await queryDataSource(env, paymentsId, workSessionContext(state), {
    and: [
      { property: "Matter_Token", rich_text: { equals: matter } },
      { property: "Type", select: { equals: type } },
    ],
  });
  const due = rows.filter((p) => plainText(p.properties?.Status) === "Due");
  if (due.length === 0) {
    const paid = rows.find((p) => plainText(p.properties?.Status) === "Paid");
    return stop(
      env,
      state,
      paid
        ? `${matter}'s ${type.toLowerCase()} (${uniqueId(paid.properties?.Payment_ID) || "Payment row"}) is already recorded as Paid${dateStart(paid.properties?.Paid_Date) ? ` on ${dateStart(paid.properties?.Paid_Date)}` : ""}. Nothing was changed.`
        : `There is no Due ${type.toLowerCase()} row for ${matter} in Payments. Rows are created when the agreement is signed (Isolated Sales), so check the Matter token or record the signing first. Nothing was recorded.`,
    );
  }
  if (due.length > 1) {
    return stop(env, state, `${matter} has ${due.length} Due ${type.toLowerCase()} rows (${due.map((p) => uniqueId(p.properties?.Payment_ID) || p.id).join(", ")}), so I can't tell which one this is. Fix the duplicates in Payments, then send it again. Nothing was recorded.`);
  }
  const row = due[0];
  const rowCurrency = plainText(row.properties?.Currency) as PaymentCurrency;
  const rowAmount = Number(row.properties?.Amount?.number);
  const paymentId = uniqueId(row.properties?.Payment_ID) || "Payment row";
  if (rowCurrency !== currency) {
    return stop(env, state, `${paymentId} is in ${rowCurrency || "no currency"}, but you reported ${currency}. A Payment's currency never changes here, so nothing was recorded.`);
  }
  if (!Number.isFinite(rowAmount)) {
    return stop(env, state, `${paymentId} has no Amount, so I can't check what was paid against it. Fill in its Amount in Payments, then send it again. Nothing was recorded.`);
  }

  const amountCheck: PendingPayment["amountCheck"] = same(amount, rowAmount) ? "gross" : report.wht !== undefined && same(amount + report.wht, rowAmount) ? "net" : "mismatch";
  const pending: PendingPayment = {
    pageId: row.id,
    paymentId,
    matter,
    type,
    currency,
    rowAmount,
    reportedAmount: amount,
    paidDate,
    method,
    ...(report.wht !== undefined ? { wht: report.wht } : {}),
    ...(report.invoice ? { invoice: report.invoice } : {}),
    amountCheck,
  };

  const current = (name: string) => plainText(row.properties?.[name]) || "—";
  const changes = [
    `• Status: Due → Paid`,
    `• Paid date: ${dateStart(row.properties?.Paid_Date) || "—"} → ${paidDate}${report.paidDateDefaulted ? " (today; no date was given)" : ""}`,
    `• Method: ${current("Method")} → ${method}`,
    ...(pending.wht !== undefined ? [`• WHT deducted: ${current("WHT_Deducted")} → ${fmt(pending.wht)}`] : []),
    ...(pending.invoice ? [`• Invoice number: ${current("Invoice_Number")} → ${pending.invoice}`] : []),
  ];
  const whtNote = pending.wht !== undefined ? ` + WHT ${fmt(pending.wht)}` : "";
  const check =
    amountCheck === "gross"
      ? `Amount check: ✅ ${currency} ${fmt(amount)} matches the row's Amount.`
      : amountCheck === "net"
        ? `Amount check: ✅ ${currency} ${fmt(amount)} received${whtNote} = ${currency} ${fmt(rowAmount)}, the row's Amount.`
        : `Amount check: ⚠️ you reported ${currency} ${fmt(amount)}${whtNote}, but the row's Amount is ${currency} ${fmt(rowAmount)}${pending.wht === undefined ? ` (a gap of ${currency} ${fmt(Math.abs(rowAmount - amount))})` : ""}. The row's Amount will not change. Record it as Paid anyway?`;

  const message = [
    `*Record payment — ${matter} ${type.toLowerCase()}* (${paymentId})`,
    `Row now: Due · ${currency} ${fmt(rowAmount)}${dateStart(row.properties?.Due_Date) ? ` · due ${dateStart(row.properties?.Due_Date)}` : ""}`,
    "",
    "Change:",
    ...changes,
    "",
    check,
    "",
    "Nothing is written until you tap Record.",
  ].join("\n");
  const buttons = [
    [
      { text: amountCheck === "mismatch" ? "✅ Record anyway" : "✅ Record", callback_data: `${PAYMENT_CALLBACK_PREFIX}:${state.workId}:approve` },
      { text: "❌ Cancel", callback_data: `${PAYMENT_CALLBACK_PREFIX}:${state.workId}:reject` },
    ],
  ];

  financeOf(state).pendingPayment = pending;
  state.stage = "awaiting_payment_approval";
  state.pendingActionSummary = { label: `Payment: ${matter} ${type.toLowerCase()}`, message, buttons, createdAt: new Date().toISOString() };
  await sendWorkspaceHatMessage(env, target(state), message, buttons);
  return state;
}

/** Verifies the row still holds what Martin was shown (it may have changed since the card was sent). Returns the reason it no longer matches, or null. */
function stillMatches(page: NotionPage, pending: PendingPayment): string | null {
  const p = page.properties ?? {};
  if (plainText(p.Status) !== "Due") return `its Status is now ${plainText(p.Status) || "empty"}, not Due`;
  if (plainText(p.Matter_Token) !== pending.matter) return "its Matter token has changed";
  if (plainText(p.Type) !== pending.type) return "its Type has changed";
  if (plainText(p.Currency) !== pending.currency) return "its Currency has changed";
  if (!same(Number(p.Amount?.number), pending.rowAmount)) return "its Amount has changed";
  return null;
}

/** What the read-back must show after the write. Returns the fields that differ. */
function readBackDifferences(page: NotionPage, pending: PendingPayment): string[] {
  const p = page.properties ?? {};
  const diffs: string[] = [];
  if (plainText(p.Status) !== "Paid") diffs.push("Status");
  if (dateStart(p.Paid_Date) !== pending.paidDate) diffs.push("Paid date");
  if (plainText(p.Method) !== pending.method) diffs.push("Method");
  if (pending.wht !== undefined && !same(Number(p.WHT_Deducted?.number), pending.wht)) diffs.push("WHT deducted");
  if (pending.invoice && plainText(p.Invoice_Number) !== pending.invoice) diffs.push("Invoice number");
  if (!same(Number(p.Amount?.number), pending.rowAmount)) diffs.push("Amount");
  return diffs;
}

/**
 * Martin's Record / Cancel on the card -- the only code path that changes a
 * Payment. The staged change is consumed first, so a second tap is a no-op.
 */
export async function handlePaymentApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.finance?.pendingPayment;
  const stagedSummary = state.pendingActionSummary;
  financeOf(state).pendingPayment = undefined;
  state.pendingActionSummary = undefined;

  if (!pending) {
    await sendWorkspaceHatMessage(env, target(state), "There's no pending payment on this card any more. Nothing was changed.");
    return state;
  }
  const label = `${pending.matter} ${pending.type.toLowerCase()} (${pending.paymentId})`;

  if (!approved) {
    state.stage = "cancelled";
    await logActivity(env, {
      entry: `Payment not recorded: ${label}`,
      type: "Activity",
      area: "Finance",
      activity: "Martin cancelled the Payments Clerk's card. The Payment row was not changed.",
      outcome: "Complete",
      workId: state.workId,
    });
    await sendWorkspaceHatMessage(env, target(state), `Cancelled. ${label} is unchanged.`);
    return state;
  }

  const paymentsId = env.PAYMENTS_DATA_SOURCE_ID ?? "";
  const restage = () => {
    financeOf(state).pendingPayment = pending;
    state.pendingActionSummary = stagedSummary;
  };

  let before: NotionPage;
  try {
    before = await getPage(env, pending.pageId, workSessionContext(state));
  } catch (err) {
    console.error(`Payments Clerk: could not re-read ${pending.pageId} before writing`, err);
    restage();
    await sendWorkspaceHatMessage(env, target(state), `⚠️ I couldn't re-read ${label} before writing, so nothing was changed. Tap Record on the card again to retry.`);
    return state;
  }
  const changed = stillMatches(before, pending);
  if (changed) {
    state.stage = "cancelled";
    await sendWorkspaceHatMessage(env, target(state), `Not recorded: ${label} changed after the card was sent (${changed}). Nothing was written. Send the payment again to see the current row.`);
    return state;
  }

  const properties: Record<string, any> = {
    Status: select("Paid"),
    Paid_Date: { date: { start: pending.paidDate } },
    Method: select(pending.method),
    ...(pending.wht !== undefined ? { WHT_Deducted: number(pending.wht) } : {}),
    ...(pending.invoice ? { Invoice_Number: richText(pending.invoice) } : {}),
  };
  try {
    // Martin's approval of THIS card, bound to this Work, its recorded
    // record_payment Action and the Payments data source. Access verifies
    // all three before the update.
    const proof = mintApprovalProofForWork(state, paymentsId);
    await updatePage(env, pending.pageId, properties, workSessionContext(state, proof));
  } catch (err) {
    console.error(`Payments Clerk: write failed for ${pending.pageId}`, err);
    restage();
    await logActivity(env, {
      entry: `Payment not recorded -- write failed: ${label}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: `Notion update of the Payment row failed: ${err instanceof Error ? err.message : String(err)}`,
      outcome: "Blocked",
      workId: state.workId,
    });
    await sendWorkspaceHatMessage(env, target(state), `⚠️ The write to ${label} failed, so it is not recorded. Check the row in Payments before retrying; if it is still Due, tap Record on the card again.`);
    return state;
  }

  let after: NotionPage | undefined;
  try {
    after = await getPage(env, pending.pageId, workSessionContext(state));
  } catch (err) {
    console.error(`Payments Clerk: read-back failed for ${pending.pageId}`, err);
  }
  const diffs = after ? readBackDifferences(after, pending) : ["the whole row (it could not be read back)"];
  state.stage = diffs.length === 0 ? "complete" : "cancelled";

  const whtText = pending.wht !== undefined ? `, WHT ${pending.currency} ${fmt(pending.wht)}` : "";
  const detail = `${pending.paymentId}: Due → Paid on ${pending.paidDate}, ${pending.method}, ${pending.currency} ${fmt(pending.reportedAmount)} reported against an Amount of ${pending.currency} ${fmt(pending.rowAmount)}${whtText}${pending.invoice ? `, invoice ${pending.invoice}` : ""}. Amount check: ${pending.amountCheck}.`;
  if (diffs.length > 0) {
    await logActivity(env, {
      entry: `Payment write needs checking: ${label}`,
      type: "Blocker",
      area: "Finance",
      activity: `Approved by Martin. ${detail}`,
      decisionRationale: `Read-back after the write did not match: ${diffs.join(", ")}.`,
      nextActions: "Martin checks the Payment row in Notion. Do not repeat the write.",
      outcome: "Blocked",
      workId: state.workId,
    });
    await sendWorkspaceHatMessage(env, target(state), `⚠️ I wrote ${label}, but reading it back did not match on: ${diffs.join(", ")}. Please check the row in Payments. I won't write it again.`);
    return state;
  }

  await logActivity(env, {
    entry: `Payment recorded: ${label}`,
    type: "Activity",
    area: "Finance",
    activity: `Approved by Martin in Telegram. ${detail}`,
    outcome: "Complete",
    workId: state.workId,
  });
  const next = pending.type === "Deposit" ? `\n\nWork on ${pending.matter} can start once its agreement is Signed (check Agreements).` : "";
  await sendWorkspaceHatMessage(env, target(state), `✅ ${label} recorded as Paid on ${pending.paidDate}.${next}`);
  return state;
}
