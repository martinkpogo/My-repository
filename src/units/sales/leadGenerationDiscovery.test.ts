import { salesOperationStub } from "../../testSupport/salesOperationStub";
import test from "node:test";
import assert from "node:assert";
import {
  DISCOVERY_QUERIES,
  LeadOpportunityDiscoveryCapability,
  MAX_APPROVAL_CARDS_PER_RUN,
  MAX_EVIDENCE_SYNTHESIS_PER_RUN,
  checkCandidateNomination,
  evidenceStatesProblemOrOpportunity,
  leadCandidateMemoryKey,
  handleLeadOpportunityApproval,
  normaliseForGrounding,
  notifyDiscoveryRunSummary,
  proposeLeadOpportunity,
  runAutonomousLeadDiscovery,
} from "./leadGenerationDiscovery";
import type { Env, WorkState } from "../../types";
import { salesManifest } from "./salesManifest";
import { resolveRecordedActionSkills } from "../../runtime/actionSkills";
import { resolveToolOperation } from "../../runtime/toolRegistry";
import { GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID, GOOGLE_DOCS_TOOL_ID } from "../../runtime/tools/googleDocsTool";
import {
  MAX_SOCIAL_SIGNAL_SEARCHES,
  renderBlockedCandidateReview,
} from "./candidateReview";

/** The Skills `discover_leads` declares, resolved through the Skill Registry -- the same path execution uses. */
const lgsSkills = () => resolveRecordedActionSkills(salesManifest.hats["Lead Generation Specialist"], "discover_leads");

function createMockWorkSession() {
  const calls: { init: any[][]; proposeLeadOpportunity: any[][] } = { init: [], proposeLeadOpportunity: [] };
  const stub = {
    init: async (...args: any[]) => {
      calls.init.push(args);
    },
    ...salesOperationStub({
      proposeLeadOpportunity: async (opportunity: any) => {
        calls.proposeLeadOpportunity.push([opportunity]);
      },
    }),
  };
  return {
    calls,
    workSession: {
      idFromName: (name: string) => name,
      get: (_id: any) => stub,
    },
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  const { workSession, calls } = createMockWorkSession();
  const kv = new Map<string, string>();
  const env = {
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    // Access resolves every operation's target against the Env, and refuses an
    // unresolvable one, so a fixture that omits a data source id turns any
    // write to that source into a denial. All six are declared here so a
    // failure in these tests means a real access decision, not a missing
    // fixture field.
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    OPERATIONS_TOPIC_ID: "14",
    WORKSPACE_TOPIC_ID: "100",
    MARTIN_TELEGRAM_USER_ID: "9999",
    WORK_SESSION: workSession as any,
    STATE_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    } as any,
    ...overrides,
  } as Env;
  // Test-only handles: the per-candidate Work sessions a run created, and the KV it wrote.
  (env as any).__sessions = calls;
  (env as any).__kv = kv;
  return env;
}

const PASS_EVALUATION = JSON.stringify({
  candidates: [
    {
      pass: true,
      organisation: "Acme Corp",
      // Source-grounded observation: names the organisation and states the
      // positioning-update signal (the strengthened evidence contract).
      evidence: "Acme Corp expanded into a new market but its public positioning still emphasises its original offering.",
      decisionMakerOrRole: "",
      category: "positioning",
      reason: "Recent expansion without corresponding positioning update.",
    },
  ],
});

// ---------------------------------------------------------------------------
// The mocked candidate-level review call.
// ---------------------------------------------------------------------------
//
// Discovery issues two kinds of AI call for a candidate that reaches
// presentation: the screening evaluation (a `candidates` array) and the
// bounded candidate-level review (`facts`/`findings`/`interpretations`/
// `opportunity`). These route the mocked AI between them, so a test exercises
// the REAL candidate-level synthesis instead of a review call that happens to
// fail and gets tolerated.

/**
 * A validated-shape review that SUPPORTS an opportunity hypothesis over the
 * combined material: one fact naming the organisation (grounded in S1, the
 * screening result, which names it too), a finding on that fact, a traceable
 * hypothesis pointing at the finding, and one material alternative
 * explanation.
 *
 * The fact and finding deliberately contain NO problem-signal keyword, so a
 * candidate presented with this draft is presented because the candidate-level
 * assessment supports the hypothesis -- not because a keyword list matched.
 */
function supportedReviewDraft(organisation: string) {
  return {
    facts: [
      {
        id: "F1",
        statement: `${organisation}'s public site still presents the original offering while its product line has moved on.`,
        sourceIds: ["S1"],
      },
    ],
    findings: [
      {
        id: "D1",
        statement: `The retrieved material shows the public story and the current offering of ${organisation} no longer line up.`,
        evidenceIds: ["F1"],
      },
    ],
    interpretations: [
      { statement: `Buyers may be struggling to place ${organisation} because of that mismatch.`, findingIds: ["D1"] },
    ],
    unknowns: [`Whether ${organisation}'s own conversations show the same confusion.`],
    conflicts: [],
    limitations: ["Retrieval was snippet-only: no page, image, or engagement figure was inspected."],
    opportunity: {
      statement: `${organisation} may have a story-versus-offering mismatch worth investigating in a consultancy conversation -- unconfirmed.`,
      findingIds: ["D1"],
      alternativeExplanations: ["The change may be a staged rollout whose positioning update is still planned."],
    },
  };
}

/**
 * A validated-shape review that assesses the combined material and finds NO
 * company-specific opportunity in it -- the honest hold: passing mention,
 * keyword-only match, repetitive or irrelevant sources, contradiction.
 */
function insufficientReviewDraft(organisation: string) {
  return {
    facts: [
      {
        id: "F1",
        statement: `A public result names ${organisation} once, alongside commentary about the category rather than about it.`,
        sourceIds: ["S1"],
      },
    ],
    findings: [
      { id: "D1", statement: `The retrieved material discusses the problem category around ${organisation}, not a demonstrated situation at it.`, evidenceIds: ["F1"] },
    ],
    interpretations: [],
    unknowns: [`Whether ${organisation} has any positioning problem at all.`],
    conflicts: [],
    limitations: ["The retrieved material is a single snippet and was not inspected beyond it."],
    opportunity: null,
    opportunityHoldReason: `the retrieved material is category commentary in which ${organisation} is mentioned in passing, so nothing company-specific is established`,
  };
}

/**
 * Routes one mocked AI request: the bounded review call gets a review draft
 * for the organisation under review; every other AI call (screening, on-demand
 * query strategy) gets `fallback`.
 */
function mockAiContent(body: string, fallback: string, review: (organisation: string) => unknown = supportedReviewDraft): string {
  if (body.includes("Build ONE evidence-backed review")) {
    const organisation = body.match(/Candidate under review: ([^"\\]+?)(?:\\n|")/)?.[1]?.trim() || "the organisation";
    return JSON.stringify(review(organisation));
  }
  return fallback;
}

test("DISCOVERY_QUERIES targets observable business situations without presupposing negative diagnoses", () => {
  assert.ok(Array.isArray(DISCOVERY_QUERIES) && DISCOVERY_QUERIES.length >= 5, "DISCOVERY_QUERIES must be a non-empty array with coverage across situation categories");

  const forbiddenDiagnosticTerms = ["poor", "bad", "confused", "ineffective", "weak", "failing"];
  for (const query of DISCOVERY_QUERIES) {
    const lower = query.toLowerCase();
    for (const term of forbiddenDiagnosticTerms) {
      assert.ok(!lower.includes(term), `DISCOVERY_QUERIES item "${query}" must not contain diagnostic presupposition term "${term}"`);
    }
  }

  const queryBlock = DISCOVERY_QUERIES.join(" ").toLowerCase();
  assert.ok(queryBlock.includes("rebrand") || queryBlock.includes("repositioning"), "must cover repositioning/brand change signals");
  assert.ok(queryBlock.includes("market") || queryBlock.includes("expansion"), "must cover market/customer expansion signals");
  assert.ok(queryBlock.includes("offering") || queryBlock.includes("service") || queryBlock.includes("model"), "must cover offering/business-model change signals");
  assert.ok(queryBlock.includes("funding") || queryBlock.includes("growth") || queryBlock.includes("acquisition"), "must cover growth/strategic change signals");
  assert.ok(queryBlock.includes("messaging") || queryBlock.includes("value proposition") || queryBlock.includes("positioning"), "must cover communication/positioning signals");
});

test("runAutonomousLeadDiscovery does nothing when web search isn't configured -- never fabricates a run", async () => {
  const summary = await runAutonomousLeadDiscovery(fakeEnv(), await lgsSkills());
  assert.deepStrictEqual(summary, {
    evaluated: 0,
    heldOverCap: 0,
    evidenceSynthesisAttempts: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 0,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: DISCOVERY_QUERIES.length,
    searchFailed: 0,
  });
});

test("LGS: a provider failure during the run is recorded as a FAILED search, never as an empty result -- the digest says the search did not run", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () => {
    throw new Error("Tavily 500");
  }) as typeof fetch;

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key" }), await lgsSkills());
  assert.strictEqual(summary.evaluated, 0, "a failed search must never produce evaluations");
  assert.strictEqual(summary.searchFailed, DISCOVERY_QUERIES.length, "every failed query is recorded as failed, not as empty");
  assert.strictEqual(summary.searchUnavailable, 0);

  const sentTexts: string[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    if (String(url).includes("api.telegram.org")) {
      sentTexts.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "activity-log-entry", properties: {} }), { status: 200 });
  }) as typeof fetch;

  const ok = await notifyDiscoveryRunSummary(fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576" }), 1, undefined, summary);
  assert.strictEqual(ok, true);
  assert.strictEqual(sentTexts.length, 1);
  assert.ok(sentTexts[0].includes("web search could not complete"), sentTexts[0]);
  assert.ok(sentTexts[0].includes(`${DISCOVERY_QUERIES.length} failed`), sentTexts[0]);
  assert.ok(sentTexts[0].includes("NOT evidence that no opportunities exist"), `a provider failure must never read as "no opportunities exist": ${sentTexts[0]}`);
});

