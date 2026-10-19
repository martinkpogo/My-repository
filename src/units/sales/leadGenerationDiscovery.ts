import type { Env, WorkState } from "../../types";
import { executeSearch, isWebSearchConfigured } from "../../runtime/research/webSearch";
import type { SearchResult } from "../../runtime/research/webSearch";
import { createPage, richText, select, title } from "../../notion";
import { generate } from "../../ai";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import { logActivity } from "../../log";
import { sendOperationsHatMessage, sendWorkspaceHatMessage } from "../../telegram";
import type { HatMessageTarget } from "../../telegram";
import { getLeadDiscoveryGovernance, findDuplicateLeads, isCheckableUrl } from "./leadDiscovery";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { AccessDeniedError, discoveryCronContext, mintApprovalProofForWork, workSessionContext, type AccessContext } from "../../access";
import { kvDelete, kvGet, kvPut } from "../../kvStore";
import { getSessionStub, newWorkId } from "../../sessionRouting";
import { SALES_OPERATION } from "./salesOperationNames";
import { runProspectResearch, summarizeResearchSynthesis } from "../../runtime/actionResearch";
import {
  buildCandidateReview,
  gatherPublicSocialSignals,
  renderBlockedCandidateReview,
  renderCandidateReview,
  type CandidateReview,
} from "./candidateReview";

import { salesOf } from "./salesState";
/**
 * Autonomous counterpart to the Martin-supplied /lead command in
 * leadDiscovery.ts -- same Hat, same authority boundaries, same Leads
 * database, same governance page (fetched live, including the Acquisition
 * Criteria section Architect added). The only difference is where the
 * candidate signal comes from: a scheduled web search instead of a typed
 * message. Reuses getLeadDiscoveryGovernance/findDuplicateLeads/
 * isCheckableUrl rather than duplicating them.
 */

const HAT_TARGET_NAME = "Lead Generation Specialist";

// Fixed queries structured around the 5 problem-signal categories named
// explicitly in the Hat Definition's Acquisition Criteria (criterion 2,
// "the strongest criterion"): unclear/inconsistent positioning and
// difficulty explaining the offer; market/model change without a
// corresponding positioning update; stagnant growth or a major strategic
// direction change; rebrand without evident strategic clarity; and
// fragmented messaging / a perceived market position weaker than actual
// capability. Earlier versions of this list searched for neutral
// situational-change announcements (a rebrand announcement, a market-entry
// press release) rather than the problem itself -- evaluateCandidates()
// still judges every result against the full Acquisition Criteria either
// way, but a search feed of press-release announcements rarely surfaces
// the kind of candidate that criterion actually describes, so the queries
// themselves needed to search for the problem, not just the event around it.
//
// These search for observable evidence, statements, or commentary without
// presupposing a negative diagnosis (avoiding terms like "bad branding" or
// "ineffective marketing") -- same discipline the Hat Definition itself
// requires of the evaluation step. Deliberately problem-signal-driven and
// not industry-scoped.
export const DISCOVERY_QUERIES = [
  // Category 1: Unclear/inconsistent positioning, difficulty explaining the offer
  "customers unsure what company actually offers",
  "startup struggles to explain what it does",
  "brand identity doesn't match business direction",
  // Category 2: Market or business-model change without a positioning update
  "company expands into new market same branding",
  "business pivots to new model brand unchanged",
  "growing company still using old messaging",
  // Category 3: Stagnant growth or a major strategic direction change
  "growth stalls despite new product launch",
  "flat sales growth strategic shift announced",
  "leadership change signals new direction",
  // Category 4: Rebrand without evident strategic clarity
  "rebrand backlash unclear direction",
  "new brand identity criticized by customers",
  "company rebrands again within a few years",
  // Category 5: Fragmented messaging, weak differentiation, or a perception gap vs. capability
  "inconsistent messaging across marketing channels",
  "hard to tell company apart from competitors",
  "brand perception lags behind product quality",
];

// Bounds total AI-evaluation volume per run (queries x this) -- same
// discipline as research/webSearch.ts's MAX_RESULTS_PER_QUERY.
const MAX_RESULTS_PER_QUERY = 3;

interface CandidateEvaluation {
  pass: boolean;
  organisation: string;
  evidence: string;
  decisionMakerOrRole: string;
  category: string;
  reason: string;
}

interface EvaluationBatchResponse {
  candidates: CandidateEvaluation[];
}

// ---------------------------------------------------------------------------
// Company-specific evidence threshold (deterministic).
// ---------------------------------------------------------------------------
//
// Correction for a confirmed live failure: an approval card cited a general
// article about inconsistent brand messaging as if it demonstrated that a
// NAMED organisation had that problem. The AI screening step judges only
// search-result snippets, so nothing downstream could tell "the source is
// about the problem category" apart from "the source shows THIS company has
// the problem". These checks are the deterministic half of that distinction:
// the named organisation must appear in the retrieved result itself, the
// observation must name that organisation, and the observation must carry a
// business problem/opportunity signal. They only ever HOLD a candidate
// (counted as insufficient evidence, never presented as an approval card) --
// they never turn a hold into a pass, they add no confidence score, and the
// full Acquisition-Criteria judgement stays with the live governance/AI step
// above them. A Lead still exists only after Martin's explicit approval.
//
// Known limitation, deliberately documented rather than papered over: the
// signal vocabulary below is a bounded wordlist, not a semantic test. An
// observation that genuinely shows a problem but is phrased entirely outside
// this vocabulary is HELD rather than presented (the safe direction), and a
// snippet that merely names the company in passing can still satisfy the
// naming checks -- semantic source-grounding beyond naming cannot be verified
// deterministically from a snippet at all, which is exactly why the candidate
// review (candidateReview.ts) keeps every source labelled as a snippet and
// Martin's approval stays the bar for a Lead.

/**
 * Unicode-aware normalisation for grounding comparisons: lowercases and
 * collapses every run of non-letter/digit characters to one space, so
 * "Acme, Corp." and "acme corp" compare equal while non-Latin names
 * (e.g. 株式会社サクラ) survive intact rather than normalising to nothing.
 */
export function normaliseForGrounding(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Bounded problem-signal vocabulary drawn from the five problem-signal
 * categories the Hat Definition's Acquisition Criteria name (criterion 2 is
 * the strongest): unclear/inconsistent positioning and difficulty explaining
 * the offer; a change without a corresponding positioning update; stagnant
 * growth; a rebrand without evident strategic clarity; fragmented messaging
 * and a perception gap versus actual capability.
 *
 * Deliberately EXCLUDES neutral event nouns -- rebrand, expansion,
 * leadership change, product launch, acquisition, funding -- on purpose: an
 * announcement of one of those, with nothing else, does not establish a
 * problem, so an evidence string carrying only the event fails this check.
 * Matched word-wise against the observation, case-insensitively.
 */
