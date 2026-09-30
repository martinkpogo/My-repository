import type { Env } from "./types";
import { queryDataSource, plainText, uniqueId } from "./notion";
import { generate } from "./ai";
import type { ChatTurn } from "./ai";
import { userLookupContext } from "./access";

/**
 * A read-only "what's in this database" capability across every data
 * source Runtime is legitimately authorized to read directly, per the
 * identity architecture decision recorded in Notion (Sept 2026): Entity and
 * Matters no longer carry any real-world identity fields at all, Handoffs
 * and Proposals are identity-safe by construction (enforced at write time
 * by handoffWriter.ts/tokenSafeProposal.ts), and the Activity & Decision
 * Log is Runtime's own operational record.
 *
 * Two layers: runDataLookup is the deterministic core -- no AI, every line
 * built directly from the live Notion record's own fields, never
 * paraphrased or summarized by a model. runConversationalDataLookup then
 * hands that same deterministically-fetched snapshot to an AI chat turn as
 * grounding, so Martin can actually discuss the data (ask follow-ups,
 * request a synthesis) rather than only ever receive a static dump -- see
 * its own doc comment for the never-invent-beyond-the-snapshot discipline
 * that keeps that conversation honest.
 *
 * Leads is the one source worth naming explicitly: it legitimately carries
 * real prospect Contact/Organisation details (a pre-qualification
 * acquisition record, discovered from public sources, per the Lead
 * Generation Specialist's own responsibility) -- included here because
 * that's genuinely public-sourced business information, not ENIG's
 * confidential client/contact identity, the same distinction
 * lead.discovery_signal_evaluation's existing policy exemption already
 * draws. That's also why the conversational layer feeding real row content
 * into an AI prompt is still business_sensitive, not client_confidential --
 * see PRODUCTION_TASK_SENSITIVITY's own comment on chat.data_lookup.
 */

export type LookupSource = "matters" | "entities" | "handoffs" | "proposals" | "leads" | "activity";

export const LOOKUP_SOURCES: readonly LookupSource[] = ["matters", "entities", "handoffs", "proposals", "leads", "activity"];

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function lookupMatters(env: Env, filter?: string): Promise<string[]> {
  const pages = await queryDataSource(
    env,
    env.MATTERS_DATA_SOURCE_ID,
    userLookupContext(),
    filter ? { property: "Status", select: { equals: filter } } : undefined,
    { pageSize: 20, sortByCreatedDescending: true },
  );
  return pages.map((p) => {
    const token = uniqueId(p.properties.Matter_ID) || "(no token)";
    const title = plainText(p.properties.Matter) || "(untitled)";
    const status = plainText(p.properties.Status) || "?";
    const need = plainText(p.properties.Stated_need);
    return `• ${token} — ${title} [${status}]${need ? `: ${truncate(need, 140)}` : ""}`;
  });
}

async function lookupEntities(env: Env, filter?: string): Promise<string[]> {
  const pages = await queryDataSource(
    env,
    env.ENTITY_DATA_SOURCE_ID,
    userLookupContext(),
    filter ? { property: "Status", select: { equals: filter } } : undefined,
    { pageSize: 20, sortByCreatedDescending: true },
  );
  return pages.map((p) => {
    const token = uniqueId(p.properties.Entity_ID) || "(no token)";
    const type = plainText(p.properties.Entity_type) || "?";
    const status = plainText(p.properties.Status) || "?";
    const context = plainText(p.properties.Business_context);
    return `• ${token} — ${type} [${status}]${context ? `: ${truncate(context, 140)}` : ""}`;
  });
}

const HANDOFF_STATUSES = ["Pending", "Picked-up", "Held", "Closed"];

async function lookupHandoffs(env: Env, filter?: string): Promise<string[]> {
  let notionFilter: Record<string, unknown> | undefined;
  if (filter) {
    const statusMatch = HANDOFF_STATUSES.find((s) => s.toLowerCase() === filter.toLowerCase());
    notionFilter = statusMatch
      ? { property: "Status", select: { equals: statusMatch } }
      : { property: "To Unit", select: { equals: filter } };
  }
  const pages = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, userLookupContext(),  notionFilter, { pageSize: 20, sortByCreatedDescending: true });
  return pages.map((p) => {
    const token = uniqueId(p.properties["Handoff ID"]) || "(no id)";
    const title = plainText(p.properties.Handoff) || "(untitled)";
    const fromUnit = plainText(p.properties["From Unit"]) || "?";
    const toUnit = plainText(p.properties["To Unit"]) || "?";
    const status = plainText(p.properties.Status) || "?";
    return `• ${token} — ${title} (${fromUnit} → ${toUnit}) [${status}]`;
  });
}

const PROPOSAL_APPROVAL_STATUSES = ["Draft", "Pending Approval", "Approved"];