test("notifyDiscoveryRunSummary distinguishes 'searches completed, nothing found' from 'search never ran'", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    sentTexts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576" });
  const emptySummary = {
    evaluated: 0,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 0,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  };

  // Every query ran and the provider genuinely returned nothing.
  await notifyDiscoveryRunSummary(env, 1, undefined, { ...emptySummary });
  assert.ok(sentTexts[0].includes("searches completed but returned no results"), sentTexts[0]);
  assert.ok(!sentTexts[0].includes("unavailable"), `a clean empty run must not claim unavailability: ${sentTexts[0]}`);

  // The search itself could not run at all.
  await notifyDiscoveryRunSummary(env, 1, undefined, { ...emptySummary, searchUnavailable: DISCOVERY_QUERIES.length });
  assert.ok(sentTexts[1].includes("web search could not complete"), sentTexts[1]);
  assert.ok(sentTexts[1].includes(`${DISCOVERY_QUERIES.length} unavailable`), sentTexts[1]);
  assert.ok(sentTexts[1].includes("NOT evidence that no opportunities exist"), sentTexts[1]);
});

test("notifyDiscoveryRunSummary appends the search-failure note to a digest that did evaluate candidates", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    sentTexts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await notifyDiscoveryRunSummary(fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576" }), 1, undefined, {
    evaluated: 12,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 11,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 1,
    searchFailed: 2,
  });
  assert.ok(sentTexts[0].includes("12 candidate(s) evaluated"), sentTexts[0]);
  assert.ok(sentTexts[0].includes("Search did not complete for 3 queries (1 unavailable, 2 failed)"), sentTexts[0]);
  assert.ok(sentTexts[0].includes("absence of results from those is not evidence"), sentTexts[0]);
});

test("notifyDiscoveryRunSummary names a failed duplicate check instead of reporting a clean run", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    sentTexts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await notifyDiscoveryRunSummary(fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576" }), 1, undefined, {
    evaluated: 12,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 3,
    pendingApproval: 0,
    screenedOut: 9,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  });
  assert.ok(sentTexts[0].includes("12 candidate(s) evaluated"), sentTexts[0]);
  assert.ok(sentTexts[0].includes("3 candidate(s) passed screening but could not be checked for duplicates"), sentTexts[0]);
  assert.ok(sentTexts[0].includes("not evidence those organisations are new"), sentTexts[0]);
  assert.ok(sentTexts[0].includes("see Blockers"), sentTexts[0]);

  // A clean run must not grow the note.
  sentTexts.length = 0;
  await notifyDiscoveryRunSummary(fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576" }), 1, undefined, {
    evaluated: 12,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 12,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  });
  assert.ok(!sentTexts[0].includes("could not be checked for duplicates"), `a run with no such failure must not claim one: ${sentTexts[0]}`);
});

test("Test A: Candidate signal passes lightweight screening -> one approval card on a record_lead Work; no Handoff and no Lead is created", async (t) => {
  const originalFetch = globalThis.fetch;
  let handoffsCreatedCount = 0;
  let leadsCreatedCount = 0;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    const aiBody = String(init?.body ?? "");
    if (url.includes("api.tavily.com")) {
      return new Response(
        JSON.stringify({
          results: [{ title: "Acme Corp expands into enterprise market", url: "https://example.com/acme", content: "Acme expansion news." }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST") {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("handoffs-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        handoffsCreatedCount++;
      }
      if (body.parent?.data_source_id === "leads-ds") {
        leadsCreatedCount++;
      }
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: mockAiContent(aiBody, PASS_EVALUATION) } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });
  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());
  const sessions = (env as any).__sessions;

  // Martin's decision (2026-10-12): screening is the bar for a CARD, his
  // approval is the bar for a Lead. Every query surfaces the same Acme Corp,
  // so exactly one card is sent and the repeats are recognised.
  assert.strictEqual(leadsCreatedCount, 0, "no Lead may be created upon screening alone -- only Martin's approval creates one");
  assert.strictEqual(handoffsCreatedCount, 0, "no Handoff is created for a screened candidate");
  assert.strictEqual(summary.pendingApproval, 1, "the screened candidate is presented once");
  assert.strictEqual(summary.skippedAlreadyPresented, summary.evaluated - 1, "the same organisation from later queries gets no second card");
  assert.strictEqual(sessions.init.length, 1, "one Work per presented candidate");
  assert.strictEqual(sessions.init[0][2], "Sales");
  assert.strictEqual(sessions.init[0][3], "Lead Generation Specialist");
  assert.deepStrictEqual(sessions.init[0][5], { actionName: "record_lead" }, "the candidate's Work records the approval-gated record_lead Action from creation");
  assert.strictEqual(sessions.proposeLeadOpportunity.length, 1);
  assert.strictEqual(sessions.proposeLeadOpportunity[0][0].organisation, "Acme Corp");
  assert.strictEqual(sessions.proposeLeadOpportunity[0][0].sourceUrl, "https://example.com/acme");
});

const UNSUPPORTED_EVALUATION = JSON.stringify({
  candidates: [
    {
      pass: false,
      organisation: "Acme Corp",
      // No supported diagnosis: the signal is real, the inference is not.
      evidence: "Acme announced a new regional office, which says nothing about its positioning or commercial model.",
      decisionMakerOrRole: "",
      category: "",
      reason: "Expansion alone does not evidence a positioning, offering, or growth problem; the diagnosis would be a hypothesis, not a finding.",
    },
  ],
});

/**
 * The confirmed live failure this threshold corrects (2026-10-19): the AI
 * passed a candidate on a GENERAL article about brand messaging and dressed
 * the observation up as Brand Russo's own problem. The evidence names the
 * company, but the retrieved source never mentions it.
 */
const BRAND_RUSSO_EVALUATION = JSON.stringify({
  candidates: [
    {
      pass: true,
      organisation: "Brand Russo",
      evidence: "Brand Russo's positioning is inconsistent with what it actually delivers.",
      decisionMakerOrRole: "",
      category: "positioning",
      reason: "A perception gap may be costing it qualified enquiries.",
    },
  ],
});

/** A named organisation with a perfectly neutral event and nothing else -- real, but not a demonstrated problem. */
const NEUTRAL_REBRAND_EVALUATION = JSON.stringify({
  candidates: [
    {
      pass: true,
      organisation: "Zenith Co",
      evidence: "Zenith Co announced a rebrand of its visual identity.",
      decisionMakerOrRole: "",
      category: "brand",
      reason: "A rebrand often signals strategic change.",
    },
  ],
});

/**
 * Installs a Tavily/Notion/LLM mock for one autonomous discovery run and
 * returns the facts a caller can assert on: which governed records were
 * actually created, every governed create body that went over the wire, and
 * what the Activity Log recorded.
 *
 * Keeping the create bodies (not just the counts) is deliberate: a test can
 * then assert that no identity-bearing value ever reached Notion, which is a
 * stronger claim than "the right number of records was created".
 */
type TavilyResult = { title: string; url: string; content: string };
/** Fixed results, or a per-call function (so one run can surface genuinely different result sets per search). */
type TavilyResults = Array<TavilyResult> | ((ctx: { query: string; domainScoped: boolean; call: number }) => Array<TavilyResult>);

