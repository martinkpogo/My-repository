import type { Env, WorkState } from "../../types";
import { isWebSearchConfigured, searchWeb } from "../../runtime/research/webSearch";
import type { WebSearchResult } from "../../runtime/research/webSearch";
import { createPage, richText, select, title } from "../../notion";
import { generate } from "../../ai";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import { logActivity } from "../../log";
import { sendOperationsHatMessage, sendWorkspaceHatMessage } from "../../telegram";
import type { HatMessageTarget } from "../../telegram";
import { getLeadDiscoveryGovernance, findDuplicateLeads, isCheckableUrl } from "./leadDiscovery";
import { discoveryCronContext, workSessionContext, type AccessContext } from "../../access";

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

/**
 * Evaluates one query's search results in a single AI call against the
 * full canonical governance (including Acquisition Criteria) -- operates
 * only on the search results' own title/url/snippet, exactly as retrieved;
 * never fabricates a decision-maker, contact, or fact the snippet doesn't
 * contain. Returns [] (not null) on governance/AI failure so one failed
 * query doesn't abort the rest of the run -- the caller logs the failure.
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
export async function evaluateCandidates(env: Env, results: WebSearchResult[], skills: ResolvedActionSkillSet): Promise<CandidateEvaluation[]> {
  if (results.length === 0) return [];

  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    console.error("Autonomous Lead Discovery: evaluation blocked -- governance retrieval failed");
    return [];
  }

  const skillContent = skills.get("research_signal").content;

  const candidatesText = results
    .map((r, i) => `[${i}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}${r.publishedDate ? `\nPublished: ${r.publishedDate}` : ""}`)
    .join("\n\n");

  const response = await generate<EvaluationBatchResponse>(env, {
    taskId: "lead.discovery_signal_evaluation",
    mode: "json",
    parts: {
      persona: `You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Hat Definition (including its Acquisition Criteria section) is authoritative for this role -- follow it exactly as written.\n\n=== HAT DEFINITION ===\n${governance.hatDefinition}`,
      behavior: governance.universalRoleContract,
      skillContent,
      context: candidatesText,
      situation: `Evaluate EACH of the search results above independently against the Acquisition Criteria section in the Hat Definition -- operating business, strategic/commercial problem signal, business consequence, ENIG relevance, consultancy-readiness, reachability, and the evidence-threshold hard gate. If the snippet doesn't support a criterion, that criterion is not met -- do not assume it. A commodity request (logo/generic graphic design/social media graphics/basic branding) or mere existence/size/industry is never sufficient to pass.\n\nReturn JSON: {"candidates": [{"pass": true|false, "organisation": "<name if identifiable, else empty string>", "evidence": "<the disciplined observation, or empty string if pass is false>", "decisionMakerOrRole": "<only if explicitly named/implied in the text, else empty string>", "category": "<short label, or empty string>", "reason": "..."}, ...]} -- exactly one entry per result given, in the same order.`,
    },
    light: true,
    maxTokens: 3000,
  });

  return response?.candidates ?? [];
}

interface DiscoveryRunSummary {
  evaluated: number;
  /**
   * Candidates that passed screening and are not duplicates, but were
   * HELD: the evidence-validation step that used to follow screening
   * (a Handoff to the retired Research & Intelligence Unit) no longer
   * exists, and no owning Action for it has been designed yet. A held
   * candidate is neither routed anywhere nor turned into a Lead.
   */
  heldNoResearchPath: number;
  /**
   * Evidence-backed opportunity findings presented to Martin for approval
   * this run -- never Leads created. No discovery source (scheduled or
   * on-demand) may create a Lead without Martin's explicit approval; see
   * proposeLeadOpportunity/handleLeadOpportunityApproval below. Nothing
   * currently feeds that gate (see heldNoResearchPath).
   */
  pendingApproval: number;
  screenedOut: number;
  skippedAsDuplicate: number;
  skippedAsInsufficient: number;
}

