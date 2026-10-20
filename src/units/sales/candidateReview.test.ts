import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SOCIAL_SIGNAL_SEARCHES,
  MAX_VISUAL_MATERIAL_BYTES,
  MAX_CANDIDATE_EVIDENCE_RESULTS,
  PUBLIC_SOCIAL_SIGNAL_DOMAINS,
  PUBLICATION_DATE_LIMITATION,
  PUBLIC_SOCIAL_ACCESS_LIMITATION,
  SNIPPET_ONLY_LIMITATION,
  VISION_ANALYSE_OPERATION_ID,
  VISION_TOOL_ID,
  blockedCandidateReview,
  buildCandidateReview,
  buildReviewSources,
  buildVisualAnalysis,
  evaluateCandidateSynthesis,
  findUnsupportedMetricClaims,
  gatherCandidateEvidence,
  gatherPublicSocialSignals,
  renderBlockedCandidateReview,
  renderCandidateReview,
  resolveVisualAnalysisCapability,
  socialSignalQueries,
  validateCandidateReviewDraft,
  validateVisualAnalysisInput,
  validateVisualAnalysisOutput,
  type CandidateReview,
  type VisualAnalysisMaterial,
} from "./candidateReview";
import { AccessDeniedError, discoveryCronContext, workSessionContext } from "../../access";
import { evidenceStatesProblemOrOpportunity } from "./leadGenerationDiscovery";
import type { SearchResult } from "../../runtime/research/webSearch";
import type { Env, WorkState } from "../../types";
import { salesManifest } from "./salesManifest";
import { resolveRecordedActionSkills } from "../../runtime/actionSkills";
import type { AiMessage } from "../../ai/types";

const lgsSkills = () => resolveRecordedActionSkills(salesManifest.hats["Lead Generation Specialist"], "discover_leads");

function envWithSearch(overrides: Partial<Env> = {}): Env {
  return { TAVILY_API_KEY: "test-tavily-key", ...overrides } as Env;
}

const SCREENING_RESULT: SearchResult = {
  title: "Nova Inc expands without updating its positioning",
  url: "https://example.com/nova-positioning-shift",
  snippet: "Nova Inc entered a new market segment while continuing to describe itself with its original positioning language.",
  provider: "tavily",
  retrieved_at: "2026-10-19T08:00:00.000Z",
  published_at: "2026-10-11",
};

const SOCIAL_RESULT: SearchResult = {
  title: "Nova Inc | LinkedIn",
  url: "https://www.linkedin.com/company/nova-inc",
  snippet: "Company page for Nova Inc. 12 employees listed.",
  provider: "tavily",
  retrieved_at: "2026-10-19T08:00:03.000Z",
};

function validDraft(overrides: Partial<NonNullable<Parameters<typeof validateCandidateReviewDraft>[0]>> = {}) {
  return {
    facts: [{ id: "F1", statement: "Nova Inc entered a new market segment.", sourceIds: ["S1"] }],
    findings: [{ id: "D1", statement: "Its public description does not reflect the new segment.", evidenceIds: ["F1"] }],
    interpretations: [{ statement: "It may have a positioning update it has not made.", findingIds: ["D1"] }],
    unknowns: ["Whether the change is deliberate is not known from this material."],
    conflicts: [],
    limitations: ["Only one source retrieved."],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sources: built from real results, never model-authored.
// ---------------------------------------------------------------------------

test("buildReviewSources: sources are built in code from retrieved results, with ids, retrieval times, and publication dates only when the provider supplied one", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT, { ...SCREENING_RESULT, url: "https://example.com/undated", published_at: undefined }]);

  assert.strictEqual(sources.length, 2, "one SourceRecord per retrieved result");
  assert.deepStrictEqual(
    sources.map((s) => s.id),
    ["S1", "S2"],
    "ids are assigned in code so a model can only cite sources that exist",
  );
  assert.strictEqual(sources[0].url, SCREENING_RESULT.url, "the direct source link is the provider's own url, verbatim");
  assert.strictEqual(sources[0].retrievalDate, SCREENING_RESULT.retrieved_at, "the retrieval time is the run's own");
  assert.strictEqual(sources[0].publicationDate, "2026-10-11", "a provider-supplied publication date is carried through");
  assert.strictEqual(sources[1].publicationDate, undefined, "a missing publication date is never invented");
  assert.strictEqual(sources[0].sourceType, "web_search_result_snippet", "the snippet-only inspection level is machine-readable on every source");
  assert.strictEqual(sources[1].sourceType, "web_search_result_snippet");
  assert.strictEqual(sources[0].passage, SCREENING_RESULT.snippet, "the passage is exactly what was retrieved");
});

test("buildReviewSources: a public social source is typed as a public social search snippet, never as a page or profile inspection", () => {
  const [source] = buildReviewSources("public_social_search_result", [SOCIAL_RESULT]);
  assert.strictEqual(source.sourceType, "public_social_search_result_snippet");
  assert.ok(source.sourceType.endsWith("_snippet"), "every social source must declare itself a snippet");
  assert.strictEqual(source.retrievalDate, SOCIAL_RESULT.retrieved_at, "the retrieval context travels with the signal");
  assert.strictEqual(source.publicationDate, undefined, "no publication date is invented for an undated social result");
});

// ---------------------------------------------------------------------------
// Public social engagement signals: public index only, bounded, disclosed.
// ---------------------------------------------------------------------------

test("socialSignalQueries: bounded, scoped to public web properties, and always naming the candidate", () => {
  const queries = socialSignalQueries("Nova Inc");
  assert.ok(queries.length <= MAX_SOCIAL_SIGNAL_SEARCHES, `must never exceed the social-signal bound (got ${queries.length})`);
  assert.ok(queries.length > 0);
  for (const q of queries) assert.ok(q.query.includes("Nova Inc"), `each query must be about the candidate: ${q.query}`);
  const scoped = queries.filter((q) => q.includeDomains);
  assert.ok(scoped.length > 0, "at least one search is scoped to the public social domains");
  for (const q of scoped) {
    for (const domain of q.includeDomains!) assert.ok(PUBLIC_SOCIAL_SIGNAL_DOMAINS.includes(domain), `unexpected domain scope: ${domain}`);
  }
});

test("gatherPublicSocialSignals: successful public retrieval produces snippet sources plus a retrieval disclosure", async (t) => {
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string, init?: any) => {
    requests.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({ results: [{ title: "Nova Inc | LinkedIn", url: "https://www.linkedin.com/company/nova-inc", content: "Company page for Nova Inc." }] }), { status: 200 });
  }) as typeof fetch;

  const gathered = await gatherPublicSocialSignals(envWithSearch(), "Nova Inc", discoveryCronContext());

  assert.strictEqual(gathered.retrievedCount, 1, "exactly the one retrieved snippet source is kept");
  assert.strictEqual(gathered.sources[0].sourceType, "public_social_search_result_snippet");
  assert.ok(gathered.disclosures.some((d) => d.includes("retrieved 1 result")), gathered.disclosures.join("\n"));

  assert.ok(requests.length <= MAX_SOCIAL_SIGNAL_SEARCHES, "the social step is bounded");
  for (const request of requests) {
    assert.ok(request.url.includes("api.tavily.com"), `the ONLY retrieval endpoint is the registered search provider: ${request.url}`);
    assert.ok(!("authorization" in Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]))), "no authorization header is ever sent");
    assert.ok(!("cookie" in Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]))), "no cookie is ever sent");
    // The provider credential travels only inside the registered search
    // Tool's own request to its own endpoint (webSearch.ts) -- never as a
    // header, never to any other host, and never into a social platform.
    assert.strictEqual(typeof request.body.api_key, "string", "the credential is only ever the registered provider's own, in its own request");
  }
});

