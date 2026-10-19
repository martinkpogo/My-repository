import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../../types";
import { workSessionReadContext } from "../../access";
import { buildRecordApprovalMarker } from "../../records/callNotes/callNotesMarker";
import {
  COMMERCIAL_VALUE_EVIDENCE_START,
  serializeCommercialValueEvidenceBlock,
} from "../../handoffContracts/commercialValueEvidence";
import { STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END } from "../../handoffContracts/strategyBoundary";
import { resolveHandoffBusinessContext } from "./valueBasedPricingAssessor";

// Finance reads the Commercial Value Evidence block from the approved Call
// Notes record its Strategy -> Finance Handoff names in `Sources` (Martin,
// 2026-10-19). Nothing is copied into the Handoff; a declared source that
// cannot be proven is refused; a record whose Note carries no block leaves
// the existing no-block path untouched.

const PAGE_ID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PAGE_URL = `https://www.notion.so/${PAGE_ID.replace(/-/g, "")}`;
const BOUNDARY = `${STRATEGY_BOUNDARY_START}\n{"proposalId":"p-1","proposalVersion":1}\n${STRATEGY_BOUNDARY_END}`;
const RECORD = { callNotesId: "CN-007", entity: "E-47", matter: "M-12", callDate: "2026-09-01", callType: "Discovery", version: 1 };

const VALUE_BLOCK = serializeCommercialValueEvidenceBlock({
  determination: "Satisfied",
  evidenceText: "GHS 19200 over annual, evidence type: client_estimated, source: client statements.",
  evidence: {
    costOfInaction: { value: 19200, currency: "GHS", period: "annual", evidenceType: "client_estimated", source: "client statements" },
  },
});

function fakeEnv(): Env {
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
    MARTIN_TELEGRAM_USER_ID: "1",
    NOTION_TOKEN: "n",
    TELEGRAM_GROUP_CHAT_ID: "-1",
    WORKSPACE_TOPIC_ID: "1",
    OPERATIONS_TOPIC_ID: "1",
  } as Env;
}

function mockNotion(t: any, opts: { sources?: string; note?: string; attestation: string }) {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${u}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.endsWith("/pages/handoff-1") && method === "GET") {
      return json({
        id: "handoff-1",
        parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
        properties: {
          "From Unit": { select: { name: "Strategy" } },
          "To Unit": { select: { name: "Finance" } },
          "Verified Facts & Sources": { rich_text: [{ plain_text: BOUNDARY }] },
          "Required Next Action": { rich_text: [] },
          Entity_Token: { rich_text: [{ plain_text: "E-47" }] },
          Matter_Token: { rich_text: [{ plain_text: "M-12" }] },
          ...(opts.sources
            ? { Sources: { rich_text: [{ plain_text: opts.sources, href: opts.sources, text: { content: opts.sources, link: { url: opts.sources } } }] } }
            : {}),
        },
      });
    }
    if (u.includes(`/pages/${PAGE_ID}`) && method === "GET") {
      const note = opts.note ?? "";
      return json({
        id: PAGE_ID,
        url: `https://notion.so/${PAGE_ID}`,
        parent: { type: "data_source_id", data_source_id: "call-notes-ds" },
        properties: {
          "Call Notes ID": { title: [{ plain_text: "CN-007" }] },
          Status: { select: { name: "Ready" } },
          Version: { number: 1 },
          "Call Date": { date: { start: "2026-09-01" } },
          "Call Type": { select: { name: "Discovery" } },
          Note: { rich_text: [{ plain_text: note, text: { content: note } }] },
          Entity: { relation: [{ id: "entity-page-1" }] },
          Matter: { relation: [{ id: "matter-page-1" }] },
          "Approval Attestation": { rich_text: [{ plain_text: opts.attestation }] },
        },
      });
    }
    if (u.endsWith("/data_sources/matters-ds/query") && method === "POST") {
      return json({
        results: [
          {
            id: "matter-page-1",
            parent: { type: "data_source_id", data_source_id: "matters-ds" },
            properties: { Matter_ID: { unique_id: { prefix: "M", number: 12 } }, Entity: { relation: [{ id: "entity-page-1" }] }, Status: { select: { name: "Commercial Development" } } },
          },
        ],
      });
    }
    if (u.endsWith("/pages/entity-page-1") && method === "GET") {
      return json({
        id: "entity-page-1",
        parent: { type: "data_source_id", data_source_id: "entity-ds" },
        properties: { Entity_ID: { unique_id: { prefix: "E", number: 47 } } },
      });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

async function read() {
  return resolveHandoffBusinessContext(fakeEnv(), "handoff-1", workSessionReadContext());
}

test("Finance reads the Commercial Value Evidence block from the Call Notes Note named in Sources", async (t) => {
  const attestation = await buildRecordApprovalMarker(RECORD, "Approved");
  mockNotion(t, { sources: PAGE_URL, attestation, note: `Discovery call notes.\n\n${VALUE_BLOCK}` });

  const result = await read();

  assert.ok(result.success, result.success ? "" : result.insufficientContext.reason);
  assert.ok(result.contract.sanitizedContext.includes(VALUE_BLOCK), "the block is carried byte-for-byte into the judgment context");
  assert.ok(!result.contract.sanitizedContext.includes("Discovery call notes"), "only the block is taken, never the rest of the Note");
});

test("Finance proceeds on its existing no-block path when the record's Note carries no block", async (t) => {
  const attestation = await buildRecordApprovalMarker(RECORD, "Approved");
  mockNotion(t, { sources: PAGE_URL, attestation, note: "Discovery call notes with no structured block." });

  const result = await read();

  assert.ok(result.success, result.success ? "" : result.insufficientContext.reason);
  assert.ok(!result.contract.sanitizedContext.includes(COMMERCIAL_VALUE_EVIDENCE_START));
});

test("Finance with no Sources behaves exactly as before and reads no Call Notes page", async (t) => {
  const attestation = await buildRecordApprovalMarker(RECORD, "Approved");
  const requests = mockNotion(t, { attestation });

  const result = await read();

  assert.ok(result.success, result.success ? "" : result.insufficientContext.reason);
  assert.ok(!requests.some((r) => r.includes(PAGE_ID)), "no source page is fetched");
});

test("Finance refuses a declared source whose approval attestation does not verify -- the Note is never used", async (t) => {
  const good = await buildRecordApprovalMarker(RECORD, "Approved");
  const tampered = good.replace(/fields_hash=[0-9a-f]+/, `fields_hash=${"0".repeat(64)}`);
  mockNotion(t, { sources: PAGE_URL, attestation: tampered, note: VALUE_BLOCK });

  const result = await read();

  assert.strictEqual(result.success, false);
  if (!result.success) assert.strictEqual(result.insufficientContext.category, "declared evidence source");
});

test("Finance refuses a defective Sources link outright", async (t) => {
  const attestation = await buildRecordApprovalMarker(RECORD, "Approved");
  mockNotion(t, { sources: "https://www.notion.so/not-an-exact-page", attestation, note: VALUE_BLOCK });

  const result = await read();

  assert.strictEqual(result.success, false);
});

test("Finance refuses a Note whose Commercial Value Evidence block is malformed -- never repaired", async (t) => {
  const attestation = await buildRecordApprovalMarker(RECORD, "Approved");
  mockNotion(t, { sources: PAGE_URL, attestation, note: `${COMMERCIAL_VALUE_EVIDENCE_START}\n{not json\n=== END COMMERCIAL VALUE EVIDENCE ===` });

  const result = await read();

  assert.strictEqual(result.success, false);
  if (!result.success) assert.match(result.insufficientContext.reason, /cannot be used/);
});
