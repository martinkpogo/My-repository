/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { adoptHandoffOwnership, runWithAdoptedOwnership, STAGED_INTERACTION_FIELDS } from "./handoffOwnership";
import { findCallbackPrefixOwner, findUnitManifest } from "./units/registry";
import { findCallbackHandler } from "./units/unitManifest";
import { resolveAwaitingHandler } from "./units/awaitingDispatch";
import * as finance from "./units/finance/valueBasedPricingAssessor";
import type { Env, WorkState } from "./types";

/**
 * Covers the cross-Unit Handoff pickup ownership contract (see
 * src/handoffOwnership.ts and docs/enig-operating-model.md, "Handoff is a
 * Business Object, not a routing subsystem"):
 *
 *  1. A pickup ADOPTS the Handoff's destination facts as the Work's recorded
 *     Unit/Hat/Action, so the receiving Unit owns the interaction from the
 *     moment it claims the Handoff -- buttons, awaiting replies, declared
 *     Skills and Access authority all resolve against it (the reported bug:
 *     "Redo Finance Quote" did nothing on a Strategy-originated session).
 *  2. A Work that already records that destination is untouched (the
 *     external path inits a new session with exactly these values).
 *  3. Every ambiguity fails closed BEFORE the handler runs, so nothing is
 *     claimed and nothing is persisted -- the Handoff stays Pending.
 *  4. The sending Unit's staged interaction does not travel with the Work,
 *     and its old buttons are refused by prefix ownership rather than
 *     silently doing nothing.
 */

const FINANCE_HAT = "Value-Based Pricing Assessor";
const STRATEGY_HAT = "Strategy Analyst";
const SALES_HAT = "Sales Executive";

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
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    WORKSPACE_TOPIC_ID: "100",
    OPERATIONS_TOPIC_ID: "14",
  } as any;
}

interface NotionCall {
  method: string;
  url: string;
}

