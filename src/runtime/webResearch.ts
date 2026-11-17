import type { Env } from "../types";
import type { AiTask } from "../ai/types";
import type { SemanticTaskId, SensitivityLevel, ContextSegment } from "../dataBoundary/types";
import { PRODUCTION_TASK_SENSITIVITY } from "../dataBoundary/policy";
import { setTaskAugmenter } from "../ai/policy";
import { aiJson } from "../ai";
import { runResearchSkill } from "./research/researchRuntime";
import { summarizeResearchSynthesis } from "./actionResearch";
import { resolveRuntimeSkill } from "./actionSkills";
import { currentRun, reportLiveStep, resolveLiveStep } from "./liveStatus";
import { kvGet, kvPut } from "../kvStore";
import { hashContent } from "../contentHash";
import { RUN_EXTENSION, DAILY_EXTENSION, readDaily, writeDaily, runGaps, noteResearchInterrupted, researchPausedInRun, noteDeepResearchProposal, type DeepResearchProposal } from "./webLookupAllowance";
export { deepResearchProposalInRun, researchHeldInRun, type DeepResearchProposal } from "./webLookupAllowance";
import { getResearchCheckpointStore } from "./workPersistence";
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
 *   - If so, the existing research engine (src/runtime/research/researchRuntime.ts:
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
  deep?: unknown;
}

/** The check's decision: the light question, and optionally a deep-research proposal. */
export interface ResearchDecision {
  question: string;
  deep?: DeepResearchProposal;
}

const MAX_PROPOSAL_LINES = 5;
const MAX_PROPOSAL_TEXT = 300;

/**
 * The proposal as the check wrote it, kept only when well-formed and scrubbed
 * of record tokens, emails, phone numbers and links. Malformed parts are
 * dropped, never repaired; the identity check proper runs where the brief is
 * shown (operatorResearch.ts), before Martin sees it.
 */
export function parseDeepProposal(raw: unknown): DeepResearchProposal | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { needed_for?: unknown; topic?: unknown; brief?: unknown };
  const clean = (v: unknown) => (typeof v === "string" ? scrubResearchQuestion(v).slice(0, MAX_PROPOSAL_TEXT) : "");
  const neededFor = clean(r.needed_for);
  const topic = clean(r.topic);
  if (neededFor.length < 8 || topic.length < 8) return undefined;
  const lines: DeepResearchProposal["lines"] = [];
  for (const item of Array.isArray(r.brief) ? r.brief : []) {
    if (lines.length >= MAX_PROPOSAL_LINES) break;
    const question = clean((item as { question?: unknown })?.question);
    const answer = clean((item as { answer?: unknown })?.answer);
    if (question.length >= 3 && answer.length >= 2) lines.push({ question, answer });
  }
  return { neededFor, topic, lines };
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

/**
 * The check's answer limit. Raised from 200 (Martin, 2026-11-13): Groq's
 * model reasons before it answers and the reasoning counts against this
 * limit, so at 200 it returned nothing (0 characters, rejected as
 * malformed) on every run. The answer itself is one short JSON line.
 */
export const RESEARCH_NEED_MAX_TOKENS = 600;

