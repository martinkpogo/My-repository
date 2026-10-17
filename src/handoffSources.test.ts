import test from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_SOURCE_ROUTE_CONTRACTS,
  parseNotionPageLink,
  parseGoogleFileLink,
  extractHandoffSources,
  resolveHandoffSources,
  readGoogleDocSourceContent,
  handoffSourceRouteContract,
  type HandoffSourceRouteContract,
} from "./handoffSources";
import { buildRecordApprovalMarker, type CallNotesApprovalRecord } from "./records/callNotes/callNotesMarker";
import { workSessionContext } from "./access";
import type { Env, WorkState } from "./types";

/**
 * The direct-page Sources resolver, tested at the seam where a Handoff's
 * declared references become exactly-fetched, validated canonical pages.
 *
 * The suite is organised the way the resolver is: link parsing, then
 * extraction (the compatibility seam), then the resolution chain -- route
 * contract, binding targets, the exact page fetch, per-type validation, the
 * free-text consistency rule. Every refusal case asserts two things: that
 * resolution reported a reason, and that NOTHING beyond the reads already
 * made was touched -- no database search was issued as a fallback, no write
 * of any kind. A resolver that quietly searched the store when a direct
 * page could not be used would reintroduce exactly the ambiguity this
 * property exists to remove.
 */

const REGISTRY: CallNotesApprovalRecord = {
  callNotesId: "CN-007",
  entity: "E-47",
  matter: "M-12",
  callDate: "2026-09-28",
  callType: "Discovery",
  version: 1,
};

/** 32-hex page ids, one per canonical database used below. */
const CN_HEX = "aaaa1111bbbb2222cccc3333dddd4444";
const CN_PAGE_ID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const CN_PAGE_URL = `https://www.notion.so/Acme-Case-Notes-${CN_HEX}`;
const CN2_HEX = "bbbb2222cccc3333dddd4444eeee5555";
const CN2_PAGE_ID = "bbbb2222-cccc-3333-dddd-4444eeee5555";
const MATTER_HEX = "ffff5555eeee6666dddd7777cccc8888";
const MATTER_PAGE_ID = "ffff5555-eeee-6666-dddd-7777cccc8888";
const ENTITY_HEX = "eeee6666dddd7777cccc8888bbbb4444";
const ENTITY_PAGE_ID = "eeee6666-dddd-7777-cccc-8888bbbb4444";
const LEADS_HEX = "12345678123456781234567812345678";
const LEADS_PAGE_ID = "12345678-1234-5678-1234-567812345678";
const HANDOFFS_HEX = "99999999888888887777777766666666";
const HANDOFFS_PAGE_ID = "99999999-8888-8888-7777-777766666666";
const PROPOSALS_HEX = "0a0a0a0a0b0b0b0b0c0c0c0c0d0d0d0d";
const PROPOSALS_PAGE_ID = "0a0a0a0a-0b0b-0b0b-0c0c-0c0c0d0d0d0d";

function fakeEnv(kv: Record<string, string> = {}): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: {
      get: async (key: string) => kv[key] ?? null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any,
    } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
  };
}

/** The Work context consumption tests already use: a registered Action whose reads cover the governed stores. */
function pickupContext() {
  const state: WorkState = {
    workId: "work_sources_1",
    chatId: 1,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "proposal_draft",
    handoffId: "handoff-1",
    stage: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as WorkState;
  return workSessionContext(state);
}

function rich(value: string) {
  return { rich_text: [{ plain_text: value, text: { content: value } }] };
}

/** The `Sources` property in Notion's READ-back shape (plain_text + href present). */
function sourcesReadShape(urls: string[]) {
  return {
    rich_text: urls.map((url) => ({ type: "text", text: { content: url, link: { url } }, plain_text: url, href: url })),
  };
}

/** The `Sources` property in Notion's WRITE shape (text.link only, no plain_text/href). */
function sourcesWriteShape(urls: string[]) {
  return { rich_text: urls.map((url) => ({ type: "text", text: { content: url, link: { url } } })) };
}

function handoffProperties(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    Reason: rich("Commercial fit approved. Call_Notes_ID: CN-007"),
    "From Unit": { select: { name: "Sales" } },
    "To Unit": { select: { name: "Strategy" } },
    ...overrides,
  };
}

interface PageFixture {
  parent: { type: string; data_source_id?: string; page_id?: string };
  properties?: Record<string, any>;
  archived?: boolean;
  /** The raw Notion API field; resolvePageTarget normalises it to `inTrash`. */
  in_trash?: boolean;
}

interface MockLog {
  /** Every request, as `METHOD url`. */
  requests: string[];
  /** Every mutating request (PATCH/PUT/DELETE) -- the resolver must produce none. */
  writes: string[];
  /** Every query issued against the Call Notes store -- a search this resolver must never make. */
  callNotesQueries: string[];
}