function emptyDiscoveryRunSummary(): DiscoveryRunSummary {
  return { evaluated: 0, heldNoResearchPath: 0, pendingApproval: 0, screenedOut: 0, skippedAsDuplicate: 0, skippedAsInsufficient: 0 };
}

export interface PendingLeadOpportunity {
  organisation: string;
  evidence: string;
  reason: string;
  category?: string;
  sourceUrl: string;
  handoffId: string;
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
  state.pendingLeadOpportunity = opportunity;

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
    `Evidence: ${opportunity.evidence}`,
    `Why this looks worth pursuing: ${opportunity.reason}`,
    `Source: ${opportunity.sourceUrl || "N/A"}`,
    "",
    "This is a candidate opportunity only -- no Lead has been created. Approve to record it as a Lead for Sales Executive follow-up, or reject to discard it.",
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
  const opportunity = state.pendingLeadOpportunity;
  state.pendingLeadOpportunity = undefined;
  state.pendingActionSummary = undefined;

  const target: HatMessageTarget = { chatId: state.chatId, threadId: state.threadId, hat: HAT_TARGET_NAME, workId: state.workId };

  if (!opportunity) {
    await sendWorkspaceHatMessage(env, target, "No valid pending opportunity finding found for this work item.");
    return state;
  }

  if (!approved) {
    await logActivity(env, {
      entry: `Opportunity finding rejected: ${opportunity.organisation}`,
      type: "Discovery",
      area: "Sales",
      decisionRationale: "Rejected by Martin.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, target, `Opportunity rejected for *${opportunity.organisation}*. No Lead was created.`);
    return state;
  }

  let duplicates: Awaited<ReturnType<typeof findDuplicateLeads>>;
  try {
    duplicates = await findDuplicateLeads(env, opportunity.organisation, "");
  } catch (err) {
    console.error(`Lead Opportunity Approval: duplicate check failed for ${opportunity.organisation}`, err);
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Couldn't verify this isn't a duplicate before creating the Lead for *${opportunity.organisation}* -- the Leads database check failed. Not created. Please try approving again.`,
    );
    return state;
  }
  if (duplicates.length > 0) {
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
    // Authorized as a governed write, judged against the Action this Work
    // records. That Action is discover_leads -- a READ action -- because
    // searching for and screening opportunities is exactly what it is, and
    // a read Action must never authorize a write (see access.ts's
    // consequencePermits). Access refuses this create for that reason, by
    // design: committing a Lead record is a different operation from finding
    // candidates, and the registry declares no Action for it yet.
    const page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
      Lead: title(opportunity.organisation),
      Organisation: richText(opportunity.organisation),
      Contact: richText(""),
      "Contact Details": richText(""),
      Source: richText(opportunity.sourceUrl || ""),
      "Discovery Evidence": richText(opportunity.evidence),
      Status: select("New"),
    }, workSessionContext(state));

    await logActivity(env, {
      entry: `Lead recorded (Martin-approved opportunity): ${opportunity.organisation}`,
      type: "Discovery",
      area: "Sales",
      activity: "Source and evidence presented for approval. Approved by Martin.",
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
    await logActivity(env, {
      entry: `Opportunity approval blocked -- Leads database unavailable: ${opportunity.organisation}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      target,
      `⚠️ Couldn't record this Lead for *${opportunity.organisation}* -- the Leads database call failed. Not created. Please try approving again once resolved.`,
    );
  }

  return state;
}

/**
 * Searches one query and screens its results against the Acquisition
 * Criteria -- the shared body for BOTH the fixed scheduled query list and
 * an on-demand request's AI-generated queries.
 *
 * A candidate that survives screening and the duplicate-Lead check is
 * HELD, not routed: the step that used to follow (a Handoff to the retired
 * research Unit, later consumed to evaluate the Acquisition Criteria)
 * belonged to a retired organizational structure, and no owning
 * Action for evidence-backed validation of a discovery candidate has been
 * designed. This function therefore creates no Handoff and no Lead, and
 * records nothing about the candidate beyond the run summary -- a later
 * owning Action will take it from here.
 */
async function searchAndScreenForQuery(env: Env, query: string, summary: DiscoveryRunSummary, access: AccessContext, skills: ResolvedActionSkillSet): Promise<void> {
  const results = (await searchWeb(env, query, access)).slice(0, MAX_RESULTS_PER_QUERY);
  if (results.length === 0) return;

  const evaluations = await evaluateCandidates(env, results, skills);
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const evaluation = evaluations[i];
    summary.evaluated++;

    if (!evaluation || !evaluation.pass) {
      summary.screenedOut++;
      continue;
    }

    if (!evaluation.organisation.trim() || !evaluation.evidence.trim() || !isCheckableUrl(result.url)) {
      summary.skippedAsInsufficient++;
      continue;
    }

    let duplicateLead: Awaited<ReturnType<typeof findDuplicateLeads>>;
    try {
      duplicateLead = await findDuplicateLeads(env, evaluation.organisation, "");
    } catch (err) {
      console.error(`Lead Discovery: duplicate check failed for ${evaluation.organisation}`, err);
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

    summary.heldNoResearchPath++;
  }
}

/**
 * Runs one autonomous discovery cycle: search and lightweight screening
 * against the Acquisition Criteria. Candidates that pass are held (see
 * searchAndScreenForQuery); no Handoff or Lead is created.
 */
export async function runAutonomousLeadDiscovery(env: Env, skills: ResolvedActionSkillSet): Promise<DiscoveryRunSummary> {
  const summary = emptyDiscoveryRunSummary();

  if (!isWebSearchConfigured(env)) {
    console.error("Autonomous Lead Discovery: no web search provider configured -- nothing to do");
    return summary;
  }

  // This is the Kernel's own scheduled loop, not a Unit's Work item, so the
  // outbound search is authorized as a Kernel-owned read rather than under any
  // registered Action -- see evaluateExternalEgress.
  for (const query of DISCOVERY_QUERIES) {
    await searchAndScreenForQuery(env, query, summary, discoveryCronContext(), skills);
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
      `🔍 Searching for organisations showing evidence of${focus ? ` ${focus}` : " a positioning, communication, or growth problem worth investigating"} (up to ${requestedCount}). Candidates that pass screening are held -- evidence-backed validation of a discovery candidate has no owning step yet, so nothing is routed onward and no Lead is created.`,
    );

    const runSummary = emptyDiscoveryRunSummary();
    for (const query of queries) {
      // Same Kernel-owned read as the scheduled loop above: an on-demand
      // discovery request runs the same discovery capability, so it is
      // authorized the same way.
      await searchAndScreenForQuery(env, query, runSummary, discoveryCronContext(), skills);
    }

    await logActivity(env, {
      entry: `On-demand discovery request processed: ${runSummary.evaluated} candidate(s) evaluated, ${runSummary.heldNoResearchPath} held (no research path)`,
      type: "Discovery",
      area: "Sales",
      activity: `Requested by Martin${focus ? ` -- focus: "${focus}"` : ""}. Queries: ${queries.map((q) => `"${q}"`).join(", ")}.`,
      decisionRationale: `${runSummary.screenedOut} screened out, ${runSummary.skippedAsDuplicate} skipped as duplicate, ${runSummary.skippedAsInsufficient} skipped for insufficient evidence.`,
      nextActions: runSummary.heldNoResearchPath > 0 ? "Candidates held: no owning Action exists yet for evidence-backed validation. No Lead is created without Martin's approval." : "No promising signal found this run.",
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
      const msgId = await sendOperationsHatMessage(
        env,
        target,
        "Scheduled discovery run: no web search results to evaluate this cycle (search unconfigured, or nothing returned)."
      );
      return msgId !== undefined;
    }

    const lines = [
      `Scheduled discovery run: ${summary.evaluated} candidate(s) evaluated, ${summary.heldNoResearchPath} held with no research path, ${summary.pendingApproval} opportunity finding(s) sent to the Workspace topic for your approval, ${summary.screenedOut} screened out, ${summary.skippedAsDuplicate} skipped as possible duplicate(s), ${summary.skippedAsInsufficient} skipped for insufficient evidence.`,
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
