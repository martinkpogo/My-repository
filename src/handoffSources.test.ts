import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDOFF_SOURCE_ROUTE_CONTRACTS,
  parseNotionPageLink,
  parseGoogleFileLink,
  extractHandoffSources,
  resolveHandoffSources,
  resolveHandoffContextBinding,
  readGoogleDocSourceContent,
  handoffSourceRouteContract,
  handoffRouteRequiresEntityMatter,
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

/**
 * The opaque token pair every commercial-route Handoff below declares in its
 * `Sources` payload -- the same pair `resolve()` supplies as the caller's own
 * operational tokens, so nothing here contradicts anything.
 */
const ENTITY_TOKEN_ENTRY = "token:entity:E-47";
const MATTER_TOKEN_ENTRY = "token:matter:M-12";
const TOKEN_ENTRIES = [ENTITY_TOKEN_ENTRY, MATTER_TOKEN_ENTRY];

const isTokenEntry = (entry: string) => entry.startsWith("token:");

/**
 * The `Sources` property in Notion's READ-back shape. An opaque token entry
 * travels as LINK-LESS plain text (Notion preserves such a text run
 * verbatim), which is exactly what makes a token entry distinguishable from
 * an artifact URL without a title lookup, an inference or a network search.
 * Pass `{ tokens: false }` only where a payload deliberately carries no
 * token pair (extraction-only and declared-generic-route cases).
 */
function sourcesReadShape(entries: string[], opts: { tokens?: boolean } = {}) {
  const all = opts.tokens === false ? entries : [...TOKEN_ENTRIES, ...entries];
  return {
    rich_text: all.map((entry) =>
      isTokenEntry(entry)
        ? { type: "text", text: { content: entry, link: null }, plain_text: entry, href: null }
        : { type: "text", text: { content: entry, link: { url: entry } }, plain_text: entry, href: entry },
    ),
  };
}

/** The `Sources` property in Notion's WRITE shape (text.link only, no plain_text/href). */
function sourcesWriteShape(entries: string[], opts: { tokens?: boolean } = {}) {
  const all = opts.tokens === false ? entries : [...TOKEN_ENTRIES, ...entries];
  return {
    rich_text: all.map((entry) =>
      isTokenEntry(entry)
        ? { type: "text", text: { content: entry, link: null } }
        : { type: "text", text: { content: entry, link: { url: entry } } },
    ),
  };
}

