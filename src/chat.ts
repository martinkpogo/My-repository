import type { Env, Unit } from "./types";
import { generate } from "./ai";
import type { ChatTurn, GeneratePromptParts } from "./ai";
import { plainText, queryDataSource } from "./notion";
import type { SensitivityLevel } from "./dataBoundary/types";
import { ALL_HATS } from "./hats/registry";
import { systemContext } from "./access";
import { kvGet, kvPut } from "./kvStore";
import { findUnitManifest } from "./units/registry";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "./governance";
import { businessSnapshot } from "./businessSnapshot";
import { offerEnigSuggestion, parseEnigReply, suggestionInstruction } from "./enigSuggestion";
import type { InlineButton } from "./telegram";
import { withLiveStatus } from "./runtime/liveStatus";

// Per the identity architecture decision (Notion, Sept 2026), real-world
// identity lives exclusively in the Identity Resolution Registry -- Entity
// and Matters now hold only pseudonymous operational records (no Name,
// Email, or Phone), so Runtime reading/writing them directly is no longer
// an identity-boundary crossing. Sales still stays client_confidential
// (chat.general_reply's task-level default, applied by passing undefined
// here) since Martin could still paste real enquiry content -- a contact's
// name, email, or phone number -- into that topic's freeform chat. Every
// other Unit is business_sensitive -- ENIG's own internal-operations tier,
// already eligible for workers-ai -- so they behave like a normal LLM for
// ordinary conversation instead of hitting the client_confidential gate
// meant for the one Unit whose freeform chat can still surface real
// contact identity.
function chatSensitivityForUnit(unit: Unit): SensitivityLevel | undefined {
  return unit === "Sales" ? undefined : "business_sensitive";
}

const MAX_HISTORY_TURNS = 20;

// Universal Role Contract, evidence rule: consequential claims must be
// attributable to a specific source; unsupported material claims are
// unverified until sourced. Confirmed necessary live, twice: (1) asked "do
// you remember any enquiries," this chat invented three entirely fictional
// ones with plausible specifics instead of saying it couldn't check; (2)
// asked about ENIG's process and Marketing's roles, it invented a detailed
// 5-step workflow and six job titles (Marketing Lead, Social Media
// Manager, etc.) that don't exist -- the real Marketing Hats are named in
// buildStructureFacts below, and none of the invented ones matched. The
// first version of this rule only named "past enquiries, entities,
// matters, deals, numbers, dates" as off-limits to invent; process steps,
// job titles/roles, and org structure are just as fabricatable and are
// named explicitly now. Below, it's handed a real snapshot of this Unit's
// recent Activity & Decision Log entries as grounding where one exists --
// but that's still only a recent slice, not full database access, so the
// rule against inventing beyond what it was actually given still applies.
const EVIDENCE_RULE =
  "If a snapshot of recent real Activity & Decision Log entries is provided below, use it to answer factual questions about recent activity — it is not the full history, and you have no other live connection to Notion or any record system beyond what's listed there (or nothing, if no snapshot is provided at all). Never invent specifics that aren't in that snapshot, in the AUTHORITATIVE FACTS section, or in this conversation's own messages -- this includes but is not limited to: past enquiries, entities, matters, deals, numbers, dates, internal process steps or workflow stages, job titles or roles, team members, or org structure. If asked about something not covered by what you were actually given, say so plainly and point to /sessions or the actual Notion database — never answer with a plausible-sounding invented example, even a generic-sounding one (a job title or process step can sound completely ordinary and still be entirely fabricated).";

// Every Unit, in a fixed order. Typed as a total Record so a Unit added to
// the type can't be silently left out of the facts below.
const UNIT_ORDER: Record<Unit, number> = {
  Sales: 0,
  Marketing: 1,
  "Business Development": 2,
  Finance: 3,
  Strategy: 4,
  "Creative & Design": 5,
  Operations: 6,
};

// The canonical Operations -- ENIG Hat Definition (Notion, ENIG HQ /
// 2. Organization / Operations). ENIG is Chat's conversational voice when
// no Unit is addressed; its role, behaviour, instructions and end results
// are read live from this page, never restated in code.
export const ENIG_HAT_DEFINITION_PAGE_ID = "413cb004-e583-8188-aad2-f36696f29d39";

