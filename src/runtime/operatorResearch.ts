import type { Env, WorkState } from "../types";
import { aiJson } from "../ai";
import { sendMessage, type InlineButton } from "../telegram";
import { redactIdentityTerms } from "../ai/identityRedaction";
import { createPage, appendTextBlocks, title, select } from "../notion";
import { operatorResearchContext } from "../access";
import { scrubResearchQuestion } from "./webResearch";
import { summarizeResearchSynthesis } from "./actionResearch";
import type { PendingResearch, ResearchSynthesis } from "./research/types";

/**
 * Martin-started research (Build Decision, 15 Nov 2026): /research runs the
 * light_search Skill and /deep_research the deep_research Skill. It is Martin
 * operating the SHARED Research Runtime directly -- owned by no Unit or Hat
 * ("shared features are pointed to by Hats, never owned by them"), so the
 * Work carries no Unit, Hat or Action and runs under the bounded
 * operator_research Access context (public web search and page reads, and the
 * Research database; nothing else).
 *
 * The flow: what to research -> clarifying questions one at a time (Skip /
 * That's enough) -> a research brief (Start / Edit: change one line, or start
 * over) -> research in the Work's
 * background alarm (pauses and resumes exactly as BD-19) -> a findings card
 * plus a page in the Research database, with "Go deeper" on a light result.
 *
 * A topic or answer that names a specific person or organisation is never
 * rewritten: Martin is asked to rephrase it.
 */

export type OperatorResearchMode = "light_search" | "deep_research";

export interface OperatorResearchState {
  mode: OperatorResearchMode;
  phase: "topic" | "questions" | "brief" | "editing" | "researching" | "done";
  topic?: string;
  /** Martin's answers so far; `answer: null` is a skipped question. */
  answers: Array<{ question: string; answer: string | null }>;
  /** The question currently waiting for an answer. */
  current?: string;
  /** While `phase` is "editing": the brief line being corrected -- the topic, or an index into `answers`. */
  editing?: "topic" | number;
  /** Spelling fixes the AI suggested for the brief on screen; applied only when Martin taps "Fix typos". */
  typos?: TypoFix[];
  /** The Research database page of the last completed run, when saved. */
  notionUrl?: string;
}

/** The callback prefix for this flow's buttons: `oresearch:<workId>:<skip|enough|start|fixtypos|edit|edit_topic|edit_<n>|restart|deeper>`. */
export const OPERATOR_RESEARCH_CALLBACK = "oresearch";
/** The awaiting state a research Work waits in for Martin's typed reply. */
export const OPERATOR_RESEARCH_AWAITING = "operator_research_reply";

export const MAX_BRIEF_QUESTIONS: Record<OperatorResearchMode, number> = { light_search: 2, deep_research: 5 };

/** Used when the AI cannot write a question (Martin's decision: AI-written, with these fallbacks). */
export const FALLBACK_BRIEF_QUESTIONS = [
  "What is this research for -- a post, a proposal, a strategy decision, something else?",
  "Which market or region should it focus on?",
  "Which kind of business is it about? Any size or sector?",
  "What time period matters -- recent only, or a longer trend?",
  "Is there anything you already know, or want left out?",
];

export const COMMAND_MODES: Record<string, OperatorResearchMode> = { "/research": "light_search", "/deep_research": "deep_research" };

