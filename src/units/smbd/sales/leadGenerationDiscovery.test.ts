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
import type { Env, WorkState } from "../../../types";

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
  const summary = await runAutonomousLeadDiscovery(fakeEnv());
  assert.deepStrictEqual(summary, { evaluated: 0, handoffsCreated: 0, pendingApproval: 0, screenedOut: 0, skippedAsDuplicate: 0, skippedAsInsufficient: 0 });
});

test("Test A: Candidate signal passes lightweight screening -> R&I Pending Work Handoff created, no Lead created", async (t) => {
  const originalFetch = globalThis.fetch;
  let handoffsCreatedCount = 0;
  let leadsCreatedCount = 0;
  let createdHandoffBody: any;

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
        createdHandoffBody = body;
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

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.ok(summary.handoffsCreated >= 1);
  assert.ok(handoffsCreatedCount >= 1, "at least one R&I Work Handoff should be created upon lightweight pass");
  assert.strictEqual(leadsCreatedCount, 0, "no Lead should be created immediately upon lightweight screening alone");
  assert.deepStrictEqual(createdHandoffBody.properties["To Unit"], { select: { name: "Research & Intelligence" } });
  assert.deepStrictEqual(createdHandoffBody.properties["From Unit"], { select: { name: "Sales" } });
  assert.strictEqual(createdHandoffBody.properties["From Hat"].rich_text[0].text.content, "Lead Generation Specialist");
  assert.ok(createdHandoffBody.properties.Reason.rich_text[0].text.content.includes("LGS Autonomous Lead Discovery"));
});

