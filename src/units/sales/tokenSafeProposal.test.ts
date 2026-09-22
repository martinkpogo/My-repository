import test from "node:test";
import assert from "node:assert/strict";
import {
  handleProposalHandoffPickup,
  handleSalesProposalDecision,
  handleSalesProposalRevisionText,
  parseFinanceQuote,
  extractInvestmentTolerance,
  buildProposalContent,
  PROPOSAL_CALLBACK_ACTION,
} from "./tokenSafeProposal";
import type { Env, WorkState } from "../../types";
import type { StrategyProposal } from "../strategy/strategyAnalyst";

// ---------------------------------------------------------------------------
// Fixtures: the live MAT-20 slice (HO-64, E-20/MAT-20, GHS 420,000).
// ---------------------------------------------------------------------------

const HO64_ID = "handoff-ho-64";
const HO62_ID = "handoff-ho-62";
const FINANCE_RATIONALE =
  "The price is based on the value-at-stake, which is the company's annual turnover. The intervention is expected to contribute to increased sales growth and enhanced credibility with larger accounts, which can lead to improved financial performance. The price is set at approximately 1.5% of the annual turnover, which is a reasonable estimate of the value that the intervention can bring to the company.";
const HO64_FACTS = `Authoritative quote: GHS 420000\nRationale: ${FINANCE_RATIONALE}`;

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "m",
    AI_MODEL_LIGHT: "m",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    TELEGRAM_BOT_TOKEN: "t",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "n",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "604",
    OPERATIONS_TOPIC_ID: "588",
    ...overrides,
  };
}

function approvedStrategyProposal(overrides: Partial<StrategyProposal> = {}): StrategyProposal {
  return {
    proposalId: "strategy-prop-1",
    proposalVersion: 1,
    executiveSummary: {
      businessSituation: "Ghana-based food manufacturing and distribution company with ~GHS 28M annual turnover, pursuing larger retail and institutional accounts",
      strategicProblem: "Inconsistent external presentation, potential perception as a smaller business, limited digital presence",
      recommendedDirection: "Develop a unified company image and messaging framework, and enhance digital presence",
      proposedIntervention: "Unified company image and messaging framework with enhanced digital presence",
      expectedBusinessEffect: "Improved credibility and trust with larger accounts",
      decisionRequired: "Approve the intervention",
    },
    businessContext: { entityContext: "", businessObjectives: "", relevantMarketContext: "", relevantAudienceOrCustomerContext: "", currentState: "", engagementTrigger: "", relevantCommercialContext: "", evidence: [] },
    strategicChallenge: {
      businessObjective: "Move toward larger and more structured customers",
      observedSituation: "Two company profiles and three decks in circulation with inconsistent content",
      strategicQuestion: "What is limiting credibility with larger accounts?",
      whyItMatters: "Larger accounts expect consistent, credible information",
    },
    diagnosis: {
      symptom: "Inconsistent external presentation",
      problem: "Lack of a unified company image and messaging",
      causes: ["Insufficient investment in brand development and external presentation"],
      constraints: ["Limited resources", "Lack of a single master document"],
      consequences: ["Potential missed opportunities", "Delayed or weakened sales growth"],
      evidence: ["Client-verified inventory of materials"],
      diagnosticConclusion: "The lack of a unified company image and messaging is the primary cause of the inconsistent external presentation",
    },
    strategicOpportunity: { opportunity: "Stronger larger-account presentation", basis: "Client-stated growth objective", relevanceToBusinessObjective: "Direct", opportunityConditions: [] },
    strategicObjective: { objective: "Develop a unified company image and messaging framework, and enhance digital presence", intendedChange: "Improved credibility and trust with larger accounts", businessAlignment: "Growth objective", measurementDirection: "Consistency of materials in use" },
    recommendedDirection: { direction: "Unified image, messaging and digital presence", rationale: "Builds trust and credibility with larger accounts", strategicLogic: "Consistency supports credibility", alternativesConsidered: [], selectionBasis: "" },
    proposedIntervention: {
      interventionName: "Develop a unified company image and messaging framework, and enhance digital presence",
      interventionSummary: "Conduct a diagnostic audit, develop a unified company image and messaging framework, enhance digital presence, and provide training to sales teams",
      workstreams: [
        { name: "Diagnostic Audit", objective: "Identify root causes of inconsistent presentation", activities: ["Review all materials in circulation"], output: "Diagnostic report", dependencies: [], acceptanceCriteria: [] },
        { name: "Unified Company Image and Messaging Framework", objective: "Develop the framework", activities: ["Draft master profile"], output: "Unified company image and messaging framework", dependencies: [], acceptanceCriteria: [] },
      ],
    },
    deliverables: [
      { name: "Diagnostic report", description: "Findings of the audit", format: "Document", acceptanceCriteria: [] },
      { name: "Master company profile", description: "Single approved profile", format: "Document", acceptanceCriteria: [] },
    ],
    timeline: { status: "Indicative", totalDuration: "12 weeks", phases: [{ name: "Audit", duration: "3 weeks", activities: [], outputs: ["Diagnostic report"], dependencies: [], reviewPoint: "Audit review" }] },
    entityInputs: { requiredInformation: ["All current profiles and decks"], requiredDocuments: [], requiredAccess: [], requiredStakeholderParticipation: ["Management interviews"], requiredDecisions: [] },
    assumptions: [{ assumption: "Client can commit resources for interviews", basis: "Client feedback", materiality: "High" }],
    dependencies: [{ dependency: "Access to current materials", owner: "Client", impactIfUnavailable: "Audit delayed" }],
    risksAndConstraints: { risks: [{ risk: "Stakeholder availability", potentialEffect: "Delay", mitigationOrResponse: "Early scheduling" }], constraints: [{ constraint: "Limited resources", implication: "Phased delivery" }] },
    expectedBusinessEffect: { intendedEffects: ["Consistent presentation across teams"], measurableEffects: ["One master profile in use"], effectsRequiringBaseline: [], limitations: ["No attributable lost-revenue figure exists"] },
    successCriteria: [{ criterion: "Single master profile adopted", measurement: "Materials audit", evidenceRequired: "Inventory" }],
    commercialScope: { included: ["Diagnostic audit", "Messaging framework"], excluded: ["Full rebrand"], expectedResources: [], expectedDuration: "12 weeks", clientResponsibilities: ["Provide materials"], downstreamUnitResponsibilities: [] },
    ...overrides,
  } as StrategyProposal;
}

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "11111111-2222-3333-4444-555555555555",
    chatId: 9999,
    unit: "Finance",
    hat: "Value-Based Pricing Assessor",
    stage: "quote_approved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: HO64_ID,
    entityToken: "E-20",
    matterToken: "MAT-20",
    strategyApprovalState: "APPROVED",
    strategyProposal: approvedStrategyProposal(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory Notion + Telegram fake.
// ---------------------------------------------------------------------------

type Props = Record<string, any>;

function toReadForm(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (v && Array.isArray(v.rich_text)) out[k] = { rich_text: v.rich_text.map((t: any) => ({ plain_text: t.text?.content ?? t.plain_text ?? "", text: t.text })) };
    else if (v && Array.isArray(v.title)) out[k] = { title: v.title.map((t: any) => ({ plain_text: t.text?.content ?? t.plain_text ?? "", text: t.text })) };
    else out[k] = v;
  }
  return out;
}

