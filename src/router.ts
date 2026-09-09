import type { Env, Unit } from "./types";
import { aiJson } from "./ai";
import { sendMessage } from "./telegram";

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
    system:
      'You route incoming Telegram messages for ENIG, a diagnose-first positioning/communications consultancy. The only Hat reachable directly from chat is "Sales Executive" (SM&BD), which owns incoming commercial enquiries (a prospective or existing client describing a business problem, asking for help, or a lead needing to be processed). Classify the message. Return JSON: {"route": "enquiry" | "out_of_scope" | "ambiguous", "reason": "..."}. Use "out_of_scope" for anything clearly not a commercial enquiry (small talk, unrelated requests). Use "ambiguous" only if it is genuinely unclear whether this is a new commercial enquiry.',
    user: text,
    light: true,
  });
  return result ?? { route: "ambiguous", reason: "Classification failed." };
}

export async function routeIncomingText(env: Env, chatId: number, text: string, threadId?: number): Promise<void> {
  if (text.startsWith("/")) return; // commands handled by caller

  const activeId = await getActiveWorkId(env, chatId, threadId);
  if (activeId) {
    const stub = getSessionStub(env, activeId);
    const state = await stub.getState();
    if (state && state.awaiting) {
      await stub.handleTextReply(text);
      return;
    }
  }

  const unitContext = resolveUnitForThread(env, threadId);
  if (unitContext === "unmapped") {
    await sendMessage(env, chatId, "This topic isn't mapped to a Unit yet.", undefined, threadId);
    return;
  }
  if (unitContext !== "dm" && unitContext !== "SM&BD") {
    const message =
      unitContext === "Finance"
        ? "Finance's Value-Based Pricing Assessor only activates via a Handoff from SM&BD — it doesn't take work directly from chat."
        : `No Hat is available for ${unitContext} yet in this workspace — not built in this slice.`;
    await sendMessage(env, chatId, message, undefined, threadId);
    return;
  }

  const classification = await classifyNewMessage(env, text);
  if (classification.route === "out_of_scope") {
    await sendMessage(
      env,
      chatId,
      "No Hat currently available here covers that. This workspace handles incoming commercial enquiries (SM&BD) and value-based pricing (Finance, via Handoff only).",
      undefined,
      threadId,
    );
    return;
  }
  if (classification.route === "ambiguous") {
    await sendMessage(
      env,
      chatId,
      `I can't determine whether this is a new commercial enquiry.${classification.reason ? ` ${classification.reason}` : ""} If it is, resend clearly describing the enquiry. If it's a reply to something in progress, use /sessions to pick the right work item first.`,
      undefined,
      threadId,
    );
    return;
  }

  const workId = newWorkId();
  const stub = getSessionStub(env, workId);
  await stub.init(workId, chatId, "SM&BD", "Sales Executive", threadId);
  await setActiveWorkId(env, chatId, threadId, workId);
  await stub.handleIncomingEnquiry(text);
}
