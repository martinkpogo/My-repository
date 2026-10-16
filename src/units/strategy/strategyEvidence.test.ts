import test from "node:test";
import assert from "node:assert/strict";
import { readApprovedCallNotesEvidence } from "./strategyEvidence";
import { buildRecordApprovalMarker, type CallNotesApprovalRecord } from "../../records/callNotes/callNotesMarker";
import { workSessionContext } from "../../access";
import type { Env, WorkState } from "../../types";

/**
 * Strategy's evidence retrieval at the seam where a Handoff's properties
 * become its evidence base. Both governed transports are exercised here
 * against the SAME record: the legacy free-text `Call_Notes_ID` reference
 * (a query on the Call Notes store), and the direct-page `Sources`
 * property (an exact page fetch). The invariants the operating model
 * promises hold for both: read-only (nothing is ever consumed here),
 * attestation verified before any body is read, a body that only points at
 * evidence refused rather than presented, and -- the point of the Sources
 * path -- no search ever standing in for a direct reference, nor a direct
 * reference silently downgraded to one.
 */

const REGISTRY: CallNotesApprovalRecord = {
  callNotesId: "CN-007",
  entity: "E-47",
  matter: "M-12",
  callDate: "2026-09-28",
  callType: "Discovery",
  sourceId: "SRC-1",
  sourceType: "Sales Call",
  version: 1,
};

const SOURCES_PAGE_ID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const SOURCES_PAGE_URL = `https://www.notion.so/Acme-Call-Notes-aaaa1111-bbbb-2222-cccc-3333dddd4444`;

/** Distinct from every registry field, so "the body reached the evidence" is unambiguous. */
const BODY =
  "Direct client statement: the quarterly reporting pack takes four staff days to assemble because three systems disagree on project codes.";

function fakeEnv(): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: {
      get: async () => null,
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

/** Strategy's own read context: a Work recording the `diagnose` Action. */
function strategyContext() {
  const state: WorkState = {
    workId: "work_evidence_1",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
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

function properties(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    Reason: rich("Call notes for commercial qualification. Call_Notes_ID: CN-007"),
    "From Unit": { select: { name: "Sales" } },
    "To Unit": { select: { name: "Strategy" } },
    ...overrides,
  };
}

function sourcesProperty(urls: string[]) {
  return {
    rich_text: urls.map((url) => ({ type: "text", text: { content: url, link: { url } }, plain_text: url, href: url })),
  };
}

interface MockLog {
  /** Every request, as `METHOD url`. */
  requests: string[];
  /** Every query issued against the Call Notes store -- the search only the legacy transport may make. */
  callNotesQueries: any[];
  /** Page ids whose body blocks were actually read. */
  blockReads: string[];
}

async function recordFixture(
  pageId: string,
  overrides: Record<string, any> = {},
  registry: CallNotesApprovalRecord = REGISTRY,
): Promise<any> {
  const marker = await buildRecordApprovalMarker(registry, "Approved");
  return {
    id: pageId,
    url: `https://notion.so/${pageId}`,
    parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
    properties: {
      "Call Notes ID": { title: [{ plain_text: registry.callNotesId }] },
      "Call Date": { date: { start: registry.callDate } },
      "Call Type": { select: { name: registry.callType } },
      "Source ID": { rich_text: [{ plain_text: registry.sourceId }] },
      "Source Type": { select: { name: registry.sourceType } },
      Status: { select: { name: "Ready" } },
      Version: { number: registry.version },
      Entity: { relation: [{ id: "entity-page-1" }] },
      Matter: { relation: [{ id: "matter-page-1" }] },
      "Approval Attestation": { rich_text: [{ plain_text: marker }] },
      ...overrides,
    },
  };
}

function mockEvidenceFetch(
  t: any,
  opts: {
    /** The page the Sources URLs name; defaults to a valid canonical record. */
    sourcesPage?: any;
    /** The record the LEGACY exact-title query returns. */
    queryRecord?: any;
    /** The body blocks served for any page id. */
    body?: string;
  } = {},
): MockLog {
  const originalFetch = globalThis.fetch;
  const log: MockLog = { requests: [], callNotesQueries: [], blockReads: [] };
  const body = opts.body ?? BODY;

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    log.requests.push(`${method} ${urlStr}`);

    if (urlStr.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "matter-page-1",
              url: "https://notion.so/matter-page-1",
              parent: { type: "data_source_id", data_source_id: "matters-ds" },
              properties: {
                Matter_ID: { unique_id: { prefix: "M", number: 12 } },
                Entity: { relation: [{ id: "entity-page-1" }] },
              },
            },
          ],
        }),
        { status: 200 },
      );
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

    if (urlStr.endsWith("/data_sources/call-notes-ds/query") && method === "POST") {
      log.callNotesQueries.push(init.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(JSON.stringify({ results: opts.queryRecord ? [opts.queryRecord] : [] }), { status: 200 });
    }

    if (urlStr.endsWith(`/pages/${SOURCES_PAGE_ID}`) && method === "GET") {
      if (!opts.sourcesPage) {
        return new Response(JSON.stringify({ object: "error", status: 404, message: "page not found" }), { status: 404 });
      }
      return new Response(JSON.stringify(opts.sourcesPage), { status: 200 });
    }

    if (urlStr.endsWith("/pages/cn-page-1") && method === "GET") {
      // The legacy record's own page: the body reader resolves the page's
      // real parent before it reads a single block.
      return new Response(
        JSON.stringify({
          id: "cn-page-1",
          url: "https://notion.so/cn-page-1",
          parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
          properties: {},
        }),
        { status: 200 },
      );
    }

    if (urlStr.includes("/blocks/") && urlStr.includes("/children") && method === "GET") {
      const pageId = urlStr.split("/blocks/")[1].split("/")[0];
      log.blockReads.push(pageId);
      return new Response(
        JSON.stringify({
          results: body ? [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: body }] } }] : [],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch in strategy-evidence test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return log;
}