function mockSourcesFetch(
  t: any,
  opts: {
    /** Pages served by exact id; any other page id 404s. */
    pages?: Record<string, PageFixture>;
    /** Whether the Handoff's Entity/Matter tokens resolve to real records. */
    resolves?: boolean;
    /** Drive file metadata served by exact file id (files.get). */
    googleFiles?: Record<string, { id?: string; name?: string; mimeType?: string; trashed?: boolean }>;
    /** Google Docs documents served by exact file id (documents.get). */
    googleDocs?: Record<string, any>;
  } = {},
): MockLog {
  const originalFetch = globalThis.fetch;
  const log: MockLog = { requests: [], writes: [], callNotesQueries: [] };
  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    log.requests.push(`${method} ${urlStr}`);
    if (method === "PATCH" || method === "PUT" || method === "DELETE") {
      log.writes.push(`${method} ${urlStr}`);
      return new Response(JSON.stringify({ id: "x", url: "https://notion.so/x", properties: {} }), { status: 200 });
    }
    if (urlStr.startsWith("https://www.googleapis.com/drive/v3/files/") && method === "GET") {
      const fileId = urlStr.split("/drive/v3/files/").pop()?.split("?")[0] ?? "";
      const file = opts.googleFiles?.[fileId];
      if (!file) {
        return new Response(JSON.stringify({ error: { code: 404, message: "File not found" } }), { status: 404 });
      }
      return new Response(JSON.stringify(file), { status: 200 });
    }
    if (urlStr.startsWith("https://docs.googleapis.com/v1/documents/") && method === "GET") {
      const fileId = urlStr.split("/v1/documents/").pop() ?? "";
      const doc = opts.googleDocs?.[fileId];
      if (!doc) {
        return new Response(JSON.stringify({ error: { code: 404, message: "Document not found" } }), { status: 404 });
      }
      return new Response(JSON.stringify(doc), { status: 200 });
    }
    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      const resolves = opts.resolves ?? true;
      return new Response(
        JSON.stringify({
          results: resolves
            ? [
                {
                  id: "matter-page-1",
                  url: "https://notion.so/matter-page-1",
                  parent: { type: "data_source_id", data_source_id: "matters-ds" },
                  properties: {
                    Matter_ID: { unique_id: { prefix: "M", number: 12 } },
                    Entity: { relation: [{ id: "entity-page-1" }] },
                    Status: { select: { name: "Qualified" } },
                  },
                },
              ]
            : [],
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith("/data_sources/call-notes-ds/query") && method === "POST") {
      // The exact-title search the LEGACY free-text path uses. A Sources
      // resolution must never issue it: the page id in the link IS the
      // identity, so needing a search would mean the direct reference failed.
      log.callNotesQueries.push(urlStr);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (urlStr.endsWith("/pages/entity-page-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "entity-page-1",
          url: "https://notion.so/entity-page-1",
          parent: { type: "data_source_id", data_source_id: "entity-ds" },
          properties: { Entity_ID: { unique_id: { prefix: "E", number: 47 } } },
        }),
        { status: 200 },
      );
    }
    if (method === "GET" && urlStr.includes("/pages/")) {
      const pageId = urlStr.split("/pages/").pop() ?? "";
      const fixture = opts.pages?.[pageId];
      if (!fixture) {
        return new Response(JSON.stringify({ object: "error", status: 404, message: "page not found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: pageId, url: `https://notion.so/${pageId}`, ...fixture }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in handoff-sources test: ${method} ${urlStr}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return log;
}

async function callNotesPageFixture(
  overrides: Record<string, any> = {},
  registry: CallNotesApprovalRecord = REGISTRY,
): Promise<PageFixture> {
  const marker = await buildRecordApprovalMarker(registry, "Approved");
  return {
    parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
    properties: {
      "Call Notes ID": { title: [{ plain_text: registry.callNotesId }] },
      "Call Date": { date: { start: registry.callDate } },
      "Call Type": { select: { name: registry.callType } },
      Note: { rich_text: [{ plain_text: "Direct client statement: the quarterly reporting pack takes four staff days to assemble." }] },
      Status: { select: { name: "Ready" } },
      Version: { number: registry.version },
      Entity: { relation: [{ id: "entity-page-1" }] },
      Matter: { relation: [{ id: "matter-page-1" }] },
      "Approval Attestation": { rich_text: [{ plain_text: marker }] },
      ...overrides,
    },
  };
}

function matterPageFixture(overrides: Record<string, any> = {}): PageFixture {
  return {
    parent: { type: "data_source_id", data_source_id: "matters-ds" },
    properties: {
      Matter_ID: { unique_id: { prefix: "M", number: 12 } },
      Entity: { relation: [{ id: "entity-page-1" }] },
      ...overrides,
    },
  };
}

function entityPageFixture(overrides: Record<string, any> = {}): PageFixture {
  return {
    parent: { type: "data_source_id", data_source_id: "entity-ds" },
    properties: { Entity_ID: { unique_id: { prefix: "E", number: 47 } }, ...overrides },
  };
}

/**
 * Contextually types a route-contract table so test literals stay inside the
 * closed `HandoffSourceType` vocabulary instead of widening to `string[]`.
 * Same seam as production: omitting `contracts` resolves against
 * `HANDOFF_SOURCE_ROUTE_CONTRACTS` exactly as production does.
 */
function routeContracts(table: Record<string, HandoffSourceRouteContract>): Readonly<Record<string, HandoffSourceRouteContract>> {
  return table;
}

interface ResolveOptions {
  tokens?: { entityToken: string; matterToken: string };
  fromUnit?: string;
  toUnit?: string;
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>;
  /** The Google binding-hop seam: the persisted identity of the Work a Doc's registration is bound to. */
  readBoundWorkState?: (workId: string) => Promise<{ entityId?: string; matterId?: string } | undefined>;
  env?: Env;
}

function resolve(properties: Record<string, any>, opts: ResolveOptions = {}) {
  return resolveHandoffSources(opts.env ?? fakeEnv(), {
    properties: properties as any,
    tokens: opts.tokens ?? { entityToken: "E-47", matterToken: "M-12" },
    route: { fromUnit: opts.fromUnit ?? "Sales", toUnit: opts.toUnit ?? "Strategy" },
    access: pickupContext(),
    ...(opts.contracts ? { contracts: opts.contracts } : {}),
    ...(opts.readBoundWorkState ? { readBoundWorkState: opts.readBoundWorkState } : {}),
  });
}

async function expectRefused(
  t: any,
  pages: Record<string, PageFixture>,
  properties: Record<string, any>,
  matcher: RegExp,
  opts: ResolveOptions & { expectNoCallNotesQuery?: boolean } = {},
) {
  const log = mockSourcesFetch(t, { pages });
  const result = await resolve(properties, opts);
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.match(result.reason, matcher, "the refusal must say exactly what stopped it");
  assert.equal(log.writes.length, 0, "a refusal must issue no write at all");
  if (opts.expectNoCallNotesQuery !== false) {
    assert.equal(log.callNotesQueries.length, 0, "a refusal must never fall back to a database search");
  }
}

// ---------------------------------------------------------------------------
// Link parsing: only an exact Notion page link parses.
// ---------------------------------------------------------------------------

test("parse: a bare-id Notion page URL resolves to the exact dashed page id", () => {
  assert.deepEqual(parseNotionPageLink(`https://www.notion.so/${CN_HEX}`), { ok: true, pageId: CN_PAGE_ID });
});

test("parse: a slug URL (name prefix, undashed id) resolves to the same exact page id", () => {
  assert.deepEqual(parseNotionPageLink(CN_PAGE_URL), { ok: true, pageId: CN_PAGE_ID });
});

test("parse: an uppercase id and unrelated query parameters still resolve to the exact page", () => {
  const result = parseNotionPageLink(`https://www.notion.so/Acme-${CN_HEX.toUpperCase()}?utm_source=share`);
  assert.deepEqual(result, { ok: true, pageId: CN_PAGE_ID });
});

test("parse: a dashed id inside a workspace path resolves to the exact page", () => {
  assert.deepEqual(parseNotionPageLink(`https://www.notion.so/acme-consulting/${CN_PAGE_ID}`), { ok: true, pageId: CN_PAGE_ID });
});

test("parse: anything that is not a URL is refused", () => {
  const result = parseNotionPageLink("just some text");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a URL/);
});

test("parse: a non-Notion host is refused -- only canonical Notion pages may be sources", () => {
  const result = parseNotionPageLink(`https://evil.example.com/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a notion\.so page link/);
});

test("parse: a database path link is refused -- a database is not a page", () => {
  const result = parseNotionPageLink(`https://www.notion.so/acme/database/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /database\/data-source\/view link/);
});

test("parse: a data-source path link is refused", () => {
  const result = parseNotionPageLink(`https://www.notion.so/acme/data_source/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /database\/data-source\/view link/);
});

test("parse: the ?v= database-view parameter is refused -- it names a view, not a page", () => {
  const result = parseNotionPageLink(`https://www.notion.so/acme/${CN_HEX}?v=0123456789abcdef0123456789abcdef`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /database-view parameter/);
});

test("parse: a URL with no page id anywhere is refused", () => {
  const result = parseNotionPageLink("https://www.notion.so/Acme-Case-Notes");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no Notion page id/);
});

test("parse: an empty entry is refused", () => {
  const result = parseNotionPageLink("   ");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /empty Sources entry/);
});

// ---------------------------------------------------------------------------
// Extraction: the compatibility seam, and the shapes a present property can take.
// ---------------------------------------------------------------------------

test("extraction: a Handoff with no Sources property is legacy -- and resolves without a single fetch", async (t) => {
  const log = mockSourcesFetch(t, {});
  const result = await resolve(handoffProperties(), { tokens: { entityToken: "broken", matterToken: "also broken" } });
  assert.deepEqual(result, { ok: true, mode: "legacy" });
  assert.equal(log.requests.length, 0, "legacy resolution touches nothing -- no fetch of any kind");
});

test("extraction: a null Sources property is legacy too", () => {
  assert.deepEqual(extractHandoffSources(handoffProperties({ Sources: null })), { ok: true, mode: "legacy" });
});

test("extraction: a present property with one link resolves its exact page id (read shape)", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }));
  assert.deepEqual(result, { ok: true, mode: "sources", refs: [{ kind: "notion", pageId: CN_PAGE_ID }] });
});

test("extraction: a present property in the write shape (text.link only) resolves too", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: sourcesWriteShape([CN_PAGE_URL]) }));
  assert.deepEqual(result, { ok: true, mode: "sources", refs: [{ kind: "notion", pageId: CN_PAGE_ID }] });
});

