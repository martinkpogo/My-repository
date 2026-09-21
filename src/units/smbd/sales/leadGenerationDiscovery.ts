import type { Env, WorkState } from "../../../types";
import { isWebSearchConfigured, searchWeb } from "../../research/webSearch";
import type { WebSearchResult } from "../../research/webSearch";
import { createPage, plainText, queryDataSource, richText, select, title } from "../../../notion";
import { aiJson } from "../../../ai";
import { logActivity } from "../../../log";
import { sendOperationsHatMessage, sendWorkspaceHatMessage } from "../../../telegram";
import type { HatMessageTarget } from "../../../telegram";
import { getLeadDiscoveryGovernance, findDuplicateLeads, isCheckableUrl } from "./leadDiscovery";
import { ActionCapability, registerActionCapability } from "../../../actions/registry";
import { getSessionStub, newWorkId } from "../../../router";

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
 */
async function evaluateCandidates(env: Env, results: WebSearchResult[]): Promise<CandidateEvaluation[]> {
  if (results.length === 0) return [];

  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    console.error("Autonomous Lead Discovery: evaluation blocked -- governance retrieval failed");
    return [];
  }

  const candidatesText = results
    .map((r, i) => `[${i}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}${r.publishedDate ? `\nPublished: ${r.publishedDate}` : ""}`)
    .join("\n\n");

  const response = await aiJson<EvaluationBatchResponse>(env, {
    taskId: "lead.discovery_signal_evaluation",
    system: [
      "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition (including its Acquisition Criteria section) are authoritative for this role -- follow them exactly as written.",
      "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
      governance.universalRoleContract,
      "=== HAT DEFINITION ===",
      governance.hatDefinition,
      "=== TASK (execution mechanics -- not part of the governance above) ===",
      "You are given several public web search results. Evaluate EACH one independently against the Acquisition Criteria section above -- operating business, strategic/commercial problem signal, business consequence, ENIG relevance, consultancy-readiness, reachability, and the evidence-threshold hard gate. Base every judgment strictly on the title/url/snippet given -- never invent a fact, a decision-maker, or a contact detail that isn't present in the text. If the snippet doesn't support a criterion, that criterion is not met -- do not assume it. Record an observation (e.g. \"expanded from X into Y but public positioning still emphasises X\"), never a diagnosis (never \"this company has bad marketing\"). A commodity request (logo/generic graphic design/social media graphics/basic branding) or mere existence/size/industry is never sufficient to pass.",
      'Return JSON: {"candidates": [{"pass": true|false, "organisation": "<name if identifiable, else empty string>", "evidence": "<the disciplined observation, or empty string if pass is false>", "decisionMakerOrRole": "<only if explicitly named/implied in the text, else empty string>", "category": "<short label, or empty string>", "reason": "..."}, ...]} -- exactly one entry per result given, in the same order.',
    ].join("\n\n"),
    user: candidatesText,
    light: true,
    maxTokens: 3000,
  });

  return response?.candidates ?? [];
}

interface DiscoveryRunSummary {
  evaluated: number;
  handoffsCreated: number;
  /**
   * Evidence-backed opportunity findings presented to Martin for approval
   * this run -- never Leads created. No discovery source (scheduled or
   * on-demand) may create a Lead without Martin's explicit approval; see
   * proposeLeadOpportunity/handleLeadOpportunityApproval below.
   */
  pendingApproval: number;
  screenedOut: number;
  skippedAsDuplicate: number;
  skippedAsInsufficient: number;
}

function emptyDiscoveryRunSummary(): DiscoveryRunSummary {
  return { evaluated: 0, handoffsCreated: 0, pendingApproval: 0, screenedOut: 0, skippedAsDuplicate: 0, skippedAsInsufficient: 0 };
}

export const LGS_HANDOFF_ORIGIN_MARKER = "LGS Autonomous Lead Discovery";

/**
 * Checks if a pending or completed LGS research request already exists for
 * the candidate organisation or source URL to prevent duplicate handoffs.
 */
