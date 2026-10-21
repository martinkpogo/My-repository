import test from "node:test";
import assert from "node:assert/strict";
import {
  callNotesEvidenceText,
  extractCallNotesReference,
  retrieveAndConsumeCallNotes,
} from "./callNotesRecord";
import {
  CALL_NOTES_APPROVAL_FIELDS,
  buildRecordApprovalMarker,
  type CallNotesApprovalRecord,
} from "./callNotesMarker";
import { workSessionContext } from "../../access";
import type { HandoffSourceRouteContract } from "../../handoffSources";
import type { Env, WorkState } from "../../types";

/**
 * Runtime's governed Call Notes consumption, tested at the seam where the
 * Handoff's reference becomes a consumed record.
 *
 * The suite is organised the way the chain itself is ordered: reference, then
 * lookup, then binding, then attestation, then the lifecycle write. Every
 * refusal case asserts two things -- that consumption reported a reason, and
 * that NOTHING was written (the record is still Ready and no PATCH was
 * issued), because a refusal that quietly advanced the record would be the
 * dangerous outcome, not a noisy one.
 */

const REGISTRY: CallNotesApprovalRecord = {
  callNotesId: "CN-007",
  entity: "E-47",
  matter: "M-12",
  callDate: "2026-09-28",
  callType: "Discovery",
  version: 1,
};

/** The record's substantive `Note` (canonical schema: the sole source of note content). */
const NOTE =
  "Direct client statement: the quarterly reporting pack takes four staff days to assemble because three systems disagree on project codes.";

/** The six canonical registry fields, in order -- what the evidence text must carry. */
const REGISTRY_EVIDENCE = [
  "Call_Notes_ID: CN-007",
  "Entity: E-47",
  "Matter: M-12",
  "Call Date: 2026-09-28",
  "Call Type: Discovery",
  "Version: 1",
].join("\n");

const DEFAULT_REASON = "Call notes for commercial qualification. Call_Notes_ID: CN-007";
const DEFAULT_TITLE = "Call Notes (Matter: M-12)";

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
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
  };
}