function rt(text: string) {
  return { rich_text: [{ plain_text: text }] };
}

function text(prop: any): string {
  if (!prop) return "";
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.plain_text).join("");
  if (prop.title) return prop.title.map((t: any) => t.plain_text).join("");
  if (prop.select) return prop.select?.name ?? "";
  return "";
}

interface World {
  pages: Map<string, { id: string; url: string; parent: string; properties: Props }>;
  fetches: { method: string; url: string; body?: any }[];
  telegram: { text: string; buttons?: any }[];
  blockAppends: { pageId: string; children: any[] }[];
  logs: Props[];
  handoffCreates: Props[];
  nextProposalNumber: number;
}

function ho64Props(overrides: Props = {}): Props {
  return {
    "Handoff ID": { unique_id: { prefix: "HO", number: 64 } },
    Handoff: { title: [{ plain_text: "Draft Proposal — MAT-20" }] },
    "From Unit": { select: { name: "Finance" } },
    "From Hat": rt("Value-Based Pricing Assessor"),
    "To Unit": { select: { name: "Sales" } },
    "To Hat": rt("Sales Executive"),
    Type: { select: { name: "Work" } },
    Status: { select: { name: "Pending" } },
    Entity_Token: rt("E-20"),
    Matter_Token: rt("MAT-20"),
    "Verified Facts & Sources": rt(HO64_FACTS),
    ...overrides,
  };
}

function ho62Props(): Props {
  return {
    "Handoff ID": { unique_id: { prefix: "HO", number: 62 } },
    "From Unit": { select: { name: "Sales" } },
    "To Unit": { select: { name: "Strategy" } },
    Matter_Token: rt("MAT-20"),
    "Verified Facts & Sources": rt("...\nInvestment boundary (context only, not pricing basis): GHS 30,000-60,000 initial planning range, open to more if evidence/scope justifies it.\n..."),
  };
}