test("gatherPublicSocialSignals: an empty result is disclosed as 'searched, found nothing' -- never as proof of no public presence", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch;

  const gathered = await gatherPublicSocialSignals(envWithSearch(), "Nova Inc", discoveryCronContext());
  assert.strictEqual(gathered.retrievedCount, 0);
  assert.strictEqual(gathered.sources.length, 0);
  assert.ok(gathered.disclosures.length > 0, "an empty search is still disclosed");
  for (const disclosure of gathered.disclosures) {
    assert.ok(/NOT evidence/i.test(disclosure), `an empty public search must be disclosed as not-evidence-of-absence: ${disclosure}`);
  }
});

test("gatherPublicSocialSignals: a provider failure is disclosed as an unsuccessful search, never folded into 'no public presence'", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

  const gathered = await gatherPublicSocialSignals(envWithSearch(), "Nova Inc", discoveryCronContext());
  assert.strictEqual(gathered.retrievedCount, 0, "a failed search yields no sources");
  assert.ok(gathered.disclosures.some((d) => d.includes("did not complete")), gathered.disclosures.join("\n"));
  for (const disclosure of gathered.disclosures) {
    assert.ok(!/NOT evidence that/i.test(disclosure) || /did not complete/i.test(disclosure), disclosure);
  }
});

test("gatherPublicSocialSignals: an Access denial propagates -- it is a governance stop, never downgraded to a search failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;

  // A work_session context with NO recorded Action is not authority to send a
  // query to a third party (src/access.ts evaluateExternalEgress).
  const denyingContext = workSessionContext({ workId: "work_review_denial" } as WorkState);
  await assert.rejects(
    () => gatherPublicSocialSignals(envWithSearch(), "Nova Inc", denyingContext),
    (err: unknown) => err instanceof AccessDeniedError,
    "an Access denial must surface as AccessDeniedError",
  );
  assert.strictEqual(fetchCalled, false, "no provider request may be made once Access denies");
});

// ---------------------------------------------------------------------------
// Fabricated-metric guard.
// ---------------------------------------------------------------------------

test("findUnsupportedMetricClaims: refuses reach, impressions, engagement rates and percentages the retrieved material does not carry", () => {
  const context = "Nova Inc said its campaign performed well last quarter.";
  const violations = findUnsupportedMetricClaims(
    [
      "The account has 12,400 impressions.",
      "Engagement rate is 4.2%.",
      "Estimated reach of 50,000 people.",
      "Its public description does not reflect the new segment.",
    ],
    context,
  );
  assert.strictEqual(violations.length, 4, `unsourced metrics must be refused, got: ${JSON.stringify(violations)}`);
  assert.ok(violations.every((v) => v.includes("does not appear in any retrieved material")), violations.join("\n"));
});

test("findUnsupportedMetricClaims: a metric or percentage that IS in the retrieved material is admissible", () => {
  const context = "Nova Inc reported an engagement rate of 4.2% across its channels.";
  const violations = findUnsupportedMetricClaims(["Nova Inc reported an engagement rate of 4.2% across its channels."], context);
  assert.deepStrictEqual(violations, [], "a figure literally present in retrieved material is sourced, not fabricated");
});

// ---------------------------------------------------------------------------
// Draft validation: missing / unverifiable / conflicting sources.
// ---------------------------------------------------------------------------

test("validateCandidateReviewDraft: a well-formed review over real retrieved sources validates", () => {
  const sources = [...buildReviewSources("web_search_result", [SCREENING_RESULT]), ...buildReviewSources("public_social_search_result", [SOCIAL_RESULT])];
  const context = sources.map((s) => `[${s.id}] ${s.url}\n${s.passage}`).join("\n\n");
  const result = validateCandidateReviewDraft(validDraft(), sources, context);
  assert.strictEqual(result.ok, true, result.ok ? "" : result.reason);
});

test("validateCandidateReviewDraft: fails closed when a fact cites a source that was never retrieved", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT]);
  const context = `[S1] ${SCREENING_RESULT.url}\n${SCREENING_RESULT.snippet}`;
  const result = validateCandidateReviewDraft(validDraft({ facts: [{ id: "F1", statement: "x", sourceIds: ["S9"] }] }), sources, context);
  assert.strictEqual(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /was not retrieved/, result.ok ? "" : result.reason);
});

test("validateCandidateReviewDraft: fails closed when a cited source does not literally appear in the retrieved material", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT]);
  // Supplied context deliberately omits S1 -- the fabricated-citation case.
  const result = validateCandidateReviewDraft(validDraft(), sources, "nothing relevant here");
  assert.strictEqual(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /do(es)? not appear in any material|not appear in any material/, result.ok ? "" : result.reason);
});

test("validateCandidateReviewDraft: an interpretation based on no finding, and a finding based on no fact, both fail closed", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT]);
  const context = `[S1] ${SCREENING_RESULT.url}\n${SCREENING_RESULT.snippet}`;

  const noFindingBasis = validateCandidateReviewDraft(validDraft({ interpretations: [{ statement: "maybe", findingIds: ["D9"] }] }), sources, context);
  assert.strictEqual(noFindingBasis.ok, false);
  assert.match(noFindingBasis.ok ? "" : noFindingBasis.reason, /does not exist/, noFindingBasis.ok ? "" : noFindingBasis.reason);

  const noEvidence = validateCandidateReviewDraft(validDraft({ findings: [{ id: "D1", statement: "unsupported", evidenceIds: [] }] }), sources, context);
  assert.strictEqual(noEvidence.ok, false);
  assert.match(noEvidence.ok ? "" : noEvidence.reason, /cites no evidence/, noEvidence.ok ? "" : noEvidence.reason);

  const emptyInterpretationBasis = validateCandidateReviewDraft(validDraft({ interpretations: [{ statement: "maybe", findingIds: [] }] }), sources, context);
  assert.strictEqual(emptyInterpretationBasis.ok, false);
  assert.match(emptyInterpretationBasis.ok ? "" : emptyInterpretationBasis.reason, /based on no finding/, emptyInterpretationBasis.ok ? "" : emptyInterpretationBasis.reason);
});

test("validateCandidateReviewDraft: a conflict must name the disagreeing retrieved sources -- conflicts are surfaced, never invented", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT]);
  const context = `[S1] ${SCREENING_RESULT.url}\n${SCREENING_RESULT.snippet}`;

  const unnamed = validateCandidateReviewDraft(validDraft({ conflicts: [{ statement: "sources disagree", sourceIds: [] }] }), sources, context);
  assert.strictEqual(unnamed.ok, false);
  assert.match(unnamed.ok ? "" : unnamed.reason, /names no disagreeing source/, unnamed.ok ? "" : unnamed.reason);

  const unknownSource = validateCandidateReviewDraft(validDraft({ conflicts: [{ statement: "sources disagree", sourceIds: ["S7"] }] }), sources, context);
  assert.strictEqual(unknownSource.ok, false);

  const named = validateCandidateReviewDraft(validDraft({ conflicts: [{ statement: "The snippet does not mention a rebrand.", sourceIds: ["S1"] }] }), sources, context);
  assert.strictEqual(named.ok, true, named.ok ? "" : named.reason);
});