/** The pickup Work this slice reuses -- no new Action is introduced by consumption. */
function pickupContext() {
  const state: WorkState = {
    workId: "work_consume_1",
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
 * A Call Notes record whose `Approval Attestation` is computed for
 * `markerRegistry` while every other property reads as `properties`. Passing a
 * different markerRegistry than the record's own fields is exactly how a
 * tampered/mismatched attestation is produced.
 */
async function callNotesPage(
  markerRegistry: CallNotesApprovalRecord = REGISTRY,
  properties: Record<string, any> = {},
  id = "call-notes-1",
): Promise<any> {
  const marker = await buildRecordApprovalMarker(markerRegistry, "Approved");
  return {
    id,
    url: `https://notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
    properties: {
      "Call Notes ID": { title: [{ plain_text: "CN-007", text: { content: "CN-007" } }] },
      "Call Date": { date: { start: "2026-09-28" } },
      "Call Type": { select: { name: "Discovery" } },
      "Note": rich(NOTE),
      "Status": { select: { name: "Ready" } },
      "Version": { number: 1 },
      "Entity": { relation: [{ id: "entity-page-1" }] },
      "Matter": { relation: [{ id: "matter-page-1" }] },
      "Approval Attestation": rich(marker),
      ...properties,
    },
  };
}

interface MockOptions {
  reason?: string;
  title?: string;
  /** What the exact-match query returns. `null`/empty = no match at all. */
  records?: any[] | null;
  /** The Handoff's `Verified Facts & Sources` payload (never searched for a reference). */
  verifiedFacts?: string;
  /** Whether the Handoff's Entity/Matter tokens resolve to real records. */
  resolves?: boolean;
  /** The record's live Status at the lifecycle's compare step. */
  liveStatus?: string;
  /**
   * Direct-page `Sources` property URLs (the Phase 1 compatibility seam).
   * Absent = the legacy free-text `Call_Notes_ID` transport.
   */
  sourcesUrls?: string[];
  /** Omit the Handoff's Entity_Token/Matter_Token properties entirely -- the source-based Handoff shape. */
  omitTokenProperties?: boolean;
  /** The canonical page the Sources URLs point at; defaults to a valid Ready, correctly bound, attested record. */
  sourcesRecord?: any;
  /** The route recorded on the Handoff (`From Unit`/`To Unit`), which the Sources resolver reads for its contract lookup. */
  fromUnit?: string;
  toUnit?: string;
}

interface MockLog {
  requests: string[];
  writes: string[];
  liveStatus: string;
}

function mockConsumeFetch(t: any, opts: MockOptions = {}): MockLog {
  const originalFetch = globalThis.fetch;
  const reason = opts.reason ?? DEFAULT_REASON;
  const title = opts.title ?? DEFAULT_TITLE;
  const verifiedFacts = opts.verifiedFacts ?? "De-identified call notes for a positioning engagement.";
  const resolves = opts.resolves ?? true;
  const log: MockLog = { requests: [], writes: [], liveStatus: opts.liveStatus ?? "Ready" };
  let defaultRecords: any[] | null | undefined;

  async function records(): Promise<any[] | null> {
    if (opts.records !== undefined && opts.records !== null) return opts.records;
    if (opts.records === null) return null;
    if (!defaultRecords) defaultRecords = [await callNotesPage()];
    return defaultRecords;
  }

  globalThis.fetch = (async (url: string, init?: any) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";
    log.requests.push(`${method} ${urlStr}`);

    if (urlStr.endsWith("/pages/handoff-1")) {
      return new Response(
        JSON.stringify({
          id: "handoff-1",
          url: "https://notion.so/handoff-1",
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          properties: {
            Status: { select: { name: "Pending" } },
            "Verified Facts & Sources": rich(verifiedFacts),
            // The migration's canonical shape: a Handoff whose identity is
            // its Sources, carrying no token properties at all.
            ...(opts.omitTokenProperties
              ? {}
              : { Entity_Token: rich("E-47"), Matter_Token: rich("M-12") }),
            Reason: rich(reason),
            Handoff: { title: [{ plain_text: title, text: { content: title } }] },
            ...(opts.sourcesUrls
              ? {
                  Sources: {
                    rich_text: opts.sourcesUrls.map((url) => ({
                      type: "text",
                      text: { content: url, link: { url } },
                      plain_text: url,
                      href: url,
                    })),
                  },
                }
              : {}),
            ...(opts.fromUnit ? { "From Unit": { select: { name: opts.fromUnit } } } : {}),
            ...(opts.toUnit ? { "To Unit": { select: { name: opts.toUnit } } } : {}),
          },
        }),
        { status: 200 },
      );
    }

    if (urlStr.endsWith("/data_sources/matters-ds/query")) {
      return new Response(
        JSON.stringify({
          results: resolves
            ? [{
                id: "matter-page-1",
                url: "https://notion.so/matter-page-1",
                properties: {
                  Matter_ID: { unique_id: { number: 12, prefix: "M" } },
                  Entity: { relation: [{ id: "entity-page-1" }] },
                },
              }]
            : [],
        }),
        { status: 200 },
      );
    }

    if (urlStr.endsWith("/pages/entity-page-1")) {
      return new Response(
        JSON.stringify({
          id: "entity-page-1",
          url: "https://notion.so/entity-page-1",
          parent: { type: "data_source_id", data_source_id: "entity-ds" },
          properties: { Entity_ID: { unique_id: { number: 47, prefix: "E" } } },
        }),
        { status: 200 },
      );
    }

    // The exact canonical Entity/Matter pages a tokenless Sources-enabled
    // Handoff names (hex ids, the only thing a Sources URL may carry): the
    // source-derived binding reads its tokens and relationship from these,
    // fetched by id -- never from the Handoff's token properties, and never
    // through the matters-ds query below.
    if (urlStr.endsWith(`/pages/${TOKENLESS_ENTITY_PAGE_ID}`)) {
      return new Response(
        JSON.stringify({
          id: TOKENLESS_ENTITY_PAGE_ID,
          url: `https://notion.so/${TOKENLESS_ENTITY_PAGE_ID}`,
          parent: { type: "data_source_id", data_source_id: "entity-ds" },
          properties: { Entity_ID: { unique_id: { number: 47, prefix: "E" } } },
        }),
        { status: 200 },
      );
    }
    if (urlStr.endsWith(`/pages/${TOKENLESS_MATTER_PAGE_ID}`)) {
      return new Response(
        JSON.stringify({
          id: TOKENLESS_MATTER_PAGE_ID,
          url: `https://notion.so/${TOKENLESS_MATTER_PAGE_ID}`,
          parent: { type: "data_source_id", data_source_id: "matters-ds" },
          properties: {
            Matter_ID: { unique_id: { number: 12, prefix: "M" } },
            Entity: { relation: [{ id: TOKENLESS_ENTITY_PAGE_ID }] },
          },
        }),
        { status: 200 },
      );
    }

    if (urlStr.endsWith("/data_sources/call-notes-ds/query")) {
      return new Response(JSON.stringify({ results: (await records()) ?? [] }), { status: 200 });
    }

    if (urlStr.endsWith("/pages/call-notes-1") && method === "GET") {
      const [page] = (await records()) ?? [];
      if (!page) {
        return new Response(
          JSON.stringify({ id: "call-notes-1", url: "https://notion.so/call-notes-1", parent: { type: "data_source_id", data_source_id: "call-notes-ds" }, properties: {} }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ...page,
          properties: { ...page.properties, Status: { select: { name: log.liveStatus } } },
        }),
        { status: 200 },
      );
    }

    if (urlStr.endsWith("/pages/call-notes-1") && method === "PATCH") {
      log.writes.push(String(init.body));
      const body = JSON.parse(String(init.body));
      if (body.properties?.Status?.select?.name) log.liveStatus = body.properties.Status.select.name;
      return new Response(
        JSON.stringify({ id: "call-notes-1", url: "https://notion.so/call-notes-1", parent: { type: "data_source_id", data_source_id: "call-notes-ds" }, properties: {} }),
        { status: 200 },
      );
    }

    // The canonical page a Sources-enabled Handoff names: served by its
    // exact id (whatever slug the URL carried is irrelevant -- only the id
    // reached here), and it is the ONLY Call Notes page that exists in a
    // sources-mode mock: no query route is ever needed, because issuing one
    // would already prove the direct reference was not trusted.
    if (urlStr.endsWith(`/pages/${SOURCES_PAGE_ID}`)) {
      if (method === "PATCH") {
        log.writes.push(String(init.body));
        const body = JSON.parse(String(init.body));
        if (body.properties?.Status?.select?.name) log.liveStatus = body.properties.Status.select.name;
        return new Response(
          JSON.stringify({ id: SOURCES_PAGE_ID, url: `https://notion.so/${SOURCES_PAGE_ID}`, parent: { type: "data_source_id", data_source_id: "call-notes-ds" }, properties: {} }),
          { status: 200 },
        );
      }
      const page = opts.sourcesRecord ?? (await callNotesPage(REGISTRY, {}, SOURCES_PAGE_ID));
      return new Response(
        JSON.stringify({
          ...page,
          id: SOURCES_PAGE_ID,
          url: `https://notion.so/${SOURCES_PAGE_ID}`,
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch in call-notes consumption test: ${method} ${urlStr}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return log;
}

function consume(contracts?: Readonly<Record<string, HandoffSourceRouteContract>>) {
  return retrieveAndConsumeCallNotes(
    fakeEnv(),
    "handoff-1",
    { entityToken: "E-47", matterToken: "M-12" },
    pickupContext(),
    ...(contracts ? [contracts] : []),
  );
}

async function expectRefused(
  t: any,
  opts: MockOptions,
  matcher: RegExp,
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
) {
  const log = mockConsumeFetch(t, opts);
  const startingStatus = opts.liveStatus ?? "Ready";
  const result = await consume(contracts);
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return log;
  assert.match(result.reason, matcher, "the refusal must say which gate stopped it");
  assert.equal(log.liveStatus, startingStatus, "a refusal must never advance the record");
  assert.equal(log.writes.length, 0, "a refusal must issue no write at all");
  return log;
}

// ---------------------------------------------------------------------------
// Gate 1 -- the Handoff's own Call_Notes_ID reference.
// ---------------------------------------------------------------------------

test("reference: reads Call_Notes_ID from the Handoff's Reason", () => {
  const result = extractCallNotesReference({ Reason: rich(DEFAULT_REASON) });
  assert.deepEqual(result, { ok: true, callNotesId: "CN-007" });
});

test("reference: reads it from the Handoff title when Reason carries none", () => {
  const result = extractCallNotesReference({
    Reason: rich("Call notes for commercial qualification."),
    Handoff: { title: [{ plain_text: "Call Notes — Call_Notes_ID=CN-042", text: { content: "Call Notes — Call_Notes_ID=CN-042" } }] },
  });
  assert.deepEqual(result, { ok: true, callNotesId: "CN-042" });
});

test("reference: the same id in both fields is not ambiguous", () => {
  const result = extractCallNotesReference({
    Reason: rich(DEFAULT_REASON),
    Handoff: { title: [{ plain_text: "CN-007", text: { content: "CN-007" } }] },
  });
  assert.deepEqual(result, { ok: true, callNotesId: "CN-007" });
});

test("reference: two different ids across the fields is ambiguous and fails closed", async (t) => {
  await expectRefused(t, { reason: "Call_Notes_ID: CN-007", title: "Call Notes — Call_Notes_ID: CN-042" }, /conflicting Call_Notes_ID/);
});

test("reference: a missing Call_Notes_ID fails closed -- it is never inferred from Entity/Matter", async (t) => {
  await expectRefused(t, { reason: "Call notes for commercial qualification. requiredCategory: call_notes" }, /carries no Call_Notes_ID reference/);
});

test("reference: an empty Call_Notes_ID fails closed", async (t) => {
  await expectRefused(t, { reason: "Call notes. Call_Notes_ID:" }, /with no value/);
});

test("reference: a multi-token Call_Notes_ID is malformed and fails closed", async (t) => {
  await expectRefused(t, { reason: "Call notes. Call_Notes_ID: CN-007 (see below)" }, /single whitespace-free token/);
});

test("reference: Verified Facts & Sources is never the place a reference is looked up", async (t) => {
  await expectRefused(
    t,
    {
      reason: "Call notes for commercial qualification. requiredCategory: call_notes",
      verifiedFacts: "Narrative. Call_Notes_ID: CN-007",
    },
    /carries no Call_Notes_ID reference/,
  );
});

// ---------------------------------------------------------------------------
// Gate 2/3/4 -- identity binding targets, exact lookup, Status and relations.
// ---------------------------------------------------------------------------

test("lookup: tokens that do not resolve stop the chain before any Call Notes read", async (t) => {
  const log = mockConsumeFetch(t, { resolves: false });
  const result = await consume();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /did not resolve to a real, related Entity\/Matter record/);
  assert.ok(
    !log.requests.some((r) => r.includes("call-notes-ds")),
    "no Call Notes query may be issued when there is nothing to bind the record to",
  );
  assert.equal(log.writes.length, 0);
});

test("lookup: zero exact matches fails closed", async (t) => {
  await expectRefused(t, { records: null }, /no Call Notes record has Call_Notes_ID "CN-007"/);
});

test("lookup: multiple exact matches fails closed -- no record is chosen", async (t) => {
  const first = await callNotesPage(REGISTRY, {}, "call-notes-1");
  const second = await callNotesPage(REGISTRY, {}, "call-notes-2");
  await expectRefused(t, { records: [first, second] }, /2 Call Notes records carry Call_Notes_ID/);
});

test("lookup: a non-Ready record is refused and left alone", async (t) => {
  await expectRefused(t, { records: [await callNotesPage(REGISTRY, { Status: { select: { name: "Consumed" } } })] }, /not "Ready"/);
});

test("lookup: a record bound to a different Entity is refused", async (t) => {
  await expectRefused(
    t,
    { records: [await callNotesPage(REGISTRY, { Entity: { relation: [{ id: "some-other-entity" }] } })] },
    /not bound to this Work's Entity/,
  );
});

test("lookup: a record bound to a different Matter is refused", async (t) => {
  await expectRefused(
    t,
    { records: [await callNotesPage(REGISTRY, { Matter: { relation: [{ id: "matter-page-9" }] } })] },
    /not bound to this Work's Matter/,
  );
});

test("lookup: a record with no Version cannot be bound and is refused", async (t) => {
  await expectRefused(
    t,
    { records: [await callNotesPage(REGISTRY, { Version: { number: undefined } })] },
    /Version property is missing/,
  );
});

// ---------------------------------------------------------------------------
// Gate 5 -- the recorded Approval Attestation, validated against this record.
// ---------------------------------------------------------------------------

test("attestation: an absent attestation refuses consumption", async (t) => {
  await expectRefused(t, { records: [await callNotesPage(REGISTRY, { "Approval Attestation": { rich_text: [] } })] }, /no record_approval attestation marker/);
});

test("attestation: a malformed attestation refuses consumption", async (t) => {
  await expectRefused(t, { records: [await callNotesPage(REGISTRY, { "Approval Attestation": rich("[record_approval result=Approved record=CN-007]") })] }, /missing or empty/);
});

test("attestation: a marker bound to a different Call_Notes_ID refuses consumption", async (t) => {
  await expectRefused(t, { records: [await callNotesPage({ ...REGISTRY, callNotesId: "CN-999" })] }, /not bound to this record's Call_Notes_ID/);
});

test("attestation: a marker bound to a different Entity refuses consumption", async (t) => {
  await expectRefused(t, { records: [await callNotesPage({ ...REGISTRY, entity: "E-99" })] }, /not bound to this record's Entity reference/);
});

test("attestation: a marker bound to a different Matter refuses consumption", async (t) => {
  await expectRefused(t, { records: [await callNotesPage({ ...REGISTRY, matter: "M-99" })] }, /not bound to this record's Matter reference/);
});

test("attestation: a marker bound to a different Version refuses consumption", async (t) => {
  await expectRefused(t, { records: [await callNotesPage({ ...REGISTRY, version: 2 })] }, /not bound to this record's Version/);
});

test("attestation: a hash that no longer matches the record's registry fields refuses consumption", async (t) => {
  // Marker computed over a different Call Date -- every spelled-out binding
  // field still agrees, so only fields_hash can catch the change.
  await expectRefused(t, { records: [await callNotesPage({ ...REGISTRY, callDate: "2026-01-01" })] }, /fields_hash does not match/);
});

// ---------------------------------------------------------------------------
// The chain itself.
// ---------------------------------------------------------------------------

test("consumption: a valid reference, record and attestation is retrieved, consumed and passed on", async (t) => {
  const log = mockConsumeFetch(t);

  const result = await consume();

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;

  assert.equal(result.pageId, "call-notes-1");
  assert.equal(result.attestation.result, "Approved");
  assert.equal(result.attestation.version, 1);
  assert.equal(log.liveStatus, "Consumed", "the record must be advanced Ready -> Consumed");
  assert.equal(log.writes.length, 1, "exactly one lifecycle write");
  assert.deepEqual(JSON.parse(log.writes[0]).properties, { Status: { select: { name: "Consumed" } } }, "the write may touch Status and nothing else");

  assert.equal(
    result.evidenceText,
    REGISTRY_EVIDENCE,
    "the governed record's own registry fields are what the existing qualification path receives",
  );
  assert.ok(
    !result.evidenceText.includes("De-identified call notes for a positioning engagement."),
    "the Handoff's narrative must never be part of the evidence passed on",
  );
});

test("consumption: the evidence text carries every canonical registry field and no others", async (t) => {
  const log = mockConsumeFetch(t);
  const result = await consume();
  assert.equal(result.ok, true);
  if (!result.ok) return;

  for (const field of CALL_NOTES_APPROVAL_FIELDS) {
    assert.ok(
      result.evidenceText.split("\n").some((line) => line.startsWith(`${field}:`)),
      `evidence text must carry ${field}`,
    );
  }
  assert.equal(result.evidenceText.split("\n").length, CALL_NOTES_APPROVAL_FIELDS.length, "no field beyond the canonical six reaches the model");
  assert.equal(callNotesEvidenceText(result.record), result.evidenceText, "the evidence text is derived from the record just consumed, not assembled separately");
  assert.equal(log.liveStatus, "Consumed");
});

test("consumption: replaying against an already-Consumed record is refused with no second write", async (t) => {
  const log = mockConsumeFetch(t);

  const first = await consume();
  assert.equal(first.ok, true, first.ok ? "" : first.reason);
  assert.equal(log.writes.length, 1);

  const second = await consume();

  assert.equal(second.ok, false, "a consumed record must not be consumable again");
  if (second.ok) return;
  assert.match(second.reason, /Status "Consumed", not "Ready"/);
  assert.equal(log.liveStatus, "Consumed");
  assert.equal(log.writes.length, 1, "the replay must not issue a second write");
});

test("consumption: a Superseded record is refused with no write", async (t) => {
  await expectRefused(t, { liveStatus: "Superseded", records: [await callNotesPage(REGISTRY, { Status: { select: { name: "Ready" } } })] }, /Status "Superseded", not "Ready"/);
});

// ---------------------------------------------------------------------------
// Gate 0 -- the Handoff's direct-page Sources property (Phase 1 seam).
// ---------------------------------------------------------------------------

/**
 * The canonical Call Notes page a Sources-enabled Handoff names. Its id is a
 * real 32-hex Notion page id, because the resolver accepts nothing else.
 */
const SOURCES_PAGE_ID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const SOURCES_PAGE_URL = `https://www.notion.so/Acme-Call-Notes-aaaa1111-bbbb-2222-cccc-3333dddd4444`;

/** The canonical Entity/Matter pages a tokenless Sources-enabled Handoff names. */
const TOKENLESS_ENTITY_PAGE_ID = "bbbb2222-bbbb-2222-bbbb-2222bbbb2222";
const TOKENLESS_MATTER_PAGE_ID = "cccc3333-cccc-3333-cccc-3333cccc3333";

/**
 * A synthetic contract for the route a call-notes Handoff travels. NO
 * production contract exists for it (the `From Unit` the isolated Sales
 * project records is not verifiable from this repo), so production refuses
 * such a Sources-enabled Handoff fail-closed -- see the uncontracted-route
 * test below. This table exists only to exercise the success path through
 * the resolver's injected-contract seam; production callers never pass one.
 */
const SOURCES_CONTRACT: Readonly<Record<string, HandoffSourceRouteContract>> = {
  "Sales->Sales": { required: ["call_notes"], optional: [], prohibited: ["handoffs"] },
};

test("sources: a Sources-enabled Handoff consumes the exact canonical page it names -- no database search, Ready -> Consumed, identical registry evidence", async (t) => {
  const log = mockConsumeFetch(t, { sourcesUrls: [SOURCES_PAGE_URL], fromUnit: "Sales", toUnit: "Sales" });
  const result = await consume(SOURCES_CONTRACT);

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;

  assert.equal(result.pageId, SOURCES_PAGE_ID, "the consumed record is the one the link named, resolved by exact page id");
  assert.equal(result.attestation.result, "Approved");
  assert.equal(log.liveStatus, "Consumed", "the canonical record is advanced Ready -> Consumed");
  assert.equal(log.writes.length, 1, "exactly one lifecycle write");
  assert.deepEqual(JSON.parse(log.writes[0]).properties, { Status: { select: { name: "Consumed" } } }, "the write may touch Status and nothing else");
  assert.ok(
    log.requests.includes(`GET https://api.notion.com/v1/pages/${SOURCES_PAGE_ID}`),
    "the canonical page was fetched by its exact id",
  );
  assert.ok(
    !log.requests.some((r) => r.includes("call-notes-ds/query")),
    "the exact-title search is never issued -- the direct page id IS the reference",
  );
  assert.equal(
    result.evidenceText,
    REGISTRY_EVIDENCE,
    "the same registry fields the legacy transport passed on -- only HOW the record was located changed",
  );
  assert.ok(
    !result.evidenceText.includes("De-identified call notes for a positioning engagement."),
    "the Handoff's narrative is never part of the evidence",
  );
});

test("sources: a Superseded canonical page is refused with no write", async (t) => {
  await expectRefused(
    t,
    {
      sourcesUrls: [SOURCES_PAGE_URL],
      fromUnit: "Sales",
      toUnit: "Sales",
      sourcesRecord: await callNotesPage(REGISTRY, { Status: { select: { name: "Superseded" } } }, SOURCES_PAGE_ID),
    },
    /only Ready or Consumed/,
    SOURCES_CONTRACT,
  );
});

test("sources: an already-Consumed canonical page is refused -- Sales consumes only Ready records, whatever the resolver accepts", async (t) => {
  await expectRefused(
    t,
    {
      sourcesUrls: [SOURCES_PAGE_URL],
      fromUnit: "Sales",
      toUnit: "Sales",
      sourcesRecord: await callNotesPage(REGISTRY, { Status: { select: { name: "Consumed" } } }, SOURCES_PAGE_ID),
    },
    /only a Ready record may be consumed/,
    SOURCES_CONTRACT,
  );
});

test("sources: a tampered attestation on the canonical page refuses consumption with no write", async (t) => {
  const foreignMarker = await buildRecordApprovalMarker({ ...REGISTRY, callDate: "2026-01-01" }, "Approved");
  await expectRefused(
    t,
    {
      sourcesUrls: [SOURCES_PAGE_URL],
      fromUnit: "Sales",
      toUnit: "Sales",
      sourcesRecord: await callNotesPage(REGISTRY, { "Approval Attestation": rich(foreignMarker) }, SOURCES_PAGE_ID),
    },
    /fields_hash does not match/,
    SOURCES_CONTRACT,
  );
});

test("sources: an Entity binding mismatch on the canonical page refuses consumption with no write", async (t) => {
  await expectRefused(
    t,
    {
      sourcesUrls: [SOURCES_PAGE_URL],
      fromUnit: "Sales",
      toUnit: "Sales",
      sourcesRecord: await callNotesPage(REGISTRY, { Entity: { relation: [{ id: "some-other-entity" }] } }, SOURCES_PAGE_ID),
    },
    /not bound to this Handoff's Entity/,
    SOURCES_CONTRACT,
  );
});

test("sources: a free-text Call_Notes_ID disagreeing with the canonical page is refused -- conflicting references, no write, no search", async (t) => {
  const log = await expectRefused(
    t,
    {
      reason: "Call notes for commercial qualification. Call_Notes_ID: CN-999",
      sourcesUrls: [SOURCES_PAGE_URL],
      fromUnit: "Sales",
      toUnit: "Sales",
    },
    /conflicting references/,
    SOURCES_CONTRACT,
  );
  assert.ok(
    !log.requests.some((r) => r.includes("call-notes-ds/query")),
    "the disagreement is caught at the page level -- neither id triggers a search",
  );
});

test("sources: a Sources-enabled call-notes Handoff on a route with no declared contract is refused -- the free-text reference is never a fallback", async (t) => {
  const log = mockConsumeFetch(t, { sourcesUrls: [SOURCES_PAGE_URL], fromUnit: "Sales", toUnit: "Sales" });
  // No injected contract: production's table has no entry for this route
  // (declaring one is Martin's decision -- the From Unit the isolated
  // project records cannot be verified from this repo).
  const result = await consume();

  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.match(result.reason, /has no Handoff source route contract/);
  assert.equal(log.writes.length, 0, "a refusal issues no write");
  assert.equal(log.liveStatus, "Ready", "a refusal never advances the record");
  assert.ok(
    !log.requests.some((r) => r.includes("call-notes-ds/query")),
    "the DEFAULT_REASON's Call_Notes_ID: CN-007 is NEVER consulted as a fallback for a Handoff whose Sources path could not be validated",
  );
});

// ---------------------------------------------------------------------------
// The source-based Handoff at this boundary: identity from the canonical
// sources, never from token properties the record no longer carries.
// ---------------------------------------------------------------------------

const TOKENLESS_CONTRACT: Readonly<Record<string, HandoffSourceRouteContract>> = {
  "Sales->Sales": { required: ["call_notes"], optional: ["entities", "matters"], prohibited: ["handoffs"] },
};

const TOKENLESS_SOURCES_URLS = [
  `https://www.notion.so/Acme-Entity-${TOKENLESS_ENTITY_PAGE_ID}`,
  `https://www.notion.so/Acme-Matter-${TOKENLESS_MATTER_PAGE_ID}`,
  SOURCES_PAGE_URL,
];

function consumeTokenless() {
  return retrieveAndConsumeCallNotes(
    fakeEnv(),
    "handoff-1",
    { entityToken: "", matterToken: "" },
    pickupContext(),
    TOKENLESS_CONTRACT,
  );
}

test("sources: a Call Notes Handoff with NO token properties consumes its canonical record -- the binding is derived from the Handoff's own Entity/Matter sources", async (t) => {
  const log = mockConsumeFetch(t, {
    sourcesUrls: TOKENLESS_SOURCES_URLS,
    omitTokenProperties: true,
    fromUnit: "Sales",
    toUnit: "Sales",
    sourcesRecord: await callNotesPage(REGISTRY, {
      Entity: { relation: [{ id: TOKENLESS_ENTITY_PAGE_ID }] },
      Matter: { relation: [{ id: TOKENLESS_MATTER_PAGE_ID }] },
    }, SOURCES_PAGE_ID),
  });

  const result = await consumeTokenless();

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.equal(result.pageId, SOURCES_PAGE_ID, "the consumed record is the one the link named");
  assert.equal(result.evidenceText, REGISTRY_EVIDENCE, "identical registry evidence -- only HOW the record was located and bound changed");
  assert.equal(log.liveStatus, "Consumed", "the canonical record advances Ready -> Consumed exactly as before");
  assert.ok(
    log.requests.includes(`GET https://api.notion.com/v1/pages/${TOKENLESS_ENTITY_PAGE_ID}`),
    "the Entity source is fetched by its exact page id",
  );
  assert.ok(
    log.requests.includes(`GET https://api.notion.com/v1/pages/${TOKENLESS_MATTER_PAGE_ID}`),
    "the Matter source is fetched by its exact page id",
  );
  assert.ok(
    !log.requests.some((r) => r.includes("matters-ds/query")),
    "identity is never resolved through the legacy token lookup when the record carries none",
  );
  assert.ok(
    !log.requests.some((r) => r.includes("call-notes-ds/query")),
    "the exact-title search is never issued -- the direct page id IS the reference",
  );
});

test("sources: a tokenless Call Notes Handoff whose sources establish no Entity/Matter binding is refused with no write -- nothing is inferred, and the narrative is never a fallback", async (t) => {
  const log = mockConsumeFetch(t, {
    sourcesUrls: [SOURCES_PAGE_URL],
    omitTokenProperties: true,
    fromUnit: "Sales",
    toUnit: "Sales",
  });

  const result = await consumeTokenless();

  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.match(result.reason, /declares no canonical Entity\/Matter source/);
  assert.equal(log.writes.length, 0, "a refusal issues no write");
  assert.equal(log.liveStatus, "Ready", "a refusal never advances the record");
  assert.ok(
    !log.requests.some((r) => r.includes("call-notes-ds/query")),
    "no search is made to fill a binding the Handoff never declared",
  );
});

test("sources: a tokenless Call Notes Handoff whose Matter source belongs to a different Entity is refused with no write", async (t) => {
  const log = mockConsumeFetch(t, {
    sourcesUrls: TOKENLESS_SOURCES_URLS,
    omitTokenProperties: true,
    fromUnit: "Sales",
    toUnit: "Sales",
    sourcesRecord: await callNotesPage(REGISTRY, {
      Entity: { relation: [{ id: TOKENLESS_ENTITY_PAGE_ID }] },
      Matter: { relation: [{ id: TOKENLESS_MATTER_PAGE_ID }] },
    }, SOURCES_PAGE_ID),
  });
  // Break the relationship proof at the MATTER source the Handoff names:
  // its Entity relation points somewhere else entirely.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const urlStr = String(url);
    if (urlStr.endsWith(`/pages/${TOKENLESS_MATTER_PAGE_ID}`)) {
      return new Response(
        JSON.stringify({
          id: TOKENLESS_MATTER_PAGE_ID,
          url: `https://notion.so/${TOKENLESS_MATTER_PAGE_ID}`,
          parent: { type: "data_source_id", data_source_id: "matters-ds" },
          properties: {
            Matter_ID: { unique_id: { number: 12, prefix: "M" } },
            Entity: { relation: [{ id: "some-other-entity" }] },
          },
        }),
        { status: 200 },
      );
    }
    return (originalFetch as any)(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await consumeTokenless();

  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.match(result.reason, /does not belong to that Entity/);
  assert.equal(log.writes.length, 0, "a refusal issues no write");
});
