/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { discoverPendingHandoffsForUnit, unitsWithHandoffPickup } from "./checkHandoffs";
import {
  PENDING_PICKUP_KIND_KEY,
  dispatchScheduledPickup,
  schedulePickupAlarm,
  type PickupAlarmStorage,
  type PickupKind,
} from "./sessionRouting";
import { runWithAdoptedOwnership } from "./handoffOwnership";
import { claimPendingHandoff, closeHandoffIfOpen } from "./handoffLifecycle";
import { runWithRecordedActionSkills } from "./runtime/actionSkills";
import { buildUnitRegistry, findUnitManifest, getUnitManifests } from "./units/registry";
import { workSessionContext } from "./access";
import { NO_ACTION_SKILLS } from "./platform/skillRegistry";
import type { HandoffPickupDeclaration, PickupHandler, UnitManifest } from "./units/unitManifest";
import type { Env, Unit, WorkState } from "./types";

/**
 * Integration proof for the modular Handoff pickup chain (see
 * docs/enig-operating-model.md, "Handoff is a Business Object";
 * src/checkHandoffs.ts, src/sessionRouting.ts, src/handoffOwnership.ts).
 *
 * WHAT THIS FILE EXERCISES -- every step below is a REAL production function,
 * called in the order production calls it:
 *
 *   discoverPendingHandoffsForUnit      (src/checkHandoffs.ts  -- the ONE discovery loop)
 *     -> stub.schedulePickup(kind)      (transport boundary; see below)
 *       -> schedulePickupAlarm          (src/sessionRouting.ts -- what WorkSession.schedulePickup does)
 *         -> dispatchScheduledPickup    (src/sessionRouting.ts -- what WorkSession.alarm() dispatches)
 *           -> runWithAdoptedOwnership  (src/handoffOwnership.ts -- ownership before handler)
 *             -> runWithRecordedActionSkills  (src/runtime/actionSkills.ts -- Skills before handler)
 *               -> declaration.handler  (the Unit's own manifest-declared pickup handler)
 *
 * The runner maps are built with the SAME predicate WorkSession.alarm() uses
 * (`for (const unit of unitsWithHandoffPickup()) runners[unit] = ...`), so the
 * Unit->runner selection is production logic, not a hand-written map.
 *
 * WHAT IS DELIBERATELY NOT COVERED -- the Cloudflare session.ts boundary:
 *
 *   `src/session.ts` cannot be imported under the node test runner: its
 *   `cloudflare:workers` Durable Object import is not resolvable there (the
 *   constraint recorded in src/sessionRouting.ts's own module comment). So the
 *   following three pieces of WorkSession are NOT executed by this file, and
 *   no test here claims they are:
 *
 *     1. `WorkSession.schedulePickup` -- a one-line delegate to
 *        `schedulePickupAlarm(this.ctx.storage, kind)`. This file calls
 *        `schedulePickupAlarm` directly with a fake DurableObjectStorage,
 *        which is the exact body of that method.
 *     2. `WorkSession.alarm()` -- builds the runner map from
 *        `unitsWithHandoffPickup()` and calls `dispatchScheduledPickup`. This
 *        file rebuilds that map with the same predicate and calls the same
 *        dispatch. What is NOT covered is only Cloudflare's alarm delivery
 *        itself, plus `alarm()`'s catch -> notifyMartinOfDiscoveryFailure.
 *     3. `WorkSession.runHandoffPickup`'s `execute()` wrapper -- Durable
 *        Object state load/persist and its rollback-on-throw. Ownership
 *        adoption and Skill resolution are exercised here, but the Work
 *        state is a fixture, not a Durable Object, so "nothing is persisted
 *        when a handler throws" is NOT proven by this file.
 *
 * The Durable Object stub (`env.WORK_SESSION.get(...)`) is faked, as it is in
 * every existing test that drives discovery; its `schedulePickup` calls the
 * real `schedulePickupAlarm`, so discovery-to-alarm wiring is real end to end.
 *
 * The synthetic Unit below is registered through the same seams the existing
 * webhook conformance tests use (`buildUnitRegistry` for structural validity,
 * the manifest-table parameter of `unitsWithHandoffPickup` for the pickup
 * predicate). It is NOT in the production registry, and the boundary test at
 * the bottom of this file pins exactly what that costs: `deriveHandoffDestination`
 * resolves its manifest with `findUnitManifest`, which has no table seam, so a
 * Unit outside the real registry can never traverse destination resolution or
 * ownership adoption without a production change.
 */

