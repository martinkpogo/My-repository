import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { Env, WorkState } from "../types";
import type { UnitManifest } from "../units/unitManifest";
import { findUnitManifest } from "../units/registry";
import {
  MAX_RESULT_EVIDENCE_CONTENT_CHARS,
  RESULT_REVIEW_BLOCKED_STAGE,
  applyResultReviewGate,
  ensureResultReviewContract,
  evaluateResultReviewGate,
  hashResultReviewApproval,
  hashResultReviewVerdict,
  isSuccessfulResultStage,
  recordResultEvidence,
  resolveResultReviewApprovalDecision,
  stageResultReviewApproval,
} from "../resultReview";
import { isTerminalWorkStage } from "../matterContinuation";
import {
  needsResultVerification,
  runMachineryResultVerification,
  type ResultVerificationDeps,
  type ResultVerificationRun,
} from "./resultVerification";
import {
  RESULT_GATE_SMOKE_ACTION,
  RESULT_GATE_SMOKE_AUTH_PARAM,
  RESULT_GATE_SMOKE_ORIGIN,
  RESULT_GATE_SMOKE_PARAMS,
  RESULT_GATE_SMOKE_TARGET,
  RESULT_GATE_SMOKE_WORK_ID_PREFIX,
  isResultGateSmokeWorkId,
  martinTelegramChatId,
  newResultGateSmokeWorkId,
  parseResultGateSmokeParams,
  resolveResultGateSmokeAction,
  resultGateSmokeEvidence,
  runResultGateSmoke,
  type ResultGateSmokeReport,
  type ResultGateSmokeRunner,
} from "./resultGateSmoke";

/**
 * The isolated live Result Gate smoke harness contract (ENIG issue #370),
 * proven at its own boundary:
 *
 * - the target is fixed and caller-unselectable (one origin, one Action, one
 *   prefix, no destination parameter; `origin`/`action` both REQUIRED and
 *   exact), and the Action resolves through the LIVE in-process Unit
 *   manifest and Resolution machinery -- no Notion fetch of its own --
 *   before any Work exists, refusing if it declares even one permitted Tool
 *   operation;
 * - the synthetic Work is created and advanced only through the runner
 *   seams, and the Machinery Worker verification happens inside the save
 *   path -- never through a direct call from the harness;
 * - a PASS stages Martin's card and nothing else: no auto-approval, no
 *   closure, and a post-run invariant refuses the report if that ever broke;
 * - harness execution (`ok` / `harness_execution`) and the Result Gate
 *   verdict (`result_gate`) are separate fields, so a recorded FAIL is
 *   never presented as a passing Result Gate test;
 * - the resolved test Action must declare ZERO permitted Tool operations,
 *   enforced by the harness itself before any Work exists;
 * - missing authority, missing/malformed evidence and unusable checks all
 *   fail closed with no verdict, no approval and no closure;
 * - no business handler, no Tool operation and no ordinary entry path can
 *   reach the test Action (source scans).
 *
 * Every run here uses a fake runner that mirrors WorkSession's own
 * execute -> save ordering over the REAL `ensureResultReviewContract`,
 * `needsResultVerification`, `runMachineryResultVerification` (with injected
 * I/O), `applyResultReviewGate`, `stageResultReviewApproval` and
 * `resolveResultReviewApprovalDecision` -- so the gate, the verdict hashing
 * and the approval binding under test are the production ones. The
 * Durable Object itself is pinned as source text, because `cloudflare:workers`
 * cannot be loaded under the node test runner.
 */

const MARTIN_CHAT = 777000111;
const WORK_ID = `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const HAT = RESULT_GATE_SMOKE_TARGET.hat;

const AUTHORITY_PAGE = `# Operations

Some prose about operations.

result_verification_authority:
  machinery_worker_id: Machinery Worker Alpha
  granted_by: martin
  granted_capabilities: [verify_work_result]

next_top_level_section:
  key: value