/** A `Sources` payload carrying ONLY opaque token entries -- no artifact at all. */
function tokenOnlySources() {
  return sourcesReadShape([], {});
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
                  id: MATTER_PAGE_ID,
                  url: "https://notion.so/matter",
                  parent: { type: "data_source_id", data_source_id: "matters-ds" },
                  properties: {
                    Matter_ID: { unique_id: { prefix: "M", number: 12 } },
                    Entity: { relation: [{ id: ENTITY_PAGE_ID }] },
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
    if (urlStr.endsWith(`/pages/${ENTITY_PAGE_ID}`) && method === "GET" && !opts.pages?.[ENTITY_PAGE_ID]) {
      return new Response(
        JSON.stringify({
          id: ENTITY_PAGE_ID,
          url: "https://notion.so/entity",
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
      Entity: { relation: [{ id: ENTITY_PAGE_ID }] },
      Matter: { relation: [{ id: MATTER_PAGE_ID }] },
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
      Entity: { relation: [{ id: ENTITY_PAGE_ID }] },
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

// --- app.notion.com canonical host (Issue #322) ----------------------------
// Notion's canonical page links increasingly use the exact host
// app.notion.com. The parser accepts that one host alongside notion.so and
// its subdomains -- and only that host, so no notion.com subdomain wildcard
// is opened and every existing rejection case still fails closed.

test("parse: an app.notion.com canonical page URL (/p/<32-hex>) resolves to the exact dashed page id", () => {
  assert.deepEqual(parseNotionPageLink(`https://app.notion.com/p/${CN_HEX}`), { ok: true, pageId: CN_PAGE_ID });
});

test("parse: an app.notion.com URL with a name slug and uppercase id still resolves to the exact page", () => {
  const result = parseNotionPageLink(`https://app.notion.com/Acme-Case-Notes-${CN_HEX.toUpperCase()}`);
  assert.deepEqual(result, { ok: true, pageId: CN_PAGE_ID });
});

test("parse: an app.notion.com URL carrying a workspace path segment still resolves", () => {
  assert.deepEqual(parseNotionPageLink(`https://app.notion.com/acme/${CN_PAGE_ID}`), { ok: true, pageId: CN_PAGE_ID });
});

test("parse: a notion.so subdomain (www.notion.so) still resolves -- subdomain support is preserved", () => {
  assert.deepEqual(parseNotionPageLink(`https://www.notion.so/${CN_HEX}`), { ok: true, pageId: CN_PAGE_ID });
});

test("parse: an arbitrary notion.com subdomain is refused -- app.notion.com is exact, never a wildcard", () => {
  const result = parseNotionPageLink(`https://evil.notion.com/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a notion\.so page link/);
});

test("parse: a lookalike app.notion.com subdomain is refused -- only the exact host is accepted", () => {
  const result = parseNotionPageLink(`https://evil.app.notion.com/p/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a notion\.so page link/);
});

test("parse: the bare notion.com apex host is refused", () => {
  const result = parseNotionPageLink(`https://www.notion.com/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a notion\.so page link/);
});

test("parse: an app.notion.com database path link is refused -- a database is not a page", () => {
  const result = parseNotionPageLink(`https://app.notion.com/acme/database/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /database\/data-source\/view link/);
});

test("parse: an app.notion.com data-source path link is refused", () => {
  const result = parseNotionPageLink(`https://app.notion.com/acme/data_source/${CN_HEX}`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /database\/data-source\/view link/);
});

test("parse: an app.notion.com ?v= database-view parameter is refused -- it names a view, not a page", () => {
  const result = parseNotionPageLink(`https://app.notion.com/acme/${CN_HEX}?v=0123456789abcdef0123456789abcdef`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /database-view parameter/);
});

test("parse: an app.notion.com URL with no page id anywhere is refused", () => {
  const result = parseNotionPageLink("https://app.notion.com/Acme-Case-Notes");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no Notion page id/);
});

// ---------------------------------------------------------------------------
// Extraction: the compatibility seam, and the shapes a present property can take.
// ---------------------------------------------------------------------------

test("extraction: a Handoff with no Sources property is legacy -- and resolves without a single fetch", async (t) => {
  const log = mockSourcesFetch(t, {});
  // Extraction reports the absence; what that MEANS is the route contract's
  // decision (see the resolution tests below for both branches).
  assert.deepEqual(extractHandoffSources(handoffProperties()), { ok: true, mode: "legacy" });
  assert.equal(log.requests.length, 0, "an absent Sources property is decided without a single fetch");
});

test("extraction: null Sources property is legacy too", () => {
  assert.deepEqual(extractHandoffSources(handoffProperties({ Sources: null })), { ok: true, mode: "legacy" });
});

test("extraction: escaped-colon fragmented rich text reconstructs token entries", () => {
  const escaped = {
    rich_text: [
      { type: "text", text: { content: "token\\:entity\\:ENT-30\ntoken\\:matter\\:MAT-31\n", link: null }, plain_text: "token\\:entity\\:ENT-30\ntoken\\:matter\\:MAT-31\n", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: escaped }));
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "token", tokenKind: "entity", token: "ENT-30" },
      { kind: "token", tokenKind: "matter", token: "MAT-31" },
    ],
    tokens: { entityToken: "ENT-30", matterToken: "MAT-31" },
  });
});

test("extraction: incomplete escaped token prefix fails closed", () => {
  const bad = {
    rich_text: [
      { type: "text", text: { content: "token\\", link: null }, plain_text: "token\\", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: bad }));
  assert.equal(result.ok, false);
});

test("extraction: fragmented rich text reconstructs token entries (HO-93 shape)", () => {
  const ho93 = {
    rich_text: [
      { type: "text", text: { content: "token", link: null }, plain_text: "token", href: null },
      { type: "text", text: { content: ":entity:", link: null }, plain_text: ":entity:", href: null },
      { type: "text", text: { content: "ENT-30\ntoken", link: null }, plain_text: "ENT-30\ntoken", href: null },
      { type: "text", text: { content: ":matter:", link: null }, plain_text: ":matter:", href: null },
      { type: "text", text: { content: "MAT-31\n", link: null }, plain_text: "MAT-31\n", href: null },
      { type: "mention", mention: { type: "page", page: { id: "402cb004-e583-81c1-b91f-e5f15cc60b41" } }, plain_text: "TEST-ENIG-HANDOFF-2026-10-23", href: "https://app.notion.com/p/402cb004e58381c1b91fe5f15cc60b41" },
      { type: "mention", mention: { type: "page", page: { id: "402cb004-e583-817c-951f-e9cd8f9bf1f2" } }, plain_text: "TEST-ENIG-HANDOFF-2026-10-23", href: "https://app.notion.com/p/402cb004e583817c951fe9cd8f9bf1f2" },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: ho93 }));
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "token", tokenKind: "entity", token: "ENT-30" },
      { kind: "token", tokenKind: "matter", token: "MAT-31" },
      { kind: "notion", pageId: "402cb004-e583-81c1-b91f-e5f15cc60b41" },
      { kind: "notion", pageId: "402cb004-e583-817c-951f-e9cd8f9bf1f2" },
    ],
    tokens: { entityToken: "ENT-30", matterToken: "MAT-31" },
  });
});

test("extraction: an empty or whitespace-only plain_text falls back to the item's text.content", () => {
  const drifted = {
    rich_text: [
      { type: "text", text: { content: "token:entity:ENT-30", link: null }, plain_text: "", href: null },
      { type: "text", text: { content: "token:matter:MAT-31", link: null }, plain_text: "   ", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: drifted }));
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "token", tokenKind: "entity", token: "ENT-30" },
      { kind: "token", tokenKind: "matter", token: "MAT-31" },
    ],
    tokens: { entityToken: "ENT-30", matterToken: "MAT-31" },
  });
});

