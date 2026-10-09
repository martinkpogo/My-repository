import test from "node:test";
import assert from "node:assert";
import {
  DISCOVERY_QUERIES,
  LeadOpportunityDiscoveryCapability,
  handleLeadOpportunityApproval,
  notifyDiscoveryRunSummary,
  proposeLeadOpportunity,
  runAutonomousLeadDiscovery,
} from "./leadGenerationDiscovery";
import type { Env, WorkState } from "../../types";
import { salesManifest } from "./salesManifest";
import { resolveRecordedActionSkills } from "../../runtime/actionSkills";

/** The Skills `discover_leads` declares, resolved through the Skill Registry -- the same path execution uses. */
const lgsSkills = () => resolveRecordedActionSkills(salesManifest.hats["Lead Generation Specialist"], "discover_leads");

function createMockWorkSession() {
  const calls: { init: any[][]; proposeLeadOpportunity: any[][] } = { init: [], proposeLeadOpportunity: [] };
  const stub = {
    init: async (...args: any[]) => {
      calls.init.push(args);
    },
    proposeLeadOpportunity: async (...args: any[]) => {
      calls.proposeLeadOpportunity.push(args);
    },
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
  const { workSession } = createMockWorkSession();
  return {
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
      get: async () => null,
      put: async () => {},
    } as any,
    ...overrides,
  } as Env;
}

const PASS_EVALUATION = JSON.stringify({
  candidates: [
    {
      pass: true,
      organisation: "Acme Corp",
      evidence: "Expanded into a new market but public positioning still emphasises its original offering.",
      decisionMakerOrRole: "",
      category: "positioning",
      reason: "Recent expansion without corresponding positioning update.",
    },
  ],
});

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
    heldNoResearchPath: 0,
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
    heldNoResearchPath: 0,
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
    heldNoResearchPath: 1,
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

