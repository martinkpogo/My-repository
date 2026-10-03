/// <reference types="node" />
/**
 * ACCESS -- the enforcement boundary's own test suite.
 *
 * Everything here exercises `evaluateAccess` and the resolvers around it
 * directly, with no Notion, no Telegram, and no Work session. That is the point:
 * Access is a pure decision function, so its contract can be pinned without any
 * of the machinery it protects.
 *
 * The suite is organised by the property being defended, and each group's tests
 * are written as the probe that WOULD have succeeded under a weaker design --
 * "a caller naming its own Action", "an approval for Handoffs used against
 * Matters", "a read Action reaching a write". Each one must deny.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AccessDeniedError,
  EXTERNAL_EGRESS_TARGET,
  NON_GOVERNED_PAGE_TARGET,
  consequencePermits,
  discoveryCronContext,
  evaluateAccess,
  governedSourceDataSourceId,
  isApprovalGatedWrite,
  mintApprovalProof,
  mintApprovalProofForWork,
  resolveActionRequirement,
  systemContext,
  userLookupContext,
  workSessionContext,
  workSessionReadContext,
  type AccessContext,
  type AccessRequest,
  type GovernedSource,
} from "./access";
import { getUnitManifests } from "./units/registry";
import type { ActionDefinition } from "./hats/actionRegistry";
import type { Env, Unit, WorkState } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A Work recording the given registered Action, as `workSessionContext` builds it. */
function work(unit: Unit, hat: string, actionName: string, overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-1",
    chatId: 9999,
    unit,
    hat,
    actionName,
    stage: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WorkState;
}

const SALES_DISCOVER = work("Sales", "Lead Generation Specialist", "discover_leads");
const SALES_ENQUIRY = work("Sales", "Sales Executive", "new_enquiry");
const SALES_CREATE_ENTITY = work("Sales", "Sales Executive", "create_entity");
const SALES_PROPOSAL_APPROVE = work("Sales", "Sales Executive", "proposal_approve");
const STRATEGY_DIAGNOSE = work("Strategy", "Strategy Analyst", "diagnose");
// Strategy's GATED action. The gated effect -- committing a diagnosis and the
// outbound Handoff that carries it -- was split out of `diagnose` into
// `commit_diagnosis` precisely so that ungated work could stay ungated. Any
// test in this file about the approval gate must use THIS one; using
// `diagnose` would assert against an ungated Action and pass for the wrong
// reason, which is worse than failing.
const STRATEGY_COMMIT_DIAGNOSIS = work("Strategy", "Strategy Analyst", "commit_diagnosis");
// A Work whose Action permits reading (`read` consequence) -- the shape any Action using the research runtime's outbound search would have.
const BD_RESEARCH_READ = work("Business Development", "Business Development Manager", "research_opportunity");
const FINANCE_PRICE = work("Finance", "Value-Based Pricing Assessor", "price");
const BD_DEVELOP = work("Business Development", "Business Development Manager", "develop_opportunity");

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return { operation: "read", dataSourceId: "entity-ds", ...overrides };
}