test("validateCandidateReviewDraft: no observed fact, or an unsourced metric, blocks the review", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT]);
  const context = `[S1] ${SCREENING_RESULT.url}\n${SCREENING_RESULT.snippet}`;

  const noFacts = validateCandidateReviewDraft(validDraft({ facts: [] }), sources, context);
  assert.strictEqual(noFacts.ok, false);
  assert.match(noFacts.ok ? "" : noFacts.reason, /no observed fact/, noFacts.ok ? "" : noFacts.reason);

  const metric = validateCandidateReviewDraft(
    validDraft({ findings: [{ id: "D1", statement: "The account reaches 40,000 people a week.", evidenceIds: ["F1"] }] }),
    sources,
    context,
  );
  assert.strictEqual(metric.ok, false, "an unsourced reach figure must block the review");
  assert.match(metric.ok ? "" : metric.reason, /metric/, metric.ok ? "" : metric.reason);

  const nullDraft = validateCandidateReviewDraft(null, sources, context);
  assert.strictEqual(nullDraft.ok, false);
});

// ---------------------------------------------------------------------------
// Rendering: facts, interpretations, unknowns, conflicts, limits, sources.
// ---------------------------------------------------------------------------

const VALIDATED_REVIEW: CandidateReview = {
  status: "validated",
  sources: [...buildReviewSources("web_search_result", [SCREENING_RESULT]), ...buildReviewSources("public_social_search_result", [SOCIAL_RESULT])],
  facts: [{ id: "F1", statement: "Nova Inc entered a new market segment while keeping its original positioning language.", sourceIds: ["S1"] }],
  findings: [{ id: "D1", statement: "Its public description no longer matches the segment it operates in.", evidenceIds: ["F1"] }],
  interpretations: [{ statement: "This may indicate an uncompleted positioning update -- a hypothesis, not an established cause.", findingIds: ["D1"] }],
  unknowns: ["Whether the leadership intends a repositioning is unknown from this material."],
  conflicts: [{ statement: "No retrieved source states a rebrand, so a rebrand reading is unsupported.", sourceIds: ["S1"] }],
  limitations: ["Only one screening source and one public social snippet were retrieved."],
  socialDisclosures: ["Public social-signal search \"Nova Inc\" retrieved 1 result(s) as search-result snippets from the public index."],
  visualAnalysis: buildVisualAnalysis([]),
};

test("renderCandidateReview: keeps observed facts, interpretations/hypotheses, unknowns, conflicts, limitations and sources distinguishable", () => {
  const text = renderCandidateReview("Nova Inc", VALIDATED_REVIEW);

  assert.ok(text.includes("*Candidate review*"), text);
  assert.ok(text.includes("*Observed facts*"), "facts get their own heading");
  assert.ok(text.includes("*Findings*"), "findings get their own heading");
  assert.ok(text.includes("*Interpretations / hypotheses* — NOT established"), "an interpretation is never readable as a fact");
  assert.ok(text.includes("*Unknowns / open questions*"), "unknowns are explicit");
  assert.ok(text.includes("*Conflicting evidence* — surfaced, not resolved"), "conflicts are surfaced, never silently merged into facts");
  assert.ok(text.includes("*Evidence limitations*"), "evidence limitations are always present");

  assert.ok(text.includes(SCREENING_RESULT.url), "the direct source link is on the card");
  assert.ok(text.includes("retrieved 2026-10-19T08:00:00.000Z"), "the retrieval time is on the card");
  assert.ok(text.includes("published 2026-10-11"), "a provider-supplied publication date is on the card");
  assert.ok(text.includes("publication date not supplied by the provider"), "an absent publication date is stated as unknown, not omitted");
  assert.ok(text.includes("retrieved 2026-10-19T08:00:03.000Z"), "the social signal's own retrieval context is on the card");
  assert.ok(text.includes(SNIPPET_ONLY_LIMITATION), "the snippet-is-not-inspection limitation is on the card");
  assert.ok(text.includes(PUBLIC_SOCIAL_ACCESS_LIMITATION), "the public-only access limitation is on the card");
  assert.ok(text.includes(PUBLICATION_DATE_LIMITATION), "the publication-date limitation is on the card");
});

test("renderCandidateReview: always states that visual analysis was NOT performed, and that any future visual reading is advisory", () => {
  const text = renderCandidateReview("Nova Inc", VALIDATED_REVIEW);
  assert.ok(text.includes("*Visual analysis*"), text);
  assert.ok(/Visual analysis: not performed/i.test(text) || /- Not performed/.test(text), `the card must say visual analysis did not run: ${text}`);
  assert.ok(text.includes("advisory"), "a future visual reading is labelled advisory on the card");
});

test("renderCandidateReview: a blocked review shows the reason and presents no unvalidated statement as a review", () => {
  const blocked: CandidateReview = { ...VALIDATED_REVIEW, status: "blocked", blockedReason: "the review cites source(s) that do not appear in any material this run retrieved: S9" };
  const text = renderCandidateReview("Nova Inc", blocked);
  assert.ok(text.includes("NOT PRODUCED"), text);
  assert.ok(text.includes("S9"), "the reason is shown");
  assert.ok(text.includes("Nothing above is a validated review"), text);
  assert.ok(!text.includes("*Observed facts*"), "a blocked review must not render a facts section");
  assert.ok(!text.includes("*Findings*"), "a blocked review must not render a findings section");
  assert.ok(text.includes(SNIPPET_ONLY_LIMITATION), "the standing limitations still appear on a blocked review");
});

test("renderBlockedCandidateReview: states the reason, the standing limitations, and the missing visual capability", () => {
  const text = renderBlockedCandidateReview("Nova Inc", "the evidence step failed before it returned any output (boom)");
  assert.ok(text.includes("NOT PRODUCED"), text);
  assert.ok(text.includes("boom"), text);
  assert.ok(text.includes(SNIPPET_ONLY_LIMITATION));
  assert.ok(text.includes(PUBLIC_SOCIAL_ACCESS_LIMITATION));
  assert.ok(/Visual analysis: not performed/i.test(text), text);
});

test("renderCandidateReview: a failed social search and an empty social search stay distinguishable on the card -- 'did not complete' is never rendered as 'found none'", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Provider failure: the search itself never succeeded.
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const failed = await gatherPublicSocialSignals(envWithSearch(), "Nova Inc", discoveryCronContext());
  const failedText = renderCandidateReview("Nova Inc", { ...VALIDATED_REVIEW, socialDisclosures: failed.disclosures });

  assert.ok(failedText.includes("*Public social engagement signals*"), failedText);
  assert.ok(failedText.includes("did not complete"), `the failed search must be disclosed on the card: ${failedText}`);
  assert.ok(failedText.includes("an unsuccessful search is not an empty one"), failedText);
  assert.ok(!failedText.includes("found no indexed result"), "a failed search must never render as a completed-but-empty one");
  assert.ok(!/has no public social presence/i.test(failedText), "a failed search must never render as an established absence of presence");

  // Completed but empty: the search succeeded and returned nothing.
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch;
  const empty = await gatherPublicSocialSignals(envWithSearch(), "Nova Inc", discoveryCronContext());
  const emptyText = renderCandidateReview("Nova Inc", { ...VALIDATED_REVIEW, socialDisclosures: empty.disclosures });

  assert.ok(emptyText.includes("found no indexed result"), `an empty search is disclosed as searched-and-found-nothing: ${emptyText}`);
  assert.ok(/NOT evidence/i.test(emptyText), "an empty search still carries its not-evidence-of-absence disclosure on the card");
  assert.ok(!emptyText.includes("did not complete"), "an empty search must never render as a failed one");

  // Both outcomes survive onto a blocked review too -- a blocked review must
  // not silently drop what actually happened during retrieval.
  const blockedText = renderCandidateReview("Nova Inc", {
    ...VALIDATED_REVIEW,
    status: "blocked",
    blockedReason: "the review cites source(s) that do not appear in any material this run retrieved: S9",
    socialDisclosures: failed.disclosures,
  });
  assert.ok(blockedText.includes("NOT PRODUCED"), blockedText);
  assert.ok(blockedText.includes("did not complete"), `a blocked card still discloses the failed search: ${blockedText}`);
});

