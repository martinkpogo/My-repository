import type { Env, Unit } from "./types";
import { aiJson } from "./ai";
import { sendMessage } from "./telegram";
import { generalChatReply } from "./chat";

export function newWorkId(): string {
  return crypto.randomUUID();
}

export async function getActiveWorkId(env: Env, chatId: number, threadId?: number): Promise<string | null> {
  return env.STATE_KV.get(`active:${chatId}:${threadId ?? "dm"}`);
}

export async function setActiveWorkId(env: Env, chatId: number, threadId: number | undefined, workId: string): Promise<void> {
  await env.STATE_KV.put(`active:${chatId}:${threadId ?? "dm"}`, workId);
}

export function getSessionStub(env: Env, workId: string) {
  const id = env.WORK_SESSION.idFromName(workId);
  return env.WORK_SESSION.get(id) as any;
}

/**
 * Resolves a Telegram forum topic's message_thread_id to the Unit it
 * represents, per UNIT_TOPIC_MAP. "dm" means no topic context at all (plain
 * 1:1 chat, or UNIT_TOPIC_MAP unset) — treated as the legacy default,
 * routable like the SM&BD topic. "unmapped" means a real thread id was
 * given but doesn't match any configured Unit.
 */
export function resolveUnitForThread(env: Env, threadId?: number): Unit | "unmapped" | "dm" {
  if (threadId === undefined || !env.UNIT_TOPIC_MAP) return "dm";
  let map: Record<string, number>;
  try {
    map = JSON.parse(env.UNIT_TOPIC_MAP);
  } catch {
    return "unmapped";
  }
  const entry = Object.entries(map).find(([, id]) => id === threadId);
  return entry ? (entry[0] as Unit) : "unmapped";
}

/** Reverse of resolveUnitForThread: the topic thread id configured for a Unit, if any. */
export function threadIdForUnit(env: Env, unit: Unit): number | undefined {
  if (!env.UNIT_TOPIC_MAP) return undefined;
  try {
    const map: Record<string, number> = JSON.parse(env.UNIT_TOPIC_MAP);
    return map[unit];
  } catch {
    return undefined;
  }
}

interface RoutingClassification {
  route: "enquiry" | "out_of_scope" | "ambiguous";
  reason?: string;
}

/**
 * Universal Role Contract, hat_selection.chat_driven_request: match the
 * incoming request against the Hat purposes available in this Worker.
 * Only Sales Executive (SM&BD) is chat-entry; Value-Based Pricing Assessor
 * (Finance) only ever activates via a Handoff, never directly from chat.
 */
export async function classifyNewMessage(env: Env, text: string): Promise<RoutingClassification> {
  const result = await aiJson<RoutingClassification>(env, {
    system: `You route incoming Telegram messages for ENIG, a diagnose-first positioning/communications consultancy. The only Hat reachable directly from chat is "Sales Executive" (SM&BD), which owns processing an incoming commercial enquiry — someone describing THEIR OWN specific business situation or problem and asking ENIG for help with it.

Classify as "enquiry" ONLY when the message names a specific business, situation, or problem the sender wants help with — e.g. "we're a bakery chain and our branding feels dated, can you help", "I run a consulting firm, our website looks outdated compared to competitors". A concrete situation plus a request for help is required.

Everything else is NOT an enquiry, including: general questions about ENIG itself ("what do you do", "what kind of work is done here", "how does this work"), small talk, greetings, meta/testing messages, or a question with no described business situation attached. Default to "out_of_scope" or "ambiguous" whenever in doubt — a real enquiry will describe itself clearly; don't strain to read one into a vague message.

Return JSON: {"route": "enquiry" | "out_of_scope" | "ambiguous", "reason": "..."}.`,
    user: text,
    light: true,
  });
  return result ?? { route: "ambiguous", reason: "Classification failed." };
}

export async function routeIncomingText(
  env: Env,
  chatId: number,
  text: string,
  threadId?: number,
  options: { forceNewEnquiry?: boolean } = {},
): Promise<void> {
  if (text.startsWith("/")) return; // commands handled by caller

  // A brand-new contact (e.g. an email) is never a reply to whatever work
  // item happens to be active in this topic — only a Telegram-typed message
  // can plausibly continue an in-progress conversation.
  if (!options.forceNewEnquiry) {
    const activeId = await getActiveWorkId(env, chatId, threadId);
    if (activeId) {
      const stub = getSessionStub(env, activeId);
      const state = await stub.getState();
      if (state && state.awaiting) {
        await stub.handleTextReply(text);
        return;
      }
    }
  }

  const unitContext = resolveUnitForThread(env, threadId);
  if (unitContext === "unmapped") {
    await sendMessage(env, chatId, "This topic isn't mapped to a Unit yet.", undefined, threadId);
    return;
  }

  // Finance and the four not-yet-built Units don't take structured work
  // from chat, but the topic isn't dead either — hold open conversation
  // there, with memory, rather than a rigid refusal every time.
  if (unitContext !== "dm" && unitContext !== "SM&BD") {
    const reply = await generalChatReply(env, unitContext, chatId, threadId, text);
    await sendMessage(env, chatId, reply || "...", undefined, threadId);
    return;
  }

  const classification = await classifyNewMessage(env, text);
  if (classification.route === "enquiry") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "SM&BD", "Sales Executive", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleIncomingEnquiry(text);
    return;
  }

  // Not a new enquiry — hold open conversation instead of a rigid refusal.
  const reply = await generalChatReply(env, "SM&BD", chatId, threadId, text);
  await sendMessage(env, chatId, reply || "...", undefined, threadId);
}
