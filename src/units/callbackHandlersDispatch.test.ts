import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { findCallbackHandler, type ApprovalCallbackHandler } from "./unitManifest";
import { getUnitManifests } from "./registry";
import {
  salesManifest,
  entityChoiceCallback,
  matterChoiceCallback,
  salesProposalDecisionCallback,
} from "./sales/salesManifest";
import { strategyManifest, interventionApprovalCallback } from "./strategy/strategyManifest";
import * as sales from "./sales/salesExecutive";
import * as strategy from "./strategy/strategyAnalyst";
import * as salesProposal from "./sales/tokenSafeProposal";
import type { StrategyProposal } from "./strategy/strategyAnalyst";
import type { Env, WorkState } from "../types";

/**
 * Covers WP7's dispatch contract: handleCallback's Unit-specific business
 * prefix branches (entity, matter, sprop, salesprop) moved onto the owning
 * Hat's HatManifest.callbackHandlers, while the Google OAuth prefixes stay
 * hardcoded as infrastructure. For each moved prefix this file proves the
 * manifest entry resolves by identity, and -- by running the manifest entry
 * and a direct call to the exact former handler on identical cloned states
 * under a recording fetch mock -- that a reply reaches the SAME handler with
 * the SAME parsed arguments (identical outcome and identical request log,
 * timestamps/UUIDs masked). A differential probe per prefix proves the raw
 * callback value genuinely flows through (a constant or mis-parsed argument
 * would collapse the two observed behaviors). Unknown prefixes keep
 * today's response: no manifest entry, session's default resolves the state
 * unchanged.
 */

