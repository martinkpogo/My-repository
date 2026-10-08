import test from "node:test";
import { NO_ACTION_SKILLS } from "../../platform/skillRegistry";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  handleProposalHandoffPickup,
  handleSalesProposalDecision,
  handleSalesProposalRevisionText,
  parseFinanceQuote,
  extractInvestmentTolerance,
  buildProposalContent,
  PROPOSAL_CALLBACK_ACTION,
  applyProposalDocComment,
} from "./tokenSafeProposal";
import type { Env, WorkState } from "../../types";
import type { StrategyProposal } from "../strategy/strategyAnalyst";
import { buildStrategyBoundaryRepresentation, serializeStrategyBoundaryRepresentation, STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END } from "../strategy/strategyAnalyst";
import { FINANCE_JUDGMENT_START, FINANCE_JUDGMENT_END, handleQuoteApproval } from "../finance/valueBasedPricingAssessor";

// ---------------------------------------------------------------------------
// Fixtures: the live MAT-20 slice (HO-64, E-20/MAT-20, GHS 420,000).
// ---------------------------------------------------------------------------

const HO64_ID = "handoff-ho-64";
const HO62_ID = "handoff-ho-62";
const FINANCE_RATIONALE =
  "The price is based on the value-at-stake, which is the company's annual turnover. The intervention is expected to contribute to increased sales growth and enhanced credibility with larger accounts, which can lead to improved financial performance. The price is set at approximately 1.5% of the annual turnover, which is a reasonable estimate of the value that the intervention can bring to the company.";
const HO64_FACTS = `Authoritative quote: GHS 420000\nRationale: ${FINANCE_RATIONALE}`;

/** The Strategy-authored boundary block, exactly as Strategy would write it onto the Strategy -> Finance Handoff. */
function strategyBlock(proposal: StrategyProposal): string {
  return serializeStrategyBoundaryRepresentation(buildStrategyBoundaryRepresentation(proposal));
}
/** Finance's own commercial-judgment block, exactly as handleQuoteApproval would write it. */
function financeBlock(factsText: string): string {
  return `${FINANCE_JUDGMENT_START}\n${factsText}\n${FINANCE_JUDGMENT_END}`;
}
/** The combined Finance -> Sales "Verified Facts & Sources" text -- both labeled sections, as handleQuoteApproval now produces it. */
function combinedHo64Facts(proposal: StrategyProposal = approvedStrategyProposal(), financeText: string = HO64_FACTS): string {
  return `${strategyBlock(proposal)}\n\n${financeBlock(financeText)}`;
}

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
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
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

/**
 * An honest attestation for a given (proposalId, proposalVersion), in the
 * shape presentStrategyProposalForApproval actually produces: the Sales
 * source-boundary fields its marker recorded, and a proposal-content check
 * that compared no field (the Runtime holds no contact identity -- an
 * Entity/Matter name is always its own token).
 */
function validAttestation(proposalId: string, proposalVersion: number): WorkState["strategyProposalTokenSafety"] {
  return {
    proposalId,
    proposalVersion,
    sourceBoundary: { checked: true, identityFieldsChecked: ["entityName", "matterName"] },
    proposalContent: { checked: true, identityFieldsChecked: [] },
  };
}

function fakeState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "11111111-2222-3333-4444-555555555555",
    chatId: 9999,
    // This Work must mirror what checkHandoffs.ts's init() actually produces
    // for an externally-created Finance -> Sales Handoff: the RECEIVING
    // Unit/Hat, not the sending one. It is Sales Executive that produces the
    // canonical Proposal from this Handoff; Finance is the Unit whose quote it
    // is built from. Modelling the Work as a Finance work item described the
    // wrong party and could not resolve an Action, so every governed read in
    // this path failed closed.
    unit: "Sales",
    hat: "Sales Executive",
    // Access resolves authority from the Work's own record, so a Work with no
    // recorded Action cannot read even the Handoff it was picked up from --
    // correctly, since "no Action" is not "no gate". Production records this
    // at init; a fixture that omits it tests nothing but the refusal.
    actionName: "proposal_draft",
    stage: "quote_approved",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: HO64_ID,
    entityToken: "E-20",
    matterToken: "MAT-20",
    strategyApprovalState: "APPROVED",
    strategyProposal: approvedStrategyProposal(),
    // Test fixture only: no production code sets this today (see
    // verifyStrategyProposalTokenSafety). Tests of the gate itself remove it.
    strategyProposalTokenSafety: validAttestation("strategy-prop-1", 1),
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
  /** Child pages created under a Proposal record: one per version (createVersionPage). */
  versionPages: { id: string; parentId: string; title: string; children: any[]; url: string }[];
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
    "Verified Facts & Sources": rt(combinedHo64Facts()),
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
  if (filter.unique_id?.equals !== undefined) return p?.unique_id?.number === filter.unique_id.equals;
  return false;
}