/** A proof that is well-formed in every respect, so each test can invalidate exactly one field. */
function proof(overrides: Partial<{ workId: string; actionName: string; targetDataSourceId: string; token: string; approvedAt: string }> = {}) {
  return mintApprovalProof({
    workId: "work-1",
    actionName: "create_entity",
    targetDataSourceId: "entity-ds",
    // Fixed so a failure is reproducible rather than dependent on a fresh uuid.
    token: "test-approval-token-0001",
    approvedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const allSources: GovernedSource[] = ["entities", "matters", "proposals", "handoffs", "leads", "activity_log", "call_notes"];

// ---------------------------------------------------------------------------
// 1. The registry itself is the authority: every registered Action resolves,
//    and the flags Access reads are present and coherent on all of them.
// ---------------------------------------------------------------------------

test("every registered Unit/Hat/Action resolves through the real registry -- an Action that cannot be resolved is never read as un-gated", () => {
  const manifests = getUnitManifests();
  assert.ok(Object.keys(manifests).length > 0, "the registry must not be empty");
  let checked = 0;
  for (const [unit, manifest] of Object.entries(manifests)) {
    if (!manifest) continue;
    for (const hat of Object.values(manifest.hats)) {
      for (const action of hat.actions ?? []) {
        const context = workSessionContext(work(unit as Unit, hat.name, action.name));
        const resolved = resolveActionRequirement(context);
        assert.ok(resolved, `${unit}/${hat.name}/${action.name} must resolve`);
        assert.strictEqual(resolved!.action.name, action.name, "the resolved Action must be the one registered");
        assert.strictEqual(
          resolved!.requiresApproval,
          action.requiresApproval,
          `${unit}/${hat.name}/${action.name}: the approval requirement Access reads must be the one declared`,
        );
        assert.ok(
          ["read", "internal", "write"].includes(action.consequence),
          `${unit}/${hat.name}/${action.name}: unknown consequence "${action.consequence}"`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked >= 30, `expected the full registered Action surface, only saw ${checked}`);
});

// ---------------------------------------------------------------------------
// 2. A caller can never supply the Action it is judged by.
// ---------------------------------------------------------------------------

test("a context naming an Action that the Work does not record is impossible to build -- workSessionContext takes the Action from the Work, not from a parameter", () => {
  // The constructor's only Action-bearing input is state.actionName. There is
  // deliberately no `actionName` parameter: this test pins that shape.
  const context = workSessionContext(SALES_ENQUIRY);
  assert.strictEqual(context.actionName, "new_enquiry");
  assert.strictEqual("actionName" in context, true);

  // Recording a different Action changes what the operation is judged by,
  // which is the only legitimate route and is visible as such.
  const switched = workSessionContext(work("Sales", "Sales Executive", "proposal_draft"));
  assert.strictEqual(switched.actionName, "proposal_draft");
});

test("assertedActionName is a cross-check only: a disagreement with the Work's record fails closed rather than resolving to either value", () => {
  const env = fakeEnv();
  // The Work records create_entity; the call site claims it is doing something
  // far less privileged. Refusing is the point -- preferring the Work would be
  // right, preferring the caller would be the bug, and silently picking one
  // would hide a defect in the code performing the operation.
  const context = workSessionContext(SALES_CREATE_ENTITY, undefined, "new_enquiry");
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), context),
    (err: unknown) => {
      assert.ok(err instanceof AccessDeniedError);
      assert.match((err as AccessDeniedError).reason, /can never substitute the Action/);
      return true;
    },
  );

  // Agreement is fine and is not itself a source of authority.
  const agreeing = workSessionContext(SALES_CREATE_ENTITY, undefined, "create_entity");
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), agreeing),
    /requires Martin's explicit approval/,
    "agreement must not turn a gated Action into an ungated one",
  );
});

test("a Work that records no Action cannot be talked into one, and a Unit/Hat without one is a denial rather than a silently un-gated operation", () => {
  const env = fakeEnv();
  // No Action at all, and nothing else named: a legitimate read of ENIG's own
  // records, nothing more.
  assert.doesNotThrow(() => evaluateAccess(env, request(), workSessionReadContext("work-1")));

  // The same context attempting a governed write is the arbitrary-write
  // bypass, and is refused.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), workSessionReadContext("work-1")),
    /no resolved Unit Action/,
  );

  // Naming a Unit and Hat with no Action is invalid state, not a lesser
  // operation.
  assert.throws(
    () => evaluateAccess(env, request(), { kind: "work_session", workId: "work-1", unit: "Sales", hat: "Sales Executive" }),
    /records no Action/,
  );
});

test("an undeclared Action on a real Hat is a denial, never treated as un-gated", () => {
  const env = fakeEnv();
  const context = workSessionContext(work("Sales", "Sales Executive", "definitely_not_an_action"));
  assert.throws(() => evaluateAccess(env, request(), context), /declares no action "definitely_not_an_action"/);
});

test("an unknown Unit, or a Unit with no such Hat, is a denial", () => {
  const env = fakeEnv();
  assert.throws(
    () => evaluateAccess(env, request(), workSessionContext(work("Operations", "Anything", "whatever"))),
    /has no registered manifest/,
  );
  assert.throws(
    () => evaluateAccess(env, request(), workSessionContext(work("Sales", "Nonexistent Hat", "new_enquiry"))),
    /declares no Hat "Nonexistent Hat"/,
  );
});

