import type { Env, Unit } from "./types";
import { aiJson } from "./ai";
import { sendMessage } from "./telegram";
import { getGovernance } from "./governance";
import { ALL_HATS, marketingHatSummaryList } from "./hats/registry";
import { getRegisteredCapabilities } from "./actions/registry";
import { getChatHistory } from "./chat";

/**
 * The single Workspace-message classification seam (CHAT/COWORK boundary).
 *
 * This module decides ONLY. It never creates a WorkSession, never writes to
 * Notion, never calls a governed execution handler, and never sends a
 * message that commits to an action -- classifyWorkspaceMessage's result is
 * a routing PROPOSAL. router.ts is the only caller that acts on it, and
 * every "cowork" decision still passes through the exact same existing
 * governed entry points (stub.init + handle*Request) and every gate inside
 * them (approval, Handoff, token-boundary, fail-closed checks) exactly as
 * before this module existed. This module adds no execution authority of
 * its own -- CHAT -> workspace routing decision -> COWORK candidate ->
 * existing governed execution gates, never CHAT -> AI says COWORK -> execute.
 */

// Canonical Notion governance source for this Workspace's routing/execution
// constraints -- same page classifyNewMessage previously used. Governs the
// bar for a genuine Sales enquiry; does not restate any Hat's own operating
// procedure.
const SMBD_PROJECT_INSTRUCTIONS_PAGE_ID = "3cecb004-e583-8193-918b-c81ae322976d";

const VALID_UNITS: Unit[] = [
  "Sales",
  "Marketing",
  "Business Development",
  "Finance",
  "Strategy",
  "Research & Intelligence",
  "Creative & Design",
  "Operations",
];

function isUnit(value: unknown): value is Unit {
  return typeof value === "string" && (VALID_UNITS as string[]).includes(value);
}

export type WorkspaceDecision =
  | { mode: "chat"; unit?: Unit }
  | { mode: "cowork"; unit: Unit; hat: string; capability?: string }
  | { mode: "clarify"; question: string }
  | { mode: "blocked"; reason: string };

interface RawWorkspaceClassification {
  mode?: "chat" | "cowork" | "clarify";
  unit?: string;
  hat?: string;
  capability?: string;
  question?: string;
}

/** Progressive Hat metadata only -- name/unit/specialization, never a full Hat Definition. */
function hatIdentitySummaryList(): string {
  return ALL_HATS.map((h) => `- ${h.name} (Unit: ${h.unit}${h.specialization ? `, specialization: ${h.specialization}` : ""})`).join("\n");
}

function capabilitySummaryList(): string {
  const capabilities = getRegisteredCapabilities();
  if (capabilities.length === 0) return "(none currently registered)";
  return capabilities.map((c) => `- ${c.id}: ${c.description}`).join("\n");
}