/** `/research [topic]` or `/deep_research [topic]` -> the mode and any topic given inline; null for anything else. */
export function parseResearchCommand(text: string): { mode: OperatorResearchMode; topic: string } | null {
  const match = text.trim().match(/^(\/research|\/deep_research)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { mode: COMMAND_MODES[match[1].toLowerCase()], topic: (match[2] ?? "").trim() };
}

const MODE_LABEL: Record<OperatorResearchMode, string> = { light_search: "Research", deep_research: "Deep research" };
const MAX_TEXT = 500;

export interface OperatorResearchDeps {
  send: (env: Env, state: WorkState, text: string, buttons?: InlineButton[][]) => Promise<void>;
  /** The next clarifying question, or null when the AI gave no usable answer. */
  nextQuestion: (env: Env, research: OperatorResearchState) => Promise<BriefQuestionAnswer | null>;
  saveToNotion: (env: Env, state: WorkState, synthesis: ResearchSynthesis) => Promise<string | null>;
}

export interface BriefQuestionAnswer {
  names_party?: boolean;
  enough?: boolean;
  /** Likely spelling mistakes in the topic or Martin's answers -- a suggestion, never applied by itself. */
  typos?: unknown;
  question?: string | null;
}

/**
 * The deterministic identity check: record tokens, emails, phone numbers and
 * links, and ENIG's or Martin's own name. Returns a reason, or null when clean.
 */
export function identityProblem(text: string): string | null {
  const trimmed = text.trim();
  if (scrubResearchQuestion(trimmed) !== trimmed.replace(/\s+/g, " ")) return "it contains a record token, email, phone number or link";
  if (redactIdentityTerms(trimmed) !== trimmed) return "it names ENIG or you";
  return null;
}

export interface TypoFix {
  wrong: string;
  right: string;
}

const MAX_TYPOS = 3;
const MAX_TYPO_LENGTH = 40;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `wrong` as a whole word (never part of a longer word), every occurrence. */
function wholeWord(wrong: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(wrong)}(?![\\p{L}\\p{N}])`, "gu");
}

function applyTypos(text: string, typos: TypoFix[]): string {
  return typos.reduce((t, fix) => t.replace(wholeWord(fix.wrong), fix.right), text);
}

/**
 * The AI's typo suggestions, kept only when each one is a small spelling fix
 * to words Martin actually typed (the topic or his answers, never the
 * questions) and the corrected text still passes the identity check. AI output
 * is a suggestion: anything malformed is dropped, never repaired.
 */
export function validTypos(research: OperatorResearchState, raw: unknown): TypoFix[] {
  if (!Array.isArray(raw)) return [];
  const typed = [research.topic ?? "", ...research.answers.map((qa) => qa.answer ?? "")];
  const fixes: TypoFix[] = [];
  for (const item of raw) {
    if (fixes.length >= MAX_TYPOS) break;
    const wrong = typeof item?.wrong === "string" ? item.wrong.trim() : "";
    const right = typeof item?.right === "string" ? item.right.trim() : "";
    if (!wrong || !right || wrong === right || wrong.length > MAX_TYPO_LENGTH || right.length > MAX_TYPO_LENGTH) continue;
    if (fixes.some((f) => f.wrong === wrong)) continue;
    if (!typed.some((t) => wholeWord(wrong).test(t))) continue;
    const candidate = [...fixes, { wrong, right }];
    if (typed.some((t) => t && identityProblem(applyTypos(t, candidate)))) continue;
    fixes.push({ wrong, right });
  }
  return fixes;
}

export function briefText(research: OperatorResearchState): string {
  const lines = [`Topic: ${research.topic ?? ""}`];
  for (const qa of research.answers) if (qa.answer) lines.push(`- ${qa.question} ${qa.answer}`);
  return lines.join("\n");
}

/** What the Research Runtime is given: the topic as the question, Martin's answers as its supplied context. */
export function pendingFor(research: OperatorResearchState): PendingResearch {
  const context = research.answers.filter((qa) => qa.answer).map((qa) => `${qa.question} ${qa.answer}`).join("\n");
  return { question: research.topic ?? "", mode: research.mode, ...(context ? { context: `Martin's research brief:\n${context}` } : {}) };
}

function buttons(workId: string, values: Array<[string, string]>): InlineButton[][] {
  return [values.map(([text, value]) => ({ text, callback_data: `${OPERATOR_RESEARCH_CALLBACK}:${workId}:${value}` }))];
}

/** Starts the flow on a new research Work. A topic given with the command skips the first question. */
export async function beginOperatorResearch(env: Env, state: WorkState, mode: OperatorResearchMode, topic: string, deps: OperatorResearchDeps): Promise<WorkState> {
  state.operatorResearch = { mode, phase: "topic", answers: [] };
  state.stage = "research_brief";
  state.awaiting = OPERATOR_RESEARCH_AWAITING;
  if (topic.trim()) return acceptTopic(env, state, topic, deps);
  await deps.send(env, state, `${mode === "deep_research" ? "🔬" : "🔎"} What do you want to research?`);
  return state;
}