async function lookupProposals(env: Env, filter?: string): Promise<string[]> {
  let notionFilter: Record<string, unknown> | undefined;
  if (filter) {
    const approvalMatch = PROPOSAL_APPROVAL_STATUSES.find((s) => s.toLowerCase() === filter.toLowerCase());
    notionFilter = approvalMatch
      ? { property: "Approval Status", select: { equals: approvalMatch } }
      : { property: "Status", select: { equals: filter } };
  }
  const pages = await queryDataSource(env, env.PROPOSALS_DATA_SOURCE_ID, userLookupContext(),  notionFilter, { pageSize: 20, sortByCreatedDescending: true });
  return pages.map((p) => {
    const token = uniqueId(p.properties["Proposal ID"]) || "(no id)";
    const entityToken = plainText(p.properties["Entity Token"]) || "?";
    const matterToken = plainText(p.properties["Matter Token"]) || "?";
    const approval = plainText(p.properties["Approval Status"]) || "?";
    const status = plainText(p.properties.Status) || "?";
    const price = p.properties["Quoted Price"]?.number;
    return `• ${token} — ${entityToken}/${matterToken} [${approval} · ${status}]${price !== undefined && price !== null ? ` — ${price}` : ""}`;
  });
}

async function lookupLeads(env: Env, filter?: string): Promise<string[]> {
  const pages = await queryDataSource(
    env,
    env.LEADS_DATA_SOURCE_ID,
    userLookupContext(),
    filter ? { property: "Status", select: { equals: filter } } : undefined,
    { pageSize: 20, sortByCreatedDescending: true },
  );
  return pages.map((p) => {
    const token = uniqueId(p.properties["Lead ID"]) || "(no id)";
    const title = plainText(p.properties.Lead) || "(untitled)";
    const org = plainText(p.properties.Organisation);
    const status = plainText(p.properties.Status) || "?";
    return `• ${token} — ${title}${org ? ` (${org})` : ""} [${status}]`;
  });
}

async function lookupActivity(env: Env, filter?: string): Promise<string[]> {
  const pages = await queryDataSource(
    env,
    env.ACTIVITY_LOG_DATA_SOURCE_ID,
    userLookupContext(),
    filter ? { property: "Area", rich_text: { equals: filter } } : undefined,
    { pageSize: 20, sortByCreatedDescending: true },
  );
  return pages.map((p) => {
    const entry = plainText(p.properties.Entry) || "(no entry)";
    const type = plainText(p.properties.Type) || "?";
    const outcome = plainText(p.properties.Outcome);
    return `• [${type}] ${truncate(entry, 160)}${outcome ? ` (${outcome})` : ""}`;
  });
}

/**
 * Runs a deterministic lookup against one of the fixed, known data
 * sources, optionally narrowed by a single filter value (a Status option,
 * a Unit name for Handoffs, or an Area name for Activity). Never guesses
 * or infers a source/filter -- that interpretation, when done from free
 * text, belongs to the caller (see dataLookupClassifier.ts for the
 * natural-language front end this deterministic core supports).
 */
export async function runDataLookup(env: Env, source: LookupSource, filter?: string): Promise<string> {
  const trimmedFilter = filter?.trim() || undefined;
  let lines: string[];
  switch (source) {
    case "matters":
      lines = await lookupMatters(env, trimmedFilter);
      break;
    case "entities":
      lines = await lookupEntities(env, trimmedFilter);
      break;
    case "handoffs":
      lines = await lookupHandoffs(env, trimmedFilter);
      break;
    case "proposals":
      lines = await lookupProposals(env, trimmedFilter);
      break;
    case "leads":
      lines = await lookupLeads(env, trimmedFilter);
      break;
    case "activity":
      lines = await lookupActivity(env, trimmedFilter);
      break;
  }
  if (lines.length === 0) {
    return `No ${source} records found${trimmedFilter ? ` matching "${trimmedFilter}"` : ""}.`;
  }
  const capNote = lines.length === 20 ? " (showing the most recent 20)" : "";
  return `*${source}${trimmedFilter ? ` — ${trimmedFilter}` : ""}* (${lines.length}${capNote})\n\n${lines.join("\n")}`;
}

export interface DataLookupClassification {
  source: LookupSource;
  filter?: string;
}

function buildDataLookupClassifierPrompt(): string {
  return [
    "Determine whether the message is asking to look up, check, discuss, or see what's in one of ENIG's own Notion databases -- including a casual or conversational phrasing of that, not just an explicit command -- as opposed to ordinary conversation unrelated to any of these databases, a question about something else, or a structured workflow command.",
    `The only databases available for lookup are exactly these six: ${LOOKUP_SOURCES.join(", ")} (activity means the Activity & Decision Log).`,
    'If it is a lookup request, respond {"is_lookup": true, "source": "<one of the six names above, exactly>", "filter": "<a single status/unit/area value the message actually names, or omit this field entirely if none>"}.',
    'If it is not a lookup request, respond {"is_lookup": false}.',
    "Never invent a source outside the six named above. Never invent a filter value the message doesn't actually contain.",
    "Examples:",
    '"Check matter Database and tell me if anything is there" -> {"is_lookup": true, "source": "matters"}',
    '"What\'s in the Leads database right now?" -> {"is_lookup": true, "source": "leads"}',
    '"Any pending handoffs to Finance?" -> {"is_lookup": true, "source": "handoffs", "filter": "Finance"}',
    '"Is MAT-20 still Qualified?" -> {"is_lookup": true, "source": "matters", "filter": "Qualified"}',
    '"How\'s the business doing this week?" -> {"is_lookup": false}',
    '"Draft a proposal for the bakery chain enquiry" -> {"is_lookup": false}',
  ].join("\n");
}