// ---------------------------------------------------------------------------
// Bounded visual analysis: capability reported, never built.
// ---------------------------------------------------------------------------

type AiMessageContentIsTextOnly = AiMessage["content"] extends string ? (string extends AiMessage["content"] ? true : false) : false;
/** Fails to compile if AiMessage.content ever stops being a plain string -- the basis for the capability report below. */
const AI_MESSAGE_CONTRACT_TEXT_ONLY: AiMessageContentIsTextOnly = true;

test("visual capability: no registered, authorized capability exists, so visual analysis is reported missing rather than built", () => {
  const capability = resolveVisualAnalysisCapability();

  assert.strictEqual(capability.available, false, "there is no vision capability in this runtime today");
  assert.strictEqual(
    require("../../runtime/toolRegistry").resolveToolOperation(VISION_TOOL_ID, VISION_ANALYSE_OPERATION_ID),
    null,
    "the Tool Registry -- the only sanctioned mechanism -- resolves no vision operation",
  );
  assert.deepStrictEqual(
    capability.missing.map((m) => m.requirement).sort(),
    ["image_message_contract", "retrieval", "vision_model"],
    "all three missing capabilities are named",
  );
  for (const requirement of capability.missing) {
    assert.strictEqual(requirement.satisfied, false, `${requirement.requirement} must be reported unsatisfied`);
    assert.ok(requirement.resolution.trim().length > 0, `${requirement.requirement} must say how it was resolved`);
  }
  assert.strictEqual(AI_MESSAGE_CONTRACT_TEXT_ONLY, true, "the AI message contract must still carry text only");
  assert.ok(capability.smallestSafeAddition.includes("Tool Registry") || capability.smallestSafeAddition.includes("Tools"), "the smallest safe addition names the registered mechanism it needs");
  assert.ok(/provider policy/i.test(capability.smallestSafeAddition), "the smallest safe addition names the provider-eligibility decision it needs");
  assert.ok(!/dispatch/i.test(capability.smallestSafeAddition) || capability.smallestSafeAddition.includes("No new dispatch path"), "the report must not propose a second dispatch mechanism");
});

test("buildVisualAnalysis: always not_performed and advisory while no capability is registered -- no fallback, no substitute", () => {
  const result = buildVisualAnalysis([{ url: "https://example.com/hero.png", retrieved: true, bytes: 1024, contentType: "image/png" }]);
  assert.strictEqual(result.status, "not_performed");
  assert.strictEqual(result.advisory, true, "visual analysis in ENIG is advisory, never authority");
  assert.match(result.reason, /visual analysis was not performed/, result.reason);
  assert.strictEqual(result.capability.available, false);
});

test("validateVisualAnalysisInput: only successfully retrieved image material inside the byte bound may be analysed", () => {
  assert.match(validateVisualAnalysisInput([]) ?? "", /no successfully retrieved image material/, "empty material is refused");

  const good: VisualAnalysisMaterial = { url: "https://example.com/hero.png", retrieved: true, bytes: 1024, contentType: "image/png" };
  assert.strictEqual(validateVisualAnalysisInput([good]), null, "retrieved in-bound image material is accepted");

  assert.match(validateVisualAnalysisInput([{ url: "https://example.com/hero.png", retrieved: false }]) ?? "", /not successfully retrieved/);
  assert.match(validateVisualAnalysisInput([{ ...good, url: "" }]) ?? "", /no source url/);
  assert.match(validateVisualAnalysisInput([{ ...good, contentType: "text/html" }]) ?? "", /not an image/);
  assert.match(validateVisualAnalysisInput([{ ...good, bytes: MAX_VISUAL_MATERIAL_BYTES + 1 }]) ?? "", /exceeds the .*byte bound/);
});

test("validateVisualAnalysisOutput: a visual result must be advisory, sourced, and attributed to supplied material", () => {
  const material: VisualAnalysisMaterial[] = [{ url: "https://example.com/hero.png", retrieved: true, bytes: 1024, contentType: "image/png" }];

  assert.match(validateVisualAnalysisOutput(null, material) ?? "", /no visual analysis output/);
  assert.match(
    validateVisualAnalysisOutput({ label: "authoritative", statement: "x", sourceUrl: material[0].url }, material) ?? "",
    /labelled advisory/,
    "output must be explicitly labelled advisory",
  );
  assert.match(
    validateVisualAnalysisOutput({ label: "advisory", statement: "", sourceUrl: material[0].url }, material) ?? "",
    /no statement/,
  );
  assert.match(
    validateVisualAnalysisOutput({ label: "advisory", statement: "x", sourceUrl: "" }, material) ?? "",
    /no source url/,
  );
  assert.match(
    validateVisualAnalysisOutput({ label: "advisory", statement: "x", sourceUrl: "https://example.com/not-supplied.png" }, material) ?? "",
    /not part of the supplied retrieved material/,
    "a result may only be attributed to material this Worker actually supplied",
  );
  assert.strictEqual(
    validateVisualAnalysisOutput({ label: "advisory reading", statement: "The hero image reads as a rebrand.", sourceUrl: material[0].url }, material),
    null,
  );
});

// ---------------------------------------------------------------------------
// End to end: one bounded review build.
// ---------------------------------------------------------------------------

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-notion-token",
    NOTION_VERSION: "2025-09-03",
    AI: {} as any,
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    GROQ_API_KEY: "test-groq-key",
    TAVILY_API_KEY: "test-tavily-key",
    ...overrides,
  } as Env;
}