const PROBLEM_SIGNAL_SOURCES: readonly string[] = [
  // Category 1 / 5: unclear or inconsistent positioning, difficulty explaining the offer, fragmented messaging.
  "inconsisten\\w*",
  "unclear",
  "confus\\w*",
  "fragment\\w*",
  "struggl\\w*",
  "difficult\\w*",
  "explain\\w*",
  "hard to (?:tell|explain|understand)",
  "mixed messag\\w*",
  "generic\\b",
  // Category 2: a market/model change without a corresponding positioning update.
  "still\\b",
  "unchanged",
  "outdated",
  "no longer",
  "without updat\\w*",
  "not updat\\w*",
  "no updat\\w*",
  "hasn'?t updat\\w*",
  "same (?:branding|positioning|messaging|identity|logo|tagline|offer)",
  // Category 3: stagnant growth / a strategic shift showing as a problem.
  "stagnan\\w*",
  "flat\\b",
  "declin\\w*",
  "plateau\\w*",
  "stall\\w*",
  "slow(?:down|ing)\\b",
  "drop(?:s|ped|ping)?\\b",
  "shrink(?:s|ing)?\\b",
  "slump(?:s|ed|ing)?\\b",
  "underperform\\w*",
  "problem\\w*\\b",
  // Category 4: rebrand without evident strategic clarity.
  "backlash",
  "criticis\\w*",
  "criticiz\\w*",
  "panned",
  // Category 5: perception gap versus actual capability.
  "perceiv\\w*",
  "lag(?:s|ged|ging)?\\b",
  "behind\\b",
  "weak(?:er|ness)?\\b",
  "differentiat\\w*",
  "indistinguishab\\w*",
  // Adverse-outcome language only a genuine problem observation would carry.
  "fail\\w*\\b",
  "los(?:e|es|ing|t)\\b",
  "churn\\w*",
];

const PROBLEM_SIGNAL_PATTERNS: readonly RegExp[] = PROBLEM_SIGNAL_SOURCES.map((source) => new RegExp(`\\b(?:${source})`, "i"));

/**
 * Whether an observation states (or quotes) a business problem or
 * opportunity signal at all -- the mechanical half of "a neutral business
 * event does not itself establish a problem". Never a diagnosis: it only
 * says the observation is about a problem/signal rather than a bare
 * announcement.
 */
export function evidenceStatesProblemOrOpportunity(evidence: string): boolean {
  if (typeof evidence !== "string" || !evidence.trim()) return false;
  const lower = evidence.toLowerCase();
  return PROBLEM_SIGNAL_PATTERNS.some((pattern) => pattern.test(lower));
}

export type CompanySpecificEvidenceVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * The deterministic evidence threshold a screening pass must additionally
 * clear before its candidate may be presented for approval:
 *
 * 1. an organisation is named, with checkable source evidence;
 * 2. the retrieved result itself names that organisation -- a general
 *    article about the problem category is never evidence about a company
 *    it does not mention;
 * 3. the observation (evidence) names that organisation -- an observation
 *    not tied to the named organisation cannot be presented as one;
 * 4. the observation carries a business problem/opportunity signal -- a
 *    rebrand, expansion, leadership change or product launch announcement
 *    on its own does not establish a problem.
 *
 * A failure is reported with the reason; the caller holds the candidate as
 * insufficient evidence (never presented). See the module comment above for
 * the deliberate limitation of check 4.
 */
export function checkCompanySpecificEvidence(
  evaluation: Pick<CandidateEvaluation, "organisation" | "evidence">,
  result: Pick<SearchResult, "title" | "url" | "snippet">,
): CompanySpecificEvidenceVerdict {
  const organisation = (evaluation.organisation ?? "").trim();
  const evidence = (evaluation.evidence ?? "").trim();
  if (!organisation) return { ok: false, reason: "the evaluation names no organisation" };
  if (!evidence) return { ok: false, reason: `the evaluation supplies no evidence for ${organisation}` };
  if (!isCheckableUrl(result.url)) return { ok: false, reason: `the source url for ${organisation} is not a checkable http(s) url: ${result.url}` };

  const normalisedOrganisation = normaliseForGrounding(organisation);
  if (!normalisedOrganisation) {
    return { ok: false, reason: `the organisation name "${organisation}" cannot be grounded in retrieved text` };
  }

  const resultText = normaliseForGrounding(`${result.title} ${result.url} ${result.snippet}`);
  if (!resultText.includes(normalisedOrganisation)) {
    return {
      ok: false,
      reason: `the retrieved result does not name ${organisation} -- a general article about the problem category is not evidence that this organisation has the problem`,
    };
  }

  if (!normaliseForGrounding(evidence).includes(normalisedOrganisation)) {
    return {
      ok: false,
      reason: `the evidence does not name ${organisation} -- an observation presented on the card must be tied to the named organisation`,
    };
  }

  if (!evidenceStatesProblemOrOpportunity(evidence)) {
    return {
      ok: false,
      reason: `the evidence for ${organisation} states no business problem or opportunity signal -- a neutral business event (rebrand, expansion, leadership change, product launch) announced on its own does not establish a problem`,
    };
  }

  return { ok: true };
}

/**
 * Evaluates one query's search results in a single AI call against the
 * full canonical governance (including Acquisition Criteria) -- operates
 * only on the search results' own title/url/snippet, exactly as retrieved;
 * never fabricates a decision-maker, contact, or fact the snippet doesn't
 * contain. Returns [] (not null) on governance/AI failure so one failed
 * query doesn't abort the rest of the run -- the caller logs the failure.
 * A `pass: true` here is NOT the end of screening: the caller additionally
 * applies the deterministic company-specific evidence threshold
 * (checkCompanySpecificEvidence below), because an AI pass alone cannot
 * prove the observation is tied to the named organisation rather than to a
 * general article about the problem category.
 *
 * Migrated (Skills architecture proof, Build order Step 2) to fetch the
 * shared `research-signal` Skill for its evidence discipline (never
 * fabricate a specific fact; observation, not diagnosis) instead of
 * restating that discipline inline -- the same Skill Business
 * Development's Opportunity Development Hat fetches for
 * discoverOpportunity/researchOpportunity
 * (businessDevelopmentManifest.ts), under a materially different
 * Persona (this Hat's own Hat Definition, not BD's), Data Source (public
 * web search results, not Martin's own request text), and consequence/
 * approval shape (this call feeds an eventual Lead-creation approval
 * gate; BD's discover_opportunity is a standalone "read" action with no
 * approval at all). What's left in this call's own `situation` below is
 * genuinely Hat/action-specific: the Acquisition Criteria evaluation
 * mechanics and this action's own JSON output shape, neither of which
 * belongs in a Skill meant to stay reusable beyond this one Hat.
 */