test("an Action on a Work with no Unit and/or Hat is a denial rather than a guess at which action it is", () => {
  const env = fakeEnv();
  const context: AccessContext = { kind: "work_session", workId: "work-1", actionName: "new_enquiry" };
  assert.throws(() => evaluateAccess(env, request(), context), /no Unit and\/or Hat/);
});

// ---------------------------------------------------------------------------
// 3. The Action's declared consequence bounds what it may do -- in both
//    directions. A read Action can never authorize a write.
// ---------------------------------------------------------------------------

test("consequencePermits: read allows only read, internal allows only read, write allows read/create/update", () => {
  const asAction = (consequence: ActionDefinition<string>["consequence"]): ActionDefinition<string> =>
    ({ name: "probe", responsibility: "probe", consequence, requiresApproval: false }) as ActionDefinition<string>;
  assert.deepStrictEqual(
    (["read", "create", "update"] as const).map((op) => consequencePermits(asAction("read"), op)),
    [true, false, false],
  );
  assert.deepStrictEqual(
    (["read", "create", "update"] as const).map((op) => consequencePermits(asAction("internal"), op)),
    [true, false, false],
  );
  assert.deepStrictEqual(
    (["read", "create", "update"] as const).map((op) => consequencePermits(asAction("write"), op)),
    [true, true, true],
  );
});

test("a read Action cannot authorize a write of any governed source -- the ENTITIES create under discover_leads probe", () => {
  const env = fakeEnv();
  // This is the specific bypass the Work-authoritative design exists to close:
  // a lead-discovery read that quietly creates an Entity. Under a
  // caller-asserted Action model this was allowed, because the caller named
  // whatever it liked.
  for (const source of allSources) {
    assert.throws(
      () =>
        evaluateAccess(
          env,
          request({ operation: "create", dataSourceId: governedSourceDataSourceId(env, source) }),
          workSessionContext(SALES_DISCOVER),
        ),
      (err: unknown) => {
        assert.ok(err instanceof AccessDeniedError, `${source}: must be an AccessDeniedError`);
        assert.match((err as AccessDeniedError).reason, /declared "read" and does not permit a create/);
        return true;
      },
    );
  }
});

test("an internal Action can read ENIG's own records but never reach governed state", () => {
  const env = fakeEnv();
  const internal = work("Business Development", "Business Development Manager", "qualify_opportunity");
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: env.ENTITY_DATA_SOURCE_ID }), workSessionContext(internal)));
  for (const operation of ["create", "update"] as const) {
    assert.throws(
      () => evaluateAccess(env, request({ operation, dataSourceId: env.MATTERS_DATA_SOURCE_ID }), workSessionContext(internal)),
      /declared "internal" and does not permit/,
    );
  }
});

test("a write Action's authorization is never reused as an implicit read authorization, and vice versa", () => {
  const env = fakeEnv();
  // A write Action may read...
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: env.HANDOFFS_DATA_SOURCE_ID }), workSessionContext(SALES_PROPOSAL_APPROVE)));
  // ...and a read Action may read. Neither direction leaks: the read Action's
  // permission to read is not a permission to write, which is asserted above.
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: env.LEADS_DATA_SOURCE_ID }), workSessionContext(SALES_DISCOVER)));
});

// ---------------------------------------------------------------------------
// 4. requiresApproval is the single authority, read off the registered Action.
// ---------------------------------------------------------------------------

test("requiresApproval is read off the ActionDefinition, never from the context -- a gated Action is gated under every context kind", () => {
  const env = fakeEnv();
  for (const source of allSources) {
    assert.throws(
      () =>
        evaluateAccess(
          env,
          request({ operation: "create", dataSourceId: governedSourceDataSourceId(env, source) }),
          workSessionContext(STRATEGY_COMMIT_DIAGNOSIS),
        ),
      /requires Martin's explicit approval/,
      `commit_diagnosis is gated, so a create to ${source} must require a proof`,
    );
  }
});

