import type { Env, SessionSummary } from "./types";
import { queryDataSource, plainText, uniqueId, type NotionPage } from "./notion";
import { userLookupContext } from "./access";
import { humanizeStage, loadSessionsIndexForRead } from "./sessionsIndex";

/**
 * A compact, read-only picture of where the business stands, handed to the
 * conversational chat reply as grounding so Martin can ask "where are we /
 * what needs me?" in plain words instead of running one lookup per
 * database.
 *
 * Built deterministically -- no AI fetches or formats anything here -- and
 * deliberately token-safe: it carries only canonical record tokens
 * (MAT-n, HND-n, ...), Unit/Hat names, statuses and counts. It never
 * carries a Matter title, stated need, Handoff title, Lead name or
 * Organisation, so it puts strictly less record content into a prompt than
 * the existing chat.data_lookup path already does. Reads go through the
 * same `user_lookup` Access context that path uses (read-only by
 * construction), plus the already-sanitized sessions index the /sessions
 * command reads. Money comes from the Payments database (token-only by its
 * spec): amounts, currencies, dates and Matter tokens, never names.
 *
 * Every section fails soft on its own: one unreadable source is named as
 * unreadable, never guessed at, and never takes the chat reply down.
 */

const SAMPLE_SIZE = 50;
const LATEST_SHOWN = 5;

type SectionResult<T> = { ok: true; value: T } | { ok: false };

export interface StatusSection {
  /** Records sampled (the most recent up to SAMPLE_SIZE). */
  sampled: number;
  /** Count per status label, in first-seen order. */
  byStatus: Array<[string, number]>;
  /** Most recent records as token-safe one-liners. */
  latest: string[];
}

export interface MoneySection {
  /** Rows sampled (the most recent up to MONEY_SAMPLE_SIZE). */
  sampled: number;
  /** Per currency: received this calendar month (UTC), and withholding tax deducted on those payments. */
  paidThisMonth: Array<{ currency: string; amount: number; wht: number }>;
  /** Per currency: every Due payment, overdue included. */
  owed: Array<{ currency: string; amount: number; count: number }>;
  /** Due payments whose Due_Date is before today, oldest first (token-safe lines). */
  overdue: string[];
  /** Deposits still Due, not overdue (token-safe lines). */
  depositsDue: string[];
}

export interface BusinessSnapshotData {
  pendingApprovals: SectionResult<SessionSummary[]>;
  matters: SectionResult<StatusSection>;
  proposals: SectionResult<StatusSection>;
  openHandoffs: SectionResult<string[]>;
  leads: SectionResult<StatusSection>;
  /** Undefined when this environment has no Payments source configured. */
  money?: SectionResult<MoneySection>;
}

const MONEY_SAMPLE_SIZE = 100;

function addTo(map: Map<string, { amount: number; wht: number; count: number }>, currency: string, amount: number, wht = 0): void {
  const cur = map.get(currency) ?? { amount: 0, wht: 0, count: 0 };
  cur.amount += amount;
  cur.wht += wht;
  cur.count += 1;
  map.set(currency, cur);
}

/**
 * Money from the Payments database (Payment Business Object). Overdue is
 * DERIVED here -- Status Due and Due_Date before today -- never read from a
 * stored field, per the spec. Rows missing an amount or currency are skipped
 * rather than guessed. Dates compare as ISO YYYY-MM-DD strings in UTC
 * (Accra is UTC+0).
 */