export async function evaluateCandidates(env: Env, results: SearchResult[], skills: ResolvedActionSkillSet): Promise<CandidateEvaluation[]> {
  if (results.length === 0) return [];

  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    console.error("Autonomous Lead Discovery: evaluation blocked -- governance retrieval failed");
    return [];
  }

  const skillContent = skills.get("research_signal").content;

  const candidatesText = results
    .map((r, i) => `[${i}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}${r.published_at ? `\nPublished: ${r.published_at}` : ""}`)
    .join("\n\n");

  const response = await generate<EvaluationBatchResponse>(env, {
    taskId: "lead.discovery_signal_evaluation",
    mode: "json",
    parts: {
      persona: `You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Hat Definition (including its Acquisition Criteria section) is authoritative for this role -- follow it exactly as written.\n\n=== HAT DEFINITION ===\n${governance.hatDefinition}`,
      behavior: governance.universalRoleContract,
      skillContent,
      context: candidatesText,
      situation: `Evaluate EACH of the search results above independently against the Acquisition Criteria section in the Hat Definition -- operating business, strategic/commercial problem signal, business consequence, ENIG relevance, consultancy-readiness, reachability, and the evidence-threshold hard gate. If the snippet doesn't support a criterion, that criterion is not met -- do not assume it. A commodity request (logo/generic graphic design/social media graphics/basic branding) or mere existence/size/industry is never sufficient to pass.\n\nCompany-specific evidence rules (hard gate -- a deterministic check enforces each one downstream and holds any candidate that fails it):\n- evidence must be a source-grounded OBSERVATION about the named organisation, taken from THIS result's own title/url/snippet, and must state the organisation's exact name. A general article about the problem category -- however accurate -- is never evidence that a particular company has that problem: if the result does not itself name the organisation, return pass: false with an empty organisation.\n- A neutral business event (a rebrand, an expansion, a leadership change, a product launch, an acquisition, a funding announcement) announced without source-grounded evidence of the problem or opportunity itself does NOT pass: the event is context, not a demonstrated problem.\n- "evidence" is what the snippet OBSERVES (an observed fact about the organisation); "reason" is why that may matter -- a hypothesis. Never present a possible business implication as an established fact, and never invent a contact, decision-maker, metric or date the snippet does not contain.\n\nReturn JSON: {"candidates": [{"pass": true|false, "organisation": "<name if identifiable, else empty string>", "evidence": "<the disciplined observation, naming the organisation, or empty string if pass is false>", "decisionMakerOrRole": "<only if explicitly named/implied in the text, else empty string>", "category": "<short label, or empty string>", "reason": "..."}, ...]} -- exactly one entry per result given, in the same order.`,
    },
    light: true,
    maxTokens: 3000,
  });

  return response?.candidates ?? [];
}

interface DiscoveryRunSummary {
  evaluated: number;
  /**
   * Screened candidates sent to Martin as Telegram approval cards this run
   * -- never Leads created. No discovery source (scheduled or on-demand)
   * may create a Lead without Martin's explicit approval of that specific
   * candidate (Martin's decision, 2026-10-12); see presentScreenedCandidate
   * and handleLeadOpportunityApproval below.
   */
  pendingApproval: number;
  /**
   * Candidates that passed screening but were NOT presented because this
   * run already sent MAX_APPROVAL_CARDS_PER_RUN cards. Nothing is
   * remembered for them, so a later run can still present them.
   */
  heldOverCap: number;
  /** Candidates skipped because Martin already has a card for them pending, or rejected them recently. */
  skippedAlreadyPresented: number;
  /** Candidates whose approval card could not be created or sent (logged as a Blocker each). */
  presentationFailed: number;
  /**
   * Candidates that passed screening but whose duplicate-Leads check failed.
   * They are counted here rather than folded into `skippedAsDuplicate`, for
   * the same reason a failed search is never reported as "no results": a
   * Notion read that threw is not a finding that the organisation is new, and
   * a candidate this run could not check is not a candidate this run handled.
   * Counting them keeps the run's own accounting exhaustive -- every evaluated
   * candidate lands in exactly one bucket.
   */
  duplicateCheckFailed: number;
  screenedOut: number;
  skippedAsDuplicate: number;
  skippedAsInsufficient: number;
  /**
   * Queries whose search could not run this cycle (no provider
   * configured) -- recorded so a digest can say "search was unavailable"
   * instead of implying the searches came back empty.
   */
  searchUnavailable: number;
  /** Queries whose search ran but failed (provider failure/invalid input) -- a failed search is never reported as "no results". */
  searchFailed: number;
}

function emptyDiscoveryRunSummary(): DiscoveryRunSummary {
  return {
    evaluated: 0,
    pendingApproval: 0,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    screenedOut: 0,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  };
}

export interface PendingLeadOpportunity {
  organisation: string;
  /** The observed fact from the screening search-result snippet, naming the organisation -- never a hypothesis. */
  evidence: string;
  /** Why this may be worth pursuing -- explicitly a hypothesis, never an established fact. */
  reason: string;
  category?: string;
  sourceUrl: string;
  /**
   * When the screening search result behind `evidence`/`sourceUrl` was
   * actually retrieved (ISO-8601), so the card can date the observation.
   * Absent only on opportunities staged without a live retrieval (direct
   * tests, legacy staged state) -- the card then says the retrieval time is
   * not recorded rather than inventing one.
   */
  sourceRetrievedAt?: string;
  /** Digest of the automatic research on this prospect (findings with sources, and limitations), or the reason it could not be done. Shown on the card; never decides anything. */
  research?: string;
  /**
   * The evidence-backed candidate review built for this candidate (Slice A):
   * source-linked observed facts, findings, explicitly-labelled
   * interpretations and unknowns, surfaced conflicts, evidence limitations,
   * the public social-signal retrieval disclosures, and the bounded visual
   * analysis result -- already rendered for the card, and already validated
   * fail-closed or marked blocked with its reason. Shown on the card;
   * never decides anything, and never a Lead, Handoff or qualification.
   */
  review?: { status: CandidateReview["status"]; text: string };
  /** Legacy: the retired research Handoff a finding came from. Screened discovery candidates carry none. */
  handoffId?: string;
}