test("extraction: a present property carrying no link at all is refused -- nothing is inferred to fill it", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: { rich_text: [] } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /carries no link/);
});

test("extraction: duplicate references to the same page are refused, not de-duplicated -- slug and bare-id URLs of one page count as a duplicate", () => {
  const result = extractHandoffSources(
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL, `https://www.notion.so/${CN_HEX}`]) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /references page .* more than once/);
});

test("extraction: a malformed link inside the property fails the whole extraction", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: sourcesReadShape(["https://www.notion.so/no-id-here"]) }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /unusable reference/);
});

// ---------------------------------------------------------------------------
// Resolution: the valid canonical path.
// ---------------------------------------------------------------------------

test("sources: one canonical Call Notes page resolves fully -- fetched by exact id, never searched, never written", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture() } });
  const result = await resolve(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }));

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;

  assert.deepEqual(result.sources, [{ type: "call_notes", id: CN_PAGE_ID }]);
  assert.equal(result.callNotes?.callNotesId, "CN-007");
  assert.equal(result.callNotes?.status, "Ready");
  assert.equal(result.callNotes?.attestation.result, "Approved", "the recorded approval attestation was re-validated against this record");

  assert.equal(log.callNotesQueries.length, 0, "the direct page id replaces the database search entirely");
  assert.equal(
    log.requests.filter((r) => r === `GET https://api.notion.com/v1/pages/${CN_PAGE_ID}`).length,
    1,
    "the exact referenced page is fetched exactly once",
  );
  assert.equal(log.writes.length, 0, "resolution is read-only");
});

