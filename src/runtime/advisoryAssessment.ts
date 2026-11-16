import type { Env, ResultReviewAssessment, WorkState } from "../types";
import { generate } from "../ai";
import { hashContent } from "../contentHash";
import { getPageContent } from "../notion";
import { systemContext } from "../access";
import { RESULT_VERIFICATION_AUTHORITY_PAGE_ID, RESULT_VERIFICATION_TASK_ID, parseResultVerificationAuthority } from "./resultVerification";

/**
 * The independent Checker as ADVISORY second opinion (Martin's decision,
 * 2026-11-14, BD-8/BD-13 refinement). After a Hat's draft is delivered to
 * Martin with its Approve and Redo buttons, the Checker assesses the draft
 * against the Action's content criteria and whether it is relevant to what
 * ENIG does and, where the Work has one, to the client's situation as
 * recorded, and sends Martin a SEPARATE assessment with a recommended next
 * action. It never blocks, delays or invalidates Approve, Redo or closure,
 * and a missing, late or failed assessment changes nothing.
 *
 * Unit-free: a Unit declares what to assess on its Action
 * (`advisoryAssessment` in src/hats/actionRegistry.ts); nothing here names a
 * Unit. The Checker's identity is still Martin's Machinery Worker grant read
 * live from the canonical Operations page (BD-13); without it, no assessment.
 */

/**
 * The longest the assessment may take before it is abandoned. It runs from a
 * Durable Object alarm after the draft is already with Martin, so nothing
 * waits on it; the allowance covers the executor's last-resort rate-limit wait
 * (up to 60 s) plus the provider calls themselves. (Was 25 s while it ran
 * inline in the draft's own request.)
 */
export const ADVISORY_ASSESSMENT_TIMEOUT_MS = 100_000;

export interface AdvisoryAssessmentInput {
  /** The draft being assessed (exactly what Martin was shown). */
  output: string;
  /** What Martin asked for, when the Work records it. */
  request?: string;
  /** The Action's CONTENT criteria (never the approval criterion: his approval does not exist yet). */
  criteria: readonly string[];
  unit?: string;
  hat?: string;
}

const RELEVANCE = ["yes", "partly", "no"] as const;
const CLIENT_RELEVANCE = ["yes", "partly", "no", "not_applicable"] as const;
const NEXT_ACTIONS = ["approve", "redo", "ask"] as const;

/** The exact answer shape (execution mechanics, same discipline as the closing check's format). */
export const ADVISORY_RESPONSE_FORMAT = [
  "=== RESPONSE FORMAT (execution mechanics) ===",
  'Reply ONLY with JSON exactly in this shape: {"assessment": "<2-4 plain sentences: what holds up and what does not>", "concerns": ["<a concrete concern>", ...], "relevant_to_enig": "yes|partly|no", "relevant_to_client_situation": "yes|partly|no|not_applicable", "recommended_next_action": "approve|redo|ask", "next_action_note": "<for redo: the concrete note Martin could send; for ask: the question; for approve: one line>"}.',
  'Use "not_applicable" for relevant_to_client_situation when the request and context supply no client situation. "concerns" may be empty. No other key names, no other values.',
].join("\n");

