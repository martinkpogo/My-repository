import type { Env, Unit } from "./types";
import { aiJson } from "./ai";
import { sendMessage } from "./telegram";
import { generalChatReply } from "./chat";
import { getGovernance } from "./governance";
import { marketingHatSummaryList } from "./hats/marketingHatDefinitions";

// Canonical Notion governance source for this Workspace's routing/execution
// constraints (Core Structure category 3 — one AI Project Instructions page
// per AI Workspace). Governs which Hat a new incoming work item routes to;
// does not restate any Hat's own operating procedure.
const SMBD_PROJECT_INSTRUCTIONS_PAGE_ID = "3cecb004-e583-8193-918b-c81ae322976d";

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
 * Workspace-level routing decision for a genuinely new work item. Governed
 * by the canonical SM&BD AI Project Instructions (retrieved live, not
 * restated in code) — this is the "Workspace matches the incoming request
 * against the Hats belonging to that Unit" step the Universal Role Contract
 * describes (Value-Based Pricing Assessor/Finance only ever activates via a
 * Handoff, never directly from chat, so it's never a candidate here).
 * Returns null if that governance can't be retrieved; the caller must not
 * classify or route without it (Martin is told directly, per the
 * fail-closed rule — no hardcoded fallback, no queued retry).
 */
export async function classifyNewMessage(
  env: Env,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<RoutingClassification | null> {
  const projectInstructions = await getGovernance(
    env,
    SMBD_PROJECT_INSTRUCTIONS_PAGE_ID,
    "SM&BD AI Project Instructions",
  );
  if (!projectInstructions) {
    console.error("classifyNewMessage: SM&BD Project Instructions retrieval failed — refusing to classify/route");
    await sendMessage(
      env,
      chatId,
      "This message wasn't processed — routing governance couldn't be retrieved from Notion. Please resend once resolved.",
      undefined,
      threadId,
    );
    return null;
  }

  const result = await aiJson<RoutingClassification>(env, {
    system: `You route incoming Telegram messages for ENIG, a diagnose-first positioning/communications consultancy. Below is the canonical SM&BD AI Project Instructions, retrieved from Notion — it is authoritative for how incoming work in this workspace is classified and which Hat/specialization it routes to. Follow it exactly.

=== SM&BD AI PROJECT INSTRUCTIONS (retrieved from Notion's canonical governance) ===
${projectInstructions}

=== CLASSIFICATION TASK (execution mechanics — not part of the governance above) ===
Classify as "enquiry" ONLY when the message names a specific business, situation, or problem the sender wants help with — e.g. "we're a bakery chain and our branding feels dated, can you help", "I run a consulting firm, our website looks outdated compared to competitors". A concrete situation plus a request for help is required.

Everything else is NOT an enquiry, including: general questions about ENIG itself ("what do you do", "what kind of work is done here", "how does this work"), small talk, greetings, meta/testing messages, or a question with no described business situation attached. Default to "out_of_scope" or "ambiguous" whenever in doubt — a real enquiry will describe itself clearly; don't strain to read one into a vague message.

Return JSON: {"route": "enquiry" | "out_of_scope" | "ambiguous", "reason": "..."}.`,
    user: text,
    light: true,
  });
  return result ?? { route: "ambiguous", reason: "Classification failed." };
}

/**
 * Coarse specialization check, run before the existing Sales enquiry
 * classifier: is this an internal Marketing-specialization task (owned by
 * one of the five Marketing Hats), as opposed to a client-facing sales
 * enquiry or general conversation? Per the SM&BD Unit's own Notion
 * definition, Marketing is one of three specializations this Unit covers
 * (Sales, Marketing, Business Development) — this is the specialization
 * step; which of the five Marketing Hats owns it is decided separately,
 * inside marketing.handleMarketingIntake, using only that Hat's own
 * short purpose per Hat (progressive context, not the full definitions).
 * Returns null on failure — callers fall through to the existing Sales
 * path unchanged rather than guessing.
 */
async function classifyMarketingTask(env: Env, text: string): Promise<"marketing" | "not_marketing" | null> {
  const result = await aiJson<{ specialization: "marketing" | "not_marketing" }>(env, {
    system: `You classify incoming messages for ENIG, a consultancy. Below are ENIG's five internal Marketing Hats:

${marketingHatSummaryList()}

Classify the message as "marketing" if Martin (ENIG's own operator, talking to his own internal team) is asking ENIG's own team to do ANY of: set marketing/campaign objectives or target audiences, decide channel or campaign strategy, define brand voice/tone/messaging/key messages, plan or review content (themes, briefs, calendars, scheduling, production workflow, publication), or plan/execute/optimize digital or paid advertising campaigns. This includes short, imperative, or informally-worded requests — e.g. "define our Q2 objectives", "what tone should our website use", "get this scheduled for publication", "reallocate the ad budget" all count as "marketing".

Classify as "not_marketing" only if the message is: (a) a prospective CLIENT's incoming business enquiry describing their own company's problem and asking ENIG for help, or (b) general small talk / unrelated to marketing work entirely.

Examples of "marketing": "Define our Q2 marketing objectives", "What tone should we use across our channels?", "We need content pillars for this quarter", "Get the blog post scheduled and published", "Increase the ad budget on the better-performing campaign".
Examples of "not_marketing": "We're a bakery chain and our branding feels dated, can you help?" (client enquiry), "How's it going?" (small talk).

Return JSON: {"specialization": "marketing"} or {"specialization": "not_marketing"}.`,
    user: text,
  });
  return result?.specialization ?? null;
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

  // Specialization check first: Marketing is a distinct specialization
  // within this same SM&BD Unit (per the Unit's own Notion definition),
  // with its own five-Hat classification handled inside
  // marketing.handleMarketingIntake. A "not_marketing"/failed result
  // falls through unchanged to the existing Sales enquiry classifier
  // below — this is additive and never alters Sales Executive's own
  // classification or behavior.
  const marketingCheck = await classifyMarketingTask(env, text);
  if (marketingCheck === "marketing") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "SM&BD", "Marketing", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleMarketingRequest(text);
    return;
  }

  const classification = await classifyNewMessage(env, chatId, text, threadId);
  if (!classification) return; // retrieval failed — Martin already told, nothing further to do.
  if (classification.route === "enquiry") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    // "Sales Executive" and the five Marketing Hats (above) are the
    // current chat-reachable Hats in this Unit. The canonical Workspace
    // Project Instructions (retrieved above, governing the
    // route/out_of_scope/ambiguous classification itself) remain the
    // authority for the Sales routing rule.
    await stub.init(workId, chatId, "SM&BD", "Sales Executive", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleIncomingEnquiry(text);
    return;
  }

  // Not a new enquiry — hold open conversation instead of a rigid refusal.
  const reply = await generalChatReply(env, "SM&BD", chatId, threadId, text);
  await sendMessage(env, chatId, reply || "...", undefined, threadId);
}
