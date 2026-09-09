import type { Env, Unit } from "./types";
import { aiChat } from "./ai";
import type { ChatTurn } from "./ai";
import { plainText, queryDataSource } from "./notion";

const MAX_HISTORY_TURNS = 20;

// Universal Role Contract, evidence rule: consequential claims must be
// attributable to a specific source; unsupported material claims are
// unverified until sourced. Confirmed necessary live: asked "do you
// remember any enquiries," this chat invented three entirely fictional
// ones with plausible specifics instead of saying it couldn't check.
// Below, it's handed a real snapshot of this Unit's recent Activity &
// Decision Log entries as grounding — but that's still only a recent
// slice, not full database access, so the rule against inventing beyond
// what it was actually given still applies.
const EVIDENCE_RULE =
  "Below is a snapshot of this Unit's most recent real Activity & Decision Log entries — use it to answer factual questions about recent activity. It is not the full history and you have no other live connection to Notion or any record system beyond what's listed. Never invent specifics — past enquiries, entities, matters, deals, numbers, dates — that aren't in that snapshot or this conversation's own messages. If asked about something not covered by the snapshot given, say so plainly and point to /sessions or the actual Notion database — never answer with a plausible-sounding invented example.";

// Confirmed necessary live, second occurrence: given a message that reads
// like an instruction to run/test the workflow ("post that, run it
// through, check X, paste back what you see"), this chat narrated an
// entire fake execution trace — fabricated Activity/Decision log entries
// in the real snapshot's exact format, fake IDs, and a false "yes it
// worked" confirmation — instead of saying it can't do that. You are this
// Unit's chat persona ONLY: you cannot send Telegram messages to any
// topic, create or update Notion pages, advance a Handoff, or otherwise
// execute any part of the workflow — only the real system code does that,
// triggered by an actual plain enquiry message, never by you. If a
// message asks you to run, post, submit, check, or report back on a
// process, say plainly that you can't perform actions and that a real
// enquiry (just the enquiry itself, no extra instructions) needs to be
// sent as its own message for the real workflow to pick it up. Never
// narrate performing an action, and never claim an outcome (created,
// sent, held, landed, succeeded) that isn't drawn from the snapshot or
// this conversation's real messages.
const NO_ACTIONS_RULE =
  "You are a chat persona only — you have no ability to send messages to other topics, create or update Notion records, advance a Handoff, or run any part of the enquiry workflow yourself. Only the real system, triggered by an actual enquiry message, does that. If asked to run, post, submit, test, check, or report back on a process, say plainly you can't perform actions — never narrate doing so, and never claim an action succeeded, landed, or completed unless it's drawn from the real snapshot or this conversation's own messages.";

async function recentActivitySnapshot(env: Env, unit: Unit): Promise<string> {
  try {
    const entries = await queryDataSource(
      env,
      env.ACTIVITY_LOG_DATA_SOURCE_ID,
      { property: "Area", rich_text: { equals: unit } },
      { pageSize: 15, sortByCreatedDescending: true },
    );
    if (entries.length === 0) return "(no Activity & Decision Log entries found for this Unit yet)";
    return entries
      .map((e) => {
        const entry = plainText(e.properties.Entry);
        const type = plainText(e.properties.Type);
        const activity = plainText(e.properties["Activity / Event"]);
        const decisions = plainText(e.properties.Decisions);
        return `- [${type}] ${entry}${activity ? ` — ${activity}` : ""}${decisions ? ` (decision: ${decisions})` : ""}`;
      })
      .join("\n");
  } catch (err) {
    console.error("Failed to fetch Activity & Decision Log snapshot", err);
    return "(couldn't reach the Activity & Decision Log right now)";
  }
}

const UNIT_PERSONAS: Record<Unit, string> = {
  "SM&BD":
    "You are ENIG's Sales, Marketing & Business Development staff AI, operating under Martin's authority at ENIG, a diagnose-first positioning/communications consultancy. Outside of the structured enquiry workflow, chat naturally and helpfully about sales, marketing, business development, leads, and client relationships. You are staff, not the final authority — never claim a business decision (pricing, commitments, client fit) has been made; that's Martin's call to make.",
  Finance:
    "You are ENIG's Finance staff AI (Financial Planning & Control). Outside of the structured Handoff-driven value-based pricing workflow, chat naturally about financial questions, budgeting, and planning. You are staff, not the final authority — never claim a financial decision has been made; that's Martin's call. New pricing work only ever comes through a Handoff from SM&BD, never directly from chat.",
  Strategy:
    "You are ENIG's Strategy staff AI. This Unit's structured Hats aren't built yet in this system, but you can still discuss strategy, positioning, and business direction questions naturally and helpfully. You are staff, not the final authority — Martin decides.",
  "Research & Intelligence":
    "You are ENIG's Research & Intelligence staff AI. This Unit's structured Hats aren't built yet in this system, but you can still help with research questions, market and competitor intelligence, and analysis naturally. You are staff, not the final authority — Martin decides.",
  "Creative & Design":
    "You are ENIG's Creative & Design staff AI. This Unit's structured Hats aren't built yet in this system, but you can still discuss creative direction, design questions, and brand ideas naturally. You are staff, not the final authority — Martin decides.",
  Operations:
    "You are ENIG's Operations staff AI. This Unit's structured Hats aren't built yet in this system, but you can still discuss operational questions, process, and delivery logistics naturally. You are staff, not the final authority — Martin decides.",
};

function historyKey(chatId: number, threadId?: number): string {
  return `chat_history:${chatId}:${threadId ?? "dm"}`;
}

export async function getChatHistory(env: Env, chatId: number, threadId?: number): Promise<ChatTurn[]> {
  const raw = await env.STATE_KV.get(historyKey(chatId, threadId));
  return raw ? JSON.parse(raw) : [];
}

async function appendChatHistory(env: Env, chatId: number, threadId: number | undefined, turns: ChatTurn[]): Promise<void> {
  const existing = await getChatHistory(env, chatId, threadId);
  const updated = [...existing, ...turns].slice(-MAX_HISTORY_TURNS);
  await env.STATE_KV.put(historyKey(chatId, threadId), JSON.stringify(updated));
}

/**
 * Free-form conversation for a Unit's topic, with rolling memory — used
 * whenever a message isn't a structured work-item reply or a new SM&BD
 * enquiry. Not logged to the Activity & Decision Log: casual discussion
 * isn't a material action the way a workflow step is.
 */
export async function generalChatReply(
  env: Env,
  unit: Unit,
  chatId: number,
  threadId: number | undefined,
  userMessage: string,
): Promise<string> {
  const history = await getChatHistory(env, chatId, threadId);
  const snapshot = await recentActivitySnapshot(env, unit);
  const system = `${UNIT_PERSONAS[unit]}\n\n${EVIDENCE_RULE}\n\n${NO_ACTIONS_RULE}\n\nRecent Activity & Decision Log entries for ${unit}:\n${snapshot}`;
  const reply = await aiChat(env, system, history, userMessage);
  await appendChatHistory(env, chatId, threadId, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply || "(no response)" },
  ]);
  return reply;
}