function installDiscoveryRun(t: any, evaluation: string, opts: { leadsQueryFails?: boolean; tavilyResults?: TavilyResults; review?: (organisation: string) => unknown } = {}) {
  const originalFetch = globalThis.fetch;
  const created: Record<string, number> = { handoffs: 0, leads: 0, proposals: 0, matters: 0, entities: 0 };
  const createBodies: any[] = [];
  const activityEntries: any[] = [];
  const searchQueries: Array<{ query: string; domainScoped: boolean }> = [];
  const tavilyResults = opts.tavilyResults ?? [{ title: "Acme Corp expands into enterprise market", url: "https://example.com/acme", content: "Acme Corp expansion news." }];
  let tavilyCalls = 0;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (url.includes("api.tavily.com")) {
      const request = JSON.parse(body);
      const query = String(request.query ?? "");
      const domainScoped = Array.isArray(request.include_domains);
      searchQueries.push({ query, domainScoped });
      const call = tavilyCalls++;
      const results = typeof tavilyResults === "function" ? tavilyResults({ query, domainScoped, call }) : tavilyResults;
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST") {
      if (opts.leadsQueryFails) {
        return new Response(JSON.stringify({ object: "error", message: "Notion unavailable" }), { status: 500 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("handoffs-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      createBodies.push(body);
      const ds = body.parent?.data_source_id;
      if (ds === "handoffs-ds") created.handoffs++;
      if (ds === "leads-ds") created.leads++;
      if (ds === "proposals-ds") created.proposals++;
      if (ds === "matters-ds") created.matters++;
      if (ds === "entity-ds") created.entities++;
      if (ds === "activity-log-ds") activityEntries.push(body.properties);
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", parent: { type: "data_source_id", data_source_id: ds }, properties: {} }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: mockAiContent(body, evaluation, opts.review ?? supportedReviewDraft) } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return { created, createBodies, activityEntries, searchQueries };
}

test("LGS: a candidate passing lightweight screening is PRESENTED for approval -- no Handoff, no Lead, and no Blocker", async (t) => {
  const { created, activityEntries } = installDiscoveryRun(t, PASS_EVALUATION);

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.strictEqual(created.handoffs, 0, "no Handoff may be created: Research & Intelligence is not a destination and no replacement exists");
  assert.strictEqual(created.leads, 0, "and certainly no Lead -- lightweight screening alone never creates one");
  assert.ok(summary.evaluated > 0, "the candidate really was evaluated");
  assert.strictEqual(summary.pendingApproval + summary.skippedAlreadyPresented, summary.evaluated, "every candidate that passed screening is presented once, and the summary says so");
  assert.strictEqual(summary.pendingApproval, 1);
  assert.strictEqual(
    activityEntries.filter((p) => p?.Type?.select?.name === "Blocker").length,
    0,
    "presenting a candidate is not a refused governed write, so it must not be logged as a Blocker",
  );
});

test("LGS: a failed duplicate check is COUNTED and logged as a Blocker -- a Notion read failure is never reported as a clean bucket", async (t) => {
  const { created, activityEntries } = installDiscoveryRun(t, PASS_EVALUATION, { leadsQueryFails: true });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.ok(summary.evaluated > 0, "the candidate really was evaluated");
  assert.strictEqual(
    summary.duplicateCheckFailed,
    summary.evaluated,
    "every candidate that passed screening but whose duplicate check threw is counted here -- previously it was dropped from the summary entirely",
  );
  assert.strictEqual(summary.pendingApproval, 0, "a candidate whose duplicate check failed must not be presented as if it were clear");
  assert.strictEqual(created.leads, 0, "and it certainly creates no Lead");
  assert.strictEqual(created.handoffs, 0, "and no Handoff");

  const blockers = activityEntries.filter((p) => p?.Type?.select?.name === "Blocker");
  assert.strictEqual(blockers.length, summary.duplicateCheckFailed, "each failure is logged as a Blocker");
  for (const blocker of blockers) {
    assert.ok(String(blocker?.Entry?.title?.[0]?.text?.content ?? "").includes("duplicate check failed"), `the Blocker names the failed duplicate check: ${JSON.stringify(blocker?.Entry)}`);
  }

  // The invariant this regression exists to protect: a run may never lose a
  // candidate between buckets. The 2026-10-19 production run reported
  // evaluated=39 with buckets summing to 38 -- exactly this path.
  const buckets =
    summary.screenedOut +
    summary.skippedAsInsufficient +
    summary.skippedAsDuplicate +
    summary.duplicateCheckFailed +
    summary.skippedAlreadyPresented +
    summary.heldOverCap +
    summary.pendingApproval +
    summary.presentationFailed;
  assert.strictEqual(buckets, summary.evaluated, "every evaluated candidate lands in exactly one bucket");
});

test("LGS: an unsupported diagnosis is screened out before any governed write -- no Handoff, no Lead, and nothing identity-bearing reaches Notion", async (t) => {
  const { created, createBodies, activityEntries } = installDiscoveryRun(t, UNSUPPORTED_EVALUATION);

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.ok(summary.evaluated > 0, "the candidate was evaluated");
  assert.strictEqual(summary.screenedOut, summary.evaluated, "an unsupported diagnosis is screened out, not escalated");
  assert.strictEqual(created.handoffs, 0, "no Handoff for a candidate whose diagnosis is only a hypothesis");
  assert.strictEqual(created.leads, 0, "and no Lead");
  assert.strictEqual(summary.pendingApproval, 0, "a screened-out candidate is never presented");

  // With no Handoff created, the identity boundary is asserted where it can
  // be checked end-to-end: on the wire. Nothing this run wrote anywhere in Notion may
  // carry a real Entity or Matter identity -- no name, no relation, no contact
  // detail. The only tokens it is even capable of writing are the opaque
  // placeholders, and a candidate that is never routed must not be
  // smuggled into some other record on the way past.
  const identityKeys = ["entityName", "matterName", "Entity", "Matter", "email", "phone", "contact"];
  for (const body of createBodies) {
    for (const key of identityKeys) {
      assert.ok(
        !(key in (body.properties ?? {})),
        `no governed create may carry a real identity field "${key}" (parent: ${body.parent?.data_source_id}): ${JSON.stringify(body.properties)}`,
      );
    }
  }

  // Screening out is ordinary judgement, not a refusal, so it is reported as a
  // screened count in the run summary rather than as a Blocker. Assert that
  // distinction: a screen-out must not manufacture a governance incident.
  assert.strictEqual(
    activityEntries.filter((p) => p?.Type?.select?.name === "Blocker").length,
    0,
    "screening a candidate out is a judgement, not a blocked governed write -- it must not be logged as a Blocker",
  );
});

test("Test D & G: A passing candidate is presented with no Handoff written -- its unvalidated diagnosis is never asserted as a fact", async (t) => {
  const originalFetch = globalThis.fetch;
  let createdHandoffBody: any;
  const deltaEvaluation = JSON.stringify({
    candidates: [{ pass: true, organisation: "Delta Corp", evidence: "Delta Corp launched a new product line while its public positioning still describes only its original offering.", decisionMakerOrRole: "", category: "", reason: "" }],
  });

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    const aiBody = String(init?.body ?? "");
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Delta Corp new product line", url: "https://example.com/delta", content: "Delta new product." }] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("handoffs-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "handoffs-ds") {
        createdHandoffBody = body;
      }
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: mockAiContent(aiBody, deltaEvaluation) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  // Screening still runs and still passes; nothing is routed onward.
  assert.strictEqual(createdHandoffBody, undefined, "no Handoff is written for a presented candidate");
  assert.ok(summary.pendingApproval >= 1, "the candidate is presented for approval, not dropped silently");
});

test("runAutonomousLeadDiscovery never creates a Lead from an inconsistent AI 'pass' with no organisation/evidence -- fails closed on the evidence-threshold gate itself", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Some Company", url: "https://example.com/post", content: "Vague content." }] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      leadsCreatedCount++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    // AI claims pass:true but supplies no organisation/evidence -- inconsistent output.
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{ pass: true, organisation: "", evidence: "", decisionMakerOrRole: "", category: "", reason: "" }] }) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.strictEqual(leadsCreatedCount, 0);
  assert.strictEqual(summary.skippedAsInsufficient, DISCOVERY_QUERIES.length);
});

// ===========================================================================
// Candidate-level evidence synthesis (2026-10-20). Nomination replaces the
// per-snippet keyword gate: an AI pass must be tied to THIS retrieved result
// and to a named organisation (deterministic, keyword-free), and whether the
// candidate actually has a company-specific problem is decided afterwards by
// the bounded candidate-level review over the whole retrieved evidence set
// (evaluateCandidateSynthesis in candidateReview.ts). The 2026-10-19 card
// that cited a general problem-category article for a NAMED organisation can
// still not be produced: that article never names the company. What changed
// is the false-negative side -- several individually neutral observations no
// longer die on a wordlist before a review can weigh them together.
// ===========================================================================

test("checkCandidateNomination: a general article about the problem category never nominates a company it does not name", () => {
  const verdict = checkCandidateNomination(
    { organisation: "Brand Russo", evidence: "Brand Russo's positioning is inconsistent with what it actually delivers." },
    { title: "Why inconsistent brand messaging costs you customers", url: "https://example.com/brand-messaging-guide", snippet: "General advice: brands that mix their messaging confuse buyers." },
  );
  assert.strictEqual(verdict.ok, false, "the retrieved result never mentions Brand Russo -- the article is about the category, not the company");
  if (!verdict.ok) {
    assert.match(verdict.reason, /does not name Brand Russo/);
    assert.match(verdict.reason, /general article about the problem category/);
  }
});

test("checkCandidateNomination: an observation not tied to the named organisation is never nominated -- the card may only carry what says something about THIS company", () => {
  const verdict = checkCandidateNomination(
    { organisation: "Brand Russo", evidence: "The company's public messaging is inconsistent with what it delivers." },
    { title: "Brand Russo positioning", url: "https://example.com/brand-russo", snippet: "Brand Russo expanded into a new market." },
  );
  assert.strictEqual(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /evidence does not name Brand Russo/);
});

test("checkCandidateNomination: a neutral business event at a NAMED organisation IS nominated -- the keyword list no longer decides who receives a review", () => {
  const result = { title: "Zenith Co news", url: "https://example.com/zenith", snippet: "Zenith Co update." };
  const neutralEvents = [
    "Zenith Co announced a rebrand of its visual identity.",
    "Zenith Co expanded into a new regional market.",
    "Zenith Co appointed a new chief executive.",
    "Zenith Co launched a new product line.",
  ];
  for (const evidence of neutralEvents) {
    const nomination = checkCandidateNomination({ organisation: "Zenith Co", evidence }, result);
    assert.strictEqual(nomination.ok, true, `naming is the whole nomination bar, whatever the wording: ${evidence}`);
    assert.strictEqual(
      evidenceStatesProblemOrOpportunity(evidence),
      false,
      `the vocabulary records no signal for a bare event (it is a hint only): ${evidence}`,
    );
  }

  // The same result with a signal-carrying observation nominates identically.
  // Nomination is deliberately indifferent to the vocabulary in both
  // directions: no keyword can create one, and no missing keyword can stop one.
  const grounded = checkCandidateNomination(
    { organisation: "Zenith Co", evidence: "Zenith Co rebranded but its public positioning still describes only its original offering." },
    result,
  );
  assert.deepStrictEqual(grounded, { ok: true });

  // ...and nomination alone still never presents anything: the candidate-
  // level synthesis decides (asserted end-to-end below, where a neutral
  // observation with a review that finds nothing company-specific is HELD
  // without a card).
});

