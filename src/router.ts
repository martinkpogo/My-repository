import type { Env, Unit } from "./types";
import { aiJson } from "./ai";
import { sendMessage } from "./telegram";
import { generalChatReply } from "./chat";
import { getGovernance } from "./governance";
import { marketingHatSummaryList } from "./hats/registry";

// Canonical Notion governance source for this Workspace's routing/execution
// constraints (Core Structure category 3 — one AI Project Instructions page
// per AI Workspace). Governs which Hat a new incoming work item routes to;
// does not restate any Hat's own operating procedure.
const SMBD_PROJECT_INSTRUCTIONS_PAGE_ID = "3cecb004-e583-8193-918b-c81ae322976d";

// Sales Executive/Business Development intake is paused by deliberate,
// standing policy, not as a temporary state pending a rebuild. Real client
// identity (Entity/Matter, names, contact details) is confirmed-sensitive
// data that this Worker's AI provider (Cloudflare Workers AI) is not
// approved to process -- Workers AI's training-data policy for personal
// information hasn't been confirmed acceptable, the same reason
// chat.general_reply is gated in dataBoundary/policy.ts. That work now
// lives entirely in an isolated Sales Executive Claude project with its own
// Notion (Entity/Matters/Proposals) and Gmail access, where Martin reviews
// and approves every client-facing action (e.g. an email) directly -- it is
// live and working, exchanging only opaque Entity_Token/Matter_Token values
// with this Worker via the shared Handoffs database.
//
// This flag stays true until an AI provider with a confirmed acceptable
// personal-data/training policy is available for this Worker to use --
// not until the isolated project exists (it already does). This Worker's
// own Notion integration has also had its connection to the Engagement
// page (Entity, Matters, Proposals) removed entirely, so salesExecutive.ts's
// Notion calls fail regardless of this flag; re-granting that access to
// bring this code back would undo the isolation this pause protects.
export const SALES_EXECUTIVE_PAUSED = true;

// generalChatReply's underlying aiChat call returns "" whenever no AI
// provider is eligible under the current data-boundary policy. As of the
// PRODUCTION_TASK_SENSITIVITY / PRODUCTION_PROVIDER_ELIGIBILITY tables in
// dataBoundary/policy.ts, this is deliberate for chat.general_reply
// specifically: it's classified client_confidential (you can reference
// any real client by name in it), and workers-ai is only eligible for
// business_sensitive and below -- Cloudflare's training-data policy for
// personal information hasn't been confirmed acceptable, the same reason
// Sales Executive itself is paused. A bare "..." fallback made that look
// like a mystery bug rather than the known, deliberate policy it is. Sales
// chat stays classified client_confidential (Martin could paste real
// enquiry content into that topic's freeform chat), which no eligible
// provider can serve today -- workers-ai is approved for business_sensitive
// and below only, pending a provider with an acceptable personal-data/
// training policy. State this directly rather than hedging with "if this
// is Sales... anywhere else...": handleSalesIntake only ever runs for
// Sales (the Sales topic itself, or the DM fallback once it's decided the
// message is Sales-relevant), so the reason is always the same one.
const SALES_CHAT_UNAVAILABLE_MESSAGE =
  "This Unit is unavailable for general chat right now. Sales conversations are classified client_confidential, and no AI provider is currently approved for that sensitivity -- pending one with an acceptable personal-data/training policy. Structured Sales enquiries are paused for the same reason; the isolated Sales Executive project handles this work in the meantime.";