export function summarizeMoney(pages: NotionPage[], now: Date): MoneySection {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const paid = new Map<string, { amount: number; wht: number; count: number }>();
  const owed = new Map<string, { amount: number; wht: number; count: number }>();
  const overdue: Array<{ due: string; line: string }> = [];
  const depositsDue: Array<{ due: string; line: string }> = [];
  for (const p of pages) {
    const amount = p.properties.Amount?.number;
    const currency = plainText(p.properties.Currency);
    if (typeof amount !== "number" || !currency) continue;
    const status = plainText(p.properties.Status);
    const type = plainText(p.properties.Type) || "Payment";
    const matter = plainText(p.properties.Matter_Token) || "(no matter token)";
    const due = p.properties.Due_Date?.date?.start?.slice(0, 10) ?? "";
    const paidOn = p.properties.Paid_Date?.date?.start?.slice(0, 10) ?? "";
    const wht = p.properties.WHT_Deducted?.number;
    const line = `${matter} ${type} ${currency} ${amount.toLocaleString("en-US")}${due ? ` due ${due}` : ""}`;
    if (status === "Paid" && paidOn.slice(0, 7) === month) addTo(paid, currency, amount, typeof wht === "number" ? wht : 0);
    if (status === "Due") {
      addTo(owed, currency, amount);
      if (due && due < today) overdue.push({ due, line });
      else if (type === "Deposit") depositsDue.push({ due: due || "9999", line });
    }
  }
  const byDue = (a: { due: string }, b: { due: string }) => a.due.localeCompare(b.due);
  return {
    sampled: pages.length,
    paidThisMonth: [...paid.entries()].map(([currency, v]) => ({ currency, amount: v.amount, wht: v.wht })),
    owed: [...owed.entries()].map(([currency, v]) => ({ currency, amount: v.amount, count: v.count })),
    overdue: overdue.sort(byDue).map((o) => o.line),
    depositsDue: depositsDue.sort(byDue).map((o) => o.line),
  };
}

function countByStatus(statuses: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()];
}

function statusSection(pages: NotionPage[], status: (p: NotionPage) => string, line: (p: NotionPage) => string | null): StatusSection {
  return {
    sampled: pages.length,
    byStatus: countByStatus(pages.map((p) => status(p) || "?")),
    latest: pages
      .map(line)
      .filter((l): l is string => l !== null)
      .slice(0, LATEST_SHOWN),
  };
}

async function attempt<T>(label: string, run: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    console.error(`businessSnapshot: ${label} unreadable -- reported as unreadable, not guessed`, err);
    return { ok: false };
  }
}

function query(env: Env, dataSourceId: string): Promise<NotionPage[]> {
  return queryDataSource(env, dataSourceId, userLookupContext(), undefined, { pageSize: SAMPLE_SIZE, sortByCreatedDescending: true });
}

export async function loadBusinessSnapshot(env: Env, now: Date = new Date()): Promise<BusinessSnapshotData> {
  const paymentsId = env.PAYMENTS_DATA_SOURCE_ID;
  const moneyPromise: Promise<SectionResult<MoneySection> | undefined> = paymentsId
    ? attempt("Payments", async () =>
        summarizeMoney(
          await queryDataSource(env, paymentsId, userLookupContext(), undefined, { pageSize: MONEY_SAMPLE_SIZE, sortByCreatedDescending: true }),
          now,
        ),
      )
    : Promise.resolve(undefined);
  const [pendingApprovals, matters, proposals, openHandoffs, leads, money] = await Promise.all([
    attempt("sessions index", async () => (await loadSessionsIndexForRead(env)).filter((s) => s.hasPendingApproval)),
    attempt("Matters", async () =>
      statusSection(
        await query(env, env.MATTERS_DATA_SOURCE_ID),
        (p) => plainText(p.properties.Status),
        (p) => {
          const token = uniqueId(p.properties.Matter_ID);
          return token ? `${token} [${plainText(p.properties.Status) || "?"}]` : null;
        },
      ),
    ),
    attempt("Proposals", async () =>
      statusSection(
        await query(env, env.PROPOSALS_DATA_SOURCE_ID),
        (p) => `${plainText(p.properties["Approval Status"]) || "?"} · ${plainText(p.properties.Status) || "?"}`,
        (p) => {
          const token = uniqueId(p.properties["Proposal ID"]);
          if (!token) return null;
          const matter = plainText(p.properties["Matter Token"]);
          return `${token}${matter ? ` for ${matter}` : ""} [${plainText(p.properties["Approval Status"]) || "?"} · ${plainText(p.properties.Status) || "?"}]`;
        },
      ),
    ),
    attempt("Handoffs", async () =>
      (await query(env, env.HANDOFFS_DATA_SOURCE_ID))
        .filter((p) => plainText(p.properties.Status) !== "Closed")
        .map((p) => {
          const token = uniqueId(p.properties["Handoff ID"]) || "(no id)";
          return `${token} ${plainText(p.properties["From Unit"]) || "?"} → ${plainText(p.properties["To Unit"]) || "?"} [${plainText(p.properties.Status) || "?"}]`;
        }),
    ),
    // Leads: counts only. A Lead legitimately carries a public-sourced
    // prospect name/Organisation; none of it is needed to say how many are
    // waiting, so none of it enters the chat prompt.
    attempt("Leads", async () =>
      statusSection(
        await query(env, env.LEADS_DATA_SOURCE_ID),
        (p) => plainText(p.properties.Status),
        () => null,
      ),
    ),
    moneyPromise,
  ]);
  return { pendingApprovals, matters, proposals, openHandoffs, leads, ...(money ? { money } : {}) };
}