test("sources: a Sources-enabled Handoff needs no free-text Call_Notes_ID at all -- the canonical page stands alone", async (t) => {
  mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture() } });
  const result = await resolve(
    handoffProperties({ Reason: rich("Commercial fit approved."), Sources: sourcesReadShape([CN_PAGE_URL]) }),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("sources: multiple references of different permitted types all resolve (injected contract)", async (t) => {
  const log = mockSourcesFetch(t, {
    pages: {
      [CN_PAGE_ID]: await callNotesPageFixture(),
      [MATTER_PAGE_ID]: matterPageFixture(),
    },
  });
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
  });
  const result = await resolve(
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL, `https://www.notion.so/${MATTER_HEX}`]) }),
    { contracts },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;
  assert.deepEqual(
    result.sources.map((s) => s.type),
    ["call_notes", "matters"],
  );
  assert.equal(log.writes.length, 0);
});

test("sources: an already-Consumed canonical Call Notes page still resolves -- Strategy's read is idempotent", async (t) => {
  mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture({ Status: { select: { name: "Consumed" } } }) } });
  const result = await resolve(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }));
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;
  assert.equal(result.callNotes?.status, "Consumed");
});

// ---------------------------------------------------------------------------
// Resolution: route contracts.
// ---------------------------------------------------------------------------

test("sources: a route with no contract is refused -- which sources may travel a route is a contract decision, never a guess", async (t) => {
  await expectRefused(
    t,
    {},
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /route "Finance->Sales" has no Handoff source route contract/,
    { fromUnit: "Finance", toUnit: "Sales" },
  );
});

test("sources: a Handoff whose From/To Unit is unset has no contract and is refused", async (t) => {
  await expectRefused(
    t,
    {},
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]), "From Unit": { select: { name: null } } }),
    /has no Handoff source route contract/,
    { fromUnit: "", toUnit: "Strategy" },
  );
});

test("sources: a prohibited source type (another Handoff) is refused by name", async (t) => {
  await expectRefused(
    t,
    { [HANDOFFS_PAGE_ID]: { parent: { type: "data_source_id", data_source_id: "handoffs-ds" }, properties: {} } },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${HANDOFFS_HEX}`]) }),
    /handoffs sources are prohibited on route Sales->Strategy/,
  );
});

test("sources: a recognizable but unpermitted source type (a Lead page) is refused", async (t) => {
  await expectRefused(
    t,
    { [LEADS_PAGE_ID]: { parent: { type: "data_source_id", data_source_id: "leads-ds" }, properties: {} } },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${LEADS_HEX}`]) }),
    /neither required nor optional on route Sales->Strategy/,
  );
});

test("sources: two pages of the same type are conflicting references -- which one is the source is ambiguous", async (t) => {
  const second = await callNotesPageFixture({}, { ...REGISTRY, callNotesId: "CN-008" });
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture(), [CN2_PAGE_ID]: second },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL, `https://www.notion.so/${CN2_HEX}`]) }),
    /references more than one call_notes source/,
  );
});

test("sources: a route requiring a source the Handoff does not carry is refused -- a mandatory source is never substituted (injected contract)", async (t) => {
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: ["matters"], optional: ["call_notes"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture() },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /requires a matters source/,
    { contracts },
  );
});

// ---------------------------------------------------------------------------
// Resolution: the page itself.
// ---------------------------------------------------------------------------

test("sources: an inaccessible page is refused, and NO database search stands in for it", async (t) => {
  await expectRefused(t, {}, handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }), /could not be read/);
});

test("sources: an archived page is refused -- only a live canonical record may be a source", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: { ...(await callNotesPageFixture()), archived: true } },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /archived or in the trash/,
  );
});

test("sources: a page in the trash is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: { ...(await callNotesPageFixture()), in_trash: true } },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /archived or in the trash/,
  );
});

test("sources: a page that is not a row of a canonical database is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: { parent: { type: "page_id", page_id: "some-parent" }, properties: {} } },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /not a row of a canonical database/,
  );
});

test("sources: a row of a database outside ENIG's governed sources is refused by Access itself before the resolver classifies it", async (t) => {
  // Access evaluates every read against the page's REAL parent (read back
  // from Notion), so a foreign data source is denied there and the fetch
  // never yields a page. The resolver's own canonical-database check behind
  // it is defence in depth for the day Access's governed set and the source
  // type vocabulary diverge -- not the primary guard.
  await expectRefused(
    t,
    { [CN_PAGE_ID]: { parent: { type: "data_source_id", data_source_id: "someone-elses-ds" }, properties: {} } },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /could not be read \(Access denied: "someone-elses-ds" is not a governed data source/,
  );
});

// ---------------------------------------------------------------------------
// Resolution: binding targets and per-type validation.
// ---------------------------------------------------------------------------

test("sources: Handoff tokens that do not resolve stop the chain before any source page is even fetched", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture() }, resolves: false });
  const result = await resolve(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }), {
    tokens: { entityToken: "E-404", matterToken: "M-404" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /did not resolve to a real, related Entity\/Matter record/);
  assert.ok(!log.requests.some((r) => r.includes(CN_HEX)), "no source page is fetched when there is nothing to bind it to");
  assert.equal(log.callNotesQueries.length, 0);
  assert.equal(log.writes.length, 0);
});

test("sources: a Call Notes page bound to a different Entity is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ Entity: { relation: [{ id: "some-other-entity" }] } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /not bound to this Handoff's Entity/,
  );
});