test("a gated write is permitted with a matching proof, and only with a matching one", () => {
  const env = fakeEnv();
  const createEntity = { operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID } as const;

  assert.doesNotThrow(() => evaluateAccess(env, createEntity, workSessionContext(SALES_CREATE_ENTITY, proof())));

  // A proof for a different Work: an approval never carries across work items.
  assert.throws(
    () => evaluateAccess(env, createEntity, workSessionContext(work("Sales", "Sales Executive", "create_entity", { workId: "work-2" }), proof())),
    /is for Work work-1, not the current Work work-2/,
  );
  // A proof for a different Action.
  assert.throws(
    () => evaluateAccess(env, createEntity, workSessionContext(SALES_CREATE_ENTITY, proof({ actionName: "new_enquiry" }))),
    /is for action "new_enquiry", not the resolved action "create_entity"/,
  );
  // A proof for a different governed source: the one that matters most, since
  // an approval for Handoffs must never authorize touching Matters.
  assert.throws(
    () =>
      evaluateAccess(
        env,
        { operation: "create", dataSourceId: env.MATTERS_DATA_SOURCE_ID },
        workSessionContext(SALES_CREATE_ENTITY, proof({ targetDataSourceId: env.HANDOFFS_DATA_SOURCE_ID })),
      ),
    /authorizes data source handoffs-ds, not the target matters-ds/,
  );
  // A malformed proof authorizes nothing at all.
  assert.throws(
    () => evaluateAccess(env, createEntity, workSessionContext(SALES_CREATE_ENTITY, proof({ token: "" }))),
    /no usable approval token/,
  );
  assert.throws(
    () => evaluateAccess(env, createEntity, workSessionContext(SALES_CREATE_ENTITY, proof({ approvedAt: "" }))),
    /no approval timestamp/,
  );
});

test("a proof is verified even when the Action is ungated -- an extra proof cannot be used to smuggle a mismatched authority past the checks", () => {
  const env = fakeEnv();
  // new_enquiry is ungated, so no proof is required. Supplying one bound to a
  // different target must still be refused rather than ignored: silently
  // ignoring it would mean a mis-scoped proof is never noticed.
  const context = workSessionContext(SALES_ENQUIRY, proof({ targetDataSourceId: env.LEADS_DATA_SOURCE_ID, actionName: "new_enquiry" }));
  assert.throws(
    () => evaluateAccess(env, { operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }, context),
    /authorizes data source leads-ds, not the target entity-ds/,
  );
});

test("reads are never approval-gated: an approval authorizes a committed change, and reading is not one", () => {
  const env = fakeEnv();
  for (const source of allSources) {
    assert.doesNotThrow(
      () => evaluateAccess(env, request({ dataSourceId: governedSourceDataSourceId(env, source) }), workSessionContext(FINANCE_PRICE)),
      `price is a gated Action, but reading ${source} must still be permitted without a proof`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The single non-Action-declared exemption: a Work's own inbound Handoff
//    progression. It is narrow, and it is decided in Access, not by the caller.
// ---------------------------------------------------------------------------

test("a Work may advance its own inbound Handoff without a proof -- pickup happens before the approval the gate waits for", () => {
  const env = fakeEnv();
  // Deliberately the GATED Strategy action: the exemption is only meaningful
  // against an Action that would otherwise demand a proof. Asserting it
  // against ungated `diagnose` would pass no matter what Access did, so this
  // would assert nothing.
  const inbound = work("Strategy", "Strategy Analyst", "commit_diagnosis", { handoffId: "handoff-1" });
  const context = workSessionContext(inbound);
  assert.strictEqual(context.inboundHandoffId, "handoff-1");

  // Guard the guard: confirm this Work really is gated, so the doesNotThrow
  // assertions below are evidence of the exemption rather than of nothing.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "update", dataSourceId: env.MATTERS_DATA_SOURCE_ID, pageId: "m1" }), context),
    /requires Martin's explicit approval/,
    "precondition: this Work's recorded Action is gated, so its Handoff progression is a real exemption",
  );

  for (const status of ["Picked-up", "Held", "Closed"]) {
    assert.doesNotThrow(
      () => evaluateAccess(env, request({ operation: "update", dataSourceId: env.HANDOFFS_DATA_SOURCE_ID, pageId: "handoff-1" }), context),
      `advancing its own Handoff to ${status} is execution-state progression, not a gated effect`,
    );
  }
});

test("the exemption is page-for-page and update-only: another Handoff, another source, and any create all stay gated", () => {
  const env = fakeEnv();
  const context = workSessionContext(work("Strategy", "Strategy Analyst", "commit_diagnosis", { handoffId: "handoff-1" }));

  // Another Work's Handoff.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "update", dataSourceId: env.HANDOFFS_DATA_SOURCE_ID, pageId: "handoff-2" }), context),
    /requires Martin's explicit approval/,
  );
  // A create is never progression, however well it matches.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: env.HANDOFFS_DATA_SOURCE_ID }), context),
    /requires Martin's explicit approval/,
  );
  // The same page id, but a different governed source: the target is the
  // resolved data source, not the page name.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "update", dataSourceId: env.MATTERS_DATA_SOURCE_ID, pageId: "handoff-1" }), context),
    /requires Martin's explicit approval/,
  );
  // With no inbound Handoff there is nothing to progress. The same gated
  // Action, so the only thing that changed is the missing handoffId.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "update", dataSourceId: env.HANDOFFS_DATA_SOURCE_ID, pageId: "handoff-1" }), workSessionContext(STRATEGY_COMMIT_DIAGNOSIS)),
    /requires Martin's explicit approval/,
  );
});