async function findExistingLGSResearchHandoff(env: Env, organisation: string, sourceUrl: string): Promise<boolean> {
  try {
    const handoffs = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
      and: [
        { property: "From Unit", select: { equals: "Sales" } },
        { property: "To Unit", select: { equals: "Research & Intelligence" } },
        { property: "Type", select: { equals: "Work" } },
      ],
    });

    for (const h of handoffs) {
      const reason = plainText(h.properties.Reason);
      const facts = plainText(h.properties["Verified Facts & Sources"]);
      if (
        reason.includes(LGS_HANDOFF_ORIGIN_MARKER) &&
        (facts.includes(organisation) || (sourceUrl && facts.includes(sourceUrl)))
      ) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error("Failed checking existing LGS research handoffs", err);
    return false;
  }
}

interface AcquisitionCriteriaEvaluationResponse {
  pass: boolean;
  organisation: string;
  evidence: string;
  reason: string;
}

/**
 * Evaluates completed R&I research against canonical Acquisition Criteria.
 * Strictly differentiates between observable evidence, findings, preliminary
 * hypothesis, and the acquisition decision -- an unsupported R&I hypothesis
 * is never converted into a fact and does not satisfy criteria on its own.
 */
async function evaluateResearchAgainstAcquisitionCriteria(
  env: Env,
  contextText: string,
  synthesisText: string,
): Promise<AcquisitionCriteriaEvaluationResponse | null> {
  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    console.error("Autonomous Lead Discovery: research evaluation blocked -- governance retrieval failed");
    return null;
  }

  return aiJson<AcquisitionCriteriaEvaluationResponse>(env, {
    taskId: "lead.discovery_signal_evaluation",
    system: [
      "You are executing the Lead Generation Specialist Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition (including its Acquisition Criteria section) are authoritative for this role -- follow them exactly as written.",
      "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
      governance.universalRoleContract,
      "=== HAT DEFINITION ===",
      governance.hatDefinition,
      "=== TASK (execution mechanics -- not part of the governance above) ===",
      "You are given candidate signal context and completed Research & Intelligence synthesis (findings, implications, limitations, sources). Evaluate whether the canonical Acquisition Criteria section above is genuinely satisfied by attributable evidence.",
      "CRITICAL RULE ON DISTINCTION: Differentiate strictly between observable evidence, R&I findings, preliminary diagnosis/hypothesis, and the acquisition decision. An unsupported or speculative preliminary diagnosis/hypothesis from R&I is NOT a fact and CANNOT satisfy the Acquisition Criteria by itself. Only evidence-backed findings satisfy the criteria.",
      'Return JSON: {"pass": true|false, "organisation": "<name if identifiable, else empty string>", "evidence": "<the attributable evidence observation>", "reason": "..."}.',
    ].join("\n\n"),
    user: `Candidate Signal Context:\n${contextText}\n\nCompleted R&I Research Synthesis:\n${synthesisText}`,
    light: true,
    maxTokens: 3000,
  });
}

/**
 * Processes completed R&I Research Handoffs originating from LGS autonomous
 * discovery. Only consumes closed R&I handoffs marked with LGS_HANDOFF_ORIGIN_MARKER
 * and From Hat Lead Generation Specialist. Idempotent per KV state.
 */