test("normaliseForGrounding: punctuation- and case-insensitive for Latin names, and never collapses a non-Latin name to nothing", () => {
  assert.strictEqual(normaliseForGrounding("Acme, Corp."), "acme corp");
  assert.strictEqual(normaliseForGrounding("  ACME   corp "), "acme corp");
  assert.strictEqual(normaliseForGrounding("株式会社サクラ"), "株式会社サクラ", "non-Latin names survive normalisation intact");

  // End-to-end through nomination: a non-Latin organisation grounds the same way.
  const verdict = checkCandidateNomination(
    { organisation: "株式会社サクラ", evidence: "株式会社サクラ expanded but its positioning still describes only its original offering." },
    { title: "株式会社サクラ rebrands", url: "https://example.com/sakura", snippet: "株式会社サクラ news." },
  );
  assert.deepStrictEqual(verdict, { ok: true });
});

test("evidenceStatesProblemOrOpportunity: bounded signal vocabulary -- a problem observation matches, a bare announcement and an empty string do not, and it decides nothing", () => {
  assert.strictEqual(evidenceStatesProblemOrOpportunity(""), false);
  assert.strictEqual(evidenceStatesProblemOrOpportunity("Zenith Co announced a rebrand."), false);
  assert.strictEqual(evidenceStatesProblemOrOpportunity("Zenith Co's public messaging is unclear to buyers."), true);
  assert.strictEqual(evidenceStatesProblemOrOpportunity("Zenith Co's growth has been stagnant for six quarters."), true);

  // Regression for the 2026-10-20 retargeting: this helper is a diagnosability
  // hint logged with a hold, never part of a gate. Both facts must hold or the
  // vocabulary has crept back into the decision path.
  const nominationWithNoSignal = checkCandidateNomination(
    { organisation: "Zenith Co", evidence: "Zenith Co announced a rebrand." },
    { title: "Zenith Co news", url: "https://example.com/zenith", snippet: "Zenith Co update." },
  );
  assert.deepStrictEqual(nominationWithNoSignal, { ok: true}, "a signal-free observation must still be nominated for its review");
});

test("LGS: a general problem-category article is HELD as insufficient evidence -- no approval card, no Work, no Lead, no Blocker", async (t) => {
  const { created, activityEntries, searchQueries } = installDiscoveryRun(t, BRAND_RUSSO_EVALUATION, {
    tavilyResults: [{ title: "Why inconsistent brand messaging costs you customers", url: "https://example.com/brand-messaging-guide", content: "General advice for owners: mixed messaging confuses buyers." }],
  });
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  assert.ok(summary.evaluated > 0, "the candidates were evaluated");
  assert.strictEqual(summary.pendingApproval, 0, "a general article must never become an approval card claiming this company has the problem");
  assert.strictEqual(summary.skippedAsInsufficient, summary.evaluated, "every such candidate is held as insufficient evidence");
  assert.strictEqual(
    summary.evidenceSynthesisAttempts ?? 0,
    0,
    "a candidate the retrieval never names is held at nomination -- before any candidate-level search or review call is spent on it",
  );
  assert.strictEqual(
    searchQueries.length,
    DISCOVERY_QUERIES.length,
    "only the screening searches ran: no candidate-specific or social search for a candidate that was never nominated",
  );
  assert.strictEqual((env as any).__sessions.init.length, 0, "no Work is created for a held candidate");
  assert.strictEqual(created.leads, 0, "and no Lead");
  assert.strictEqual(created.handoffs, 0, "and no Handoff");
  assert.strictEqual(
    activityEntries.filter((p) => p?.Type?.select?.name === "Blocker").length,
    0,
    "holding a candidate is a screening judgement, not a blocked governed write -- it must not be logged as a Blocker",
  );
});

test("LGS: a neutral business event at a named organisation is NOMINATED, given a candidate-level review, and still HELD when the material shows nothing company-specific", async (t) => {
  const { created, searchQueries } = installDiscoveryRun(t, NEUTRAL_REBRAND_EVALUATION, {
    tavilyResults: [{ title: "Zenith Co announces rebrand", url: "https://example.com/zenith-rebrand", content: "Zenith Co unveiled a new logo and visual identity." }],
    // The combined material really is just an event announcement, so the
    // review honestly returns no company-specific opportunity hypothesis.
    review: insufficientReviewDraft,
  });
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  assert.ok(summary.evaluated > 0, "the candidates were evaluated");
  assert.strictEqual(summary.pendingApproval, 0, "a bare neutral event must not be presented as a demonstrated problem");
  assert.ok(summary.skippedAsInsufficient > 0, "the review held the candidate as insufficient evidence");

  // Half (1) of the 2026-10-20 correction: the keyword list no longer stops a
  // neutrally-worded observation from receiving a real, substantive review.
  // The candidate-level search ran and an attempt was spent -- the old gate
  // would have stopped this candidate before any of that.
  assert.ok(
    (summary.evidenceSynthesisAttempts ?? 0) > 0,
    "the neutral observation received a bounded candidate-level evidence review instead of dying on a wordlist",
  );
  assert.ok(
    searchQueries.some((q) => !q.domainScoped && q.query === '"Zenith Co"'),
    `the review first gathered candidate-specific public evidence for the named organisation: ${JSON.stringify(searchQueries)}`,
  );
  // ...and the budget kept that spending bounded: once MAX_EVIDENCE_SYNTHESIS_PER_RUN
  // attempts were spent, later nominations were held rather than reviewed again.
  assert.strictEqual(
    summary.evidenceSynthesisAttempts,
    MAX_EVIDENCE_SYNTHESIS_PER_RUN,
    "the run stops at the synthesis budget instead of reviewing candidates with no end",
  );
  // Run-wide search volume stays a small constant: screening searches plus at
  // most one candidate search and the bounded social step per attempt.
  assert.ok(
    searchQueries.length <= DISCOVERY_QUERIES.length + MAX_EVIDENCE_SYNTHESIS_PER_RUN * (1 + MAX_SOCIAL_SIGNAL_SEARCHES),
    `searches stay bounded: ${searchQueries.length} (<= ${DISCOVERY_QUERIES.length} screening + ${MAX_EVIDENCE_SYNTHESIS_PER_RUN} attempts x ${1 + MAX_SOCIAL_SIGNAL_SEARCHES} retrieval searches)`,
  );

  // Half (2): the candidate-level assessment still holds it -- no card, no
  // Work, no Lead -- and every candidate still lands in exactly one bucket
  // (holds consume no card, so the card cap alone cannot bound them).
  assert.strictEqual(summary.pendingApproval + summary.skippedAlreadyPresented + summary.heldOverCap + summary.skippedAsInsufficient, summary.evaluated, "every evaluated candidate lands in exactly one bucket");
  assert.strictEqual((env as any).__sessions.init.length, 0, "no Work is created for a held candidate");
  assert.strictEqual(created.leads, 0, "and no Lead");
});

test("candidate-level synthesis: several individually NEUTRAL observations jointly support an opportunity hypothesis -- labelled unconfirmed, traceable to its facts, with a retained alternative explanation", async (t) => {
  const NEUTRAL_EVALUATION = JSON.stringify({
    candidates: [
      {
        pass: true,
        organisation: "Acme Corp",
        // A bare event announcement: no problem/opportunity vocabulary anywhere
        // in the observation, so the retired wordlist gate could never have
        // nominated this candidate at all.
        evidence: "Acme Corp announced a rebrand of its visual identity this month.",
        decisionMakerOrRole: "",
        category: "rebrand",
        reason: "Announced rebrand with no stated follow-through.",
      },
    ],
  });
  assert.strictEqual(
    evidenceStatesProblemOrOpportunity("Acme Corp announced a rebrand of its visual identity this month."),
    false,
    "the screening observation itself carries no signal word -- whatever supports the hypothesis must be the combined review",
  );

  const { created } = installDiscoveryRun(t, NEUTRAL_EVALUATION, {
    // Fresh, uniquely-url'd results per search so the review genuinely has
    // several distinct observations to weigh: the screening announcement, the
    // candidate-specific range page, and a social snippet.
    tavilyResults: ({ domainScoped, query }) => {
      if (domainScoped) {
        return [{ title: "Acme Corp social post", url: "https://social.example.com/acme-post", content: "Acme Corp shared its latest release notes." }];
      }
      if (query.startsWith('"')) {
        return [{ title: "Acme Corp product range page", url: "https://example.com/acme-range", content: "Acme Corp lists a wider range of products than its original site copy." }];
      }
      return [{ title: "Acme Corp announces rebrand", url: "https://example.com/acme-rebrand", content: "Acme Corp unveiled a new logo and visual identity." }];
    },
    // Each observation on its own is neutral: the finding (and the hypothesis
    // built on it) exists only because the review weighs them together.
    review: (organisation) => ({
      facts: [
        { id: "F1", statement: `${organisation} still describes only its original offering on its public site.`, sourceIds: ["S1"] },
        { id: "F2", statement: `${organisation}'s product range page lists a wider range of products than that site copy does.`, sourceIds: ["S2"] },
      ],
      findings: [{ id: "D1", statement: `Two retrieved sources describe ${organisation} in two different ways.`, evidenceIds: ["F1", "F2"] }],
      interpretations: [{ statement: `The mismatch may be why new buyers struggle to place ${organisation}.`, findingIds: ["D1"] }],
      unknowns: [`Whether ${organisation}'s own sales conversations show the same confusion.`],
      conflicts: [],
      limitations: ["Retrieval was snippet-only; no page or image was inspected."],
      opportunity: {
        statement: `${organisation} may have a story-versus-offering mismatch worth investigating in a consultancy conversation -- unconfirmed.`,
        findingIds: ["D1"],
        alternativeExplanations: ["The rebrand may be the first step of a messaging update that is still in progress."],
      },
    }),
  });
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  assert.strictEqual(summary.pendingApproval, 1, "the combined assessment warrants presenting the candidate to Martin");
  assert.strictEqual(created.leads, 0, "and still no Lead: Martin's explicit approval remains the only path to one");

  const opportunity = (env as any).__sessions.proposeLeadOpportunity[0][0];
  const text = String(opportunity.review.text ?? "");
  assert.strictEqual(opportunity.review.status, "validated", "the hypothesis comes from a validated review");

  // Every layer stays visible and linked: both neutral observations, the
  // finding they jointly support, the hypothesis pointing at that finding,
  // the explicit UNCONFIRMED label, and the retained alternative explanation.
  assert.ok(text.includes("still describes only its original offering on its public site. [S1]"), `observation 1 with its source: ${text}`);
  assert.ok(text.includes("wider range of products than that site copy does. [S2]"), `observation 2 with its source: ${text}`);
  assert.ok(text.includes("Two retrieved sources describe Acme Corp in two different ways. [F1, F2]"), `the finding names both supporting facts: ${text}`);
  assert.ok(text.includes("*Opportunity hypothesis*"), `the hypothesis is on the card: ${text}`);
  assert.ok(text.includes("UNCONFIRMED"), "the hypothesis is labelled unconfirmed -- never an established fact");
  assert.ok(text.includes("[supported by D1"), `the hypothesis states which findings support it: ${text}`);
  assert.ok(text.includes("worth investigating in a consultancy conversation"), "it is framed as worth investigating, not as a demonstrated problem");
  assert.ok(text.includes("*Alternative explanations*"), "the alternative explanations section is retained");
  assert.ok(text.includes("still in progress"), `the material alternative explanation itself: ${text}`);
});

