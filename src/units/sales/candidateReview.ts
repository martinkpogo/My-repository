import type { Env } from "../../types";
import { AccessDeniedError, type AccessContext } from "../../access";
import { executeSearch, extractDomain } from "../../runtime/research/webSearch";
import type { SearchResult } from "../../runtime/research/webSearch";
import {
  findUnverifiableSources,
  validateSynthesis,
  type EvidenceSynthesis,
  type Limitation,
  type SourceRecord,
} from "../../runtime/evidence/validation";
import { resolveToolOperation } from "../../runtime/toolRegistry";
import { redactIdentityTerms } from "../../ai/identityRedaction";
import { generate } from "../../ai";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import { getLeadDiscoveryGovernance } from "./leadDiscovery";

/**
 * Evidence-backed candidate review for the Lead Generation Specialist
 * (Slice A).
 *
 * A candidate that survives the Acquisition Criteria screening still reaches
 * Martin's approval card as an observation plus one source URL. This module is
 * what turns that into a REVIEW he can actually judge: source-linked observed
 * facts, evidence-backed findings, explicitly-labelled interpretations and
 * unknowns, surfaced conflicts, and the limitations of the evidence -- each
 * fact tied to a source this Worker really retrieved, with its retrieval time
 * and (only when the provider supplied one) its publication date.
 *
 * Three boundaries this module exists to keep:
 *
 * 1. **Sources are built in code, never authored by the model.** Every
 *    `SourceRecord` comes from a `SearchResult` this run actually received
 *    from the registered `search` Tool contract. The model only REFERS to
 *    them by id. A model that invents a source id, a URL, or a date fails
 *    validation instead of reaching the card.
 *
 * 2. **A snippet is never presented as page or image inspection.** The only
 *    thing retrieved is the provider's snippet for a result. Every source is
 *    typed `*_snippet` and the rendered review says so in its limitations --
 *    so no card can imply a page was opened, an image was seen, or a profile
 *    was logged into.
 *
 * 3. **Evidence is evidence, not authority.** The review is advisory input to
 *    Martin's approval decision. Nothing here creates a Lead, a Handoff, or a
 *    qualification, and nothing here decides anything.
 *
 * The structural contract reuses the shared evidence gate in
 * `src/runtime/evidence/validation.ts` (Evidence -> Finding -> Implication ->
 * Limitation -> Source, plus the provenance check) rather than defining a
 * parallel taxonomy: `facts` are EvidenceItems (each must cite a retrieved
 * source), `findings` must cite EvidenceItems, `interpretations` are
 * Implications that must be based on a Finding, and `limitations` are
 * Limitations. `unknowns` and `conflicts` are the two buckets that contract
 * has no home for -- an unknown cites nothing because nothing is known, and a
 * conflict must cite the disagreeing sources so it is surfaced rather than
 * silently resolved.
 */

// ---------------------------------------------------------------------------
// Sources.
// ---------------------------------------------------------------------------

/** Where a Source came from. Both are snippets: neither is a page or image inspection. */
export type ReviewSourceKind = "web_search_result" | "public_social_search_result";

/**
 * The `sourceType` written onto every SourceRecord. The `_snippet` suffix is
 * load-bearing: it is the machine-readable half of "a search result snippet is
 * not evidence that the page or image behind it was inspected".
 */
export function reviewSourceType(kind: ReviewSourceKind): string {
  return kind === "public_social_search_result" ? "public_social_search_result_snippet" : "web_search_result_snippet";
}

/**
 * Builds the SourceRecords for a review from results this run really
 * retrieved. Ids are assigned in code (`S1..Sn`) so a later model response can
 * only cite sources that exist. `publicationDate` is carried ONLY when the
 * provider supplied one -- a missing publication date is never inferred, and
 * the renderer says so rather than printing an invented date.
 */
export function buildReviewSources(kind: ReviewSourceKind, results: readonly SearchResult[], startIndex = 1): SourceRecord[] {
  const sourceType = reviewSourceType(kind);
  return results.map((result, index) => ({
    id: `S${startIndex + index}`,
    source: result.title.trim() || extractDomain(result.url),
    sourceType,
    url: result.url,
    ...(result.published_at ? { publicationDate: result.published_at } : {}),
    retrievalDate: result.retrieved_at,
    passage: result.snippet,
    claimSupported: "",
    validationStatus: "unvalidated" as const,
  }));
}

// ---------------------------------------------------------------------------
// Public social engagement signals.
// ---------------------------------------------------------------------------

/**
 * Public web properties a social-signal search is scoped to. Scoping to the
 * public index is what keeps this a READ of publicly retrievable material:
 * nothing here authenticates to a platform, and no authenticated platform
 * access (existing or new) is used, added, or implied.
 */
export const PUBLIC_SOCIAL_SIGNAL_DOMAINS: readonly string[] = [
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "youtube.com",
];

/** Upper bound on the extra public searches one candidate's social-signal step may run. */
export const MAX_SOCIAL_SIGNAL_SEARCHES = 2;

/** Upper bound on results kept per social-signal search. */
export const MAX_SOCIAL_SIGNAL_RESULTS_PER_SEARCH = 3;

