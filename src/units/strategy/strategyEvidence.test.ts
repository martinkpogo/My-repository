import test from "node:test";
import assert from "node:assert/strict";
import { readApprovedCallNotesEvidence, readCallNotesNoteProperty, readGoogleDocSourceEvidence } from "./strategyEvidence";
import type { HandoffSourceRouteContract } from "../../handoffSources";
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
 * attestation verified before any note content is read, the record's `Note`
 * property as the SOLE substantive source (the page body is never read, and
 * a Note that is missing, wrong-typed, empty, or only points at evidence is
 * refused rather than presented), and -- the point of the Sources path --
 * no search ever standing in for a direct reference, nor a direct
 * reference silently downgraded to one.
 */

const REGISTRY: CallNotesApprovalRecord = {
  callNotesId: "CN-007",
  entity: "E-47",
  matter: "M-12",
  callDate: "2026-09-28",
  callType: "Discovery",
  version: 1,
};

const SOURCES_PAGE_ID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const SOURCES_PAGE_URL = `https://www.notion.so/Acme-Call-Notes-aaaa1111-bbbb-2222-cccc-3333dddd4444`;

/** Distinct from every registry field, so "the note reached the evidence" is unambiguous. */
const NOTE =
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

/**
 * The production shape of a Sources-enabled Handoff's payload: the opaque
 * token pair first, then the canonical artifact pages. Identity and evidence
 * are separate questions, and both are answered in the one sanctioned place.
 */
function sourcesProperty(urls: string[]) {
  return {
    rich_text: [
      { type: "text", text: { content: "token:entity:E-47", link: null }, plain_text: "token:entity:E-47", href: null },
      { type: "text", text: { content: "token:matter:M-12", link: null }, plain_text: "token:matter:M-12", href: null },
      ...urls.map((url) => ({ type: "text", text: { content: url, link: { url } }, plain_text: url, href: url })),
    ],
  };
}

/** The Sales -> Strategy contract as production declares it: identity required, artifacts governed per type. */
const TOKEN_CONTRACT: Readonly<Record<string, HandoffSourceRouteContract>> = {
  "Sales->Strategy": {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: ["call_notes", "entities", "matters"],
    prohibited: ["handoffs"],
  },
};

/**
 * A route DECLARED generic -- both token flags false, no entity/matter
 * artifact type -- which is the only thing that permits a Handoff with no
 * Sources payload at all. Production declares no generic route; this table
 * exists solely to exercise the legacy free-text transport through the
 * resolver's injected-contract seam, exactly as it was reachable before
 * Sources became the identity carrier.
 */
const GENERIC_CONTRACT: Readonly<Record<string, HandoffSourceRouteContract>> = {
  "Sales->Strategy": {
    requiresEntityToken: false,
    requiresMatterToken: false,
    required: [],
    optional: ["call_notes"],
    prohibited: ["handoffs", "entities", "matters"],
  },
};

interface MockLog {
  /** Every request, as `METHOD url`. */
  requests: string[];
  /** Every query issued against the Call Notes store -- the search only the legacy transport may make. */
  callNotesQueries: any[];
  /** Page ids whose block children were actually read -- must stay empty: no Call Notes path reads a page body. */
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
      Note: rich(NOTE),
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
    /**
     * The body blocks served for any page id. Deliberately still served so a
     * body-only record can be attempted on purpose -- proof that the reader
     * refuses it and never fetches it.
     */
    body?: string;
  } = {},
): MockLog {
  const originalFetch = globalThis.fetch;
  const log: MockLog = { requests: [], callNotesQueries: [], blockReads: [] };
  const body = opts.body ?? NOTE;

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

    // NOTE: there is deliberately NO handler for `/pages/cn-page-1`. Since the
    // Note-based reader, no Call Notes path re-fetches a located record's page:
    // the Note comes straight from the properties each governed read already
    // returned. Any such fetch lands on the throw below, which is the proof.

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

function readEvidence(props: Record<string, any>, contracts: Readonly<Record<string, HandoffSourceRouteContract>> = TOKEN_CONTRACT) {
  return readApprovedCallNotesEvidence(
    fakeEnv(),
    props as any,
    { entityToken: "E-47", matterToken: "M-12" },
    strategyContext(),
    contracts,
  );
}

async function expectRefused(
  t: any,
  props: Record<string, any>,
  matcher: RegExp,
  opts: Parameters<typeof mockEvidenceFetch>[1] = {},
  contracts: Readonly<Record<string, HandoffSourceRouteContract>> = TOKEN_CONTRACT,
) {
  const log = mockEvidenceFetch(t, opts);
  const result = await readEvidence(props, contracts);
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return log;
  assert.match(result.reason, matcher, "the refusal must say exactly what stopped it");
  return log;
}

// ---------------------------------------------------------------------------
// The Note reader's own shape validation: present, rich text, non-empty.
// ---------------------------------------------------------------------------

test("note reader: the three defects -- absent, wrong-typed, empty -- are each their own structured, non-sensitive reason", () => {
  const missing = readCallNotesNoteProperty({});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /carries no Note property/);

  const wrongType = readCallNotesNoteProperty({ Note: { number: 5 } });
  assert.equal(wrongType.ok, false);
  if (!wrongType.ok) assert.match(wrongType.reason, /not rich text/);

  const wrongShape = readCallNotesNoteProperty({ Note: { rich_text: "not-an-array" } });
  assert.equal(wrongShape.ok, false);
  if (!wrongShape.ok) assert.match(wrongShape.reason, /not rich text/);

  const empty = readCallNotesNoteProperty({ Note: { rich_text: [{ plain_text: "   \n  " }] } });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /carries an empty Note property/);

  const healthy = readCallNotesNoteProperty({ Note: rich(NOTE) });
  assert.equal(healthy.ok, true, healthy.ok ? "" : healthy.reason);
  if (healthy.ok) assert.equal(healthy.note, NOTE, "the rich text is extracted verbatim");
  for (const failure of [missing, wrongType, wrongShape, empty]) {
    if (!failure.ok) assert.ok(!failure.reason.includes("quarterly"), "a refusal reason must never carry note content");
  }
});

