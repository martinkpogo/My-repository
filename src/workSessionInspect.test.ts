import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env, WorkState } from "./types";
import { handleWorkSessionState } from "./workSessionInspect";

const ADMIN_KEY = "test-admin-key-888";
const WORK_ID = "e0922db0-3460-47e8-a820-3533e48c82c2";
const ROUTE = "https://enig-agent.martnkpogo.workers.dev/admin/work-session-state";

// WorkState fields that must never leave the runtime through this route:
// identity, the operator's Telegram identifiers, and the Skill finding prose
// PR #232 keeps off every blocker surface.
const FORBIDDEN_FIELDS = [
  "entityName",
  "matterName",
  "enquiryText",
  "chatId",
  "threadId",
  "strategyContext",
  "strategyDiagnosis",
  "strategyProposal",
  "pendingStrategyApproval",
  "strategySourceBoundaryAttestation",
  "finding",
  "evidenceLimitation",
  "implication",
  "failureReason",
  "unresolvedQuestion",
];

const APPROVED_FIELDS = [
  "workId",
  "handoffId",
  "stage",
  "updatedAt",
  "strategySkillCycleUnavailable",
  "strategySkillFindings",
];

type FakeEnv = { env: Env; calls: { idFromName: string[]; getState: number } };

/**
 * Fake runtime: WORK_SESSION namespace resolving to a stub that exposes ONLY
 * getState(). Any other Durable Object call the handler might reach for would
 * throw, so a passing test also proves the route is read-only.
 */
function createFakeEnv(options: { adminKey?: string; state?: WorkState | undefined } = {}): FakeEnv {
  const calls = { idFromName: [] as string[], getState: 0 };
  const stub = {
    getState: async () => {
      calls.getState += 1;
      return options.state;
    },
    execute: async () => {
      throw new Error("inspection route must not call execute()");
    },
    handleTextReply: async () => {
      throw new Error("inspection route must not call handleTextReply()");
    },
    handleCallback: async () => {
      throw new Error("inspection route must not call handleCallback()");
    },
  };
  const env = {
    WORK_SESSION: {
      idFromName: (name: string) => {
        calls.idFromName.push(name);
        return name;
      },
      get: () => stub,
    },
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    // Explicit `adminKey: undefined` models the unset production secret; a
    // caller that simply omits it gets the normal configured key.
    WORKER_ADMIN_KEY: "adminKey" in options ? options.adminKey : ADMIN_KEY,
  } as unknown as Env;
  return { env, calls };
}

function inspectRequest(options: { workId?: string; key?: string | null } = {}): Request {
  const workId = "workId" in options ? options.workId : WORK_ID;
  const url = workId === undefined ? ROUTE : `${ROUTE}?workId=${encodeURIComponent(workId)}`;
  const headers = new Headers();
  const key = "key" in options ? options.key : ADMIN_KEY;
  if (key) headers.set("X-Worker-Admin-Key", key);
  return new Request(url, { headers });
}

// Sentinel-bearing WorkState: everything approved plus everything forbidden,
// so leakage shows up as a literal string in the response body.
function richState(): WorkState {
  return {
    workId: WORK_ID,
    handoffId: "3eecb004-e583-8122-87d8-f4153856758b",
    stage: "strategy_blocked",
    updatedAt: "2026-10-05T07:56:07.677Z",
    strategySkillCycleUnavailable: false,
    chatId: 987654321,
    threadId: 42,
    entityName: "SENTINEL_ENTITY_NAME",
    matterName: "SENTINEL_MATTER_NAME",
    enquiryText: "SENTINEL_ENQUIRY_TEXT",
    strategyContext: "SENTINEL_STRATEGY_CONTEXT",
    strategyDiagnosis: "SENTINEL_STRATEGY_DIAGNOSIS",
    strategyProposal: "SENTINEL_STRATEGY_PROPOSAL",
    pendingStrategyApproval: "SENTINEL_PENDING_STRATEGY_APPROVAL",
    strategySourceBoundaryAttestation: "SENTINEL_ATTESTATION",
    strategySkillFindings: [
      {
        skillId: "brand_strategy",
        status: "completed",
        finding: "SENTINEL_FINDING",
        evidenceLimitation: "SENTINEL_EVIDENCE_LIMITATION",
        implication: "SENTINEL_IMPLICATION",
        unresolvedQuestion: "SENTINEL_UNRESOLVED_QUESTION",
      },
      {
        skillId: "business_strategy",
        status: "failed",
        failureReason: "SENTINEL_FAILURE_REASON",
      },
    ],
  } as unknown as WorkState;
}

test("auth: missing X-Worker-Admin-Key header -> 403, no Durable Object touched", async () => {
  const { env, calls } = createFakeEnv({ state: richState() });
  const res = await handleWorkSessionState(inspectRequest({ key: null }), env);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.idFromName.length, 0);
  assert.strictEqual(calls.getState, 0);
});

test("auth: incorrect X-Worker-Admin-Key header -> 403, no Durable Object touched", async () => {
  const { env, calls } = createFakeEnv({ state: richState() });
  const res = await handleWorkSessionState(inspectRequest({ key: "wrong-key" }), env);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.getState, 0);
});