// The only roles/Hats that actually exist in this system, computed from
// the same registries the runtime itself routes with (hats/registry.ts's
// ALL_HATS, which is exactly what workspaceRouter's addressee matching
// reads, and units/registry.ts's manifests, which decide whether a Unit can
// start governed work at all) so this can never drift out of sync with
// reality the way the hand-written list it replaces did -- that list still
// said Finance, Strategy and Business Development had zero Hats long after
// all three were built. Exists specifically because the chat invented six
// Marketing job titles that don't exist (see EVIDENCE_RULE above) when asked
// what roles are available.
export function buildStructureFacts(): string {
  const units = (Object.keys(UNIT_ORDER) as Unit[]).sort((a, b) => UNIT_ORDER[a] - UNIT_ORDER[b]);
  const unitLines = units.map((unit) => {
    const hats = ALL_HATS.filter((h) => h.unit === unit).map((h) => (h.specialization ? `${h.name} (${h.specialization})` : h.name));
    // ENIG is defined in Notion as an Operations Hat but declares no Actions,
    // so it is in neither ALL_HATS nor a manifest -- named here so the facts
    // match its definition without making it addressable or dispatchable.
    if (unit === "Operations") hats.push("ENIG (Chief of Staff) -- the voice Martin talks to when he addresses no Unit; it routes work and starts none itself");
    const startable = findUnitManifest(unit) !== undefined;
    const hatText = hats.length ? `Hats: ${hats.join("; ")}` : "no Hats in this runtime";
    return `- ${unit}: ${hatText}. ${startable ? "Governed work CAN be started from chat." : "Governed work can NOT be started from chat."}`;
  });
  return `=== AUTHORITATIVE FACTS -- READ THIS BEFORE ANSWERING ANY QUESTION ABOUT ROLES, HATS, JOB TITLES, OR TEAM STRUCTURE ===
ENIG's real Units are exactly these seven, with exactly these Hats -- no others exist under any name:
${unitLines.join("\n")}
A "Hat" is an AI-executed role inside this system, not a human employee or job opening.
Sales Executive is paused here in this runtime by standing policy, but it is not inactive -- it is present and actively working as an isolated Sales Executive project in Claude, with its own Notion and Gmail access, where Martin reviews and approves every client-facing action directly. If asked whether Sales Executive is paused, active, or exists, say it is paused in this runtime specifically (due to the sensitive nature of its work) but implemented and live in that separate Claude project -- never say simply "paused" without that context. Lead Generation Specialist is not paused.
If asked what roles/Hats/positions exist anywhere, your answer must use ONLY the names listed above, copied exactly -- never add, combine, rename, pluralize into new variants, or supplement with anything that sounds like a typical department role (e.g. "Marketing Lead," "Social Media Manager," "SEO Specialist," "Marketing Coordinator," "Marketing Analyst" -- these and anything like them DO NOT EXIST here, no matter how plausible they sound). If earlier turns in this conversation named different or additional roles, that was a mistake -- correct it plainly rather than repeating or extending it. Since these are AI execution roles, never suggest applying for one, contacting a "lead" as if they were a person, or imply there's a hiring process of any kind.
=== END AUTHORITATIVE FACTS ===`;
}

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
//
// That rule used to stop there, which made this reply talk Martin OUT of
// work the system can do: Chat has been action-capable since the
// 2026-09-28 decision (router.ts dispatches a message that addresses a
// Unit/Hat through the Action Registry before this reply is ever reached).
// The reply itself still executes nothing -- what changed is that it now
// says how the work actually starts, so a request ends with the exact
// message Martin can send rather than a bare "I can't".
const HOW_WORK_STARTS_RULE =
  "This reply itself cannot perform any action — you cannot send messages to other topics, create or update Notion records, advance a Handoff, or run any workflow. The real system can: when Martin starts a message with the name of a Unit or Hat listed in AUTHORITATIVE FACTS as able to start governed work from chat (for example \"Marketing, draft a LinkedIn post about how we diagnose before we prescribe\" or \"Lead Generation Specialist, find leads in ...\"), the system routes it to that Unit's real workflow, which asks Martin's approval before anything is written or sent. Strategy and Finance requests must also name an existing Matter token (e.g. MAT-12). So when Martin asks for work one of those Units does, say which Unit or Hat owns it and give him the exact one-line message to send, starting with that name. When no listed Unit can start it from chat, say so plainly. Never narrate doing the work yourself, and never claim anything succeeded, landed, was created, sent, or completed unless it's drawn from the real snapshot or this conversation's own messages.";