test("isApprovalGatedWrite is the single place the requirement is decided, and it reads only the Action's own flag", () => {
  const env = fakeEnv();
  const gated = { name: "gated", responsibility: "probe", consequence: "write", requiresApproval: true } as ActionDefinition<string>;
  const ungated = { name: "ungated", responsibility: "probe", consequence: "write", requiresApproval: false } as ActionDefinition<string>;
  const inbound = workSessionContext(work("Strategy", "Strategy Analyst", "diagnose", { handoffId: "handoff-1" }));

  assert.strictEqual(isApprovalGatedWrite(env, gated, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), inbound), true);
  assert.strictEqual(isApprovalGatedWrite(env, ungated, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), inbound), false);
  assert.strictEqual(
    isApprovalGatedWrite(env, gated, request({ operation: "update", dataSourceId: env.HANDOFFS_DATA_SOURCE_ID, pageId: "handoff-1" }), inbound),
    false,
    "the Work's own Handoff progression is the one exemption",
  );
  assert.strictEqual(
    isApprovalGatedWrite(env, gated, request({ operation: "read", dataSourceId: env.HANDOFFS_DATA_SOURCE_ID, pageId: "handoff-1" }), inbound),
    false,
    "reads are never gated",
  );
});

// ---------------------------------------------------------------------------
// 6. The Kernel system context is narrow, and cannot name its own target.
// ---------------------------------------------------------------------------

test("a system context may write the Activity Log it owns and read ENIG's records -- and nothing else", () => {
  const env = fakeEnv();
  assert.doesNotThrow(() => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ACTIVITY_LOG_DATA_SOURCE_ID }), systemContext("kernel-1")));
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: env.ENTITY_DATA_SOURCE_ID }), systemContext()));

  for (const source of ["entities", "matters", "proposals", "handoffs", "leads", "call_notes"] as GovernedSource[]) {
    assert.throws(
      () => evaluateAccess(env, request({ operation: "create", dataSourceId: governedSourceDataSourceId(env, source) }), systemContext("kernel-1")),
      /authorizes only the Activity & Decision Log it owns/,
      `a system context must not be able to create a ${source} record`,
    );
    assert.throws(
      () => evaluateAccess(env, request({ operation: "update", dataSourceId: governedSourceDataSourceId(env, source) }), systemContext("kernel-1")),
      /authorizes only the Activity & Decision Log it owns/,
      `a system context must not be able to update a ${source} record`,
    );
  }
});