test("Test A: Candidate signal passes lightweight screening -> held; no Handoff and no Lead is created", async (t) => {
  const originalFetch = globalThis.fetch;
  let handoffsCreatedCount = 0;
  let leadsCreatedCount = 0;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
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
    return new Response(JSON.stringify({ choices: [{ message: { content: PASS_EVALUATION } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  // The step that used to follow screening (a Handoff to the retired
  // Research & Intelligence Unit) no longer exists and no replacement has
  // been designed, so a passing candidate is HELD: counted, never routed.
  assert.strictEqual(leadsCreatedCount, 0, "no Lead may be created immediately upon lightweight screening alone");
  assert.strictEqual(handoffsCreatedCount, 0, "no Handoff is created for a screened candidate");
  assert.ok(summary.evaluated > 0 && summary.heldNoResearchPath === summary.evaluated, "every candidate that passed screening is held");
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
 * Installs a Tavily/Notion/LLM mock for one autonomous discovery run and
 * returns the facts a caller can assert on: which governed records were
 * actually created, every governed create body that went over the wire, and
 * what the Activity Log recorded.
 *
 * Keeping the create bodies (not just the counts) is deliberate: a test can
 * then assert that no identity-bearing value ever reached Notion, which is a
 * stronger claim than "the right number of records was created".
 */
function installDiscoveryRun(t: any, evaluation: string) {
  const originalFetch = globalThis.fetch;
  const created: Record<string, number> = { handoffs: 0, leads: 0, proposals: 0, matters: 0, entities: 0 };
  const createBodies: any[] = [];
  const activityEntries: any[] = [];

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
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
    return new Response(JSON.stringify({ choices: [{ message: { content: evaluation } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return { created, createBodies, activityEntries };
}

test("LGS: a candidate passing lightweight screening is HELD -- no Handoff, no Lead, and no Blocker (nothing was refused; there is simply no research path to route to)", async (t) => {
  const { created, activityEntries } = installDiscoveryRun(t, PASS_EVALUATION);

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.strictEqual(created.handoffs, 0, "no Handoff may be created: Research & Intelligence is not a destination and no replacement exists");
  assert.strictEqual(created.leads, 0, "and certainly no Lead -- lightweight screening alone never creates one");
  assert.ok(summary.evaluated > 0, "the candidate really was evaluated");
  assert.strictEqual(summary.heldNoResearchPath, summary.evaluated, "every candidate that passed screening is held, and the summary says so");
  assert.strictEqual(summary.pendingApproval, 0, "nothing is presented to Martin: no evidence-backed validation step exists to produce a finding");
  assert.strictEqual(
    activityEntries.filter((p) => p?.Type?.select?.name === "Blocker").length,
    0,
    "holding a candidate is not a refused governed write, so it must not be logged as a Blocker",
  );
});

test("LGS: an unsupported diagnosis is screened out before any governed write -- no Handoff, no Lead, and nothing identity-bearing reaches Notion", async (t) => {
  const { created, createBodies, activityEntries } = installDiscoveryRun(t, UNSUPPORTED_EVALUATION);

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  assert.ok(summary.evaluated > 0, "the candidate was evaluated");
  assert.strictEqual(summary.screenedOut, summary.evaluated, "an unsupported diagnosis is screened out, not escalated");
  assert.strictEqual(created.handoffs, 0, "no Handoff for a candidate whose diagnosis is only a hypothesis");
  assert.strictEqual(created.leads, 0, "and no Lead");
  assert.strictEqual(summary.heldNoResearchPath, 0);

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

test("Test D & G: A passing candidate is held with no Handoff written -- its unvalidated diagnosis is never asserted as a fact", async (t) => {
  const originalFetch = globalThis.fetch;
  let createdHandoffBody: any;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
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
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{ pass: true, organisation: "Delta Corp", evidence: "New product line launch", decisionMakerOrRole: "", category: "", reason: "" }] }) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }), await lgsSkills());

  // Screening still runs and still passes; nothing is routed onward.
  assert.strictEqual(createdHandoffBody, undefined, "no Handoff is written for a held candidate");
  assert.ok(summary.heldNoResearchPath >= 1, "the candidate is held, not dropped silently");
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
    heldNoResearchPath: 1,
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
  assert.ok(sentTexts[0].includes("1 opportunity finding(s) sent to the Workspace topic for your approval"));
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
    heldNoResearchPath: 1,
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
    heldNoResearchPath: 0,
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
    heldNoResearchPath: 0,
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

  assert.deepStrictEqual(updated.pendingLeadOpportunity, SAMPLE_OPPORTUNITY);
  assert.ok(sentText.includes("Zenith Co"));
  assert.ok(sentText.includes(SAMPLE_OPPORTUNITY.evidence));
  assert.ok(sentText.includes("no Lead has been created"));
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

  const state = fakeOpportunityState();
  const proposed = await proposeLeadOpportunity(fakeEnv(), state, SAMPLE_OPPORTUNITY);
  assert.ok(proposed.pendingActionSummary);

  const resolved = await handleLeadOpportunityApproval(fakeEnv(), proposed, true);
  assert.strictEqual(resolved.pendingActionSummary, undefined, "resolving the approval must clear pendingActionSummary");
  // PENDING ARCHITECT DECISION: the Lead create is refused, because no
  // registered Action authorizes it under `discover_leads` (a read Action).
  // The approval-gate behaviour under test here -- the staged opportunity is
  // consumed exactly once -- is still asserted by the stale-tap half below.
  assert.strictEqual(leadCreateCount, 0, "the Lead create is refused while no Action authorizes it");

  // Simulate a resurfaced (stale) tap on the same, already-resolved item --
  // e.g. Martin taps an old /sessions-resurfaced button after already
  // approving via the original message. Must not create a second Lead.
  const staleTapResult = await handleLeadOpportunityApproval(fakeEnv(), resolved, true);
  assert.strictEqual(leadCreateCount, 0, "a stale approval tap must not execute the action a second time");
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

  const state = fakeOpportunityState({ pendingLeadOpportunity: SAMPLE_OPPORTUNITY });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(updated.pendingLeadOpportunity, undefined, "pending state must be cleared once decided");
  // PENDING ARCHITECT DECISION, as in Test A: Martin's approval is required and
  // present, and the Lead create is still refused, because `discover_leads` is a
  // read Action and no registered Action authorizes committing a Lead. The
  // approval requirement itself is therefore currently untestable end-to-end --
  // it is the ONLY thing standing between a screened candidate and a client
  // record, and it is not being exercised. That is the risk this decision
  // carries, stated rather than assumed away.
  assert.strictEqual(leadProps, null, "the Lead create is refused while no Action authorizes it");
  assert.ok(!sentText.includes("Lead recorded"), "no success message may be sent for a write that did not happen");
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

  const state = fakeOpportunityState({ pendingLeadOpportunity: SAMPLE_OPPORTUNITY });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, false);

  assert.strictEqual(updated.pendingLeadOpportunity, undefined);
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

  const state = fakeOpportunityState({ pendingLeadOpportunity: undefined });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(updated.pendingLeadOpportunity, undefined);
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

  const state = fakeOpportunityState({ pendingLeadOpportunity: SAMPLE_OPPORTUNITY });
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
  const outboundQueries: string[] = [];

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
      outboundQueries.push(JSON.parse(init.body).query);
      return new Response(JSON.stringify({ results: [{ title: "Nova Inc positioning shift", url: "https://example.com/nova", content: "Nova expansion." }] }), { status: 200 });
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
  assert.strictEqual(outboundQueries.length, 2, "both generated queries must have been searched");
  for (const query of outboundQueries) {
    assert.ok(!/\bENIG\b/i.test(query), `identity must not leave the runtime in a search query: ${query}`);
    assert.ok(!/\bMartin\b/i.test(query), `identity must not leave the runtime in a search query: ${query}`);
  }
  assert.ok(outboundQueries[0].includes("the business"), `the canonical redaction replacement must be applied: ${outboundQueries[0]}`);
  assert.ok(outboundQueries[1].includes("the operator"), `the canonical redaction replacement must be applied: ${outboundQueries[1]}`);
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