/** Martin's typed reply on a research Work. */
export async function handleOperatorResearchReply(env: Env, state: WorkState, text: string, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch;
  if (!research) return state;
  if (research.phase === "topic") return acceptTopic(env, state, text, deps);
  if (research.phase === "questions" && research.current) {
    const problem = identityProblem(text);
    if (problem) {
      await deps.send(env, state, `Please rephrase that answer -- ${problem}. Describe the kind of business or person instead of naming them.`);
      return state;
    }
    research.answers.push({ question: research.current, answer: text.trim().slice(0, MAX_TEXT) });
    research.current = undefined;
    return askNext(env, state, deps);
  }
  if (research.phase === "editing" && research.editing !== undefined) return acceptCorrection(env, state, text, deps);
  await deps.send(env, state, "Tap Start to begin, or Edit to change something.");
  return state;
}

/** The brief lines Martin can correct: the topic, and each question he answered (a skipped one is not in the brief). */
function editableLines(research: OperatorResearchState): Array<{ label: string; value: string; text: string }> {
  const lines = [{ label: "Topic", value: "edit_topic", text: `Topic: ${research.topic ?? ""}` }];
  let n = 0;
  research.answers.forEach((qa, i) => {
    if (qa.answer) lines.push({ label: `Answer ${++n}`, value: `edit_${i}`, text: `Answer ${n}: ${qa.question} ${qa.answer}` });
  });
  return lines;
}

async function askWhatToChange(env: Env, state: WorkState, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  research.phase = "brief";
  research.editing = undefined;
  const lines = editableLines(research);
  await deps.send(
    env,
    state,
    `✏️ What would you like to change?\n\n${lines.map((l) => l.text).join("\n")}`,
    [lines.map((l) => ({ text: l.label, callback_data: `${OPERATOR_RESEARCH_CALLBACK}:${state.workId}:${l.value}` })), ...buttons(state.workId, [["🔁 Start over", "restart"]])],
  );
  return state;
}

async function pickLine(env: Env, state: WorkState, value: string, deps: OperatorResearchDeps): Promise<WorkState | null> {
  const research = state.operatorResearch!;
  if (value === "edit_topic") {
    research.phase = "editing";
    research.editing = "topic";
    await deps.send(env, state, `Send the corrected topic.\n\nNow: ${research.topic ?? ""}`);
    return state;
  }
  const index = Number(value.slice("edit_".length));
  const qa = Number.isInteger(index) ? research.answers[index] : undefined;
  if (!qa?.answer) return null;
  research.phase = "editing";
  research.editing = index;
  await deps.send(env, state, `Send the corrected answer to:\n${qa.question}\n\nNow: ${qa.answer}`);
  return state;
}

/**
 * Martin's corrected line: the same checks as when it was first typed -- the
 * deterministic identity check, then the AI's names-a-party flag on that line
 * -- and then the updated brief. A refused correction keeps the old line.
 */
async function acceptCorrection(env: Env, state: WorkState, text: string, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  const editing = research.editing!;
  const value = text.trim().slice(0, MAX_TEXT);
  const problem = editing === "topic" && value.length < 3 ? "it is too short" : identityProblem(value);
  if (problem) {
    await deps.send(env, state, `Please rephrase that -- ${problem}. Describe the kind of business or person instead of naming them.`);
    return state;
  }
  // The AI judges "the topic or the latest answer", so an edited answer is put last for the check.
  const probe: OperatorResearchState =
    editing === "topic"
      ? { ...research, topic: value }
      : { ...research, answers: [...research.answers.filter((_, i) => i !== editing), { question: research.answers[editing].question, answer: value }] };
  const ai = await deps.nextQuestion(env, probe).catch(() => null);
  if (ai?.names_party === true) {
    await deps.send(env, state, "That seems to name a specific person or organisation. Please rephrase it -- describe the kind of business or person instead.");
    return state;
  }
  if (editing === "topic") research.topic = value;
  else research.answers[editing] = { question: research.answers[editing].question, answer: value };
  return showBrief(env, state, deps, ai);
}