test("false-positive resistance: a problem keyword in the screening observation is NOT enough -- without grounded company-specific support the candidate is held, never carded", async (t) => {
  const KEYWORD_EVALUATION = JSON.stringify({
    candidates: [
      {
        pass: true,
        organisation: "Acme Corp",
        evidence: "Acme Corp has a positioning problem: its messaging is inconsistent across its marketing channels.",
        decisionMakerOrRole: "",
        category: "positioning",
        reason: "Inconsistent messaging signals a positioning problem.",
      },
    ],
  });
  assert.strictEqual(
    evidenceStatesProblemOrOpportunity("Acme Corp has a positioning problem: its messaging is inconsistent across its marketing channels."),
    true,
    "the observation DOES carry a signal word -- and that must not be what decides the outcome",
  );

  // The retrieved material the review actually weighs is only a passing
  // mention in category commentary, so the review honestly finds no
  // company-specific opportunity hypothesis.
  const { created, searchQueries } = installDiscoveryRun(t, KEYWORD_EVALUATION, { review: insufficientReviewDraft });
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  assert.strictEqual(summary.pendingApproval, 0, "a keyword match with no grounded supporting context must never reach an approval card");
  assert.ok((summary.evidenceSynthesisAttempts ?? 0) > 0, "the keyword did identify material for review -- the review is what refused it");
  assert.ok(
    searchQueries.some((q) => !q.domainScoped && q.query === '"Acme Corp"'),
    "the candidate-specific search was still performed, so the refusal is an assessment of retrieved evidence, not a missing search",
  );
  assert.strictEqual(summary.skippedAsInsufficient + summary.heldOverCap, summary.evaluated, "every evaluated candidate still lands in exactly one bucket");
  assert.strictEqual((env as any).__sessions.init.length, 0, "no Work is created for a held candidate");
  assert.strictEqual(created.leads, 0, "and no Lead");
  assert.strictEqual(created.handoffs, 0, "and no Handoff");
});

test("LGS: a grounded observation that names the organisation IS presented -- carrying the organisation-named evidence, the retrieval date, and a labelled UNCONFIRMED opportunity hypothesis", async (t) => {
  const { searchQueries } = installDiscoveryRun(t, PASS_EVALUATION);
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  assert.strictEqual(summary.pendingApproval, 1, "a properly grounded candidate is still presented");
  const opportunity = (env as any).__sessions.proposeLeadOpportunity[0][0];
  assert.ok(opportunity.evidence.includes("Acme Corp"), `the card's observation names the organisation: ${opportunity.evidence}`);
  assert.strictEqual(typeof opportunity.sourceRetrievedAt, "string", "the retrieval date travels to the card");
  assert.ok(!Number.isNaN(Date.parse(opportunity.sourceRetrievedAt)), `the retrieval date is a real timestamp: ${opportunity.sourceRetrievedAt}`);

  // Candidate-level synthesis, on the card: a validated review whose
  // hypothesis is traceable to findings and facts, explicitly marked as NOT
  // established, with the material alternative explanation retained. The
  // supporting fact carries no problem-signal keyword, so what established
  // the hypothesis is the combined assessment -- not a wordlist match.
  assert.strictEqual(opportunity.review.status, "validated", "the card carries a validated candidate-level review");
  const reviewText = String(opportunity.review.text ?? "");
  assert.ok(reviewText.includes("*Opportunity hypothesis*"), `the card states the opportunity hypothesis: ${reviewText}`);
  assert.ok(reviewText.includes("UNCONFIRMED"), "the hypothesis is labelled unconfirmed, never an established fact");
  assert.ok(reviewText.includes("[supported by D1"), `the hypothesis names the findings that support it: ${reviewText}`);
  assert.ok(reviewText.includes("*Alternative explanations*"), "the material alternative explanation is retained on the card");
  assert.ok(reviewText.includes("staged rollout"), `the alternative explanation itself is shown: ${reviewText}`);

  // Bounded candidate-level retrieval: exactly one unscoped candidate-specific
  // search (the organisation's own name, distinct from the domain-scoped
  // social query of the same wording) plus the bounded social step.
  const candidateSearches = searchQueries.filter((q) => !q.domainScoped && q.query === '"Acme Corp"');
  assert.strictEqual(candidateSearches.length, 1, `exactly one candidate-specific search per attempt: ${JSON.stringify(searchQueries)}`);
  const socialSearches = searchQueries.filter((q) => q.domainScoped || q.query.endsWith("official social media"));
  assert.strictEqual(socialSearches.length, MAX_SOCIAL_SIGNAL_SEARCHES, "the social step stays at its own bound");
});

test("runAutonomousLeadDiscovery records nothing when governance retrieval fails -- fails closed, not open", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [{ title: "Some Company", url: "https://example.com/post", content: "Some content." }] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response("server error", { status: 500 });
    }
    if (url.includes("/pages") && method === "POST") {
      leadsCreatedCount++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.strictEqual(leadsCreatedCount, 0);
  assert.strictEqual(summary.pendingApproval, 0);
});

test("notifyDiscoveryRunSummary sends a single Hat-labeled digest, never one message per Lead", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    sentTexts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({ TELEGRAM_GROUP_CHAT_ID: "-1004435157576" });
  const success = await notifyDiscoveryRunSummary(env, 1, undefined, {
    evaluated: 12,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 1,
    screenedOut: 9,
    skippedAsDuplicate: 1,
    skippedAsInsufficient: 1,
    searchUnavailable: 0,
    searchFailed: 0,
  });

  assert.strictEqual(success, true, "notifyDiscoveryRunSummary should return true when message succeeds");
  assert.strictEqual(sentTexts.length, 1, "exactly one digest message per run, never one per Lead");
  assert.ok(sentTexts[0].startsWith("Hat: Lead Generation Specialist."));
  assert.ok(sentTexts[0].includes("12 candidate(s) evaluated"));
  assert.ok(sentTexts[0].includes("1 sent to the Workspace topic for your approval"));
  assert.ok(sentTexts[0].includes("No Lead is created until you approve"));
});

test("notifyDiscoveryRunSummary catches Telegram errors gracefully without throwing", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Telegram API connection timeout");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const success = await notifyDiscoveryRunSummary(fakeEnv(), 12345, undefined, {
    evaluated: 5,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 4,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  });

  assert.strictEqual(success, false, "notifyDiscoveryRunSummary should return false when Telegram fetch throws");
});

test("notifyDiscoveryRunSummary handles invalid or missing chatId cleanly without throwing", async (t) => {
  // This test used to reach the real Telegram API. `notifyDiscoveryRunSummary`
  // resolves the Operations target from the Env rather than from the chatId
  // argument, so an invalid chatId does NOT short-circuit the send -- it
  // proceeds and Telegram rejects it. That made this test's result depend on
  // ambient network behaviour, which is how it came to hang indefinitely
  // wherever an outbound connection blackholes instead of failing fast. A
  // test must never reach the network; Telegram's own rejection is simulated
  // here, which is also the more faithful thing to assert.
  const originalFetch = globalThis.fetch;
  const sentChatIds: unknown[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    // Only Telegram sends are counted: a failed notification also writes an
    // Activity & Decision Log entry, and conflating the two would make this
    // assert on bookkeeping rather than on the send.
    if (!String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ id: "activity-log-entry", properties: {} }), { status: 200 });
    }
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { chat_id?: unknown }) : {};
    sentChatIds.push(body.chat_id);
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const success1 = await notifyDiscoveryRunSummary(fakeEnv(), NaN, undefined, {
    evaluated: 1,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 1,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  });
  assert.strictEqual(success1, false, "a rejected notification reports failure rather than throwing");

  const success2 = await notifyDiscoveryRunSummary(fakeEnv(), 0, undefined, {
    evaluated: 1,
    heldOverCap: 0,
    skippedAlreadyPresented: 0,
    presentationFailed: 0,
    duplicateCheckFailed: 0,
    pendingApproval: 0,
    screenedOut: 1,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
    searchUnavailable: 0,
    searchFailed: 0,
  });
  assert.strictEqual(success2, false);

  // Both calls must actually attempt a notification rather than silently
  // skipping one -- a silent skip would also report `false`, so the count is
  // what distinguishes "handled an invalid chatId" from "never tried".
  assert.ok(sentChatIds.length >= 2, `both calls must reach Telegram and be refused, not silently skipped (saw ${sentChatIds.length})`);
});