/** The Checker's prompt parts. Pure and exported so the rubric is testable. */
export function buildAdvisoryPromptParts(input: AdvisoryAssessmentInput, checkerId: string) {
  return {
    persona: `You are ENIG's independent Checker (Machinery Worker "${checkerId}"). You did not write this draft. You give Martin a SECOND OPINION on it -- advisory only: he decides, and nothing waits on you.`,
    skillContent: [
      "Assess the draft below. Judge:",
      "1. Each of the content criteria listed under CRITERIA.",
      "2. Whether it is RELEVANT TO WHAT ENIG DOES -- use ENIG's own description of itself (the Consultancy Profile, where provided above) to judge whether ENIG's services can actually act on it.",
      "3. Whether it is RELEVANT TO THE CLIENT'S SITUATION, only where the request or context supplies one as recorded; otherwise answer not_applicable. Never invent a situation.",
      "Judge only against what you were given. You cannot know whether a claim is true in the world, only whether the draft's claims are supported by the sources it names. Be concrete and brief; do not pad. Then recommend ONE next action: approve (good to use), redo (with a concrete note Martin could send), or ask (a question to settle first).",
    ].join("\n"),
    context: [
      `REQUEST: ${input.request?.trim() || "(not recorded)"}`,
      `CRITERIA:\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
      ADVISORY_RESPONSE_FORMAT,
    ].join("\n\n"),
    situation: `DRAFT (${input.unit ?? "unassigned"}/${input.hat ?? "unassigned"}):\n\n${input.output}`,
  };
}

/** Validates the Checker's reply; anything outside the exact shape is no assessment (never a guess). */
export function parseAdvisoryAssessment(raw: unknown): Pick<ResultReviewAssessment, "assessment" | "concerns" | "relevantToEnig" | "relevantToClient" | "recommended" | "note"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const assessment = text(r.assessment, 900);
  const note = text(r.next_action_note, 500) ?? undefined;
  const relevantToEnig = (RELEVANCE as readonly unknown[]).includes(r.relevant_to_enig) ? (r.relevant_to_enig as ResultReviewAssessment["relevantToEnig"]) : null;
  const relevantToClient = (CLIENT_RELEVANCE as readonly unknown[]).includes(r.relevant_to_client_situation) ? (r.relevant_to_client_situation as ResultReviewAssessment["relevantToClient"]) : null;
  const recommended = (NEXT_ACTIONS as readonly unknown[]).includes(r.recommended_next_action) ? (r.recommended_next_action as ResultReviewAssessment["recommended"]) : null;
  if (!assessment || !relevantToEnig || !relevantToClient || !recommended) return null;
  const concerns = Array.isArray(r.concerns) ? r.concerns.map((c) => text(c, 300)).filter((c): c is string => c !== null).slice(0, 5) : [];
  return { assessment, concerns, relevantToEnig, relevantToClient, recommended, ...(note ? { note } : {}) };
}

const NEXT_LABEL: Record<ResultReviewAssessment["recommended"], string> = { approve: "Approve", redo: "Redo", ask: "Ask first" };
const RELEVANCE_LABEL: Record<string, string> = { yes: "yes", partly: "partly", no: "no", not_applicable: "not applicable" };

/** The separate message Martin receives. Plain text: nothing here is a button. */
export function formatAdvisoryMessage(a: ResultReviewAssessment, when: "before" | "after"): string {
  return [
    "🔎 Checker's second opinion (advisory -- you decide)",
    when === "after" ? "(This arrived after you had already approved; nothing changes.)" : "",
    "",
    a.assessment,
    "",
    `Relevant to what ENIG does: ${RELEVANCE_LABEL[a.relevantToEnig]}`,
    `Relevant to the client's situation: ${RELEVANCE_LABEL[a.relevantToClient]}`,
    ...(a.concerns.length ? ["", "Concerns:", ...a.concerns.map((c) => `- ${c}`)] : []),
    "",
    `Recommended next action: ${NEXT_LABEL[a.recommended]}${a.note ? ` -- ${a.note}` : ""}`,
  ]
    .filter((line, i, all) => !(line === "" && (i === 0 || all[i - 1] === "")))
    .join("\n");
}

/** One short line for the Result approval card, when an assessment exists. */
export function summarizeAssessment(a: ResultReviewAssessment | undefined): string {
  return a ? `Checker's second opinion (advisory): recommends ${NEXT_LABEL[a.recommended].toLowerCase()}; relevant to ENIG: ${RELEVANCE_LABEL[a.relevantToEnig]}.` : "";
}

export interface AdvisoryAssessmentDeps {
  fetchAuthorityPage: () => Promise<string>;
  ask: (input: AdvisoryAssessmentInput, checkerId: string) => Promise<unknown>;
}

export function advisoryAssessmentDeps(env: Env): AdvisoryAssessmentDeps {
  return {
    fetchAuthorityPage: () => getPageContent(env, RESULT_VERIFICATION_AUTHORITY_PAGE_ID, systemContext()),
    ask: (input, checkerId) =>
      generate<Record<string, unknown>>(env, { taskId: RESULT_VERIFICATION_TASK_ID, mode: "json", parts: buildAdvisoryPromptParts(input, checkerId) }),
  };
}

/**
 * Runs the assessment. Returns null -- silently, with a log line -- when the
 * Checker's authority cannot be read, the call fails or times out, or the
 * reply is not the exact shape: no assessment is simply no second opinion.
 */
export async function runAdvisoryAssessment(input: AdvisoryAssessmentInput, deps: AdvisoryAssessmentDeps, timeoutMs = ADVISORY_ASSESSMENT_TIMEOUT_MS): Promise<ResultReviewAssessment | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await deps.fetchAuthorityPage();
    const authority = parseResultVerificationAuthority(page ?? "");
    if (!authority.ok) {
      console.error(`Advisory assessment unavailable: ${authority.reason}`);
      return null;
    }
    const checkerId = authority.authority.machineryWorkerId;
    const raw = await Promise.race([
      deps.ask(input, checkerId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const parsed = parseAdvisoryAssessment(raw);
    if (!parsed) {
      console.error("Advisory assessment unavailable: the Checker's reply was not the exact shape");
      return null;
    }
    return { ...parsed, checkerId, outputHash: await hashContent(input.output), assessedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`Advisory assessment unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether, and how, a finished assessment is delivered, judged against the
 * Work's CURRENT saved state so it can never interfere with a decision
 * Martin has already made or confuse him about a draft he has moved on from.
 *   before -- the assessed draft is still the one awaiting his decision
 *   after  -- he approved it meanwhile (the Work is complete or closing)
 *   skip   -- the draft was redone, replaced or the Work cancelled
 */
export function assessmentDelivery(fresh: WorkState, assessedOutput: string, currentOutput: (s: WorkState) => string | undefined, awaitingStage: string): "before" | "after" | "skip" {
  const current = currentOutput(fresh);
  if (current === assessedOutput && fresh.stage === awaitingStage) return "before";
  const closed = fresh.stage === "delivered" || fresh.stage === "complete" || fresh.stage === "result_review_blocked";
  if (closed && (current === undefined || current === assessedOutput) && fresh.resultReview?.approval) return "after";
  return "skip";
}