function installWorld(t: any, opts: { ho64?: Props; withHo62?: boolean; proposalPrefix?: string | null; stripProposalId?: boolean } = {}): World {
  const world: World = { pages: new Map(), fetches: [], telegram: [], blockAppends: [], versionPages: [], logs: [], handoffCreates: [], nextProposalNumber: 7 };
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
    if (u.endsWith("/pages") && method === "POST" && body.parent?.type === "page_id") {
      const id = `version-page-${world.versionPages.length + 1}`;
      const page = {
        id,
        parentId: body.parent.page_id,
        title: body.properties?.title?.title?.[0]?.text?.content ?? "",
        children: body.children ?? [],
        url: `https://notion.so/${id}`,
      };
      world.versionPages.push(page);
      return json({ id, url: page.url });
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
    if (init?.method === "GET" && url.includes("/v1/pages/") && /^[0-9a-f-]{32,36}$/i.test(url.split("/v1/pages/").pop()!.split("?")[0])) {
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
  const state = await handleProposalHandoffPickup(env, fakeState(stateOverrides), NO_ACTION_SKILLS);
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

test("1b. A Handoff picked up with no continuing WorkSession (only handoffId in state, as checkHandoffs.ts's init() produces for an externally-created Handoff) still produces a Proposal -- LOG-874 regression: entityName/matterName in state are never required", async (t) => {
  const world = installWorld(t);
  const env = fakeEnv();
  const freshState: WorkState = {
    workId: "11111111-2222-3333-4444-555555555555",
    chatId: 9999,
    unit: "Sales",
    hat: "Sales Executive",
    // checkHandoffs.ts's init() passes actionName "proposal_draft" for exactly
    // this case. It is what makes the Work resolvable to a registered Action,
    // so it belongs in a fixture that claims to model init()'s output -- its
    // absence here tested the refusal path, not the LOG-874 regression.
    actionName: "proposal_draft",
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: HO64_ID,
  };
  assert.strictEqual((freshState as any).entityName, undefined);
  assert.strictEqual((freshState as any).matterName, undefined);

  const state = await handleProposalHandoffPickup(env, freshState, NO_ACTION_SKILLS);

  assert.strictEqual(proposals(world).length, 1, "pickup must succeed and produce the canonical Proposal without any continuing-session identity");
  assert.strictEqual(state.salesProposal?.proposalId, "PROP-7");
  assert.strictEqual(state.blockedReason, undefined);
});

test("2. Reprocessing HO-64 is idempotent -- no second record, no new Version, same content", async (t) => {
  const { world, env, state } = await createV1(t);
  const contentBefore = text(proposals(world)[0].properties["Proposal Content"]);

  // Same WorkSession reprocesses (e.g. HO-64 set back to Pending by hand).
  world.pages.get(HO64_ID)!.properties.Status = { select: { name: "Pending" } };
  const again = await handleProposalHandoffPickup(env, state, NO_ACTION_SKILLS);
  // A fresh WorkSession with no memory of the Proposal also reprocesses.
  const fresh = await handleProposalHandoffPickup(env, fakeState(), NO_ACTION_SKILLS);

  assert.strictEqual(proposals(world).length, 1, "reprocessing must never create a duplicate Proposal");
  const rec = proposals(world)[0];
  assert.strictEqual(text(rec.properties.Version), "v1");
  assert.strictEqual(text(rec.properties["Proposal Content"]), contentBefore);
  assert.strictEqual(again.salesProposal?.currentVersion, 1);
  assert.strictEqual(fresh.salesProposal?.proposalId, "PROP-7");
  assert.strictEqual(world.versionPages.length, 1, "no additional version page on reprocess");
  assert.strictEqual(approvalRequests(world).length, 3, "reprocessing re-presents the same pending Version");
  assert.ok(approvalRequests(world).every((m) => m.text.includes("Proposal: PROP-7 · Version: v1")));
});

test("2b. A Proposal for the same Matter not linked to HO-64 is ambiguous -- fails closed, no new record", async (t) => {
  const world = installWorld(t);
  world.pages.set("stray", { id: "stray", url: "u", parent: "proposals-ds", properties: { "Matter Token": rt("MAT-20"), Handoff: { relation: [] } } });
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState(), NO_ACTION_SKILLS);
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
  const { world, state } = await createV1(t, { entityName: "Acme Foods Ghana Ltd" }, { ho64: ho64Props({ "Verified Facts & Sources": rt(combinedHo64Facts(leaked)) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /identity-bearing value/);
  assert.ok(!world.telegram.some((m) => m.text.includes("Acme Foods")), "the identity itself is never echoed to Telegram");
  assert.ok(!world.logs.some((l) => JSON.stringify(l).includes("Acme Foods")), "nor into the Activity Log");
});

test("4b. Contact details (email / phone) cannot enter the Runtime Proposal even when no name is known", async (t) => {
  const leaked = approvedStrategyProposal();
  leaked.executiveSummary = { ...leaked.executiveSummary, strategicProblem: "Contact ceo@example.com or +233 24 123 4567" };
  const { world, state } = await createV1(t, {}, { ho64: ho64Props({ "Verified Facts & Sources": rt(combinedHo64Facts(leaked)) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /identity-bearing value/);
});

test("16. On approval, Runtime resolves Entity_Token/Matter_Token to their real page IDs and advances the Matter to Proposal status -- no Drive/Gmail access, no identity read outside Entity/Matters", async (t) => {
  const { world, env, state } = await createV1(t);
  const entityPage = { id: "entity-page-20", url: "https://notion.so/entity-page-20", parent: "entity-ds", properties: { Entity_ID: { unique_id: { prefix: "E", number: 20 } } } };
  world.pages.set(entityPage.id, entityPage);
  world.pages.set("matter-page-20", {
    id: "matter-page-20",
    url: "https://notion.so/matter-page-20",
    parent: "matters-ds",
    properties: { Matter_ID: { unique_id: { prefix: "MAT", number: 20 } }, Entity: { relation: [{ id: entityPage.id }] } },
  });

  const ready = await handleSalesProposalDecision(env, state, 7, 1, "approve");

  assert.strictEqual(ready.salesProposal?.approvalStatus, "Approved");
  assert.strictEqual(text(world.pages.get("matter-page-20")!.properties.Status), "Proposal", "the Matter's operational Status must advance on approval");
  for (const f of world.fetches) {
    assert.ok(!/googleapis|gmail|drive/i.test(f.url), `no Google access: ${f.url}`);
    assert.ok(!f.url.includes("/search"), `no Notion search: ${f.url}`);
  }
  const pageReads = world.fetches.filter((f) => f.method === "GET" && f.url.includes("/pages/")).map((f) => f.url.split("/pages/")[1]);
  // The Matter is in this list because updatePage resolves a page's target from
  // its real parent before dispatching, so a governed write is necessarily
  // preceded by a read of the page being written. Naming it explicitly keeps
  // the assertion honest: only the Handoff, the Proposal, and the two pages the
  // tokens actually resolved to are readable -- a read of any other Entity or
  // Matter still fails here, which is what "no identity read outside
  // Entity/Matters" is guarding.
  assert.ok(
    pageReads.every((id) => id === HO64_ID || id.startsWith("proposals-ds") || id === entityPage.id || id === "matter-page-20"),
    `only the Handoff, the Proposal, and the resolved Entity/Matter pages are read: ${pageReads}`,
  );
});

test("16b. On approval, an Entity_Token/Matter_Token that doesn't resolve fails to advance the Matter status without undoing the approval", async (t) => {
  const { world, env, state } = await createV1(t);
  // No Matter/Entity pages seeded -- tokens do not resolve.
  const ready = await handleSalesProposalDecision(env, state, 7, 1, "approve");

  assert.strictEqual(ready.salesProposal?.approvalStatus, "Approved", "Martin's approval itself still applies even when the Matter status can't be advanced");
  assert.ok(world.telegram.some((m) => /Matter status NOT advanced/.test(m.text)), "Martin must be told the Matter status wasn't advanced");
});

test("Sales does not require state.strategyProposal for Proposal production -- the Finance -> Sales Handoff alone is the Strategy-facts source", async (t) => {
  // No state.strategyProposal at all on this work item (e.g. a fresh
  // Durable Object created for an externally-discovered Handoff, per
  // checkHandoffs.ts's own fallback path) -- production per this routing
  // change no longer needs it for Proposal production. Note
  // verifyStrategyProposalTokenSafety (left untouched by this change, see
  // its own doc comment) returns null when state.strategyProposal is
  // absent -- "nothing to verify" -- so this specific gate does not itself
  // block this path; resolveFacts's own Handoff-sourced parsing is what
  // actually supplies the Strategy facts here.
  const { world, state } = await createV1(t, { strategyProposal: undefined, strategyProposalTokenSafety: undefined, strategyApprovalState: undefined });
  assert.strictEqual(proposals(world).length, 1, "a Proposal is still produced, sourced entirely from the Handoff");
  assert.strictEqual(state.salesProposal?.facts?.strategyProposalId, "strategy-prop-1");
  assert.strictEqual(state.salesProposal?.facts?.strategyProposalVersion, 1);
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
    "PROPOSAL IDENTIFICATION",
    "EXECUTIVE SUMMARY / CONTEXT",
    "STRATEGIC PROBLEM / OPPORTUNITY",
    "DIAGNOSIS",
    "OBJECTIVE",
    "RECOMMENDED INTERVENTION",
    "SCOPE AND DELIVERABLES",
    "APPROACH / METHOD",
    "EXPECTED OUTCOMES",
    "TIMELINE",
    "BASIS FOR THE INVESTMENT",
    "INVESTMENT",
    "COMMERCIAL TERMS",
    "WHAT ENIG NEEDS FROM THE CLIENT",
    "ASSUMPTIONS, DEPENDENCIES, RISKS AND EXCLUSIONS",
    "NEXT STEPS",
  ]) {
    assert.match(stored, new RegExp(`\\n\\d+\\. ${heading.replace(/[/()]/g, "\\$&")}\\n`), `missing section: ${heading}`);
  }
  assert.ok(stored.includes("Unified Company Image and Messaging Framework"), "workstreams are carried in full");
  assert.ok(rec["Proposal Content"].rich_text.length > 1, "long content is split across rich-text items, not truncated");
  assert.strictEqual(world.versionPages.length, 1);
  const snapshot = world.versionPages[0].children.map((b: any) => b.paragraph.rich_text[0].text.content).join("");
  assert.strictEqual(snapshot, stored, "a v1 child page holds exactly the stored content");
});

test("6. The Finance quote remains exactly GHS 420,000", async (t) => {
  const { world, state } = await createV1(t);
  const rec = proposals(world)[0].properties;
  assert.strictEqual(rec["Quoted Price"].number, 420000);
  assert.match(text(rec["Quote Rationale"]), /^Currency: GHS\./);
  const content = text(rec["Proposal Content"]);
  assert.match(content, /\nInvestment: GHS 420,000\n/);
  assert.strictEqual(state.salesProposal!.facts!.quote.price, 420000);
  assert.strictEqual(state.salesProposal!.facts!.quote.currency, "GHS");
});

function section(content: string, heading: string): string {
  const m = content.match(new RegExp(`\\n\\d+\\. ${heading}\\n([\\s\\S]*?)(?=\\n\\n\\d+\\. |$)`));
  return m ? m[1] : "";
}

test("7. The Finance rationale is preserved verbatim, with no added financial justification", async (t) => {
  const { world } = await createV1(t);
  const rec = proposals(world)[0].properties;
  const content = text(rec["Proposal Content"]);
  assert.ok(text(rec["Quote Rationale"]).endsWith(FINANCE_RATIONALE));
  assert.strictEqual(section(content, "BASIS FOR THE INVESTMENT"), FINANCE_RATIONALE, "the basis section is exactly the Finance rationale");
});

test("8. The GHS 30,000–60,000 planning range is kept out of Proposal Content, shown to Martin as internal review material, and never replaces GHS 420,000", async (t) => {
  const { world } = await createV1(t);
  const rec = proposals(world)[0].properties;
  const content = text(rec["Proposal Content"]);
  assert.strictEqual(rec["Quoted Price"].number, 420000);
  assert.ok(!content.includes("30,000") && !content.includes("60,000"), "the planning range is not in Proposal Content");
  assert.strictEqual(section(content, "INVESTMENT"), "Investment: GHS 420,000");
  const review = world.telegram.map((m) => m.text).join("").split("INTERNAL REVIEW MATERIAL")[1];
  assert.ok(review, "the approval request carries a labelled internal review section");
  assert.match(review, /Client-disclosed planning range \(client-disclosed, recorded on HO-62\): GHS 30,000–60,000/);
  assert.match(review, /does not replace or alter the Finance quote/);
});

test("8b. Proposal Content holds commercial substance only; the approved hash covers exactly that content", async (t) => {
  const { world, state } = await createV1(t);
  const content = text(proposals(world)[0].properties["Proposal Content"]);
  for (const internal of [
    "30,000",
    "60,000",
    "INTERNAL",
    "review material",
    "Payment terms",
    "Quote validity",
    "validity",
    "issue date",
    "Martin",
    "Source Handoff",
    "HO-64",
    "HO-62",
    "Approved Strategy proposal",
    "strategy-prop-1",
    "Identity & Artifact",
    "approval",
    "not altered",
    "Not specified",
    "established upstream",
    "Approved Finance pricing rationale",
  ]) {
    assert.ok(!content.toLowerCase().includes(internal.toLowerCase()), `internal material in Proposal Content: ${internal}`);
  }
  const v1 = state.salesProposal!.versions[0];
  assert.strictEqual(v1.content, content);
  assert.strictEqual(v1.contentHash, createHash("sha256").update(content).digest("hex"), "hash is of Proposal Content only");
  const snapshot = world.versionPages[0].children.map((b: any) => b.paragraph.rich_text[0].text.content).join("");
  assert.strictEqual(snapshot, content, "the version page holds no review material either");
});

test("8c. The review material stays available to Martin: open items, sources and the rationale conflict", async (t) => {
  const { world } = await createV1(t);
  const msg = world.telegram.map((m) => m.text).join("");
  const [proposalPart, review] = msg.split("=== INTERNAL REVIEW MATERIAL");
  assert.match(proposalPart, /=== PROPOSAL PROP-7 v1 \(the content being approved\) ===/);
  assert.match(review, /not part of the Proposal, not stored in Proposal Content, not approved with it/);
  assert.match(review, /Open items \(not stated upstream, not in the Proposal\): payment terms; quote validity period; issue date\./);
  assert.match(review, /Source: Handoff HO-64 \(Finance → Sales\); approved Strategy proposal strategy-prop-1 v1\./);
  assert.match(review, /conflict is unresolved/);
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
    [`${PROPOSAL_CALLBACK_ACTION}:${state.workId}:7.1.a`, `${PROPOSAL_CALLBACK_ACTION}:${state.workId}:7.1.r`, `${PROPOSAL_CALLBACK_ACTION}:${state.workId}:7.1.g`],
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
  assert.match(section(v2Content, "AMENDMENTS"), /^- Add a second training session for the retail sales team\.$/);
  assert.ok(!v2Content.includes("Introduced in"), "amendment provenance is review material, not Proposal Content");
  assert.match(approvalRequests(world).at(-1)!.text + world.telegram.at(-1)!.text, /Amendment introduced in v2 at Martin's direction\./);
  assert.match(v2Content, /GHS 420,000/, "the Finance quote is untouched by a Sales revision");
  assert.strictEqual(state.salesProposal!.versions[0].content, v1Content, "approved v1 substance is kept unchanged");
  assert.strictEqual(world.versionPages.length, 2, "v1 and v2 each keep their own child page");
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
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState({ handoffId: "missing-handoff" }), NO_ACTION_SKILLS);
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /could not be resolved/);
});

test("18b. A missing or ambiguous Finance quote fails closed and holds the Handoff", async (t) => {
  for (const facts of ["Rationale: something", "Authoritative quote: GHS 420000\nAuthoritative quote: GHS 400000\nRationale: x", "Authoritative quote: 420000\nRationale: no currency", "Authoritative quote: GHS 420000"]) {
    const world = installWorld(t, { ho64: ho64Props({ "Verified Facts & Sources": rt(facts) }) });
    const state = await handleProposalHandoffPickup(fakeEnv(), fakeState(), NO_ACTION_SKILLS);
    assert.strictEqual(proposals(world).length, 0, facts);
    assert.match(state.blockedReason ?? "", /missing or ambiguous/, facts);
    assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Held", facts);
  }
});

test("18c. Missing token fields fail closed", async (t) => {
  const world = installWorld(t, { ho64: ho64Props({ Matter_Token: rt("") }) });
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState(), NO_ACTION_SKILLS);
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Matter_Token/);
});

test("18d. Missing required Proposal facts fail closed and name exactly what is missing", async (t) => {
  const thin = approvedStrategyProposal({ deliverables: [] });
  thin.proposedIntervention = { ...thin.proposedIntervention, workstreams: [] };
  const { world, state } = await createV1(t, {}, { ho64: ho64Props({ "Verified Facts & Sources": rt(combinedHo64Facts(thin)) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /required Proposal facts are missing:.*scope -- at least one workstream or deliverable/);
  assert.match(text(world.pages.get(HO64_ID)!.properties["Open Questions"]), /workstream or deliverable/);
});

test("18e. A Finance -> Sales Handoff with no Strategy boundary representation fails closed (missing Strategy section)", async (t) => {
  const { world, state } = await createV1(t, {}, { ho64: ho64Props({ "Verified Facts & Sources": rt(financeBlock(HO64_FACTS)) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Strategy boundary representation.*missing START\/END markers/);
});

test("18e-2. A Strategy boundary block that is not valid JSON fails closed (malformed Strategy section)", async (t) => {
  const malformed = `${STRATEGY_BOUNDARY_START}\nnot json at all {{{\n${STRATEGY_BOUNDARY_END}\n\n${financeBlock(HO64_FACTS)}`;
  const { world, state } = await createV1(t, {}, { ho64: ho64Props({ "Verified Facts & Sources": rt(malformed) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Strategy boundary representation.*not valid JSON/);
});

test("18e-3. A Strategy boundary block missing proposalId/proposalVersion fails closed", async (t) => {
  const rep = buildStrategyBoundaryRepresentation(approvedStrategyProposal());
  const { proposalId, ...withoutId } = rep as any;
  const noId = `${STRATEGY_BOUNDARY_START}\n${JSON.stringify(withoutId)}\n${STRATEGY_BOUNDARY_END}\n\n${financeBlock(HO64_FACTS)}`;
  const { world, state } = await createV1(t, {}, { ho64: ho64Props({ "Verified Facts & Sources": rt(noId) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Strategy boundary representation has no proposalId/);
});

test("18e-4. A Finance -> Sales Handoff with no Finance commercial judgment block fails closed (missing Finance judgment)", async (t) => {
  const { world, state } = await createV1(t, {}, { ho64: ho64Props({ "Verified Facts & Sources": rt(strategyBlock(approvedStrategyProposal())) }) });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /Finance commercial judgment block.*missing START\/END markers/);
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
  const state = await handleProposalHandoffPickup(fakeEnv(), fakeState(), NO_ACTION_SKILLS);
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /not a Finance/);
});

test("19. Missing Telegram Conversation stream configuration fails closed -- nothing is written", async (t) => {
  const world = installWorld(t);
  const state = await handleProposalHandoffPickup(fakeEnv({ WORKSPACE_TOPIC_ID: undefined }), fakeState(), NO_ACTION_SKILLS);
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
    strategyProposalId: "strategy-prop-1",
    strategyProposalVersion: 1,
    strategy: approvedStrategyProposal(),
  };
  const a = buildProposalContent(facts, { proposalId: "PROP-7", version: 1, amendments: [] });
  const b = buildProposalContent(facts, { proposalId: "PROP-7", version: 1, amendments: [] });
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// Strategy Proposal identity boundary.
// ---------------------------------------------------------------------------

test("S1. Without a token-safety attestation for the approved Strategy Proposal (the production state today), nothing is produced", async (t) => {
  const { world, state } = await createV1(t, { strategyProposalTokenSafety: undefined });
  assert.strictEqual(proposals(world).length, 0, "no Proposal record");
  assert.strictEqual(approvalRequests(world).length, 0, "nothing presented for approval");
  assert.match(state.blockedReason ?? "", /Strategy Proposal identity boundary: .*strategy-prop-1 v1.*no token-safety attestation on record/);
  assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Held", "HO-64 is held with the reason, not left to retry every cycle");
  assert.match(text(world.pages.get(HO64_ID)!.properties["Open Questions"]), /token-safety attestation/);
  assert.ok(!world.fetches.some((f) => f.url.endsWith("/pages") && f.body?.parent?.data_source_id === "proposals-ds"));
});

test("S2. An attestation for a different Strategy Proposal version does not count", async (t) => {
  const { world, state } = await createV1(t, {
    strategyProposalTokenSafety: validAttestation("strategy-prop-1", 2),
  });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /is for Strategy proposal strategy-prop-1 v2, not the approved strategy-prop-1 v1/);
});

test("S3. The gate is not a text heuristic: a clean-looking but unverified Strategy Proposal is still refused", async (t) => {
  const { world, state } = await createV1(t, { strategyProposalTokenSafety: undefined, entityName: undefined, matterName: undefined });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /no token-safety attestation on record/);
});

test("S5. A legacy {proposalId, proposalVersion, basis} attestation (no sourceBoundary/proposalContent) cannot pass verification", async (t) => {
  const legacy = { proposalId: "strategy-prop-1", proposalVersion: 1, basis: "approved by Martin" } as any;
  const { world, state } = await createV1(t, { strategyProposalTokenSafety: legacy });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /does not confirm the Sales source-boundary identity check/);
});

test("S6. An attestation whose sourceBoundary check is not recorded as having run fails verification", async (t) => {
  const incomplete = {
    proposalId: "strategy-prop-1",
    proposalVersion: 1,
    sourceBoundary: { checked: false, identityFieldsChecked: ["entityName", "matterName"] },
    proposalContent: { checked: true, identityFieldsChecked: [] },
  } as any;
  const { world, state } = await createV1(t, { strategyProposalTokenSafety: incomplete });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /does not confirm the Sales source-boundary identity check ran and passed/);
});

test("S7. An attestation with no proposalContent check fails verification", async (t) => {
  const incomplete = {
    proposalId: "strategy-prop-1",
    proposalVersion: 1,
    sourceBoundary: { checked: true, identityFieldsChecked: ["entityName", "matterName"] },
  } as any;
  const { world, state } = await createV1(t, { strategyProposalTokenSafety: incomplete });
  assert.strictEqual(proposals(world).length, 0);
  assert.match(state.blockedReason ?? "", /does not confirm the complete Strategy Proposal was independently checked/);
});

test("S8. The attestation Strategy really produces for a Handoff-originated proposal passes -- a source-boundary marker naming entityName,contactName and a proposal check that compared no field (MAT-26, HO-86 -> HO-87)", async (t) => {
  const asProduced: WorkState["strategyProposalTokenSafety"] = {
    proposalId: "strategy-prop-1",
    proposalVersion: 1,
    sourceBoundary: { checked: true, identityFieldsChecked: ["entityName", "contactName"] },
    proposalContent: { checked: true, identityFieldsChecked: [] },
  };
  const { world, state } = await createV1(t, { strategyProposalTokenSafety: asProduced });
  assert.strictEqual(state.blockedReason, undefined);
  assert.strictEqual(proposals(world).length, 1, "the Proposal is produced");
});

test("S4. Reprocessing an existing Proposal without verification does not re-hydrate Strategy facts, so no new Version can be built from them", async (t) => {
  const { world, env } = await createV1(t);
  const fresh = await handleProposalHandoffPickup(env, fakeState({ strategyProposalTokenSafety: undefined }), NO_ACTION_SKILLS);
  assert.strictEqual(proposals(world).length, 1);
  assert.strictEqual(fresh.salesProposal?.facts, undefined);
  await handleSalesProposalDecision(env, fresh, 7, 1, "revise");
  await handleSalesProposalRevisionText(env, fresh, "Clarify the audit scope.");
  assert.strictEqual(text(proposals(world)[0].properties.Version), "v1", "no new Version without verified facts");
  assert.match(fresh.blockedReason ?? "", /upstream facts .* not available/);
});

// ---------------------------------------------------------------------------
// Integration (SYNTHETIC, continuous): Finance → Sales quote Handoff round-trip
// ---------------------------------------------------------------------------
//
// Runs the REAL Finance quote-approval writer and then the REAL Sales pickup in
// one process, with the persisted Handoff as the only thing crossing between
// them: Phase 1 writes the Finance → Sales Handoff through handleQuoteApproval
// (in-memory Notion fake), Phase 2 builds a FRESH Sales Work that knows only
// that Handoff's id -- no Finance state, no identity-bearing context -- and
// runs handleProposalHandoffPickup on it. Nothing is passed from Finance's
// in-memory state into Sales: the Handoff record is the Unit boundary.
//
// SYNTHETIC, not the real live quote case: Notion, Telegram and the Work states
// are fakes and no real quote request was run end to end. It establishes that
// the two halves compose against the same persisted record; it does not
// establish that the deployed Worker completes a real quote. That still
// requires one real quote request through a real Handoff, with its result
// logged.

test("Ifx. Integration: a real Finance quote approval writes the Handoff a fresh Sales Work consumes into a token-safe Proposal", async (t) => {
  const world = installWorld(t);

  // --- Phase 0: the Strategy -> Finance Handoff, as Strategy would write it ---
  const SRC = "handoff-strategy-src";
  world.pages.set(SRC, {
    id: SRC,
    url: `https://notion.so/${SRC}`,
    parent: "handoffs-ds",
    properties: {
      "Handoff ID": { unique_id: { prefix: "HO", number: 63 } },
      Handoff: { title: [{ plain_text: "Quote request — MAT-20" }] },
      "From Unit": { select: { name: "Strategy" } },
      "From Hat": rt("Strategy Analyst"),
      "To Unit": { select: { name: "Finance" } },
      "To Hat": rt("Value-Based Pricing Assessor"),
      Type: { select: { name: "Work" } },
      Status: { select: { name: "Pending" } },
      Entity_Token: rt("E-20"),
      Matter_Token: rt("MAT-20"),
      "Verified Facts & Sources": rt(`${strategyBlock(approvedStrategyProposal())}\n\nProposed intervention: Diagnostic. Value context: GHS 8M-12M opportunity.`),
    },
  });

  // --- Phase 1: Finance's REAL quote approval ---
  const env = fakeEnv();
  const rationale = "Priced from the documented value at stake and the approved commercial scope for the engagement.";
  const financeState: WorkState = {
    workId: "11111111-2222-3333-4444-55555555aaaa",
    chatId: 9999,
    unit: "Finance",
    hat: "Value-Based Pricing Assessor",
    actionName: "price",
    stage: "awaiting_quote_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: SRC,
    entityToken: "E-20",
    matterToken: "MAT-20",
    quote: { price: 420000, currency: "GHS", rationale },
  };

  // Take the id back from the PERSISTED record, not from Finance's state: the
  // world is seeded with HO64, which is itself a Finance -> Sales Handoff, so
  // matching on From/To alone silently picks the fixture and makes Phase 2
  // consume the seeded block instead of the real writer's output. Diffing the
  // page ids is what guarantees Phase 1's write is the one under test.
  const idsBeforeApproval = new Set(world.pages.keys());
  await handleQuoteApproval(env, financeState, true);
  assert.strictEqual(financeState.stage, "quote_approved", "Finance must approve the quote");

  const fsHandoff = [...world.pages.values()].find(
    (p) => !idsBeforeApproval.has(p.id) && p.parent === "handoffs-ds",
  );
  assert.ok(fsHandoff, "handleQuoteApproval must have persisted a Finance -> Sales Handoff");
  assert.strictEqual(text(fsHandoff!.properties["From Unit"]), "Finance");
  assert.strictEqual(text(fsHandoff!.properties["To Unit"]), "Sales");

  const writtenFacts = text(fsHandoff!.properties["Verified Facts & Sources"]);
  assert.match(writtenFacts, /=== FINANCE COMMERCIAL JUDGMENT ===/, "the real writer must have written the Finance markers");
  assert.ok(writtenFacts.includes(strategyBlock(approvedStrategyProposal())), "the Strategy boundary block must be carried forward verbatim");

  // --- Phase 2: a FRESH Sales Work -- Handoff id only, no Finance state ---
  const freshSales: WorkState = {
    workId: "99999999-8888-7777-6666-55555555bbbb",
    chatId: 9999,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "proposal_draft",
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffId: fsHandoff!.id,
  };
  assert.strictEqual((freshSales as any).entityToken, undefined, "the fresh Work carries no Finance identity");

  const salesState = await handleProposalHandoffPickup(env, freshSales, NO_ACTION_SKILLS);
  assert.ok(!salesState.blockedReason, `pickup must succeed: ${salesState.blockedReason}`);
  assert.strictEqual(salesState.salesProposal?.entityToken, "E-20", "entityToken taken from the Handoff");
  assert.strictEqual(salesState.salesProposal?.matterToken, "MAT-20", "matterToken taken from the Handoff");

  // Exactly one Proposal, linked to the originating Handoff, token-only identity
  const recs = proposals(world);
  assert.strictEqual(recs.length, 1, "exactly one canonical Proposal");
  const rec = recs[0].properties;
  assert.deepStrictEqual(rec.Handoff.relation, [{ id: fsHandoff!.id }], "linked to the originating Handoff");
  assert.strictEqual(text(rec["Entity Token"]), "E-20");
  assert.strictEqual(text(rec["Matter Token"]), "MAT-20");
  assert.strictEqual(rec.Entity, undefined, "no identity-bearing Entity relation");
  assert.strictEqual(rec.Matter, undefined, "no identity-bearing Matter relation");

  // Quote, rationale and tokens unchanged
  const content = text(rec["Proposal Content"]);
  assert.strictEqual(rec["Quoted Price"].number, 420000, "currency and amount exactly as Finance quoted");
  assert.match(text(rec["Quote Rationale"]), /^Currency: GHS\./, "currency exactly as Finance quoted");
  assert.match(text(rec["Quote Rationale"]), /value at stake/);
  assert.match(section(content, "COMMERCIAL TERMS"), /Currency: GHS/, "currency carried into the Proposal content");
  assert.match(content, /Entity_Token: E-20/);
  assert.match(content, /Matter_Token: MAT-20/);
  assert.match(content, /\nInvestment: GHS 420,000\n/, "Investment section carries the exact amount");
  assert.strictEqual(section(content, "BASIS FOR THE INVESTMENT"), rationale, "rationale verbatim, no added justification");

  // Draft / Pending Approval -- not approved, no client artifact, no real identity
  assert.strictEqual(text(rec["Approval Status"]), "Pending Approval", "presented for approval, never auto-approved");
  assert.ok(!world.fetches.some((f) => /googleapis|drive|gmail/i.test(f.url)), "no client artifact is created");
  assert.ok(!/Acme|@client\.com|Acme Foods/i.test(JSON.stringify(rec)), "no real identity in the Proposal record");

  // The Handoff is consumed
  assert.strictEqual(text(world.pages.get(fsHandoff!.id)!.properties.Status), "Closed");

  // Idempotent on reprocessing: still one Proposal, byte-identical content
  const again = await handleProposalHandoffPickup(env, { ...freshSales }, NO_ACTION_SKILLS);
  assert.ok(!again.blockedReason, `reprocessing must stay clean: ${again.blockedReason}`);
  assert.strictEqual(proposals(world).length, 1, "reprocessing must never create a second Proposal");
  assert.strictEqual(text(proposals(world)[0].properties["Proposal Content"]), content, "content unchanged on reprocess");
});

// ---------------------------------------------------------------------------
// Fail-closed at the integration level: a MARKED but malformed Finance block.
//
// Not redundant with 18b: its four fixtures are all unmarked, so every one of
// them fails at the marker check and the assertion /missing or ambiguous/ only
// matches the call-site prefix -- the ambiguity, currency and rationale
// branches are never reached. Not redundant with the parser-level cases in
// valueBasedPricingAssessor.test.ts either: those assert on the parser's return
// value, not on the pickup's refusal plus the Handoff being held. This asserts
// the SPECIFIC reason, which is what proves the intended branch was reached.
//
// Missing tokens (18c), malformed Strategy blocks (18e-2, 18e-3), an absent
// Finance block (18e-4), an unreadable Handoff (18a) and a wrong route/type
// are already adequately covered, so no cases are added for them here.
// ---------------------------------------------------------------------------

test("Ifc. Integration: a marked but malformed Finance block fails closed on its own branch and holds the Handoff", async (t) => {
  const cases: { inner: string; reason: RegExp }[] = [
    {
      inner: "Authoritative quote: GHS 420000\nAuthoritative quote: GHS 400000\nRationale: x",
      reason: /more than one 'Authoritative quote:' line/,
    },
    {
      inner: "Authoritative quote: 420000\nRationale: no currency stated",
      reason: /the Finance quote currency/,
    },
    {
      inner: "Authoritative quote: GHS 420000",
      reason: /the Finance pricing rationale/,
    },
  ];

  for (const { inner, reason } of cases) {
    const facts = `${strategyBlock(approvedStrategyProposal())}\n\n${financeBlock(inner)}`;
    const world = installWorld(t, { ho64: ho64Props({ "Verified Facts & Sources": rt(facts) }) });
    const state = await handleProposalHandoffPickup(fakeEnv(), fakeState(), NO_ACTION_SKILLS);

    assert.strictEqual(proposals(world).length, 0, inner);
    assert.match(state.blockedReason ?? "", /missing or ambiguous/, inner);
    // The specific branch, not just the call-site prefix.
    assert.match(state.blockedReason ?? "", reason, inner);
    assert.strictEqual(text(world.pages.get(HO64_ID)!.properties.Status), "Held", inner);
  }
});



// ---------------------------------------------------------------------------
// Live work status (src/runtime/workStatus.ts) for the Finance -> Sales
// Proposal pickup: the real steps, ending on the outcome.
// ---------------------------------------------------------------------------

const salesStatus = (world: World) => world.telegram.filter((m) => m.text.startsWith("Hat: Sales Executive.\n\n🧭")).map((m) => m.text);

test("Status: a produced Proposal shows the pickup's real steps and ends on the version awaiting approval", async (t) => {
  const { world } = await createV1(t);
  const final = salesStatus(world).at(-1)!;
  let at = -1;
  for (const step of [
    "✓ Reading the Finance -> Sales Handoff",
    "✓ Checking the Handoff's tokens, context and Finance judgment block",
    "✓ Looking for an existing Proposal for this Handoff",
    "✓ Checking the Strategy Proposal's token-safety attestation",
    "✓ Resolving the Proposal facts from the approved Strategy Proposal and the Finance quote",
    "✓ Checking the composed Proposal is token-safe",
    "✓ Creating the Proposal record and writing v1 to Notion",
    "✅ PROP-7 v1 ready below -- awaiting your approval.",
  ]) {
    const next = final.indexOf(step);
    assert.ok(next > at, `"${step}" in order, in:\n${final}`);
    at = next;
  }
});

test("Status: a fail-closed Proposal marks the step it stopped on, ends on the block, and never echoes the identity", async (t) => {
  const leaked = approvedStrategyProposal();
  leaked.executiveSummary = { ...leaked.executiveSummary, businessSituation: "Acme Foods Ghana Ltd is pursuing larger accounts" };
  const { world } = await createV1(t, { entityName: "Acme Foods Ghana Ltd" }, { ho64: ho64Props({ "Verified Facts & Sources": rt(combinedHo64Facts(leaked)) }) });
  const final = salesStatus(world).at(-1)!;
  assert.match(final, /✗ Checking the composed Proposal is token-safe\n⛔ Blocked -- the reason is below\.$/);
  assert.ok(!final.includes("Acme"));
});

// ---------------------------------------------------------------------------
// Version pages: every version is its own readable child page; the Proposals
// row links the current one and, once approved, exactly the approved one.
// "Proposal Content" stays the hashed source of truth.
// ---------------------------------------------------------------------------

test("Version pages 1. v1 is a child page of the Proposal record, and the record's Current Version Link and the approval request point at it", async (t) => {
  const { world, state } = await createV1(t);
  const rec = proposals(world)[0];

  assert.strictEqual(world.versionPages.length, 1);
  const page = world.versionPages[0];
  assert.strictEqual(page.parentId, rec.id, "a child of the Proposal record's page");
  assert.strictEqual(page.title, "PROP-7 v1");
  assert.strictEqual(rec.properties["Current Version Link"].url, page.url);
  assert.strictEqual(rec.properties["Approved Version Link"], undefined, "nothing is approved yet");
  assert.strictEqual(state.salesProposal!.versions[0].pageUrl, page.url);
  assert.ok(approvalRequests(world)[0].text.includes(`Read this version: ${page.url}`), "Martin gets the link to read the version");
  assert.strictEqual(
    page.children.map((b: any) => b.paragraph.rich_text[0].text.content).join(""),
    text(rec.properties["Proposal Content"]),
    "the page holds exactly the hashed Proposal Content",
  );
});

test("Version pages 2. Approval sets Approved Version Link to the approved version's page", async (t) => {
  const { world, env, state } = await createV1(t);

  await handleSalesProposalDecision(env, state, 7, 1, "approve");

  const rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec["Approval Status"]), "Approved");
  assert.strictEqual(rec["Approved Version Link"].url, world.versionPages[0].url);
});

test("Version pages 3. A revision gets its own new page, moves the Current link, clears the Approved link, and leaves the approved version's page untouched", async (t) => {
  const { world, env, state } = await createV1(t);
  await handleSalesProposalDecision(env, state, 7, 1, "approve");
  const v1Page = structuredClone(world.versionPages[0]);

  await handleSalesProposalDecision(env, state, 7, 1, "revise");
  await handleSalesProposalRevisionText(env, state, "Add a second training session for the retail sales team.");

  const rec = proposals(world)[0].properties;
  assert.strictEqual(world.versionPages.length, 2);
  assert.strictEqual(world.versionPages[1].title, "PROP-7 v2");
  assert.strictEqual(rec["Current Version Link"].url, world.versionPages[1].url);
  assert.strictEqual(rec["Approved Version Link"].url, null, "the prior approval's link does not carry over to the unapproved v2");
  assert.deepStrictEqual(world.versionPages[0], v1Page, "v1's page is written once and never edited");
});

test("Version pages 4. A Proposal that predates version pages is approved without an Approved Version Link, not with a wrong one", async (t) => {
  const { world, env, state } = await createV1(t);
  const rec = proposals(world)[0];
  delete rec.properties["Current Version Link"];

  await handleSalesProposalDecision(env, state, 7, 1, "approve");

  assert.strictEqual(text(rec.properties["Approval Status"]), "Approved");
  assert.strictEqual(rec.properties["Approved Version Link"], undefined);
});


// ---------------------------------------------------------------------------
// Google Doc per version, and comments on it as change requests.
// A Doc is a readable, commentable copy of a token-safe version, created only
// when Martin taps "Create Google Doc". A comment never edits it: it runs the
// Proposal's own "Request changes" path and creates the next version.
// ---------------------------------------------------------------------------

function kvWithGoogleAccount(accounts: string[] = ["martin@example.com"]) {
  const store = new Map<string, string>();
  for (const a of accounts) {
    store.set(`google_oauth_tokens:${a}`, JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000, updated_at: "now" }));
  }
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async ({ prefix }: { prefix?: string } = {}) => ({ keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    } as any,
  };
}

/** Wraps the Notion/Telegram fake with a Google Drive/Docs fake, recording every Google call. */
function withGoogleFake(t: any, opts: { failDocCreate?: boolean } = {}) {
  const inner = globalThis.fetch;
  const calls: { method: string; url: string; body?: any }[] = [];
  let docText = "";
  let docTitle = "";
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    if (!u.includes("googleapis.com")) return inner(url as any, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.endsWith("/drive/v3/files") && method === "POST") {
      if (body.mimeType === "application/vnd.google-apps.folder") return json({ id: "folder-1" });
      if (opts.failDocCreate) return json({}, 500);
      docTitle = body.name;
      return json({ id: "doc-1" });
    }
    if (u.includes("/documents/doc-1:batchUpdate")) {
      docText = body.requests[0].insertText.text;
      return json({});
    }
    if (u.endsWith("/documents/doc-1") && method === "GET") {
      return json({ title: docTitle, body: { content: [{ paragraph: { elements: [{ textRun: { content: docText } }] } }] } });
    }
    throw new Error(`Unexpected Google call: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = inner;
  });
  return calls;
}

test("Google Doc 1. Tapping Create Google Doc makes one Doc of exactly the current version in a dedicated folder, watches it bound to that version, and shows the link", async (t) => {
  const { world, state } = await createV1(t);
  const calls = withGoogleFake(t);
  const { kv, store } = kvWithGoogleAccount();
  const env = fakeEnv({ STATE_KV: kv });
  const sp = state.salesProposal!;

  await handleSalesProposalDecision(env, state, 7, 1, "doc");

  const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/drive/v3/files"));
  assert.strictEqual(creates.length, 2, "one folder, then one Doc");
  assert.strictEqual(creates[0].body.name, "ENIG Proposals (token-safe)");
  assert.strictEqual(creates[1].body.name, "PROP-7 v1");
  assert.deepStrictEqual(creates[1].body.parents, ["folder-1"]);
  assert.strictEqual(store.get("google_proposal_docs_folder:martin@example.com"), "folder-1", "the folder is remembered");
  const watched = JSON.parse(store.get("google_doc_watch:doc-1")!);
  assert.deepStrictEqual(watched.proposal, { workId: state.workId, proposalNumber: 7, proposalId: "PROP-7", version: 1 });
  assert.strictEqual(sp.versions[0].docUrl, "https://docs.google.com/document/d/doc-1/edit");
  assert.match(world.telegram.at(-1)!.text, /Google Doc for PROP-7 v1:\* https:\/\/docs\.google\.com\/document\/d\/doc-1\/edit/);
  assert.strictEqual(sp.currentVersion, 1, "creating a Doc changes nothing about the Proposal");
  assert.strictEqual(sp.approvalStatus, "Pending Approval");
});

test("Google Doc 2. A second tap returns the existing Doc and creates nothing", async (t) => {
  const { world, state } = await createV1(t);
  const calls = withGoogleFake(t);
  const env = fakeEnv({ STATE_KV: kvWithGoogleAccount().kv });
  await handleSalesProposalDecision(env, state, 7, 1, "doc");
  const before = calls.length;

  await handleSalesProposalDecision(env, state, 7, 1, "doc");

  assert.strictEqual(calls.length, before, "no further Google call");
  assert.match(world.telegram.at(-1)!.text, /already exists: https:\/\/docs\.google\.com\/document\/d\/doc-1\/edit/);
});

test("Google Doc 3. No authorized account, several accounts, or a failed create each say so and create nothing", async (t) => {
  const { world, state } = await createV1(t);
  const calls = withGoogleFake(t);

  await handleSalesProposalDecision(fakeEnv({ STATE_KV: kvWithGoogleAccount([]).kv }), state, 7, 1, "doc");
  assert.match(world.telegram.at(-1)!.text, /no Google account is authorized/);

  await handleSalesProposalDecision(fakeEnv({ STATE_KV: kvWithGoogleAccount(["a@x.com", "b@x.com"]).kv }), state, 7, 1, "doc");
  assert.match(world.telegram.at(-1)!.text, /2 Google accounts are authorized and I won't guess/);
  assert.strictEqual(calls.length, 0, "nothing reached Google in either case");

  const failing = withGoogleFake(t, { failDocCreate: true });
  await handleSalesProposalDecision(fakeEnv({ STATE_KV: kvWithGoogleAccount().kv }), state, 7, 1, "doc");
  assert.match(world.telegram.at(-1)!.text, /Couldn't create the Google Doc \(creation\)/);
  assert.strictEqual(state.salesProposal!.versions[0].docUrl, undefined, "a failed create records no Doc");
  assert.ok(failing.length > 0);
});

test("Google Doc 4. A button for a version that is no longer current makes no Doc", async (t) => {
  const { state } = await createV1(t);
  const calls = withGoogleFake(t);
  const env = fakeEnv({ STATE_KV: kvWithGoogleAccount().kv });
  await handleSalesProposalDecision(env, state, 7, 1, "revise");
  await handleSalesProposalRevisionText(env, state, "Add a second training session.");
  assert.strictEqual(state.salesProposal!.currentVersion, 2);

  await handleSalesProposalDecision(env, state, 7, 1, "doc");

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(state.salesProposal!.versions[0].docUrl, undefined);
});

test("Doc comment 1. A change request on the current version's Doc runs the revision path: v2 with the change recorded verbatim, pending approval, v1 untouched", async (t) => {
  const { world, env, state } = await createV1(t);
  const v1Content = state.salesProposal!.versions[0].content;

  const { result } = await applyProposalDocComment(env, state, { proposalNumber: 7, version: 1, text: 'Regarding "training": Add a second session for the retail team.' });

  assert.deepStrictEqual(result, { kind: "revised", newVersion: 2 });
  const rec = proposals(world)[0].properties;
  assert.strictEqual(text(rec.Version), "v2");
  assert.strictEqual(text(rec["Approval Status"]), "Pending Approval");
  assert.match(text(rec["Proposal Content"]), /Regarding "training": Add a second session for the retail team\./);
  assert.strictEqual(state.salesProposal!.versions[0].content, v1Content, "v1 is kept unchanged");
  assert.strictEqual(world.versionPages.length, 2, "v2 has its own page");
  assert.ok(approvalRequests(world).at(-1)!.text.includes("Version: v2"), "v2 comes back to Martin for approval");
});

test("Doc comment 2. A comment on a superseded version's Doc creates nothing and says which version is current", async (t) => {
  const { world, env, state } = await createV1(t);
  await applyProposalDocComment(env, state, { proposalNumber: 7, version: 1, text: "First change." });
  assert.strictEqual(state.salesProposal!.currentVersion, 2);
  const pagesBefore = world.versionPages.length;

  const { result } = await applyProposalDocComment(env, state, { proposalNumber: 7, version: 1, text: "Second change on the old Doc." });

  assert.strictEqual(result.kind, "stale");
  assert.match((result as any).detail, /copy of v1, but PROP-7 is now at v2/);
  assert.strictEqual(state.salesProposal!.currentVersion, 2);
  assert.strictEqual(world.versionPages.length, pagesBefore);
});

test("Doc comment 3. A comment that would put real identity into the Proposal is refused with the reason, and no version is created", async (t) => {
  const { world, env, state } = await createV1(t, { entityName: "Acme Foods Ghana Ltd" });
  const pagesBefore = world.versionPages.length;

  const { result } = await applyProposalDocComment(env, state, { proposalNumber: 7, version: 1, text: "Mention Acme Foods Ghana Ltd by name." });

  assert.strictEqual(result.kind, "refused");
  assert.match((result as any).detail, /identity-bearing value/);
  assert.strictEqual(state.salesProposal!.currentVersion, 1);
  assert.strictEqual(world.versionPages.length, pagesBefore);
  assert.strictEqual(state.pendingSalesProposalRevision, undefined, "no revision is left half-open");
});

test("Doc comment 4. A Work that no longer belongs to Sales refuses the request", async (t) => {
  const { env, state } = await createV1(t);
  state.unit = "Strategy";

  const { result } = await applyProposalDocComment(env, state, { proposalNumber: 7, version: 1, text: "Change." });

  assert.strictEqual(result.kind, "refused");
  assert.match((result as any).detail, /now belongs to Strategy/);
});