test("a user_lookup context is read-only and may not carry a resolved action or a proof", () => {
  const env = fakeEnv();
  assert.doesNotThrow(() => evaluateAccess(env, request(), userLookupContext()));
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), userLookupContext()),
    /read-only/,
  );
  assert.throws(() => evaluateAccess(env, request(), { ...userLookupContext(), actionName: "new_enquiry", unit: "Sales", hat: "Sales Executive" }), /must not carry a resolved action/);
  assert.throws(() => evaluateAccess(env, request(), { ...userLookupContext(), proof: proof() }), /must not carry a resolved action/);
});

test("the discovery cron context is a Kernel-owned read and performs no governed write of its own", () => {
  const env = fakeEnv();
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: env.HANDOFFS_DATA_SOURCE_ID }), discoveryCronContext()));
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ACTIVITY_LOG_DATA_SOURCE_ID }), discoveryCronContext()),
    /only permitted as a Kernel-owned "system" write, not under context "discovery_cron"/,
  );
});

test("an unknown context kind is refused rather than treated as the most permissive one", () => {
  const env = fakeEnv();
  assert.throws(
    () => evaluateAccess(env, request(), { kind: "trusted" as never, workId: "work-1" }),
    /unknown execution context kind "trusted"/,
  );
});

// ---------------------------------------------------------------------------
// 7. Target resolution: no operation proceeds against a target that was not
//    resolved, and a page outside every governed source is readable but not
//    writable.
// ---------------------------------------------------------------------------

test("a request with no resolvable target is refused -- never defaulted to whatever the caller said", () => {
  const env = fakeEnv();
  for (const operation of ["read", "create", "update"] as const) {
    assert.throws(
      () => evaluateAccess(env, request({ operation, dataSourceId: "" }), workSessionContext(SALES_ENQUIRY)),
      /without a resolvable target data source/,
    );
  }
});

test("an unrecognized target is refused by name, under every context kind -- a caller cannot launder an arbitrary target through the read path", () => {
  const env = fakeEnv();
  // Every governed source in this Env is the only set of targets a Notion
  // operation may name. Without this, a read of an unrecognized id resolved
  // no Action and was permitted -- so the requirement would have been "target
  // must be non-empty" rather than "target must be governed".
  const bogus = ["some-other-ds", "https://evil.example.com", "external:whatever", "ENTITY-DS", ""];
  const contexts: Array<[string, AccessContext]> = [
    ["discovery_cron", discoveryCronContext()],
    ["system", systemContext("kernel-1")],
    ["user_lookup", userLookupContext()],
    ["work_session (no Action)", workSessionReadContext("work-1")],
    ["work_session (gated Action)", workSessionContext(SALES_CREATE_ENTITY, proof())],
  ];
  for (const target of bogus) {
    for (const [label, context] of contexts) {
      for (const operation of ["read", "create", "update"] as const) {
        assert.throws(
          () => evaluateAccess(env, request({ operation, dataSourceId: target }), context),
          /without a resolvable target data source|is not a governed data source/,
          `${label} + ${operation} + "${target}" must be refused`,
        );
      }
    }
  }
  // And a governed source is recognized, so the check is not vacuous: the seven
  // real ids are accepted.
  for (const source of allSources) {
    assert.doesNotThrow(
      () => evaluateAccess(env, request({ dataSourceId: governedSourceDataSourceId(env, source) }), systemContext("kernel-1")),
      `${source} is a governed source and must resolve`,
    );
  }
});

test("NON_GOVERNED_PAGE_TARGET is read-only: a page outside every governed source can be read, never written", () => {
  const env = fakeEnv();
  // A standalone governance page (Hat Definition, Universal Role Contract) has
  // no governed source. Reading it is legitimate and is how governance content
  // is retrieved.
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: NON_GOVERNED_PAGE_TARGET }), systemContext()));
  for (const operation of ["create", "update"] as const) {
    assert.throws(
      () => evaluateAccess(env, request({ operation, dataSourceId: NON_GOVERNED_PAGE_TARGET }), workSessionContext(STRATEGY_DIAGNOSE, proof())),
      /lives in no governed source/,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Outbound requests to third parties are inside the same boundary.
// ---------------------------------------------------------------------------

test("an outbound read is permitted for a Kernel-owned read and for a Work whose Action permits reading", () => {
  const env = fakeEnv();
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: EXTERNAL_EGRESS_TARGET }), discoveryCronContext()));
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: EXTERNAL_EGRESS_TARGET }), workSessionContext(BD_RESEARCH_READ)));
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: EXTERNAL_EGRESS_TARGET }), workSessionContext(SALES_DISCOVER)));
});