function routeAiAndGovernance(t: any, reviewJson: unknown): void {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const body = String(init?.body ?? "");
    if (urlStr.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Nova Inc | LinkedIn", url: "https://www.linkedin.com/company/nova-inc", content: "Company page for Nova Inc. 12 employees listed." }] }), { status: 200 });
    }
    if (urlStr.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Acquisition Criteria: operating business; strategic/commercial problem signal." }] } }] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && urlStr.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(urlStr.split("/v1/pages/").pop()!.split("?")[0])) {
      return new Response(
        JSON.stringify({ id: urlStr.split("/").pop(), url: urlStr, parent: { type: "page", page_id: "governance-root" }, properties: {} }),
        { status: 200 },
      );
    }
    if (body.includes("Build ONE evidence-backed review")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reviewJson) } }] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${urlStr.slice(0, 120)}`);
  }) as typeof fetch;
}

const GOOD_REVIEW_JSON = {
  facts: [
    { id: "F1", statement: "Nova Inc entered a new market segment while continuing to describe itself with its original positioning language.", sourceIds: ["S1"] },
    { id: "F2", statement: "A public company page for Nova Inc lists 12 employees.", sourceIds: ["S2"] },
  ],
  findings: [{ id: "D1", statement: "Its public description does not reflect the segment it now operates in.", evidenceIds: ["F1", "F2"] }],
  interpretations: [{ statement: "This may be an uncompleted positioning update rather than a deliberate choice -- a hypothesis.", findingIds: ["D1"] }],
  unknowns: ["Whether leadership intends a repositioning is not known from this material."],
  conflicts: [{ statement: "Nothing retrieved states that Nova Inc rebranded, so a rebrand reading is unsupported.", sourceIds: ["S1"] }],
  limitations: ["Only one screening source and one public social snippet were retrieved."],
};

test("buildCandidateReview: produces a validated, source-linked review from material this run really retrieved", async (t) => {
  routeAiAndGovernance(t, GOOD_REVIEW_JSON);
  const social = await gatherPublicSocialSignals(fakeEnv(), "Nova Inc", discoveryCronContext());
  const review = await buildCandidateReview(fakeEnv(), "Nova Inc", SCREENING_RESULT, social, await lgsSkills());

  assert.strictEqual(review.status, "validated", review.blockedReason ?? "");
  assert.strictEqual(review.sources.length, 2, "the screening result plus the retrieved social snippet");
  assert.deepStrictEqual(review.facts.flatMap((f) => f.sourceIds).sort(), ["S1", "S2"], "every fact cites a real retrieved source");
  assert.strictEqual(review.interpretations.length, 1, "the interpretation is kept in its own bucket");
  assert.strictEqual(review.unknowns.length, 1, "the unknowns are kept in their own bucket");
  assert.strictEqual(review.conflicts.length, 1, "the conflict is kept in its own bucket");
  assert.ok(review.limitations.length >= 1);
  assert.strictEqual(review.socialDisclosures.length, social.disclosures.length, "the social retrieval disclosures travel onto the review");
  assert.strictEqual(review.visualAnalysis.status, "not_performed", "visual analysis did not run");
  assert.ok(review.sources.every((s) => s.validationStatus === "validated"), "sources that passed the provenance gate are marked validated");
  assert.ok(review.sources.every((s) => s.sourceType.endsWith("_snippet")), "no source may claim a page or image inspection");

  const text = renderCandidateReview("Nova Inc", review);
  assert.ok(text.includes("*Observed facts*") && text.includes("*Interpretations / hypotheses*"), text);
  assert.ok(text.includes("https://example.com/nova-positioning-shift"), "the screening source link is on the card");
  assert.ok(text.includes("https://www.linkedin.com/company/nova-inc"), "the social source link is on the card");
});

test("buildCandidateReview: a model that cites a source we never retrieved blocks the review instead of shipping it", async (t) => {
  routeAiAndGovernance(t, {
    ...GOOD_REVIEW_JSON,
    facts: [{ id: "F1", statement: "Nova Inc is the market leader in its region.", sourceIds: ["S9"] }],
  });
  const social = await gatherPublicSocialSignals(fakeEnv(), "Nova Inc", discoveryCronContext());
  const review = await buildCandidateReview(fakeEnv(), "Nova Inc", SCREENING_RESULT, social, await lgsSkills());

  assert.strictEqual(review.status, "blocked");
  assert.match(review.blockedReason ?? "", /was not retrieved|not appear in any material/, review.blockedReason ?? "");
  assert.strictEqual(review.facts.length, 0, "a blocked review carries no facts");
  const text = renderCandidateReview("Nova Inc", review);
  assert.ok(text.includes("NOT PRODUCED"), text);
  assert.ok(!text.includes("*Observed facts*"), "a blocked review must not render facts");
});

test("buildCandidateReview: a fabricated engagement metric blocks the review", async (t) => {
  routeAiAndGovernance(t, {
    ...GOOD_REVIEW_JSON,
    findings: [{ id: "D1", statement: "Its posts reach 40,000 people a week at a 6.1% engagement rate.", evidenceIds: ["F1"] }],
  });
  const social = await gatherPublicSocialSignals(fakeEnv(), "Nova Inc", discoveryCronContext());
  const review = await buildCandidateReview(fakeEnv(), "Nova Inc", SCREENING_RESULT, social, await lgsSkills());

  assert.strictEqual(review.status, "blocked");
  assert.match(review.blockedReason ?? "", /metric/i, review.blockedReason ?? "");
});

test("buildCandidateReview: when governance cannot be retrieved the review is blocked -- no persona of our own is ever substituted", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string) => {
    const urlStr = String(url);
    if (urlStr.includes("/blocks/") || urlStr.includes("/v1/pages/") || urlStr.includes("/pages/")) {
      return new Response("server error", { status: 500 });
    }
    if (urlStr.includes("api.tavily.com")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    throw new Error(`Unexpected fetch: ${urlStr.slice(0, 120)}`);
  }) as typeof fetch;

  const social = await gatherPublicSocialSignals(fakeEnv(), "Nova Inc", discoveryCronContext());
  const review = await buildCandidateReview(fakeEnv(), "Nova Inc", SCREENING_RESULT, social, await lgsSkills());

  assert.strictEqual(review.status, "blocked");
  assert.match(review.blockedReason ?? "", /governance could not be retrieved/, review.blockedReason ?? "");
});

// ===========================================================================
// Candidate-level evidence synthesis (2026-10-20): the bounded candidate-
// specific search, the combined review over the whole retrieved evidence set,
// and the verdict that either presents a traceable, explicitly unconfirmed
// opportunity hypothesis or holds the candidate with its reason.
// ===========================================================================

test("gatherCandidateEvidence: exactly ONE bounded, Access-gated candidate-specific search -- own endpoint, no credential in headers, results kept as snippets", async (t) => {
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string, init?: any) => {
    requests.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), headers: init?.headers ?? {} });
    return new Response(
      JSON.stringify({
        results: [
          { title: "Nova Inc | LinkedIn", url: "https://www.linkedin.com/company/nova-inc", content: "Company page for Nova Inc." },
          { title: "Nova Inc expands into a new segment", url: "https://example.com/nova-news", content: "Nova Inc entered a new market segment." },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const gathered = await gatherCandidateEvidence(envWithSearch(), "Nova Inc", discoveryCronContext());

  assert.strictEqual(requests.length, 1, "one nominated candidate = one candidate-specific search, never a crawl");
  assert.strictEqual(requests[0].body.query, '"Nova Inc"', "the search is the organisation's own name");
  assert.ok(
    requests[0].body.max_results <= MAX_CANDIDATE_EVIDENCE_RESULTS,
    `the candidate-specific result set is bounded (got ${requests[0].body.max_results}, bound ${MAX_CANDIDATE_EVIDENCE_RESULTS})`,
  );
  assert.ok(requests[0].url.includes("api.tavily.com"), `the ONLY retrieval endpoint is the registered search provider: ${requests[0].url}`);
  const headerNames = Object.fromEntries(Object.entries(requests[0].headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.ok(!("authorization" in headerNames) && !("cookie" in headerNames), "no authorization or cookie header is ever sent");
  assert.strictEqual(typeof requests[0].body.api_key, "string", "the provider credential travels only inside the registered search Tool's own request");

  assert.strictEqual(gathered.retrievedCount, 2, "every retrieved snippet is kept");
  assert.ok(gathered.sources.every((s) => s.sourceType === "web_search_result_snippet"), "candidate-specific results are snippets, never an inspected page");
  assert.ok(gathered.disclosures.some((d) => d.includes("retrieved 2 result(s)")), gathered.disclosures.join("\n"));
});

test("gatherCandidateEvidence: a url the review already holds is never gathered twice -- repetition cannot inflate apparent support", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          { title: "Nova Inc expands", url: "https://example.com/dupe", content: "Nova Inc entered a new segment." },
          { title: "Nova Inc expands", url: "https://example.com/dupe", content: "Nova Inc entered a new segment." },
          { title: "Nova Inc positioning page", url: SCREENING_RESULT.url, content: "Nova Inc original positioning language." },
          { title: "Nova Inc product range", url: "https://example.com/nova-range", content: "Nova Inc lists a wider product range." },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  const gathered = await gatherCandidateEvidence(envWithSearch(), "Nova Inc", discoveryCronContext(), [SCREENING_RESULT.url]);

  const urls = gathered.sources.map((s) => s.url);
  assert.deepStrictEqual(urls, ["https://example.com/dupe", "https://example.com/nova-range"], "the screening url and the repeated url are both dropped");
  assert.strictEqual(new Set(urls).size, urls.length, "one url = one source");
  assert.ok(gathered.disclosures.some((d) => d.includes("duplicate(s) of an already-retrieved url omitted")), gathered.disclosures.join("\n"));
});

test("gatherCandidateEvidence: 'searched, found nothing' and 'the search never succeeded' stay distinct -- neither is ever evidence about the organisation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let mode: "empty" | "failed" = "empty";
  globalThis.fetch = (async () =>
    mode === "empty" ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : new Response("boom", { status: 500 })) as typeof fetch;

  const empty = await gatherCandidateEvidence(envWithSearch(), "Nova Inc", discoveryCronContext());
  mode = "failed";
  const failed = await gatherCandidateEvidence(envWithSearch(), "Nova Inc", discoveryCronContext());

  assert.strictEqual(empty.retrievedCount, 0, "an empty search yields no sources");
  assert.ok(empty.disclosures.some((d) => d.includes("found no indexed result") && /NOT evidence/i.test(d)), `an empty search is disclosed as searched-nothing: ${empty.disclosures.join("\n")}`);
  assert.ok(!empty.disclosures.some((d) => d.includes("did not complete")), "an empty search must never claim it failed");

  assert.strictEqual(failed.retrievedCount, 0, "a failed search yields no sources");
  assert.ok(failed.disclosures.some((d) => d.includes("did not complete")), `a failed search is disclosed as failed: ${failed.disclosures.join("\n")}`);
  assert.ok(
    !failed.disclosures.some((d) => d.includes("found no indexed result")),
    "a search that never succeeded must never be rendered as one that searched and found nothing",
  );
  assert.ok(!failed.disclosures.some((d) => /NOT evidence that/i.test(d)), "a failure carries no claim at all about what exists");
});

test("gatherCandidateEvidence: an Access denial propagates -- it is a governance stop, never downgraded to a search failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;

  const denyingContext = workSessionContext({ workId: "work_candidate_evidence_denial" } as WorkState);
  await assert.rejects(
    () => gatherCandidateEvidence(envWithSearch(), "Nova Inc", denyingContext),
    (err: unknown) => err instanceof AccessDeniedError,
    "an Access denial must surface as AccessDeniedError",
  );
  assert.strictEqual(fetchCalled, false, "no provider request may be made once Access denies");
});

const OPPORTUNITY_REVIEW_JSON = {
  facts: [
    { id: "F1", statement: "Nova Inc still describes only its original offering in its public copy.", sourceIds: ["S1"] },
    { id: "F2", statement: "A candidate-specific result lists a wider Nova Inc product range than that copy does.", sourceIds: ["S2"] },
  ],
  findings: [
    { id: "D1", statement: "Nova Inc's public story and its current offering differ across the retrieved sources.", evidenceIds: ["F1", "F2"] },
  ],
  interpretations: [{ statement: "The mismatch may be why new buyers struggle to place Nova Inc.", findingIds: ["D1"] }],
  unknowns: ["Whether Nova Inc's own sales conversations show the same confusion."],
  conflicts: [],
  limitations: ["Retrieval was snippet-only; no page or image was inspected."],
  opportunity: {
    statement: "Nova Inc may have a story-versus-offering mismatch worth investigating -- unconfirmed.",
    findingIds: ["D1"],
    alternativeExplanations: ["The update may be a staged rollout whose positioning refresh is still in progress."],
  },
};

test("buildCandidateReview: screening + candidate-specific + social become ONE source set with sequential ids, one id per url, and the candidate-search disclosure on the card", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const body = String(init?.body ?? "");
    if (urlStr.includes("api.tavily.com")) {
      const request = JSON.parse(body);
      const query = String(request.query ?? "");
      const domainScoped = Array.isArray(request.include_domains);
      if (domainScoped) {
        return new Response(JSON.stringify({ results: [{ title: "Nova Inc | LinkedIn", url: "https://www.linkedin.com/company/nova-inc", content: "Company page for Nova Inc." }] }), { status: 200 });
      }
      if (query === '"Nova Inc"') {
        // A duplicate of the screening url (dropped) plus one genuinely new result.
        return new Response(
          JSON.stringify({
            results: [
              { title: "Nova Inc positioning shift", url: SCREENING_RESULT.url, content: "Nova Inc original positioning language." },
              { title: "Nova Inc product range page", url: "https://example.com/nova-range", content: "Nova Inc lists a wider range than its original site copy." },
            ],
          }),
          { status: 200 },
        );
      }
      if (query.endsWith("official social media")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(JSON.stringify({ results: [{ title: SCREENING_RESULT.title, url: SCREENING_RESULT.url, content: SCREENING_RESULT.snippet }] }), { status: 200 });
    }
    if (urlStr.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Acquisition Criteria: operating business; strategic/commercial problem signal." }] } }] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && urlStr.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(urlStr.split("/v1/pages/").pop()!.split("?")[0])) {
      return new Response(JSON.stringify({ id: urlStr.split("/").pop(), url: urlStr, parent: { type: "page", page_id: "governance-root" }, properties: {} }), { status: 200 });
    }
    if (body.includes("Build ONE evidence-backed review")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(OPPORTUNITY_REVIEW_JSON) } }] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${urlStr.slice(0, 120)}`);
  }) as typeof fetch;

  const candidateEvidence = await gatherCandidateEvidence(envWithSearch(), "Nova Inc", discoveryCronContext(), [SCREENING_RESULT.url]);
  const social = await gatherPublicSocialSignals(envWithSearch(), "Nova Inc", discoveryCronContext());
  const review = await buildCandidateReview(fakeEnv(), "Nova Inc", SCREENING_RESULT, social, await lgsSkills(), candidateEvidence);

  assert.strictEqual(review.status, "validated", review.blockedReason ?? "");
  assert.deepStrictEqual(
    review.sources.map((s) => s.id),
    ["S1", "S2", "S3"],
    "S1 is the screening result, S2 the candidate-specific result, S3 the social snippet -- ids are assigned across the COMBINED set",
  );
  assert.strictEqual(
    review.sources[1].url,
    "https://example.com/nova-range",
    "the screening url returned again by the candidate-specific search was dropped rather than double-counted",
  );
  assert.strictEqual(review.facts.flatMap((f) => f.sourceIds).sort().join(","), "S1,S2", "facts may cite any retrieved stage, not only the screening result");

  const text = renderCandidateReview("Nova Inc", review);
  assert.ok(text.includes("*Candidate-specific evidence search*"), `the candidate-specific retrieval step is disclosed on the card: ${text}`);
  assert.ok(text.includes("retrieved 1 result(s)"), "the disclosure says what that search actually retrieved");
  assert.ok(text.includes("1 duplicate(s) of an already-retrieved url omitted"), "the omission of an already-held url is disclosed, not silent");
  assert.ok(text.includes("*Opportunity hypothesis*") && text.includes("UNCONFIRMED"), "the validated hypothesis travels to the card, labelled unconfirmed");
  assert.ok(text.includes("[supported by D1"), `the hypothesis names the findings behind it: ${text}`);
  assert.ok(text.includes("*Alternative explanations*") && text.includes("staged rollout"), "the alternative explanation is retained on the card");
});