async function acceptTopic(env: Env, state: WorkState, text: string, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  const topic = text.trim().slice(0, MAX_TEXT);
  const problem = topic.length < 3 ? "it is too short" : identityProblem(topic);
  if (problem) {
    await deps.send(env, state, `Please rephrase the topic -- ${problem}. Describe the kind of business or person instead of naming them.`);
    return state;
  }
  research.topic = topic;
  research.phase = "questions";
  return askNext(env, state, deps);
}

async function askNext(env: Env, state: WorkState, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  if (research.answers.length >= MAX_BRIEF_QUESTIONS[research.mode]) return showBrief(env, state, deps);
  const asked = new Set(research.answers.map((qa) => qa.question));
  const ai = await deps.nextQuestion(env, research).catch(() => null);
  if (ai?.names_party === true) return refuseNamedParty(env, state, deps);
  if (ai?.enough === true && research.answers.length > 0) return showBrief(env, state, deps, ai);
  const aiQuestion = typeof ai?.question === "string" ? ai.question.trim().slice(0, 300) : "";
  const question = aiQuestion && !asked.has(aiQuestion) && !identityProblem(aiQuestion) ? aiQuestion : FALLBACK_BRIEF_QUESTIONS.find((q) => !asked.has(q));
  if (!question) return showBrief(env, state, deps, ai);
  research.current = question;
  const n = research.answers.length + 1;
  await deps.send(env, state, `Question ${n} of up to ${MAX_BRIEF_QUESTIONS[research.mode]}:\n${question}`, buttons(state.workId, [["Skip", "skip"], ["That's enough, start", "enough"]]));
  return state;
}

/** The last thing Martin typed names a specific person or organisation: drop it and ask again, never rewrite it. */
async function refuseNamedParty(env: Env, state: WorkState, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  research.editing = undefined;
  research.typos = undefined;
  const last = research.answers.pop();
  if (last) {
    research.phase = "questions";
    research.current = last.question;
    await deps.send(env, state, `That answer seems to name a specific person or organisation. Please rephrase it -- describe the kind of business or person instead.\n\n${last.question}`, buttons(state.workId, [["Skip", "skip"], ["That's enough, start", "enough"]]));
  } else {
    research.topic = undefined;
    research.phase = "topic";
    await deps.send(env, state, "That topic seems to name a specific person or organisation. Please rephrase it -- describe the kind of business or person instead.");
  }
  return state;
}

/**
 * Shows the brief. `ai` is the brief_questions reply already in hand for this
 * exact brief; without one, the step is asked once here, so every brief gets
 * the names-a-party flag and typo suggestions (an AI failure shows the brief
 * with neither, as before).
 */
async function showBrief(env: Env, state: WorkState, deps: OperatorResearchDeps, ai?: BriefQuestionAnswer | null): Promise<WorkState> {
  const research = state.operatorResearch!;
  const reply = ai === undefined ? await deps.nextQuestion(env, research).catch(() => null) : ai;
  if (reply?.names_party === true) return refuseNamedParty(env, state, deps);
  research.phase = "brief";
  research.current = undefined;
  research.editing = undefined;
  const typos = validTypos(research, reply?.typos);
  research.typos = typos.length ? typos : undefined;
  const suggestion = typos.length ? `\n\n✍️ Possible typos: ${typos.map((t) => `"${t.wrong}" → "${t.right}"`).join(", ")}` : "";
  const actions: Array<[string, string]> = typos.length ? [["✅ Fix typos", "fixtypos"], ["▶️ Start as is", "start"], ["✏️ Edit", "edit"]] : [["▶️ Start", "start"], ["✏️ Edit", "edit"]];
  await deps.send(env, state, `📋 ${MODE_LABEL[research.mode]} brief\n\n${briefText(research)}${suggestion}`, buttons(state.workId, actions));
  return state;
}

/** Martin accepted the suggested fixes: apply them to his own lines and show the brief again (no new suggestions). */
async function fixTypos(env: Env, state: WorkState, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  const typos = research.typos ?? [];
  if (research.topic) research.topic = applyTypos(research.topic, typos);
  research.answers = research.answers.map((qa) => (qa.answer ? { question: qa.question, answer: applyTypos(qa.answer, typos) } : qa));
  return showBrief(env, state, deps, null);
}