function matches(props: Props, filter: any): boolean {
  if (!filter) return true;
  if (filter.and) return filter.and.every((f: any) => matches(props, f));
  const p = props[filter.property];
  if (filter.relation?.contains) return (p?.relation ?? []).some((r: any) => r.id === filter.relation.contains);
  if (filter.rich_text?.equals !== undefined) return text(p) === filter.rich_text.equals;
  if (filter.select?.equals !== undefined) return text(p) === filter.select.equals;
  return false;
}

function installWorld(t: any, opts: { ho64?: Props; withHo62?: boolean; proposalPrefix?: string | null; stripProposalId?: boolean } = {}): World {
  const world: World = { pages: new Map(), fetches: [], telegram: [], blockAppends: [], logs: [], handoffCreates: [], nextProposalNumber: 7 };
  world.pages.set(HO64_ID, { id: HO64_ID, url: "https://notion.so/ho64", parent: "handoffs-ds", properties: opts.ho64 ?? ho64Props() });
  if (opts.withHo62 !== false) world.pages.set(HO62_ID, { id: HO62_ID, url: "https://notion.so/ho62", parent: "handoffs-ds", properties: ho62Props() });
  const prefix = opts.proposalPrefix === undefined ? "PROP" : opts.proposalPrefix;

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    world.fetches.push({ method, url: u, body });
    const json = (o: any) => new Response(JSON.stringify(o), { status: 200 });

    if (u.includes("api.telegram.org")) {
      world.telegram.push({ text: body.text ?? "", buttons: body.reply_markup?.inline_keyboard });
      return json({ ok: true, result: { message_id: world.telegram.length } });
    }
    const q = u.match(/\/data_sources\/([^/]+)\/query$/);
    if (q && method === "POST") {
      const results = [...world.pages.values()].filter((p) => p.parent === q[1] && matches(p.properties, body.filter));
      return json({ results: results.map((p) => ({ id: p.id, url: p.url, properties: p.properties })) });
    }
    const blocks = u.match(/\/blocks\/([^/]+)\/children$/);
    if (blocks && method === "PATCH") {
      world.blockAppends.push({ pageId: blocks[1], children: body.children });
      return json({ results: [] });
    }
    if (u.endsWith("/pages") && method === "POST") {
      const parent = body.parent.data_source_id;
      const props = toReadForm(body.properties);
      if (parent === "activity-log-ds") {
        world.logs.push(props);
        return json({ id: "log", url: "https://notion.so/log", properties: props });
      }
      if (parent === "handoffs-ds") world.handoffCreates.push(props);
      const id = `${parent}-page-${world.pages.size + 1}`;
      if (parent === "proposals-ds" && !opts.stripProposalId) props["Proposal ID"] = { unique_id: { prefix, number: world.nextProposalNumber++ } };
      world.pages.set(id, { id, url: `https://notion.so/${id}`, parent, properties: props });
      return json({ id, url: `https://notion.so/${id}`, properties: props });
    }
    const pg = u.match(/\/pages\/([^/]+)$/);
    if (pg) {
      const page = world.pages.get(pg[1]);
      if (!page) return new Response("not found", { status: 404 });
      if (method === "PATCH") Object.assign(page.properties, toReadForm(body.properties));
      return json({ id: page.id, url: page.url, properties: page.properties, parent: { type: "data_source_id", data_source_id: page.parent } });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return world;
}

function proposals(world: World) {
  return [...world.pages.values()].filter((p) => p.parent === "proposals-ds");
}

function approvalRequests(world: World) {
  return world.telegram.filter((m) => m.text.includes("Proposal approval request"));
}

async function createV1(t: any, stateOverrides: Partial<WorkState> = {}, worldOpts: Parameters<typeof installWorld>[1] = {}) {
  const world = installWorld(t, worldOpts);
  const env = fakeEnv();
  const state = await handleProposalHandoffPickup(env, fakeState(stateOverrides));
  return { world, env, state };
}

// ---------------------------------------------------------------------------
// 1-2. Exactly one canonical Proposal; reprocessing is idempotent.
// ---------------------------------------------------------------------------

test("1. HO-64 produces exactly one canonical Proposal linked to HO-64", async (t) => {
  const { world, state } = await createV1(t);
  const recs = proposals(world);
  assert.strictEqual(recs.length, 1);
  assert.deepStrictEqual(recs[0].properties.Handoff.relation, [{ id: HO64_ID }]);
  assert.strictEqual(state.salesProposal?.proposalId, "PROP-7");
  assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Closed");
});

test("2. Reprocessing HO-64 is idempotent -- no second record, no new Version, same content", async (t) => {
  const { world, env, state } = await createV1(t);
  const contentBefore = text(proposals(world)[0].properties["Proposal Content"]);

  // Same WorkSession reprocesses (e.g. HO-64 set back to Pending by hand).
  world.pages.get(HO64_ID)!.properties.Status = { select: { name: "Pending" } };
  const again = await handleProposalHandoffPickup(env, state);
  // A fresh WorkSession with no memory of the Proposal also reprocesses.
  const fresh = await handleProposalHandoffPickup(env, fakeState());

  assert.strictEqual(proposals(world).length, 1, "reprocessing must never create a duplicate Proposal");
  const rec = proposals(world)[0];
  assert.strictEqual(text(rec.properties.Version), "v1");
  assert.strictEqual(text(rec.properties["Proposal Content"]), contentBefore);
  assert.strictEqual(again.salesProposal?.currentVersion, 1);
  assert.strictEqual(fresh.salesProposal?.proposalId, "PROP-7");
  assert.strictEqual(world.blockAppends.length, 1, "no additional version snapshot on reprocess");
  assert.strictEqual(approvalRequests(world).length, 3, "reprocessing re-presents the same pending Version");
  assert.ok(approvalRequests(world).every((m) => m.text.includes("Proposal: PROP-7 · Version: v1")));
});

test("2b. A Proposal for the same Matter not linked to HO-64 is ambiguous -- fails closed, no new record", async (t) => {
  const world = installWorld(t);
  world.pages.set("stray", { id: "stray", url: "u", parent: "proposals-ds", properties: { "Matter Token": rt("MAT-20"), Handoff: { relation: [] } } });
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState());
  assert.strictEqual(proposals(world).length, 1, "only the pre-existing stray record");
  assert.match(state.blockedReason ?? "", /cannot deterministically associate/);
  assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Held");
});