const SYNTHETIC_UNIT = "Synthetic Test Unit" as Unit;
const SYNTHETIC_HANDOFF_ID = "handoff-synthetic-1";

const FINANCE_UNIT: Unit = "Finance";
const FINANCE_HAT = "Value-Based Pricing Assessor";
const FINANCE_PICKUP_ACTION = "price";
const FINANCE_HANDOFF_ID = "handoff-finance-1";

const STRATEGY_UNIT: Unit = "Strategy";
const STRATEGY_HAT = "Strategy Analyst";
const STRATEGY_SENDING_ACTION = "diagnose";

// --- fakes ------------------------------------------------------------------

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
      return true;
    },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((k) => ({ name: k })),
      list_complete: true,
      cursor: undefined,
    }),
    store,
  };
}

function fakeEnv(kv = fakeKv()): Env & { STATE_KV: ReturnType<typeof fakeKv> } {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: kv,
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

/** A fake DurableObjectStorage: the surface `PickupAlarmStorage` requires. */
function fakeStorage() {
  const store = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage: PickupAlarmStorage = {
    get: async <T = unknown>(key: string): Promise<T | undefined | null> => (store.has(key) ? (store.get(key) as T) : null),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
      return true;
    },
    setAlarm: async (timestamp: number | Date) => {
      alarms.push(Number(timestamp));
    },
  };
  return { storage, store, alarms };
}

/**
 * The WorkSession Durable Object stub, with the two methods the pickup chain
 * touches. `schedulePickup` calls the REAL `schedulePickupAlarm` -- the exact
 * body of `WorkSession.schedulePickup` -- so discovery-to-alarm wiring is
 * production behaviour, not a recording stub. `init` records only: it is a
 * tripwire for "the continuing path must not create a second Work".
 */
function installWorkSessionStub(
  env: Env,
  storage: PickupAlarmStorage,
  calls: { init: any[][]; schedule: string[] },
): void {
  const stub = {
    init: async (...args: any[]) => {
      calls.init.push(args);
    },
    schedulePickup: async (kind: string) => {
      calls.schedule.push(kind);
      await schedulePickupAlarm(storage, kind as PickupKind);
    },
  };
  (env as any).WORK_SESSION = { idFromName: (name: string) => name, get: () => stub };
}

interface HandoffFixture {
  toUnit: string;
  toHat: string;
  reason?: string;
}

function handoffPage(id: string, fixture: HandoffFixture, status: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    // `parent` is what src/notion.ts reads to resolve a page's real target,
    // so every update needs it -- same requirement the lifecycle tests pin.
    parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
    properties: {
      Status: { select: { name: status } },
      "To Unit": { select: { name: fixture.toUnit } },
      "To Hat": { rich_text: [{ plain_text: fixture.toHat }] },
      Reason: { rich_text: [{ plain_text: fixture.reason ?? "Approved work ready for the receiving Unit." }] },
    },
  };
}

/**
 * A mutable Notion fake: the discovery query, Handoff reads, Handoff updates
 * (claim/close) and Activity-log creates the pickup chain makes. `status` is
 * the live record state, so a claim genuinely moves Pending -> Picked-up and a
 * later read observes it. `sequence` records the ORDER of production side
 * effects, which is what the ownership-ordering test asserts against.
 */