/** The light check's instructions (runtime.research_need). */
export const RESEARCH_NEED_INSTRUCTIONS = [
    "You decide whether a step in ENIG's work needs PUBLIC WEB research before it answers.",
    "Say yes only when current, public, external information (markets, sectors, trends, what businesses commonly struggle with or ask about, public facts about an industry) would materially improve the answer, and it is not already in the step's own context.",
    // Martin, 2026-11-13: a campaign-strategy request was judged "not needed"
    // and the draft was written from general knowledge with no evidence.
    // Substantial work always gets light web research -- automatic, never
    // offered as a choice. Deep research stays a proposal Martin approves.
    "Substantial work -- a campaign, a strategy, a proposal, a diagnosis, a pricing recommendation, or any multi-part plan -- ALWAYS needs light web research: answer {\"needs_web\": true, \"question\": \"<one general research question on the work's subject>\"}. Light research is automatic: never ask Martin whether to research it. Deep research (the \"deep\" field) is only ever proposed, never automatic, and runs only after Martin approves its brief.",
    // Martin, 2026-11-13: with a weaker model answering, a request for market
    // evidence was judged "not needed" and the draft was written from
    // general knowledge.
    "A request that asks you to find, identify or research what businesses or customers need, struggle with, want or do -- or any current market or sector fact -- ALWAYS needs web research, even when you could answer from general knowledge: the point is current, sourced evidence.",
    "Say no for questions about ENIG's own records, approvals, people, or anything the step's context already answers.",
    "The research question must be general and identity-free: never a client's name, record token (ENT-/MAT-/HO-...), contact, email, phone, or anything identifying.",
    // Martin, 2026-11-13: a Marketing request for a problem businesses have
    // was researched as a question about their customers, so the findings
    // never showed the problem. The question must stay on the request's own
    // subject.
    "The research question must stay on the exact subject the request asks about. If it asks what problems or needs a kind of business has, research THOSE businesses' own problems and needs -- not their customers' behaviour or the market in general -- and ask for evidence that would show whether the problem exists.",
    // Martin, 2026-11-16: light research stays automatic; deep research is
    // only PROPOSED, as a brief Martin approves before anything runs.
    'When the step is substantial work -- a campaign, a strategy, a proposal, a market or offer decision -- whose quality depends on evidence one quick search cannot give (several angles, comparisons, buyer behaviour, what has worked elsewhere), ALSO propose Deep Research by adding "deep": {"needed_for": "<what this research will let the step do, one line>", "topic": "<one research question>", "brief": [{"question": "<a clarifying question>", "answer": "<its answer, from this step\'s own context>"}]}. Give 2 to 5 brief lines answered only from the step\'s own context and role -- the purpose or decision it serves, who the buyers or audience are, the market or region, the time period, what to leave out. Every part identity-free, like the question. Leave "deep" out when one quick search is enough.',
    'Reply ONLY with JSON: {"needs_web": true, "question": "<one general research question>"}, optionally with "deep" as above, or {"needs_web": false}.',
].join("\n");

async function decideResearchNeed(env: Env, task: AiTask): Promise<ResearchDecision | null> {
  const level = callerSensitivity(task);
  if (!level) return null; // unresolved: never guess a level
  const system = RESEARCH_NEED_INSTRUCTIONS;
  const user = stepText(task);
  const result = await aiJson<ResearchNeed>(env, {
    taskId: "runtime.research_need",
    system,
    user,
    light: true,
    maxTokens: RESEARCH_NEED_MAX_TOKENS,
    // Held to the calling step's own level (approved rule, 2026-11-11).
    sensitivity: level,
  });
  // Diagnostic only: whether the check answered and what it decided -- never the question or the step's content.
  console.log(`web research check for ${task.taskId}: ${!result ? "no usable answer" : result.needs_web === true ? "research needed" : "not needed"}`);
  if (!result || result.needs_web !== true || typeof result.question !== "string") return null;
  const question = scrubResearchQuestion(result.question);
  if (question.length < 8) return null;
  const deep = parseDeepProposal(result.deep);
  return deep ? { question, deep } : { question };
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
  const cacheKey = await researchCacheKey(question);
  const cached = await readCachedResearch(env, cacheKey);
  if (cached) {
    reportLiveStep(RESEARCH_CACHE_HIT_STEP);
    resolveLiveStep(RESEARCH_CACHE_HIT_STEP, RESEARCH_CACHE_HIT_STEP);
    return cached;
  }
  const methodology = resolveRuntimeSkill("research_signal").content;
  // Inside a Work, research checkpoints through that Work's own durable
  // storage (BD-15), so an interrupted job resumes the next time this Work
  // researches the same question instead of starting again.
  const checkpoints = access.kind === "work_session" ? getResearchCheckpointStore(access.workId) : undefined;
  const outcome = await runResearchSkill(env, { question, context: "", skillContent: methodology, ...(checkpoints ? { checkpoints } : {}) }, access);
  if (outcome.status === "interrupted") {
    // Visibly incomplete: the run's end card says research paused and why,
    // and nothing is handed to the Hat as if research had completed. Inside
    // a Work, the research job itself resumes on the Work's alarm
    // (option B, Martin 15 Nov 2026) -- no Hat step is re-run.
    const scheduled = checkpoints?.scheduleResume
      ? await checkpoints.scheduleResume({ question, mode: "light_search", ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}) }).then(
          () => true,
          (err) => {
            console.error("Research resume not scheduled", err instanceof Error ? err.message : err);
            return false;
          },
        )
      : false;
    noteResearchInterrupted(env, question, { ...outcome, resumesAutomatically: scheduled });
    return null;
  }
  if (outcome.status !== "completed") return null;
  const result = { digest: summarizeResearchSynthesis(outcome.synthesis), gaps: outcome.synthesis.limitations.map((l) => l.statement) };
  await writeCachedResearch(env, cacheKey, result);
  return result;
}

