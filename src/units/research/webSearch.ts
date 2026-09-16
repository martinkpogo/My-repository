import type { Env } from "../../types";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import type { ResearchProtocolId } from "./protocols";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

const TAVILY_API_URL = "https://api.tavily.com/search";

// Cost/latency cap -- at most this many queries fire per research request,
// each returning at most this many results. Tuned for "enough to ground a
// synthesis," not exhaustive research.
export const MAX_QUERIES_PER_REQUEST = 3;
const MAX_RESULTS_PER_QUERY = 5;

// One short, generic query focus per protocol -- deliberately NOT an AI
// call. Query text is built entirely from the already-abstracted
// relevance statement (safe-context-derived, never Martin's raw chat
// text) plus this fixed phrase, so there is no additional place an
// identity/proprietary detail could leak into an external query the way
// a fresh LLM generation call might improvise one. Evidence & Source
// Validation has no query of its own -- it's a cross-cutting check on
// results already gathered, not a search topic.
const PROTOCOL_QUERY_FOCUS: Partial<Record<ResearchProtocolId, string>> = {
  business_company: "company profile and business situation",
  market_industry: "market size, demand, and growth trends",
  competitive: "competitors and market positioning",
  customer_audience: "customer needs, reviews, and audience feedback",
  environmental_regulatory: "regulatory, economic, and policy conditions",
};

/**
 * Builds up to MAX_QUERIES_PER_REQUEST search queries, one per selected
 * protocol that has a query focus, from the relevance statement (already
 * grounded in the Research-Safe Consultancy Context, never raw chat
 * text) -- deterministic and pure so it's directly testable without
 * mocking a search provider or an LLM call.
 */
export function buildSearchQueries(relevance: string, protocols: ResearchProtocolId[]): string[] {
  return protocols
    .map((id) => PROTOCOL_QUERY_FOCUS[id])
    .filter((focus): focus is string => Boolean(focus))
    .slice(0, MAX_QUERIES_PER_REQUEST)
    .map((focus) => redactIdentityTerms(`${relevance} ${focus}`.trim()));
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
        snippet: r.content ?? "",
        publishedDate: r.published_date,
      }));
  } catch (err) {
    console.error("Tavily search threw", err);
    return [];
  }
}

/** Formats fetched results as the "web search results" block of the effective research context -- each with an exact, copy-verbatim URL. */
export function formatWebResultsForContext(results: WebSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map((r) => `- ${r.title} (${r.url})${r.publishedDate ? ` [${r.publishedDate}]` : ""}: ${r.snippet}`)
    .join("\n");
}