/**
 * Martin's button on a research Work. Returns the job to schedule when one
 * starts (the caller owns the Work's alarm), else null.
 */
export async function handleOperatorResearchButton(env: Env, state: WorkState, value: string, deps: OperatorResearchDeps): Promise<{ state: WorkState; schedule: PendingResearch | null }> {
  const research = state.operatorResearch;
  if (!research) return { state, schedule: null };
  if (value === "skip" && research.phase === "questions" && research.current) {
    research.answers.push({ question: research.current, answer: null });
    research.current = undefined;
    return { state: await askNext(env, state, deps), schedule: null };
  }
  if (value === "enough" && research.phase === "questions") return { state: await showBrief(env, state, deps), schedule: null };
  if (value === "fixtypos" && research.phase === "brief" && research.typos?.length) return { state: await fixTypos(env, state, deps), schedule: null };
  if (value === "edit" && (research.phase === "brief" || research.phase === "editing")) return { state: await askWhatToChange(env, state, deps), schedule: null };
  if (value.startsWith("edit_") && (research.phase === "brief" || research.phase === "editing")) {
    const next = await pickLine(env, state, value, deps);
    if (next) return { state: next, schedule: null };
  }
  if (value === "restart" && (research.phase === "brief" || research.phase === "editing")) {
    state.operatorResearch = { mode: research.mode, phase: "topic", answers: [] };
    state.awaiting = OPERATOR_RESEARCH_AWAITING;
    await deps.send(env, state, "OK -- what do you want to research?");
    return { state, schedule: null };
  }
  if (value === "start" && research.phase === "brief") return start(env, state, research, deps);
  if (value === "deeper" && research.phase === "done" && research.mode === "light_search") {
    research.mode = "deep_research";
    return start(env, state, research, deps);
  }
  await deps.send(env, state, "That button is no longer current -- nothing was changed.");
  return { state, schedule: null };
}

async function start(env: Env, state: WorkState, research: OperatorResearchState, deps: OperatorResearchDeps): Promise<{ state: WorkState; schedule: PendingResearch }> {
  research.phase = "researching";
  state.stage = "researching";
  state.awaiting = undefined;
  await deps.send(
    env,
    state,
    research.mode === "deep_research"
      ? "🔬 Deep research started in the background. It can take several minutes; I'll post the findings here and save them to the Research database."
      : "🔎 Researching now. I'll post the findings here and save them to the Research database.",
  );
  return { state, schedule: pendingFor(research) };
}

/** A completed run: the findings card, and a page in the Research database. */
export async function completeOperatorResearch(env: Env, state: WorkState, synthesis: ResearchSynthesis, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  const url = await deps.saveToNotion(env, state, synthesis).catch((err) => {
    console.error("Research page not saved", err instanceof Error ? err.message : err);
    return null;
  });
  research.phase = "done";
  if (url) research.notionUrl = url;
  state.stage = "complete";
  state.awaiting = undefined;
  const saved = url ? `Saved to the Research database: ${url}` : env.RESEARCH_DATA_SOURCE_ID ? "⚠️ It could not be saved to the Research database -- it is only in this message." : "The Research database is not configured, so this is only in this message.";
  await deps.send(
    env,
    state,
    `✅ ${MODE_LABEL[research.mode]} complete: ${research.topic}\n\n${summarizeResearchSynthesis(synthesis, 3200)}\n\n${saved}`,
    research.mode === "light_search" ? buttons(state.workId, [["🔬 Go deeper", "deeper"]]) : undefined,
  );
  return state;
}

/** A run that could not complete (blocked by the runtime): visibly incomplete, never presented as findings. */
export async function failOperatorResearch(env: Env, state: WorkState, reason: string, deps: OperatorResearchDeps): Promise<WorkState> {
  const research = state.operatorResearch!;
  research.phase = "done";
  state.stage = "research_incomplete";
  state.awaiting = undefined;
  await deps.send(env, state, `${MODE_LABEL[research.mode]} could not be completed: ${reason}`);
  return state;
}

