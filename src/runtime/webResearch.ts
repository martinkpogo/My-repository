import type { Env } from "../types";
import type { AiTask } from "../ai/types";
import type { SemanticTaskId, SensitivityLevel, ContextSegment } from "../dataBoundary/types";
import { PRODUCTION_TASK_SENSITIVITY } from "../dataBoundary/policy";
import { setTaskAugmenter } from "../ai/policy";
import { aiJson } from "../ai";
import { executeResearch } from "./research/executor";
import { summarizeResearchSynthesis } from "./actionResearch";
import { resolveRuntimeSkill } from "./actionSkills";
import { currentRun } from "./liveStatus";
import { kvGet } from "../kvStore";
import { RUN_EXTENSION, DAILY_EXTENSION, readDaily, writeDaily, runGaps } from "./webLookupAllowance";
import { systemContext, type AccessContext } from "../access";

/**
 * Universal web research (Martin's decision, 2026-11-11; supersedes the
 * 2026-10-12 rule that an Action had to declare the research_signal Skill
 * to use research). Web research is a Runtime tool every Hat and every Work
 * can use:
 *
 *   - Before a Hat's OUTPUT step (WEB_RESEARCH_TASKS) the AI decides, with
 *     one light check (runtime.research_need), whether public web research
 *     would materially help, and the question to research.
 *   - If so, the existing research engine (src/runtime/research/executor.ts:
 *     plan, search, source-checked synthesis) runs it, with the
 *     research_signal methodology supplied here by the Runtime, and its
 *     source-cited findings -- and what it could NOT establish -- are added
 *     to that step's prompt, labelled as external context, never client
 *     evidence.
 *
 * Guardrails:
 *   - Identity never leaves: the question is stripped of record tokens,
 *     emails and phone numbers, and the research engine's own safe-context
 *     and identity rules apply unchanged.
 *   - The check is held to the CALLING step's sensitivity (every segment is
 *     stamped with it), so it can never reach a provider the calling step
 *     could not.
 *   - Read-only: nothing is posted, sent or written except the optional
 *     "Research more" card to Martin.
 *   - Ceilings: RUN_LIMIT lookups per run and DAILY_LIMIT per day. At a
 *     ceiling the search reports the limit (never silently stops), the run
 *     ends with a card: 🔎 Research more (+RUN_EXTENSION, gaps only) or
 *     ✅ That's enough; at the daily ceiling, "Allow 50 more today".
 *   - Not for steps whose rules bind them to supplied evidence only:
 *     classification/routing, extraction, qualification, Finance pricing,
 *     Result verification, and the research engine's own steps.
 * Fails open: any failure here only means the step runs without findings.
 */

/** The Hat output steps that may use web research. Everything else never does. */
export const WEB_RESEARCH_TASKS: ReadonlySet<SemanticTaskId> = new Set<SemanticTaskId>([
  "chat.general_reply",
  "marketing.hat_action_decision",
  "sales.call_prep_briefing",
  "sales.proposal_drafting",
  "sales.proposal_revision",
  "strategy.diagnosis",
  "strategy.proposal_drafting",
  "strategy.proposal_discussion",
  "strategy.business_diagnosis",
  "strategy.brand_diagnosis",
  "strategy.communication_diagnosis",
  "strategy.specialist_synthesis",
  "business_development.assess_opportunity",
  "business_development.develop_opportunity",
  "business_development.determine_next_move",
  "business_development.assess_partnership",
  "business_development.develop_partnership",
  "business_development.assess_market_opportunity",
  "business_development.develop_growth_opportunity",
]);

const SENSITIVITY_ORDER: SensitivityLevel[] = ["public", "public_sourced", "internal", "business_sensitive", "client_confidential", "pii_restricted"];
const CHECK_INPUT_LIMIT = 6000;