// ---------------------------------------------------------------------------
// 3-4, 16. Token safety and the identity boundary.
// ---------------------------------------------------------------------------

test("3. Proposal carries E-20 and MAT-20 as tokens and no Entity/Matter relation", async (t) => {
  const { world } = await createV1(t);
  const rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec["Entity Token"]), "E-20");
  assert.strictEqual(text(rec["Matter Token"]), "MAT-20");
  assert.strictEqual(rec.Entity, undefined, "no relation to the identity-bearing Entity page");
  assert.strictEqual(rec.Matter, undefined, "no relation to the identity-bearing Matter page");
  const content = text(rec["Proposal Content"]);
  assert.match(content, /Entity_Token: E-20/);
  assert.match(content, /Matter_Token: MAT-20/);
});

test("4. A real client identity cannot enter the Runtime Proposal -- fails closed before any record is written", async (t) => {
  const leaked = approvedStrategyProposal();
  leaked.executiveSummary = { ...leaked.executiveSummary, businessSituation: "Acme Foods Ghana Ltd is pursuing larger accounts" };
  const { world, state } = await createV1(t, { strategyProposal: leaked, entityName: "Acme Foods Ghana Ltd" });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /identity-bearing value/);
  assert.ok(!world.telegram.some((m) => m.text.includes("Acme Foods")), "the identity itself is never echoed to Telegram");
  assert.ok(!world.logs.some((l) => JSON.stringify(l).includes("Acme Foods")), "nor into the Activity Log");
  assert.ok(!JSON.stringify(world.pages.get(HO64_ID)!.properties).includes("Acme Foods"), "nor onto the Handoff");
});

test("4b. Contact details (email / phone) cannot enter the Runtime Proposal even when no name is known", async (t) => {
  const leaked = approvedStrategyProposal();
  leaked.executiveSummary = { ...leaked.executiveSummary, strategicProblem: "Contact ceo@example.com or +233 24 123 4567" };
  const { world, state } = await createV1(t, { strategyProposal: leaked });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /identity-bearing value/);
});

test("16. Runtime never resolves Entity_Token/Matter_Token -- no Entity/Matters reads, no Drive/Gmail access", async (t) => {
  const { world, env, state } = await createV1(t);
  const ready = await handleSalesProposalDecision(env, state, 7, 1, "approve");
  assert.strictEqual(ready.salesProposal?.approvalStatus, "Approved");
  for (const f of world.fetches) {
    assert.ok(!f.url.includes("entity-ds") && !f.url.includes("matters-ds"), `no Entity/Matters access: ${f.url}`);
    assert.ok(!/googleapis|gmail|drive/i.test(f.url), `no Google access: ${f.url}`);
    assert.ok(!f.url.includes("/search"), `no Notion search: ${f.url}`);
  }
  const pageReads = world.fetches.filter((f) => f.method === "GET" && f.url.includes("/pages/")).map((f) => f.url.split("/pages/")[1]);
  assert.ok(pageReads.every((id) => id === HO64_ID || id.startsWith("proposals-ds")), `only the Handoff and the Proposal are read: ${pageReads}`);
});