test("extraction: an item carrying no usable text in either field is ignored, and a Sources property with nothing usable still fails closed", () => {
  const unusable = {
    rich_text: [
      { type: "text", text: { content: "   ", link: null }, plain_text: "", href: null },
      { type: "text", text: { link: null }, plain_text: null, href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: unusable }));
  assert.equal(result.ok, false);
});

test("extraction: an entity token split after its kind prefix is reconstructed from the adjacent fragment", () => {
  const split = {
    rich_text: [
      { type: "text", text: { content: "token:entity:", link: null }, plain_text: "token:entity:", href: null },
      { type: "text", text: { content: "ENT-30", link: null }, plain_text: "ENT-30", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: split }));
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [{ kind: "token", tokenKind: "entity", token: "ENT-30" }],
    tokens: { entityToken: "ENT-30" },
  });
});

test("extraction: a matter token split after its kind prefix is reconstructed from the adjacent fragment", () => {
  const split = {
    rich_text: [
      { type: "text", text: { content: "token:matter:", link: null }, plain_text: "token:matter:", href: null },
      { type: "text", text: { content: "MAT-31", link: null }, plain_text: "MAT-31", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: split }));
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [{ kind: "token", tokenKind: "matter", token: "MAT-31" }],
    tokens: { matterToken: "MAT-31" },
  });
});

test("extraction: an incomplete token with no continuation fails closed", () => {
  const incomplete = {
    rich_text: [
      { type: "text", text: { content: "token:entity:", link: null }, plain_text: "token:entity:", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: incomplete }));
  assert.equal(result.ok, false);
});

test("extraction: a reconstructed token that is malformed fails closed", () => {
  const malformed = {
    rich_text: [
      { type: "text", text: { content: "token:entity:", link: null }, plain_text: "token:entity:", href: null },
      { type: "text", text: { content: "not-a-valid-token", link: null }, plain_text: "not-a-valid-token", href: null },
    ],
  };
  const result = extractHandoffSources(handoffProperties({ Sources: malformed }));
  assert.equal(result.ok, false);
});

test("extraction: a present property with one link resolves its exact page id (read shape)", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL], { tokens: false }) }));
  assert.deepEqual(result, { ok: true, mode: "sources", refs: [{ kind: "notion", pageId: CN_PAGE_ID }], tokens: {} });
});

test("extraction: a present property in the write shape (text.link only) resolves too", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: sourcesWriteShape([CN_PAGE_URL], { tokens: false }) }));
  assert.deepEqual(result, { ok: true, mode: "sources", refs: [{ kind: "notion", pageId: CN_PAGE_ID }], tokens: {} });
});

test("extraction: an opaque token entry round-trips through Notion's rich text as link-less plain text", () => {
  // Write shape (what sourcesRichText produces) -> read shape (what Notion
  // hands back) -> the same pair, in order, with no link on either entry.
  const written = sourcesWriteShape([], {});
  const readBack = {
    rich_text: written.rich_text.map((item: any) => ({
      type: "text",
      text: { content: item.text.content, link: item.text.link ?? null },
      plain_text: item.text.content,
      href: item.text.link?.url ?? null,
    })),
  };
  const result = extractHandoffSources(handoffProperties({ Sources: readBack }));
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "token", tokenKind: "entity", token: "E-47" },
      { kind: "token", tokenKind: "matter", token: "M-12" },
    ],
    tokens: { entityToken: "E-47", matterToken: "M-12" },
  });
});

test("extraction: token entries and artifact URLs coexist in one payload and stay distinguishable", () => {
  const result = extractHandoffSources(
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`, CN_PAGE_URL]) }),
  );
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "token", tokenKind: "entity", token: "E-47" },
      { kind: "token", tokenKind: "matter", token: "M-12" },
      { kind: "notion", pageId: MATTER_PAGE_ID },
      { kind: "notion", pageId: CN_PAGE_ID },
    ],
    tokens: { entityToken: "E-47", matterToken: "M-12" },
  });
});

test("extraction: an app.notion.com canonical page link in Sources resolves to the exact page id (Issue #322)", () => {
  const result = extractHandoffSources(
    handoffProperties({ Sources: sourcesReadShape([`https://app.notion.com/p/${CN_HEX}`]) }),
  );
  assert.deepEqual(result, {
    ok: true,
    mode: "sources",
    refs: [
      { kind: "token", tokenKind: "entity", token: "E-47" },
      { kind: "token", tokenKind: "matter", token: "M-12" },
      { kind: "notion", pageId: CN_PAGE_ID },
    ],
    tokens: { entityToken: "E-47", matterToken: "M-12" },
  });
});

test("extraction: a token-shaped entry carrying a malformed token is refused, never treated as arbitrary text", () => {
  for (const [entry, matcher] of [
    ["token:entity:", /not an opaque token entry/],
    ["token:contact:ENT-28", /not an opaque token entry/],
    ["token:entity:ent-28", /not a syntactically valid opaque entity token/],
    ["token:entity:ENT", /not a syntactically valid opaque entity token/],
    ["token:matter:MAT-20-EXTRA", /not a syntactically valid opaque matter token/],
  ] as const) {
    const bad = extractHandoffSources(
      handoffProperties({ Sources: { rich_text: [{ type: "text", text: { content: entry, link: null }, plain_text: entry, href: null }] } }),
    );
    assert.equal(bad.ok, false, `"${entry}" must not be accepted`);
    if (bad.ok) continue;
    assert.match(bad.reason, matcher, `"${entry}" must say what is wrong with it`);
  }
});