// `unit` undefined reads across every Unit -- ENIG's view, which owns no
// single Unit's log.
async function recentActivitySnapshot(env: Env, unit: Unit | undefined): Promise<string> {
  try {
    const entries = await queryDataSource(
      env,
      env.ACTIVITY_LOG_DATA_SOURCE_ID,
      systemContext(),
      unit ? { property: "Area", rich_text: { equals: unit } } : undefined,
      { pageSize: 15, sortByCreatedDescending: true },
    );
    if (entries.length === 0) return `(no Activity & Decision Log entries found${unit ? " for this Unit" : ""} yet)`;
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

// ENIG's own baseline description of what it does -- not client-confidential
// or in any way sensitive (it's the business's own public positioning), and
// true regardless of Unit. Included in every persona below so a Unit with
// no Activity Log history yet (most of them) can still correctly answer
// "what does the business do" from its own system prompt instead of having
// nothing to draw on but its own name -- the Evidence Rule still governs
// everything beyond this baseline (specific clients, past work, financials,
// anything not actually in the snapshot or conversation).
const CONSULTANCY_DESCRIPTION =
  "We are ENIG, a diagnose-first positioning/communications consultancy: we diagnose a client's underlying situation before prescribing an intervention, rather than selling a predetermined service. You are staff here, not an outside observer describing the business -- speak as \"we\"/\"our\" (e.g. \"we diagnose the situation first\"), never as \"they\"/\"the consultancy\" in the third person.";

const UNIT_PERSONAS: Record<Unit, string> = {
  Sales:
    `You are ENIG's Sales staff AI, operating under Martin's authority. ${CONSULTANCY_DESCRIPTION} Outside of the structured enquiry workflow, chat naturally and helpfully about sales, leads, and client relationships. You are staff, not the final authority — never claim a business decision (pricing, commitments, client fit) has been made; that's Martin's call to make.`,
  Marketing:
    `You are ENIG's Marketing staff AI, operating under Martin's authority. ${CONSULTANCY_DESCRIPTION} Outside of the structured intake workflow, chat naturally and helpfully about marketing strategy, content, brand, and digital questions. You are staff, not the final authority — never claim a business decision has been made; that's Martin's call to make.`,
  "Business Development":
    `You are ENIG's Business Development staff AI. ${CONSULTANCY_DESCRIPTION} Outside of this Unit's structured workflows, discuss partnerships, growth channels, and business-development questions naturally. You are staff, not the final authority — Martin decides.`,
  Finance:
    `You are ENIG's Finance staff AI (Financial Planning & Control). ${CONSULTANCY_DESCRIPTION} Outside of the structured value-based pricing workflow, chat naturally about financial questions, budgeting, and planning. You are staff, not the final authority — never claim a financial decision has been made; that's Martin's call. Pricing work starts from a Handoff or from Martin's own request naming an existing Matter token, never from this conversation alone.`,
  Strategy:
    `You are ENIG's Strategy staff AI. ${CONSULTANCY_DESCRIPTION} Outside of this Unit's structured diagnosis workflow, discuss strategy, positioning, and business direction questions naturally and helpfully. You are staff, not the final authority — Martin decides.`,
  "Creative & Design":
    `You are ENIG's Creative & Design staff AI. ${CONSULTANCY_DESCRIPTION} This Unit's structured Hats aren't built yet in this system, but you can still discuss creative direction, design questions, and brand ideas naturally. You are staff, not the final authority — Martin decides.`,
  Operations:
    `You are ENIG's Operations staff AI. ${CONSULTANCY_DESCRIPTION} This Unit's structured Hats aren't built yet in this system, but you can still discuss operational questions, process, and delivery logistics naturally. You are staff, not the final authority — Martin decides.`,
};

function historyKey(chatId: number, threadId?: number): string {
  return `chat_history:${chatId}:${threadId ?? "dm"}`;
}

export async function getChatHistory(env: Env, chatId: number, threadId?: number): Promise<ChatTurn[]> {
  const raw = await kvGet(env, historyKey(chatId, threadId));
  return raw ? JSON.parse(raw) : [];
}

async function appendChatHistory(env: Env, chatId: number, threadId: number | undefined, turns: ChatTurn[]): Promise<void> {
  const existing = await getChatHistory(env, chatId, threadId);
  const updated = [...existing, ...turns].slice(-MAX_HISTORY_TURNS);
  await kvPut(env, historyKey(chatId, threadId), JSON.stringify(updated));
}

async function runChatTurn(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  promptParts: Pick<GeneratePromptParts, "persona" | "behavior" | "skillContent" | "context">,
  userMessage: string,
  sensitivity: SensitivityLevel | undefined,
): Promise<string> {
  const history = await getChatHistory(env, chatId, threadId);
  const reply = await generate(env, {
    taskId: "chat.general_reply",
    mode: "text",
    parts: { ...promptParts, situation: userMessage },
    history,
    maxTokens: 800,
    sensitivity,
  });
  await appendChatHistory(env, chatId, threadId, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply || "(no response)" },
  ]);
  return reply;
}