test("Requirement 1 & 2: Successful discovery with failed notification still returns successful processing summary and records notification failure", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes("api.telegram.org")) {
      throw new Error("Telegram HTTP request timed out");
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({ MARTIN_TELEGRAM_USER_ID: "9999" });
  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills()); // returns summary with 0 evaluated when unconfigured

  let notificationSent = false;
  let notificationError: string | null = null;
  try {
    const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
    notificationSent = await notifyDiscoveryRunSummary(env, chatId, undefined, summary);
    if (!notificationSent) {
      notificationError = "Telegram notification returned unconfirmed or failed status";
    }
  } catch (err: any) {
    notificationError = err?.message || String(err);
  }

  assert.strictEqual(summary.evaluated, 0, "discovery summary is produced successfully");
  assert.strictEqual(notificationSent, false, "notificationSent is false when Telegram fails");
  assert.strictEqual(notificationError, "Telegram notification returned unconfirmed or failed status");
});

test("Requirement 1: Successful discovery with successful notification records notificationSent: true", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = fakeEnv({ MARTIN_TELEGRAM_USER_ID: "9999" });
  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  let notificationSent = false;
  let notificationError: string | null = null;
  try {
    const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
    notificationSent = await notifyDiscoveryRunSummary(env, chatId, undefined, summary);
    if (!notificationSent) {
      notificationError = "Telegram notification returned unconfirmed or failed status";
    }
  } catch (err: any) {
    notificationError = err?.message || String(err);
  }

  assert.strictEqual(notificationSent, true);
  assert.strictEqual(notificationError, null);
});

// ============================================================
// Human approval gate: proposeLeadOpportunity / handleLeadOpportunityApproval
// ============================================================

function fakeOpportunityState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-opp-1",
    chatId: 12345,
    unit: "Sales",
    hat: "Lead Generation Specialist",
    stage: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const SAMPLE_OPPORTUNITY = {
  organisation: "Zenith Co",
  evidence: "Expanded into a new market but public positioning still emphasises its original offering.",
  reason: "Matches the Acquisition Criteria's positioning-gap signal.",
  category: "positioning",
  sourceUrl: "https://example.com/zenith",
  handoffId: "h-1",
};

test("proposeLeadOpportunity sets pendingLeadOpportunity and presents evidence-backed findings -- never creates a Lead", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  let sentButtons: any[] = [];
  let leadCreated = false;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      sentText = body.text;
      sentButtons = body.reply_markup?.inline_keyboard ?? [];
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") leadCreated = true;
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState();
  const updated = await proposeLeadOpportunity(fakeEnv(), state, SAMPLE_OPPORTUNITY);

  assert.deepStrictEqual(updated.sales?.pendingLeadOpportunity, SAMPLE_OPPORTUNITY);
  assert.ok(sentText.includes("Zenith Co"));
  assert.ok(sentText.includes(SAMPLE_OPPORTUNITY.evidence));
  assert.ok(sentText.includes("No Lead has been created"));
  assert.strictEqual(updated.stage, "awaiting_lead_approval");
  assert.strictEqual(sentButtons[0][0].callback_data, "leadopportunity:work-opp-1:approve");
  assert.strictEqual(sentButtons[0][1].callback_data, "leadopportunity:work-opp-1:reject");
  assert.strictEqual(leadCreated, false, "presenting an opportunity must never itself create a Lead");

  // Generic approval-recovery descriptor: /sessions can label and resurface
  // this exact message/buttons if the original Telegram message is missed.
  assert.ok(updated.pendingActionSummary, "proposeLeadOpportunity must also set the generic pendingActionSummary");
  assert.strictEqual(updated.pendingActionSummary?.label, "Opportunity: Zenith Co");
  assert.ok(sentText.endsWith(updated.pendingActionSummary!.message), "the stored summary message must be exactly what was sent (minus the Hat label prefix)");
  assert.deepStrictEqual(updated.pendingActionSummary?.buttons, sentButtons);
});

test("proposeLeadOpportunity: the card labels evidence as a search-result snippet, the reason as a hypothesis, and dates the retrieval", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      sentTexts.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      return new Response(
        JSON.stringify({ id: url.split("/v1/pages/").pop()!.split("?")[0], url, parent: { type: "page", page_id: "governance-root" }, properties: {} }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // With a retrieval date recorded.
  await proposeLeadOpportunity(fakeEnv(), fakeOpportunityState(), {
    ...SAMPLE_OPPORTUNITY,
    sourceRetrievedAt: "2026-10-19T08:00:00.000Z",
  });
  const dated = sentTexts[0];
  assert.ok(dated.includes("Observed (search-result snippet -- the source page itself was not opened):"), `the observation must be labelled a snippet, not a page reading: ${dated}`);
  assert.ok(dated.includes("Hypothesis -- why this may be worth pursuing, NOT established:"), `the reason must be labelled a hypothesis: ${dated}`);
  assert.ok(dated.includes("Source: https://example.com/zenith (search-result snippet; retrieved 2026-10-19T08:00:00.000Z)"), `the source carries its retrieval date: ${dated}`);

  // Without a retrieval date: the card says so rather than inventing one.
  await proposeLeadOpportunity(fakeEnv(), fakeOpportunityState(), SAMPLE_OPPORTUNITY);
  assert.ok(sentTexts[1].includes("Source: https://example.com/zenith (search-result snippet; retrieval time not recorded)"), `an unrecorded retrieval time is stated, never guessed: ${sentTexts[1]}`);
});

test("proposeLeadOpportunity: a BLOCKED evidence review is marked NOT PRODUCED on the card -- never readable as a validated review", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      return new Response(
        JSON.stringify({ id: url.split("/v1/pages/").pop()!.split("?")[0], url, parent: { type: "page", page_id: "governance-root" }, properties: {} }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const blockedText = renderBlockedCandidateReview("Zenith Co", "the review cites source(s) that do not appear in any material this run retrieved: S9");
  await proposeLeadOpportunity(fakeEnv(), fakeOpportunityState(), {
    ...SAMPLE_OPPORTUNITY,
    sourceRetrievedAt: "2026-10-19T08:00:00.000Z",
    review: { status: "blocked", text: blockedText },
  });

  assert.ok(sentText.includes("Evidence review: NOT PRODUCED -- see below; this candidate has NOT passed an evidence review"), `a blocked review must be marked on the card: ${sentText}`);
  assert.ok(!sentText.includes("Evidence review: validated"), "a blocked review must never be labelled validated");
  assert.ok(sentText.includes("S9"), "the blocked reason is shown");
  assert.ok(sentText.includes("NOT PRODUCED"), "the review body itself says NOT PRODUCED");
  // The screening observation survives a blocked review, still labelled a snippet.
  assert.ok(sentText.includes("Observed (search-result snippet -- the source page itself was not opened):"), "the observation is still on the card, still labelled a snippet");

  // And a VALIDATED review is labelled for exactly what it is: validated against retrieved material only.
  await proposeLeadOpportunity(fakeEnv(), fakeOpportunityState(), {
    ...SAMPLE_OPPORTUNITY,
    review: { status: "validated", text: "*Candidate review* — Zenith Co\nStatus: validated against the retrieved material only." },
  });
  assert.ok(sentText.includes("Evidence review: validated against the retrieved material only"), `a validated review says so, bounded to the retrieved material: ${sentText}`);
});

test("handleLeadOpportunityApproval clears pendingActionSummary alongside pendingLeadOpportunity, and a stale second tap is a safe no-op", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadCreateCount = 0;
  let lastSentText = "";

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      lastSentText = body.text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") leadCreateCount++;
      return new Response(JSON.stringify({ id: "lead-page", url: "https://notion.so/lead-page" }), { status: 200 });
    }
    if (String(url).includes("/data_sources") && String(url).includes("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ actionName: "record_lead" });
  const proposed = await proposeLeadOpportunity(fakeEnv(), state, SAMPLE_OPPORTUNITY);
  assert.ok(proposed.pendingActionSummary);

  const resolved = await handleLeadOpportunityApproval(fakeEnv(), proposed, true);
  assert.strictEqual(resolved.pendingActionSummary, undefined, "resolving the approval must clear pendingActionSummary");
  assert.strictEqual(leadCreateCount, 1, "Martin's approval of this candidate creates exactly one Lead");

  // Simulate a resurfaced (stale) tap on the same, already-resolved item --
  // e.g. Martin taps an old /sessions-resurfaced button after already
  // approving via the original message. Must not create a second Lead.
  const staleTapResult = await handleLeadOpportunityApproval(fakeEnv(), resolved, true);
  assert.strictEqual(leadCreateCount, 1, "a stale approval tap must not execute the action a second time");
  assert.ok(lastSentText.includes("No valid pending opportunity"), "a stale tap must reply that there's nothing pending");
  assert.strictEqual(staleTapResult.pendingActionSummary, undefined);
});

test("handleLeadOpportunityApproval creates a Lead only on explicit approval", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadProps: any = null;
  let sentText = "";

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("leads-ds") && method === "POST" && String(url).endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") {
        leadProps = body.properties;
        return new Response(JSON.stringify({ id: "lead-page-1", url: "https://notion.so/lead-page-1", properties: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ actionName: "record_lead", sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(updated.sales?.pendingLeadOpportunity, undefined, "pending state must be cleared once decided");
  // Martin's decision (2026-10-12): his approval of THIS candidate, on a Work
  // recording record_lead, authorizes exactly this Lead create (Access checks
  // the proof bound to Work + record_lead + the Leads data source).
  assert.ok(leadProps, "the approved candidate is recorded as a Lead");
  assert.strictEqual(leadProps.Lead.title[0].text.content, "Zenith Co");
  assert.strictEqual(leadProps.Status.select.name, "New");
  assert.ok(sentText.includes("Lead recorded"));
  assert.strictEqual(updated.stage, "complete", "a decided candidate's Work is closed");
});

test("handleLeadOpportunityApproval creates no Lead on rejection", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadCreated = false;
  let sentText = "";

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") leadCreated = true;
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, false);

  assert.strictEqual(updated.sales?.pendingLeadOpportunity, undefined);
  assert.strictEqual(leadCreated, false, "rejection must never create a Lead");
  assert.ok(sentText.includes("rejected"));
  assert.ok(sentText.includes("No Lead was created"));
});

test("handleLeadOpportunityApproval fails closed when no pending opportunity exists", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = (async (url: string, init: any) => {
    if (String(url).includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ sales: { pendingLeadOpportunity: undefined } });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(updated.sales?.pendingLeadOpportunity, undefined);
  assert.ok(sentText.includes("No valid pending opportunity finding"));
});

test("handleLeadOpportunityApproval refuses to create a duplicate Lead even after explicit approval", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadCreated = false;
  let sentText = "";

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("leads-ds") && method === "POST" && String(url).endsWith("/query")) {
      return new Response(JSON.stringify({ results: [{ id: "existing-lead", properties: { Lead: { title: [{ plain_text: "Zenith Co" }] } } }] }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") leadCreated = true;
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });
  await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(leadCreated, false, "must never create a duplicate Lead, even on explicit approval");
  assert.ok(sentText.includes("Not created"));
});

// ============================================================
// On-demand discovery capability
// ============================================================

test("LeadOpportunityDiscoveryCapability ignores messages that aren't discovery requests", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const body = String(init?.body ?? "");
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (body.includes("on-demand discovery capability")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isDiscoveryRequest: false }) } }] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(fakeEnv({ GROQ_API_KEY: "key" }), 12345, "How's it going?", undefined, await lgsSkills());
  assert.strictEqual(handled, false);
});