// ---------------------------------------------------------------------------
// 5-9. Full content, the Finance quote and its rationale, Pending Approval.
// ---------------------------------------------------------------------------

test("5. The complete Proposal content is stored (beyond 2,000 chars, not truncated) and snapshotted", async (t) => {
  const { world, state } = await createV1(t);
  const rec = proposals(world)[0].properties;
  const stored = text(rec["Proposal Content"]);
  assert.strictEqual(stored, state.salesProposal!.versions[0].content, "stored content is the full composed Proposal");
  for (const heading of [
    "1. PROPOSAL IDENTIFICATION",
    "2. EXECUTIVE SUMMARY / CONTEXT",
    "3. STRATEGIC PROBLEM / OPPORTUNITY",
    "4. DIAGNOSIS",
    "5. OBJECTIVE",
    "6. RECOMMENDED INTERVENTION",
    "7. SCOPE AND DELIVERABLES",
    "8. APPROACH / METHOD",
    "9. EXPECTED OUTCOMES",
    "10. TIMELINE",
    "11. BASIS FOR THE INVESTMENT",
    "12. INVESTMENT",
    "13. COMMERCIAL TERMS",
    "14. WHAT ENIG NEEDS FROM THE CLIENT",
    "15. ASSUMPTIONS, DEPENDENCIES, RISKS AND EXCLUSIONS",
    "16. NEXT STEPS",
  ]) {
    assert.ok(stored.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(stored.includes("Unified Company Image and Messaging Framework"), "workstreams are carried in full");
  assert.ok(rec["Proposal Content"].rich_text.length > 1, "long content is split across rich-text items, not truncated");
  assert.strictEqual(world.blockAppends.length, 1);
  const snapshot = world.blockAppends[0].children.slice(1).map((b: any) => b.paragraph.rich_text[0].text.content).join("");
  assert.strictEqual(snapshot, stored, "a v1 snapshot is kept in the page body");
});

test("6. The Finance quote remains exactly GHS 420,000", async (t) => {
  const { world, state } = await createV1(t);
  const rec = proposals(world)[0].properties;
  assert.strictEqual(rec["Quoted Price"].number, 420000);
  assert.match(text(rec["Quote Rationale"]), /^Currency: GHS\./);
  const content = text(rec["Proposal Content"]);
  assert.match(content, /Investment: GHS 420,000 \(authoritative Finance quote/);
  assert.strictEqual(state.salesProposal!.facts!.quote.price, 420000);
  assert.strictEqual(state.salesProposal!.facts!.quote.currency, "GHS");
});

test("7. The Finance rationale is preserved verbatim, with no added financial justification", async (t) => {
  const { world } = await createV1(t);
  const rec = proposals(world)[0].properties;
  const content = text(rec["Proposal Content"]);
  assert.ok(content.includes(`Approved Finance pricing rationale:\n${FINANCE_RATIONALE}`));
  assert.ok(text(rec["Quote Rationale"]).endsWith(FINANCE_RATIONALE));
  const basis = content.split("11. BASIS FOR THE INVESTMENT")[1].split("12. INVESTMENT")[0].trim();
  assert.strictEqual(basis, `Approved Finance pricing rationale:\n${FINANCE_RATIONALE}`, "nothing beyond the Finance rationale in the basis section");
});

test("8. The GHS 30,000–60,000 client planning range is kept as context and never replaces GHS 420,000", async (t) => {
  const { world } = await createV1(t);
  const rec = proposals(world)[0].properties;
  const content = text(rec["Proposal Content"]);
  assert.strictEqual(rec["Quoted Price"].number, 420000);
  assert.match(content, /Client-disclosed planning range \(commercial context only; client-disclosed, recorded on HO-62\): GHS 30,000–60,000/);
  const investment = content.split("12. INVESTMENT")[1].split("13. COMMERCIAL TERMS")[0];
  assert.ok(!investment.includes("30,000") && !investment.includes("60,000"), "the range never appears in the Investment section");
  assert.match(investment, /GHS 420,000/);
  const internal = content.split("INTERNAL REVIEW NOTES")[1];
  assert.ok(content.indexOf("30,000") > content.indexOf("INTERNAL REVIEW NOTES"), "range only in the internal notes");
  assert.match(internal, /does not replace or alter the Finance quote/);
});

test("9. A newly generated Proposal is Pending Approval, Approved Version blank, Artifact Status Not Requested", async (t) => {
  const { world, state } = await createV1(t);
  const rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec["Approval Status"]), "Pending Approval");
  assert.strictEqual(text(rec["Approved Version"]), "");
  assert.strictEqual(text(rec["Artifact Status"]), "Not Requested");
  assert.strictEqual(text(rec.Version), "v1");
  assert.strictEqual(state.salesProposal?.approvalStatus, "Pending Approval");
  assert.strictEqual(state.salesProposal?.approvedVersion, undefined);
});

// ---------------------------------------------------------------------------
// 10-13, 15. Approval bound to the exact Proposal ID + Version.
// ---------------------------------------------------------------------------

test("10. The approval request presents the complete Proposal and identifies the exact Proposal ID and Version", async (t) => {
  const { world, state } = await createV1(t);
  const reqs = approvalRequests(world);
  assert.strictEqual(reqs.length, 1);
  const full = world.telegram.map((m) => m.text).join("");
  assert.match(reqs[0].text, /Proposal: PROP-7 · Version: v1/);
  assert.ok(full.includes(state.salesProposal!.versions[0].content.slice(-200)), "the complete content is sent, not an outline");
  const buttons = world.telegram.at(-1)!.buttons.flat();
  assert.deepStrictEqual(
    buttons.map((b: any) => b.callback_data),
    [`${PROPOSAL_CALLBACK_ACTION}:${state.workId}:7.1.a`, `${PROPOSAL_CALLBACK_ACTION}:${state.workId}:7.1.r`],
  );
  assert.ok(buttons.every((b: any) => Buffer.byteLength(b.callback_data) <= 64), "Telegram callback_data 64-byte limit");
});

test("11-12, 15. Approving the exact Version sets Approved, records Approved Version exactly, and moves to Pending Identity Resolution", async (t) => {
  const { world, env, state } = await createV1(t);
  const result = await handleSalesProposalDecision(env, state, 7, 1, "approve");
  const rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec["Approval Status"]), "Approved");
  assert.strictEqual(text(rec["Approved Version"]), "v1");
  assert.strictEqual(text(rec["Artifact Status"]), "Pending Identity Resolution");
  assert.strictEqual(result.salesProposal?.approvedVersion, 1);
  const approvalLog = world.logs.find((l) => text(l.Entry).startsWith("Proposal approved: PROP-7 v1"));
  assert.ok(approvalLog, "approval event recorded in the Activity & Decision Log");
  assert.strictEqual(text(approvalLog!.Type), "Decision");
  assert.match(text(approvalLog!["Decision Rationale"]), /Version v1; content SHA-256 [0-9a-f]{64}/);
});