test("extraction: a second token of the same kind is refused -- which token names the Entity is never ambiguous", () => {
  const payload = sourcesReadShape([], {});
  payload.rich_text.push({ type: "text", text: { content: "token:entity:ENT-28", link: null }, plain_text: "token:entity:ENT-28", href: null } as any);
  const result = extractHandoffSources(handoffProperties({ Sources: payload }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /more than one entity token/);
});

test("extraction: a present property carrying no link at all is refused -- nothing is inferred to fill it", () => {
  const result = extractHandoffSources(handoffProperties({ Sources: { rich_text: [] } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /carries no entry/);
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
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
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
    /route "Finance->Strategy" has no Handoff source route contract/,
    { fromUnit: "Finance", toUnit: "Strategy" },
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
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: ["matters"], optional: ["call_notes"], prohibited: ["handoffs"] },
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
    tokens: { entityToken: "E-47", matterToken: "M-12" },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /does not resolve to real, correctly-related Entity\/Matter records/);
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
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
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
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [MATTER_PAGE_ID]: matterPageFixture({ Entity: { relation: [{ id: "some-other-entity" }] } }) },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    /not related to the Entity page this Handoff's Entity token resolves to/,
    { contracts },
  );
});

test("sources: an Entity source that is not this Handoff's Entity is refused (injected contract)", async (t) => {
  // The refusal happens at the ONE binding resolution, not in a second
  // reader: a page whose `Entity_ID` disagrees with the declared token
  // cannot be this Handoff's Entity, so the token pair never resolves to a
  // real, correctly-related pair and nothing binds. Nothing searches for a
  // record that would agree instead.
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["entities"], prohibited: ["handoffs"] },
  });
  await expectRefused(
    t,
    { [ENTITY_PAGE_ID]: entityPageFixture({ Entity_ID: { unique_id: { prefix: "E", number: 99 } } }) },
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${ENTITY_HEX}`]) }),
    /does not resolve to real, correctly-related Entity\/Matter records/,
    { contracts },
  );
});

test("sources: a correctly bound Matter source resolves (injected contract)", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [MATTER_PAGE_ID]: matterPageFixture() } });
  const contracts = routeContracts({
    ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["matters"], prohibited: ["handoffs"] },
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
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${PROPOSALS_HEX}`], { tokens: false }) }),
    /no per-type source validation is implemented for proposals/,
    { contracts: { ...HANDOFF_SOURCE_ROUTE_CONTRACTS, "Sales->Strategy": { requiresEntityToken: false, requiresMatterToken: false, required: [], optional: ["proposals"], prohibited: [] } } },
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
    "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["call_notes", "matters"], prohibited: ["handoffs"] },
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

test("sources: the production route table declares, per route, the tokens it requires and the artifact types it permits", () => {
  assert.deepEqual(handoffSourceRouteContract("Sales", "Strategy"), {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    // The commercial route needs an Entity and a Matter, so the canonical
    // pages that carry them are permitted references whose relationship is
    // checked against the token-derived binding -- alongside its approved
    // Call Notes evidence record.
    optional: ["call_notes", "entities", "matters"],
    prohibited: ["handoffs"],
  });
  // Strategy -> Finance is contracted EXPLICITLY (LOG-1140 and LOG-1149),
  // not reached by any fallback: its opaque Entity/Matter tokens are
  // required outright (the quote is priced for one Matter of one Entity),
  // the upstream Handoff's canonical Call Notes reference may ride
  // alongside, and a Handoff is never evidence for another Handoff.
  assert.deepEqual(handoffSourceRouteContract("Strategy", "Finance"), {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: ["call_notes", "entities", "matters"],
    prohibited: ["handoffs"],
  });
  // Finance -> Sales, Strategy -> Marketing and Strategy -> Sales carry the
  // same identity requirement for the same reason: each Handoff is about one
  // Matter of one Entity, and the receiving Unit's pickup and the Work it
  // creates need that binding. These entries exist so retiring the separate
  // token properties costs those routes nothing.
  for (const [from, to] of [
    ["Finance", "Sales"],
    ["Strategy", "Marketing"],
    ["Strategy", "Sales"],
  ] as const) {
    assert.deepEqual(
      handoffSourceRouteContract(from, to),
      { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: [], prohibited: ["handoffs"] },
      `${from} -> ${to}`,
    );
  }
  // An uncontracted route still has NO contract -- nothing is granted by
  // fallback or inference, exactly as before.
  assert.equal(handoffSourceRouteContract("Finance", "Strategy"), undefined, "an uncontracted route has no contract until one is declared");
  // Genericity is a declared contract fact, never an absence of one: every
  // contracted commercial route needs an Entity/Matter, and an uncontracted
  // route needs them too (nothing has declared it generic), exactly as before.
  assert.equal(handoffRouteRequiresEntityMatter("Sales", "Strategy"), true);
  assert.equal(handoffRouteRequiresEntityMatter("Strategy", "Finance"), true, "the Strategy -> Finance contract declares its own Entity/Matter requirement -- it is not generic");
  assert.equal(handoffRouteRequiresEntityMatter("Finance", "Strategy"), true, "no contract means no generic declaration -- Entity/Matter stays required");
});