test("buildCandidateReview: a model that withholds a hypothesis records why, and the review stays validated-but-unsupported rather than inventing one", async (t) => {
  routeAiAndGovernance(t, {
    ...GOOD_REVIEW_JSON,
    opportunity: null,
    opportunityHoldReason: "the retrieved material is category commentary in which Nova Inc is mentioned in passing",
  });
  const social = await gatherPublicSocialSignals(fakeEnv(), "Nova Inc", discoveryCronContext());
  const review = await buildCandidateReview(fakeEnv(), "Nova Inc", SCREENING_RESULT, social, await lgsSkills());

  assert.strictEqual(review.status, "validated", "the review itself validated -- what is missing is a hypothesis, not a review");
  assert.strictEqual(review.opportunity, null, "an explicitly withheld hypothesis is recorded as withheld");
  assert.match(review.opportunityHoldReason ?? "", /mentioned in passing/, "the model's own reason is preserved for the hold");

  const verdict = evaluateCandidateSynthesis("Nova Inc", review);
  assert.strictEqual(verdict.ok, false, "no hypothesis means no presentation -- the candidate is held");
  if (!verdict.ok) {
    assert.match(verdict.reason, /no company-specific opportunity hypothesis for Nova Inc/, verdict.reason);
    assert.match(verdict.reason, /mentioned in passing/, "the hold discloses WHY, in the model's own words");
  }

  const text = renderCandidateReview("Nova Inc", review);
  assert.ok(!text.includes("*Opportunity hypothesis*"), "an withheld hypothesis is never rendered as one");
});