function highest(levels: (SensitivityLevel | undefined)[]): SensitivityLevel | undefined {
  let best: SensitivityLevel | undefined;
  for (const l of levels) if (l && (!best || SENSITIVITY_ORDER.indexOf(l) > SENSITIVITY_ORDER.indexOf(best))) best = l;
  return best;
}

/** Removes anything identifying from a research question: record tokens, emails, phone numbers, URLs. */
export function scrubResearchQuestion(question: string): string {
  return question
    .replace(/\b(ENT|MAT|HO|HND|PROP|PRP|PAY|CN|RES|LEAD|CSA|LOG)-[A-Za-z0-9-]+\b/gi, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface ResearchNeed {
  needs_web?: boolean;
  question?: string;
}

function stepText(task: AiTask): string {
  return task.messages
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join("\n\n")
    .slice(-CHECK_INPUT_LIMIT);
}

/**
 * The level the check is held to: the calling step's EFFECTIVE level -- each
 * segment's own stamp where it has one, else the step's task level, exactly
 * as the Data Boundary evaluates that step -- taking the highest.
 */
export function callerSensitivity(task: AiTask): SensitivityLevel | undefined {
  const taskLevel = PRODUCTION_TASK_SENSITIVITY[task.taskId] ?? task.boundaryContext.taskSensitivity;
  const levels = task.boundaryContext.segments.map((s) => s.sensitivity ?? taskLevel);
  return highest(levels.length ? levels : [taskLevel]);
}

async function decideResearchNeed(env: Env, task: AiTask): Promise<string | null> {
  const level = callerSensitivity(task);
  if (!level) return null; // unresolved: never guess a level
  const system = [
    "You decide whether a step in ENIG's work needs PUBLIC WEB research before it answers.",
    "Say yes only when current, public, external information (markets, sectors, trends, what businesses commonly struggle with or ask about, public facts about an industry) would materially improve the answer, and it is not already in the step's own context.",
    "Say no for questions about ENIG's own records, approvals, people, or anything the step's context already answers.",
    "The research question must be general and identity-free: never a client's name, record token (ENT-/MAT-/HO-...), contact, email, phone, or anything identifying.",
    'Reply ONLY with JSON: {"needs_web": true, "question": "<one general research question>"} or {"needs_web": false}.',
  ].join("\n");
  const user = stepText(task);
  const result = await aiJson<ResearchNeed>(env, {
    taskId: "runtime.research_need",
    system,
    user,
    light: true,
    maxTokens: 200,
    // Held to the calling step's own level (approved rule, 2026-11-11).
    sensitivity: level,
  });
  if (!result || result.needs_web !== true || typeof result.question !== "string") return null;
  const question = scrubResearchQuestion(result.question);
  return question.length >= 8 ? question : null;
}

function findingsBlock(question: string, digest: string): string {
  return [
    "=== WEB RESEARCH (public sources, gathered just now) ===",
    `Question researched: ${question}`,
    digest,
    "How to use this: external context only. It is NOT evidence about any client, Matter or ENIG record -- never state it as a client fact, never base a client finding on it alone, and name the source when you use a finding. What it could not establish stays open; never fill it in.",
    "=== END WEB RESEARCH ===",
  ].join("\n");
}

/** Runs one research question through the existing engine with the Runtime's research_signal methodology. */
export async function researchOnline(env: Env, question: string, access: AccessContext): Promise<{ digest: string; gaps: string[] } | null> {
  const methodology = resolveRuntimeSkill("research_signal").content;
  const outcome = await executeResearch(env, { question, context: "", skillContent: methodology }, access);
  if (outcome.status !== "completed") return null;
  return { digest: summarizeResearchSynthesis(outcome.synthesis), gaps: outcome.synthesis.limitations.map((l) => l.statement) };
}

/** The augmenter installed on the shared AI executor. Never throws past the executor's own guard. */
export interface WebResearchDeps {
  decide: (env: Env, task: AiTask) => Promise<string | null>;
  research: (env: Env, question: string, access: AccessContext) => Promise<{ digest: string; gaps: string[] } | null>;
}
const DEFAULT_DEPS: WebResearchDeps = { decide: decideResearchNeed, research: researchOnline };

/**
 * One web check and at most one research run per run: a run's later Hat
 * steps (a Strategy pickup makes several) reuse the same findings instead
 * of each deciding and researching again -- every research run costs
 * several AI calls on top of its searches, inside the run's one subrequest
 * budget (HO-86, 2026-10-08). Going further is Martin's "Research more".
 */
const runResearch = new WeakMap<object, Promise<string | null>>();

export async function augmentTaskWithWebResearch(env: Env, task: AiTask, deps: WebResearchDeps = DEFAULT_DEPS): Promise<AiTask> {
  if (!WEB_RESEARCH_TASKS.has(task.taskId)) return task;
  const run = currentRun();
  if (!run?.access) return task; // research needs the run's own Access context
  const access = run.access;
  let pending = runResearch.get(run);
  if (!pending) {
    pending = (async () => {
      const decided = await deps.decide(env, task);
      const question = decided ? scrubResearchQuestion(decided) : null;
      if (!question || question.length < 8) return null;
      const found = await deps.research(env, question, access);
      if (!found) return null;
      const info = runGaps.get(run) ?? { question, gaps: [] };
      info.question = question;
      info.gaps = found.gaps;
      runGaps.set(run, info);
      return findingsBlock(question, found.digest);
    })();
    runResearch.set(run, pending);
  }
  const block = await pending;
  if (!block) return task;
  const segment: ContextSegment = { type: "system", content: block, provenance: "runtime:web_research", sensitivity: "public_sourced" };
  const messages = [...task.messages];
  const i = messages.findIndex((m) => m.role === "system");
  if (i >= 0) messages[i] = { ...messages[i], content: `${messages[i].content}\n\n${block}` };
  else messages.unshift({ role: "system", content: block });
  return { ...task, messages, boundaryContext: { ...task.boundaryContext, segments: [...task.boundaryContext.segments, segment] } };
}

/**
 * Martin's tap on the limit card. "more": research the gaps only, with a
 * fresh RUN_EXTENSION allowance, and post the findings. "allow": raise
 * today's ceiling by DAILY_EXTENSION. "done": nothing.
 */
export async function handleWebResearchCallback(env: Env, id: string, value: string, chatId: number, threadId: number | undefined): Promise<string> {
  const raw = await kvGet(env, `web_research_card:${id}`);
  if (!raw) return "That research card has expired. Ask again to start a new search.";
  if (value === "done") return "OK, no more research on that.";
  if (value === "allow") {
    const daily = await readDaily(env);
    await writeDaily(env, { used: daily.used, limit: daily.limit + DAILY_EXTENSION });
    return `Allowed ${DAILY_EXTENSION} more web searches today (limit now ${daily.limit + DAILY_EXTENSION}). Ask again or tap Research more.`;
  }
  const card = JSON.parse(raw) as { question: string; gaps: string[] };
  const focus = card.gaps.length ? `${card.question} -- specifically: ${card.gaps.slice(0, 5).join("; ")}` : card.question;
  const question = scrubResearchQuestion(focus);
  const { withLiveStatus } = await import("./liveStatus");
  const found = await withLiveStatus(
    env,
    { chatId, threadId, header: "Web research — more" },
    async () => {
      const run = currentRun();
      if (run) run.searchLimit = RUN_EXTENSION;
      return researchOnline(env, question, systemContext());
    },
    () => "succeeded",
    undefined,
    { access: systemContext() },
  );
  return found ? `🔎 More research on: ${question}\n\n${found.digest}` : "The extra research could not be completed (no usable sources). Nothing else was changed.";
}

setTaskAugmenter((env, task) => augmentTaskWithWebResearch(env, task));