test("13. A stale approval cannot approve a newer or different Version", async (t) => {
  const { world, env, state } = await createV1(t);
  await handleSalesProposalDecision(env, state, 7, 1, "revise");
  await handleSalesProposalRevisionText(env, state, "State payment terms as 50% on signature, 50% on completion.");
  assert.strictEqual(state.salesProposal?.currentVersion, 2);

  await handleSalesProposalDecision(env, state, 7, 1, "approve"); // the old v1 button
  let rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec["Approval Status"]), "Pending Approval", "stale v1 approval must not approve v2");
  assert.strictEqual(text(rec["Approved Version"]), "");

  await handleSalesProposalDecision(env, state, 99, 2, "approve"); // wrong Proposal ID
  rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec["Approval Status"]), "Pending Approval", "approval for another Proposal ID must not apply");
  assert.ok(world.logs.some((l) => text(l.Entry).includes("stale or mismatched")));
});

test("13b. Approval fails closed if the record's content changed after Martin was shown it", async (t) => {
  const { world, env, state } = await createV1(t);
  proposals(world)[0].properties["Proposal Content"] = rt("tampered");
  await handleSalesProposalDecision(env, state, 7, 1, "approve");
  assert.strictEqual(text(proposals(world)[0].properties["Approval Status"]), "Pending Approval");
  assert.match(state.blockedReason ?? "", /no longer matches/);
});

test("13c. An unrecognised Approval Status on the record fails closed (cannot distinguish Pending from Approved)", async (t) => {
  const { world, env, state } = await createV1(t);
  proposals(world)[0].properties["Approval Status"] = { select: null };
  await handleSalesProposalDecision(env, state, 7, 1, "approve");
  assert.strictEqual(text(proposals(world)[0].properties["Approved Version"]), "");
  assert.match(state.blockedReason ?? "", /cannot distinguish Pending Approval from Approved/);
});