function mockNotion(
  t: any,
  handoffs: Record<string, HandoffFixture>,
  status: Record<string, string>,
  sequence: string[],
  activityBodies: any[],
  patchBodies: { id: string; body: any }[],
): void {
  const originalFetch = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    // Discovery failures notify Martin over Telegram; the failure paths here
    // are expected behaviour, so answer them like the API does.
    if (url.includes("api.telegram.org")) return json({ ok: true, result: { message_id: 1 } });
    if (!url.includes("api.notion.com")) throw new Error(`Unexpected fetch in test: ${method} ${url}`);

    if (method === "POST" && url.includes("/data_sources/handoffs-ds/query")) {
      const body = JSON.parse(String(init.body));
      const toUnit = body.filter?.and?.find((f: any) => f.property === "To Unit")?.select?.equals;
      const results = Object.entries(handoffs)
        .filter(([id, fixture]) => fixture.toUnit === toUnit && status[id] === "Pending")
        .map(([id, fixture]) => handoffPage(id, fixture, status[id]));
      return json({ results });
    }
    if (method === "GET" && url.includes("/v1/pages/")) {
      const id = url.split("/v1/pages/")[1].split("?")[0];
      if (handoffs[id]) {
        sequence.push(`handoff-read:${id}`);
        return json(handoffPage(id, handoffs[id], status[id]));
      }
      // A standalone governance page (Hat Definition, Universal Role
      // Contract): its parent is a page, not a data source.
      if (/^[0-9a-f-]{32,36}$/i.test(id)) {
        return json({ id, url, parent: { type: "page", page_id: "governance-root" }, properties: {} });
      }
      return new Response(JSON.stringify({ message: "Could not find page." }), { status: 404 });
    }
    if (method === "PATCH" && url.includes("/v1/pages/")) {
      const id = url.split("/v1/pages/")[1].split("?")[0];
      const body = JSON.parse(String(init.body));
      patchBodies.push({ id, body });
      if (body.properties?.Status?.select?.name) status[id] = body.properties.Status.select.name;
      sequence.push(`handoff-update:${id}:${status[id]}`);
      return json({ id, url, properties: {} });
    }
    if (method === "POST" && url.replace(/\/+$/, "").endsWith("/v1/pages")) {
      activityBodies.push(JSON.parse(String(init.body)));
      sequence.push("activity-log-write");
      return json({ id: "activity-page", url: "https://notion.so/activity-page", properties: {} });
    }

    throw new Error(`Unexpected Notion request in test: ${method} ${url}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

/**
 * A Strategy-owned session mid-chain -- the sending Unit's state, exactly the
 * shape handoffOwnership.ts exists to transfer away from. None of the staged
 * interaction may survive adoption.
 */
function strategyOwnedWork(handoffId: string): WorkState {
  return {
    workId: "work-chain-1",
    chatId: 9999,
    threadId: 100,
    unit: STRATEGY_UNIT,
    hat: STRATEGY_HAT,
    actionName: STRATEGY_SENDING_ACTION,
    stage: "in_progress",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    handoffId,
    awaiting: "strategy_feedback",
    pendingActionSummary: {
      label: "Strategy proposal",
      message: "Approve this proposal?",
      buttons: [[{ text: "Approve", callback_data: "sprop:work-chain-1:1.a" }]],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    strategy: {
      pendingApproval: {
        kind: "strategy_intervention",
        strategyWorkSessionId: "work-chain-1",
        proposalId: "prop-1",
        proposalVersion: 1,
        decisionOptions: ["approve", "refine", "reject"],
      },
    },
    workStatus: { hat: STRATEGY_HAT, header: "Strategy Analyst — diagnose", done: ["read Handoff"] },
    workStatusMessageId: 4242,
  } as WorkState;
}

/**
 * Mirrors `WorkSession.alarm()`'s runner construction (one runner per Unit the
 * registry predicate reports) and `WorkSession.runHandoffPickup`'s body
 * (ownership adoption, then Skill resolution, then the declared handler),
 * using only importable production functions. The one piece it cannot run is
 * `execute()`'s Durable Object persistence -- see the boundary note above.
 */
function runnersMirroringAlarm(
  env: Env,
  state: WorkState,
  declaration: HandoffPickupDeclaration,
  table: Partial<Record<Unit, UnitManifest>> = getUnitManifests(),
): Partial<Record<PickupKind, () => Promise<unknown>>> {
  const runners: Partial<Record<PickupKind, () => Promise<unknown>>> = {};
  for (const unit of unitsWithHandoffPickup(table)) {
    runners[unit] = async () =>
      runWithAdoptedOwnership(env, state, unit, (adopted) => {
        // Adoption guarantees a resolved destination, but WorkState's fields
        // stay optional in the type, so the Hat is guarded explicitly.
        const adoptedUnit = adopted.unit;
        const hatName = adopted.hat;
        const manifest = adoptedUnit ? findUnitManifest(adoptedUnit) : undefined;
        const hat = manifest && hatName ? manifest.hats[hatName] : undefined;
        if (!adoptedUnit || !hatName || !hat) {
          throw new Error(`${adoptedUnit ?? "(no Unit)"} declares no Hat "${hatName ?? "(no Hat)"}"`);
        }
        return runWithRecordedActionSkills(hat, adopted.actionName, (skills) => declaration.handler(env, adopted, skills)).then(
          (outcome) => {
            if (outcome.kind === "refused") throw new Error(outcome.reason);
            return outcome.result;
          },
        );
      });
  }
  return runners;
}

/** The pickup declaration under test: a distinguishable handler that records what it observed. */
function recordingDeclaration(
  seq: string[],
  observed: Array<PickupObservation>,
  body: (env: Env, state: WorkState, seq: string[], observed: PickupObservation[]) => Promise<WorkState>,
): HandoffPickupDeclaration {
  const handler: PickupHandler = async (env, state) => {
    seq.push("handler-entry");
    observed.push({ unit: state.unit, hat: state.hat, actionName: state.actionName, handoffId: state.handoffId });
    return body(env, state, seq, observed);
  };
  return { handler };
}

interface PickupObservation {
  unit: string | undefined;
  hat: string | undefined;
  actionName: string | undefined;
  handoffId: string | undefined;
}

// --- A. Synthetic Unit: discovery -> alarm schedule -> dispatch -> handler --

test("synthetic Unit: its declared pickup handler is selected and invoked through the real discovery -> alarm-schedule -> dispatch chain", async (t) => {
  const seq: string[] = [];
  const observed: PickupObservation[] = [];
  const declaration = recordingDeclaration(seq, observed, async (_env, state) => state);

  // The synthetic Unit's manifest: the same minimal shape the webhook
  // conformance tests register under an unfamiliar Unit key, carrying a real
  // HandoffPickupDeclaration with a distinguishable handler.
  const syntheticManifest = {
    unit: SYNTHETIC_UNIT,
    hats: {},
    intakeClassificationTaskId: "test_intake",
    intakeIntroLine: "synthetic Unit declared only for this integration proof",
    actionClassificationTaskId: "test_action",
    handoffPickup: declaration,
  } as unknown as UnitManifest;

  // Registered through the existing registry-assembly seam: a valid manifest
  // under an unfamiliar Unit key survives buildUnitRegistry unchanged.
  const assembled = buildUnitRegistry({ [SYNTHETIC_UNIT]: syntheticManifest });
  assert.ok(assembled[SYNTHETIC_UNIT], "registry assembly must accept the synthetic Unit's manifest");

  // ...and through the real pickup predicate, over the production registry.
  const table: Partial<Record<Unit, UnitManifest>> = { ...getUnitManifests(), [SYNTHETIC_UNIT]: syntheticManifest };
  assert.ok(
    unitsWithHandoffPickup(table).includes(SYNTHETIC_UNIT),
    "the registry-driven pickup predicate must report the newly registered Unit -- no Unit-specific list",
  );

  const env = fakeEnv();
  const { storage, store } = fakeStorage();
  const calls = { init: [] as any[][], schedule: [] as string[] };
  installWorkSessionStub(env, storage, calls);

  const status: Record<string, string> = { [SYNTHETIC_HANDOFF_ID]: "Pending" };
  const activityBodies: any[] = [];
  const patchBodies: { id: string; body: any }[] = [];
  mockNotion(t, { [SYNTHETIC_HANDOFF_ID]: { toUnit: SYNTHETIC_UNIT, toHat: "Synthetic Pickup Hat" } }, status, seq, activityBodies, patchBodies);

  // Continuing-Work path: this Handoff already has a Work. It is a real
  // production path (the same one the existing same-Work discovery test uses)
  // and the ONLY one reachable for a Unit outside the real registry -- the
  // new-Work branch resolves its destination with findUnitManifest, which has
  // no seam. The boundary test at the bottom of this file pins that limit.
  await env.STATE_KV.put(`handoff_workitem:${SYNTHETIC_HANDOFF_ID}`, "work-existing-1");

  const scheduled = await discoverPendingHandoffsForUnit(env, SYNTHETIC_UNIT, syntheticManifest.handoffPickup);
  assert.strictEqual(scheduled, 1, "the real discovery loop must schedule exactly one pickup for the synthetic Unit");
  assert.deepStrictEqual(calls.schedule, [SYNTHETIC_UNIT], "discovery must record the synthetic Unit's own pickup kind");
  assert.strictEqual(calls.init.length, 0, "the continuing path must not create a second Work");
  assert.strictEqual(store.get(PENDING_PICKUP_KIND_KEY), SYNTHETIC_UNIT, "the real alarm-schedule must have armed this Unit's pickup");

  // Dispatch through the real alarm-side function, with the runner map keyed
  // exactly the way WorkSession.alarm() keys it: one entry per Unit the
  // registry predicate reports. So the runner dispatch selects is picked by
  // production selection, not by a hand-keyed map. Every other Unit's runner
  // is a tripwire that fails the test if dispatch ever reaches it.
  const runners: Partial<Record<PickupKind, () => Promise<unknown>>> = {};
  for (const unit of unitsWithHandoffPickup(table)) {
    runners[unit] = async () => {
      assert.strictEqual(unit, SYNTHETIC_UNIT, `dispatch must never reach another Unit's runner (${unit})`);
      return declaration.handler(env, strategyOwnedWork(SYNTHETIC_HANDOFF_ID), NO_ACTION_SKILLS);
    };
  }
  assert.ok(
    Object.keys(runners).length > 1,
    "the map must hold every declared pickup Unit (real ones included), so dispatch's selection of the synthetic Unit is non-trivial",
  );
  const ran = await dispatchScheduledPickup(storage, runners);
  assert.strictEqual(ran, SYNTHETIC_UNIT, "dispatch must run the runner registered for the synthetic Unit");
  assert.deepStrictEqual(seq, ["handler-entry"], "the synthetic Unit's declared handler must be the handler that ran");
  assert.strictEqual(observed.length, 1);
  assert.strictEqual(observed[0].handoffId, SYNTHETIC_HANDOFF_ID);
  assert.ok(!store.has(PENDING_PICKUP_KIND_KEY), "the pending kind is single-shot: consumed by dispatch, never re-run by a duplicate alarm");
  assert.strictEqual(patchBodies.length, 0, "scheduling and dispatching a pickup never writes Handoff state -- only the handler does");
});