/** At most this many approval cards are sent per discovery run, so a run never floods the Workspace topic. */
export const MAX_APPROVAL_CARDS_PER_RUN = 5;
/** How long a rejected candidate is remembered (never re-proposed in this window). */
const REJECTED_CANDIDATE_TTL_SECONDS = 180 * 24 * 60 * 60;
/** How long a presented-but-undecided candidate is remembered, so later runs do not send a second card for it. */
const PENDING_CANDIDATE_TTL_SECONDS = 14 * 24 * 60 * 60;

/** One KV key per organisation, normalized so trivial spelling/punctuation variants share it. */
export function leadCandidateMemoryKey(organisation: string): string {
  const lower = organisation.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, " ").trim();
  // A name with no Latin letters or digits must not collapse to one shared key.
  return `lead_candidate:${normalized || lower.replace(/\s+/g, " ").trim()}`;
}

/** Where a run's approval cards are attached (the Work's chat). Cards themselves are always delivered to the Workspace topic. */
export interface CandidatePresentationTarget {
  chatId: number;
  threadId?: number;
}

/**
 * Presents an evidence-backed opportunity finding to Martin -- the
 * explicit human approval gate required before ANY discovery source
 * (scheduled or on-demand) may create a Lead. This is a candidate only:
 * no Lead exists yet, and none will unless Martin approves via the
 * buttons this sends. Shared by both discovery paths since both funnel
 * through processCompletedLGSResearchHandoffs.
 */
export async function proposeLeadOpportunity(
  env: Env,
  state: WorkState,
  opportunity: PendingLeadOpportunity,
): Promise<WorkState> {
  salesOf(state).pendingLeadOpportunity = opportunity;
  state.stage = "awaiting_lead_approval";

  const target: HatMessageTarget = { chatId: state.chatId, threadId: state.threadId, hat: HAT_TARGET_NAME, workId: state.workId };
  const buttons = [
    [
      { text: "✅ Approve -- create Lead", callback_data: `leadopportunity:${state.workId}:approve` },
      { text: "❌ Reject", callback_data: `leadopportunity:${state.workId}:reject` },
    ],
  ];

  const message = [
    `*Opportunity Finding* -- ${opportunity.organisation}`,
    "",
    `Category: ${opportunity.category || "unclassified"}`,
    `Observed (search-result snippet -- the source page itself was not opened): ${opportunity.evidence}`,
    `Hypothesis -- why this may be worth pursuing, NOT established: ${opportunity.reason}`,
    `Source: ${opportunity.sourceUrl || "N/A"} (search-result snippet${opportunity.sourceRetrievedAt ? `; retrieved ${opportunity.sourceRetrievedAt}` : "; retrieval time not recorded"})`,
    "",
    opportunity.review ? `Evidence review: ${opportunity.review.status === "validated" ? "validated against the retrieved material only" : "NOT PRODUCED -- see below; this candidate has NOT passed an evidence review"}\n${opportunity.review.text}\n` : "",
    opportunity.research ? `*Research*\n${opportunity.research}\n` : "",
    "Screened by Lead Generation against the Acquisition Criteria. No Lead has been created. Approve to record it as a Lead (Status: New), or reject to discard it -- a rejected organisation is not proposed again for 180 days. The evidence above is advisory input to that decision only: it is not a diagnosis, not a qualification, and not approval to contact anyone.",
  ].join("\n");

  state.pendingActionSummary = {
    label: `Opportunity: ${opportunity.organisation}`,
    message,
    buttons,
    createdAt: new Date().toISOString(),
  };

  await sendWorkspaceHatMessage(env, target, message, buttons);

  await logActivity(env, {
    entry: `Opportunity finding presented for approval: ${opportunity.organisation}`,
    type: "Discovery",
    area: "Sales",
    activity: `Category: ${opportunity.category || "unclassified"}. Source: ${opportunity.sourceUrl || "N/A"}.`,
    decisionRationale: opportunity.reason,
    nextActions: "Awaiting Martin's explicit approval before any Lead is created.",
    outcome: "Active",
  });

  return state;
}

/**
 * Martin's explicit approval or rejection of a pending opportunity finding
 * -- the ONLY code path that may create a Lead from discovery. Re-checks
 * for a duplicate at approval time (not just when first presented), since
 * time may have passed and another Lead could have appeared meanwhile.
 */