function formatCounts(section: StatusSection, noun: string): string {
  if (section.sampled === 0) return `none recorded`;
  const counts = section.byStatus.map(([status, n]) => `${status}: ${n}`).join(", ");
  const scope = section.sampled === SAMPLE_SIZE ? ` (of the ${SAMPLE_SIZE} most recent ${noun})` : ` (${section.sampled} total)`;
  return `${counts}${scope}`;
}

const UNREADABLE = "(couldn't read this right now -- say so if asked; do not guess)";

export function formatBusinessSnapshot(data: BusinessSnapshotData): string {
  const lines: string[] = ["=== LIVE BUSINESS SNAPSHOT (read just now; record tokens, statuses and counts only) ==="];

  lines.push("Waiting on Martin's approval:");
  if (!data.pendingApprovals.ok) lines.push(`  ${UNREADABLE}`);
  else if (data.pendingApprovals.value.length === 0) lines.push("  nothing");
  else
    for (const s of data.pendingApprovals.value.slice(0, 10))
      lines.push(`  - ${s.unit ?? "?"}/${s.hat ?? "?"} — ${s.label} (${humanizeStage(s.stage)})`);

  lines.push(`Matters: ${data.matters.ok ? formatCounts(data.matters.value, "matters") : UNREADABLE}`);
  if (data.matters.ok && data.matters.value.latest.length) lines.push(`  latest: ${data.matters.value.latest.join(", ")}`);

  lines.push(`Proposals: ${data.proposals.ok ? formatCounts(data.proposals.value, "proposals") : UNREADABLE}`);
  if (data.proposals.ok && data.proposals.value.latest.length) lines.push(`  latest: ${data.proposals.value.latest.join(", ")}`);

  lines.push("Handoffs not yet closed:");
  if (!data.openHandoffs.ok) lines.push(`  ${UNREADABLE}`);
  else if (data.openHandoffs.value.length === 0) lines.push("  none");
  else for (const h of data.openHandoffs.value.slice(0, 10)) lines.push(`  - ${h}`);

  lines.push(`Leads: ${data.leads.ok ? formatCounts(data.leads.value, "leads") : UNREADABLE}`);

  if (data.money) {
    lines.push("Money (Payments; Matter tokens and amounts only):");
    if (!data.money.ok) lines.push(`  ${UNREADABLE}`);
    else {
      const m = data.money.value;
      const fmt = (n: number) => n.toLocaleString("en-US");
      if (m.sampled === 0) lines.push("  no payments recorded yet");
      else {
        lines.push(
          `  Paid this month: ${m.paidThisMonth.length ? m.paidThisMonth.map((p) => `${p.currency} ${fmt(p.amount)}${p.wht ? ` (withholding tax deducted ${p.currency} ${fmt(p.wht)})` : ""}`).join("; ") : "nothing"}`,
        );
        lines.push(`  Owed (all Due, overdue included): ${m.owed.length ? m.owed.map((o) => `${o.currency} ${fmt(o.amount)} across ${o.count}`).join("; ") : "nothing"}`);
        lines.push(`  Overdue: ${m.overdue.length ? m.overdue.slice(0, 5).join(", ") : "none"}`);
        lines.push(`  Deposits due: ${m.depositsDue.length ? m.depositsDue.slice(0, 5).join(", ") : "none"}`);
        if (m.sampled === MONEY_SAMPLE_SIZE) lines.push(`  (from the ${MONEY_SAMPLE_SIZE} most recent Payments rows)`);
      }
    }
  }
  lines.push("=== END SNAPSHOT ===");
  return lines.join("\n");
}

export async function businessSnapshot(env: Env): Promise<string> {
  return formatBusinessSnapshot(await loadBusinessSnapshot(env));
}