// --- B. Ownership adoption precedes handler execution -----------------------

test("pickup adopts the Handoff destination as the Work's recorded ownership BEFORE the handler runs (production order, observed at runtime)", async (t) => {
  const seq: string[] = [];
  const observed: PickupObservation[] = [];
  // A variant declaration for a REGISTERED Unit -- the documented test seam on
  // discoverPendingHandoffsForUnit -- so the whole chain, ownership adoption
  // included, runs exactly as production runs it.
  const declaration = recordingDeclaration(seq, observed, async (_env, state) => state);

  const env = fakeEnv();
  const { storage } = fakeStorage();
  const calls = { init: [] as any[][], schedule: [] as string[] };
  installWorkSessionStub(env, storage, calls);

  const status: Record<string, string> = { [FINANCE_HANDOFF_ID]: "Pending" };
  const activityBodies: any[] = [];
  const patchBodies: { id: string; body: any }[] = [];
  mockNotion(
    t,
    { [FINANCE_HANDOFF_ID]: { toUnit: FINANCE_UNIT, toHat: FINANCE_HAT, reason: "Quote request ready for Finance." } },
    status,
    seq,
    activityBodies,
    patchBodies,
  );
  await env.STATE_KV.put(`handoff_workitem:${FINANCE_HANDOFF_ID}`, "work-chain-1");

  // The Work is owned by the SENDING Unit when discovery finds it. Adoption
  // must move it to the destination before the handler observes it.
  const state = strategyOwnedWork(FINANCE_HANDOFF_ID);
  const before = { unit: state.unit, hat: state.hat, actionName: state.actionName };
  assert.deepStrictEqual(before, { unit: STRATEGY_UNIT, hat: STRATEGY_HAT, actionName: STRATEGY_SENDING_ACTION });

  const runners = runnersMirroringAlarm(env, state, declaration);
  const scheduled = await discoverPendingHandoffsForUnit(env, FINANCE_UNIT, declaration);
  assert.strictEqual(scheduled, 1);
  const ran = await dispatchScheduledPickup(storage, runners);
  assert.strictEqual(ran, FINANCE_UNIT);

  // 1. Ownership really transferred -- the production Activity write names the
  //    receiving Unit and the Handoff that moved the Work.
  assert.ok(
    seq.includes("activity-log-write"),
    "adoption must write the ownership-transfer Activity record (production side effect)",
  );
  const transfer = activityBodies[0];
  assert.ok(JSON.stringify(transfer).includes("Work ownership transferred"), "the Activity entry must be the transfer record");
  assert.ok(JSON.stringify(transfer).includes(FINANCE_UNIT), "the transfer record must name the receiving Unit");
  assert.ok(JSON.stringify(transfer).includes(FINANCE_HANDOFF_ID), "the transfer record must name the Handoff that moved it");

  // 2. ORDER: the production Activity write (emitted by adoptHandoffOwnership)
  //    happened strictly before the handler began. This is observed sequence,
  //    not a source-text check.
  assert.ok(
    seq.indexOf("activity-log-write") < seq.indexOf("handler-entry"),
    `ownership adoption must complete before the handler starts; observed order: ${seq.join(" -> ")}`,
  );

  // 3. The handler observed the ADOPTED ownership, not the sending Unit's.
  assert.strictEqual(observed[0].unit, FINANCE_UNIT, "the handler must run on Work owned by the destination Unit");
  assert.strictEqual(observed[0].hat, FINANCE_HAT);
  assert.strictEqual(observed[0].actionName, FINANCE_PICKUP_ACTION, "the destination Action is the one adoption records for Access");

  // 4. Adoption mutated the SAME Work state in place, and cleared the sending
  //    Unit's staged interaction while keeping session infrastructure.
  assert.strictEqual(state.unit, FINANCE_UNIT);
  assert.strictEqual(state.hat, FINANCE_HAT);
  assert.strictEqual(state.actionName, FINANCE_PICKUP_ACTION);
  assert.strictEqual(state.awaiting, undefined, "the sending Unit's awaiting state must not travel");
  assert.strictEqual(state.pendingActionSummary, undefined, "the sending Unit's staged approval must not travel");
  assert.strictEqual(state.strategy?.pendingApproval, undefined, "the sending Unit's slice-staged approval must not travel");
  assert.strictEqual(state.workStatusMessageId, undefined, "the sending Unit's live status bubble must not travel");
  assert.strictEqual(state.chatId, 9999, "session infrastructure is deliberately retained");
  assert.strictEqual(state.threadId, 100);
  assert.strictEqual(state.workId, "work-chain-1", "the session identity is untouched -- ownership transfers, the session does not split");
});