function readEvidence(props: Record<string, any>) {
  return readApprovedCallNotesEvidence(fakeEnv(), props as any, { entityToken: "E-47", matterToken: "M-12" }, strategyContext());
}

async function expectRefused(
  t: any,
  props: Record<string, any>,
  matcher: RegExp,
  opts: Parameters<typeof mockEvidenceFetch>[1] = {},
) {
  const log = mockEvidenceFetch(t, opts);
  const result = await readEvidence(props);
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return log;
  assert.match(result.reason, matcher, "the refusal must say exactly what stopped it");
  return log;
}

// ---------------------------------------------------------------------------
// Legacy: the free-text reference transport, unchanged.
// ---------------------------------------------------------------------------

test("legacy: a Handoff with no Sources property resolves through the free-text reference -- one exact query, body read after attestation", async (t) => {
  const log = mockEvidenceFetch(t, { queryRecord: await recordFixture("cn-page-1") });
  const result = await readEvidence(properties());

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;

  assert.equal(result.via, "reference", "the legacy transport is unchanged and still labelled as such");
  assert.equal(result.callNotesId, "CN-007");
  assert.equal(result.status, "Ready");
  assert.equal(log.callNotesQueries.length, 1, "exactly one exact-title query locates the record");
  assert.equal(log.callNotesQueries[0]?.filter?.property, "Call Notes ID", "the query is the exact-title lookup, not a broad scan");
  assert.deepEqual(log.blockReads, ["cn-page-1"], "the record's own body is read once, after the attestation");
  assert.ok(result.evidenceText.includes("Call_Notes_ID: CN-007"), "registry fields identify the record");
  assert.ok(result.evidenceText.includes(BODY), "the body is the substantive evidence");
});

