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
 * command reads.
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

export interface BusinessSnapshotData {
  pendingApprovals: SectionResult<SessionSummary[]>;
  matters: SectionResult<StatusSection>;
  proposals: SectionResult<StatusSection>;
  openHandoffs: SectionResult<string[]>;
  leads: SectionResult<StatusSection>;
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

export async function loadBusinessSnapshot(env: Env): Promise<BusinessSnapshotData> {
  const [pendingApprovals, matters, proposals, openHandoffs, leads] = await Promise.all([
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
  ]);
  return { pendingApprovals, matters, proposals, openHandoffs, leads };
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
  lines.push("=== END SNAPSHOT ===");
  return lines.join("\n");
}

export async function businessSnapshot(env: Env): Promise<string> {
  return formatBusinessSnapshot(await loadBusinessSnapshot(env));
}