test("sources: a Sources-enabled Strategy -> Finance Handoff resolves -- its opaque tokens establish the binding, its canonical Entity/Matter sources are cross-checked against it, and the forwarded Call Notes reference validates against that binding", async (t) => {
  const log = mockSourcesFetch(t, {
    pages: {
      [CN_PAGE_ID]: await callNotesPageFixture({
        Entity: { relation: [{ id: ENTITY_PAGE_ID }] },
        Matter: { relation: [{ id: MATTER_PAGE_ID }] },
      }),
      [MATTER_PAGE_ID]: matterPageFixture({ Entity: { relation: [{ id: ENTITY_PAGE_ID }] } }),
      [ENTITY_PAGE_ID]: entityPageFixture(),
    },
  });
  const result = await resolve(
    handoffProperties({
      Reason: rich("Martin-approved Strategic Intervention Proposal ready for value-based pricing."),
      "From Unit": { select: { name: "Strategy" } },
      "To Unit": { select: { name: "Finance" } },
      Sources: sourcesReadShape([`https://www.notion.so/${ENTITY_HEX}`, `https://www.notion.so/${MATTER_HEX}`, CN_PAGE_URL]),
    }),
    // The shape Strategy's producer writes: the two opaque tokens plus the
    // forwarded artifacts, and no caller-held tokens at all.
    { fromUnit: "Strategy", toUnit: "Finance", tokens: { entityToken: "", matterToken: "" } },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;
  assert.deepEqual(
    result.sources.map((s) => s.type),
    ["entities", "matters", "call_notes"],
  );
  assert.equal(result.binding.entityId, ENTITY_PAGE_ID);
  assert.equal(result.binding.matterId, MATTER_PAGE_ID);
  assert.equal(result.binding.entityToken, "E-47", "the operational token is the one the Handoff's own Sources payload declared");
  assert.equal(result.callNotes?.callNotesId, "CN-007", "the forwarded Call Notes reference validates against this Handoff's binding");
  assert.equal(log.writes.length, 0, "resolution never writes");
});

test("sources: the Strategy -> Finance token requirement is enforced at resolution -- a Sources-enabled Handoff of that route missing the Entity token is refused, never substituted by a page or treated as legacy", async (t) => {
  await expectRefused(
    t,
    {
      [CN_PAGE_ID]: await callNotesPageFixture({ Matter: { relation: [{ id: MATTER_PAGE_ID }] } }),
      [MATTER_PAGE_ID]: matterPageFixture(),
    },
    handoffProperties({
      Reason: rich("Martin-approved Strategic Intervention Proposal ready for value-based pricing."),
      "From Unit": { select: { name: "Strategy" } },
      "To Unit": { select: { name: "Finance" } },
      // A canonical Matter page and a Call Notes page, but NO Entity token
      // entry: the Matter page must never stand in for the missing token.
      Sources: sourcesReadShape([MATTER_TOKEN_ENTRY, `https://www.notion.so/${MATTER_HEX}`, CN_PAGE_URL], { tokens: false }),
    }),
    /requires an opaque Entity token/,
    { fromUnit: "Strategy", toUnit: "Finance", tokens: { entityToken: "", matterToken: "" } },
  );
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
      { kind: "token", tokenKind: "entity", token: "E-47" },
      { kind: "token", tokenKind: "matter", token: "M-12" },
      { kind: "notion", pageId: CN_PAGE_ID },
      { kind: "google", type: "google_doc", fileId: GDOC_FILE_ID },
    ],
    tokens: { entityToken: "E-47", matterToken: "M-12" },
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
  "Sales->Strategy": { requiresEntityToken: true, requiresMatterToken: true, required: [], optional: ["call_notes", "google_doc", "google_sheet"], prohibited: ["handoffs"] },
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

function boundWorkState(overrides: { entityId?: string; matterId?: string } = { matterId: MATTER_PAGE_ID, entityId: ENTITY_PAGE_ID }) {
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
    readBoundWorkState: boundWorkState({ matterId: "matter-page-OTHER", entityId: ENTITY_PAGE_ID }),
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

// ---------------------------------------------------------------------------
// Source-based identity: the binding a Handoff's OWN opaque token entries
// establish (resolved through the authorized operational stores), and the
// consumer entry point every Unit goes through.
// ---------------------------------------------------------------------------

/** A contract table whose BD->Strategy route is declared GENERIC (no Entity/Matter at all). */
const GENERIC_ROUTE_CONTRACTS = routeContracts({
  ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
  "BD->Strategy": {
    requiresEntityToken: false,
    requiresMatterToken: false,
    required: [],
    optional: ["call_notes"],
    prohibited: ["handoffs", "entities", "matters"],
  },
});

test("sources: a Handoff's binding comes from its opaque token entries, and its canonical Entity/Matter sources are cross-checked against it", async (t) => {
  const log = mockSourcesFetch(t, {
    pages: {
      [ENTITY_PAGE_ID]: entityPageFixture(),
      [MATTER_PAGE_ID]: matterPageFixture(),
      [CN_PAGE_ID]: await callNotesPageFixture(),
    },
  });
  // The caller holds no tokens at all: the payload alone carries the identity.
  const result = await resolve(
    handoffProperties({
      Sources: sourcesReadShape([`https://www.notion.so/${ENTITY_HEX}`, `https://www.notion.so/${MATTER_HEX}`, CN_PAGE_URL]),
    }),
    { tokens: { entityToken: "", matterToken: "" } },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok || result.mode !== "sources") return;
  assert.deepEqual(result.binding, {
    entityId: ENTITY_PAGE_ID,
    matterId: MATTER_PAGE_ID,
    entityToken: "E-47",
    matterToken: "M-12",
    matterStatus: "Qualified",
  });
  assert.deepEqual(
    result.sources.map((s) => s.id).sort(),
    [ENTITY_PAGE_ID, MATTER_PAGE_ID, CN_PAGE_ID].sort(),
    "every declared reference is recorded, including the ones cross-checked against the binding",
  );
  assert.equal(result.callNotes?.callNotesId, "CN-007", "the Call Notes source is validated against the token-derived binding");
  assert.equal(log.callNotesQueries.length, 0, "no title-based lookup anywhere");
  assert.equal(log.writes.length, 0, "resolution is read-only");
});

test("sources: artifact URLs are PRESERVED, never replaced by the Entity/Matter pages the tokens resolve to", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture() } });
  const result = await resolve(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }));
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.deepEqual(
    result.ok && result.mode === "sources" ? result.sources : null,
    [{ type: "call_notes", id: CN_PAGE_ID }],
    "exactly the declared artifact -- no Entity or Matter page is appended to the payload",
  );
  assert.equal(
    log.requests.filter((r) => r === `GET https://api.notion.com/v1/pages/${CN_PAGE_ID}`).length,
    1,
    "the declared artifact is fetched exactly once",
  );
});