function fakeEnv(): Env {
  return {
    // One superset JSON for every AI task these flows ask for -- parity does
    // not depend on the content, only on both sides seeing the same one.
    AI: {
      run: async () => ({
        response: JSON.stringify({
          name: "Draft name",
          stated_need: "Stated need",
          summary: "Summary",
          title: "Title",
          draft: "Draft",
          reason: "Reason",
        }),
      }),
    } as any,
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

/** Mask nondeterministic content (timestamps minted mid-flow, UUIDs) so parity compares behavior, not the clock. */
function mask(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
}

interface Observation {
  /** The settled run: final state, or the error both sides must share. */
  outcome: string;
  /** Every fetch the run performed, as "METHOD url body", masked. */
  requests: string[];
}

/**
 * Installs a recording, shape-generous fetch mock (Telegram, Notion
 * query/retrieve/update/create, anything else -> plain 200), runs the given
 * call on a fresh env, and returns the masked outcome + request log. The
 * mock answers only from the request itself, so two runs of identical input
 * produce identical output -- any argument difference shows up as a
 * difference in this observation.
 */
async function observed(
  run: (env: Env, state: WorkState) => Promise<WorkState>,
  makeState: () => WorkState,
): Promise<Observation> {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push(`${method} ${url} ${body}`);
    if (url.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.includes("/query")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    const page = (id: string) =>
      JSON.stringify({
        id,
        url: `https://notion.so/${id}`,
        parent: { type: "data_source_id", data_source_id: "some-ds" },
        properties: {
          Matter: { title: [{ plain_text: "Matter X" }] },
          "Entity Record": { title: [{ plain_text: "Entity X" }] },
          Entity_ID: { unique_id: { prefix: "E", number: 1 } },
          Status: { select: { name: "Open" } },
        },
      });
    if (method === "GET" && url.includes("/pages/")) {
      return new Response(page(url.split("/pages/").pop() ?? "page"), { status: 200 });
    }
    if (method === "PATCH" && url.includes("/pages/")) {
      return new Response(page(url.split("/pages/").pop() ?? "page"), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/pages")) {
      return new Response(page("created-page"), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  let outcome: string;
  try {
    const env = fakeEnv();
    const state = makeState();
    try {
      const result = await run(env, state);
      outcome = mask(JSON.stringify({ ok: true, state: result }));
    } catch (err) {
      // Name+message only (no stack): the stack names the adapter's file on
      // one side and the handler's on the other, which is the point of the
      // move, not a behavioral difference.
      outcome = mask(JSON.stringify({ ok: false, error: `${(err as Error).name}: ${(err as Error).message}` }));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { outcome, requests: requests.map(mask) };
}

/** entry + raw value must settle exactly like a direct call with the parsed arguments -- same handler, same args. */
async function assertParity(
  label: string,
  entry: ApprovalCallbackHandler,
  value: string,
  makeState: () => WorkState,
  direct: (env: Env, state: WorkState) => Promise<WorkState>,
): Promise<Observation> {
  const viaManifest = await observed((env, state) => entry(env, state, false, value), makeState);
  const viaDirect = await observed(direct, makeState);
  assert.strictEqual(viaManifest.outcome, viaDirect.outcome, `${label}: identical outcome -- same handler with the same parsed arguments`);
  assert.deepStrictEqual(viaManifest.requests, viaDirect.requests, `${label}: identical request log -- same handler with the same parsed arguments`);
  return viaManifest;
}

/** The raw value must genuinely change what runs -- a constant or mis-routed argument cannot pass this. */
async function assertValueMatters(
  label: string,
  entry: ApprovalCallbackHandler,
  valueA: string,
  valueB: string,
  makeState: () => WorkState,
): Promise<void> {
  const a = await observed((env, state) => entry(env, state, false, valueA), makeState);
  const b = await observed((env, state) => entry(env, state, false, valueB), makeState);
  assert.notStrictEqual(
    `${a.outcome}|${a.requests.join("|")}`,
    `${b.outcome}|${b.requests.join("|")}`,
    `${label}: two different callback values must reach the handler with two different arguments`,
  );
}

function salesState(): WorkState {
  return {
    workId: "work_cb_sales",
    chatId: 1,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "handle_request",
    stage: "awaiting_reply",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enquiryText: "We're a bakery chain and our branding feels dated, can you help?",
  };
}

function strategyState(): WorkState {
  return {
    workId: "work_cb_strategy",
    chatId: 1,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "awaiting_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    strategyApprovalState: "AWAITING_INTERVENTION_APPROVAL",
    // Only the fields identityMatches reads at runtime are constructed here
    // (proposalId + proposalVersion); the full StrategyProposal shape is
    // strategyAnalyst.test's own subject.
    strategyProposal: { proposalId: "prop-1", proposalVersion: 2 } as StrategyProposal,
    pendingStrategyApproval: {
      kind: "strategy_intervention",
      strategyWorkSessionId: "work_cb_strategy",
      proposalId: "prop-1",
      proposalVersion: 2,
      decisionOptions: ["approve", "refine", "reject"],
    },
  };
}

function proposalState(): WorkState {
  const state = salesState();
  state.salesProposal = {
    pageId: "prop-page-1",
    pageUrl: "https://notion.so/prop-page-1",
    proposalId: "PROP-7",
    proposalNumber: 7,
    handoffId: "ho-1",
    handoffRef: "HO-1",
    entityToken: "ENT-1",
    matterToken: "MAT-1",
    currentVersion: 1,
    approvalStatus: "Pending Approval",
    artifactStatus: "Not Requested",
    versions: [],
    amendments: [],
  };
  return state;
}

test("WP7 classification: handleCallback keeps only the Google OAuth cases; the four business cases are gone and the default still resolves unknown prefixes unchanged", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "session.ts"), "utf8");
  for (const gone of ['case "entity":', 'case "matter":', 'case "sprop":', "case salesProposal.PROPOSAL_CALLBACK_ACTION:"]) {
    assert.ok(!src.includes(gone), `${gone} must no longer be a hardcoded case in session.ts`);
  }
  for (const stays of ['case "googleaccount":', 'case "googlefolder":', 'case "googleaction":']) {
    assert.ok(src.includes(stays), `${stays} must remain hardcoded -- Google OAuth is infrastructure, not a Hat decision`);
  }
  assert.ok(src.includes("return Promise.resolve(state);"), "an unknown prefix must still resolve the state unchanged (today's response)");
});

test("WP7 routing: each moved business prefix resolves through findCallbackHandler to its manifest entry", () => {
  const se = salesManifest.hats["Sales Executive"];
  const sa = strategyManifest.hats["Strategy Analyst"];
  assert.strictEqual(findCallbackHandler("entity", se), entityChoiceCallback, "entity routes to the relocated picker callback");
  assert.strictEqual(findCallbackHandler("matter", se), matterChoiceCallback, "matter routes to the relocated picker callback");
  assert.strictEqual(findCallbackHandler("sprop", sa), interventionApprovalCallback, "sprop routes to the relocated intervention callback");
  // Also pins the literal key to tokenSafeProposal's exported constant (the
  // manifest spells the key literally to avoid a circular-import TDZ).
  assert.strictEqual(salesProposal.PROPOSAL_CALLBACK_ACTION, "salesprop");
  assert.strictEqual(findCallbackHandler(salesProposal.PROPOSAL_CALLBACK_ACTION, se), salesProposalDecisionCallback, "salesprop routes to the relocated decision callback");
});

test("WP7 classification: no manifest claims any infrastructure prefix -- Google OAuth stays hardcoded", () => {
  for (const manifest of Object.values(getUnitManifests())) {
    for (const hat of Object.values(manifest.hats)) {
      for (const prefix of ["googleaccount", "googlefolder", "googleaction"]) {
        assert.strictEqual(findCallbackHandler(prefix, hat), undefined, `${prefix} must not appear in any manifest's callbackHandlers`);
      }
    }
  }
});

test("entity: reaches sales.handleEntityChoice with the raw chosen value", async () => {
  await assertParity(
    "entity",
    entityChoiceCallback,
    "entity-page-1",
    salesState,
    (env, state) => sales.handleEntityChoice(env, state, "entity-page-1"),
  );
  // Non-vacuous: "new" takes the draft path (no page read), the page id
  // takes the read path -- so the raw value demonstrably flows through.
  await assertValueMatters("entity", entityChoiceCallback, "new", "entity-page-1", salesState);
});

test("matter: reaches sales.handleMatterChoice with the raw chosen value", async () => {
  await assertParity(
    "matter",
    matterChoiceCallback,
    "matter-page-1",
    salesState,
    (env, state) => sales.handleMatterChoice(env, state, "matter-page-1"),
  );
  await assertValueMatters("matter", matterChoiceCallback, "new", "matter-page-1", salesState);
});

test("sprop: parses '<version>.<a|r|j>' exactly as the old switch case and reaches strategy.handleInterventionApproval", async () => {
  // Refine and reject on a live approval: the parsed version AND decision
  // land in the handler's observable state changes.
  await assertParity(
    "sprop refine",
    interventionApprovalCallback,
    "2.r",
    strategyState,
    (env, state) => strategy.handleInterventionApproval(env, state, 2, "refine"),
  );
  await assertParity(
    "sprop reject",
    interventionApprovalCallback,
    "2.j",
    strategyState,
    (env, state) => strategy.handleInterventionApproval(env, state, 2, "reject"),
  );
  // A stale version takes the mismatch path, whose Activity-Log rationale
  // names the parsed version -- so version parsing is observable too.
  await assertParity(
    "sprop stale version",
    interventionApprovalCallback,
    "99.r",
    strategyState,
    (env, state) => strategy.handleInterventionApproval(env, state, 99, "refine"),
  );
  // A malformed value is the old switch's no-op: state unchanged, no request.
  const noop = await observed((env, state) => interventionApprovalCallback(env, state, false, "garbage"), strategyState);
  assert.ok(noop.outcome.includes('"ok":true'), "malformed sprop value still resolves the state, as before");
  assert.deepStrictEqual(noop.requests, [], "a malformed sprop value issues no request, exactly like the old early return");
  await assertValueMatters("sprop", interventionApprovalCallback, "2.r", "2.j", strategyState);
});

test("salesprop: parses '<number>.<version>.<a|r>' exactly as the old switch case and reaches salesProposal.handleSalesProposalDecision", async () => {
  // Revise on a live proposal: parsed number + version land in
  // pendingSalesProposalRevision and the awaiting state.
  await assertParity(
    "salesprop revise",
    salesProposalDecisionCallback,
    "7.1.r",
    proposalState,
    (env, state) => salesProposal.handleSalesProposalDecision(env, state, 7, 1, "revise"),
  );
  // A wrong proposal number takes the stale path whose message names the
  // parsed number -- number parsing is observable.
  await assertParity(
    "salesprop stale number",
    salesProposalDecisionCallback,
    "9.1.a",
    proposalState,
    (env, state) => salesProposal.handleSalesProposalDecision(env, state, 9, 1, "approve"),
  );
  // Approve: same handler, same parsed arguments (the proof minting itself
  // is tokenSafeProposal.test's subject and runs inside the same function).
  await assertParity(
    "salesprop approve",
    salesProposalDecisionCallback,
    "7.1.a",
    proposalState,
    (env, state) => salesProposal.handleSalesProposalDecision(env, state, 7, 1, "approve"),
  );
  const noop = await observed((env, state) => salesProposalDecisionCallback(env, state, false, "7.1.z"), proposalState);
  assert.ok(noop.outcome.includes('"ok":true'), "a malformed salesprop value still resolves the state, as before");
  assert.deepStrictEqual(noop.requests, [], "a malformed salesprop value issues no request, exactly like the old early return");
  await assertValueMatters("salesprop", salesProposalDecisionCallback, "7.1.r", "7.1.a", proposalState);
});