/**
 * Research cache (Martin's decision 2026-11-14, free-tier option C): the
 * same research question within 24 hours reuses its saved findings -- no
 * AI calls, no searches, nothing counted against the limits. Only a
 * completed research run is saved. The key is a SHA-256 of the
 * identity-free question, never the text; it is not in kvStore's fallback
 * allowlist, so it stays Cloudflare-only. Best-effort: a cache failure is a
 * miss, never a failed research run.
 */
export const RESEARCH_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const RESEARCH_CACHE_HIT_STEP = "Using web research saved earlier today";
const RESEARCH_CACHE_PREFIX = "web_research_cache:";

async function researchCacheKey(question: string): Promise<string> {
  return RESEARCH_CACHE_PREFIX + (await hashContent(question.trim().toLowerCase().replace(/\s+/g, " ")));
}

async function readCachedResearch(env: Env, key: string): Promise<{ digest: string; gaps: string[] } | null> {
  if (!env.STATE_KV) return null;
  try {
    const raw = await kvGet(env, key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { digest?: unknown; gaps?: unknown };
    if (typeof parsed.digest !== "string" || !parsed.digest || !Array.isArray(parsed.gaps)) return null;
    return { digest: parsed.digest, gaps: parsed.gaps.filter((g): g is string => typeof g === "string") };
  } catch (err) {
    console.error("Research cache read failed", err instanceof Error ? err.message : err);
    return null;
  }
}

async function writeCachedResearch(env: Env, key: string, result: { digest: string; gaps: string[] }): Promise<void> {
  if (!env.STATE_KV) return;
  try {
    await kvPut(env, key, JSON.stringify(result), { expirationTtl: RESEARCH_CACHE_TTL_SECONDS });
  } catch (err) {
    console.error("Research cache write failed", err instanceof Error ? err.message : err);
  }
}

/** Deep Research findings are cached under their own key, so a Light answer is never served for a Deep request. */
async function deepResearchCacheKey(question: string): Promise<string> {
  return RESEARCH_CACHE_PREFIX + "deep:" + (await hashContent(question.trim().toLowerCase().replace(/\s+/g, " ")));
}

/** Saves completed Deep Research findings for 24 hours (same rules as the research cache). */
export async function saveDeepResearchFindings(env: Env, question: string, result: { digest: string; gaps: string[] }): Promise<void> {
  await writeCachedResearch(env, await deepResearchCacheKey(question), result);
}

/** Completed findings for this question, Deep Research first, else Light Search; null when none are saved. */
export async function savedResearchFindings(env: Env, question: string): Promise<{ digest: string; gaps: string[]; mode: "deep_research" | "light_search" } | null> {
  const deep = await readCachedResearch(env, await deepResearchCacheKey(question));
  if (deep) return { ...deep, mode: "deep_research" };
  const light = await readCachedResearch(env, await researchCacheKey(question));
  return light ? { ...light, mode: "light_search" } : null;
}

/**
 * Feeds already-completed research findings into the CURRENT run, so the
 * Hat's next AI step uses exactly these findings instead of deciding and
 * researching again ("Continue to draft", option B). Returns false when no
 * findings are saved or there is no run.
 */
export async function seedRunResearchFindings(env: Env, question: string): Promise<boolean> {
  const run = currentRun();
  if (!run) return false;
  const saved = await savedResearchFindings(env, question);
  if (!saved) return false;
  runResearch.set(run, Promise.resolve(findingsBlock(question, saved.digest)));
  return true;
}

/** The augmenter installed on the shared AI executor. Never throws past the executor's own guard. */
export interface WebResearchDeps {
  /** The light question (a string, as before), or a decision that may carry a deep-research proposal. */
  decide: (env: Env, task: AiTask) => Promise<string | ResearchDecision | null>;
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
      const decision = await deps.decide(env, task);
      const decided = typeof decision === "string" ? decision : decision?.question;
      const question = decided ? scrubResearchQuestion(decided) : null;
      if (!question || question.length < 8) return null;
      const found = await deps.research(env, question, access);
      // A deep proposal is kept only where the Work can hold its draft for
      // it, and never when the light research itself paused.
      const deep = typeof decision === "object" ? decision?.deep : undefined;
      if (deep && run.offersDeepResearch && !researchPausedInRun()) noteDeepResearchProposal({ ...deep, lightQuestion: question });
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

setTaskAugmenter("web_research", 20, (env, task) => augmentTaskWithWebResearch(env, task));