test("sources: a token pair that does not resolve to real, correctly-related records is refused -- no page is substituted for a token", async (t) => {
  const log = mockSourcesFetch(t, { resolves: false });
  const result = await resolve(handoffProperties({ Sources: tokenOnlySources() }));
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.match(result.reason, /does not resolve to real, correctly-related Entity\/Matter records/);
  assert.equal(log.writes.length, 0, "a refusal must issue no write at all");
  assert.equal(log.callNotesQueries.length, 0, "a refusal must never fall back to a database search");
});

test("sources: a Handoff whose Sources declares NO token pair is refused on a route that requires an Entity/Matter -- the retired token properties are read nowhere", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [CN_PAGE_ID]: await callNotesPageFixture() } });
  const result = await resolve(handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL], { tokens: false }) }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /requires an opaque Entity token/);
  assert.equal(log.requests.length, 0, "the token requirement is decided before a single fetch");
});

test("sources: a route that requires neither token refuses one that arrives anyway -- the route does not deal in it", async (t) => {
  await expectRefused(
    t,
    {},
    handoffProperties({
      "From Unit": { select: { name: "BD" } },
      Reason: rich("Fit approved."),
      Sources: {
        rich_text: [
          { type: "text", text: { content: ENTITY_TOKEN_ENTRY, link: null }, plain_text: ENTITY_TOKEN_ENTRY, href: null },
        ],
      },
    }),
    /carries an Entity token, but route BD->Strategy does not require one/,
    { fromUnit: "BD", toUnit: "Strategy", contracts: GENERIC_ROUTE_CONTRACTS },
  );
});

test("sources: a Handoff with no Sources at all is refused on a route that requires an Entity/Matter -- absence is never a fallback", async (t) => {
  const log = mockSourcesFetch(t, {});
  const result = await resolve(
    handoffProperties({ Entity_Token: rich("E-47"), Matter_Token: rich("M-12") }),
    { tokens: { entityToken: "", matterToken: "" } },
  );
  assert.equal(result.ok, false, "no Sources means no identity, whatever the retired columns may have said");
  if (result.ok) return;
  assert.match(result.reason, /declares no "Sources" property/);
  assert.equal(log.requests.length, 0, "the refusal performs no fetch -- nothing is read to fill the gap");
});

// ---------------------------------------------------------------------------
// Missing `Sources` on a declared-generic route: the contract's REQUIRED
// artifacts are enforced in the same decision as its identity requirements.
// A required artifact can only travel inside Sources, so an absent property
// that would silently bypass a `required` entry must refuse -- while a
// generic route with no required artifact keeps its legitimate compatibility
// path (no fetch, no invented identity).
// ---------------------------------------------------------------------------

const GENERIC_ROUTE_REQUIRING_CALL_NOTES = routeContracts({
  ...HANDOFF_SOURCE_ROUTE_CONTRACTS,
  "BD->Strategy": {
    requiresEntityToken: false,
    requiresMatterToken: false,
    required: ["call_notes"],
    optional: [],
    prohibited: ["handoffs", "entities", "matters"],
  },
});