export interface SocialSignalGather {
  /** Snippet sources actually retrieved from the public index. */
  sources: SourceRecord[];
  /**
   * One line per search, saying what actually happened. An unsuccessful
   * search is disclosed as an unsuccessful search -- never folded into "this
   * organisation has no public social presence", and never a place where a
   * reach/impression/engagement figure could be invented.
   */
  disclosures: string[];
  /** How many snippet sources were actually retrieved. */
  retrievedCount: number;
}

/** The bounded public-signal searches for one screened candidate, in order. */
export function socialSignalQueries(organisation: string): Array<{ query: string; includeDomains?: string[] }> {
  return [
    { query: `"${organisation}"`, includeDomains: [...PUBLIC_SOCIAL_SIGNAL_DOMAINS] },
    { query: `"${organisation}" official social media`, includeDomains: undefined },
  ].slice(0, MAX_SOCIAL_SIGNAL_SEARCHES);
}

/**
 * Gathers PUBLIC social engagement signals for one screened candidate through
 * the same registered, Access-gated `search` Tool contract every other
 * discovery read uses -- no second retrieval mechanism, no provider choice,
 * no credentials.
 *
 * Each of the five SearchOutcome kinds is disclosed separately, because
 * "searched and found nothing" and "the search never succeeded" are different
 * facts about the world and a card must not conflate them.
 *
 * An Access denial is deliberately NOT caught: AccessDeniedError is a
 * governance decision, so it propagates exactly as it does for the screening
 * search. Any OTHER unexpected throw is caught and disclosed as a failure of
 * this step, so one broken signal search cannot abort a discovery run -- and
 * because it is disclosed rather than swallowed, it can never read as evidence
 * of an absent public presence either.
 */
export async function gatherPublicSocialSignals(env: Env, organisation: string, access: AccessContext): Promise<SocialSignalGather> {
  const sources: SourceRecord[] = [];
  const disclosures: string[] = [];
  const seenUrls = new Set<string>();

  for (const { query, includeDomains } of socialSignalQueries(organisation)) {
    const redactedQuery = redactIdentityTerms(query);
    let outcome;
    try {
      outcome = await executeSearch(
        env,
        {
          query: redactedQuery,
          ...(includeDomains ? { include_domains: includeDomains } : {}),
          max_results: MAX_SOCIAL_SIGNAL_RESULTS_PER_SEARCH,
        },
        access,
      );
    } catch (err) {
      if (err instanceof AccessDeniedError) throw err;
      console.error(`Lead Discovery: public social signal search failed for ${organisation}`, err);
      disclosures.push(
        `Public social-signal search "${redactedQuery}" failed before any result was returned. No conclusion about this organisation's public social presence may be drawn from it.`,
      );
      continue;
    }

    switch (outcome.kind) {
      case "success_with_results": {
        // Ids continue across searches and a url already gathered is not
        // gathered twice, so every source the review may cite has exactly one
        // id and one retrieval record.
        const fresh = outcome.results.filter((result) => !seenUrls.has(result.url));
        for (const result of fresh) seenUrls.add(result.url);
        const before = sources.length;
        sources.push(...buildReviewSources("public_social_search_result", fresh, sources.length + 1));
        disclosures.push(
          `Public social-signal search "${redactedQuery}" retrieved ${sources.length - before} result(s) as search-result snippets from the public index${fresh.length < outcome.results.length ? ` (${outcome.results.length - fresh.length} duplicate(s) of an already-retrieved url omitted)` : ""}.`,
        );
        break;
      }
      case "success_no_results":
        disclosures.push(
          `Public social-signal search "${redactedQuery}" completed and found no indexed result. This is NOT evidence that ${organisation} has no public social presence.`,
        );
        break;
      case "provider_unavailable":
      case "provider_failure":
      case "invalid_input":
        disclosures.push(
          `Public social-signal search "${redactedQuery}" did not complete (${outcome.kind}). No conclusion about ${organisation}'s public social presence may be drawn from it -- an unsuccessful search is not an empty one.`,
        );
        break;
    }
  }

  return { sources, disclosures, retrievedCount: sources.length };
}

// ---------------------------------------------------------------------------
// Fabricated-metric guard.
// ---------------------------------------------------------------------------

/**
 * Metric vocabulary a model is tempted to supply for a public organisation
 * when no source carries it. Private analytics (reach, impressions,
 * engagement rate, follower/view/like counts, CTR, conversion and open rates)
 * are never publicly retrievable through the registered `search` Tool, so a
 * review statement using one of these terms is only admissible when the SAME
 * term literally appears in the material this run actually retrieved.
 *
 * This is a provenance rule, not a threshold: it introduces no target, no
 * benchmark, and no measurement -- it refuses an unsourced figure outright.
 */
const METRIC_TERMS: readonly string[] = [
  "impression",
  "engagement rate",
  "reach",
  "follower",
  "like count",
  "view count",
  "click-through rate",
  "ctr",
  "conversion rate",
  "open rate",
  "subscriber count",
];