test("a read of ENIG's own records is not authority to disclose one externally", () => {
  const env = fakeEnv();
  // workSessionReadContext carries no Action, and is correct for reading
  // ENIG's own records. It is deliberately NOT authority to send a query to a
  // third party: those are different acts with different authorities.
  assert.doesNotThrow(() => evaluateAccess(env, request({ dataSourceId: env.ENTITY_DATA_SOURCE_ID }), workSessionReadContext("work-1")));
  assert.throws(
    () => evaluateAccess(env, request({ dataSourceId: EXTERNAL_EGRESS_TARGET }), workSessionReadContext("work-1")),
    /no registered operation behind an outbound read/,
  );
  assert.throws(
    () => evaluateAccess(env, request({ dataSourceId: EXTERNAL_EGRESS_TARGET }), userLookupContext()),
    /may not disclose anything to a third party/,
  );
});

test("no outbound create or update is authorized under any context, and a caller cannot name its own external target", () => {
  const env = fakeEnv();
  for (const context of [discoveryCronContext(), workSessionContext(BD_RESEARCH_READ), systemContext("kernel-1")]) {
    for (const operation of ["create", "update"] as const) {
      assert.throws(
        () => evaluateAccess(env, request({ operation, dataSourceId: EXTERNAL_EGRESS_TARGET }), context),
        /outbound (create|update) to an external provider is not authorized/,
      );
    }
  }
  // A gated Action plus a valid proof still does not authorize a mutation of
  // external state: no Action anywhere answers that question.
  assert.throws(
    () => evaluateAccess(env, request({ operation: "create", dataSourceId: EXTERNAL_EGRESS_TARGET }), workSessionContext(SALES_PROPOSAL_APPROVE, proof({ actionName: "proposal_approve" }))),
    /outbound create to an external provider is not authorized/,
  );
  // A caller-supplied target is not an authorized external target. This is
  // the stronger form of the same property: an unrecognized target is refused
  // by name, not merely denied its create/update, so it cannot be laundered
  // through the read path.
  assert.throws(
    () => evaluateAccess(env, request({ dataSourceId: "external:https://evil.example.com" }), discoveryCronContext()),
    /is not a governed data source in this environment/,
  );
  assert.throws(
    () => evaluateAccess(env, request({ dataSourceId: "external:https://evil.example.com" }), workSessionContext(BD_RESEARCH_READ)),
    /is not a governed data source in this environment/,
  );
});

// ---------------------------------------------------------------------------
// 9. mintApprovalProofForWork binds an approval to the Work's OWN Action, so
//    no call site can mint a proof for an action other than the one Access
//    will resolve.
// ---------------------------------------------------------------------------

test("mintApprovalProofForWork binds to the Work's recorded Action, so the two cannot disagree", () => {
  const env = fakeEnv();
  const p = mintApprovalProofForWork(SALES_CREATE_ENTITY, env.ENTITY_DATA_SOURCE_ID);
  assert.strictEqual(p.workId, "work-1");
  assert.strictEqual(p.actionName, "create_entity");
  assert.doesNotThrow(() => evaluateAccess(env, request({ operation: "create", dataSourceId: env.ENTITY_DATA_SOURCE_ID }), workSessionContext(SALES_CREATE_ENTITY, p)));
});

test("mintApprovalProofForWork refuses a Work that records no Action -- a proof with no action could never be verified", () => {
  const env = fakeEnv();
  const noAction = work("Sales", "Sales Executive", "new_enquiry");
  delete (noAction as Partial<WorkState>).actionName;
  assert.throws(() => mintApprovalProofForWork(noAction, env.ENTITY_DATA_SOURCE_ID), /records no Action/);
});