test("missing Sources: a declared-generic route with NO required artifact accepts an absent Sources -- the legitimate compatibility case, with no fetch", async (t) => {
  const log = mockSourcesFetch(t, {});
  const result = await resolve(handoffProperties({ Reason: rich("Fit approved.") }), {
    fromUnit: "BD",
    toUnit: "Strategy",
    contracts: GENERIC_ROUTE_CONTRACTS,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.equal(result.mode, "legacy", "a generic route with no required artifact keeps the legacy compatibility mode");
  assert.equal(log.requests.length, 0, "nothing is fetched to fill a binding this route does not use");
});

test("missing Sources: a declared-generic route that still REQUIRES an artifact refuses an absent Sources -- a required source is never bypassed by the missing property", async (t) => {
  const log = mockSourcesFetch(t, {});
  const result = await resolve(handoffProperties({ Reason: rich("Fit approved.") }), {
    fromUnit: "BD",
    toUnit: "Strategy",
    contracts: GENERIC_ROUTE_REQUIRING_CALL_NOTES,
  });
  assert.equal(result.ok, false, "a required artifact cannot be supplied without Sources, so the absence must refuse, not pass through as legacy");
  if (result.ok) return;
  assert.match(result.reason, /requires a call_notes source/, "the refusal names the exact artifact whose requirement was bypassed");
  assert.match(result.reason, /absent property is refused rather than the contract's requirement skipped/);
  assert.equal(log.requests.length, 0, "the refusal performs no fetch -- the contract alone decides");
  assert.equal(log.writes.length, 0, "a refusal issues no write");
});

test("missing Sources: the required-artifact refusal surfaces through resolveHandoffContextBinding too -- consumers share the one contract", async (t) => {
  const log = mockSourcesFetch(t, {});
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: handoffProperties({ Reason: rich("Fit approved.") }),
    route: { fromUnit: "BD", toUnit: "Strategy" },
    access: pickupContext(),
    contracts: GENERIC_ROUTE_REQUIRING_CALL_NOTES,
  });
  assert.equal(binding.ok, false, "a consumer must not receive an empty legacy binding that skipped a required artifact");
  if (binding.ok) return;
  assert.match(binding.reason, /requires a call_notes source/);
  assert.equal(log.requests.length, 0, "the refusal performs no fetch");
});

test("sources: a caller-supplied token that CONTRADICTS the token the Sources payload declares fails closed", async (t) => {
  const log = mockSourcesFetch(t, { pages: { [MATTER_PAGE_ID]: matterPageFixture() } });
  const result = await resolve(
    handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    { tokens: { entityToken: "ENT-28", matterToken: "M-12" } },
  );
  assert.equal(result.ok, false, "a contradiction between the caller's token and the payload's token must refuse");
  if (result.ok) return;
  assert.match(result.reason, /contradicts the Entity token/);
  assert.equal(log.writes.length, 0, "a refusal issues no write");
});

test("sources: lifecycle validation runs on the token-derived binding too -- a non-current Call Notes Status is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ Status: { select: { name: "Draft" } } }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /only Ready or Consumed carries current approved evidence/,
  );
});

test("sources: approval validation runs on the token-derived binding too -- an unverifiable attestation is refused", async (t) => {
  await expectRefused(
    t,
    { [CN_PAGE_ID]: await callNotesPageFixture({ "Approval Attestation": rich("record_approval result=Approved") }) },
    handoffProperties({ Sources: sourcesReadShape([CN_PAGE_URL]) }),
    /does not carry a valid recorded approval attestation/,
  );
});

test("resolveHandoffContextBinding: a Handoff with no Sources on a route that requires an Entity/Matter is refused -- the retired token properties are read nowhere", async (t) => {
  const log = mockSourcesFetch(t, {});
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: {
      ...handoffProperties(),
      Entity_Token: rich("E-47"),
      Matter_Token: rich("M-12"),
    },
    route: { fromUnit: "Sales", toUnit: "Strategy" },
    access: pickupContext(),
  });
  assert.equal(binding.ok, false, "no Sources means no identity, whatever the retired columns may have said");
  if (binding.ok) return;
  assert.match(binding.reason, /declares no "Sources" property/);
  assert.equal(log.requests.length, 0, "the refusal performs no fetch");
});

test("resolveHandoffContextBinding: a Sources-enabled Handoff returns the PROVED binding its token entries establish", async (t) => {
  mockSourcesFetch(t, {
    pages: {
      [ENTITY_PAGE_ID]: entityPageFixture(),
      [MATTER_PAGE_ID]: matterPageFixture({ Status: { select: { name: "Qualified" } } }),
    },
  });
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: handoffProperties({
      Reason: rich("Commercial fit approved."),
      Sources: sourcesReadShape([`https://www.notion.so/${ENTITY_HEX}`, `https://www.notion.so/${MATTER_HEX}`]),
    }),
    route: { fromUnit: "Sales", toUnit: "Strategy" },
    access: pickupContext(),
  });
  assert.equal(binding.ok, true, binding.ok ? "" : binding.reason);
  if (!binding.ok || binding.mode !== "sources") return;
  assert.equal(binding.entityToken, "E-47");
  assert.equal(binding.matterToken, "M-12");
  assert.equal(binding.binding.matterId, MATTER_PAGE_ID);
  assert.equal(binding.binding.matterStatus, "Qualified", "the Matter's live Status travels with the binding");
});