test("auth: missing WORKER_ADMIN_KEY secret -> 403 even with the right header (fail closed)", async () => {
  const { env, calls } = createFakeEnv({ adminKey: undefined, state: richState() });
  const res = await handleWorkSessionState(inspectRequest({ key: ADMIN_KEY }), env);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.getState, 0);
});

test("validation: missing workId -> 400, no Durable Object instantiated", async () => {
  const { env, calls } = createFakeEnv({ state: richState() });
  const res = await handleWorkSessionState(inspectRequest({ workId: undefined }), env);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(calls.idFromName.length, 0);
  assert.strictEqual(calls.getState, 0);
});

test("validation: malformed workId -> 400, no Durable Object instantiated", async () => {
  for (const workId of ["not-a-uuid", "e0922db0346047e8a8203533e48c82c2", "3eecb004/e583/8122"]) {
    const { env, calls } = createFakeEnv({ state: richState() });
    const res = await handleWorkSessionState(inspectRequest({ workId }), env);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(workId)}`);
    assert.strictEqual(calls.idFromName.length, 0, `must not instantiate a DO for ${JSON.stringify(workId)}`);
    assert.strictEqual(calls.getState, 0);
  }
});

test("validation: valid UUID reaches the existing getSessionStub path exactly once", async () => {
  const { env, calls } = createFakeEnv({ state: richState() });
  const res = await handleWorkSessionState(inspectRequest(), env);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls.idFromName, [WORK_ID]);
  assert.strictEqual(calls.getState, 1);
});

test("projection: response carries only the approved fields, never the full WorkState", async () => {
  const { env } = createFakeEnv({ state: richState() });
  const res = await handleWorkSessionState(inspectRequest(), env);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "application/json");

  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;

  assert.deepStrictEqual(Object.keys(body).sort(), [...APPROVED_FIELDS].sort());

  for (const field of FORBIDDEN_FIELDS) {
    assert.ok(!raw.includes(`"${field}"`), `response must not expose ${field}`);
  }
  assert.ok(!raw.includes("SENTINEL_"), "response must not expose any non-projected WorkState value");

  const findings = body.strategySkillFindings as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(findings));
  for (const finding of findings) {
    assert.deepStrictEqual(Object.keys(finding).sort(), ["invocation", "skillId", "status"]);
  }
  assert.deepStrictEqual(body, {
    workId: WORK_ID,
    handoffId: "3eecb004-e583-8122-87d8-f4153856758b",
    stage: "strategy_blocked",
    updatedAt: "2026-10-05T07:56:07.677Z",
    strategySkillCycleUnavailable: false,
    strategySkillFindings: [
      { invocation: 1, skillId: "brand_strategy", status: "completed" },
      { invocation: 2, skillId: "business_strategy", status: "failed" },
    ],
  });
});

test("retrieval: six-invocation sequence is returned in exact order with array order as invocation number", async () => {
  const skillIds = [
    "brand_strategy",
    "business_strategy",
    "communication_strategy",
    "research_signal",
    "brand_strategy",
    "business_strategy",
  ];
  const state = {
    workId: WORK_ID,
    stage: "strategy_blocked",
    updatedAt: "2026-10-05T07:56:07.677Z",
    strategySkillFindings: skillIds.map((skillId, index) => ({
      skillId,
      status: index % 2 === 0 ? "completed" : "failed",
    })),
  } as unknown as WorkState;
  const { env } = createFakeEnv({ state });

  const res = await handleWorkSessionState(inspectRequest(), env);
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as {
    handoffId: string | null;
    strategySkillCycleUnavailable: boolean | null;
    strategySkillFindings: Array<{ invocation: number; skillId: string | null; status: string | null }>;
  };

  assert.strictEqual(body.handoffId, null, "absent field -> null, not unrelated state");
  assert.strictEqual(body.strategySkillCycleUnavailable, null, "absent field -> null");
  assert.deepStrictEqual(
    body.strategySkillFindings,
    skillIds.map((skillId, index) => ({
      invocation: index + 1,
      skillId,
      status: index % 2 === 0 ? "completed" : "failed",
    })),
  );
});

test("retrieval: strategySkillCycleUnavailable distinguishes false from absent", async () => {
  for (const [cycleUnavailable, expected] of [
    [true, true],
    [false, false],
    [undefined, null],
  ] as const) {
    const state = {
      workId: WORK_ID,
      stage: "strategy_blocked",
      strategySkillCycleUnavailable: cycleUnavailable,
    } as unknown as WorkState;
    const { env } = createFakeEnv({ state });
    const res = await handleWorkSessionState(inspectRequest(), env);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { strategySkillCycleUnavailable: boolean | null };
    assert.strictEqual(body.strategySkillCycleUnavailable, expected);
    assert.deepStrictEqual((body as unknown as Record<string, unknown>).strategySkillFindings, []);
  }
});

test("missing state: undefined -> 404 without creating or writing any record", async () => {
  const { env, calls } = createFakeEnv({ state: undefined });
  const res = await handleWorkSessionState(inspectRequest(), env);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(calls.getState, 1);
});

test("missing state: null -> 404", async () => {
  const { env } = createFakeEnv({ state: null as unknown as WorkState });
  const res = await handleWorkSessionState(inspectRequest(), env);
  assert.strictEqual(res.status, 404);
});