// --- C. A failed pickup stays Pending and the retry path re-attempts it ------

test("a failed pickup leaves the Handoff Pending with no completion recorded, and the established rediscovery path retries it to a successful lifecycle", async (t) => {
  const seq: string[] = [];
  const observed: PickupObservation[] = [];
  let attempts = 0;

  // The handler fails BEFORE claiming the Handoff (the pre-claim failure
  // guarantee), then on retry performs the same lifecycle calls a real
  // pickup makes: claim Pending -> Picked-up, then close.
  const declaration = recordingDeclaration(seq, observed, async (env, state) => {
    attempts++;
    if (attempts === 1) throw new Error("synthetic pickup failure before the claim");
    const claim = await claimPendingHandoff(env, state.handoffId!, workSessionContext(state));
    if (!claim.claimed) throw new Error(`unexpected claim refusal: ${claim.reason}`);
    await closeHandoffIfOpen(env, state.handoffId!, "synthetic pickup completed", workSessionContext(state));
    return state;
  });

  const env = fakeEnv();
  const { storage, store } = fakeStorage();
  const calls = { init: [] as any[][], schedule: [] as string[] };
  installWorkSessionStub(env, storage, calls);

  const status: Record<string, string> = { [FINANCE_HANDOFF_ID]: "Pending" };
  const activityBodies: any[] = [];
  const patchBodies: { id: string; body: any }[] = [];
  mockNotion(
    t,
    { [FINANCE_HANDOFF_ID]: { toUnit: FINANCE_UNIT, toHat: FINANCE_HAT, reason: "Quote request ready for Finance." } },
    status,
    seq,
    activityBodies,
    patchBodies,
  );
  await env.STATE_KV.put(`handoff_workitem:${FINANCE_HANDOFF_ID}`, "work-chain-1");

  // One Work, retried -- the state object survives across both attempts.
  const state = strategyOwnedWork(FINANCE_HANDOFF_ID);
  const runners = runnersMirroringAlarm(env, state, declaration);

  // --- attempt 1: the pickup fails ---
  assert.strictEqual(await discoverPendingHandoffsForUnit(env, FINANCE_UNIT, declaration), 1);
  await assert.rejects(
    () => dispatchScheduledPickup(storage, runners),
    /synthetic pickup failure before the claim/,
    "dispatchScheduledPickup must re-throw a runner failure so the alarm can report it",
  );

  assert.strictEqual(attempts, 1);
  assert.strictEqual(status[FINANCE_HANDOFF_ID], "Pending", "a pre-claim failure must leave the Handoff exactly as discovery found it");
  assert.strictEqual(patchBodies.length, 0, "no success, claim or completion state may be recorded for the failed attempt");
  assert.ok(!seq.some((e) => e.startsWith("handoff-update")), "no Handoff status write at all on the failed attempt");
  assert.ok(!store.has(PENDING_PICKUP_KIND_KEY), "the scheduled kind is single-shot: the failed alarm consumed it, so retry is rediscovery's job");

  // --- retry: the established path is rediscovery, which re-schedules it ---
  assert.strictEqual(
    await discoverPendingHandoffsForUnit(env, FINANCE_UNIT, declaration),
    1,
    "the still-Pending Handoff must be rediscovered and rescheduled by the same discovery loop",
  );
  assert.deepStrictEqual(calls.schedule, [FINANCE_UNIT, FINANCE_UNIT], "each discovery cycle schedules the Pending Handoff again");
  assert.strictEqual(calls.init.length, 0, "rediscovery continues the SAME Work -- it never creates a second one");

  // --- attempt 2: the retry succeeds through the real lifecycle ---
  const ran = await dispatchScheduledPickup(storage, runners);
  assert.strictEqual(ran, FINANCE_UNIT);
  assert.strictEqual(attempts, 2, "the retried pickup must reach the handler a second time");
  assert.deepStrictEqual(
    // updatePage PATCHes `{ properties }`, so the lifecycle writes are read
    // from the wrapped payload exactly as src/notion.ts sends them.
    patchBodies.map((p) => p.body.properties?.Status?.select?.name),
    ["Picked-up", "Closed"],
    "the successful retry must follow the existing lifecycle: claim Pending -> Picked-up, then close",
  );
  assert.ok(
    JSON.stringify(patchBodies[1].body.properties).includes("Open Questions"),
    "the close must record the reason, per closeHandoffIfOpen's contract",
  );
  assert.strictEqual(status[FINANCE_HANDOFF_ID], "Closed");
  assert.strictEqual(seq.filter((e) => e === "handler-entry").length, 2, "one handler entry per attempt -- failure then success");
  assert.strictEqual(observed[1].unit, FINANCE_UNIT, "the successful attempt runs on the adopted ownership, exactly like the first");
});

