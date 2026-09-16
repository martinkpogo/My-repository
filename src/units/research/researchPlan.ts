import type { Env } from "../../types";
import { aiJson } from "../../ai";
import type { ResearchProtocolId } from "./protocols";
import { researchProtocolDetail } from "./protocols";

/**
 * Protocol-specific research planning -- the layer that was missing
 * entirely before. Confirmed live: with only a fixed one-phrase-per-
 * protocol search suffix (e.g. "market size, demand, and growth trends"),
 * a protocol's own registered evidenceRequirements (already defined in
 * protocols.ts) were never actually read anywhere in the pipeline. A
 * protocol chosen in Stage 1 had no operational consequence beyond that
 * one generic phrase.
 *
 * This stage turns a selected protocol into a bounded set of concrete
 * research sub-questions ("dimensions"), grounded in the protocol's own
 * method/evidenceRequirements and the actual research question -- not a
 * hard-coded checklist. Each dimension becomes one search query in
 * webSearch.ts's gatherDimensionEvidence.
 */

export interface ResearchPlanDimension {
  protocol: ResearchProtocolId;
  subQuestion: string;
}

// Bounded, not unlimited browsing -- but sufficient to actually cover a
// multi-protocol request, unlike the old flat 3-query cap this replaces.
export const MAX_DIMENSIONS_PER_PROTOCOL = 4;
export const MAX_DIMENSIONS_PER_REQUEST = 8;

interface RawPlanDimension {
  protocol?: string;
  subQuestion?: string;
}

interface PlanResult {
  dimensions?: RawPlanDimension[];
}

/**
 * Deterministic bound enforcement -- applied regardless of what the model
 * returns, never trusting its count. Caps per protocol first (so one
 * protocol can't crowd out another's dimensions), then the total.
 */
export function capResearchPlan(dimensions: ResearchPlanDimension[]): ResearchPlanDimension[] {
  const perProtocolCount = new Map<ResearchProtocolId, number>();
  const capped: ResearchPlanDimension[] = [];
  for (const dimension of dimensions) {
    if (capped.length >= MAX_DIMENSIONS_PER_REQUEST) break;
    const count = perProtocolCount.get(dimension.protocol) ?? 0;
    if (count >= MAX_DIMENSIONS_PER_PROTOCOL) continue;
    perProtocolCount.set(dimension.protocol, count + 1);
    capped.push(dimension);
  }
  return capped;
}

/**
 * The illustrative examples below (market structure, demand conditions,
 * Ghana-specific evidence, etc. for Market/Industry; named firms/offers/
 * pricing for Competitive; buyer needs/behaviour/reviews for Customer/
 * Audience) are drawn directly from the governance correction that
 * created this stage -- they illustrate the KIND of dimension expected,
 * never a fixed checklist to copy verbatim onto an unrelated question.
 */
export function buildResearchPlanPrompt(categorySummary: string, relevance: string, protocols: ResearchProtocolId[]): string {
  return [
    "You generate a bounded research plan for ENIG's Research & Intelligence Unit -- a strategy-led consultancy's own R&I capability. Below is the authorized research category this consultancy operates in -- use ONLY this, never any information about the consultancy beyond what's stated here:",
    categorySummary,
    `This research question has been interpreted, in relation to that authorized category, as:\n"${relevance}"`,
    "Below are the protocol(s) already selected for this request, with their method and evidence requirements (already governed -- read and apply them, don't invent your own):",
    researchProtocolDetail(protocols),
    `For EACH protocol listed above, generate 2-${MAX_DIMENSIONS_PER_PROTOCOL} specific research sub-questions ("dimensions") that this protocol's own method and evidence requirements call for, tailored to what the actual research question asks -- never generic filler, and never the same dimensions regardless of the question.

Illustrative examples of the KIND of dimension expected (not a checklist to copy verbatim -- tailor to the actual question):
- Market / Industry Intelligence: market structure, demand conditions, relevant market indicators or benchmarks, service categories, purchasing organisations/demand segments where evidence supports it, market developments and trends, geography-specific evidence (e.g. a named country), relevant comparison geography where useful, evidence gaps.
- Competitive Intelligence: demonstrable competitor/alternative overlap, named firms where evidence supports it, observable offers, positioning, public pricing where available, competitive crowding.
- Customer / Audience Intelligence: actual evidence about buyers/audiences, needs, behaviour, purchase drivers, perceptions, reviews, public feedback.

Each dimension should be phrased as a concrete, searchable research sub-question (a complete question, not a topic label).`,
    `Return JSON:
{
  "dimensions": [
    {"protocol": "<exact protocol name from above>", "subQuestion": "<a concrete, searchable research sub-question>"},
    ...
  ]
}`,
  ].join("\n\n");
}

/**
 * Generates one protocol's dimensions in isolation -- confirmed live as
 * the fix for multi-protocol requests (the guardrail can select up to
 * five at once) blowing past free-tier size limits: a single combined
 * call asking for every selected protocol's dimensions at once scaled
 * its prompt with protocol count, and a 5-protocol request measured at
 * ~10-11K tokens even after every other size fix in this file's history
 * -- still over Groq's fixed 8000 TPM cap and slow enough to trip
 * several providers' 12s timeout. One call per protocol keeps every
 * individual request small regardless of how many protocols a request
 * activates, and each protocol's own eligible-provider fallback runs
 * independently, so one protocol's failure no longer takes the whole
 * plan down with it. Returns [] (never throws or fails the whole plan)
 * if this protocol's call didn't produce anything usable -- the caller
 * treats a partial plan across protocols as success.
 */
async function generateProtocolPlan(
  env: Env,
  categorySummary: string,
  relevance: string,
  question: string,
  protocol: ResearchProtocolId,
): Promise<ResearchPlanDimension[]> {
  const result = await aiJson<PlanResult>(env, {
    taskId: "research.plan_generation",
    system: buildResearchPlanPrompt(categorySummary, relevance, [protocol]),
    user: question,
    maxTokens: 1536,
  });

  if (!result?.dimensions || result.dimensions.length === 0) return [];

  // This call was scoped to exactly one protocol, so that protocol is
  // used directly rather than trusting whatever the model echoes back
  // in each dimension's "protocol" field -- a model that gets that
  // field wrong or omits it no longer silently drops an otherwise-good
  // dimension the way the combined-call version could.
  return result.dimensions
    .map((d): ResearchPlanDimension | null => {
      const subQuestion = d.subQuestion?.trim();
      return subQuestion ? { protocol, subQuestion } : null;
    })
    .filter((d): d is ResearchPlanDimension => d !== null);
}

/**
 * Generates and bounds the research plan across every selected protocol,
 * one independent (and independently fallback-eligible) AI call per
 * protocol -- see generateProtocolPlan. Returns null only if every
 * protocol's call failed and there is nothing at all to search for;
 * callers must fail closed in that case (this stage is load-bearing --
 * without it, evidence gathering has nothing to search for beyond the
 * bare question, which is the exact gap this stage exists to close). A
 * partial result (some but not all protocols produced dimensions) is
 * treated as success, not a failure -- some evidence beats none.
 */
export async function generateResearchPlan(
  env: Env,
  categorySummary: string,
  relevance: string,
  question: string,
  protocols: ResearchProtocolId[],
): Promise<ResearchPlanDimension[] | null> {
  const perProtocol = await Promise.all(
    protocols.map((protocol) => generateProtocolPlan(env, categorySummary, relevance, question, protocol)),
  );
  const mapped = perProtocol.flat();

  if (mapped.length === 0) return null;
  return capResearchPlan(mapped);
}