export async function handleLeadOpportunityApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const opportunity = state.sales?.pendingLeadOpportunity;
  const stagedSummary = state.pendingActionSummary;
  // The staged approval is consumed BEFORE anything else runs, so a second
  // tap on the same card (a replay) finds nothing and is a no-op.
  salesOf(state).pendingLeadOpportunity = undefined;
  state.pendingActionSummary = undefined;

  const target: HatMessageTarget = { chatId: state.chatId, threadId: state.threadId, hat: HAT_TARGET_NAME, workId: state.workId };

  if (!opportunity) {
    await sendWorkspaceHatMessage(env, target, "No valid pending opportunity finding found for this work item.");
    return state;
  }

  // A failed write did not happen, so the candidate is put back exactly as
  // it was staged: the same card's Approve button then works again, and a
  // Lead still exists only after Martin's own fresh tap.
  const restageForRetry = () => {
    salesOf(state).pendingLeadOpportunity = opportunity;
    state.pendingActionSummary = stagedSummary;
  };

  if (!approved) {
    state.stage = "complete";
    // Remembered so later discovery runs do not propose the same
    // organisation again. Best-effort: a failed write only means it may be
    // proposed again later, never that anything is created.
    await kvPut(
      env,
      leadCandidateMemoryKey(opportunity.organisation),
      JSON.stringify({ status: "rejected", workId: state.workId, at: new Date().toISOString() }),
      { expirationTtl: REJECTED_CANDIDATE_TTL_SECONDS },
    ).catch((err) => console.error(`Lead Opportunity Approval: could not remember the rejection of ${opportunity.organisation}`, err));
    await logActivity(env, {
      entry: `Opportunity finding rejected: ${opportunity.organisation}`,
      type: "Discovery",
      area: "Sales",
      decisionRationale: "Rejected by Martin.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, target, `Opportunity rejected for *${opportunity.organisation}*. No Lead was created, and it won't be proposed again for 180 days.`);
    return state;
  }

  let duplicates: Awaited<ReturnType<typeof findDuplicateLeads>>;
  try {
    duplicates = await findDuplicateLeads(env, opportunity.organisation, "");
  } catch (err) {
    console.error(`Lead Opportunity Approval: duplicate check failed for ${opportunity.organisation}`, err);
    restageForRetry();
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Couldn't verify this isn't a duplicate before creating the Lead for *${opportunity.organisation}* -- the Leads database check failed. Not created. Tap Approve on the card again to retry.`,
    );
    return state;
  }
  if (duplicates.length > 0) {
    state.stage = "complete";
    await logActivity(env, {
      entry: `Opportunity approval blocked -- possible duplicate: ${opportunity.organisation}`,
      type: "Discovery",
      area: "Sales",
      decisionRationale: `Matches existing Lead(s): ${duplicates.map((d) => d.name).join(", ")}`,
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Not created -- *${opportunity.organisation}* now matches an existing Lead: ${duplicates.map((d) => d.name).join(", ")}. Review manually if this is genuinely new.`,
    );
    return state;
  }

  try {
    // Martin's approval of THIS candidate, bound to this Work, its recorded
    // record_lead Action and the Leads data source. Access verifies all three
    // before the create; a Work recording any other Action (e.g. a legacy
    // card from before record_lead existed) cannot mint a usable proof and
    // the create is refused.
    const proof = mintApprovalProofForWork(state, env.LEADS_DATA_SOURCE_ID);
    const page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
      Lead: title(opportunity.organisation),
      Organisation: richText(opportunity.organisation),
      Contact: richText(""),
      "Contact Details": richText(""),
      Source: richText(opportunity.sourceUrl || ""),
      "Discovery Evidence": richText(opportunity.evidence),
      Status: select("New"),
    }, workSessionContext(state, proof));

    state.stage = "complete";
    await kvDelete(env, leadCandidateMemoryKey(opportunity.organisation)).catch(() => {});

    await logActivity(env, {
      entry: `Lead recorded (Martin-approved opportunity): ${opportunity.organisation}`,
      type: "Discovery",
      area: "Sales",
      activity: "Screened candidate presented for approval in Telegram. Approved by Martin.",
      decisionRationale: opportunity.reason,
      nextActions: "Prepared for Sales Executive follow-up.",
      outcome: "Complete",
    });

    await sendWorkspaceHatMessage(
      env,
      target,
      `✅ Lead recorded: *${opportunity.organisation}*\n${page.url}\n\nThis is a Lead only -- no Entity created, no qualification performed. Prepared for the isolated Sales Executive environment to pick up from here.`,
    );
  } catch (err) {
    console.error(`Lead Opportunity Approval: Leads DB write failed for ${opportunity.organisation}`, err);
    restageForRetry();
    await logActivity(env, {
      entry: `Opportunity approval blocked -- Lead not created: ${opportunity.organisation}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Couldn't record this Lead for *${opportunity.organisation}* -- the Leads database call failed. Not created. Tap Approve on the card again to retry once resolved.`,
    );
  }

  return state;
}

/**
 * Researches ONE screened candidate before its card is sent (Martin's decision,
 * 2026-10-12: research runs automatically as this Hat's step, and he sees the
 * result and approves). The prospect is a PUBLIC organisation ENIG has not
 * engaged, so the research uses the prospect task profile. A failure never
 * suppresses the card -- it is sent marked unresearched, with the reason.
 */
async function researchCandidate(env: Env, opportunity: PendingLeadOpportunity, access: AccessContext, skills: ResolvedActionSkillSet): Promise<string> {
  try {
    const outcome = await runProspectResearch(
      env,
      skills,
      {
        question: `What is publicly known about ${opportunity.organisation}'s current positioning, market situation and any strategic or brand change that would show whether it has a real positioning or growth problem worth a consultancy conversation?`,
        context: `Why it was screened: ${opportunity.reason}\nEvidence found: ${opportunity.evidence}\nSource: ${opportunity.sourceUrl}`,
      },
      access,
    );
    if (outcome.status === "completed") return summarizeResearchSynthesis(outcome.synthesis, 1200);
    return `Not researched -- ${outcome.reason}`.slice(0, 600);
  } catch (err) {
    console.error(`Lead Discovery: research failed for ${opportunity.organisation}`, err);
    return "Not researched -- the research step failed unexpectedly.";
  }
}

/**
 * Builds the evidence-backed candidate review for ONE screened candidate:
 * public social-signal retrieval plus the validated review, then rendered for
 * the card. Never suppresses the approval card -- any unexpected failure here
 * degrades to a BLOCKED review that says so, because Martin still has to see
 * the candidate either way.
 *
 * An Access denial is re-thrown rather than degraded: AccessDeniedError is a
 * governance decision, and turning it into "review unavailable" would downgrade
 * exactly the stop the Access boundary exists to enforce.
 */
async function buildReviewForCandidate(
  env: Env,
  opportunity: PendingLeadOpportunity,
  screeningResult: SearchResult,
  access: AccessContext,
  skills: ResolvedActionSkillSet,
): Promise<{ status: CandidateReview["status"]; text: string }> {
  try {
    const social = await gatherPublicSocialSignals(env, opportunity.organisation, access);
    const review: CandidateReview = await buildCandidateReview(env, opportunity.organisation, screeningResult, social, skills);
    return { status: review.status, text: renderCandidateReview(opportunity.organisation, review) };
  } catch (err) {
    if (err instanceof AccessDeniedError) throw err;
    console.error(`Lead Discovery: candidate review could not be built for ${opportunity.organisation}`, err);
    return {
      status: "blocked",
      text: renderBlockedCandidateReview(
        opportunity.organisation,
        `the evidence step failed before it returned any output (${err instanceof Error ? err.message : "unknown error"})`,
      ),
    };
  }
}

/**
 * Presents ONE screened candidate to Martin: its own Work, recording the
 * approval-gated record_lead Action from creation, then the approval card.
 * Nothing is written to the Leads database here. The candidate is remembered
 * as pending so a later run does not send a second card for it.
 *
 * `screeningResult` is the one retrieved search result that surfaced THIS
 * candidate -- the only web source the review may attribute a fact to, since
 * the other results from the same query belong to different organisations.
 */
async function presentScreenedCandidate(
  env: Env,
  presentTo: CandidatePresentationTarget,
  opportunity: PendingLeadOpportunity,
  screeningResult: SearchResult,
  access: AccessContext,
  skills: ResolvedActionSkillSet,
): Promise<boolean> {
  opportunity = {
    ...opportunity,
    research: await researchCandidate(env, opportunity, access, skills),
    review: await buildReviewForCandidate(env, opportunity, screeningResult, access, skills),
  };
  try {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, presentTo.chatId, "Sales", HAT_TARGET_NAME, presentTo.threadId, { actionName: "record_lead" });
    await stub.runUnitOperation("Sales", SALES_OPERATION.proposeLeadOpportunity, opportunity);
    await kvPut(
      env,
      leadCandidateMemoryKey(opportunity.organisation),
      JSON.stringify({ status: "pending", workId, at: new Date().toISOString() }),
      { expirationTtl: PENDING_CANDIDATE_TTL_SECONDS },
    ).catch((err) => console.error(`Lead Discovery: could not remember the pending card for ${opportunity.organisation}`, err));
    return true;
  } catch (err) {
    console.error(`Lead Discovery: could not present ${opportunity.organisation} for approval`, err);
    await logActivity(env, {
      entry: `Lead discovery blocked -- approval card not sent: ${opportunity.organisation}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: `Could not create the candidate's Work or send its approval card: ${err instanceof Error ? err.message : String(err)}`,
      outcome: "Blocked",
    }).catch(() => {});
    return false;
  }
}