// ---------------------------------------------------------------------------
// 14. Substantive revision -> new Version, renewed approval.
// ---------------------------------------------------------------------------

test("14. A substantive revision after approval creates a new Version, keeps the approved substance, and requires renewed approval", async (t) => {
  const { world, env, state } = await createV1(t);
  await handleSalesProposalDecision(env, state, 7, 1, "approve");
  const v1Content = state.salesProposal!.versions[0].content;

  await handleSalesProposalDecision(env, state, 7, 1, "revise");
  assert.strictEqual(state.awaiting, "sales_proposal_revision");
  await handleSalesProposalRevisionText(env, state, "Add a second training session for the retail sales team.");

  const rec = proposals(world)[0].properties;
  assert.strictEqual(proposals(world).length, 1, "still one canonical record");
  assert.strictEqual(text(rec.Version), "v2");
  assert.strictEqual(text(rec["Approval Status"]), "Pending Approval");
  assert.strictEqual(text(rec["Approved Version"]), "", "Approved Version cleared for the unapproved v2");
  assert.strictEqual(text(rec["Artifact Status"]), "Held", "the previously released artifact work is held, not given v2");
  const v2Content = text(rec["Proposal Content"]);
  assert.match(v2Content, /Version: v2/);
  assert.match(v2Content, /Introduced in v2: Add a second training session for the retail sales team\./);
  assert.match(v2Content, /GHS 420,000/, "the Finance quote is untouched by a Sales revision");
  assert.strictEqual(state.salesProposal!.versions[0].content, v1Content, "approved v1 substance is kept unchanged");
  assert.strictEqual(world.blockAppends.length, 2, "v1 and v2 snapshots both kept in the page body");
  assert.ok(approvalRequests(world).at(-1)!.text.includes("Proposal: PROP-7 · Version: v2"));

  await handleSalesProposalDecision(env, state, 7, 2, "approve");
  assert.strictEqual(text(proposals(world)[0].properties["Approved Version"]), "v2");
  assert.strictEqual(text(proposals(world)[0].properties["Artifact Status"]), "Pending Identity Resolution");
});

test("14b. A revision that would introduce identity is refused -- no new Version", async (t) => {
  const { world, env, state } = await createV1(t);
  await handleSalesProposalDecision(env, state, 7, 1, "revise");
  await handleSalesProposalRevisionText(env, state, "Send it to jane.doe@client.com");
  assert.strictEqual(text(proposals(world)[0].properties.Version), "v1");
  assert.strictEqual(state.salesProposal?.currentVersion, 1);
});

// ---------------------------------------------------------------------------
// 17-20. No Sales->Sales Handoff; fail-closed conditions; no Drive file.
// ---------------------------------------------------------------------------

test("17. No Handoff of any kind (including Sales -> Sales) is created anywhere in the flow", async (t) => {
  const { world, env, state } = await createV1(t);
  await handleSalesProposalDecision(env, state, 7, 1, "approve");
  await handleSalesProposalDecision(env, state, 7, 1, "revise");
  await handleSalesProposalRevisionText(env, state, "Clarify the audit scope.");
  await handleSalesProposalDecision(env, state, 7, 2, "approve");
  assert.strictEqual(world.handoffCreates.length, 0);
  assert.ok(!world.fetches.some((f) => f.method === "POST" && f.body?.parent?.data_source_id === "handoffs-ds"));
});

test("18a. HO-64 that cannot be resolved fails closed", async (t) => {
  const world = installWorld(t);
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState({ handoffId: "missing-handoff" }));
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /could not be resolved/);
});

test("18b. A missing or ambiguous Finance quote fails closed and holds the Handoff", async (t) => {
  for (const facts of ["Rationale: something", "Authoritative quote: GHS 420000\nAuthoritative quote: GHS 400000\nRationale: x", "Authoritative quote: 420000\nRationale: no currency", "Authoritative quote: GHS 420000"]) {
    const world = installWorld(t, { ho64: ho64Props({ "Verified Facts & Sources": rt(facts) }) });
    const state = await handleProposalHandoffPickup(fakeEnv(), fakeState());
    assert.strictEqual(proposals(world).length, 0, facts);
    assert.match(state.blockedReason ?? "", /missing or ambiguous/, facts);
    assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Held", facts);
  }
});

test("18c. Missing token fields fail closed", async (t) => {
  const world = installWorld(t, { ho64: ho64Props({ Matter_Token: rt("") }) });
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState());
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Matter_Token/);
});

