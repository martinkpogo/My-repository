import type { Env } from "../../../types";
import { isWebSearchConfigured, searchWeb } from "../../research/webSearch";
import type { WebSearchResult } from "../../research/webSearch";
import { createPage, plainText, queryDataSource, richText, select, title } from "../../../notion";
import { aiJson } from "../../../ai";
import { logActivity } from "../../../log";
import { sendHatMessage } from "../../../telegram";
import { getLeadDiscoveryGovernance, findDuplicateLeads, isCheckableUrl } from "./leadDiscovery";

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

// Fixed queries structured around 5 observable business situation categories:
// (1) Repositioning and strategic brand change, (2) Market and customer expansion,
// (3) Offering and business-model change, (4) Growth and strategic change, and
// (5) Communication and positioning signals.
//
// These search for observable evidence, announcements, or statements without
// presupposing a negative diagnosis (avoiding terms like "bad branding" or
// "ineffective marketing"). Deliberately problem-signal-driven and not industry-scoped.
export const DISCOVERY_QUERIES = [
  // Category 1: Repositioning and strategic brand change
  "company announces brand repositioning",
  "strategic rebrand announcement",
  "market positioning change strategy",
  // Category 2: Market and customer expansion
  "company expanding into new geographic markets",
  "expansion into enterprise customer segment",
  "moving upmarket product expansion",
  // Category 3: Offering and business-model change
  "company launches new service offering",
  "business model transition announcement",
  "offering portfolio diversification",
  // Category 4: Growth and strategic change
  "company scaling funding expansion initiative",
  "strategic acquisition market entry",
  "strategic leadership changes growth strategy",
  // Category 5: Communication and positioning signals
  "company clarifies value proposition",
  "brand messaging update announcement",
  "market positioning public statement",
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
  recorded: { organisation: string; url: string }[];
  screenedOut: number;
  skippedAsDuplicate: number;
  skippedAsInsufficient: number;
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

      const duplicates = await findDuplicateLeads(env, evalResult.organisation, "");
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

      try {
        const page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
          Lead: title(evalResult.organisation),
          Organisation: richText(evalResult.organisation),
          Contact: richText(""),
          "Contact Details": richText(""),
          Source: richText(facts.match(/Source URL:\s*(https?:\/\/\S+)/i)?.[1] || facts),
          "Discovery Evidence": richText(evalResult.evidence),
          Status: select("New"),
        });
        summary.recorded.push({ organisation: evalResult.organisation, url: page.url });
        await logActivity(env, {
          entry: `Lead recorded (autonomous discovery after R&I research): ${evalResult.organisation}`,
          type: "Discovery",
          area: "Sales",
          activity: `Source verified with R&I research evidence.`,
          decisionRationale: evalResult.reason,
          nextActions: "Prepared for Sales Executive follow-up.",
          outcome: "Complete",
        });
      } catch (err) {
        console.error(`Autonomous Lead Discovery: Leads DB write failed for ${evalResult.organisation}`, err);
        await logActivity(env, {
          entry: `Autonomous discovery blocked -- Leads database unavailable: ${evalResult.organisation}`,
          type: "Blocker",
          area: "Sales",
          decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
          outcome: "Blocked",
        });
      }
    }
  } catch (err) {
    console.error("Error processing completed LGS research handoffs", err);
  }
}

/**
 * Runs one full autonomous discovery cycle:
 * 1. Search & Lightweight Screening -> create Pending Work Handoff to R&I
 * 2. Process completed R&I research handoffs -> evaluate Acquisition Criteria -> create Lead
 */
export async function runAutonomousLeadDiscovery(env: Env): Promise<DiscoveryRunSummary> {
  const summary: DiscoveryRunSummary = {
    evaluated: 0,
    handoffsCreated: 0,
    recorded: [],
    screenedOut: 0,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
  };

  if (!isWebSearchConfigured(env)) {
    console.error("Autonomous Lead Discovery: no web search provider configured -- nothing to do");
    return summary;
  }

  // Phase 1: Search & lightweight screening -> create R&I Work Handoffs
  for (const query of DISCOVERY_QUERIES) {
    const results = (await searchWeb(env, query)).slice(0, MAX_RESULTS_PER_QUERY);
    if (results.length === 0) continue;

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

      const duplicateLead = await findDuplicateLeads(env, evaluation.organisation, "");
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
        console.error(`Autonomous Lead Discovery: Handoff creation failed for ${evaluation.organisation}`, err);
        await logActivity(env, {
          entry: `Autonomous discovery handoff creation blocked: ${evaluation.organisation}`,
          type: "Blocker",
          area: "Sales",
          decisionRationale: `Notion call against HANDOFFS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
          outcome: "Blocked",
        });
      }
    }
  }

  // Phase 2: Consume completed R&I research -> evaluate criteria -> create Leads
  await processCompletedLGSResearchHandoffs(env, summary);

  return summary;
}

/**
 * Sends the one-per-run Telegram digest (never one message per Lead, to
 * avoid spamming three times a day) and returns whether anything material
 * happened, for the caller's own logging.
 */
export async function notifyDiscoveryRunSummary(env: Env, chatId: number, threadId: number | undefined, summary: DiscoveryRunSummary): Promise<void> {
  const target = { chatId, threadId, hat: HAT_TARGET_NAME };

  if (summary.evaluated === 0) {
    await sendHatMessage(env, target, "Scheduled discovery run: no web search results to evaluate this cycle (search unconfigured, or nothing returned).");
    return;
  }

  const lines = [
    `Scheduled discovery run: ${summary.evaluated} candidate(s) evaluated, ${summary.handoffsCreated} R&I research handoff(s) created, ${summary.recorded.length} recorded as Lead(s), ${summary.screenedOut} screened out, ${summary.skippedAsDuplicate} skipped as possible duplicate(s), ${summary.skippedAsInsufficient} skipped for insufficient evidence.`,
  ];
  if (summary.recorded.length > 0) {
    lines.push("", ...summary.recorded.map((r) => `• ${r.organisation} -- ${r.url}`));
    lines.push("", "These are Leads only -- no Entity created, no qualification performed. Prepared for the isolated Sales Executive environment to pick up from here.");
  }

  await sendHatMessage(env, target, lines.join("\n"));
}