/**
 * Searches one query and screens its results against the Acquisition
 * Criteria -- the shared body for BOTH the fixed scheduled query list and
 * an on-demand request's AI-generated queries.
 *
 * A candidate that survives screening and the duplicate-Lead check is
 * presented to Martin as a Telegram approval card on its own record_lead
 * Work (Martin's decision, 2026-10-12: screening is the bar for a card; his
 * approval is the bar for a Lead). This function creates no Handoff and no
 * Lead. A candidate already pending or recently rejected is skipped, and at
 * most MAX_APPROVAL_CARDS_PER_RUN cards are sent per run.
 */
async function searchAndScreenForQuery(
  env: Env,
  query: string,
  summary: DiscoveryRunSummary,
  access: AccessContext,
  skills: ResolvedActionSkillSet,
  presentTo: CandidatePresentationTarget,
): Promise<void> {
  // Defense in depth at the search edge, same as the research path: the
  // queries are already generated from prompt-redacted inputs and the fixed
  // DISCOVERY_QUERIES carry no identity, but an outbound disclosure re-check
  // costs nothing (LOG-1068 security: identity_redaction_required_when_
  // context_demands).
  const outcome = await executeSearch(env, { query: redactIdentityTerms(query) }, access);

  if (outcome.kind === "provider_unavailable") {
    summary.searchUnavailable++;
    return;
  }
  if (outcome.kind === "provider_failure" || outcome.kind === "invalid_input") {
    // A failed search is recorded as a failed search -- never folded into
    // "nothing found", which would misrepresent an unsearched query as an
    // empty result.
    summary.searchFailed++;
    console.error(`Lead Discovery: search did not complete for a discovery query (${outcome.kind}: ${outcome.reason})`);
    return;
  }
  if (outcome.kind === "success_no_results") return;

  const results = outcome.results.slice(0, MAX_RESULTS_PER_QUERY);

  const evaluations = await evaluateCandidates(env, results, skills);
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const evaluation = evaluations[i];
    summary.evaluated++;

    if (!evaluation || !evaluation.pass) {
      summary.screenedOut++;
      continue;
    }

    // The deterministic company-specific evidence threshold. An AI pass
    // whose source never names the organisation, or whose observation names
    // no problem/opportunity signal (a bare rebrand/expansion/leadership/
    // product-launch announcement, or a general article about the problem
    // category), is held as insufficient evidence -- never presented as a
    // normal approval card implying the case is established.
    const threshold = checkCompanySpecificEvidence(evaluation, result);
    if (!threshold.ok) {
      summary.skippedAsInsufficient++;
      console.log(`Lead Discovery: candidate held as insufficient evidence -- ${threshold.reason}`);
      continue;
    }

    let duplicateLead: Awaited<ReturnType<typeof findDuplicateLeads>>;
    try {
      duplicateLead = await findDuplicateLeads(env, evaluation.organisation, "");
    } catch (err) {
      console.error(`Lead Discovery: duplicate check failed for ${evaluation.organisation}`, err);
      // Counted before the (fallible) Blocker write below: a candidate we
      // could not check must show up in the run's own accounting even if the
      // Activity & Decision Log write also fails -- logActivity never throws.
      summary.duplicateCheckFailed++;
      await logActivity(env, {
        entry: `Lead discovery blocked -- duplicate check failed: ${evaluation.organisation}`,
        type: "Blocker",
        area: "Sales",
        decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
        outcome: "Blocked",
      });
      continue;
    }
    if (duplicateLead.length > 0) {
      summary.skippedAsDuplicate++;
      continue;
    }

    // Already carded and undecided, or rejected recently: never a second card.
    // A failed read is treated as "not seen" -- the worst case is a repeat
    // card Martin can reject, never a Lead.
    const remembered = await kvGet(env, leadCandidateMemoryKey(evaluation.organisation)).catch(() => null);
    if (remembered) {
      summary.skippedAlreadyPresented++;
      continue;
    }

    if (summary.pendingApproval >= MAX_APPROVAL_CARDS_PER_RUN) {
      summary.heldOverCap++;
      continue;
    }

    const presented = await presentScreenedCandidate(
      env,
      presentTo,
      {
        organisation: evaluation.organisation.trim(),
        evidence: evaluation.evidence.trim(),
        reason: evaluation.reason,
        category: evaluation.category,
        sourceUrl: result.url,
        sourceRetrievedAt: result.retrieved_at,
      },
      result,
      access,
      skills,
    );
    if (presented) summary.pendingApproval++;
    else summary.presentationFailed++;
  }
}

/**
 * Runs one autonomous discovery cycle: search and lightweight screening
 * against the Acquisition Criteria. Each candidate that passes becomes a
 * Telegram approval card (see searchAndScreenForQuery); no Handoff or Lead
 * is created by the run itself. Cards attach to Martin's DM Work by default.
 */
export async function runAutonomousLeadDiscovery(
  env: Env,
  skills: ResolvedActionSkillSet,
  presentTo: CandidatePresentationTarget = { chatId: Number(env.MARTIN_TELEGRAM_USER_ID) },
): Promise<DiscoveryRunSummary> {
  const summary = emptyDiscoveryRunSummary();

  if (!isWebSearchConfigured(env)) {
    console.error("Autonomous Lead Discovery: no web search provider configured -- nothing to do");
    // Record the unavailability honestly: none of the queries were run, so
    // the digest reports "search unavailable", not "searches found nothing".
    summary.searchUnavailable = DISCOVERY_QUERIES.length;
    return summary;
  }

  // This is the Kernel's own scheduled loop, not a Unit's Work item, so the
  // outbound search is authorized as a Kernel-owned read rather than under any
  // registered Action -- see evaluateExternalEgress.
  for (const query of DISCOVERY_QUERIES) {
    await searchAndScreenForQuery(env, query, summary, discoveryCronContext(), skills, presentTo);
  }

  return summary;
}