test("LeadOpportunityDiscoveryCapability generates a search strategy and holds promising signals -- no Handoff, never a Lead directly", async (t) => {
  const originalFetch = globalThis.fetch;
  let ackText = "";
  let handoffsCreatedCount = 0;
  let leadsCreatedCount = 0;
  const outboundQueries: Array<{ query: string; domainScoped: boolean }> = [];

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const urlStr = String(url);

    if (urlStr.includes("api.telegram.org")) {
      const parsed = JSON.parse(init.body);
      if (!ackText) ackText = parsed.text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (urlStr.includes("api.tavily.com")) {
      const request = JSON.parse(init.body);
      outboundQueries.push({ query: request.query, domainScoped: Array.isArray(request.include_domains) });
      return new Response(JSON.stringify({ results: [{ title: "Acme Corp positioning shift", url: "https://example.com/nova", content: "Acme Corp expansion news." }] }), { status: 200 });
    }
    if (urlStr.includes("leads-ds") && method === "POST" && urlStr.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("handoffs-ds") && method === "POST" && urlStr.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.includes("/pages") && method === "POST") {
      const parsed = JSON.parse(init.body);
      if (parsed.parent?.data_source_id === "handoffs-ds") handoffsCreatedCount++;
      if (parsed.parent?.data_source_id === "leads-ds") leadsCreatedCount++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    if (body.includes("on-demand discovery capability")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isDiscoveryRequest: true, count: 2, focus: "positioning problem" }) } }] }), { status: 200 });
    }
    if (body.includes("distinct web search queries")) {
      // Deliberately identity-bearing: the outbound search edge must redact
      // these before they leave the runtime (LOG-1068 identity_redaction).
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries: ["positioning problem like ENIG has", "struggling brands Martin would notice"] }) } }] }), { status: 200 });
    }
    if (body.includes("evidence-threshold hard gate")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: PASS_EVALUATION } }] }), { status: 200 });
    }
    if (body.includes("Build ONE evidence-backed review")) {
      // The bounded candidate-level review call for the presented candidate:
      // route it to a real (mocked) review rather than letting it throw, so
      // the presentation path under test is the governed one.
      const organisation = body.match(/Candidate under review: ([^"\\]+?)(?:\\n|")/)?.[1]?.trim() || "the organisation";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(supportedReviewDraft(organisation)) } }] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(
    fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }),
    12345,
    "Find me 2 companies showing a positioning problem",
    undefined,
    await lgsSkills(),
  );

  assert.strictEqual(handled, true);
  assert.ok(ackText.includes("Searching for organisations"));
  assert.ok(ackText.includes("positioning problem"));
  assert.ok(!ackText.includes("Research & Intelligence"), "the acknowledgement must not promise routing to a retired Unit");
  assert.strictEqual(handoffsCreatedCount, 0, "promising signals are held; no Handoff is produced");
  assert.strictEqual(leadsCreatedCount, 0, "on-demand discovery must never create a Lead directly");
  // Both generated discovery queries must have been searched, in order --
  // interleaved with (never replaced by) the bounded retrieval a presented
  // candidate's own synthesis performs: ONE candidate-specific public search
  // plus the bounded social step. Nothing else may leave the runtime.
  const generated = outboundQueries.filter((q) => q.query.includes("the business") || q.query.includes("the operator"));
  assert.deepStrictEqual(
    generated.map((q) => q.query),
    ["positioning problem like the business has", "struggling brands the operator would notice"],
    "both generated queries are searched in order, with the canonical redaction replacement applied",
  );
  const socialSearches = outboundQueries.filter((q) => q.domainScoped || q.query.endsWith("official social media"));
  const candidateSearches = outboundQueries.filter((q) => !q.domainScoped && q.query === '"Acme Corp"');
  assert.strictEqual(
    socialSearches.length,
    MAX_SOCIAL_SIGNAL_SEARCHES,
    `the bounded social-signal step runs in full alongside the generated queries (got ${socialSearches.length}, bound ${MAX_SOCIAL_SIGNAL_SEARCHES})`,
  );
  assert.strictEqual(candidateSearches.length, 1, "the presented candidate's ONE bounded candidate-specific search ran");
  assert.ok(
    candidateSearches.length <= MAX_EVIDENCE_SYNTHESIS_PER_RUN,
    `candidate-specific searches stay inside the synthesis budget (got ${candidateSearches.length}, bound ${MAX_EVIDENCE_SYNTHESIS_PER_RUN})`,
  );
  assert.strictEqual(
    candidateSearches.length + socialSearches.length + generated.length,
    outboundQueries.length,
    `nothing but generated, candidate-specific and social searches leaves the runtime: ${JSON.stringify(outboundQueries)}`,
  );
  assert.ok(candidateSearches.every((q) => q.query.includes("Acme Corp")), "the candidate-specific search names the candidate");
  for (const { query } of outboundQueries) {
    assert.ok(!/\bENIG\b/i.test(query), `identity must not leave the runtime in a search query: ${query}`);
    assert.ok(!/\bMartin\b/i.test(query), `identity must not leave the runtime in a search query: ${query}`);
  }
});

test("LeadOpportunityDiscoveryCapability fails closed when search strategy generation is unavailable, without silently falling through", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = (async (url: string, init: any) => {
    const body = String(init?.body ?? "");
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (urlStr.includes("/blocks/")) {
      return new Response("server error", { status: 500 }); // governance retrieval fails
    }
    if (urlStr.includes("/pages") && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    if (body.includes("on-demand discovery capability")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isDiscoveryRequest: true, count: 3, focus: "positioning problem" }) } }] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(
    fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }),
    12345,
    "Find me 3 companies with a positioning problem",
    undefined,
    await lgsSkills(),
  );

  assert.strictEqual(handled, true, "must not silently fall through once intent is recognized -- an explicit failure message is required");
  assert.ok(sentText.toLowerCase().includes("couldn't generate a search strategy"));
});

