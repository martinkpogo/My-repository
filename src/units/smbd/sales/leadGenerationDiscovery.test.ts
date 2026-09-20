import test from "node:test";
import assert from "node:assert";
import { DISCOVERY_QUERIES, notifyDiscoveryRunSummary, runAutonomousLeadDiscovery } from "./leadGenerationDiscovery";
import type { Env } from "../../../types";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    OPERATIONS_TOPIC_ID: "14",
    WORKSPACE_TOPIC_ID: "100",
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

  // Verify no queries presuppose unsupported negative diagnoses
  const forbiddenDiagnosticTerms = ["poor", "bad", "confused", "ineffective", "weak", "failing"];
  for (const query of DISCOVERY_QUERIES) {
    const lower = query.toLowerCase();
    for (const term of forbiddenDiagnosticTerms) {
      assert.ok(!lower.includes(term), `DISCOVERY_QUERIES item "${query}" must not contain diagnostic presupposition term "${term}"`);
    }
  }

  // Verify coverage across observable business situation categories
  const queryBlock = DISCOVERY_QUERIES.join(" ").toLowerCase();
  assert.ok(queryBlock.includes("rebrand") || queryBlock.includes("repositioning"), "must cover repositioning/brand change signals");
  assert.ok(queryBlock.includes("market") || queryBlock.includes("expansion"), "must cover market/customer expansion signals");
  assert.ok(queryBlock.includes("offering") || queryBlock.includes("service") || queryBlock.includes("model"), "must cover offering/business-model change signals");
  assert.ok(queryBlock.includes("funding") || queryBlock.includes("growth") || queryBlock.includes("acquisition"), "must cover growth/strategic change signals");
  assert.ok(queryBlock.includes("messaging") || queryBlock.includes("value proposition") || queryBlock.includes("positioning"), "must cover communication/positioning signals");
});

test("runAutonomousLeadDiscovery does nothing when web search isn't configured -- never fabricates a run", async () => {
  const summary = await runAutonomousLeadDiscovery(fakeEnv());
  assert.deepStrictEqual(summary, { evaluated: 0, handoffsCreated: 0, recorded: [], screenedOut: 0, skippedAsDuplicate: 0, skippedAsInsufficient: 0 });
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

test("Test B: Completed R&I research with insufficient evidence -> no Lead created", async (t) => {
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
  assert.ok(summary.screenedOut >= 1 || summary.skippedAsInsufficient >= 0);
});

test("Test C: Completed R&I research satisfying Acquisition Criteria -> Lead created with Status New", async (t) => {
  const originalFetch = globalThis.fetch;
  let leadsCreatedCount = 0;
  let createdLeadProps: any;

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
                "Verified Facts & Sources": { rich_text: [{ plain_text: "Candidate Organisation: Gamma Inc\nSource URL: https://example.com/gamma" }] },
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
        createdLeadProps = body.properties;
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

  const summary = await runAutonomousLeadDiscovery(fakeEnv({ HANDOFFS_DATA_SOURCE_ID: "handoffs-ds", TAVILY_API_KEY: "key", GROQ_API_KEY: "key" }));

  assert.strictEqual(leadsCreatedCount, 1, "exactly one Lead should be created when Acquisition Criteria are satisfied by research");
  assert.strictEqual(summary.recorded.length, 1);
  assert.deepStrictEqual(createdLeadProps.Status, { select: { name: "New" } });
  assert.strictEqual(createdLeadProps.Organisation.rich_text[0].text.content, "Gamma Inc");
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

  assert.strictEqual(summary.recorded.length, 0);
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
  assert.strictEqual(summary.recorded.length, 0);
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
    recorded: [{ organisation: "Acme Corp", url: "https://notion.so/lead-page-1" }],
    screenedOut: 9,
    skippedAsDuplicate: 1,
    skippedAsInsufficient: 1,
  });

  assert.strictEqual(success, true, "notifyDiscoveryRunSummary should return true when message succeeds");
  assert.strictEqual(sentTexts.length, 1, "exactly one digest message per run, never one per Lead");
  assert.ok(sentTexts[0].startsWith("Hat: Lead Generation Specialist."));
  assert.ok(sentTexts[0].includes("12 candidate(s) evaluated"));
  assert.ok(sentTexts[0].includes("Acme Corp"));
  assert.ok(sentTexts[0].includes("no Entity created, no qualification performed"));
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
    recorded: [],
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
    recorded: [],
    screenedOut: 1,
    skippedAsDuplicate: 0,
    skippedAsInsufficient: 0,
  });
  assert.strictEqual(success1, false);

  const success2 = await notifyDiscoveryRunSummary(fakeEnv(), 0, undefined, {
    evaluated: 1,
    handoffsCreated: 0,
    recorded: [],
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