// ---------------------------------------------------------------------------
// Production dependencies
// ---------------------------------------------------------------------------

export const BRIEF_QUESTION_INSTRUCTIONS = [
  "You help prepare a public web research brief. You never research and never answer the research question yourself.",
  "You are given the research topic and the clarifying questions already answered (or skipped).",
  "First work out what the research is about. The topic is often a description of a kind of business, service, offer or idea rather than a question. Research about such a subject is usually about its market and context -- who needs or buys it, how much demand there is, what alternatives and competitors exist, what people pay, what is changing -- not about the subject's own clients or operations. Never treat the topic as a business you are interviewing, and never assume the person asking already knows the answers you would research.",
  "Ask about what the person wants to find out and for what, not about the subject's details: the question to answer or decision it serves, who the buyers or audience are, which market or region, which time period, and what to leave out.",
  "If the topic is a description with no clear question, the first question asks what they want to find out about it (for example demand, competitors, pricing or buyer needs).",
  "Build on the answers so far: ask about something not yet covered. Never ask a question that only narrows the wording of the previous answer (an answer \"Branding\" does not lead to \"which businesses within the branding sector\").",
  "Write the ONE next clarifying question that would most improve the research: short, plain, one thing at a time. Never repeat a question already asked.",
  'If the answers already make the research clear, set "enough": true.',
  'If the topic or the latest answer names a specific person, or a specific company or organisation by name, set "names_party": true.',
  'List likely spelling mistakes in the topic and the answers (never in the questions) as "typos": [{"wrong": "<the word exactly as written>", "right": "<its correct spelling>"}] -- spelling only: never rephrase, never change meaning, never "correct" a name or a local word you do not know; [] when there are none.',
  'Reply ONLY with JSON: {"names_party": false, "enough": false, "question": "<one short question>", "typos": []}.',
].join("\n");

async function aiNextQuestion(env: Env, research: OperatorResearchState): Promise<BriefQuestionAnswer | null> {
  const asked = research.answers.map((qa) => `Q: ${qa.question}\nA: ${qa.answer ?? "(skipped)"}`).join("\n");
  return aiJson<BriefQuestionAnswer>(env, {
    taskId: "research.brief_questions",
    system: BRIEF_QUESTION_INSTRUCTIONS,
    user: `Topic: ${research.topic}\n${asked ? `Answered so far:\n${asked}` : "No questions asked yet."}`,
    light: true,
    maxTokens: 300,
    sensitivity: "business_sensitive",
  });
}

function sourcesText(synthesis: ResearchSynthesis): string {
  return synthesis.sources.map((s) => `- ${s.source}${s.url ? ` -- ${s.url}` : ""}${s.claimSupported ? ` (supports: ${s.claimSupported})` : ""}`).join("\n") || "No sources.";
}

async function saveResearchPage(env: Env, state: WorkState, synthesis: ResearchSynthesis): Promise<string | null> {
  const dataSourceId = env.RESEARCH_DATA_SOURCE_ID;
  if (!dataSourceId) return null;
  const research = state.operatorResearch!;
  const access = operatorResearchContext(String(state.workId));
  const page = await createPage(
    env,
    dataSourceId,
    {
      Topic: title((research.topic ?? "Research").slice(0, 200)),
      Mode: select(research.mode === "deep_research" ? "Deep" : "Light"),
      Status: select("Complete"),
      Date: { date: { start: new Date().toISOString().slice(0, 10) } },
    },
    access,
  );
  await appendTextBlocks(env, page.id, "Research brief", briefText(research), access);
  await appendTextBlocks(env, page.id, "Findings", summarizeResearchSynthesis(synthesis, 20000), access);
  await appendTextBlocks(env, page.id, "Sources", sourcesText(synthesis), access);
  return page.url ?? null;
}

export const DEFAULT_OPERATOR_RESEARCH_DEPS: OperatorResearchDeps = {
  send: (env, state, text, b) => sendMessage(env, state.chatId, text, b, state.threadId).then(() => undefined),
  nextQuestion: aiNextQuestion,
  saveToNotion: saveResearchPage,
};