export async function processCompletedLGSResearchHandoffs(env: Env, summary: DiscoveryRunSummary): Promise<void> {
  try {
    const completedHandoffs = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
      and: [
        { property: "From Unit", select: { equals: "Sales" } },
        { property: "To Unit", select: { equals: "Research & Intelligence" } },
        { property: "Type", select: { equals: "Work" } },
        { property: "Status", select: { equals: "Closed" } },
      ],
    });

    for (const handoff of completedHandoffs) {
      const fromHat = plainText(handoff.properties["From Hat"]);
      const reason = plainText(handoff.properties.Reason);

      // Filter: must strictly originate from LGS autonomous discovery workflow
      if (fromHat !== "Lead Generation Specialist" || !reason.includes(LGS_HANDOFF_ORIGIN_MARKER)) {
        continue;
      }

      // Idempotency check: skip if already processed by LGS
      const alreadyProcessed = await env.STATE_KV.get(`lgs_processed_handoff:${handoff.id}`);
      if (alreadyProcessed) continue;

      const facts = plainText(handoff.properties["Verified Facts & Sources"]);
      const workCompleted = plainText(handoff.properties["Work Completed"]);

      if (!workCompleted) {
        await env.STATE_KV.put(`lgs_processed_handoff:${handoff.id}`, "insufficient");
        summary.skippedAsInsufficient++;
        continue;
      }

      const evalResult = await evaluateResearchAgainstAcquisitionCriteria(env, facts, workCompleted);
      await env.STATE_KV.put(`lgs_processed_handoff:${handoff.id}`, "processed");

      if (!evalResult || !evalResult.pass) {
        summary.screenedOut++;
        await logActivity(env, {
          entry: `Autonomous discovery screened out after R&I research: ${evalResult?.organisation || handoff.id}`,
          type: "Discovery",
          area: "Sales",
          decisionRationale: evalResult?.reason || "Research synthesis did not satisfy Acquisition Criteria.",
          outcome: "Complete",
        });
        continue;
      }

      if (!evalResult.organisation.trim() || !evalResult.evidence.trim()) {
        summary.skippedAsInsufficient++;
        continue;
      }

      let duplicates: Awaited<ReturnType<typeof findDuplicateLeads>>;
      try {
        duplicates = await findDuplicateLeads(env, evalResult.organisation, "");
      } catch (err) {
        console.error(`Autonomous Lead Discovery: duplicate check failed for ${evalResult.organisation}`, err);
        await logActivity(env, {
          entry: `Autonomous discovery blocked -- duplicate check failed: ${evalResult.organisation}`,
          type: "Blocker",
          area: "Sales",
          decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
          outcome: "Blocked",
        });
        continue;
      }
      if (duplicates.length > 0) {
        summary.skippedAsDuplicate++;
        await logActivity(env, {
          entry: `Autonomous discovery skipped after research -- possible duplicate: ${evalResult.organisation}`,
          type: "Discovery",
          area: "Sales",
          decisionRationale: `Matches existing Lead(s): ${duplicates.map((d) => d.name).join(", ")}`,
          outcome: "Complete",
        });
        continue;
      }

      const category = facts.match(/Category:\s*(.+)/i)?.[1]?.trim();
      const sourceUrl = facts.match(/Source URL:\s*(https?:\/\/\S+)/i)?.[1] || "";

      try {
        const workId = newWorkId();
        const stub = getSessionStub(env, workId);
        // No live chat behind this -- same "no prior session" fallback
        // discoverPendingFinanceHandoffs uses for an externally-originated
        // Handoff: default to Martin's DM identity. sendWorkspaceHatMessage
        // always routes to the shared Workspace topic regardless, so this
        // is purely the WorkState's own identity, not where the message lands.
        await stub.init(workId, Number(env.MARTIN_TELEGRAM_USER_ID), "Sales", "Lead Generation Specialist", undefined, {
          handoffId: handoff.id,
        });
        await stub.proposeLeadOpportunity({
          organisation: evalResult.organisation,
          evidence: evalResult.evidence,
          reason: evalResult.reason,
          category,
          sourceUrl,
          handoffId: handoff.id,
        });
        summary.pendingApproval++;
      } catch (err) {
        console.error(`Autonomous Lead Discovery: failed to present opportunity for approval: ${evalResult.organisation}`, err);
        await logActivity(env, {
          entry: `Autonomous discovery blocked -- could not present opportunity for approval: ${evalResult.organisation}`,
          type: "Blocker",
          area: "Sales",
          decisionRationale: err instanceof Error ? err.message : String(err),
          outcome: "Blocked",
        });
      }
    }
  } catch (err) {
    console.error("Error processing completed LGS research handoffs", err);
  }
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
    const page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
      Lead: title(opportunity.organisation),
      Organisation: richText(opportunity.organisation),
      Contact: richText(""),
      "Contact Details": richText(""),
      Source: richText(opportunity.sourceUrl || ""),
      "Discovery Evidence": richText(opportunity.evidence),
      Status: select("New"),
    });

    await logActivity(env, {
      entry: `Lead recorded (Martin-approved opportunity): ${opportunity.organisation}`,
      type: "Discovery",
      area: "Sales",
      activity: "Source verified with R&I research evidence. Approved by Martin.",
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
 * Searches one query, screens its results against the Acquisition
 * Criteria, and creates a Sales -> R&I Work Handoff for each candidate
 * that passes -- the shared Phase 1 body for BOTH the fixed scheduled
 * query list and an on-demand request's AI-generated queries. Identical
 * either way: which query fed it is the only difference, so both paths
 * share the exact same screening discipline and the exact same downstream
 * approval gate (Phase 2 -- see processCompletedLGSResearchHandoffs).
 */
async function searchAndHandoffForQuery(env: Env, query: string, summary: DiscoveryRunSummary): Promise<void> {
  const results = (await searchWeb(env, query)).slice(0, MAX_RESULTS_PER_QUERY);
  if (results.length === 0) return;

  const evaluations = await evaluateCandidates(env, results);
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

    const existingHandoff = await findExistingLGSResearchHandoff(env, evaluation.organisation, result.url);
    if (existingHandoff) {
      summary.skippedAsDuplicate++;
      continue;
    }

    try {
      await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, {
        Handoff: title(`LGS Research Request -- ${evaluation.organisation}`),
        "From Unit": select("Sales"),
        "From Hat": richText("Lead Generation Specialist"),
        "To Unit": select("Research & Intelligence"),
        "To Hat": richText("Research & Intelligence Analyst"),
        Type: select("Work"),
        Status: select("Pending"),
        Reason: richText(`${LGS_HANDOFF_ORIGIN_MARKER}: Research organisation positioning and evidence for Acquisition Criteria evaluation.`),
        "Expected Output": richText("Evidence-backed research relevant to the Acquisition Criteria, including a preliminary diagnosis/hypothesis where supported by evidence."),
        Entity_Token: richText("E-UNBOUND"),
        Matter_Token: richText("M-UNBOUND"),
        "Verified Facts & Sources": richText(
          `Candidate Organisation: ${evaluation.organisation}\nSource URL: ${result.url}\nCategory: ${evaluation.category || "unclassified"}\nInitial Signal Evidence: ${evaluation.evidence}\nDecision Maker / Role: ${evaluation.decisionMakerOrRole || "N/A"}\nQuery: "${query}"`,
        ),
      });
      summary.handoffsCreated++;
      await logActivity(env, {
        entry: `R&I research handoff created for discovery candidate: ${evaluation.organisation}`,
        type: "Discovery",
        area: "Sales",
        activity: `Category: ${evaluation.category || "unclassified"}. Source: ${result.url}. Query: "${query}".`,
        decisionRationale: evaluation.reason,
        nextActions: "Pending R&I research execution.",
        outcome: "Active",
      });
    } catch (err) {
      console.error(`Lead Discovery: Handoff creation failed for ${evaluation.organisation}`, err);
      await logActivity(env, {
        entry: `Lead discovery handoff creation blocked: ${evaluation.organisation}`,
        type: "Blocker",
        area: "Sales",
        decisionRationale: `Notion call against HANDOFFS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
        outcome: "Blocked",
      });
    }
  }
}

/**
 * Runs one full autonomous discovery cycle:
 * 1. Search & Lightweight Screening -> create Pending Work Handoff to R&I
 * 2. Process completed R&I research handoffs -> evaluate Acquisition Criteria -> present for approval
 */
export async function runAutonomousLeadDiscovery(env: Env): Promise<DiscoveryRunSummary> {
  const summary = emptyDiscoveryRunSummary();

  if (!isWebSearchConfigured(env)) {
    console.error("Autonomous Lead Discovery: no web search provider configured -- nothing to do");
    return summary;
  }

  // Phase 1: Search & lightweight screening -> create R&I Work Handoffs
  for (const query of DISCOVERY_QUERIES) {
    await searchAndHandoffForQuery(env, query, summary);
  }

  // Phase 2: Consume completed R&I research -> evaluate criteria -> present for Martin's approval
  await processCompletedLGSResearchHandoffs(env, summary);

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

  const response = await aiJson<OnDemandQueryGenerationResponse>(env, {
    taskId: "lead.discovery_ondemand_query_generation",
    system: [
      "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition (including its Acquisition Criteria section) are authoritative for this role -- follow them exactly as written.",
      "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
      governance.universalRoleContract,
      "=== HAT DEFINITION ===",
      governance.hatDefinition,
      "=== TASK (execution mechanics -- not part of the governance above) ===",
      `Martin has asked you to proactively search for organisations showing evidence of a problem worth investigating${focus ? `, specifically: "${focus}"` : ""}. Generate exactly ${count} distinct web search queries likely to surface real organisations exhibiting the kind of strategic/commercial problem signal the Acquisition Criteria describe (criterion 2) -- unclear/inconsistent positioning, difficulty explaining the offer, a market/model change without a corresponding positioning update, stagnant growth, a rebrand without evident strategic clarity, fragmented cross-channel messaging, or a perceived market position weaker than actual capability${focus ? ", scoped to the specific focus given above" : ""}. Each query must search for an observable situation or statement, never presuppose a negative diagnosis (never use words like poor/bad/confused/ineffective/weak/failing), and never name a specific organisation -- you are generating a search strategy, not a company list.`,
      'Return JSON: {"queries": ["...", ...]} with exactly the requested number of distinct query strings.',
    ].join("\n\n"),
    user: focus || "No specific focus given -- search broadly across the Acquisition Criteria's problem-signal categories.",
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
 * waiting for the next scheduled cycle. Reuses the exact same search,
 * screening, and R&I Handoff creation as scheduled discovery
 * (searchAndHandoffForQuery) -- the only difference is where the query
 * list comes from (AI-generated from Martin's stated focus, instead of
 * the fixed DISCOVERY_QUERIES list) and that it's triggered by a chat
 * message instead of a cron tick. Results still arrive asynchronously,
 * once R&I's own scheduled pickup researches each Handoff and Phase 2
 * evaluates it -- this never bypasses that, and never bypasses the
 * approval gate either, since Phase 2 is shared code.
 */
export const LeadOpportunityDiscoveryCapability: ActionCapability = {
  id: "sales.lead_opportunity_discovery",
  name: "Lead Generation Specialist On-Demand Discovery Capability",
  description:
    "Runs on-demand opportunity discovery when Martin asks Lead Generation Specialist to proactively find companies showing evidence of a problem worth investigating.",
  async handleIntake(env: Env, chatId: number, text: string, threadId?: number): Promise<boolean> {
    const classification = await aiJson<OnDemandIntakeClassification>(env, {
      taskId: "lead.discovery_ondemand_intake",
      system: `You classify incoming messages for ENIG's Lead Generation Specialist on-demand discovery capability.
Check if Martin is asking ENIG's own team to PROACTIVELY DISCOVER/FIND new potential companies/organisations to investigate as possible clients -- e.g. "find me 3 companies showing a positioning problem", "look for businesses with weak differentiation worth reaching out to", "search for organisations that might need our help".
This is NOT: a prospective client's own enquiry about their own company (that is a Sales enquiry), a request to research a SPECIFIC NAMED company or market (that is Research & Intelligence), or general chat/small talk.
If yes, set isDiscoveryRequest to true, extract the requested count as an integer if one was stated (otherwise omit the field), and a short restatement of the problem/situation focus requested (e.g. "positioning or communication problem"), or an empty string if no specific focus was given.
Return JSON: {"isDiscoveryRequest": true | false, "count": <integer, omit if not stated>, "focus": "..."}`,
      user: text,
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
      `🔍 Searching for organisations showing evidence of${focus ? ` ${focus}` : " a positioning, communication, or growth problem worth investigating"} (up to ${requestedCount}). Each promising signal goes to Research & Intelligence for evidence-backed investigation -- I'll bring findings back here for your approval as they're ready. This runs across the next few discovery cycles, not instantly.`,
    );

    const runSummary = emptyDiscoveryRunSummary();
    for (const query of queries) {
      await searchAndHandoffForQuery(env, query, runSummary);
    }

    await logActivity(env, {
      entry: `On-demand discovery request processed: ${runSummary.evaluated} candidate(s) evaluated, ${runSummary.handoffsCreated} sent to R&I`,
      type: "Discovery",
      area: "Sales",
      activity: `Requested by Martin${focus ? ` -- focus: "${focus}"` : ""}. Queries: ${queries.map((q) => `"${q}"`).join(", ")}.`,
      decisionRationale: `${runSummary.screenedOut} screened out, ${runSummary.skippedAsDuplicate} skipped as duplicate, ${runSummary.skippedAsInsufficient} skipped for insufficient evidence.`,
      nextActions: runSummary.handoffsCreated > 0 ? "Awaiting R&I research, then Martin's approval before any Lead is created." : "No promising signal found this run.",
      outcome: "Active",
    });

    return true;
  },
};

registerActionCapability(LeadOpportunityDiscoveryCapability);

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
      `Scheduled discovery run: ${summary.evaluated} candidate(s) evaluated, ${summary.handoffsCreated} R&I research handoff(s) created, ${summary.pendingApproval} opportunity finding(s) sent to the Workspace topic for your approval, ${summary.screenedOut} screened out, ${summary.skippedAsDuplicate} skipped as possible duplicate(s), ${summary.skippedAsInsufficient} skipped for insufficient evidence.`,
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