// ---------------------------------------------------------------------------
// Legacy: the free-text reference transport, unchanged.
// ---------------------------------------------------------------------------

test("legacy: a Handoff with no Sources property resolves through the free-text reference -- one exact query, the Note read after attestation and never the page body", async (t) => {
  const log = mockEvidenceFetch(t, { queryRecord: await recordFixture("cn-page-1") });
  const result = await readEvidence(properties(), GENERIC_CONTRACT);

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;

  assert.equal(result.via, "reference", "the legacy transport is unchanged and still labelled as such");
  assert.equal(result.callNotesId, "CN-007");
  assert.equal(result.status, "Ready");
  assert.equal(log.callNotesQueries.length, 1, "exactly one exact-title query locates the record");
  assert.equal(log.callNotesQueries[0]?.filter?.property, "Call Notes ID", "the query is the exact-title lookup, not a broad scan");
  assert.deepEqual(log.blockReads, [], "the record's page body is NEVER read -- the Note property is the sole source");
  assert.ok(result.evidenceText.includes("Call_Notes_ID: CN-007"), "registry fields identify the record");
  assert.ok(result.evidenceText.includes(NOTE), "the Note is the substantive evidence");
  assert.ok(
    result.evidenceText.includes("=== Approved Call Notes note (the substantive evidence"),
    "the Note is presented under its own label, never as metadata",
  );
});

test("legacy: a missing free-text reference is refused -- nothing is inferred from Entity/Matter", async (t) => {
  const log = await expectRefused(
    t,
    properties({ Reason: rich("Call notes for commercial qualification.") }),
    /carries no Call_Notes_ID reference/,
    {},
    GENERIC_CONTRACT,
  );
  assert.equal(log.callNotesQueries.length, 0, "no lookup without a reference");
  assert.deepEqual(log.blockReads, [], "no body is read");
});

test("legacy: a record whose page body carries text but whose Note is absent never succeeds -- the body is not a fallback", async (t) => {
  const log = await expectRefused(
    t,
    properties(),
    /carries no Note property/,
    { queryRecord: await recordFixture("cn-page-1", { Note: undefined }), body: NOTE },
    GENERIC_CONTRACT,
  );
  assert.equal(log.callNotesQueries.length, 1, "the record itself was located and every gate ahead of the Note passed");
  assert.deepEqual(log.blockReads, [], "the substantive-looking page body is never fetched as a fallback");
});

// ---------------------------------------------------------------------------
// Sources: the canonical-page transport.
// ---------------------------------------------------------------------------

test("sources: the canonical page is read directly -- the exact-title query is never issued, and the evidence is that page's own Note", async (t) => {
  const log = mockEvidenceFetch(t, { sourcesPage: await recordFixture(SOURCES_PAGE_ID) });
  const result = await readEvidence(properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }));

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;

  assert.equal(result.via, "sources");
  assert.equal(result.callNotesId, "CN-007");
  assert.equal(result.status, "Ready");
  assert.equal(log.callNotesQueries.length, 0, "the direct page id replaces the search entirely");
  assert.deepEqual(log.blockReads, [], "the canonical record's page body is never read -- its Note is the evidence");
  assert.ok(result.evidenceText.includes("registry fields (identification"), "identification and evidence stay labelled");
  assert.ok(result.evidenceText.includes(NOTE));
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

test("sources: an Entity mismatch refuses before any note content is read, and the refusal carries none", async (t) => {
  const log = mockEvidenceFetch(t, {
    sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Entity: { relation: [{ id: "entity-page-9" }] } }),
  });
  const result = await readEvidence(properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }));
  assert.equal(result.ok, false, "a record not bound to this Handoff's Entity must refuse");
  if (result.ok) return;
  assert.match(result.reason, /not bound to this Handoff's Entity/);
  assert.ok(!result.reason.includes("quarterly"), "the note content must not leak into a pre-content refusal");
  assert.deepEqual(log.blockReads, [], "nothing substantive is read for an unbound record");
});