// --- D. The Cloudflare / registry boundary, pinned as runtime behaviour -----

test("boundary: a Unit outside the real registry is refused by destination resolution and by ownership adoption -- the exact seam this proof cannot cross", async (t) => {
  const seq: string[] = [];
  let handlerRan = 0;
  const declaration: HandoffPickupDeclaration = {
    handler: async (_env, state) => {
      handlerRan++;
      seq.push("handler-entry");
      return state;
    },
  };

  const env = fakeEnv();
  const { storage, store } = fakeStorage();
  const calls = { init: [] as any[][], schedule: [] as string[] };
  installWorkSessionStub(env, storage, calls);

  const status: Record<string, string> = { [SYNTHETIC_HANDOFF_ID]: "Pending" };
  const activityBodies: any[] = [];
  const patchBodies: { id: string; body: any }[] = [];
  mockNotion(t, { [SYNTHETIC_HANDOFF_ID]: { toUnit: SYNTHETIC_UNIT, toHat: "Synthetic Pickup Hat" } }, status, seq, activityBodies, patchBodies);

  // 1. The NEW-WORK branch of discovery cannot run for a Unit outside the
  //    real registry: deriveHandoffDestination resolves its manifest with
  //    findUnitManifest (no table seam), so destination resolution fails
  //    closed rather than guessing a Hat/Action.
  const scheduled = await discoverPendingHandoffsForUnit(env, SYNTHETIC_UNIT, declaration);
  assert.strictEqual(scheduled, 0, "no pickup may be scheduled when the destination cannot be resolved");
  assert.strictEqual(calls.init.length, 0, "no Work may be created under a guessed Hat/Action");
  assert.ok(!(await env.STATE_KV.get(`handoff_workitem:${SYNTHETIC_HANDOFF_ID}`)), "no Work association may be recorded");

  // 2. OWNERSHIP ADOPTION is the same wall: it resolves the destination
  //    through deriveHandoffDestination, so it refuses before the handler and
  //    before anything is mutated. This is why the synthetic handler above is
  //    invoked without adoption, and why ownership ordering is proven with a
  //    registered Unit instead.
  const state = strategyOwnedWork(SYNTHETIC_HANDOFF_ID);
  const before = JSON.stringify(state);
  await assert.rejects(
    () => runWithAdoptedOwnership(env, state, SYNTHETIC_UNIT, async (adopted) => adopted),
    /missing_manifest/,
    "adoption must fail closed on a Unit with no canonical manifest -- it never invents an organizational context",
  );
  assert.strictEqual(handlerRan, 0, "no handler may run when ownership cannot be established");
  assert.strictEqual(JSON.stringify(state), before, "a refused adoption leaves the Work exactly as it was");
  assert.strictEqual(status[SYNTHETIC_HANDOFF_ID], "Pending", "and the Handoff is untouched -- still Pending");
  assert.ok(!store.has(PENDING_PICKUP_KIND_KEY), "nothing was scheduled for the refused pickup");
});