test("validateCandidateReviewDraft: a hypothesis citation must be as real as any other -- unknown finding, empty statement, or no finding at all blocks the review", () => {
  const sources = buildReviewSources("web_search_result", [SCREENING_RESULT]);
  const context = `${SCREENING_RESULT.title} ${SCREENING_RESULT.url} ${SCREENING_RESULT.snippet}`;
  const base = {
    facts: [{ id: "F1", statement: "Nova Inc entered a new market segment.", sourceIds: ["S1"] }],
    findings: [{ id: "D1", statement: "Its public description does not reflect the new segment.", evidenceIds: ["F1"] }],
    interpretations: [{ statement: "A hypothesis.", findingIds: ["D1"] }],
    unknowns: ["Unknown."],
    conflicts: [],
    limitations: ["Limitation."],
  };

  const fabricated = validateCandidateReviewDraft(
    { ...base, opportunity: { statement: "Nova Inc may have a positioning gap -- unconfirmed.", findingIds: ["D9"] } },
    sources,
    context,
  );
  assert.strictEqual(fabricated.ok, false, "a hypothesis citing a finding that does not exist is a fabricated citation");
  if (!fabricated.ok) assert.match(fabricated.reason, /finding "D9"/, fabricated.reason);

  const emptyStatement = validateCandidateReviewDraft(
    { ...base, opportunity: { statement: "  ", findingIds: ["D1"] } },
    sources,
    context,
  );
  assert.strictEqual(emptyStatement.ok, false, "a hypothesis with no statement is refused");

  const noFinding = validateCandidateReviewDraft(
    { ...base, opportunity: { statement: "Nova Inc may have a positioning gap -- unconfirmed.", findingIds: [] } },
    sources,
    context,
  );
  assert.strictEqual(noFinding.ok, false, "a hypothesis resting on no finding is refused");
  if (!noFinding.ok) assert.match(noFinding.reason, /rests on no finding/, noFinding.reason);

  const absent = validateCandidateReviewDraft(base, sources, context);
  assert.strictEqual(absent.ok, true, "ABSENCE of a hypothesis is an honest outcome, not a validation failure -- the synthesis holds on it instead");

  const nullHypothesis = validateCandidateReviewDraft({ ...base, opportunity: null, opportunityHoldReason: "the material shows nothing company-specific." }, sources, context);
  assert.strictEqual(nullHypothesis.ok, true, "an explicitly withheld hypothesis validates");
});

/** A validated candidate-level review over one retrieved source that names Nova Inc, with an opportunity hypothesis chain through D1 -> F1 -> S1. */
function synthesisFixture(overrides: Partial<CandidateReview> = {}): CandidateReview {
  return {
    status: "validated",
    sources: buildReviewSources("web_search_result", [SCREENING_RESULT]),
    facts: [
      { id: "F1", statement: "Nova Inc describes its original offering while its product range has widened.", sourceIds: ["S1"] },
    ],
    findings: [{ id: "D1", statement: "Two aspects of Nova Inc's public story no longer line up.", evidenceIds: ["F1"] }],
    interpretations: [],
    unknowns: [],
    conflicts: [],
    limitations: [],
    socialDisclosures: [],
    visualAnalysis: buildVisualAnalysis([]),
    opportunity: {
      statement: "Nova Inc may have a story-versus-offering mismatch worth investigating -- unconfirmed.",
      findingIds: ["D1"],
      alternativeExplanations: ["The change may be a staged rollout."],
    },
    ...overrides,
  };
}

test("evaluateCandidateSynthesis: a traceable hypothesis over KEYWORD-FREE observations passes -- no problem word is required anywhere", () => {
  const review = synthesisFixture();
  assert.strictEqual(
    review.facts.some((fact) => evidenceStatesProblemOrOpportunity(fact.statement)),
    false,
    "the supporting observation deliberately carries no signal word, so passing it cannot be a keyword match in disguise",
  );

  const verdict = evaluateCandidateSynthesis("Nova Inc", review);
  assert.strictEqual(verdict.ok, true, "several neutral, individually weak observations may jointly support a hypothesis");
  if (verdict.ok) {
    assert.deepStrictEqual(verdict.supportedByFactIds, ["F1"], "the verdict says which observations the hypothesis rests on");
    assert.ok(/unconfirmed/i.test(verdict.hypothesis.statement), "the hypothesis itself declares itself unconfirmed");
    assert.strictEqual(verdict.hypothesis.alternativeExplanations.length, 1, "the alternative explanation travels with the verdict");
  }
});

test("evaluateCandidateSynthesis: a review that was never validated can never yield a presentation", () => {
  const verdict = evaluateCandidateSynthesis("Nova Inc", synthesisFixture({ status: "blocked", blockedReason: "the review cites a source this run never retrieved: S9" }));
  assert.strictEqual(verdict.ok, false);
  if (!verdict.ok) {
    assert.match(verdict.reason, /was not validated/, verdict.reason);
    assert.match(verdict.reason, /S9/, "the validation failure itself is disclosed as the hold reason");
  }
});