test("sources: a Call Notes page bound to a different Matter is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ Matter: { relation: [{ id: "some-other-matter" }] } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /not bound to this Handoff's Matter/,
  );
});

test("sources: a Superseded Call Notes page is refused -- no approved current evidence", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ Status: { select: { name: "Superseded" } } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /only Ready or Consumed/,
  );
});

test("sources: a Call Notes page with no Status at all is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ Status: { select: { name: null } } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /only Ready or Consumed/,
  );
});

test("sources: a Call Notes page with no Version cannot carry a checkable approval and is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ Version: { number: undefined } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /Version property is missing/,
  );
});

test("sources: a Call Notes page with no recorded attestation is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ "Approval Attestation": { rich_text: [] } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /no record_approval attestation marker/,
  );
});

test("sources: a tampered attestation on the canonical page is refused by fields_hash", async (t) => {
  const valid = await callNotesPageFixture();
  const marker = valid.properties!["Approval Attestation"].rich_text[0].plain_text as string;
  const tampered = marker.replace(/fields_hash=[0-9a-f]+/, `fields_hash=${"0".repeat(64)}`);
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ "Approval Attestation": rich(tampered) }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /fields_hash does not match/,
  );
});

test("sources: an attestation bound to different registry fields is refused", async (t) => {
  // The marker is computed over registry fields the PAGE does not actually
  // carry (the page keeps the real 2026-09-28 call date): the fields_hash
  // recompute over the fetched properties cannot reproduce it.
  const foreignMarker = await buildRecordApprovalMarker({ ...REGISTRY, callDate: "2026-01-01" }, "Approved");
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ "Approval Attestation": rich(foreignMarker) }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /fields_hash does not match/,
  );
});

test("sources: a Matter source whose Matter_ID is not this Handoff's Matter is refused (injected contract)", async (t) => {
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [MATTER_PAGE_ID]: matterPageFixture({ Matter_ID: { unique_id: { prefix: "M", number: 99 } } }) },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    /is not this Handoff's Matter/,
    { contracts },
  );
});

test("sources: a Matter source related to a different Entity is refused (injected contract)", async (t) => {
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [MATTER_PAGE_ID]: matterPageFixture({ Entity: { relation: [{ id: "some-other-entity" }] } }) },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    /not related to the Entity page this Handoff's Entity_Token resolves to/,
    { contracts },
  );
});

test("sources: an Entity source whose Entity_ID is not this Handoff's Entity is refused (injected contract)", async (t) => {
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: [], optional: ["entities"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [ENTITY_PAGE_ID]: entityPageFixture({ Entity_ID: { unique_id: { prefix: "E", number: 99 } } }) },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${ENTITY_HEX}`]) }),
    /is not this Handoff's Entity/,
    { contracts },
  );
});

test("sources: a correctly bound Matter source resolves (injected contract)", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [MATTER_PAGE_ID]: matterPageFixture() } });
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: [], optional: ["matters"], prohibited: ["handoffs"] },
  });
  // No free-text Call_Notes_ID here: this Handoff declares only its Matter
  // page, and nothing in its narrative claims a Call Notes reference.
  const result = await resolve(
    handoffProperties({ Reason: rich("Commercial fit approved."), Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    { contracts },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.equal(log.writes.length, 0);
});

test("sources: a type with no implemented per-type validation refuses rather than passes (injected contract)", async (t) => {
  await expectRefused(
    t,
    { [PROPOSALS_PAGE_ID]: { parent: { type: "data_source_id", data_source_id: "proposals-ds" }, properties: {} } },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${PROPOSALS_HEX}`]) }),
    /no per-type source validation is implemented for proposals/,
    { contracts: { ...HANDOFF_SOURCE_ROUTE_CONTRACTS, "Sales->Strategy": { required: [], optional: ["proposals"], prohibited: [] } } },
  );
});

// ---------------------------------------------------------------------------
// The free-text consistency rule: two transports, one truth.
// ---------------------------------------------------------------------------

test("sources: a free-text Call_Notes_ID that AGREES with the canonical page is accepted", async (t) => {
  mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture() } });
  const result = await resolve(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }));
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("sources: a free-text Call_Notes_ID that DISAGREES with the canonical page is refused -- conflicting references", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture() },
    handoffProperties({ Reason: rich("Fit approved. Call_Notes_ID: CN-999"), Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /conflicting references/,
  );
});

test("sources: a free-text Call_Notes_ID with no canonical page behind it is refused -- the free-text id is never a fallback", async (t) => {
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [MATTER_PAGE_ID]: matterPageFixture() },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    /carries no canonical Call Notes page/,
    { contracts },
  );
});

test("sources: a broken free-text Call_Notes_ID beside a Sources property is refused -- conflicting transports never silently win", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture() },
    handoffProperties({ Reason: rich("Fit approved. Call_Notes_ID:"), Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /cannot be used beside its Sources property/,
  );
});

test("sources: a malformed free-text Call_Notes_ID beside a Sources property is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture() },
    handoffProperties({ Reason: rich("Fit approved. Call_Notes_ID: CN-007 (see below)"), Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /cannot be used beside its Sources property/,
  );
});

test("sources: a free-text reference that conflicts with itself beside a Sources property is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture() },
    handoffProperties({
      Reason: rich("Fit approved. Call_Notes_ID: CN-007"),
      Handoff: { title: [{ plain_text: "Call Notes — Call_Notes_ID: CN-042", text: { content: "Call Notes — Call_Notes_ID: CN-042" } }] },
      Sources: sourcesReadShape([CN_PAGE_URL]),
    }),
    /cannot be used beside its Sources property/,
  );
});

