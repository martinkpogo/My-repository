import type { Env, Unit } from "./types";
import { aiChat } from "./ai";
import type { ChatTurn } from "./ai";

const MAX_HISTORY_TURNS = 20;

// Universal Role Contract, evidence rule: consequential claims must be
// attributable to a specific source; unsupported material claims are
// unverified until sourced. This chat has no live connection to Notion or
// any other record — it must never fabricate specifics about real
// business records (entities, matters, enquiries, deals, numbers, dates)
// to sound helpful. Confirmed necessary live: asked "do you remember any
// enquiries," it invented three entirely fictional ones with plausible
// specifics instead of saying it couldn't check.
const EVIDENCE_RULE =
  "You have no live connection to Notion, the Handoffs/Entity/Matters databases, or any other record system — only this conversation's own recent messages. Never invent specifics about real business records: past enquiries, entities, matters, deals, numbers, dates, or anything you'd need an actual database to know. If asked about real records or history you have no access to, say so plainly and point to /sessions (open work items) or the actual Notion database — never answer with a plausible-sounding invented example.";

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
  const system = `${UNIT_PERSONAS[unit]}\n\n${EVIDENCE_RULE}`;
  const reply = await aiChat(env, system, history, userMessage);
  await appendChatHistory(env, chatId, threadId, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply || "(no response)" },
  ]);
  return reply;
}