test("evaluateCandidateSynthesis: a hypothesis resting on nothing -- absent, empty, or unlinked -- holds the candidate", () => {
  const absent = evaluateCandidateSynthesis("Nova Inc", synthesisFixture({ opportunity: undefined }));
  assert.strictEqual(absent.ok, false, "no hypothesis block at all can never be read as approval to present");

  const withheld = evaluateCandidateSynthesis("Nova Inc", synthesisFixture({ opportunity: null, opportunityHoldReason: "nothing company-specific is established." }));
  assert.strictEqual(withheld.ok, false);
  if (!withheld.ok) assert.match(withheld.reason, /nothing company-specific is established/, withheld.reason);

  const unlinked = evaluateCandidateSynthesis(
    "Nova Inc",
    synthesisFixture({ opportunity: { statement: "Nova Inc may have a positioning gap.", findingIds: [], alternativeExplanations: [] } }),
  );
  assert.strictEqual(unlinked.ok, false, "an unlinked hypothesis is traceable to no observation");
  if (!unlinked.ok) assert.match(unlinked.reason, /rests on no finding/, unlinked.reason);

  const missingFinding = evaluateCandidateSynthesis(
    "Nova Inc",
    synthesisFixture({ opportunity: { statement: "Nova Inc may have a positioning gap.", findingIds: ["D404"], alternativeExplanations: [] } }),
  );
  assert.strictEqual(missingFinding.ok, false, "a hypothesis pointing at a finding that does not exist is refused");
  if (!missingFinding.ok) assert.match(missingFinding.reason, /"D404"/, missingFinding.reason);
});

test("evaluateCandidateSynthesis: contradictory retrieved sources hold the candidate -- contradiction is disclosed, never averaged into support", () => {
  const verdict = evaluateCandidateSynthesis(
    "Nova Inc",
    synthesisFixture({
      conflicts: [{ statement: "One source reports Nova Inc rebranded while another reports it did not.", sourceIds: ["S1"] }],
    }),
  );
  assert.strictEqual(verdict.ok, false);
  if (!verdict.ok) {
    assert.match(verdict.reason, /sources conflict/, verdict.reason);
    assert.match(verdict.reason, /rebranded while another reports/, "the actual conflict is what gets disclosed");
  }
});

test("evaluateCandidateSynthesis: a hypothesis restated as an observed fact is refused -- a hypothesis is never an established fact", () => {
  const statement = "Nova Inc may have a story-versus-offering mismatch worth investigating -- unconfirmed.";
  const verdict = evaluateCandidateSynthesis(
    "Nova Inc",
    synthesisFixture({
      facts: [{ id: "F1", statement, sourceIds: ["S1"] }],
      opportunity: { statement, findingIds: ["D1"], alternativeExplanations: [] },
    }),
  );
  assert.strictEqual(verdict.ok, false, "dressing the hypothesis as a fact is caught deterministically");
  if (!verdict.ok) assert.match(verdict.reason, /restated as an observed fact/, verdict.reason);
});

test("evaluateCandidateSynthesis: a general problem-category source cannot carry a company-specific hypothesis, no matter how many findings rest on it", () => {
  const genericSource = buildReviewSources("web_search_result", [
    {
      title: "Why inconsistent brand messaging costs you customers",
      url: "https://example.com/brand-messaging-guide",
      snippet: "General advice: brands that mix their messaging confuse buyers.",
      provider: "tavily",
      retrieved_at: "2026-10-19T08:00:00.000Z",
    },
  ])[0];

  const verdict = evaluateCandidateSynthesis(
    "Nova Inc",
    synthesisFixture({
      // The fact NAMES the company (a passing mention) but the material behind
      // it never says anything about it -- the 2026-10-19 failure shape.
      sources: [genericSource],
      facts: [{ id: "F1", statement: "Nova Inc is mentioned once in a guide about the problem category.", sourceIds: ["S1"] }],
      opportunity: {
        statement: "Nova Inc may have inconsistent brand messaging worth investigating -- unconfirmed.",
        findingIds: ["D1"],
        alternativeExplanations: [],
      },
    }),
  );

  assert.strictEqual(verdict.ok, false, "a category article is never evidence about the company it fails to describe");
  if (!verdict.ok) {
    assert.match(verdict.reason, /general article about the problem category/, verdict.reason);
    assert.match(verdict.reason, /passing mention cannot establish a company-specific problem/, verdict.reason);
  }
});

test("evaluateCandidateSynthesis: an observation that never names the organisation cannot ground the hypothesis", () => {
  const verdict = evaluateCandidateSynthesis(
    "Nova Inc",
    synthesisFixture({
      facts: [{ id: "F1", statement: "A public result discusses inconsistent messaging in the category generally.", sourceIds: ["S1"] }],
    }),
  );
  assert.strictEqual(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /no supporting observation for Nova Inc is grounded/, verdict.reason);
});

test("evaluateCandidateSynthesis: a visual observation alone can never qualify a candidate -- the gate reaches only retrieved sources, and a visual reading is not one", () => {
  // A visual observation is structurally NOT a SourceRecord: sources are
  // built only from retrieved search results (buildReviewSources takes
  // SearchResult), so a fact resting on a visual reading cites no retrieved
  // source and the grounding step can never reach it. This test pins that
  // contract at the decision function itself, so a future vision capability
  // cannot silently start qualifying Leads on a visual impression.
  const visualOnlyReview: CandidateReview = {
    ...synthesisFixture(),
    sources: [],
    facts: [{ id: "V1", statement: "Nova Inc's homepage renders three inconsistent logo lockups.", sourceIds: [] }],
    findings: [{ id: "D1", statement: "Its visual branding presentation appears inconsistent.", evidenceIds: ["V1"] }],
    opportunity: {
      statement: "Nova Inc may have a brand-consistency gap worth investigating -- unconfirmed.",
      findingIds: ["D1"],
      alternativeExplanations: ["The variants may be deliberate per-product branding."],
    },
  };

  const verdict = evaluateCandidateSynthesis("Nova Inc", visualOnlyReview);
  assert.strictEqual(verdict.ok, false, "a hypothesis resting only on a visual observation may never qualify a candidate");
  if (!verdict.ok) {
    assert.match(
      verdict.reason,
      /no supporting observation for Nova Inc is grounded in retrieved material that names it/,
      verdict.reason,
    );
  }

  // And the gate is blind to the visual field in the OTHER direction too: the
  // ordinary, retrieved-source-grounded review passes while carrying the same
  // not_performed visual result, so visual contributes nothing to a pass
  // either. Advisory evidence for Martin, never a qualification input.
  const grounded = synthesisFixture();
  assert.strictEqual(grounded.visualAnalysis.status, "not_performed", "production never produces a performed visual analysis today");
  assert.strictEqual(grounded.visualAnalysis.advisory, true);
  assert.strictEqual(evaluateCandidateSynthesis("Nova Inc", grounded).ok, true, "qualification comes from retrieved sources alone, not from any visual reading");
});

test("blockedCandidateReview: a review that could not be BUILT is blocked with its reason and renders nothing unvalidated", () => {
  const review = blockedCandidateReview("the evidence step failed before it returned any output (boom)");
  assert.strictEqual(review.status, "blocked");
  assert.strictEqual(review.blockedReason, "the evidence step failed before it returned any output (boom)");
  assert.strictEqual(review.facts.length, 0, "no facts are invented for a review that never ran");

  const text = renderCandidateReview("Nova Inc", review);
  assert.ok(text.includes("NOT PRODUCED"), text);
  assert.ok(!text.includes("*Observed facts*"), "a blocked review renders no facts, findings, or hypothesis");
  assert.ok(!text.includes("*Opportunity hypothesis*"), "and never an opportunity hypothesis");

  const verdict = evaluateCandidateSynthesis("Nova Inc", review);
  assert.strictEqual(verdict.ok, false, "a candidate-level review that could not be built always holds the candidate");
});