function buildClassificationSystemPrompt(projectInstructions: string): string {
  return `You are the single Workspace routing seam for ENIG, an AI-staffed consultancy operating on Telegram. Every fresh message in the Workspace stream is classified here, exactly once, before anything else happens. Your output is a routing PROPOSAL only -- it is never itself authorization to execute anything; the runtime enforces its own separate, unmodified approval/Handoff/token gates regardless of what you decide.

=== THE TWO MODES ===
CHAT is the default. It covers: general questions, business discussion, asking a Unit/Hat for advice/analysis/opinion, internal reasoning out loud, discussion of ENIG's own operations, and exploratory discussion where no governed work has actually been requested yet -- even if a specific Unit or Hat is named, a company is mentioned, the wording is imperative, or the message sounds like something a Hat could in principle execute. Naming a Unit/Hat only establishes WHO the user is talking to, never that governed work should start.

COWORK is active governed work: WorkSession, Business Objects, Handoffs, approvals, and execution. Use it only when the user is actually asking ENIG to perform a defined piece of work right now -- a concrete business/service matter needing governed execution, clearly corresponding to an existing Hat/workflow/capability, or the user has just moved from discussing an issue into actually doing the work (e.g. "let's diagnose it properly and develop the intervention" after a chat discussion already established the situation).

Examples that MUST stay CHAT:
- "Finance, explain our value-based pricing." (asking for an explanation, not commissioning pricing work)
- "Strategy, what do you think about this positioning problem?" (asking for an opinion)
- "Marketing Strategist, what should we consider before changing our positioning?" (asking for considerations, not commissioning campaign work)
- "R&I, what does this market look like?" phrased as a passing question with no request to actually investigate
- "How should ENIG approach this kind of client?" (a general question about ENIG itself)

Examples that ARE COWORK:
- A concrete Sales enquiry: a specific prospect names their business, situation, or problem and asks for help -- e.g. "we're a bakery chain and our branding feels dated, can you help." A vague or test-like message with no real situation described is NOT this.
- A genuine R&I research request: an explicit ask to investigate/research a market, competitor, customer/audience, or business/regulatory question -- e.g. "research this company," "what do customers in this segment care about."
- "Marketing Strategist, let's develop the campaign strategy for this" -- ONLY once the message establishes that actual work is being undertaken (e.g. "let's develop," "let's get this started," "go ahead and draft"), not merely because the Hat was named.
- A clear instruction to begin diagnosing/pricing/proposing/researching/drafting something specific, where the request supplies (or has already, in this conversation, supplied) enough concrete substance to actually start.

Never default to Sales, and never use any fixed Unit priority -- every Unit (Sales, Marketing, Business Development, Finance, Strategy, Research & Intelligence, Creative & Design, Operations) must be independently addressable on its own terms. A Telegram topic/thread is a stream identity only, never a Unit identity -- do not let which topic a message arrived in decide the Unit; decide from the message (and recent conversation) itself.

=== HAT METADATA (progressive -- identity only, not full Hat definitions) ===
${hatIdentitySummaryList()}

Marketing's five Hats, with their purpose:
${marketingHatSummaryList()}

=== REGISTERED WORKSPACE CAPABILITIES ===
${capabilitySummaryList()}
Only propose a capability id from this exact list, and only when the message clearly asks for that specific action to actually happen (e.g. "create a Google Doc for X," "update the content calendar sheet") -- capability-sounding words inside an ordinary discussion (e.g. mentioning a spreadsheet in passing) must stay CHAT.

=== SALES AI PROJECT INSTRUCTIONS (retrieved from Notion's canonical governance -- authoritative for what counts as a genuine Sales enquiry) ===
${projectInstructions}

=== WHEN TO USE "clarify" INSTEAD OF GUESSING ===
Use clarify when the request could reasonably mean either discussion or active work, or when the available Hat/Unit metadata above is insufficient to safely determine which Unit or Hat should own it. Ask one direct, short clarifying question. Never invent ownership.

=== RESPONSE FORMAT ===
Return JSON only: {"mode": "chat" | "cowork" | "clarify", "unit": "<exact Unit name from the list above, if applicable>", "hat": "<exact Hat name, if applicable and known>", "capability": "<exact capability id, only for cowork with a registered capability>", "question": "<only for clarify>"}. Omit any field that doesn't apply. For "chat", include "unit" only when a specific Unit/Hat was clearly addressed -- omit it for a general question addressed to no one in particular.`;
}

/**
 * Classifies a fresh Workspace message as chat/cowork/clarify/blocked. This
 * is the ONLY place a new Workspace message is classified -- router.ts must
 * not run any further independent classifier before or after this call.
 * Fails closed (mode: "blocked", Martin messaged directly) if governance
 * can't be retrieved or the AI call itself fails -- never guesses, never
 * silently falls through to execution.
 */