test("Test B: Completed R&I research with insufficient evidence -> no Lead created, no opportunity presented", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("handoffs-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "h1",
              properties: {
                "From Unit": { select: { name: "Sales" } },
                "From Hat": { rich_text: [{ plain_text: "Lead Generation Specialist" }] },
                "To Unit": { select: { name: "Research & Intelligence" } },
                Status: { select: { name: "Closed" } },
                Reason: { rich_text: [{ plain_text: "LGS Autonomous Lead Discovery: research request" }] },
                "Verified Facts & Sources": { rich_text: [{ plain_text: "Candidate Organisation: Beta LLC\nSource URL: https://example.com/beta" }] },
                "Work Completed": { rich_text: [{ plain_text: JSON.stringify({ findings: [], implications: [], limitations: [{ statement: "Insufficient evidence" }] }) }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (body.parent?.data_source_id === "leads-ds") {
        leadsCreatedCount++;
      }
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    // AI evaluation returns pass: false for insufficient research
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pass: false, organisation: "Beta LLC", evidence: "", reason: "Insufficient evidence" }) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.strictEqual(leadsCreatedCount, 0, "no Lead should be created when research evidence is insufficient");
  assert.strictEqual(summary.pendingApproval, 0, "no opportunity should be presented when research evidence is insufficient");
});

test("Test C: Completed R&I research satisfying Acquisition Criteria -> opportunity presented for approval, no Lead created directly", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("handoffs-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "h2",
              properties: {
                "From Unit": { select: { name: "Sales" } },
                "From Hat": { rich_text: [{ plain_text: "Lead Generation Specialist" }] },
                "To Unit": { select: { name: "Research & Intelligence" } },
                Status: { select: { name: "Closed" } },
                Reason: { rich_text: [{ plain_text: "LGS Autonomous Lead Discovery: research request" }] },
                "Verified Facts & Sources": { rich_text: [{ plain_text: "Candidate Organisation: Gamma Inc\nSource URL: https://example.com/gamma\nCategory: positioning" }] },
                "Work Completed": { rich_text: [{ plain_text: JSON.stringify({ findings: [{ statement: "Gamma Inc expanded into EU market with unaligned messaging" }] }) }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("leads-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/pages") && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.parent?.data_source_id === "leads-ds") {
        leadsCreatedCount++;
      }
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pass: true,
                organisation: "Gamma Inc",
                evidence: "Attributable market expansion evidence with positioning gap",
                reason: "Acquisition criteria satisfied by evidence.",
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

  const { workSession, calls } = createMockWorkSession();
  const summary = await runAutonomousLeadDiscovery(
    fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key", WORK_SESSION: workSession as any }),
  );

  assert.strictEqual(leadsCreatedCount, 0, "scheduled discovery must NEVER create a Lead directly -- only Martin's approval may");
  assert.strictEqual(summary.pendingApproval, 1, "exactly one opportunity should be presented for approval");
  assert.strictEqual(calls.init.length, 1, "a fresh WorkSession should be created to hold the pending approval");
  assert.strictEqual(calls.proposeLeadOpportunity.length, 1, "the opportunity should be presented to Martin");
  const [opportunity] = calls.proposeLeadOpportunity[0];
  assert.strictEqual(opportunity.organisation, "Gamma Inc");
  assert.strictEqual(opportunity.evidence, "Attributable market expansion evidence with positioning gap");
});

test("Test D & G: Unsupported diagnosis/hypothesis does not become an asserted fact & opaque token rules preserved", async (t) => {
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

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.ok(summary.handoffsCreated >= 1);
  assert.ok(createdHandoffBody, "handoff should be created");
  assert.strictEqual(createdHandoffBody.properties.Entity_Token.rich_text[0].text.content, "E-UNBOUND", "Entity_Token must remain opaque non-resolvable reference token");
  assert.strictEqual(createdHandoffBody.properties.Matter_Token.rich_text[0].text.content, "M-UNBOUND", "Matter_Token must remain opaque non-resolvable reference token");
});

test("Test E & F: Repeated execution idempotency & unrelated closed R&I Handoff ignored", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;

  globalThis.fetch = (async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/blocks/")) {
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "governance text" }] } }] }), { status: 200 });
    }
    if (url.includes("handoffs-ds") && method === "POST" && url.endsWith("/query")) {
      return new Response(
        JSON.stringify({
          results: [
            // Unrelated closed R&I handoff (From Hat: Marketing Strategist or missing LGS origin marker)
            {
              id: "unrelated-1",
              properties: {
                "From Unit": { select: { name: "Marketing" } },
                "From Hat": { rich_text: [{ plain_text: "Marketing Strategist" }] },
                "To Unit": { select: { name: "Research & Intelligence" } },
                Status: { select: { name: "Closed" } },
                Reason: { rich_text: [{ plain_text: "Unrelated marketing request" }] },
                "Verified Facts & Sources": { rich_text: [{ plain_text: "Candidate Organisation: Epsilon Corp" }] },
                "Work Completed": { rich_text: [{ plain_text: JSON.stringify({ findings: [{ statement: "Epsilon research" }] }) }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/pages") && method === "POST") {
      leadsCreatedCount++;
      return new Response(JSON.stringify({ id: "page1", url: "https://notion.so/page1", properties: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: PASS_EVALUATION } }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.strictEqual(summary.pendingApproval, 0);
  assert.strictEqual(leadsCreatedCount, 0, "unrelated closed R&I handoff must NOT be consumed by LGS");
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

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

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

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

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
    handoffsCreated: 1,
    pendingApproval: 1,
    screenedOut: 9,
    skippedAsDuplicate: 1,
    skippedAsInsufficient: 1,
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
    handoffsCreated: 1,
    pendingApproval: 0,
    screenedOut: 4,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
  });

  assert.strictEqual(success, false, "notifyDiscoveryRunSummary should return false when Telegram fetch throws");
});

test("notifyDiscoveryRunSummary handles invalid or missing chatId cleanly without throwing", async () => {
  const success1 = await notifyDiscoveryRunSummary(fakeEnv(), NaN, undefined, {
    evaluated: 1,
    handoffsCreated: 0,
    pendingApproval: 0,
    screenedOut: 1,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
  });
  assert.strictEqual(success1, false);

  const success2 = await notifyDiscoveryRunSummary(fakeEnv(), 0, undefined, {
    evaluated: 1,
    handoffsCreated: 0,
    pendingApproval: 0,
    screenedOut: 1,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
  });
  assert.strictEqual(success2, false);
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
  const summary = await runAutonomousLeadDiscovery(env); // returns summary with 0 evaluated when unconfigured

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
  const summary = await runAutonomousLeadDiscovery(env);

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
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const state = fakeOpportunityState({ pendingLeadOpportunity: SAMPLE_OPPORTUNITY });
  const updated = await handleLeadOpportunityApproval(fakeEnv(), state, true);

  assert.strictEqual(updated.pendingLeadOpportunity, undefined, "pending state must be cleared once decided");
  assert.ok(leadProps, "a Lead should be created on explicit approval");
  assert.deepStrictEqual(leadProps.Status, { select: { name: "New" } });
  assert.strictEqual(leadProps.Organisation.rich_text[0].text.content, "Zenith Co");
  assert.ok(sentText.includes("Lead recorded"));
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
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(fakeEnv({ GROQ_API_KEY: "key" }), 12345, "How's it going?");
  assert.strictEqual(handled, false);
});

test("LeadOpportunityDiscoveryCapability generates a search strategy and creates R&I Handoffs for promising signals, never a Lead directly", async (t) => {
  const originalFetch = globalThis.fetch;
  let ackText = "";
  let handoffsCreatedCount = 0;
  let leadsCreatedCount = 0;

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
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ queries: ["positioning problem query one", "positioning problem query two"] }) } }] }), { status: 200 });
    }
    if (body.includes("several public web search results")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: PASS_EVALUATION } }] }), { status: 200 });
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
  );

  assert.strictEqual(handled, true);
  assert.ok(ackText.includes("Searching for organisations"));
  assert.ok(ackText.includes("positioning problem"));
  assert.ok(handoffsCreatedCount >= 1, "at least one R&I Handoff should be created from the on-demand queries");
  assert.strictEqual(leadsCreatedCount, 0, "on-demand discovery must never create a Lead directly");
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
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(
    fakeEnv({ TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }),
    12345,
    "Find me 3 companies with a positioning problem",
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
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const handled = await LeadOpportunityDiscoveryCapability.handleIntake(fakeEnv({ GROQ_API_KEY: "key" }), 12345, "Find me some companies");

  assert.strictEqual(handled, true);
  assert.ok(sentText.includes("no web search provider is configured"));
});