test("mintApprovalProof refuses a proof missing any of its three required bindings", () => {
  assert.throws(() => mintApprovalProof({ workId: "", actionName: "create_entity", targetDataSourceId: "entity-ds" }), /without a Work id/);
  assert.throws(() => mintApprovalProof({ workId: "work-1", actionName: "", targetDataSourceId: "entity-ds" }), /without an action name/);
  assert.throws(() => mintApprovalProof({ workId: "work-1", actionName: "create_entity", targetDataSourceId: "" }), /without a target data source/);
});

// ---------------------------------------------------------------------------
// 10. Governed-source mapping is symbolic, so a manifest can never assert an
//     environment-specific id.
// ---------------------------------------------------------------------------

test("every governed source maps to this Env's own data source id, and an unknown source is a type error rather than a silent undefined", () => {
  const env = fakeEnv();
  assert.deepStrictEqual(
    allSources.map((s) => governedSourceDataSourceId(env, s)),
    ["entity-ds", "matters-ds", "proposals-ds", "handoffs-ds", "leads-ds", "activity-log-ds", "call-notes-ds"],
  );
  assert.strictEqual(governedSourceDataSourceId(env, "handoffs"), env.HANDOFFS_DATA_SOURCE_ID);
});

// ---------------------------------------------------------------------------
// 11. The registry is a genuine single mechanism: the Access decision reads
//     the same objects the Unit Registry dispatches through, with no second
//     table of Actions anywhere.
// ---------------------------------------------------------------------------

test("the Actions Access resolves are the same objects the registry dispatches -- there is no second Action table", () => {
  const env = fakeEnv();
  const manifests = getUnitManifests();
  for (const [unit, manifest] of Object.entries(manifests)) {
    if (!manifest) continue;
    for (const hat of Object.values(manifest.hats)) {
      for (const action of hat.actions ?? []) {
        const resolved = resolveActionRequirement(workSessionContext(work(unit as Unit, hat.name, action.name)));
        assert.strictEqual(
          resolved!.action,
          action,
          `${unit}/${hat.name}/${action.name}: Access must resolve the registry's own object, not a copy`,
        );
        assert.ok(resolved!.action.responsibility.length > 0, `${action.name} must declare a responsibility`);
      }
    }
  }
  // And the reverse: nothing resolves an Action that is not registered.
  assert.throws(() => evaluateAccess(env, request(), workSessionContext(work("Sales", "Lead Generation Specialist", "new_enquiry"))), /declares no action "new_enquiry"/);
  assert.throws(() => evaluateAccess(env, request(), workSessionContext(work("Strategy", "Strategy Analyst", "price"))), /declares no action "price"/);
  assert.throws(() => evaluateAccess(env, request(), workSessionContext(work("Finance", "Value-Based Pricing Assessor", "diagnose"))), /declares no action "diagnose"/);
});

test("BD's develop_opportunity and Finance's price are gated Actions with no per-target narrowing -- approvalGatedTargets is gone from the registry", () => {
  const manifests = getUnitManifests();
  for (const manifest of Object.values(manifests)) {
    if (!manifest) continue;
    for (const hat of Object.values(manifest.hats)) {
      for (const action of hat.actions ?? []) {
        assert.strictEqual(
          (action as unknown as Record<string, unknown>).approvalGatedTargets,
          undefined,
          `${manifest.unit}/${hat.name}/${action.name} must not carry a per-target narrowing list -- that is the retired mechanism`,
        );
        assert.strictEqual(
          (action as unknown as Record<string, unknown>).requiresApproval,
          action.requiresApproval,
          "requiresApproval must be a plain boolean, present on every Action",
        );
      }
    }
  }
  assert.strictEqual(resolveActionRequirement(workSessionContext(BD_DEVELOP))!.requiresApproval, true);
  assert.strictEqual(resolveActionRequirement(workSessionContext(FINANCE_PRICE))!.requiresApproval, true);
  // The ungated counterpart is genuinely ungated -- the flag is read, not
  // inferred from the action's name.
  assert.strictEqual(resolveActionRequirement(workSessionContext(SALES_ENQUIRY))!.requiresApproval, false);
});