export async function classifyWorkspaceMessage(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  text: string,
): Promise<WorkspaceDecision> {
  const projectInstructions = await getGovernance(env, SMBD_PROJECT_INSTRUCTIONS_PAGE_ID, "Sales AI Project Instructions");
  if (!projectInstructions) {
    console.error("classifyWorkspaceMessage: Sales Project Instructions retrieval failed — refusing to classify/route");
    await sendMessage(
      env,
      chatId,
      "This message wasn't processed — routing governance couldn't be retrieved from Notion. Please resend once resolved.",
      undefined,
      threadId,
    );
    return { mode: "blocked", reason: "routing governance retrieval failed" };
  }

  // Recent conversation context lets a short transition message ("okay,
  // let's diagnose it properly") resolve against what was already
  // established in chat, without requiring every follow-up to repeat the
  // whole situation, and without treating every follow-up in a client-
  // adjacent conversation as automatically COWORK.
  const history = await getChatHistory(env, chatId, threadId);
  const recentHistoryText = history
    .slice(-6)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  const result = await aiJson<RawWorkspaceClassification>(env, {
    taskId: "routing.workspace_classification",
    system: buildClassificationSystemPrompt(projectInstructions),
    user: `${recentHistoryText ? `Recent conversation in this thread:\n${recentHistoryText}\n\n` : ""}New message: ${text}`,
    light: true,
  });

  const mapped = mapRawClassificationToDecision(result);
  if (mapped.messageForMartin) {
    console.error(`classifyWorkspaceMessage: ${mapped.logReason} (chat ${chatId})`);
    await sendMessage(env, chatId, mapped.messageForMartin, undefined, threadId);
  }
  return mapped.decision;
}

/**
 * Pure mapping from the AI's raw classification JSON to a WorkspaceDecision
 * -- no I/O, no side effects, deterministic. Exported specifically so the
 * decision logic (chat/cowork/clarify/blocked mapping, capability
 * validation, Unit validation) can be tested directly without depending on
 * the AI call itself succeeding -- routing.workspace_classification is
 * client_confidential with no eligible provider today (see
 * PRODUCTION_PROVIDER_ELIGIBILITY in dataBoundary/policy.ts), the same
 * standing constraint its predecessor classifiers always had, so the real
 * end-to-end call cannot be exercised with controlled content in this
 * environment either. classifyWorkspaceMessage itself remains the only
 * production caller.
 */
export function mapRawClassificationToDecision(
  result: RawWorkspaceClassification | null,
): { decision: WorkspaceDecision; messageForMartin?: string; logReason?: string } {
  if (!result || !result.mode) {
    return {
      decision: { mode: "blocked", reason: "workspace classification unavailable" },
      messageForMartin:
        "Couldn't classify that message — no AI provider is currently available. This points to a genuine provider failure, not an access restriction; please try again shortly.",
      logReason: "AI classification unavailable",
    };
  }

  if (result.mode === "clarify") {
    return {
      decision: {
        mode: "clarify",
        question: result.question?.trim() || "Could you clarify whether you'd like to discuss this, or have ENIG actively start work on it?",
      },
    };
  }

  if (result.mode === "chat") {
    return { decision: { mode: "chat", unit: isUnit(result.unit) ? result.unit : undefined } };
  }

  if (result.mode === "cowork") {
    if (!isUnit(result.unit)) {
      return {
        decision: {
          mode: "clarify",
          question: "I couldn't determine which Unit should own this work — could you name it explicitly (e.g. Sales, Strategy, Marketing, Research & Intelligence)?",
        },
      };
    }
    const capabilities = getRegisteredCapabilities();
    const capability = typeof result.capability === "string" && capabilities.some((c) => c.id === result.capability) ? result.capability : undefined;
    return { decision: { mode: "cowork", unit: result.unit, hat: typeof result.hat === "string" ? result.hat : "", capability } };
  }

  return {
    decision: { mode: "blocked", reason: "workspace classification returned an unrecognized mode" },
    messageForMartin: "Couldn't classify that message safely — the routing decision came back in an unexpected shape. Please try rephrasing.",
    logReason: `AI returned an unrecognized mode "${result.mode}"`,
  };
}