test("resolveHandoffContextBinding: a canonical source that DISAGREES with the token-derived binding fails closed -- a page never redefines identity", async (t) => {
  mockSourcesFetch(t, {
    pages: { [MATTER_PAGE_ID]: matterPageFixture({ Matter_ID: { unique_id: { prefix: "M", number: 99 } } }) },
  });
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: handoffProperties({ Sources: sourcesReadShape([`https://www.notion.so/${MATTER_HEX}`]) }),
    route: { fromUnit: "Sales", toUnit: "Strategy" },
    access: pickupContext(),
  });
  assert.equal(binding.ok, false, "a source that disagrees with the Handoff's own token must refuse");
  if (binding.ok) return;
  assert.match(binding.reason, /is not this Handoff's Matter/);
});

test("resolveHandoffContextBinding: a route declared generic resolves a Handoff carrying neither sources nor tokens -- no fetch, no requirement", async (t) => {
  const log = mockSourcesFetch(t, {});
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: handoffProperties({ "From Unit": { select: { name: "BD" } }, Reason: rich("Fit approved.") }),
    route: { fromUnit: "BD", toUnit: "Strategy" },
    access: pickupContext(),
    contracts: GENERIC_ROUTE_CONTRACTS,
  });
  assert.equal(binding.ok, true, binding.ok ? "" : binding.reason);
  if (!binding.ok || binding.mode !== "legacy") return;
  assert.equal(binding.entityToken, "", "a generic Handoff carries no Entity identity, and none is invented");
  assert.equal(binding.matterToken, "", "a generic Handoff carries no Matter identity, and none is invented");
  assert.equal(log.requests.length, 0, "nothing is fetched to fill an identity this route does not use");
});

test("resolveHandoffContextBinding: a Handoff with no Sources is refused on every OTHER route -- genericity is declared, never inferred from an absent contract", async () => {
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: handoffProperties({ Reason: rich("Fit approved."), "From Unit": { select: { name: "BD" } } }),
    route: { fromUnit: "BD", toUnit: "Strategy" },
    access: pickupContext(),
  });
  assert.equal(binding.ok, false, "no contract means no generic declaration -- an uncontracted route stays bound");
  if (binding.ok) return;
  assert.match(binding.reason, /requires an Entity\/Matter binding/);
});

test("resolveHandoffContextBinding: an UNCONTRACTED route with sources is refused -- genericity is declared, never inferred from an absent contract", async () => {
  const binding = await resolveHandoffContextBinding(fakeEnv(), {
    properties: handoffProperties({
      Reason: rich("Fit approved."),
      "From Unit": { select: { name: "BD" } },
      Sources: sourcesReadShape([CN_PAGE_URL]),
    }),
    route: { fromUnit: "BD", toUnit: "Strategy" },
    access: pickupContext(),
  });
  assert.equal(binding.ok, false, "no contract means no generic declaration -- an uncontracted route stays bound");
  if (binding.ok) return;
  assert.match(binding.reason, /has no Handoff source route contract/);
});

// ---------------------------------------------------------------------------
// The operational-store boundary: identity is resolved through the canonical
// Matters and Entities records ONLY. The Isolated Sales Identity Resolution
// Registry is not a source ENIG may ask, and no second resolution path exists.
// ---------------------------------------------------------------------------

test("sources: a full token binding resolution queries ONLY the canonical Matters store -- the Identity Resolution Registry is never reachable", async (t) => {
  const log = mockSourcesFetch(t, {});
  const result = await resolve(
    handoffProperties({ Reason: rich("Fit approved."), Sources: tokenOnlySources() }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  const dataSourcesQueried = log.requests
    .filter((r) => r.includes("/data_sources/") && r.includes("/query"))
    .map((r) => r.split("/data_sources/")[1].split("/query")[0]);
  assert.ok(dataSourcesQueried.length > 0, "the identity resolution must have issued its canonical unique-id query");
  assert.deepEqual(
    [...new Set(dataSourcesQueried)],
    ["matters-ds"],
    "the ONLY data source identity resolution may query is the canonical Matters store",
  );
  assert.equal(log.callNotesQueries.length, 0, "no free-text search stands in for the direct reference");
});

test("identity resolution: src/identityResolution.ts is hard-wired to the canonical Matters store and can name no other data source", () => {
  const source = readFileSync(join(__dirname, "identityResolution.ts"), "utf8");
  const queried = [...source.matchAll(/queryDataSource\(\s*env,\s*([A-Za-z_.]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(queried)], ["env.MATTERS_DATA_SOURCE_ID"], "one store, named once, reachable only through env");
  assert.ok(
    !/DATA_SOURCE_ID\b/.test(source.replace(/MATTERS_DATA_SOURCE_ID/g, "")),
    "identityResolution.ts names no data source other than the Matters store -- the Identity Resolution Registry is not even addressable from it",
  );
});