test("sources: the canonical Call Notes id itself travels as the page's own registry field, not as any title inference", async (t) => {
  // The page's Call Notes ID differs from the free-text id only in the
  // record it names; the resolver reads the id from the FETCHED page's
  // registry field and compares it -- never from the URL's slug text.
  const registry = { ...REGISTRY, callNotesId: "CN-404" };
  const page = await callNotesPageFixture({}, registry);
  const log = mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: page } });
  const result = await resolve(
    handoffProperties({ Reason: rich("Fit approved. Call_Notes_ID: CN-404"), Sources: sourcesReadShape([CN_PAGE_URL]) }),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;
  assert.equal(result.callNotes?.callNotesId, "CN-404");
  assert.ok(!log.requests.some((r) => r.includes("call-notes-ds")), "no title-based lookup anywhere");
});

test("sources: the production route table permits exactly the documented types on Sales->Strategy", () => {
  assert.deepEqual(handoffSourceRouteContract("Sales", "Strategy"), {
    required: [],
    optional: ["call_notes"],
    prohibited: ["handoffs"],
  });
  assert.equal(handoffSourceRouteContract("Strategy", "Finance"), undefined, "any other route has no contract until one is declared");
});

// ---------------------------------------------------------------------------
// Google file links: only exact docs.google.com direct file links parse.
// ---------------------------------------------------------------------------

const GDOC_FILE_ID = "abc123DEF456ghi789jkl012mno345pq";
const GSHEET_FILE_ID = "sheet123ABC456def789GHI012jkl345mn";
const GOOGLE_ACCOUNT = "martin@example.com";
const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheets";

test("parseGoogleFileLink: a direct Google Doc URL resolves to the exact file id and the type its URL claims", () => {
  for (const url of [
    `https://docs.google.com/document/d/${GDOC_FILE_ID}/edit`,
    `https://docs.google.com/document/d/${GDOC_FILE_ID}/preview`,
    `https://docs.google.com/document/d/${GDOC_FILE_ID}?usp=sharing`,
    `http://docs.google.com/document/u/0/d/${GDOC_FILE_ID}/edit`.replace("/u/0", ""),
  ]) {
    assert.deepEqual(parseGoogleFileLink(url), { ok: true, fileType: "google_doc", fileId: GDOC_FILE_ID }, url);
  }
});

test("parseGoogleFileLink: a direct Google Sheets URL resolves to google_sheet", () => {
  assert.deepEqual(parseGoogleFileLink(`https://docs.google.com/spreadsheets/d/${GSHEET_FILE_ID}/edit#gid=0`), {
    ok: true,
    fileType: "google_sheet",
    fileId: GSHEET_FILE_ID,
  });
});

test("parseGoogleFileLink: a lookalike host is refused -- never normalized into docs.google.com", () => {
  const result = parseGoogleFileLink(`https://docs.google.com.evil.example/document/d/${GDOC_FILE_ID}/edit`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a docs\.google\.com direct file link/);
});

test("parseGoogleFileLink: other Google products, the /u/<n>/ variant, and drive.google.com share links are refused", () => {
  for (const url of [
    `https://docs.google.com/presentation/d/${GDOC_FILE_ID}/edit`,
    `https://docs.google.com/forms/d/${GDOC_FILE_ID}/edit`,
    `https://drive.google.com/file/d/${GDOC_FILE_ID}/view`,
    `https://docs.google.com/document/u/0/d/${GDOC_FILE_ID}/edit`,
  ]) {
    const result = parseGoogleFileLink(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.match(result.reason, /not a direct file link|not a docs\.google\.com direct file link/, url);
  }
});

test("parseGoogleFileLink: a missing or unrecognizable file id is refused", () => {
  for (const url of ["https://docs.google.com/document/d/edit", "https://docs.google.com/document/d/short/edit"]) {
    const result = parseGoogleFileLink(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.match(result.reason, /recognizable Google file id/, url);
  }
});

test("parseGoogleFileLink: not a URL is refused", () => {
  const result = parseGoogleFileLink("just some words");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /is not a URL/);
});

test("extraction: a mixed Sources property resolves typed refs -- a Notion page and a Google Doc, each exact", () => {
  const result = extractHandoffSources(
    handoffProperties({ Sources: sourcesWriteShape([CN_PAGE_URL, `https://docs.google.com/document/d/${GDOC_FILE_ID}/edit`]) }),
  );
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "notion", pageId: CN_PAGE_ID },
      { kind: "google", type: "google_doc", fileId: GDOC_FILE_ID },
    ],
  });
});