/**
 * Free-form conversation for a Unit's topic, with rolling memory — used
 * whenever a message isn't a structured work-item reply or a new Sales
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
  // Universal live status: a slow reply shows what it is reading and doing; the status is removed once the reply is ready.
  return withLiveStatus(env, { chatId, threadId, header: `${unit} chat` }, () => generalChatReplyInner(env, unit, chatId, threadId, userMessage));
}

async function generalChatReplyInner(
  env: Env,
  unit: Unit,
  chatId: number,
  threadId: number | undefined,
  userMessage: string,
): Promise<string> {
  const snapshot = await recentActivitySnapshot(env, unit);
  const parts = {
    persona: buildStructureFacts(),
    behavior: UNIT_PERSONAS[unit],
    skillContent: EVIDENCE_RULE,
    context: [HOW_WORK_STARTS_RULE, `Recent Activity & Decision Log entries for ${unit}:\n${snapshot}`].join("\n\n"),
  };
  return runChatTurn(env, chatId, threadId, parts, userMessage, chatSensitivityForUnit(unit));
}

/**
 * Shown instead of a reply when ENIG's canonical definition cannot be read.
 * ENIG has no hard-coded fallback persona: answering without its approved
 * definition would be answering as a role nobody approved.
 */
export const ENIG_UNAVAILABLE_MESSAGE =
  "ENIG couldn't read its definition page in Notion (Operations — ENIG) just now, so it isn't answering without it. Nothing was started. Please try again shortly, or check that the page still exists.";

/**
 * ENIG -- the Operations Hat (Chief of Staff) Martin talks to when a
 * message addresses no Unit: routeIncomingText's Chat-mode fallback once no
 * Unit/Hat was addressed. Built on the SCRIBE split recorded on its Notion
 * definition: Role, Instruction, Behaviour and End result come live from
 * that page (plus the Universal Role Contract every Hat inherits);
 * Situation is Martin's message; Context is assembled here from the
 * sources the definition names -- the token-safe business snapshot, the
 * cross-Unit Activity & Decision Log, the Unit/Hat structure, and the
 * conversation history runChatTurn carries.
 *
 * Fails closed: if either governance page is unreadable, no AI call is
 * made and Martin is told so. ENIG declares no Actions and starts nothing;
 * work starts only through router.ts's existing addressed-Unit dispatch.
 */
export async function enigChatReply(env: Env, chatId: number, threadId: number | undefined, userMessage: string): Promise<EnigChatReply> {
  const reply = await runEnigTurn(env, chatId, threadId, userMessage, suggestionInstruction());
  if (reply === null) return { text: ENIG_UNAVAILABLE_MESSAGE };
  // ENIG suggests, Martin confirms: a validated SUGGEST line becomes a
  // Yes/No button (src/enigSuggestion.ts); anything else is dropped.
  const parsed = parseEnigReply(reply);
  if (!parsed.addressee) return { text: parsed.text };
  const buttons = await offerEnigSuggestion(env, chatId, threadId, userMessage, parsed.addressee);
  return { text: parsed.text, buttons };
}

export interface EnigChatReply {
  /** What Martin sees; empty when no provider answered. */
  text: string;
  /** A Yes/No suggestion button row, when ENIG proposed an owning Unit/Hat. */
  buttons?: InlineButton[][];
}

/**
 * One ENIG turn for `situation` in this chat/thread, recorded in that
 * thread's rolling history like any other turn. Returns null -- with no AI
 * call made -- when either governance page is unreadable, so each caller
 * decides how to say so (enigChatReply replies with
 * ENIG_UNAVAILABLE_MESSAGE; the morning brief reports to Operations). An
 * empty string means the provider produced nothing, exactly as
 * runChatTurn reports it.
 */
export async function runEnigTurn(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  situation: string,
  extraInstruction?: string,
): Promise<string | null> {
  // Universal live status for every ENIG turn (conversation and morning brief); removed once the turn has its answer.
  return withLiveStatus(env, { chatId, threadId, header: "ENIG" }, () => runEnigTurnInner(env, chatId, threadId, situation, extraInstruction));
}

async function runEnigTurnInner(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  situation: string,
  extraInstruction?: string,
): Promise<string | null> {
  const [hatDefinition, universalRoleContract] = await Promise.all([
    getGovernance(env, ENIG_HAT_DEFINITION_PAGE_ID, "Operations — ENIG Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);
  if (!hatDefinition || !universalRoleContract) return null;

  const [snapshot, activity] = await Promise.all([businessSnapshot(env), recentActivitySnapshot(env, undefined)]);
  const parts = {
    persona: `You are ENIG. Your Hat Definition follows; act exactly within it.\n\n${hatDefinition}`,
    behavior: universalRoleContract,
    skillContent: [buildStructureFacts(), HOW_WORK_STARTS_RULE, extraInstruction].filter(Boolean).join("\n\n"),
    context: [snapshot, `Recent Activity & Decision Log entries (all Units):\n${activity}`].join("\n\n"),
  };
  return runChatTurn(env, chatId, threadId, parts, situation, "business_sensitive");
}