`;

function fakeEnv(overrides: Record<string, unknown> = {}): Env {
  return { MARTIN_TELEGRAM_USER_ID: String(MARTIN_CHAT), ...overrides } as unknown as Env;
}

function defaultDeps(overrides: Partial<ResultVerificationDeps> = {}): ResultVerificationDeps {
  return {
    fetchAuthorityPage: async () => AUTHORITY_PAGE,
    runCheck: async ({ evidence }) => ({
      outcome: "pass",
      reason: `the ${evidence.length} synthetic smoke evidence item(s) satisfy every declared completion criterion.`,
    }),
    ...overrides,
  };
}

const SRC = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

function allTypeScriptFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push({ rel: path.relative(SRC, full), text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(SRC);
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures: a runner that mirrors WorkSession's execute -> save ordering.
// ---------------------------------------------------------------------------

type EvidenceMode = "record" | "omit" | "malformed";

function freshState(workId: string, chatId: number): WorkState {
  const now = new Date().toISOString();
  return {
    workId,
    chatId,
    unit: RESULT_GATE_SMOKE_TARGET.unit,
    hat: HAT,
    actionName: RESULT_GATE_SMOKE_TARGET.action,
    stage: "new",
    createdAt: now,
    updatedAt: now,
  } as unknown as WorkState;
}

/** WorkSession's own `recordedActionResult`: the Work's recorded Action as registered on its Unit manifest. */
function recordedActionResult(state: WorkState): { expectedResult?: string; completionCriteria?: readonly string[] } | undefined {
  const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
  const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
  return hat?.actions.find((a) => a.name === state.actionName);
}

interface SmokeHarness {
  runner: ResultGateSmokeRunner;
  ensureCalls: Array<{ workId: string; chatId: number }>;
  runCalls: string[];
  /** Ordering markers proving the verification happens INSIDE the persistence seam. */
  order: string[];
  verifications: ResultVerificationRun[];
  staged: Array<Awaited<ReturnType<typeof stageResultReviewApproval>>>;
  blockedReasons: Array<string | undefined>;
  state(): WorkState | undefined;
  setDeps(deps: ResultVerificationDeps): void;
  setEvidenceMode(mode: EvidenceMode): void;
}

function makeHarness(options: { existing?: boolean; evidence?: EvidenceMode } = {}): SmokeHarness {
  const ensureCalls: Array<{ workId: string; chatId: number }> = [];
  const runCalls: string[] = [];
  const order: string[] = [];
  const verifications: ResultVerificationRun[] = [];
  const staged: Array<Awaited<ReturnType<typeof stageResultReviewApproval>>> = [];
  const blockedReasons: Array<string | undefined> = [];
  let deps = defaultDeps();
  let evidenceMode: EvidenceMode = options.evidence ?? "record";
  let state: WorkState | undefined = options.existing ? freshState(WORK_ID, MARTIN_CHAT) : undefined;

  const harness: SmokeHarness = {
    ensureCalls,
    runCalls,
    order,
    verifications,
    staged,
    blockedReasons,
    state: () => state,
    setDeps: (next) => {
      deps = next;
    },
    setEvidenceMode: (next) => {
      evidenceMode = next;
    },
    runner: {
      ensureGovernedWork: async (id, chatId) => {
        ensureCalls.push({ workId: id, chatId });
        if (state) {
          return {
            ok: false,
            reason: `Work ${id} already exists in this session -- the Result Gate smoke harness refuses to reuse or overwrite an existing Work; run a fresh invocation with a new Work id instead.`,
          };
        }
        state = freshState(id, chatId);
        return { ok: true };
      },
      runWithWorkPersistence: async (id, fn) => {
        runCalls.push(id);
        order.push("persistence:start");
        // Entry snapshot: WorkSession.execute's catch path returns without
        // save(), so storage keeps exactly this.
        const entry = structuredClone(state!);
        try {
          const current = state!;
          if (current.workId !== id) {
            throw new Error(`Result Gate smoke Work mismatch: this session holds ${current.workId} but the smoke asked for ${id}.`);
          }
          // WorkSession.execute: the Result contract comes from the Work's
          // OWN recorded Action, never hand-written.
          ensureResultReviewContract(current, recordedActionResult(current));
          const after = await fn(current);
          order.push("body:done");

          // Model a producing side whose evidence set is absent or malformed
          // at the moment verification judges it (the runner owns the save()
          // seam, which is where that set is read).
          if (evidenceMode === "omit") after.resultReview!.evidence = undefined;
          if (evidenceMode === "malformed") after.resultReview!.evidence = [{ kind: "", ref: "", content: "" }];

          // WorkSession.save: verification first, then the gate -- the exact
          // production order, over the real implementations.
          if (
            after.resultReview &&
            (isSuccessfulResultStage(after.stage ?? "") || after.stage === RESULT_REVIEW_BLOCKED_STAGE) &&
            (await needsResultVerification(after))
          ) {
            order.push("verification");
            verifications.push(await runMachineryResultVerification(after, deps));
          }
          await applyResultReviewGate(after, async (s, reason) => {
            order.push("gate");
            blockedReasons.push(reason);
            if (s.resultReview?.checker?.outcome === "passed" && !s.resultReview?.approval && !s.resultReview?.pendingApproval) {
              staged.push(await stageResultReviewApproval(s));
            }
          });
          state = after;
          order.push("persistence:end");
          return after;
        } catch (err) {
          console.error("smoke harness runner failed", err);
          state = entry;
          order.push("persistence:threw");
          return entry;
        }
      },
    },
  };
  return harness;
}

async function runHappy(opts: { evidence?: EvidenceMode } = {}): Promise<{ report: ResultGateSmokeReport; harness: SmokeHarness }> {
  const harness = makeHarness({ evidence: opts.evidence });
  const report = await runResultGateSmoke(fakeEnv(), WORK_ID, harness.runner);
  return { report, harness };
}

// ---------------------------------------------------------------------------
// The fixed target and Work id shape.
// ---------------------------------------------------------------------------

test("target: one fixed Unit/Hat/Responsibility/Action, declared once and reported verbatim", () => {
  assert.deepEqual(RESULT_GATE_SMOKE_PARAMS, ["origin", "action", "work_id"]);
  assert.equal(RESULT_GATE_SMOKE_ORIGIN, "result_gate_smoke");
  assert.equal(RESULT_GATE_SMOKE_ACTION, "result_gate_smoke_test");
  assert.deepEqual({ ...RESULT_GATE_SMOKE_TARGET }, {
    unit: "Business Development",
    hat: "Business Development Manager",
    responsibility: "develop_opportunities",
    action: "result_gate_smoke_test",
  });
  assert.equal(RESULT_GATE_SMOKE_WORK_ID_PREFIX, "result-gate-smoke-");
  // The auth parameter is admin auth (src/adminAuth.ts), never a harness
  // parameter -- it cannot carry a target or a destination.
  assert.equal(RESULT_GATE_SMOKE_AUTH_PARAM, "key");
});

test("work id: only result-gate-smoke-<uuid> belongs to the harness", () => {
  const generated = newResultGateSmokeWorkId();
  assert.ok(generated.startsWith(RESULT_GATE_SMOKE_WORK_ID_PREFIX));
  assert.ok(isResultGateSmokeWorkId(generated), "a generated id is a harness id");

  for (const id of [
    "df99c0e2-e522-4853-a994-51fae8dd2f06",
    `smoke-googledocs-${"a".repeat(8)}-0000-4000-8000-000000000000`,
    `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}not-a-uuid`,
    `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE`,
    "",
    null,
    42,
  ]) {
    assert.equal(isResultGateSmokeWorkId(id), false, `${JSON.stringify(id)} must not be a harness Work id`);
  }
});

// ---------------------------------------------------------------------------
// Query-parameter contract: exact values only, no destination, no target.
// ---------------------------------------------------------------------------

test("params: exact origin and action are accepted, with or without a Work id", () => {
  assert.deepEqual(parseResultGateSmokeParams(new URLSearchParams("origin=result_gate_smoke&action=result_gate_smoke_test")), {
    ok: true,
  });
  const withId = parseResultGateSmokeParams(new URLSearchParams(`origin=result_gate_smoke&action=result_gate_smoke_test&work_id=${WORK_ID}`));
  assert.deepEqual(withId, { ok: true, work_id: WORK_ID });
});

test("params: origin and action are REQUIRED -- missing or empty values are refused exactly like different ones", () => {
  const cases: Array<[query: string, expected: RegExp]> = [
    // Missing entirely.
    ["", /origin is required/],
    [`action=${RESULT_GATE_SMOKE_ACTION}`, /origin is required/],
    [`work_id=${WORK_ID}`, /origin is required/],
    [`origin=${RESULT_GATE_SMOKE_ORIGIN}`, /action is required/],
    // Present but empty.
    [`origin=&action=${RESULT_GATE_SMOKE_ACTION}`, /origin must be exactly/],
    [`origin=${RESULT_GATE_SMOKE_ORIGIN}&action=`, /action must be exactly/],
    // Present but different.
    [`origin=direct_request&action=${RESULT_GATE_SMOKE_ACTION}`, /origin must be exactly/],
    [`origin=${RESULT_GATE_SMOKE_ORIGIN}&action=develop_opportunity`, /action must be exactly/],
    [`origin=${RESULT_GATE_SMOKE_ORIGIN}&action=result_gate_smoke`, /action must be exactly/],
  ];
  for (const [query, expected] of cases) {
    const res = parseResultGateSmokeParams(new URLSearchParams(query));
    assert.equal(res.ok, false, `"${query}" must be refused`);
    if (!res.ok) assert.match(res.reason, expected, `"${query}" -> ${res.reason}`);
  }
});

test("params: any other origin or action is refused", () => {
  for (const [key, value] of [
    ["origin", "direct_request"],
    ["origin", "handoff_pickup"],
    ["origin", "lifecycle_transition"],
    ["origin", ""],
    ["action", "develop_opportunity"],
    ["action", "diagnose"],
    ["action", ""],
  ]) {
    const other = key === "origin" ? `action=${RESULT_GATE_SMOKE_ACTION}` : `origin=${RESULT_GATE_SMOKE_ORIGIN}`;
    const res = parseResultGateSmokeParams(new URLSearchParams(`${key}=${value}&${other}`));
    assert.equal(res.ok, false, `${key}=${value} must be refused`);
    if (!res.ok) assert.match(res.reason, new RegExp(key));
  }
});

test("params: there is no caller choice of Unit, Hat, Responsibility, Action or Telegram destination", () => {
  const forbidden = [
    "chat_id=777000111",
    "chatId=777000111",
    "thread_id=1",
    "destination=777000111",
    "to=777000111",
    "unit=Sales",
    "hat=Sales%20Executive",
    "responsibility=develop_opportunities",
    "action_version=1",
    "mode=chat",
  ];
  for (const query of forbidden) {
    const res = parseResultGateSmokeParams(new URLSearchParams(query));
    assert.equal(res.ok, false, `${query} must be refused`);
    if (!res.ok) assert.match(res.reason, /unknown query parameter/);
  }
});

test("params: each parameter may appear at most once, and work_id must already be a harness id", () => {
  const duplicate = parseResultGateSmokeParams(new URLSearchParams("action=result_gate_smoke_test&action=result_gate_smoke_test"));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.reason, /duplicate query parameter "action"/);

  const badId = parseResultGateSmokeParams(new URLSearchParams(`origin=${RESULT_GATE_SMOKE_ORIGIN}&action=${RESULT_GATE_SMOKE_ACTION}&work_id=df99c0e2-e522-4853-a994-51fae8dd2f06`));
  assert.equal(badId.ok, false);
  if (!badId.ok) assert.match(badId.reason, /result-gate-smoke-/);

  const emptyId = parseResultGateSmokeParams(new URLSearchParams(`origin=${RESULT_GATE_SMOKE_ORIGIN}&action=${RESULT_GATE_SMOKE_ACTION}&work_id=`));
  assert.equal(emptyId.ok, false);
});

test("params: the admin-auth key parameter is still accepted for authentication only", () => {
  const res = parseResultGateSmokeParams(new URLSearchParams(`key=whatever&origin=${RESULT_GATE_SMOKE_ORIGIN}&action=${RESULT_GATE_SMOKE_ACTION}`));
  assert.deepEqual(res, { ok: true });
  // The key never substitutes for a required harness parameter.
  const keyOnly = parseResultGateSmokeParams(new URLSearchParams("key=whatever"));
  assert.equal(keyOnly.ok, false, "admin auth does not relax the required origin/action");
});

// ---------------------------------------------------------------------------
// The approval destination: trusted configuration, fail closed.
// ---------------------------------------------------------------------------

test("destination: Martin's DM comes from trusted config and fails closed without it", () => {
  assert.equal(martinTelegramChatId(fakeEnv()), MARTIN_CHAT);
  for (const value of ["", "   ", "not-a-number", "0", "-5", "12.5", "1e30", undefined, null]) {
    assert.equal(martinTelegramChatId({ MARTIN_TELEGRAM_USER_ID: value as string }), null, `${JSON.stringify(value)} must fail closed`);
  }
});

test("destination: an unconfigured destination refuses BEFORE any Work is created", async () => {
  const harness = makeHarness();
  const report = await runResultGateSmoke(fakeEnv({ MARTIN_TELEGRAM_USER_ID: "" }), WORK_ID, harness.runner);
  assert.equal(report.ok, false);
  assert.match(report.refusal ?? "", /MARTIN_TELEGRAM_USER_ID/);
  assert.equal(harness.ensureCalls.length, 0, "no Work may exist without an approval destination");
  assert.equal(harness.runCalls.length, 0);
});

test("destination: the runner is always handed the configured DM, never a caller-supplied one", async () => {
  const { harness } = await runHappy();
  assert.deepEqual(harness.ensureCalls, [{ workId: WORK_ID, chatId: MARTIN_CHAT }]);
});

// ---------------------------------------------------------------------------
// Pre-flight: the LIVE in-process Unit manifest and Resolution machinery
// decide (no Notion fetch here; the canonical Operations authority page is
// read later, by the Machinery Worker verification inside save()).
// ---------------------------------------------------------------------------

/** The live manifest with Tool operation declarations added to the test-only Action. */
function manifestWithToolOperations(operations: readonly { tool_id: string; operation_id: string; required: boolean }[]): UnitManifest {
  const live = findUnitManifest("Business Development")!;
  const hat = live.hats[HAT];
  return {
    ...live,
    hats: {
      ...live.hats,
      [HAT]: {
        ...hat,
        actions: hat.actions.map((a) => (a.name === RESULT_GATE_SMOKE_ACTION ? { ...a, tool_operations: [...operations] } : a)),
      },
    },
  } as unknown as UnitManifest;
}

test("pre-flight: the test Action resolves through the in-process Unit manifest with its Result contract and zero Tool operations", async () => {
  const resolution = await resolveResultGateSmokeAction();
  assert.equal(resolution.ok, true, resolution.ok ? "" : resolution.reason);
  if (!resolution.ok) return;
  const { plan } = resolution;
  assert.equal(plan.unit, "Business Development");
  assert.equal(plan.hat, "Business Development Manager");
  assert.equal(plan.responsibility, "develop_opportunities");
  assert.equal(plan.action, "result_gate_smoke_test");
  assert.ok(plan.expectedResult.trim().length > 0, "the Action declares an expected Result");
  assert.ok(plan.completionCriteria.length >= 1, "the Action declares completion criteria");
  assert.deepEqual(plan.toolOperations, [], "the test-only Action declares no Tool operation");
});

test("pre-flight: a manifest that no longer declares the test Action refuses, and resolution always precedes Work creation", async () => {
  const live = findUnitManifest("Business Development")!;
  const hat = live.hats[HAT];
  const stripped = {
    ...live,
    hats: { ...live.hats, [HAT]: { ...hat, actions: hat.actions.filter((a) => a.name !== RESULT_GATE_SMOKE_ACTION) } },
  } as unknown as UnitManifest;

  const resolution = await resolveResultGateSmokeAction(stripped);
  assert.equal(resolution.ok, false);
  if (!resolution.ok) {
    assert.match(resolution.reason, /undeclared_action/);
    assert.ok(resolution.reason.includes(RESULT_GATE_SMOKE_ACTION), resolution.reason);
  }

  // The core resolves the in-process authority (Unit manifest + Resolution)
  // BEFORE it asks the runner to create anything, so an unusable authority
  // never leaves a Work behind.
  const source = read("runtime/resultGateSmoke.ts");
  const resolveAt = source.indexOf("await resolveResultGateSmokeAction(manifest)");
  const ensureAt = source.indexOf("runner.ensureGovernedWork(");
  assert.ok(resolveAt > -1 && ensureAt > -1, "both steps exist");
  assert.ok(resolveAt < ensureAt, "authority is resolved before any Work exists");
});

test("pre-flight: an Action declaring no Result contract is refused (no Work, no run)", async () => {
  const live = findUnitManifest("Business Development")!;
  const hat = live.hats[HAT];
  const withoutContract = {
    ...live,
    hats: {
      ...live.hats,
      [HAT]: {
        ...hat,
        actions: hat.actions.map((a) => (a.name === RESULT_GATE_SMOKE_ACTION ? { ...a, expectedResult: undefined, completionCriteria: undefined } : a)),
      },
    },
  } as unknown as UnitManifest;

  const resolution = await resolveResultGateSmokeAction(withoutContract);
  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.match(resolution.reason, /no complete Result contract/);
});

test("pre-flight: an Action declaring even ONE permitted Tool operation is refused", async () => {
  const resolution = await resolveResultGateSmokeAction(
    manifestWithToolOperations([{ tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false }]),
  );
  assert.equal(resolution.ok, false, "one declared Tool operation is enough to refuse");
  if (!resolution.ok) {
    assert.match(resolution.reason, /isolation violated/);
    assert.match(resolution.reason, /ZERO Tool operations/);
    assert.match(resolution.reason, /google_docs:google_docs\.create_and_verify/, "the refusal names the offending operation");
    assert.match(resolution.reason, /before any Work is created/);
    assert.match(resolution.reason, /no evidence is recorded|before any evidence is recorded/);
  }
});

test("pre-flight: an Action declaring MULTIPLE permitted Tool operations is refused, naming every one", async () => {
  const resolution = await resolveResultGateSmokeAction(
    manifestWithToolOperations([
      { tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false },
      { tool_id: "telegram", operation_id: "telegram.send_message", required: true },
    ]),
  );
  assert.equal(resolution.ok, false, "multiple declared Tool operations are refused");
  if (!resolution.ok) {
    assert.match(resolution.reason, /2 permitted Tool operation/);
    assert.match(resolution.reason, /google_docs:google_docs\.create_and_verify/);
    assert.match(resolution.reason, /telegram:telegram\.send_message/);
    assert.match(resolution.reason, /ZERO Tool operations/);
  }
});

test("isolation: a Tool-operation refusal happens BEFORE any Work exists -- no creation, no mutation, no evidence, no verification, no approval", async () => {
  const harness = makeHarness();
  const manifest = manifestWithToolOperations([{ tool_id: "google_docs", operation_id: "google_docs.create_and_verify", required: false }]);

  // Through the real orchestration, using the EXISTING runner seams to
  // prove nothing was created or mutated.
  const report = await runResultGateSmoke(fakeEnv(), WORK_ID, harness.runner, manifest);

  assert.equal(report.ok, false);
  assert.equal(report.harness_execution, "refused");
  assert.equal(report.result_gate, "no_usable_verdict");
  assert.match(report.refusal ?? "", /isolation violated/);
  assert.match(report.refusal ?? "", /ZERO Tool operations/);

  // No Durable Object Work creation or mutation (the existing seams).
  assert.deepEqual(harness.ensureCalls, [], "ensureGovernedWork is never called");
  assert.deepEqual(harness.runCalls, [], "runWithWorkPersistence is never called");
  assert.equal(harness.state(), undefined, "no Work state exists at all");
  assert.deepEqual(harness.order, [], "no execute/save cycle ran");

  // No evidence, no verification, no approval, no closure.
  assert.deepEqual(report.evidence, []);
  assert.equal(report.verification, null);
  assert.equal(report.approval, null);
  assert.equal(report.stage, null);
  assert.equal(report.work_closed, false);
  assert.equal(harness.verifications.length, 0, "the verifier never ran");
  assert.equal(harness.staged.length, 0, "no approval was staged");
  assert.equal(harness.blockedReasons.length, 0, "the Result review gate never ran");

  // Structurally: the zero-Tool-operation check lives inside the pre-flight,
  // which completes before the runner is ever asked to create a Work.
  const source = read("runtime/resultGateSmoke.ts");
  const toolCheckAt = source.indexOf("isolation violated: the test-only Action");
  const resolveAt = source.indexOf("await resolveResultGateSmokeAction(manifest)");
  const ensureAt = source.indexOf("runner.ensureGovernedWork(");
  assert.ok(toolCheckAt > -1 && resolveAt > -1 && ensureAt > -1, "all three steps exist");
  assert.ok(toolCheckAt < resolveAt, "the check runs inside the pre-flight resolution");
  assert.ok(resolveAt < ensureAt, "the pre-flight completes before any Work is created");
});

// ---------------------------------------------------------------------------
// The full sequence: create -> synthetic evidence -> save() verifies ->
// gate refuses -> Martin's card staged.
// ---------------------------------------------------------------------------

test("sequence: the synthetic Work runs the normal execute/save lifecycle and the Result Gate blocks it", async () => {
  const { report, harness } = await runHappy();

  assert.equal(report.ok, true, report.refusal ?? "");
  // Harness execution and the Result Gate verdict are separate facts: the
  // harness completed, and the Result Gate's verdict is its own field.
  assert.equal(report.harness_execution, "completed");
  assert.equal(report.result_gate, "passed");
  assert.equal(report.work_id, WORK_ID);
  assert.deepEqual(report.target, { ...RESULT_GATE_SMOKE_TARGET });
  assert.equal(report.stage, RESULT_REVIEW_BLOCKED_STAGE);
  assert.equal(isSuccessfulResultStage(report.stage ?? ""), false, "the Work never sits at a successful stage");
  assert.equal(report.work_closed, false);
  assert.equal(isTerminalWorkStage(report.stage ?? ""), false);
  assert.ok(report.blocked_reason && report.blocked_reason.length > 0, "the refusal reason stays visible");

  // Exactly one creation (with the configured destination) and one run.
  assert.deepEqual(harness.ensureCalls, [{ workId: WORK_ID, chatId: MARTIN_CHAT }]);
  assert.deepEqual(harness.runCalls, [WORK_ID]);
  assert.equal(harness.verifications.length, 1, "exactly one Machinery Worker verification ran");

  // Synthetic evidence, through the existing evidence model.
  assert.equal(report.evidence.length, 2);
  for (const item of report.evidence) {
    assert.equal(item.kind, "smoke_test");
    assert.ok(item.ref.length > 0);
  }
  assert.ok(report.evidence.some((e) => e.ref === WORK_ID));
  assert.ok(report.evidence.some((e) => e.ref === "result-gate-smoke-sequence"));
});

test("verification: the verdict is recorded over the exact snapshot, with checker identity and evidence refs", async () => {
  const { report } = await runHappy();
  assert.equal(report.ok, true, report.refusal ?? "");
  assert.ok(report.verification, "a verdict was recorded");
  assert.equal(report.verification!.outcome, "passed");
  assert.equal(report.result_gate, "passed", "the verdict field mirrors the recorded verdict");
  assert.equal(report.harness_execution, "completed");
  assert.equal(report.verification!.checker_id, "Machinery Worker Alpha");
  assert.ok(report.verification!.reason && report.verification!.reason.length > 0);
  assert.ok(report.verification!.verdict_hash && report.verification!.verdict_hash.length > 0);
  assert.ok(report.verification!.snapshot_key && report.verification!.snapshot_key.length > 0, "the evidence snapshot identity is reported");

  const refs = report.verification!.evidence_refs;
  assert.ok(refs.some((r) => r.kind === "work_record" && r.ref === WORK_ID), "the Work's own record is part of the snapshot");
  assert.deepEqual(
    refs.filter((r) => r.kind === "smoke_test").map((r) => r.ref).sort(),
    [WORK_ID, "result-gate-smoke-sequence"].sort(),
    "the synthetic evidence set is exactly what the verdict binds to",
  );
});

test("verification: reached through the save path, in order, never by a direct call", async () => {
  const { harness } = await runHappy();
  assert.deepEqual(harness.order, ["persistence:start", "body:done", "verification", "gate", "persistence:end"]);
  assert.equal(harness.staged.length, 1, "the card was staged by the gate's own reportBlocked callback");
  assert.equal(harness.blockedReasons.length, 1);
});

test("lifecycle: a PASS stages Martin's approval but never approves and never closes", async () => {
  const { report, harness } = await runHappy();
  const state = harness.state()!;

  // PASS reported, approval merely staged.
  assert.equal(report.verification?.outcome, "passed");
  assert.equal(report.approval?.staged, true);
  assert.ok(report.approval?.review_hash && report.approval.review_hash.length > 0);
  assert.ok(state.resultReview?.pendingApproval, "Martin's card is staged for his own decision");
  assert.equal(state.resultReview?.approval, undefined, "a PASS must never record an approval");
  assert.equal(report.work_closed, false, "a PASS must never close the Work");
  assert.notEqual(state.stage, "complete", "the gate, not the harness, owns the stage");
  assert.equal(state.stage, RESULT_REVIEW_BLOCKED_STAGE);
  assert.equal(state.resultReview?.preBlockStage, "complete", "the refused success stage is remembered for Martin's approval to restore");

  // The button token is deliberately not part of the report.
  assert.ok(!JSON.stringify(report).includes(state.resultReview!.pendingApproval!.token), "the approval token must not be reported");
});

test("approval: the staged card binds to the exact verdict over this Work's snapshot", async () => {
  const { report, harness } = await runHappy();
  const state = harness.state()!;
  const review = state.resultReview!;
  const staged = review.pendingApproval!;
  assert.ok(staged, "a card was staged");

  // The reported verdict hash recomputes from the reported snapshot.
  const recomputedVerdict = await hashResultReviewVerdict({
    workId: WORK_ID,
    expectedResult: review.expectedResult!,
    completionCriteria: review.completionCriteria!,
    evidenceRefs: report.verification!.evidence_refs,
    outcome: report.verification!.outcome,
    reason: report.verification!.reason ?? undefined,
  });
  assert.equal(report.verification!.verdict_hash, recomputedVerdict);

  // The reported review hash is the approval's binding to THAT verdict.
  const expectedReviewHash = await hashResultReviewApproval({
    workId: WORK_ID,
    expectedResult: review.expectedResult!,
    completionCriteria: review.completionCriteria!,
    verdictHash: report.verification!.verdict_hash!,
  });
  assert.equal(report.approval!.review_hash, expectedReviewHash);
  assert.equal(staged.reviewHash, expectedReviewHash);

  // A wrong token records nothing; Martin's own token records his approval
  // against that exact hash -- and only then does the gate allow closure.
  const wrong = await resolveResultReviewApprovalDecision(state, { approved: true, token: "not-the-staged-token" });
  assert.equal(wrong.ok, false, "a token that is not this card's records nothing");
  assert.equal(review.approval, undefined);

  const right = await resolveResultReviewApprovalDecision(state, { approved: true, token: staged.token });
  assert.equal(right.ok, true);
  if (right.ok && right.approval) {
    assert.equal(right.approval.approver, "martin");
    assert.equal(right.approval.reviewHash, expectedReviewHash);
  }
  assert.equal(staged.token !== undefined, true, "the staged card was consumed by the decision");

  const gate = await evaluateResultReviewGate(state);
  assert.equal(gate.allowed, true, "only Martin's recorded approval satisfies the gate");
});

test("callback: session.ts restores the refused success stage only from Martin's recorded approval", () => {
  const session = read("session.ts");
  const callbackAt = session.indexOf('case "resultreview"');
  assert.ok(callbackAt > -1, "the resultreview callback exists");
  const callbackSlice = session.slice(callbackAt, callbackAt + 2600);
  assert.ok(callbackSlice.includes("state.stage = review.preBlockStage"), "Martin's approval restores the stage the gate refused it from");
  assert.ok(callbackSlice.includes("resolveResultReviewApprovalDecision(state"), "the decision goes through the sanctioned resolver");
});

// ---------------------------------------------------------------------------
// Response semantics: harness execution and the Result Gate verdict are
// separate, unmistakable facts.
// ---------------------------------------------------------------------------

test("response semantics: PASS, recorded FAIL and refusal/unavailable are three unmistakable states", async () => {
  // 1. Harness completed + Result Gate PASSED.
  const pass = await runHappy();
  assert.equal(pass.report.ok, true);
  assert.equal(pass.report.harness_execution, "completed");
  assert.equal(pass.report.result_gate, "passed");
  assert.equal(pass.report.verification?.outcome, "passed");

  // 2. Harness completed + Result Gate FAILED (a recorded verdict): the
  //    harness did its job, the Result Gate did NOT pass.
  const fail = await runHappy({ evidence: "omit" });
  assert.equal(fail.report.ok, true, "harness execution completed and recorded a verdict");
  assert.equal(fail.report.harness_execution, "completed");
  assert.equal(fail.report.result_gate, "failed");
  assert.notEqual(fail.report.result_gate, "passed", "a recorded FAIL is never a passing Result Gate test");
  assert.equal(fail.report.verification?.outcome, "failed");
  assert.equal(fail.report.approval?.staged, false, "a FAIL stages nothing");

  // 3. Harness refused / no usable verdict.
  const refusedHarness = makeHarness();
  refusedHarness.setDeps(defaultDeps({ runCheck: async () => null }));
  const refused = await runResultGateSmoke(fakeEnv(), WORK_ID, refusedHarness.runner);
  assert.equal(refused.ok, false);
  assert.equal(refused.harness_execution, "refused");
  assert.equal(refused.result_gate, "no_usable_verdict");
  assert.equal(refused.verification, null);

  // 4. A pre-run refusal (no configured destination) is the same state.
  const preRun = await runResultGateSmoke(fakeEnv({ MARTIN_TELEGRAM_USER_ID: "" }), WORK_ID, makeHarness().runner);
  assert.equal(preRun.ok, false);
  assert.equal(preRun.harness_execution, "refused");
  assert.equal(preRun.result_gate, "no_usable_verdict");

  // The pair is total and consistent: "completed" exactly when ok, and the
  // verdict field is always one of the three explicit values.
  for (const r of [pass.report, fail.report, refused, preRun]) {
    assert.equal(r.harness_execution === "completed", r.ok, "harness_execution restates ok unambiguously");
    assert.ok(["passed", "failed", "no_usable_verdict"].includes(r.result_gate), `"${r.result_gate}" is an explicit state`);
  }
});

// ---------------------------------------------------------------------------
// Fail closed: nothing unusable can produce PASS, an approval or a closure.
// ---------------------------------------------------------------------------

test("fail closed: an unreadable authority page records no verdict and stages no approval", async () => {
  const harness = makeHarness();
  harness.setDeps(defaultDeps({ fetchAuthorityPage: async () => { throw new Error("page deleted"); } }));
  const report = await runResultGateSmoke(fakeEnv(), WORK_ID, harness.runner);

  assert.equal(report.ok, false);
  assert.equal(report.harness_execution, "refused", "an unusable verification is a harness refusal");
  assert.equal(report.result_gate, "no_usable_verdict", "no verdict can ever be reported as passed");
  assert.match(report.refusal ?? "", /verification_unavailable/);
  assert.match(report.refusal ?? "", /page deleted/);
  assert.equal(report.verification, null, "no verdict exists to report");
  assert.equal(report.approval, null, "nothing can be staged without a verdict");
  assert.equal(report.stage, RESULT_REVIEW_BLOCKED_STAGE, "the gate still refuses the closure");
  assert.equal(report.work_closed, false);
  assert.equal(harness.state()!.resultReview?.checker, undefined);
  assert.equal(harness.state()!.resultReview?.pendingApproval, undefined);
});

test("fail closed: an authority page without Martin's assignment records no verdict", async () => {
  const harness = makeHarness();
  harness.setDeps(defaultDeps({ fetchAuthorityPage: async () => "# Operations\n\nJust prose, no assignment.\n" }));
  const report = await runResultGateSmoke(fakeEnv(), WORK_ID, harness.runner);

  assert.equal(report.ok, false);
  assert.equal(report.harness_execution, "refused");
  assert.equal(report.result_gate, "no_usable_verdict");
  assert.match(report.refusal ?? "", /verification_unavailable/);
  assert.equal(report.verification, null);
  assert.equal(report.approval, null);
  assert.equal(report.work_closed, false);
  assert.equal(harness.state()!.resultReview?.checker, undefined);
});

test("fail closed: a check that produces no usable verdict records nothing", async () => {
  const harness = makeHarness();
  harness.setDeps(defaultDeps({ runCheck: async () => null }));
  const report = await runResultGateSmoke(fakeEnv(), WORK_ID, harness.runner);

  assert.equal(report.ok, false);
  assert.equal(report.harness_execution, "refused");
  assert.equal(report.result_gate, "no_usable_verdict");
  assert.match(report.refusal ?? "", /verification_unavailable/);
  assert.match(report.refusal ?? "", /no usable verdict/);
  assert.equal(report.verification, null);
  assert.equal(report.approval, null);
  assert.equal(report.work_closed, false);
  assert.equal(harness.state()!.resultReview?.pendingApproval, undefined);
});

test("fail closed: missing producing-side evidence yields a FAILED verdict, never PASS", async () => {
  const { report, harness } = await runHappy({ evidence: "omit" });

  assert.equal(report.verification?.outcome, "failed");
  assert.match(report.verification?.reason ?? "", /recorded no Result evidence/);
  // `ok` / `harness_execution` report the HARNESS (it completed and
  // recorded a verdict); `result_gate` is the verdict itself, and a
  // recorded FAIL is "failed" -- never a passing Result Gate test.
  assert.equal(report.ok, true, "the harness completed its sequence");
  assert.equal(report.harness_execution, "completed");
  assert.equal(report.result_gate, "failed");
  assert.notEqual(report.result_gate, "passed");
  assert.notEqual(report.verification?.outcome, "passed");
  assert.equal(report.approval?.staged, false, "a FAIL never stages Martin's card");
  assert.equal(report.work_closed, false);
  assert.equal(harness.state()!.resultReview?.approval, undefined);
  assert.equal(harness.state()!.resultReview?.pendingApproval, undefined);
  assert.equal(harness.state()!.stage, RESULT_REVIEW_BLOCKED_STAGE);
  assert.match(harness.state()!.resultReview?.blockReason ?? "", /verification failed/i);
});

test("fail closed: malformed evidence refs cannot produce a verdict at all", async () => {
  const { report, harness } = await runHappy({ evidence: "malformed" });

  assert.equal(report.ok, false);
  assert.equal(report.harness_execution, "refused");
  assert.equal(report.result_gate, "no_usable_verdict");
  assert.match(report.refusal ?? "", /verification_unavailable/);
  assert.match(report.refusal ?? "", /malformed evidence reference/);
  assert.equal(report.verification, null);
  assert.equal(report.approval, null);
  assert.equal(report.work_closed, false);
  assert.equal(harness.state()!.resultReview?.checker, undefined);
  assert.equal(harness.state()!.resultReview?.pendingApproval, undefined);
  assert.equal(harness.state()!.stage, RESULT_REVIEW_BLOCKED_STAGE, "the gate refuses with its own no-verdict reason");
});

test("evidence: the harness's own synthetic evidence is always well-formed and within the recorder's bounds", () => {
  const items = resultGateSmokeEvidence(WORK_ID);
  assert.equal(items.length, 2);
  assert.equal(items.length <= 12, true);
  for (const item of items) {
    assert.ok(item.kind.trim().length > 0, "kind is required");
    assert.ok(item.ref.trim().length > 0, "ref is required");
    assert.ok(item.content.length <= MAX_RESULT_EVIDENCE_CONTENT_CHARS, "content stays within the bound");
    assert.ok(!/ENT-\d+|MAT-\d+|HO-\d+/.test(item.content), "no real record identity appears in synthetic evidence");
  }
  assert.ok(!JSON.stringify(items).includes("SENTINEL"), "no client identity appears in synthetic evidence");
});

test("evidence: the existing recorder refuses a malformed set, so nothing can backfill it", async () => {
  const state = freshState(WORK_ID, MARTIN_CHAT);
  ensureResultReviewContract(state, recordedActionResult(state));
  const refused = await recordResultEvidence(state, [{ kind: "", ref: "", content: "x" }]);
  assert.equal(refused.ok, false);
  assert.equal(state.resultReview?.evidence, undefined);
});

// ---------------------------------------------------------------------------
// Isolation: prefix, reuse, and no caller-selectable target.
// ---------------------------------------------------------------------------

test("isolation: a non-smoke Work id is refused before the runner is touched", async () => {
  const harness = makeHarness();
  const report = await runResultGateSmoke(fakeEnv(), "df99c0e2-e522-4853-a994-51fae8dd2f06", harness.runner);
  assert.equal(report.ok, false);
  assert.equal(report.harness_execution, "refused");
  assert.equal(report.result_gate, "no_usable_verdict");
  assert.match(report.refusal ?? "", /result-gate-smoke-/);
  assert.equal(harness.ensureCalls.length, 0);
  assert.equal(harness.runCalls.length, 0);
  assert.equal(harness.state(), undefined, "no Work exists");
});

test("isolation: a malformed smoke Work id is refused too", async () => {
  const harness = makeHarness();
  const report = await runResultGateSmoke(fakeEnv(), `${RESULT_GATE_SMOKE_WORK_ID_PREFIX}nope`, harness.runner);
  assert.equal(report.ok, false);
  assert.match(report.refusal ?? "", /result-gate-smoke-/);
  assert.equal(harness.ensureCalls.length, 0);
});

test("isolation: an existing Work is never reused or overwritten", async () => {
  const harness = makeHarness({ existing: true });
  const before = structuredClone(harness.state()!);

  const report = await runResultGateSmoke(fakeEnv(), WORK_ID, harness.runner);

  assert.equal(report.ok, false);
  assert.match(report.refusal ?? "", /already exists/);
  assert.match(report.refusal ?? "", /refuses to reuse or overwrite/);
  assert.deepEqual(harness.ensureCalls, [{ workId: WORK_ID, chatId: MARTIN_CHAT }]);
  assert.equal(harness.runCalls.length, 0, "the existing Work is never advanced");
  assert.deepEqual(harness.state(), before, "the existing Work's state is untouched");
  assert.equal(report.verification, null);
  assert.equal(report.approval, null);
  assert.equal(report.work_closed, false);
});

test("isolation: a second run under a fresh id is independent of the first", async () => {
  const first = makeHarness();
  const firstReport = await runResultGateSmoke(fakeEnv(), newResultGateSmokeWorkId(), first.runner);
  assert.equal(firstReport.ok, true, firstReport.refusal ?? "");

  const second = makeHarness();
  const secondId = newResultGateSmokeWorkId();
  const secondReport = await runResultGateSmoke(fakeEnv(), secondId, second.runner);
  assert.equal(secondReport.ok, true, secondReport.refusal ?? "");
  assert.notEqual(firstReport.work_id, secondReport.work_id, "each run gets a fresh Work id");
  assert.equal(first.ensureCalls.length, 1);
  assert.equal(second.ensureCalls.length, 1);
  assert.notEqual(first.ensureCalls[0].workId, second.ensureCalls[0].workId);
});

// ---------------------------------------------------------------------------
// No business handler, no Tool operation, no direct verifier call.
// ---------------------------------------------------------------------------

test("isolation: the runner exposes only the two seams -- creation and execute; there is no close seam", () => {
  const harness = makeHarness();
  assert.deepEqual(Object.keys(harness.runner).sort(), ["ensureGovernedWork", "runWithWorkPersistence"]);
  assert.equal("closeGovernedWork" in harness.runner, false, "the harness must never be able to close its own Work");
});

test("isolation: the harness core imports no verifier, no Telegram sender, no Notion writer, no Tool registry and no dispatch", () => {
  const source = read("runtime/resultGateSmoke.ts");
  const importSpecifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(importSpecifiers.length >= 8, "the module does import things -- the scan is meaningful");

  const forbidden = [
    "resultVerification",
    "telegram",
    "notion",
    "toolRegistry",
    "dispatch",
    "checkHandoffs",
    "handoffWriter",
    "./log",
    "../log",
    "googleDocsSmoke",
    "access",
  ];
  for (const specifier of importSpecifiers) {
    for (const token of forbidden) {
      assert.ok(!specifier.includes(token), `the core must not import "${specifier}" (it contains "${token}")`);
    }
  }
  assert.ok(!source.includes("runMachineryResultVerification("), "the core never calls the verifier");
  assert.ok(!source.includes("recordCheckerVerdict"), "the core never writes a Checker verdict");
  assert.ok(!source.includes("stageResultReviewApproval("), "the core never stages an approval");
  assert.ok(!source.includes("sendMessage"), "the core never sends a message itself");
  assert.ok(!source.includes("invokeTool"), "the core never invokes a Tool operation");
});

test("isolation: the WorkSession's smoke method drives init + execute and nothing else", () => {
  const session = read("session.ts");
  const signature = "async runResultGateSmoke(workId: string): Promise<ResultGateSmokeReport> {";
  const start = session.indexOf(signature);
  assert.ok(start >= 0, "the Durable Object exposes the harness entry");
  const rest = session.slice(start + signature.length);
  const end = rest.search(/\n  (?:async |private |protected )/);
  const body = end === -1 ? rest : rest.slice(0, end);

  assert.ok(body.includes("this.getState()"), "reuse is checked before anything is created");
  assert.ok(body.includes("this.init("), "the Work is created through the normal creation seam");
  assert.ok(body.includes("actionName: RESULT_GATE_SMOKE_TARGET.action"), "the test-only Action is recorded on the Work");
  assert.ok(body.includes("this.execute(fn)"), "the Work advances through the normal execute/save cycle");

  for (const forbidden of [
    "runMachineryResultVerification",
    "recordCheckerVerdict",
    "stageResultReviewApproval",
    "applyResultReviewGate",
    "invokeTool",
    "dispatchAction",
    "cancel(",
  ]) {
    assert.ok(!body.includes(forbidden), `the smoke method must never call ${forbidden}`);
  }
});

test("wiring: save() is the one place the Machinery Worker verification is triggered, before the gate", () => {
  const session = read("session.ts");
  assert.equal((session.match(/runMachineryResultVerification\(/g) ?? []).length, 1, "exactly one trigger -- WorkSession.save()");
  assert.equal((session.match(/recordCheckerVerdict\(/g) ?? []).length, 0, "session.ts never writes a verdict directly");

  const saveAt = session.indexOf("private async save(state: WorkState)");
  assert.ok(saveAt > -1);
  const verificationAt = session.indexOf("runMachineryResultVerification(", saveAt);
  const gateAt = session.indexOf("applyResultReviewGate(", saveAt);
  assert.ok(verificationAt > -1 && gateAt > -1 && verificationAt < gateAt, "verification runs before the gate on every save");
});

test("wiring: the approval card for a smoke Work is marked TEST ONLY", () => {
  const session = read("session.ts");
  assert.ok(session.includes("isResultGateSmokeWorkId(state.workId)"), "the card marks exactly the harness Works");
  assert.ok(session.includes("TEST ONLY"), "the approval request is clearly marked as a test");
  assert.equal((session.match(/TEST ONLY/g) ?? []).length, 1, "one marker, on the one Result approval card");
});

// ---------------------------------------------------------------------------
// Ordinary entry paths cannot reach the test Action.
// ---------------------------------------------------------------------------

test("isolation: no ordinary intake, dispatch, Handoff or routing path names the test Action or its origin", () => {
  const files = allTypeScriptFiles();

  const actionAllowlist = new Set([
    "units/businessDevelopment/businessDevelopmentManifest.ts",
    "resultGateSmoke.ts",
    "runtime/resultGateSmoke.ts",
    "runtime/resolution.test.ts",
    "runtime/resultGateSmoke.test.ts",
    "resultGateSmokeRoute.test.ts",
  ]);
  const actionOffenders = files.filter((f) => f.text.includes(RESULT_GATE_SMOKE_ACTION) && !actionAllowlist.has(f.rel)).map((f) => f.rel);
  assert.deepEqual(actionOffenders, [], "only the manifest, the harness and their tests may name the test Action");

  // The quoted origin literal (a bare `result_gate_smoke_test` also contains
  // `result_gate_smoke`, so the quotes make the origin check exact).
  const originAllowlist = new Set([
    "runtime/workContract.ts",
    "units/businessDevelopment/businessDevelopmentManifest.ts",
    "runtime/resolution.test.ts",
    "runtime/resultGateSmoke.ts",
    "runtime/resultGateSmoke.test.ts",
    "resultGateSmokeRoute.test.ts",
  ]);
  const originOffenders = files.filter((f) => f.text.includes('"result_gate_smoke"') && !originAllowlist.has(f.rel)).map((f) => f.rel);
  assert.deepEqual(originOffenders, [], "only WorkOrigin, the manifest declaration, Resolution and the harness may name the special origin");

  for (const file of [
    "router.ts",
    "index.ts",
    "session.ts",
    "checkHandoffs.ts",
    "workContinuation.ts",
    "units/dispatch.ts",
    "hats/actionRegistry.ts",
    "units/unitManifest.ts",
    "handoffWriter.ts",
    "sessionRouting.ts",
  ]) {
    const source = files.find((f) => f.rel === file);
    assert.ok(source, `${file} exists`);
    assert.ok(!source!.text.includes(RESULT_GATE_SMOKE_ACTION), `${file} must not name the test Action`);
    assert.ok(!source!.text.includes('"result_gate_smoke"'), `${file} must not name the smoke origin`);
  }
});

test("isolation: the ordinary Resolution boundary still refuses the test Action under every normal origin", async () => {
  // The full matrix lives in runtime/resolution.test.ts (Task 1); this pins
  // that those tests are still present and that the special origin is the
  // only one that resolves it.
  const resolutionTests = read("runtime/resolution.test.ts");
  assert.ok(resolutionTests.includes("normal origins cannot resolve the test-only Action"));
  assert.ok(resolutionTests.includes("special origin resolves only the exact intended Action"));
  for (const origin of ["direct_request", "handoff_pickup", "lifecycle_transition"]) {
    assert.ok(resolutionTests.includes(`"${origin}"`) || resolutionTests.includes(`"${origin}",`), `${origin} is covered`);
  }
});

test("isolation: the test-only Action declares no Tool operation and no Skill requirement", () => {
  const manifest = findUnitManifest("Business Development")!;
  const action = manifest.hats[HAT].actions.find((a) => a.name === RESULT_GATE_SMOKE_ACTION);
  assert.ok(action, "the Action is registered on the manifest");
  assert.equal(action!.tool_operations, undefined, "no Tool operation is declared");
  assert.equal(action!.skill_requirements, undefined, "no Skill requirement is declared");
  assert.equal(action!.consequence, "internal");
  assert.equal(action!.requiresApproval, false);
  assert.ok(action!.expectedResult && action!.completionCriteria?.length, "the Result contract is declared on the manifest");
});