test("sources: a tampered attestation refuses BEFORE any note content is read", async (t) => {
  const valid = await recordFixture(SOURCES_PAGE_ID);
  const marker = valid.properties["Approval Attestation"].rich_text[0].plain_text as string;
  const tampered = marker.replace(/fields_hash=[0-9a-f]+/, `fields_hash=${"0".repeat(64)}`);
  const log = mockEvidenceFetch(t, {
    sourcesPage: { ...valid, properties: { ...valid.properties, "Approval Attestation": rich(tampered) } },
  });
  const result = await readEvidence(properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }));
  assert.equal(result.ok, false, "an unproven record must refuse");
  if (result.ok) return;
  assert.match(result.reason, /fields_hash does not match/);
  assert.ok(!result.reason.includes("quarterly"), "the note of an unproven record is never even parsed into a refusal");
  assert.deepEqual(log.blockReads, [], "the body of an unproven record is never retrieved");
});

test("sources: a Superseded canonical page is refused -- no approved current evidence (a legacy value, still never consumed)", async (t) => {
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

test("sources: a record whose page body carries text but whose Note is absent never succeeds -- the body is not a fallback", async (t) => {
  const log = await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /carries no Note property/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Note: undefined }), body: NOTE },
  );
  assert.deepEqual(log.blockReads, [], "the substantive-looking page body is never fetched as a fallback");
});

test("sources: an empty Note is refused rather than presented as evidence", async (t) => {
  await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /carries an empty Note property/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Note: rich("   ") }) },
  );
});

test("sources: a wrong-typed Note property is refused rather than coerced", async (t) => {
  await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /Note property that is not rich text/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Note: { number: 5 } }) },
  );
});

test("sources: a Note that only points at evidence is refused by the same test order 1 uses", async (t) => {
  await expectRefused(
    t,
    properties({ Sources: sourcesProperty([SOURCES_PAGE_URL]) }),
    /only points at evidence/,
    { sourcesPage: await recordFixture(SOURCES_PAGE_ID, { Note: rich("Call_Notes_ID: CN-007") }) },
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

// ---------------------------------------------------------------------------
// The Google Doc source evidence step: content read only for an ALREADY
// VALIDATED source, substantive-by-the-same-test-as-order-1.
// ---------------------------------------------------------------------------

const GDOC_FILE_ID = "abc123DEF456ghi789jkl012mno345pq";
const GDOC_ACCOUNT = "martin@example.com";

const VALIDATED_GDOC_SOURCE = {
  fileId: GDOC_FILE_ID,
  accountIdentifier: GDOC_ACCOUNT,
  title: "Proposal review",
  proposal: { workId: "work-prop-1", proposalId: "PROP-6", version: 2 },
};

function fakeEnvWithGoogleToken(): Env {
  const kv: Record<string, string> = {
    [`google_oauth_tokens:${GDOC_ACCOUNT}`]: JSON.stringify({
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      expires_at: Date.now() + 3_600_000,
      account_identifier: GDOC_ACCOUNT,
      updated_at: "2026-10-01T00:00:00.000Z",
    }),
  };
  const env = fakeEnv() as any;
  env.STATE_KV = {
    get: async (key: string) => kv[key] ?? null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  };
  return env as Env;
}

function mockDocsFetch(t: any, text: string) {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    requests.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).startsWith("https://docs.googleapis.com/v1/documents/")) {
      return new Response(
        JSON.stringify({ body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in strategyEvidence google test: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requests;
}

test("googleDoc evidence: a validated Doc's substantive content becomes the evidence base -- read-only through the Docs API", async (t) => {
  const requests = mockDocsFetch(
    t,
    "Direct client statement: the quarterly reporting pack takes four staff days to assemble because three systems disagree on project codes.",
  );
  const evidence = await readGoogleDocSourceEvidence(fakeEnvWithGoogleToken(), VALIDATED_GDOC_SOURCE);
  assert.equal(evidence.ok, true, evidence.ok ? "" : evidence.reason);
  if (!evidence.ok) return;
  assert.match(evidence.evidenceText, /quarterly reporting pack/);
  assert.equal(evidence.fileId, GDOC_FILE_ID);
  assert.equal(evidence.proposalId, "PROP-6");
  assert.equal(evidence.version, 2);
  assert.equal(requests.filter((r) => r.includes("/documents/")).length, 1, "exactly one Docs read, nothing else");
});

test("googleDoc evidence: a Doc whose text only points at evidence is refused -- the same substantive test order 1 applies", async (t) => {
  mockDocsFetch(t, "Call_Notes_ID: CN-007");
  const evidence = await readGoogleDocSourceEvidence(fakeEnvWithGoogleToken(), VALIDATED_GDOC_SOURCE);
  assert.equal(evidence.ok, false, "a reference-only document is not the business situation");
  if (evidence.ok) return;
  assert.match(evidence.reason, /nothing substantive in it/);
});