// Every other Unit's chat is business_sensitive (see chatSensitivityForUnit
// in chat.ts) and should normally succeed, so seeing this message there
// points to a genuine provider failure, not policy.
const AI_UNAVAILABLE_MESSAGE =
  "Couldn't generate a reply -- no AI provider is currently available. This points to a genuine provider failure, not an access restriction; please try again shortly.";

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
 * routable like the old combined SM&BD topic used to be, before Sales,
 * Marketing, and Business Development each got their own. "unmapped" means
 * a real thread id was given but doesn't match any configured Unit.
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
 * by the canonical Sales AI Project Instructions (retrieved live, not
 * restated in code) — this is the "Workspace matches the incoming request
 * against the Hats belonging to that Unit" step the Universal Role Contract
 * describes (Value-Based Pricing Assessor/Finance only ever activates via a
 * Handoff, never directly from chat, so it's never a candidate here). The
 * underlying Notion page (SMBD_PROJECT_INSTRUCTIONS_PAGE_ID) still covers
 * the combined Sales/Marketing/Business Development governance from before
 * the Unit split — only its label here has been renamed to match.
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
    "Sales AI Project Instructions",
  );
  if (!projectInstructions) {
    console.error("classifyNewMessage: Sales Project Instructions retrieval failed — refusing to classify/route");
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
    taskId: "routing.enquiry_classification",
    system: `You route incoming Telegram messages for ENIG, a diagnose-first positioning/communications consultancy. Below is the canonical Sales AI Project Instructions, retrieved from Notion — it is authoritative for how incoming work in this workspace is classified and which Hat/specialization it routes to. Follow it exactly.

=== SALES AI PROJECT INSTRUCTIONS (retrieved from Notion's canonical governance) ===
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
 * Coarse specialization check, only needed in the DM/no-topic-configured
 * fallback (Sales and Marketing each have their own dedicated topic now,
 * which already declares which specialization a message belongs to): is
 * this an internal Marketing-specialization task (owned by one of the five
 * Marketing Hats), as opposed to a client-facing sales enquiry or general
 * conversation? Per the original combined SM&BD Unit's Notion definition,
 * Marketing was one of three specializations that Unit covered (Sales,
 * Marketing, Business Development) — this is the specialization step;
 * which of the five Marketing Hats owns it is decided separately, inside
 * marketing.handleMarketingIntake, using only that Hat's own short purpose
 * per Hat (progressive context, not the full definitions). Returns null on
 * failure — callers fall through to the existing Sales path unchanged
 * rather than guessing.
 */
async function classifyMarketingTask(env: Env, text: string): Promise<"marketing" | "not_marketing" | null> {
  const result = await aiJson<{ specialization: "marketing" | "not_marketing" }>(env, {
    taskId: "routing.marketing_specialization_check",
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

// User-facing text for a Sales enquiry that arrives while
// SALES_EXECUTIVE_PAUSED is true. Kept as one constant so the DM path and
// the dedicated Sales-topic path can't drift apart.
const SALES_PAUSED_MESSAGE =
  "Sales Executive intake is paused by standing policy until an AI provider with an acceptable personal-data/training policy is available. This enquiry was not processed here — the isolated Sales Executive project (with its own Notion and Gmail access) owns this work now.";

/**
 * Classifies and, if it's a genuine enquiry, starts a Sales Executive work
 * item -- shared by the dedicated Sales topic (which already knows the
 * message is Sales-relevant) and the DM/no-topic-configured fallback
 * (which doesn't, and still needs the enquiry/out_of_scope/ambiguous
 * classification this performs). Always ends by replying in `threadId`,
 * so the caller can simply return afterward.
 */
async function handleSalesIntake(env: Env, chatId: number, text: string, threadId: number | undefined): Promise<void> {
  const classification = await classifyNewMessage(env, chatId, text, threadId);
  if (!classification) return; // retrieval failed — Martin already told, nothing further to do.
  if (classification.route === "enquiry") {
    if (SALES_EXECUTIVE_PAUSED) {
      console.error(`Sales Executive intake paused — enquiry not processed (chat ${chatId})`);
      await sendMessage(env, chatId, SALES_PAUSED_MESSAGE, undefined, threadId);
      return;
    }
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Sales", "Sales Executive", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleIncomingEnquiry(text);
    return;
  }

  // Not a new enquiry — hold open conversation instead of a rigid refusal.
  const reply = await generalChatReply(env, "Sales", chatId, threadId, text);
  await sendMessage(env, chatId, reply || SALES_CHAT_UNAVAILABLE_MESSAGE, undefined, threadId);
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

  // The Marketing topic already declares its own intent -- no need for the
  // DM path's specialization classifier, straight to the five-Hat
  // classification inside marketing.handleMarketingIntake.
  if (unitContext === "Marketing") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Marketing", "Marketing", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleMarketingRequest(text);
    return;
  }

  // Likewise, the Sales topic already declares its own intent.
  if (unitContext === "Sales") {
    await handleSalesIntake(env, chatId, text, threadId);
    return;
  }

  // Finance, Business Development, and the other not-yet-built Units don't
  // take structured work from chat, but the topic isn't dead either — hold
  // open conversation there, with memory, rather than a rigid refusal.
  if (unitContext !== "dm") {
    const reply = await generalChatReply(env, unitContext, chatId, threadId, text);
    await sendMessage(env, chatId, reply || AI_UNAVAILABLE_MESSAGE, undefined, threadId);
    return;
  }

  // DM / no UNIT_TOPIC_MAP configured: there's no dedicated topic to signal
  // intent, so both specializations that used to share the old combined
  // SM&BD topic still need classifying here. Marketing first, per the
  // Unit's own Notion definition of Sales/Marketing/Business Development as
  // three specializations under one umbrella; a "not_marketing"/failed
  // result falls through unchanged to the Sales classifier.
  const marketingCheck = await classifyMarketingTask(env, text);
  if (marketingCheck === "marketing") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Marketing", "Marketing", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleMarketingRequest(text);
    return;
  }

  await handleSalesIntake(env, chatId, text, threadId);
}