const ON_DEMAND_QUERY_COUNT_DEFAULT = 3;
const ON_DEMAND_QUERY_COUNT_MAX = 5;

interface OnDemandQueryGenerationResponse {
  queries: string[];
}

/**
 * Generates a small set of web search queries for an on-demand discovery
 * request -- the "independently determine where to search" step. Same
 * governance, same non-diagnostic discipline, and same Acquisition
 * Criteria grounding as the fixed DISCOVERY_QUERIES list, just scoped to
 * Martin's stated focus instead of the 5 fixed categories. Returns null on
 * governance/AI failure -- callers must fail closed, never fall back to a
 * generic/unscoped search or invent a query themselves.
 */
async function generateOnDemandDiscoveryQueries(env: Env, focus: string, count: number): Promise<string[] | null> {
  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    console.error("On-demand Lead Discovery: query generation blocked -- governance retrieval failed");
    return null;
  }

  const response = await generate<OnDemandQueryGenerationResponse>(env, {
    taskId: "lead.discovery_ondemand_query_generation",
    mode: "json",
    parts: {
      persona:
        "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition (including its Acquisition Criteria section) are authoritative for this role -- follow them exactly as written.",
      behavior: ["=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===", governance.universalRoleContract, "=== HAT DEFINITION ===", governance.hatDefinition].join("\n\n"),
      skillContent: [
        "=== TASK (execution mechanics -- not part of the governance above) ===",
        `Martin has asked you to proactively search for organisations showing evidence of a problem worth investigating${focus ? `, specifically: "${focus}"` : ""}. Generate exactly ${count} distinct web search queries likely to surface real organisations exhibiting the kind of strategic/commercial problem signal the Acquisition Criteria describe (criterion 2) -- unclear/inconsistent positioning, difficulty explaining the offer, a market/model change without a corresponding positioning update, stagnant growth, a rebrand without evident strategic clarity, fragmented cross-channel messaging, or a perceived market position weaker than actual capability${focus ? ", scoped to the specific focus given above" : ""}. Each query must search for an observable situation or statement, never presuppose a negative diagnosis (never use words like poor/bad/confused/ineffective/weak/failing), and never name a specific organisation -- you are generating a search strategy, not a company list.`,
        'Return JSON: {"queries": ["...", ...]} with exactly the requested number of distinct query strings.',
      ].join("\n\n"),
      situation: focus || "No specific focus given -- search broadly across the Acquisition Criteria's problem-signal categories.",
    },
    light: true,
  });

  const queries = (response?.queries ?? []).filter((q) => typeof q === "string" && q.trim());
  return queries.length > 0 ? queries.slice(0, count) : null;
}

interface OnDemandIntakeClassification {
  isDiscoveryRequest: boolean;
  count?: number;
  focus?: string;
}

/**
 * On-demand counterpart to runAutonomousLeadDiscovery: lets Martin ask,
 * in the Workspace stream, for LGS to proactively find opportunities right
 * now ("find me 3 companies showing a positioning problem") instead of
 * waiting for the next scheduled cycle. Reuses the exact same search and
 * screening as scheduled discovery (searchAndScreenForQuery) -- the only
 * difference is where the query list comes from (AI-generated from
 * Martin's stated focus, instead of the fixed DISCOVERY_QUERIES list) and
 * that it's triggered by a chat message instead of a cron tick. Candidates
 * that pass screening are held, exactly as in the scheduled path, and no
 * Lead is created without Martin's approval.
 */
export const LeadOpportunityDiscoveryCapability = {
  id: "sales.lead_opportunity_discovery",
  name: "Lead Generation Specialist On-Demand Discovery Capability",
  description:
    "Runs on-demand opportunity discovery when Martin asks Lead Generation Specialist to proactively find companies showing evidence of a problem worth investigating.",
  async handleIntake(env: Env, chatId: number, text: string, threadId: number | undefined, skills: ResolvedActionSkillSet): Promise<boolean> {
    const classification = await generate<OnDemandIntakeClassification>(env, {
      taskId: "lead.discovery_ondemand_intake",
      mode: "json",
      parts: {
        persona: `You classify incoming messages for ENIG's Lead Generation Specialist on-demand discovery capability.
Check if Martin is asking ENIG's own team to PROACTIVELY DISCOVER/FIND new potential companies/organisations to investigate as possible clients -- e.g. "find me 3 companies showing a positioning problem", "look for businesses with weak differentiation worth reaching out to", "search for organisations that might need our help".
This is NOT: a prospective client's own enquiry about their own company (that is a Sales enquiry), a request to research a SPECIFIC NAMED company or market (a separate request, not discovery), or general chat/small talk.
If yes, set isDiscoveryRequest to true, extract the requested count as an integer if one was stated (otherwise omit the field), and a short restatement of the problem/situation focus requested (e.g. "positioning or communication problem"), or an empty string if no specific focus was given.
Return JSON: {"isDiscoveryRequest": true | false, "count": <integer, omit if not stated>, "focus": "..."}`,
        situation: text,
      },
      light: true,
    });

    if (!classification || !classification.isDiscoveryRequest) {
      return false;
    }

    const target: HatMessageTarget = { chatId, threadId, hat: HAT_TARGET_NAME };

    if (!isWebSearchConfigured(env)) {
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ Can't run discovery right now -- no web search provider is configured. Not proceeding.",
      );
      return true;
    }

    const requestedCount =
      typeof classification.count === "number" && classification.count > 0
        ? Math.min(Math.floor(classification.count), ON_DEMAND_QUERY_COUNT_MAX)
        : ON_DEMAND_QUERY_COUNT_DEFAULT;
    const focus = classification.focus?.trim() ?? "";

    const queries = await generateOnDemandDiscoveryQueries(env, focus, requestedCount);
    if (!queries) {
      await logActivity(env, {
        entry: "On-demand Lead Discovery blocked -- search strategy generation unavailable",
        type: "Blocker",
        area: "Sales",
        decisionRationale: "Could not retrieve canonical Lead Generation Specialist governance and/or no AI provider was eligible/available. Refusing to search without it.",
        outcome: "Blocked",
      });
      await sendWorkspaceHatMessage(
        env,
        target,
        "⚠️ Couldn't generate a search strategy for this request -- governance retrieval or AI classification failed. Not proceeding. Please try again shortly.",
      );
      return true;
    }

    await sendWorkspaceHatMessage(
      env,
      target,
      `🔍 Searching for organisations showing evidence of${focus ? ` ${focus}` : " a positioning, communication, or growth problem worth investigating"} (up to ${requestedCount}). Each candidate that passes screening comes to you as an approval card (at most ${MAX_APPROVAL_CARDS_PER_RUN}); no Lead is created unless you approve it.`,
    );

    const runSummary = emptyDiscoveryRunSummary();
    for (const query of queries) {
      // Same Kernel-owned read as the scheduled loop above: an on-demand
      // discovery request runs the same discovery capability, so it is
      // authorized the same way.
      await searchAndScreenForQuery(env, query, runSummary, discoveryCronContext(), skills, { chatId, threadId });
    }

    await logActivity(env, {
      entry: `On-demand discovery request processed: ${runSummary.evaluated} candidate(s) evaluated, ${runSummary.pendingApproval} sent for approval`,
      type: "Discovery",
      area: "Sales",
      activity: `Requested by Martin${focus ? ` -- focus: "${focus}"` : ""}. Queries: ${queries.map((q) => `"${q}"`).join(", ")}.`,
      decisionRationale: `${runSummary.screenedOut} screened out, ${runSummary.skippedAsDuplicate} skipped as duplicate, ${runSummary.skippedAlreadyPresented} already presented or recently rejected, ${runSummary.heldOverCap} held over the ${MAX_APPROVAL_CARDS_PER_RUN}-card cap, ${runSummary.presentationFailed} card(s) failed, ${runSummary.skippedAsInsufficient} skipped for insufficient evidence.${runSummary.searchUnavailable + runSummary.searchFailed > 0 ? ` Search did not complete for ${runSummary.searchUnavailable + runSummary.searchFailed} quer${runSummary.searchUnavailable + runSummary.searchFailed === 1 ? "y" : "ies"} (${runSummary.searchUnavailable} unavailable, ${runSummary.searchFailed} failed) -- absence of results from those is not evidence that nothing exists.` : ""}`,
      nextActions: runSummary.pendingApproval > 0 ? "Awaiting Martin's approval of each card. No Lead is created without it." : "No new candidate to present this run.",
      outcome: "Active",
    });

    return true;
  },
};