test("18d. Missing required Proposal facts fail closed and name exactly what is missing", async (t) => {
  const thin = approvedStrategyProposal({ deliverables: [] });
  thin.proposedIntervention = { ...thin.proposedIntervention, workstreams: [] };
  const { world, state } = await createV1(t, { strategyProposal: thin });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /required Proposal facts are missing: scope -- at least one workstream or deliverable/);
  assert.match(text(world.pages.get(HO64_ID)!.properties["Open Questions"]), /workstream or deliverable/);
});

test("18e. No Martin-approved Strategy proposal on the work item fails closed", async (t) => {
  const { world, state } = await createV1(t, { strategyApprovalState: "AWAITING_INTERVENTION_APPROVAL" });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Martin-approved Strategic Intervention Proposal/);
});

test("18f. A token mismatch between the work item and HO-64 fails closed", async (t) => {
  const { world, state } = await createV1(t, { matterToken: "MAT-21" });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /consistent Matter_Token/);
});

test("18g. A Proposal record without a Proposal ID fails closed -- it stays Draft and is never presented", async (t) => {
  const { world, state } = await createV1(t, {}, { stripProposalId: true });
  assert.match(state.blockedReason ?? "", /without a Proposal ID/);
  assert.strictEqual(proposals(world).length, 1);
  assert.strictEqual(text(proposals(world)[0].properties["Approval Status"]), "Draft", "never presented, never approvable");
  assert.strictEqual(approvalRequests(world).length, 0);
});

test("18g-2. A Proposal ID without a prefix is still bound by its number", async (t) => {
  const { state } = await createV1(t, {}, { proposalPrefix: null });
  assert.strictEqual(state.salesProposal?.proposalId, "7");
  assert.strictEqual(state.salesProposal?.proposalNumber, 7);
});

test("18h. A non-Finance Handoff is refused (never routed through this path)", async (t) => {
  const world = installWorld(t, { ho64: ho64Props({ "From Unit": { select: { name: "Sales" } }, "From Hat": rt("Sales Executive") }) });
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState());
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /not a Finance/);
});

test("19. Missing Telegram Conversation stream configuration fails closed -- nothing is written", async (t) => {
  const world = installWorld(t);
  const state = await handleProposalHandoffPickup(fakeEnv({ WORKSPACE_TOPIC_ID: undefined }), fakeState());
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Telegram Conversation \(Workspace\) stream is not configured/);
  assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Pending", "left Pending so it retries once configured");
});

test("20. Runtime creates no Drive file and never writes Artifact Action or Artifact Reference", async (t) => {
  const { world, env, state } = await createV1(t);
  await handleSalesProposalDecision(env, state, 7, 1, "approve");
  assert.ok(!world.fetches.some((f) => /googleapis|drive/i.test(f.url)));
  const rec = proposals(world)[0].properties;
  assert.strictEqual(rec["Artifact Action"], undefined);
  assert.strictEqual(rec["Artifact Reference"], undefined);
  assert.ok(world.telegram.at(-1)!.text.includes("has not created any client-facing artifact or file"));
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

test("parseFinanceQuote reads the live HO-64 text exactly", () => {
  const r = parseFinanceQuote(HO64_FACTS);
  assert.ok("quote" in r);
  assert.deepStrictEqual(r.quote, { price: 420000, currency: "GHS", rationale: FINANCE_RATIONALE });
});

test("extractInvestmentTolerance reads only the labeled planning range", () => {
  assert.deepStrictEqual(extractInvestmentTolerance(text(ho62Props()["Verified Facts & Sources"])), { low: 30000, high: 60000, currency: "GHS" });
  assert.deepStrictEqual(extractInvestmentTolerance("=== Investment tolerance (CONTEXT ONLY -- never the pricing basis) ===\nGHS 30000-60000"), { low: 30000, high: 60000, currency: "GHS" });
  assert.strictEqual(extractInvestmentTolerance("No range here. Turnover GHS 28M."), null);
});

test("buildProposalContent is deterministic", () => {
  const facts = {
    handoffId: HO64_ID,
    handoffRef: "HO-64",
    entityToken: "E-20",
    matterToken: "MAT-20",
    quote: { price: 420000, currency: "GHS", rationale: FINANCE_RATIONALE },
    strategyProposalVersion: 1,
    strategy: approvedStrategyProposal(),
  };
  const a = buildProposalContent(facts, { proposalId: "PROP-7", version: 1, amendments: [] });
  const b = buildProposalContent(facts, { proposalId: "PROP-7", version: 1, amendments: [] });
  assert.strictEqual(a, b);
});