test("extraction: the same Google file through two URL shapes is one reference written twice -- refused", () => {
  const result = extractHandoffSources(
    handoffProperties({
      Sources: sourcesWriteShape([
        `https://docs.google.com/document/d/${GDOC_FILE_ID}/edit`,
        `https://docs.google.com/document/d/${GDOC_FILE_ID}/preview`,
      ]),
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /references Google file .* more than once/);
});

// ---------------------------------------------------------------------------
// Google source resolution: registration binding, actual type, no Sheets read.
// ---------------------------------------------------------------------------

/** A route contract that permits the Google types, so their full validation chain can be exercised (the production table permits none). */
const GOOGLE_PERMITTING_CONTRACTS = routeContracts({
  "Sales->Strategy": { required: [], optional: ["call_notes", "google_doc", "google_sheet"], prohibited: ["handoffs"] },
});

function googleKv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [`google_doc_watch:${GDOC_FILE_ID}`]: JSON.stringify({
      documentId: GDOC_FILE_ID,
      accountIdentifier: GOOGLE_ACCOUNT,
      title: "Proposal review",
      createdAt: "2026-10-01T00:00:00.000Z",
      proposal: { workId: "work-prop-1", proposalNumber: 6, proposalId: "PROP-6", version: 2 },
    }),
    [`google_sheet_watch:${GSHEET_FILE_ID}`]: JSON.stringify({
      spreadsheetId: GSHEET_FILE_ID,
      accountIdentifier: GOOGLE_ACCOUNT,
      title: "Numbers",
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
    [`google_oauth_tokens:${GOOGLE_ACCOUNT}`]: JSON.stringify({
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      expires_at: Date.now() + 3_600_000,
      account_identifier: GOOGLE_ACCOUNT,
      updated_at: "2026-10-01T00:00:00.000Z",
    }),
    ...overrides,
  };
}

function googleDocUrl(fileId = GDOC_FILE_ID) {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

/** A Google-source Handoff payload whose Reason carries no free-text Call_Notes_ID reference (that transport is checked separately from the Sources path). */
function googleHandoffProperties(url: string) {
  return handoffProperties({ Reason: rich("Commercial fit approved."), Sources: sourcesWriteShape([url]) });
}

/** The validated-source shape readGoogleDocSourceContent consumes -- built directly: content reading is its own seam. */
const VALIDATED_DOC_SOURCE = {
  fileId: GDOC_FILE_ID,
  accountIdentifier: GOOGLE_ACCOUNT,
  title: "Proposal review",
  proposal: { workId: "work-prop-1", proposalId: "PROP-6", version: 2 },
};

function boundWorkState(overrides: { entityId?: string; matterId?: string } = { matterId: "matter-page-1", entityId: "entity-page-1" }) {
  return async () => overrides;
}

test("sources: a registered, bound Google Doc resolves fully -- exact file, registration binding, Drive-verified type; content is NOT read at resolution", async (t) => {
  const log = mockSourcesFetch(t, {
    googleFiles: { [GDOC_FILE_ID]: { id: GDOC_FILE_ID, name: "Proposal review", mimeType: DOC_MIME } },
  });
  const result = await resolve(googleHandoffProperties(googleDocUrl()), {
    contracts: GOOGLE_PERMITTING_CONTRACTS,
    env: fakeEnv(googleKv()),
    readBoundWorkState: boundWorkState(),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;
  assert.deepEqual(result.sources, [{ type: "google_doc", id: GDOC_FILE_ID }]);
  assert.equal(result.googleDoc?.fileId, GDOC_FILE_ID);
  assert.equal(result.googleDoc?.accountIdentifier, GOOGLE_ACCOUNT);
  assert.equal(result.googleDoc?.proposal.proposalId, "PROP-6");
  assert.equal(result.googleDoc?.proposal.version, 2);
  assert.equal(log.writes.length, 0, "resolution writes nothing");
  assert.equal(log.requests.filter((r) => r.includes("/documents/")).length, 0, "the Doc's CONTENT is not read at resolution -- only its binding and type");
  assert.equal(log.requests.filter((r) => r.includes("/drive/v3/files/")).length, 1, "exactly one files.get -- the actual type verified once");
});

test("sources: an UNREGISTERED Google Doc is refused -- account access alone is never a relationship", async (t) => {
  await expectGoogleRefused(
    t,
    googleDocUrl("unregisteredfile00011122233344455"),
    /is not registered by this Worker/,
    {},
  );
});

test("sources: a registered Doc with no proposal/Work binding is refused -- nothing ties it to an Entity/Matter", async (t) => {
  await expectGoogleRefused(
    t,
    googleDocUrl(),
    /no proposal\/Work binding/,
    {
      [`google_doc_watch:${GDOC_FILE_ID}`]: JSON.stringify({
        documentId: GDOC_FILE_ID,
        accountIdentifier: GOOGLE_ACCOUNT,
        title: "Loose doc",
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
    },
  );
});

test("sources: a Doc bound to a Work whose state cannot be read is refused -- an unverifiable binding is never assumed", async (t) => {
  await expectGoogleRefused(t, googleDocUrl(), /no longer has readable state/, googleKv(), {
    readBoundWorkState: async () => undefined,
  });
});

test("sources: a Doc bound to another Matter is refused -- the binding must name exactly this Handoff's Matter", async (t) => {
  await expectGoogleRefused(t, googleDocUrl(), /not bound to this Handoff's Matter/, googleKv(), {
    readBoundWorkState: boundWorkState({ matterId: "matter-page-OTHER", entityId: "entity-page-1" }),
  });
});

test("sources: a link that claims a Doc but whose Drive mimeType is a Sheet is refused -- the API decides the type, never the URL", async (t) => {
  await expectGoogleRefused(t, googleDocUrl(), /Drive API reports mimeType/, googleKv(), {
    readBoundWorkState: boundWorkState(),
    files: { [GDOC_FILE_ID]: { id: GDOC_FILE_ID, mimeType: SHEET_MIME } },
  });
});

test("sources: a trashed Doc is refused -- only a live file may be a source", async (t) => {
  await expectGoogleRefused(t, googleDocUrl(), /in the trash/, googleKv(), {
    readBoundWorkState: boundWorkState(),
    files: { [GDOC_FILE_ID]: { id: GDOC_FILE_ID, mimeType: DOC_MIME, trashed: true } },
  });
});

test("sources: a Doc whose registered account holds no authorized token is refused -- the type cannot be verified, so nothing is read", async (t) => {
  await expectGoogleRefused(t, googleDocUrl(), /no currently authorized Google token/, {
    [`google_doc_watch:${GDOC_FILE_ID}`]: googleKv()[`google_doc_watch:${GDOC_FILE_ID}`],
  }, {
    readBoundWorkState: boundWorkState(),
  });
});

test("sources: a Drive API failure is refused with its HTTP status -- never read unverified", async (t) => {
  await expectGoogleRefused(t, googleDocUrl(), /HTTP 404/, googleKv(), {
    readBoundWorkState: boundWorkState(),
    files: {}, // the files.get 404s
  });
});

test("sources: a registered Google Sheet is refused with the precise missing contract -- account identity only, no binding, no bounded range", async (t) => {
  await expectGoogleRefused(
    t,
    `https://docs.google.com/spreadsheets/d/${GSHEET_FILE_ID}/edit`,
    /registration carries account identity only .*no declared bounded worksheet range/s,
    googleKv(),
    {
      files: { [GSHEET_FILE_ID]: { id: GSHEET_FILE_ID, mimeType: SHEET_MIME } },
      readBoundWorkState: boundWorkState(),
    },
  );
});

test("sources: an UNREGISTERED Google Sheet is refused the same way -- and nothing about it is ever read", async (t) => {
  const log = mockSourcesFetch(t, {});
  const kv = googleKv();
  delete kv[`google_sheet_watch:${GSHEET_FILE_ID}`]; // nothing registered about this spreadsheet at all
  const result = await resolve(googleHandoffProperties(`https://docs.google.com/spreadsheets/d/${GSHEET_FILE_ID}/edit`), {
    contracts: GOOGLE_PERMITTING_CONTRACTS,
    env: fakeEnv(kv),
    readBoundWorkState: boundWorkState(),
  });
  assert.equal(result.ok, false, "an unregistered spreadsheet is never a source");
  if (result.ok) return;
  assert.match(result.reason, /not registered by this Worker/);
  assert.equal(log.requests.filter((r) => !r.includes("/pages/") && !r.includes("/data_sources/")).length, 0, "no Google API was ever contacted about the spreadsheet");
  assert.equal(log.writes.length, 0);
});

test("sources: a Google Doc on a route whose contract does not permit google_doc is refused BEFORE any Google API is contacted (production table)", async (t) => {
  const log = mockSourcesFetch(t, {});
  // No contracts seam: the production table, where Sales->Strategy permits only call_notes.
  const result = await resolve(googleHandoffProperties(googleDocUrl()), {
    env: fakeEnv(googleKv()),
    readBoundWorkState: boundWorkState(),
  });
  assert.equal(result.ok, false, "no production route permits google_doc today -- the contract decides, not the code path");
  if (result.ok) return;
  assert.match(result.reason, /does not permit google_doc sources/);
  assert.equal(log.requests.filter((r) => r.includes("googleapis.com")).length, 0, "permission is checked before any Google API is contacted");
});

/** Runs one Google-source refusal through the full chain and asserts the exact reason plus the no-write/no-search discipline. */
async function expectGoogleRefused(
  t: any,
  url: string,
  matcher: RegExp,
  kv: Record<string, string>,
  extra: {
    readBoundWorkState?: (workId: string) => Promise<{ entityId?: string; matterId?: string } | undefined>;
    files?: Record<string, { id?: string; mimeType?: string; trashed?: boolean }>;
  } = {},
) {
  const log = mockSourcesFetch(t, { googleFiles: extra.files ?? {} });
  const result = await resolve(googleHandoffProperties(url), {
    contracts: GOOGLE_PERMITTING_CONTRACTS,
    env: fakeEnv(kv),
    ...(extra.readBoundWorkState ? { readBoundWorkState: extra.readBoundWorkState } : {}),
  });
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.match(result.reason, matcher, "the refusal must say exactly what stopped it");
  assert.equal(log.writes.length, 0, "a refusal issues no write of any kind");
  assert.equal(log.callNotesQueries.length, 0, "a refusal never falls back to a database search");
  assert.equal(log.requests.filter((r) => r.includes("/documents/")).length, 0, "no content read ever happened on a refused source");
}

// ---------------------------------------------------------------------------
// readGoogleDocSourceContent: the content read, only for an already
// validated source -- read-only, empty refused.
// ---------------------------------------------------------------------------

function docBody(text: string) {
  return {
    body: {
      content: [
        {
          paragraph: {
            elements: [{ textRun: { content: text } }],
          },
        },
      ],
    },
  };
}

test("readGoogleDocSourceContent: reads the validated Doc's text through the Docs API -- read-only", async (t) => {
  mockSourcesFetch(t, { googleDocs: { [GDOC_FILE_ID]: docBody("The commercial situation, recorded.") } });
  const read = await readGoogleDocSourceContent(fakeEnv(googleKv()), VALIDATED_DOC_SOURCE);
  assert.equal(read.ok, true, read.ok ? "" : read.reason);
  if (!read.ok) return;
  assert.match(read.content, /The commercial situation, recorded\./);
});

test("readGoogleDocSourceContent: a document with no text is refused -- nothing is inferred to fill the gap", async (t) => {
  mockSourcesFetch(t, { googleDocs: { [GDOC_FILE_ID]: docBody("") } });
  const read = await readGoogleDocSourceContent(fakeEnv(googleKv()), VALIDATED_DOC_SOURCE);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.match(read.reason, /carries no text content/);
});

test("readGoogleDocSourceContent: an account with no authorized token refuses the read -- never through another account", async (t) => {
  mockSourcesFetch(t, { googleDocs: { [GDOC_FILE_ID]: docBody("text") } });
  const read = await readGoogleDocSourceContent(fakeEnv({}), VALIDATED_DOC_SOURCE);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.match(read.reason, /no currently authorized token/);
});

test("readGoogleDocSourceContent: a failed Docs read surfaces its HTTP status", async (t) => {
  mockSourcesFetch(t, {}); // documents.get 404s
  const read = await readGoogleDocSourceContent(fakeEnv(googleKv()), VALIDATED_DOC_SOURCE);
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.match(read.reason, /HTTP 404/);
});