test("LeadOpportunityDiscoveryCapability fails closed when web search isn't configured", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentText = "";
  globalThis.fetch = (async (url: string, init: any) => {
    const body = String(init?.body ?? "");
    if (String(url).includes("api.telegram.org")) {
      sentText = JSON.parse(init.body).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (body.includes("on-demand discovery capability")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isDiscoveryRequest: true, count: 3 }) } }] }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
      // A standalone governance page (Hat Definition, Universal
      // Role Contract): its parent is a page, not a data source,
      // which is precisely how it resolves to "no governed target".
      return new Response(
        JSON.stringify({
          id: url.split("/v1/pages/").pop()!.split("?")[0],
          url: url,
          parent: { type: "page", page_id: "governance-root" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(fakeEnv({ GROQ_API_KEY: "key" }), 12345, "Find me some companies", undefined, await lgsSkills());

  assert.strictEqual(handled, true);
  assert.ok(sentText.includes("no web search provider is configured"));
});

// ===========================================================================
// Martin's decision (2026-10-12): screened candidates come to him as Telegram
// approval cards (at most MAX_APPROVAL_CARDS_PER_RUN per run); a Lead exists
// only after he approves that specific candidate; rejected ones are not
// proposed again.
// ===========================================================================

/** A discovery run where every query surfaces three NEW organisations, so the per-run card cap is what limits presentation. */
function installDistinctCandidateRun(t: any) {
  const originalFetch = globalThis.fetch;
  let searchBatch = 0;
  let leadsCreated = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      // Every search call -- screening, the bounded candidate-specific search,
      // or the bounded public social-signal searches that follow a presented
      // candidate -- gets its own batch of freshly-named organisations, so no
      // two candidates ever share a memory key. The organisation name IS the
      // result title, which is what lets the deterministic nomination check
      // (the retrieved result must name the organisation) pass for every one
      // of them.
      const batch = searchBatch++;
      return new Response(
        JSON.stringify({
          results: [0, 1, 2].map((i) => ({
            title: `Org ${batch}-${i}`,
            url: `https://example.com/org-${batch}-${i}`,
            content: `Org ${batch}-${i} expanded into a new market.`,
          })),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      if (JSON.parse(init.body).parent?.data_source_id === "leads-ds") leadsCreated++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    const aiBody = String(init?.body ?? "");
    if (aiBody.includes("Build ONE evidence-backed review")) {
      // The bounded candidate-level review call for one presented candidate:
      // a real (mocked) review draft built for the organisation under review,
      // so presentation is the governed path -- nomination must be followed by
      // a successful candidate-level synthesis to yield a card.
      const organisation = aiBody.match(/Candidate under review: ([^"\\]+?)(?:\\n|")/)?.[1]?.trim() || "the organisation";
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(supportedReviewDraft(organisation)) } }] }),
        { status: 200 },
      );
    }
    // The screening AI call is the one whose prompt lists the retrieved
    // results as `[i] Title: ...`; the mock echoes those exact titles back as
    // the organisations, so each candidate is grounded in ITS OWN result
    // (the nomination check requires the retrieved result to name the
    // organisation). Every other AI call gets no candidates back and can
    // never manufacture one.
    const titles = [...aiBody.matchAll(/\[\d+\] Title: ([^\\"]+)/g)].map((m) => m[1].trim());
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidates: titles.map((organisation) => ({
                  pass: true,
                  organisation,
                  evidence: `${organisation} expanded into a new market but its public positioning still emphasises its original offering.`,
                  decisionMakerOrRole: "",
                  category: "positioning",
                  reason: "Expansion without a positioning update.",
                })),
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { leadsCreated: () => leadsCreated };
}

test("LGS approval cards: a run sends at most MAX_APPROVAL_CARDS_PER_RUN cards; the rest are held without being remembered", async (t) => {
  const run = installDistinctCandidateRun(t);
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());
  const sessions = (env as any).__sessions;
  const kv: Map<string, string> = (env as any).__kv;

  assert.strictEqual(summary.pendingApproval, MAX_APPROVAL_CARDS_PER_RUN, "exactly the cap is presented");
  assert.strictEqual(sessions.proposeLeadOpportunity.length, MAX_APPROVAL_CARDS_PER_RUN);
  assert.ok(summary.heldOverCap > 0, "candidates beyond the cap are counted as held");
  assert.strictEqual(summary.pendingApproval + summary.heldOverCap, summary.evaluated);
  assert.strictEqual(run.leadsCreated(), 0, "no run ever creates a Lead");
  // Only presented candidates are remembered; held ones stay eligible for a later run.
  const remembered = [...kv.keys()].filter((k) => k.startsWith("lead_candidate:"));
  assert.strictEqual(remembered.length, MAX_APPROVAL_CARDS_PER_RUN);
  for (const key of remembered) assert.strictEqual(JSON.parse(kv.get(key)!).status, "pending");
});

test("LGS approval cards: an organisation Martin rejected (or already has a card for) is never proposed again", async (t) => {
  installDiscoveryRun(t, PASS_EVALUATION);
  const env = fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" });
  (env as any).__kv.set(leadCandidateMemoryKey("Acme Corp"), JSON.stringify({ status: "rejected" }));

  const summary = await runAutonomousLeadDiscovery(env, await lgsSkills());

  assert.strictEqual(summary.pendingApproval, 0, "a remembered organisation gets no card");
  assert.strictEqual(summary.skippedAlreadyPresented, summary.evaluated);
  assert.strictEqual((env as any).__sessions.init.length, 0, "and no Work is created for it");
});

test("LGS approval cards: leadCandidateMemoryKey treats trivial spelling variants of one organisation as the same", () => {
  assert.strictEqual(leadCandidateMemoryKey("Acme Corp."), leadCandidateMemoryKey("  ACME   corp "));
  assert.notStrictEqual(leadCandidateMemoryKey("Acme Corp"), leadCandidateMemoryKey("Acme Group"));
  assert.notStrictEqual(leadCandidateMemoryKey("株式会社サクラ"), leadCandidateMemoryKey("株式会社モミジ"), "non-Latin names never share one key");
});

/** Telegram + Notion mock for handleLeadOpportunityApproval; `leadsWrite` scripts the Leads create response. */
function installApprovalMock(t: any, leadsWrite: "ok" | "fail" = "ok") {
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  let leadCreates = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("api.telegram.org")) {
      sent.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("leads-ds") && method === "POST" && String(url).endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") {
        leadCreates++;
        if (leadsWrite === "fail") return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
        return new Response(JSON.stringify({ id: "lead-1", url: "https://notion.so/lead-1", properties: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { sent, leadCreates: () => leadCreates };
}

test("handleLeadOpportunityApproval: rejecting remembers the organisation for 180 days and closes the Work", async (t) => {
  installApprovalMock(t);
  const env = fakeEnv();
  const state = fakeOpportunityState({ actionName: "record_lead", sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });

  const updated = await handleLeadOpportunityApproval(env, state, false);

  const memory = (env as any).__kv.get(leadCandidateMemoryKey(SAMPLE_OPPORTUNITY.organisation));
  assert.ok(memory, "the rejection is remembered");
  assert.strictEqual(JSON.parse(memory).status, "rejected");
  assert.strictEqual(updated.stage, "cancelled");
});

test("handleLeadOpportunityApproval: a card whose Work does not record record_lead can never create a Lead (fails closed, nothing written)", async (t) => {
  const mock = installApprovalMock(t);
  // A legacy card from before record_lead existed: its Work records no Action
  // (or a read one), so Martin's approval cannot be bound to an approval-gated
  // write and Access refuses the create.
  for (const actionName of [undefined, "discover_leads"]) {
    const state = fakeOpportunityState({ ...(actionName ? { actionName } : {}), sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });
    const updated = await handleLeadOpportunityApproval(fakeEnv(), state, true);
    assert.ok(!mock.sent.some((m) => m.includes("Lead recorded")), `no success may be reported (actionName=${actionName})`);
    assert.deepStrictEqual(updated.sales?.pendingLeadOpportunity, SAMPLE_OPPORTUNITY, "the candidate stays staged rather than being silently dropped");
  }
  assert.strictEqual(mock.leadCreates(), 0, "the Leads database is never written");
});

test("handleLeadOpportunityApproval: a failed Leads write re-stages the candidate so the SAME card's Approve works again", async (t) => {
  const mock = installApprovalMock(t, "fail");
  const state = fakeOpportunityState({ actionName: "record_lead", sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });

  const afterFailure = await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(mock.leadCreates(), 1, "the write was attempted once");
  assert.deepStrictEqual(afterFailure.sales?.pendingLeadOpportunity, SAMPLE_OPPORTUNITY, "the candidate is staged again for a retry");
  assert.notStrictEqual(afterFailure.stage, "complete", "a failed write does not close the Work");
  assert.ok(mock.sent.some((m) => m.includes("Tap Approve on the card again")));
});

// ---------------------------------------------------------------------------
// Outbound email remains a separate, unapproved slice -- pinned here so the
// lead-generation path can never grow a send capability unnoticed.
// ---------------------------------------------------------------------------

test("Slice A introduces no outbound email send path: the approval flow reaches only Notion and Telegram, and no email-send Tool operation is registered", async (t) => {
  const originalFetch = globalThis.fetch;
  const hosts = new Set<string>();
  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    hosts.add(new URL(String(url)).host);
    if (String(url).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (String(url).includes("leads-ds") && method === "POST" && String(url).endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (String(url).includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") {
        return new Response(JSON.stringify({ id: "lead-1", url: "https://notion.so/lead-1", properties: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "log-page" }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ actionName: "record_lead", sales: { pendingLeadOpportunity: SAMPLE_OPPORTUNITY } });
  await handleLeadOpportunityApproval(fakeEnv(), state, true);

  // Every host this governed path contacted. An email provider appearing here
  // would mean discovery had grown a send path -- outbound email is a
  // separate slice requiring its own approval.
  assert.deepStrictEqual(
    [...hosts].sort(),
    ["api.notion.com", "api.telegram.org"],
    "the approval path may reach only the Leads database and Telegram -- no email provider",
  );

  // The Tool Registry is the only sanctioned way a capability becomes
  // executable, and its table is static and code-owned. No email-send
  // operation may resolve -- while a real registered operation does, so this
  // probe cannot pass vacuously.
  assert.ok(
    resolveToolOperation(GOOGLE_DOCS_TOOL_ID, GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID),
    "the probe is not vacuous: a genuinely registered operation still resolves",
  );
  for (const [toolId, operationId] of [
    ["email", "email.send"],
    ["gmail", "gmail.send_message"],
    ["sendgrid", "sendgrid.send_email"],
    ["smtp", "smtp.send"],
  ] as const) {
    assert.strictEqual(
      resolveToolOperation(toolId, operationId),
      null,
      `no ${toolId}.${operationId} operation may be registered -- outbound email is not approved`,
    );
  }
});
