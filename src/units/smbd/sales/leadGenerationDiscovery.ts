import type { Env } from "../../../types";
import { isWebSearchConfigured, searchWeb } from "../../research/webSearch";
import type { WebSearchResult } from "../../research/webSearch";
import { createPage, richText, select, title } from "../../../notion";
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

// Fixed queries derived from the Acquisition Criteria's own "operating
// business" / "strategic or commercial problem signal" vocabulary --
// targeting business-change events (expansion, rebrand, new market entry,
// funding, pivot) that could plausibly have opened a positioning/
// communication gap, per the canonical criterion 2 examples. Deliberately
// not industry-scoped -- the criteria are problem-signal-driven, not
// industry-driven (a smaller organisation with a substantial problem is
// as strong a Lead as a larger one).
export const DISCOVERY_QUERIES = [
  "company announces expansion into new market",
  "startup rebrands after pivot",
  "business launches new product line",
  "company diversifies offering new market entry",
  "brand repositioning announcement",
  "company raises funding to expand into new markets",
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
  recorded: { organisation: string; url: string }[];
  screenedOut: number;
  skippedAsDuplicate: number;
  skippedAsInsufficient: number;
}

/**
 * Runs one full autonomous discovery cycle: search -> evaluate -> (for
 * anything that passes) duplicate-check against the Leads database only ->
 * create. Never touches Entity (no explicit reference exists in this flow
 * at all, unlike the manual /lead path) and never sets Status to anything
 * but "New" -- identical authority boundary to the manual flow. Intended
 * to be invoked by a scheduled trigger (see index.ts's /admin/run-lead-
 * discovery), not by a chat command.
 */
export async function runAutonomousLeadDiscovery(env: Env): Promise<DiscoveryRunSummary> {
  const summary: DiscoveryRunSummary = { evaluated: 0, recorded: [], screenedOut: 0, skippedAsDuplicate: 0, skippedAsInsufficient: 0 };

  if (!isWebSearchConfigured(env)) {
    console.error("Autonomous Lead Discovery: no web search provider configured -- nothing to do");
    return summary;
  }

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

      // Fail-closed on the evidence-threshold hard gate itself: a "pass"
      // without the minimum evidence package (real organisation name +
      // an actual observation + a checkable source) is inconsistent output,
      // not a genuine pass -- never trust the AI's boolean alone.
      if (!evaluation.organisation.trim() || !evaluation.evidence.trim() || !isCheckableUrl(result.url)) {
        summary.skippedAsInsufficient++;
        continue;
      }

      const duplicates = await findDuplicateLeads(env, evaluation.organisation, "");
      if (duplicates.length > 0) {
        summary.skippedAsDuplicate++;
        await logActivity(env, {
          entry: `Autonomous discovery skipped -- possible duplicate: ${evaluation.organisation}`,
          type: "Discovery",
          area: "Sales",
          decisionRationale: `Matches existing Lead(s): ${duplicates.map((d) => d.name).join(", ")}`,
          outcome: "Complete",
        });
        continue;
      }

      try {
        const page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
          Lead: title(evaluation.organisation),
          Organisation: richText(evaluation.organisation),
          Contact: richText(evaluation.decisionMakerOrRole),
          "Contact Details": richText(""),
          Source: richText(result.url),
          "Discovery Evidence": richText(evaluation.evidence),
          Status: select("New"),
        });
        summary.recorded.push({ organisation: evaluation.organisation, url: page.url });
        await logActivity(env, {
          entry: `Lead recorded (autonomous discovery): ${evaluation.organisation}`,
          type: "Discovery",
          area: "Sales",
          activity: `Category: ${evaluation.category || "unclassified"}. Source: ${result.url}. Query: "${query}".`,
          decisionRationale: evaluation.reason,
          nextActions: "Prepared for Sales Executive follow-up.",
          outcome: "Complete",
        });
      } catch (err) {
        console.error(`Autonomous Lead Discovery: Leads database write failed for ${evaluation.organisation}`, err);
        await logActivity(env, {
          entry: `Autonomous discovery blocked -- Leads database unavailable: ${evaluation.organisation}`,
          type: "Blocker",
          area: "Sales",
          decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${err instanceof Error ? err.message : String(err)}`,
          outcome: "Blocked",
        });
      }
    }
  }

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
    `Scheduled discovery run: ${summary.evaluated} candidate(s) evaluated, ${summary.recorded.length} recorded as Lead(s), ${summary.screenedOut} screened out, ${summary.skippedAsDuplicate} skipped as possible duplicate(s), ${summary.skippedAsInsufficient} skipped for insufficient evidence.`,
  ];
  if (summary.recorded.length > 0) {
    lines.push("", ...summary.recorded.map((r) => `• ${r.organisation} -- ${r.url}`));
    lines.push("", "These are Leads only -- no Entity created, no qualification performed. Prepared for the isolated Sales Executive environment to pick up from here.");
  }

  await sendHatMessage(env, target, lines.join("\n"));
}