/**
 * Classifies free text as a data-lookup request or not, and if so, which
 * source/filter -- the only classification AI call in this module (see
 * runConversationalDataLookup below for the second, separate AI call this
 * feeds into). Its own input is only Martin's own question plus this fixed
 * schema description, never any fetched row content (see this file's own
 * doc comment on why that keeps this business_sensitive, not
 * client_confidential). Runs on the primary model, not the light/fast one
 * -- confirmed live that the light model missed phrasing as plain as "check
 * matter Database and tell me if anything is there", silently falling
 * through to ordinary chat instead of answering; reliably recognizing the
 * request at all matters more here than the cost/latency light models save
 * elsewhere. Returns null for anything that isn't confidently a lookup
 * request, or that names a source outside the fixed six -- the caller
 * falls through to ordinary chat.
 */
export async function classifyDataLookupRequest(env: Env, userMessage: string): Promise<DataLookupClassification | null> {
  const raw = await generate<{ is_lookup?: boolean; source?: string; filter?: string }>(env, {
    taskId: "chat.data_lookup",
    mode: "json",
    parts: { persona: buildDataLookupClassifierPrompt(), situation: userMessage },
  });
  if (!raw || raw.is_lookup !== true) return null;
  const source = raw.source?.toLowerCase().trim();
  if (!source || !LOOKUP_SOURCES.includes(source as LookupSource)) return null;
  return { source: source as LookupSource, filter: raw.filter?.trim() || undefined };
}

const MAX_LOOKUP_HISTORY_TURNS = 20;

function lookupHistoryKey(chatId: number, threadId: number | undefined, source: LookupSource): string {
  return `lookup_history:${chatId}:${threadId ?? "dm"}:${source}`;
}

async function getLookupHistory(env: Env, chatId: number, threadId: number | undefined, source: LookupSource): Promise<ChatTurn[]> {
  const raw = await env.STATE_KV.get(lookupHistoryKey(chatId, threadId, source));
  return raw ? JSON.parse(raw) : [];
}

async function appendLookupHistory(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  source: LookupSource,
  turns: ChatTurn[],
): Promise<void> {
  const existing = await getLookupHistory(env, chatId, threadId, source);
  const updated = [...existing, ...turns].slice(-MAX_LOOKUP_HISTORY_TURNS);
  await env.STATE_KV.put(lookupHistoryKey(chatId, threadId, source), JSON.stringify(updated));
}

/**
 * A genuine conversation about one database's current contents -- not a
 * static dump. runDataLookup's deterministic fetch supplies the grounding
 * (the actual live rows, built the same way as always, no AI involved in
 * fetching or formatting them); this then hands that snapshot to an AI
 * chat turn so Martin can ask follow-ups, request a synthesis, or just get
 * a natural answer instead of a raw list, per-source rolling history so
 * "tell me more about MAT-20" on the next message still has the prior
 * turn's context. The grounding rule below is the same discipline
 * chat.ts's EVIDENCE_RULE already applies elsewhere: discuss only what's
 * actually in the snapshot, never invent a record, field, or value beyond
 * it.
 */
export async function runConversationalDataLookup(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  source: LookupSource,
  filter: string | undefined,
  userMessage: string,
): Promise<string> {
  const snapshot = await runDataLookup(env, source, filter);
  const persona = [
    `You are ENIG's data assistant for the ${source} database. Below is the current live snapshot of matching records, fetched directly from Notion just now -- not generated or paraphrased by you.`,
    "",
    snapshot,
    "",
    "Discuss this snapshot naturally and answer follow-up questions about it. Never invent a record, field, value, or count that isn't actually present in the snapshot above or this conversation's own messages -- if asked about something the snapshot doesn't cover, say so plainly and suggest a different filter or a fresh look, rather than guessing. The snapshot reflects only the most recent matching records (capped at 20) as of this moment -- say so if asked whether it's complete or current.",
  ].join("\n");

  const history = await getLookupHistory(env, chatId, threadId, source);
  const reply = await generate(env, { taskId: "chat.data_lookup", mode: "text", parts: { persona, situation: userMessage }, history, maxTokens: 800 });
  await appendLookupHistory(env, chatId, threadId, source, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply || "(no response)" },
  ]);
  return reply || "Couldn't generate a reply -- no AI provider is currently available. Please try again shortly.";
}