/**
 * Adapts LeadOpportunityDiscoveryCapability's existing on-demand discovery
 * intake to the Unit Registry manifest's readHandler shape (ENIG Operating
 * Model design doc, "The Unit Registry") -- salesManifest.ts's
 * discover_leads action. Deliberately reuses handleIntake unchanged rather
 * than reimplementing it: same governance retrieval, same
 * lead.discovery_ondemand_intake classification, same search/screening,
 * same fail-closed messages for "no web search
 * configured"/"couldn't generate a search strategy" -- this only adapts
 * WHERE the result is delivered.
 *
 * handleIntake always sends its own message directly (via
 * sendWorkspaceHatMessage) in every path where it returns true -- there is
 * no "success with nothing to say" case. Returning "" for that case is
 * therefore correct, not a loss of information: dispatch.ts's read-reply
 * path skips sending an empty string, so nothing doubles up. Only the
 * `false` case (not recognized as a discovery request at all) had its
 * fallback message living in router.ts's dispatchCowork instead of here;
 * that text is preserved verbatim below, just returned instead of sent
 * separately by the caller.
 *
 * chatId/threadId are irrelevant to what actually gets sent -- every
 * message handleIntake sends goes through sendWorkspaceHatMessage, which
 * always overrides target.chatId/threadId with the configured Workspace
 * stream target regardless of what's passed in (see telegram.ts). Martin's
 * own DM id is passed only to satisfy handleIntake's signature.
 */
export async function discoverLeadsReadHandler(env: Env, text: string, skills: ResolvedActionSkillSet): Promise<string> {
  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(env, Number(env.MARTIN_TELEGRAM_USER_ID), text, undefined, skills);
  return handled
    ? ""
    : `That didn't look like a discovery request to Lead Generation Specialist -- try something like "find me 3 companies showing a positioning problem."`;
}

/**
 * Sends the one-per-run Telegram digest to the Operations Stream
 * (never one message per Lead) and returns whether the notification succeeded.
 */
export async function notifyDiscoveryRunSummary(env: Env, chatId: number, threadId: number | undefined, summary: DiscoveryRunSummary): Promise<boolean> {
  const target = { chatId, threadId, hat: HAT_TARGET_NAME };

  try {
    if (summary.evaluated === 0) {
      const skippedSearches = summary.searchUnavailable + summary.searchFailed;
      const msgId = await sendOperationsHatMessage(
        env,
        target,
        skippedSearches > 0
          ? `Scheduled discovery run: web search could not complete for ${skippedSearches} quer${skippedSearches === 1 ? "y" : "ies"} (${summary.searchUnavailable} unavailable, ${summary.searchFailed} failed) and nothing was evaluated. This is NOT evidence that no opportunities exist -- the search itself did not run successfully.`
          : "Scheduled discovery run: searches completed but returned no results to evaluate this cycle.",
      );
      return msgId !== undefined;
    }

    const searchNote =
      summary.searchUnavailable + summary.searchFailed > 0
        ? ` Search did not complete for ${summary.searchUnavailable + summary.searchFailed} quer${summary.searchUnavailable + summary.searchFailed === 1 ? "y" : "ies"} (${summary.searchUnavailable} unavailable, ${summary.searchFailed} failed) -- absence of results from those is not evidence that nothing exists.`
        : "";
    const duplicateCheckNote =
      summary.duplicateCheckFailed > 0
        ? ` ${summary.duplicateCheckFailed} candidate(s) passed screening but could not be checked for duplicates, so no card was shown for them (see Blockers) -- that is a Notion read failure, not evidence those organisations are new.`
        : "";
    const lines = [
      `Scheduled discovery run: ${summary.evaluated} candidate(s) evaluated, ${summary.pendingApproval} sent to the Workspace topic for your approval, ${summary.screenedOut} screened out, ${summary.skippedAsDuplicate} skipped as possible duplicate(s), ${summary.skippedAlreadyPresented} already presented or recently rejected, ${summary.heldOverCap} held over the ${MAX_APPROVAL_CARDS_PER_RUN}-card cap, ${summary.skippedAsInsufficient} skipped for insufficient evidence.${summary.presentationFailed > 0 ? ` ${summary.presentationFailed} approval card(s) could not be sent (see Blockers).` : ""}${duplicateCheckNote}${searchNote}`,
    ];
    if (summary.pendingApproval > 0) {
      lines.push("", "No Lead is created until you approve each finding in the Workspace topic.");
    }

    const msgId = await sendOperationsHatMessage(env, target, lines.join("\n"));
    return msgId !== undefined;
  } catch (err) {
    console.error("notifyDiscoveryRunSummary: Telegram notification failed", err);
    return false;
  }
}