const PERCENTAGE_TOKEN = /\b\d+(?:\.\d+)?\s?%/g;
/** Matches the metric term and its ordinary inflections (reach/reaches/reached, impression/impressions, follower/followers). */
const WORD = (term: string) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es|ed|ing)?\\b`, "i");

/**
 * Returns every statement that asserts a metric or a percentage the retrieved
 * material does not literally contain -- the mechanical half of "no fabricated
 * reach, impressions, engagement rates, or invented percentages".
 *
 * A non-empty return means the review must NOT be presented as validated.
 */
export function findUnsupportedMetricClaims(statements: readonly string[], suppliedContext: string): string[] {
  const haystack = suppliedContext.toLowerCase();
  const violations: string[] = [];

  for (const statement of statements) {
    if (typeof statement !== "string" || !statement.trim()) continue;

    for (const term of METRIC_TERMS) {
      if (WORD(term).test(statement) && !WORD(term).test(suppliedContext)) {
        violations.push(`uses the metric term "${term}" that does not appear in any retrieved material: ${statement}`);
        break;
      }
    }

    const percentages = statement.match(PERCENTAGE_TOKEN) ?? [];
    for (const percentage of percentages) {
      if (!haystack.includes(percentage.toLowerCase().replace(/\s+/g, "")) && !haystack.includes(percentage.toLowerCase())) {
        violations.push(`states a percentage "${percentage.trim()}" that does not appear in any retrieved material: ${statement}`);
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The review draft (what the model may say) and its validation.
// ---------------------------------------------------------------------------

interface ReviewFactDraft {
  id: string;
  statement: string;
  sourceIds: string[];
}

interface ReviewFindingDraft {
  id: string;
  statement: string;
  evidenceIds: string[];
}

interface ReviewInterpretationDraft {
  statement: string;
  findingIds: string[];
}

interface ReviewConflictDraft {
  statement: string;
  sourceIds: string[];
}

/** Exactly what the model returns. Every reference is an id that must already exist. */
export interface CandidateReviewDraft {
  facts: ReviewFactDraft[];
  findings: ReviewFindingDraft[];
  interpretations: ReviewInterpretationDraft[];
  /** What is NOT known. Cites nothing, because nothing is established about it. */
  unknowns: string[];
  /** Where retrieved sources disagree. Must name the disagreeing sources; never silently resolved. */
  conflicts: ReviewConflictDraft[];
  limitations: string[];
}

export interface ReviewConflict {
  statement: string;
  sourceIds: string[];
}

export type CandidateReviewValidation =
  | { ok: true; synthesis: EvidenceSynthesis }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Turns an untrusted model response into the shared evidence contract's own
 * shape, then runs the shared gates on it:
 *
 * 1. shape -- every bucket present, every statement a non-empty string, every
 *    id non-empty and unique;
 * 2. `validateSynthesis` -- Evidence cites a Source, Finding cites Evidence,
 *    Implication is based on a Finding (an inference can never be dressed as a
 *    finding);
 * 3. `findUnverifiableSources` -- every cited Source literally appears in the
 *    material this run retrieved, so a fabricated source can never ship;
 * 4. conflicts cite a real Source;
 * 5. `findUnsupportedMetricClaims` -- no metric or percentage the retrieved
 *    material does not carry.
 *
 * A failure is a failure: the caller reports the review as blocked and shows
 * the reason. It is never downgraded to "a weaker review".
 */
export function validateCandidateReviewDraft(draft: CandidateReviewDraft | null, sources: readonly SourceRecord[], suppliedContext: string): CandidateReviewValidation {
  if (!draft || typeof draft !== "object") return { ok: false, reason: "no review was produced (the evidence step returned no usable output)" };

  const facts = asArray(draft.facts) as ReviewFactDraft[];
  const findings = asArray(draft.findings) as ReviewFindingDraft[];
  const interpretations = asArray(draft.interpretations) as ReviewInterpretationDraft[];
  const conflicts = asArray(draft.conflicts) as ReviewConflictDraft[];
  const unknowns = asArray(draft.unknowns) as unknown[];
  const limitations = asArray(draft.limitations) as unknown[];

  if (facts.length === 0) return { ok: false, reason: "the review contains no observed fact tied to a retrieved source" };

  const sourceIds = new Set(sources.map((s) => s.id));
  const seenFactIds = new Set<string>();
  for (const fact of facts) {
    if (!fact || !isNonEmptyString(fact.statement)) return { ok: false, reason: "the review contains an empty observed fact" };
    if (!isNonEmptyString(fact.id)) return { ok: false, reason: "an observed fact carries no id for findings to cite" };
    if (seenFactIds.has(fact.id)) return { ok: false, reason: `the review reuses the observed-fact id "${fact.id}"` };
    seenFactIds.add(fact.id);
    if (!Array.isArray(fact.sourceIds) || fact.sourceIds.length === 0) {
      return { ok: false, reason: `observed fact "${fact.statement.slice(0, 60)}" cites no source -- an uncited claim is not an observation` };
    }
    for (const id of fact.sourceIds) {
      if (!sourceIds.has(id)) return { ok: false, reason: `observed fact cites source "${String(id)}", which was not retrieved` };
    }
  }

  const seenFindingIds = new Set<string>();
  for (const finding of findings) {
    if (!finding || !isNonEmptyString(finding.statement)) return { ok: false, reason: "the review contains an empty finding" };
    if (!isNonEmptyString(finding.id)) return { ok: false, reason: "a finding carries no id for interpretations to cite" };
    if (seenFindingIds.has(finding.id)) return { ok: false, reason: `the review reuses the finding id "${finding.id}"` };
    seenFindingIds.add(finding.id);
    if (!Array.isArray(finding.evidenceIds) || finding.evidenceIds.length === 0) {
      return { ok: false, reason: `finding "${finding.statement.slice(0, 60)}" cites no evidence -- an unsupported claim cannot be a finding` };
    }
    for (const id of finding.evidenceIds) {
      if (!seenFactIds.has(id)) return { ok: false, reason: `finding cites evidence "${String(id)}", which does not exist` };
    }
  }

  for (const interpretation of interpretations) {
    if (!interpretation || !isNonEmptyString(interpretation.statement)) return { ok: false, reason: "the review contains an empty interpretation" };
    if (!Array.isArray(interpretation.findingIds) || interpretation.findingIds.length === 0) {
      return { ok: false, reason: `interpretation "${interpretation.statement.slice(0, 60)}" is based on no finding -- an interpretation must rest on a finding, not on nothing` };
    }
    for (const id of interpretation.findingIds) {
      if (!seenFindingIds.has(id)) return { ok: false, reason: `interpretation references finding "${String(id)}", which does not exist` };
    }
  }

  for (const conflict of conflicts) {
    if (!conflict || !isNonEmptyString(conflict.statement)) return { ok: false, reason: "the review contains an empty conflict entry" };
    if (!Array.isArray(conflict.sourceIds) || conflict.sourceIds.length === 0) {
      return { ok: false, reason: `conflict "${conflict.statement.slice(0, 60)}" names no disagreeing source` };
    }
    for (const id of conflict.sourceIds) {
      if (!sourceIds.has(id)) return { ok: false, reason: `conflict cites source "${String(id)}", which was not retrieved` };
    }
  }

  for (const unknown of unknowns) {
    if (!isNonEmptyString(unknown)) return { ok: false, reason: "the review contains an empty unknown" };
  }
  for (const limitation of limitations) {
    if (!isNonEmptyString(limitation)) return { ok: false, reason: "the review contains an empty limitation" };
  }

  const synthesis: EvidenceSynthesis = {
    sources: sources.map((source) => ({ ...source })),
    evidence: facts.map((fact) => ({ id: fact.id, statement: fact.statement, sourceIds: fact.sourceIds })),
    findings: findings.map((finding) => ({ id: finding.id, statement: finding.statement, evidenceIds: finding.evidenceIds })),
    implications: interpretations.map((interpretation) => ({ statement: interpretation.statement, basedOnFindingIds: interpretation.findingIds })),
    limitations: limitations.map((value) => ({ statement: String(value) })),
  };

  const structural = validateSynthesis(synthesis);
  if (!structural.valid) return { ok: false, reason: structural.reason ?? "the review did not satisfy the Evidence -> Finding -> Implication citation contract" };

  const unverifiable = findUnverifiableSources(synthesis, suppliedContext);
  if (unverifiable.length > 0) {
    return {
      ok: false,
      reason: `the review cites source(s) that do not appear in any material this run retrieved: ${unverifiable.map((s) => s.id).join(", ")}`,
    };
  }

  const statements = [
    ...synthesis.evidence.map((e) => e.statement),
    ...synthesis.findings.map((f) => f.statement),
    ...synthesis.implications.map((i) => i.statement),
    ...unknowns.map((u) => String(u)),
    ...conflicts.map((c) => c.statement),
    ...limitations.map((l) => String(l)),
  ];
  const metricViolations = findUnsupportedMetricClaims(statements, suppliedContext);
  if (metricViolations.length > 0) {
    return { ok: false, reason: `the review asserts metric(s) no retrieved material supports -- ${metricViolations[0]}` };
  }

  return { ok: true, synthesis };
}

// ---------------------------------------------------------------------------
// Bounded visual analysis.
// ---------------------------------------------------------------------------

/** The Tool Registry id/operation visual analysis would have to resolve to. */
export const VISION_TOOL_ID = "vision";
export const VISION_ANALYSE_OPERATION_ID = "vision.analyse_image";

/**
 * Why visual analysis cannot run today, resolved against the runtime that
 * actually exists rather than assumed. Three requirements, each failing
 * closed:
 *
 * - `retrieval` is a LIVE lookup against the Tool Registry -- the only
 *   sanctioned mechanism by which an external capability becomes executable.
 *   Nothing registers an image-retrieval operation, and no Unit may add one
 *   locally or call a handler it resolved itself.
 * - `image_message_contract` and `vision_model` are resolved from the
 *   contracts' own shapes rather than a live probe, because TypeScript erases
 *   types at runtime: `AiMessage.content` is a single `string`
 *   (`src/ai/types.ts`), so no image part can reach a provider, and the
 *   registered models are text-only instruct models. Both are stated with
 *   their source location so the claim stays checkable.
 */
export interface VisualAnalysisRequirement {
  requirement: "retrieval" | "image_message_contract" | "vision_model";
  satisfied: boolean;
  resolution: string;
}

export interface VisualAnalysisCapability {
  available: boolean;
  missing: VisualAnalysisRequirement[];
  /**
   * The SMALLEST change that would make the first option real -- reported, not
   * built. Adding it is an Architect decision (a new registered capability
   * plus provider policy), so it is deliberately described here and never
   * implemented by this slice.
   */
  smallestSafeAddition: string;
}

const SMALLEST_SAFE_VISUAL_ADDITION =
  "Register ONE image-retrieval read capability alongside the existing `search` Tool contract (ENIG HQ / 6. Tools), authorize exactly that operation for the Lead-Generation discovery context, and register one vision-capable model in the AI provider policy so `AiTask.messages` can carry an image part. Then submit only successfully retrieved images to that model and label its output advisory. No new dispatch path, no second mechanism, no Tool Registry bypass -- all three pieces are Architect decisions (capability registration + provider eligibility), so this is reported for approval rather than implemented.";

export function resolveVisualAnalysisCapability(): VisualAnalysisCapability {
  const requirements: VisualAnalysisRequirement[] = [
    {
      requirement: "retrieval",
      satisfied: resolveToolOperation(VISION_TOOL_ID, VISION_ANALYSE_OPERATION_ID) !== null,
      resolution:
        resolveToolOperation(VISION_TOOL_ID, VISION_ANALYSE_OPERATION_ID) !== null
          ? `Tool Registry resolves ${VISION_TOOL_ID}.${VISION_ANALYSE_OPERATION_ID}`
          : `the Tool Registry resolves no ${VISION_TOOL_ID}.${VISION_ANALYSE_OPERATION_ID} -- no registered, bounded mechanism retrieves an image for analysis`,
    },
    {
      requirement: "image_message_contract",
      satisfied: false,
      resolution:
        "AiMessage.content is a single string (src/ai/types.ts) and AiTask.messages carries no image part, so a retrieved image cannot be submitted to any model",
    },
    {
      requirement: "vision_model",
      satisfied: false,
      resolution:
        "the registered providers execute the configured text-only instruct models (AI_MODEL_PRIMARY / AI_MODEL_LIGHT); no vision-capable model is registered in the provider policy",
    },
  ];

  const missing = requirements.filter((r) => !r.satisfied);
  return { available: missing.length === 0, missing, smallestSafeAddition: SMALLEST_SAFE_VISUAL_ADDITION };
}

/** Material that WOULD be analysed. Only successfully retrieved material may ever reach the gate. */
export interface VisualAnalysisMaterial {
  url: string;
  /** True only when this Worker actually received the bytes through an approved mechanism. */
  retrieved: boolean;
  bytes?: number;
  contentType?: string;
}

/** Upper bound on one image the bounded mechanism may accept, when one exists. */
export const MAX_VISUAL_MATERIAL_BYTES = 4 * 1024 * 1024;

/**
 * Input contract for the bounded visual mechanism. Runs in production as part
 * of `buildVisualAnalysis` (today it always fails, because no material can be
 * retrieved without the capability), and is unit-tested directly so the
 * contract is exercised rather than merely written down.
 *
 * Rejects, fail-closed: empty material, anything not actually retrieved, a
 * non-image content type, and anything past the byte bound. Analysis over
 * anything else is exactly the "screenshot of something we never fetched"
 * failure this gate exists to prevent.
 */
export function validateVisualAnalysisInput(material: readonly VisualAnalysisMaterial[]): string | null {
  if (material.length === 0) return "no successfully retrieved image material was supplied -- there is nothing that may be analysed";
  for (const item of material) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) return "supplied visual material carries no source url";
    if (item.retrieved !== true) return `visual material from ${item.url} was not successfully retrieved by this Worker -- it may not be analysed`;
    if (item.contentType && !item.contentType.toLowerCase().startsWith("image/")) {
      return `visual material from ${item.url} is not an image (content type ${item.contentType})`;
    }
    if (typeof item.bytes === "number" && item.bytes > MAX_VISUAL_MATERIAL_BYTES) {
      return `visual material from ${item.url} exceeds the ${MAX_VISUAL_MATERIAL_BYTES}-byte bound`;
    }
  }
  return null;
}

/** What a bounded visual analysis would ever produce. Advisory, never a decision. */
export interface VisualAnalysisOutput {
  label: string;
  statement: string;
  sourceUrl: string;
}

/**
 * Output contract: a visual result must be explicitly labelled advisory, be
 * attributed to the exact material it analysed, and must not claim an
 * inspection that did not happen. Exercised directly by tests; production
 * cannot reach it today because no visual capability is registered -- see
 * `resolveVisualAnalysisCapability`.
 */
export function validateVisualAnalysisOutput(output: VisualAnalysisOutput | null, material: readonly VisualAnalysisMaterial[]): string | null {
  if (!output || typeof output !== "object") return "no visual analysis output was produced";
  if (!/advisory/i.test(output.label)) return "visual analysis output must be explicitly labelled advisory";
  if (!isNonEmptyString(output.statement)) return "visual analysis output carries no statement";
  if (!isNonEmptyString(output.sourceUrl)) return "visual analysis output carries no source url";
  if (!material.some((item) => item.url === output.sourceUrl)) {
    return "visual analysis output is attributed to a url that is not part of the supplied retrieved material";
  }
  return null;
}

export interface VisualAnalysisResult {
  status: "not_performed";
  reason: string;
  capability: VisualAnalysisCapability;
  /** Any future visual output in ENIG is advisory evidence for Martin, never authority. */
  advisory: true;
}

/**
 * The bounded visual step. It always resolves to `not_performed` while no
 * registered, authorized capability exists -- there is no fallback, no
 * best-effort image guess, and no substitute mechanism.
 */
export function buildVisualAnalysis(material: readonly VisualAnalysisMaterial[]): VisualAnalysisResult {
  const capability = resolveVisualAnalysisCapability();
  if (!capability.available) {
    return {
      status: "not_performed",
      reason: `visual analysis was not performed: ${capability.missing.map((m) => m.resolution).join("; ")}`,
      capability,
      advisory: true,
    };
  }
  const inputDefect = validateVisualAnalysisInput(material);
  if (inputDefect) {
    return { status: "not_performed", reason: `visual analysis was not performed: ${inputDefect}`, capability, advisory: true };
  }
  // Unreachable while no capability is registered: execution is gated above on
  // the registered capability, never started from this branch.
  return {
    status: "not_performed",
    reason: "visual analysis was not performed: no approved vision-capable submission step is registered for this material",
    capability,
    advisory: true,
  };
}

// ---------------------------------------------------------------------------
// Building and rendering the review.
// ---------------------------------------------------------------------------

export interface CandidateReview {
  status: "validated" | "blocked";
  /** Why the review is blocked. Present only when status is `blocked`. */
  blockedReason?: string;
  /** Sources actually retrieved for this review -- built from real results, never model-authored. */
  sources: SourceRecord[];
  facts: Array<{ id: string; statement: string; sourceIds: string[] }>;
  findings: Array<{ id: string; statement: string; evidenceIds: string[] }>;
  interpretations: Array<{ statement: string; findingIds: string[] }>;
  unknowns: string[];
  conflicts: ReviewConflict[];
  limitations: string[];
  socialDisclosures: string[];
  visualAnalysis: VisualAnalysisResult;
}

/** A standing limitation: what a `search` snippet does and does not prove. */
export const SNIPPET_ONLY_LIMITATION =
  "Every source here was retrieved as a search-result snippet through the registered `search` Tool. No web page, social profile, or image was opened, inspected, or logged into, so a snippet never proves what the page or image behind it contains.";

/** A standing limitation: how far public social-signal retrieval can reach. */
export const PUBLIC_SOCIAL_ACCESS_LIMITATION =
  "Public social engagement signals were read only from publicly indexed content through the same registered `search` Tool. No authenticated access to any platform was used or added, so behind-login content, private analytics, reach, impressions and engagement rates are outside what this review can observe.";

const DETERMINISTIC_LIMITATIONS: readonly Limitation[] = [
  { statement: SNIPPET_ONLY_LIMITATION },
  { statement: PUBLIC_SOCIAL_ACCESS_LIMITATION },
];

/** Publication dates are printed only when the provider supplied one; this says so, so an absent date is never mistaken for a fact. */
export const PUBLICATION_DATE_LIMITATION =
  "A publication date is shown only where the search provider supplied one. Where it is absent, the publication date is unknown -- not recent, and not withheld.";

/** The model's own instructions for one bounded review call. Never governance: the persona comes from live governance. */
function reviewSituation(): string {
  return [
    "Build ONE evidence-backed review of the screened candidate from the retrieved material in Context, which is the ONLY source of fact available to you.",
    "",
    "Return JSON with exactly these keys:",
    '{"facts":[{"id":"F1","statement":"...","sourceIds":["S1"]}],"findings":[{"id":"D1","statement":"...","evidenceIds":["F1"]}],"interpretations":[{"statement":"...","findingIds":["D1"]}],"unknowns":["..."],"conflicts":[{"statement":"...","sourceIds":["S1"]}],"limitations":["..."]}',
    "",
    "Rules:",
    "- facts: only what the retrieved passages literally state, each tied to a source id that appears in Context. Attribute the observation, never the cause. A snippet is not proof that the page or image behind it was inspected.",
    "- findings: what the facts jointly establish. A finding with no fact behind it is not a finding.",
    "- interpretations: your reading or a hypothesis, explicitly not established. Every one must rest on a finding. Never restate a hypothesis as a fact.",
    "- unknowns: what is genuinely not known from this material. Do not fill them in.",
    "- conflicts: where retrieved sources disagree. Name the disagreeing sources; never resolve a conflict silently.",
    "- limitations: what this evidence cannot show -- thin coverage, snippet-only retrieval, missing publication dates, absent social signals.",
    "- Never invent a reach, impression, engagement-rate, follower, view or like count, or any percentage. Numeric engagement figures that are not literally in Context must be omitted, not estimated.",
    "- Never invent a source id, url, date, contact, or decision-maker.",
    "- If the material cannot support a fact, return fewer facts rather than a weaker claim.",
  ].join("\n");
}

/**
 * Produces the review for one screened candidate:
 *
 * 1. fetch this Hat's governance live (no hard-coded persona -- a governance
 *    failure blocks the review, it never substitutes text of our own);
 * 2. build the sources in code from what was really retrieved;
 * 3. one bounded JSON call under the existing
 *    `lead.discovery_signal_evaluation` profile (public, source-attributed
 *    search-result content -- the same registered profile the screening call
 *    already uses, so no new SemanticTaskId and no new data-boundary profile);
 * 4. validate fail-closed through the shared evidence gates plus the
 *    metric guard;
 * 5. attach the deterministic limitations and the bounded visual step.
 *
 * A failure returns a `blocked` review with the reason. It never returns a
 * partially-validated review, and it never suppresses Martin's approval card.
 */
export async function buildCandidateReview(
  env: Env,
  organisation: string,
  screeningResult: SearchResult,
  social: SocialSignalGather,
  skills: ResolvedActionSkillSet,
): Promise<CandidateReview> {
  const visualAnalysis = buildVisualAnalysis([]);
  // Ids are assigned across the COMBINED set: the screening result is S1 and
  // the social snippets continue from it, so a cited id is always unique and
  // always points at exactly one retrieved result.
  const screeningSources = buildReviewSources("web_search_result", [screeningResult]);
  const socialSources = social.sources.map((source, index) => ({
    ...source,
    id: `S${screeningSources.length + index + 1}`,
  }));
  const sources = [...screeningSources, ...socialSources];

  const base: Omit<CandidateReview, "status"> = {
    sources,
    facts: [],
    findings: [],
    interpretations: [],
    unknowns: [],
    conflicts: [],
    limitations: [],
    socialDisclosures: social.disclosures,
    visualAnalysis,
  };

  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    return { ...base, status: "blocked", blockedReason: "the review was not produced: Lead Generation governance could not be retrieved, so no review was attempted" };
  }

  const skillContent = skills.get("research_signal").content;
  const context = sources
    .map(
      (source) =>
        `[${source.id}] ${source.source}${source.url ? ` — ${source.url}` : ""} [sourceType: ${source.sourceType}] [retrieved: ${source.retrievalDate ?? "not recorded"}]${source.publicationDate ? ` [published: ${source.publicationDate}]` : ""}\nSnippet: ${source.passage}`,
    )
    .join("\n\n");

  let draft: CandidateReviewDraft | null = null;
  try {
    draft = await generate<CandidateReviewDraft>(env, {
      taskId: "lead.discovery_signal_evaluation",
      mode: "json",
      parts: {
        persona: `You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Hat Definition (including its Acquisition Criteria section) is authoritative for this role -- follow it exactly as written.\n\n=== HAT DEFINITION ===\n${governance.hatDefinition}`,
        behavior: governance.universalRoleContract,
        skillContent,
        context,
        situation: `${reviewSituation()}\n\nCandidate under review: ${organisation}`,
      },
      light: true,
      maxTokens: 3000,
    });
  } catch (err) {
    console.error(`Lead Discovery: candidate review failed for ${organisation}`, err);
    return { ...base, status: "blocked", blockedReason: "the review was not produced: the evidence step failed before it returned any output" };
  }

  const validation = validateCandidateReviewDraft(draft, sources, context);
  if (!validation.ok) {
    return { ...base, status: "blocked", blockedReason: `the review was not produced: ${validation.reason}` };
  }

  // Sources that survived the provenance gate are verified against what this
  // run actually retrieved; their `claimSupported` is filled from the facts
  // that cite them rather than left to the model.
  const claimBySource = new Map<string, string[]>();
  for (const fact of validation.synthesis.evidence) {
    for (const sourceId of fact.sourceIds) {
      claimBySource.set(sourceId, [...(claimBySource.get(sourceId) ?? []), fact.statement]);
    }
  }
  const validatedSources = validation.synthesis.sources.map((source) => ({
    ...source,
    validationStatus: "validated" as const,
    claimSupported: (claimBySource.get(source.id) ?? []).join(" "),
  }));

  return {
    ...base,
    status: "validated",
    sources: validatedSources,
    facts: validation.synthesis.evidence.map((fact) => ({ id: fact.id, statement: fact.statement, sourceIds: fact.sourceIds })),
    findings: validation.synthesis.findings.map((finding) => ({ id: finding.id, statement: finding.statement, evidenceIds: finding.evidenceIds })),
    interpretations: validation.synthesis.implications.map((implication) => ({ statement: implication.statement, findingIds: implication.basedOnFindingIds })),
    unknowns: (asArray(draft!.unknowns) as unknown[]).map((value) => String(value)),
    conflicts: (asArray(draft!.conflicts) as ReviewConflictDraft[]).map((conflict) => ({ statement: conflict.statement, sourceIds: conflict.sourceIds })),
    limitations: (asArray(draft!.limitations) as unknown[]).map((value) => String(value)),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The card text for a review that was NOT produced. Used both when validation
 * fails and when the evidence step itself fails: the reason is stated, the
 * standing limitations still appear (snippet-only retrieval, public-only
 * social access, no visual capability), and nothing unvalidated is presented
 * as a review. The approval card itself is never suppressed by a review
 * failure.
 */
export function renderBlockedCandidateReview(organisation: string, reason: string): string {
  const capability = resolveVisualAnalysisCapability();
  return [
    `*Candidate review* — ${organisation}`,
    "",
    `Status: NOT PRODUCED — ${clip(reason || "no reason recorded", 400)}`,
    "",
    "Nothing above is a validated review of this candidate. The screening observation and source on this card are unaffected.",
    "",
    "*Evidence limitations*:",
    `- ${SNIPPET_ONLY_LIMITATION}`,
    `- ${PUBLIC_SOCIAL_ACCESS_LIMITATION}`,
    `- Visual analysis: not performed — ${clip(capability.missing.map((m) => m.resolution).join("; "), 300)}`,
  ].join("\n");
}

function sourceLine(source: SourceRecord): string {
  const published = source.publicationDate ? `; published ${source.publicationDate}` : "; publication date not supplied by the provider";
  const retrieved = source.retrievalDate ? `retrieved ${source.retrievalDate}` : "retrieval time not recorded";
  return `- [${source.id}] ${source.url ?? source.source} (${source.sourceType}) — ${retrieved}${published}`;
}

/**
 * Renders the review for Martin's approval card. Every bucket keeps its own
 * heading so an interpretation can never be read as a fact, and the standing
 * limitations are always present -- including that nothing here was visually
 * inspected, and that visual analysis did not run.
 *
 * A blocked review renders as blocked: the reason is shown and no unvalidated
 * statement is presented as a review.
 */
export function renderCandidateReview(organisation: string, review: CandidateReview): string {
  const header = `*Candidate review* — ${organisation}`;

  if (review.status === "blocked") {
    const lines = [renderBlockedCandidateReview(organisation, review.blockedReason ?? "no reason recorded")];
    if (review.socialDisclosures.length > 0) {
      lines.push("", "*Public social engagement signals*:");
      for (const disclosure of review.socialDisclosures) lines.push(`- ${clip(disclosure, 300)}`);
    }
    return lines.join("\n");
  }

  const lines: string[] = [header, "", "Status: validated against the retrieved material only."];

  if (review.facts.length > 0) {
    lines.push("", "*Observed facts* (each tied to a retrieved source):");
    for (const fact of review.facts) lines.push(`- ${clip(fact.statement, 300)} [${fact.sourceIds.join(", ")}]`);
  }
  if (review.findings.length > 0) {
    lines.push("", "*Findings* (what the facts establish):");
    for (const finding of review.findings) lines.push(`- ${clip(finding.statement, 300)} [${finding.evidenceIds.join(", ")}]`);
  }
  if (review.interpretations.length > 0) {
    lines.push("", "*Interpretations / hypotheses* — NOT established:");
    for (const interpretation of review.interpretations) lines.push(`- ${clip(interpretation.statement, 300)} [from ${interpretation.findingIds.join(", ")}]`);
  }
  if (review.unknowns.length > 0) {
    lines.push("", "*Unknowns / open questions*:");
    for (const unknown of review.unknowns) lines.push(`- ${clip(unknown, 220)}`);
  }
  if (review.conflicts.length > 0) {
    lines.push("", "*Conflicting evidence* — surfaced, not resolved:");
    for (const conflict of review.conflicts) lines.push(`- ${clip(conflict.statement, 240)} [${conflict.sourceIds.join(", ")}]`);
  }

  const limitations = [...DETERMINISTIC_LIMITATIONS.map((l) => l.statement), PUBLICATION_DATE_LIMITATION, ...review.limitations.map((l) => clip(l, 240))];
  lines.push("", "*Evidence limitations*:");
  for (const limitation of limitations) lines.push(`- ${limitation}`);

  lines.push(...renderSocialAndVisual(review));

  lines.push("", "*Sources* (retrieval times are this run's; publication dates only where the provider supplied one):");
  for (const source of review.sources.slice(0, 8)) lines.push(sourceLine(source));
  if (review.sources.length > 8) lines.push(`- …and ${review.sources.length - 8} further retrieved source(s).`);

  return lines.join("\n");
}

function renderSocialAndVisual(review: CandidateReview): string[] {
  const lines: string[] = [];
  lines.push("", "*Public social engagement signals*:");
  if (review.socialDisclosures.length > 0) {
    for (const disclosure of review.socialDisclosures) lines.push(`- ${clip(disclosure, 300)}`);
  } else {
    lines.push("- No public social-signal search was run for this candidate.");
  }
  lines.push("", "*Visual analysis*:");
  lines.push(`- ${clip(review.visualAnalysis.reason, 500)}`);
  lines.push("- Not performed. Any future visual reading would be labelled advisory and would never be authority.");
  return lines;
}