test("legacy: a missing free-text reference is refused -- nothing is inferred from Entity/Matter", async (t) => {
  const log = await expectRefused(
    t,
    properties({ Reason: rich("Call notes for commercial qualification.") }),
    /carries no Call_Notes_ID reference/,
  );
  assert.equal(log.callNotesQueries.length, 0, "no lookup without a reference");
  assert.deepEqual(log.blockReads, [], "no body is read");
});

// ---------------------------------------------------------------------------
// Sources: the canonical-page transport.
// ---------------------------------------------------------------------------

test("sources: the canonical page is read directly -- the exact-title query is never issued, and the evidence is the page's own body", async (t) => {
  const log = mockEvidenceFetch(t, { sourcesPage: await recordFixture(SOURCES_PAGE_ID) });
  const result = await readEvidence(properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }));

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;

  assert.equal(result.via, "sources");
  assert.equal(result.callNotesId, "CN-007");
  assert.equal(result.status, "Ready");
  assert.equal(log.callNotesQueries.length, 0, "the direct page id replaces the search entirely");
  assert.deepEqual(log.blockReads, [SOURCES_PAGE_ID], "the canonical record's own body is the evidence");
  assert.ok(result.evidenceText.includes("registry fields (identification"), "identification and evidence stay labelled");
  assert.ok(result.evidenceText.includes(BODY));
});

test("sources: an unreadable canonical page is refused, and NO search stands in for it", async (t) => {
  const log = await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /could not be read/,
    {}, // the sources page deliberately 404s
  );
  assert.equal(log.callNotesQueries.length, 0, "a broken direct reference is never repaired by a search");
});

test("sources: a free-text Call_Notes_ID that disagrees with the canonical page is refused", async (t) => {
  const log = await expectRefused(
    t,
    properties({ Reason: rich("Call notes. Call_Notes_ID: CN-999"), Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /conflicting references/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID) },
  );
  assert.equal(log.callNotesQueries.length, 0, "neither id triggers a search");
  assert.deepEqual(log.blockReads, [], "a conflicted Handoff's body is never read");
});

test("sources: a broken free-text Call_Notes_ID beside a Sources property is refused", async (t) => {
  await expectRefused(
    t,
    properties({ Reason: rich("Call notes. Call_Notes_ID:"), Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /cannot be used beside its Sources property/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID) },
  );
});

test("sources: a tampered attestation refuses BEFORE any body is read", async (t) => {
  const valid = await recordFixture(SOURCES_PAGE_ID);
  const marker = valid.properties["Approval Attestation"].rich_text[0].plain_text as string;
  const tampered = marker.replace(/fields_hash=[0-9a-f]+/, `fields_hash=${"0".repeat(64)}`);
  const log = await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /fields_hash does not match/,
    { sourcesPage: { ...valid, properties: { ...valid.properties, "Approval Attestation": rich(tampered) } } },
  );
  assert.deepEqual(log.blockReads, [], "the body of an unproven record is never retrieved");
});

test("sources: a Superseded canonical page is refused -- no approved current evidence", async (t) => {
  await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /only Ready or Consumed/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Status: { select: { name: "Superseded" } } }) },
  );
});

test("sources: an already-Consumed canonical page still carries approved evidence -- this reader never writes, so the re-read is idempotent", async (t) => {
  mockEvidenceFetch(t, { sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Status: { select: { name: "Consumed" } } }) });
  const result = await readEvidence(properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }));
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.equal(result.status, "Consumed");
  assert.equal(result.via, "sources");
});

test("sources: an empty page body is refused rather than presented as evidence", async (t) => {
  await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /carries no page body/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID), body: "" },
  );
});

test("sources: a body that only points at evidence is refused by the same test order 1 uses", async (t) => {
  await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /only points at evidence/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID), body: "Call_Notes_ID: CN-007" },
  );
});

test("sources: a route with no declared contract is refused -- which sources may travel a route is never guessed", async (t) => {
  const log = await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]), "From Unit": { select: { name: null } } }),
    /has no Handoff source route contract/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID) },
  );
  assert.deepEqual(log.blockReads, [], "nothing is read on an uncontracted route");
});
