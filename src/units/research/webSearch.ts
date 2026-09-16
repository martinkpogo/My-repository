import type { Env } from "../../types";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { RESEARCH_PROTOCOL_REGISTRY } from "./protocols";
import type { ResearchPlanDimension } from "./researchPlan";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

/** One research-plan dimension plus whatever the search for it actually turned up. */
export interface DimensionEvidence extends ResearchPlanDimension {
  results: WebSearchResult[];
}

const TAVILY_API_URL = "https://api.tavily.com/search";
const MAX_RESULTS_PER_QUERY = 5;

// Confirmed live: Tavily's "content" field is unbounded (some results ran
// well over a thousand characters), and with up to MAX_DIMENSIONS_PER_
// REQUEST (8) dimensions x MAX_RESULTS_PER_QUERY (5) results each, the
// untruncated total pushed a single synthesis prompt to ~18,000 tokens --
// past every free-tier provider's context window or rate limit. A snippet
// is corroborating evidence, not the source itself (the title/url/domain
// stay intact for citation and for findUnverifiableSources's verification
// against the literal supplied text), so it's safe to bound.
const MAX_SNIPPET_LENGTH = 400;

function capSnippet(snippet: string): string {
  return snippet.length > MAX_SNIPPET_LENGTH ? `${snippet.slice(0, MAX_SNIPPET_LENGTH)}...` : snippet;
}

export function isWebSearchConfigured(env: Env): boolean {
  return Boolean(env.TAVILY_API_KEY);
}

/**
 * Calls Tavily's search API for one query. Returns [] on any failure --
 * missing key, network error, non-2xx, or malformed response -- never
 * throws. Callers must treat an empty result as "no search evidence
 * available" and proceed with the same honest-limitation behavior as
 * when no search provider is configured at all; a provider hiccup is
 * never a reason to fabricate or to block the whole request.
 */
export async function searchWeb(env: Env, query: string): Promise<WebSearchResult[]> {
  if (!env.TAVILY_API_KEY) return [];
  try {
    const res = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        max_results: MAX_RESULTS_PER_QUERY,
        search_depth: "basic",
      }),
    });
    if (!res.ok) {
      console.error(`Tavily search failed: ${res.status} ${await res.text().catch(() => "")}`);
      return [];
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    };
    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url!,
        snippet: capSnippet(r.content ?? ""),
        publishedDate: r.published_date,
      }));
  } catch (err) {
    console.error("Tavily search threw", err);
    return [];
  }
}

/** Best-effort domain extraction for source-quality context -- falls back to the raw URL if parsing fails. */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Executes the research plan -- one search per dimension, not one per
 * protocol. This is the fix for the core diagnosed failure: a protocol
 * used to collapse to a single generic search phrase; now each of its
 * concrete sub-questions (from researchPlan.ts, grounded in the
 * protocol's own evidenceRequirements) gets its own query. Each query is
 * the dimension's sub-question itself, redacted through the identity gate
 * as defense in depth -- the sub-question was already generated from the
 * abstracted safe-context category, never Martin's raw identity-bearing
 * text, but this costs nothing to double-check. Degrades to empty results
 * per dimension when search isn't configured, exactly like before.
 */
export async function gatherDimensionEvidence(env: Env, plan: ResearchPlanDimension[]): Promise<DimensionEvidence[]> {
  return Promise.all(
    plan.map(async (dimension) => {
      const query = redactIdentityTerms(dimension.subQuestion);
      const results = await searchWeb(env, query);
      return { ...dimension, results };
    }),
  );
}

export interface DimensionCoverage {
  covered: DimensionEvidence[];
  uncovered: DimensionEvidence[];
}

/**
 * Deterministic coverage check -- the minimum, mechanically verifiable
 * form of "adequate vs. insufficient evidence": a dimension with zero
 * search results has no evidence at all, full stop, regardless of what
 * the synthesis model might otherwise be tempted to say about it.
 * Distinguishing "adequate" from "technically present but off-topic"
 * evidence (e.g. a competitor-analysis how-to article for a market-size
 * question) is not mechanically checkable without another model call --
 * that's enforced at the prompt level instead (see the synthesis output
 * contract's explicit rule against exactly this).
 */
export function assessDimensionCoverage(dimensionEvidence: DimensionEvidence[]): DimensionCoverage {
  return {
    covered: dimensionEvidence.filter((d) => d.results.length > 0),
    uncovered: dimensionEvidence.filter((d) => d.results.length === 0),
  };
}

/**
 * Formats gathered evidence grouped by protocol/dimension, with domain
 * and date retained per result -- structured, not a flat blob, so the
 * synthesis model (and a human reading the Activity Log) can see which
 * evidence answers which specific sub-question.
 */
export function formatDimensionEvidenceForContext(dimensionEvidence: DimensionEvidence[]): string {
  const withResults = dimensionEvidence.filter((d) => d.results.length > 0);
  if (withResults.length === 0) return "";
  return withResults
    .map((d) => {
      const protocolName = RESEARCH_PROTOCOL_REGISTRY[d.protocol].name;
      const lines = d.results.map(
        (r) => `  - ${r.title} (${r.url}) [source: ${extractDomain(r.url)}]${r.publishedDate ? ` [${r.publishedDate}]` : ""}: ${r.snippet}`,
      );
      return `[${protocolName}] Research dimension: "${d.subQuestion}"\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * Surfaces dimensions that returned zero evidence as an explicit warning
 * block injected into the synthesis prompt -- the mechanism that turns
 * "missing evidence" into a required Limitation instead of a silent gap
 * the model might paper over with inference.
 */
export function formatUncoveredDimensionsWarning(uncovered: DimensionEvidence[]): string {
  if (uncovered.length === 0) return "";
  return `No search evidence was found for the following research dimension(s) -- these MUST be reported as Limitations, never filled in with inference or generic claims:\n${uncovered
    .map((d) => `- [${RESEARCH_PROTOCOL_REGISTRY[d.protocol].name}] ${d.subQuestion}`)
    .join("\n")}`;
}