/** Serves Handoff page reads (GET /v1/pages/<id>) and Activity-log creates (POST /v1/pages); throws on anything else. */
function mockNotion(t: any, pages: Record<string, unknown>): NotionCall[] {
  const originalFetch = globalThis.fetch;
  const calls: NotionCall[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.includes("api.notion.com")) throw new Error(`Unexpected fetch in test: ${url}`);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (method === "GET" && url.includes("/v1/pages/")) {
      const id = url.split("/v1/pages/")[1].split("?")[0];
      const page = pages[id];
      if (!page) return new Response(JSON.stringify({ message: "Could not find page." }), { status: 404 });
      return new Response(JSON.stringify(page), { status: 200 });
    }
    if (method === "POST" && url.replace(/\/+$/, "").endsWith("/v1/pages")) {
      return new Response(JSON.stringify({ id: "activity-page", url: "https://notion.so/activity-page", properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected Notion request in test: ${method} ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

function handoffPage(id: string, toUnit: string, toHat: string, reason = "Approved work ready for the receiving Unit.") {
  return {
    id,
    url: `https://notion.so/${id}`,
    parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
    properties: {
      "To Unit": { select: { name: toUnit } },
      "To Hat": { rich_text: [{ plain_text: toHat }] },
      Reason: { rich_text: [{ plain_text: reason }] },
    },
  };
}

/** A Strategy-owned session mid-chain: exactly the state the reported bug ran on. */
function strategyState(): WorkState {
  const state: WorkState = {
    workId: "work-1",
    chatId: 9999,
    threadId: 100,
    unit: "Strategy",
    hat: STRATEGY_HAT,
    actionName: "diagnose",
    stage: "in_progress",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    handoffId: "handoff-finance",
    // The sending Unit's staged interaction: none of it may travel.
    awaiting: "strategy_feedback",
    pendingActionSummary: {
      label: "Strategy proposal",
      message: "Approve this proposal?",
      buttons: [[{ text: "Approve", callback_data: "sprop:work-1:1.a" }]],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    pendingStrategyApproval: {
      kind: "strategy_intervention",
      strategyWorkSessionId: "work-1",
      proposalId: "prop-1",
      proposalVersion: 1,
      decisionOptions: ["approve", "refine", "reject"],
    },
    workStatus: { hat: STRATEGY_HAT, header: "Strategy Analyst — diagnose", done: ["read Handoff"] },
    workStatusMessageId: 4242,
  };
  return state;
}

function clone(state: WorkState): WorkState {
  return JSON.parse(JSON.stringify(state));
}

test("pickup adopts the Handoff destination: Strategy-owned Work records Finance/Value-Based Pricing Assessor/price before its handler runs", async (t) => {
  const calls = mockNotion(t, { "handoff-finance": handoffPage("handoff-finance", "Finance", FINANCE_HAT) });
  const state = strategyState();
  const before = clone(state);

  const seen: WorkState[] = [];
  const result = await runWithAdoptedOwnership(fakeEnv(), state, "Finance", async (adopted) => {
    seen.push(adopted);
    return adopted;
  });

  assert.strictEqual(seen.length, 1, "the pickup handler must run exactly once");
  assert.strictEqual(seen[0], state, "ownership is adopted on the SAME Work, not a copy -- no second session");
  assert.strictEqual(result, state, "the adopted state is what the caller saves");
  assert.strictEqual(state.unit, "Finance", "the receiving Unit owns the Work");
  assert.strictEqual(state.hat, FINANCE_HAT, "the destination Hat is the one the Handoff names");
  assert.strictEqual(state.actionName, "price", "the resolved pickup Action is what Access and Skills resolve from here on");

  // Identity and chain continuity are untouched: same Work, same chat, same
  // Handoff (the very record handlePickup will claim).
  assert.strictEqual(state.workId, before.workId, "workId must not change -- the session is reused, never duplicated");
  assert.strictEqual(state.chatId, before.chatId, "chatId must not change");
  assert.strictEqual(state.threadId, before.threadId, "threadId must not change");
  assert.strictEqual(state.handoffId, before.handoffId, "handoffId must stay the Handoff being claimed");

  // The sending Unit's staged interaction does not travel.
  assert.strictEqual(state.awaiting, undefined, "a stale awaiting reply must not survive the transfer");
  assert.strictEqual(state.pendingActionSummary, undefined, "a stale re-sent approval button must not survive");
  assert.strictEqual(state.pendingStrategyApproval, undefined, "the sending Unit's staged approval must not survive");
  assert.strictEqual(state.workStatus, undefined, "a stale status bubble must not be edited by the receiving Unit");
  assert.strictEqual(state.workStatusMessageId, undefined, "the receiving Unit must not edit the sending Unit's status message");

  assert.ok(
    calls.some((c) => c.method === "POST"),
    "the transfer is recorded in the Activity & Decision Log as governance evidence",
  );
});

test("pickup adoption is a strict no-op when the Work already records that destination (the external path's init values)", async (t) => {
  const calls = mockNotion(t, { "handoff-finance": handoffPage("handoff-finance", "Finance", FINANCE_HAT) });
  const state: WorkState = {
    workId: "work-external",
    chatId: 9999,
    unit: "Finance",
    hat: FINANCE_HAT,
    actionName: "price",
    stage: "in_progress",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    handoffId: "handoff-finance",
    awaiting: "value_context_more",
    pendingActionSummary: {
      label: "Quote",
      message: "Approve quote?",
      buttons: [[{ text: "Approve", callback_data: "quote:work-external:approve" }]],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  };

  let ran = 0;
  await runWithAdoptedOwnership(fakeEnv(), state, "Finance", async (adopted) => {
    ran++;
    return adopted;
  });

  assert.strictEqual(ran, 1, "the handler must still run");
  assert.strictEqual(state.unit, "Finance", "unit unchanged");
  assert.strictEqual(state.hat, FINANCE_HAT, "hat unchanged");
  assert.strictEqual(state.actionName, "price", "action unchanged");
  assert.strictEqual(state.awaiting, "value_context_more", "an already-correct Work keeps its OWN awaiting state -- adoption never clears it");
  assert.ok(state.pendingActionSummary, "an already-correct Work keeps its own staged approval");
  assert.equal(
    calls.filter((c) => c.method === "POST").length,
    0,
    "no transfer means nothing to log -- no Activity write for a no-op",
  );
});

test("pickup refuses closed when the Handoff names a different destination Unit -- handler never runs, state unchanged", async (t) => {
  mockNotion(t, { "handoff-finance": handoffPage("handoff-finance", "Sales", SALES_HAT) });
  const state = strategyState();
  const before = clone(state);
  let ran = 0;

  await assert.rejects(
    () =>
      runWithAdoptedOwnership(fakeEnv(), state, "Finance", async () => {
        ran++;
        return state;
      }),
    /does not match this discovery loop's Unit "Finance"/,
    "the destination-mismatch reason must reach the failure report",
  );
  assert.strictEqual(ran, 0, "no handler may run on a session whose ownership could not be established");
  assert.deepStrictEqual(state, before, "a refused adoption leaves the Work exactly as it was");
});

test("pickup refuses closed when the destination names a Hat the Unit does not declare", async (t) => {
  mockNotion(t, { "handoff-finance": handoffPage("handoff-finance", "Finance", "Ghost Hat") });
  const state = strategyState();
  const before = clone(state);
  let ran = 0;

  await assert.rejects(
    () =>
      runWithAdoptedOwnership(fakeEnv(), state, "Finance", async () => {
        ran++;
        return state;
      }),
    /refusing to run the Finance pickup/,
    "an unregistered destination Hat must stop the pickup",
  );
  assert.strictEqual(ran, 0, "the handler must not run");
  assert.deepStrictEqual(state, before, "nothing partial is mutated");
});

test("pickup refuses closed when the Work records no Handoff at all -- no network call is made", async (t) => {
  const calls = mockNotion(t, {});
  const state = strategyState();
  state.handoffId = undefined;

  await assert.rejects(
    () => runWithAdoptedOwnership(fakeEnv(), state, "Finance", async () => state),
    /no Handoff recorded on the Work/,
    "a pickup that cannot name the Handoff owning it must not guess",
  );
  assert.strictEqual(calls.length, 0, "nothing is even read when there is no Handoff");
});

test("full Strategy -> Finance -> Sales chain transfers ownership twice on the same Work", async (t) => {
  mockNotion(t, {
    "handoff-finance": handoffPage("handoff-finance", "Finance", FINANCE_HAT),
    "handoff-sales": handoffPage("handoff-sales", "Sales", SALES_HAT),
  });
  const state = strategyState();

  await runWithAdoptedOwnership(fakeEnv(), state, "Finance", async (adopted) => adopted);
  assert.strictEqual(`${state.unit}/${state.hat}/${state.actionName}`, `Finance/${FINANCE_HAT}/price`, "first leg adopts Finance");

  // Exactly what valueBasedPricingAssessor does when it queues its own
  // outbound Handoff: adopt the new record on the same session.
  state.handoffId = "handoff-sales";
  await runWithAdoptedOwnership(fakeEnv(), state, "Sales", async (adopted) => adopted);
  assert.strictEqual(
    `${state.unit}/${state.hat}/${state.actionName}`,
    `Sales/${SALES_HAT}/proposal_draft`,
    "second leg adopts Sales on the same Work -- still no second session",
  );
  assert.strictEqual(state.workId, "work-1", "one Work, one session, for the whole chain");
  assert.strictEqual(state.handoffId, "handoff-sales", "the Work tracks the Handoff currently being claimed");
});

test("after adoption the receiving Unit's buttons and replies resolve; the sending Unit's do not", async (t) => {
  mockNotion(t, { "handoff-finance": handoffPage("handoff-finance", "Finance", FINANCE_HAT) });
  const strategyHat = findUnitManifest("Strategy")!.hats[STRATEGY_HAT];
  const financeHat = findUnitManifest("Finance")!.hats[FINANCE_HAT];

  // The bug, stated as a lookup: before the transfer, Finance's own buttons
  // and continuations resolve to nothing on a Strategy-owned session.
  assert.strictEqual(findCallbackHandler("quote", strategyHat), undefined, "Finance's quote buttons are unreachable under the sending Unit");
  assert.strictEqual(
    resolveAwaitingHandler({ unit: "Strategy", hat: STRATEGY_HAT, awaiting: "quote_redo_reason" }),
    undefined,
    "Finance's awaiting replies are unreachable under the sending Unit",
  );

  const state = strategyState();
  await adoptHandoffOwnership(fakeEnv(), state, "Finance");

  assert.strictEqual(typeof findCallbackHandler("quote", financeHat), "function", "Redo/Approve quote buttons now reach Finance's handler");
  assert.strictEqual(
    resolveAwaitingHandler({ unit: state.unit!, hat: state.hat!, awaiting: "quote_redo_reason" }),
    finance.handleQuoteRedoReason,
    "Finance's awaiting reply resolves to the exact handler the old switch case called",
  );
  assert.strictEqual(findCallbackHandler("sprop", financeHat), undefined, "a stale Strategy button stays unreachable");
  assert.strictEqual(
    resolveAwaitingHandler({ unit: "Finance", hat: FINANCE_HAT, awaiting: "strategy_feedback" }),
    undefined,
    "a stale Strategy awaiting reply stays unreachable",
  );
});

test("stale buttons are refused by prefix ownership, and infrastructure/unknown prefixes are not claimed by any Unit", () => {
  // A prefix owned by ANOTHER Unit is what handleCallback reports as stale
  // ("this button belongs to X, this work now runs as Y") instead of doing
  // nothing -- so ownership lookup must find it from the receiving side.
  assert.deepStrictEqual(findCallbackPrefixOwner("sprop"), { unit: "Strategy", hat: STRATEGY_HAT }, "sprop is Strategy's");
  assert.deepStrictEqual(findCallbackPrefixOwner("strategyhandoff"), { unit: "Strategy", hat: STRATEGY_HAT });
  assert.deepStrictEqual(findCallbackPrefixOwner("quote"), { unit: "Finance", hat: FINANCE_HAT }, "quote is Finance's");
  assert.deepStrictEqual(findCallbackPrefixOwner("salesprop"), { unit: "Sales", hat: SALES_HAT });

  // Infrastructure prefixes stay hardcoded in handleCallback and belong to
  // no Unit, so they must not be reported as a stale Unit button.
  assert.strictEqual(findCallbackPrefixOwner("googleaccount"), undefined, "Google OAuth is infrastructure, not a Unit decision");
  assert.strictEqual(findCallbackPrefixOwner("googlefolder"), undefined);
  assert.strictEqual(findCallbackPrefixOwner("googleaction"), undefined);
  assert.strictEqual(findCallbackPrefixOwner("switch"), undefined, "infrastructure routing callbacks belong to no Unit");
  assert.strictEqual(findCallbackPrefixOwner("nonsense-prefix"), undefined, "an unknown prefix keeps today's silent no-op");
});

test("a transfer clears every staged-interaction field and deliberately retains session infrastructure", async (t) => {
  mockNotion(t, { "handoff-finance": handoffPage("handoff-finance", "Finance", FINANCE_HAT) });
  const state = strategyState();
  // Seed every field on the list with a sentinel, whatever its real type,
  // so this test proves the clearing itself rather than one fixture's state.
  for (const field of STAGED_INTERACTION_FIELDS) {
    (state as unknown as Record<string, unknown>)[field] = field === "workStatusMessageId" ? 1 : { sentinel: field };
  }
  (state as unknown as Record<string, unknown>).pendingGoogleAction = { sentinel: "google" };

  await adoptHandoffOwnership(fakeEnv(), state, "Finance");

  for (const field of STAGED_INTERACTION_FIELDS) {
    assert.strictEqual(
      (state as unknown as Record<string, unknown>)[field],
      undefined,
      `${field} must not travel from the sending Unit to the receiving one`,
    );
  }
  assert.deepStrictEqual(
    (state as unknown as Record<string, unknown>).pendingGoogleAction,
    { sentinel: "google" },
    "pendingGoogleAction is session infrastructure (OAuth), deliberately retained",
  );
});
