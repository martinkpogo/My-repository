import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { Env, ExternalToolOperationRecord, WorkState } from "../../types";
import { operationRecordKey } from "../toolRegistry";
import { installStatePersistence } from "../workPersistence";
import {
  GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX,
  GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX,
  googleDocsSmokeInput,
  runGoogleDocsSmoke,
  type GoogleDocsSmokeResult,
  type GoogleDocsSmokeWorkRunner,
} from "./googleDocsSmoke";

/**
 * The governed Google Docs smoke contract (LOG-1069), proven at its own
 * boundary: every pre-flight gate refuses before any Work exists or any
 * Google request is made; the invocation itself is the Registry's unchanged
 * one (a non-declaring Action is denied with ZERO Drive mutations); the
 * disposable folder is the exact bound target and the production proposal
 * folder is never read; durable intent/outcome records land around the
 * effect; the five canonical outcomes and the reconciliation paths surface
 * exactly as the Registry produces them; and the smoke Work is closed only
 * on a clean terminal end.
 *
 * Every Google interaction here is a scripted fetch fake with call counters
 * -- no real Google document is ever created -- and every denial/blocked
 * assertion checks ZERO Drive mutation calls.
 */

const WORK_ID = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}abcd1234-5678-90ef-ghij-klmnopqrstuv`;
const ACCOUNT = "martin@example.com";
const SMOKE_FOLDER = "folder-smoke-1";
const PRODUCTION_FOLDER = "folder-production-1";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** STATE_KV whose reads are observable, so a test can prove which keys were touched. */
function fakeEnv(seed: Record<string, string> = {}, opts: { readLog?: string[] } = {}) {
  const store = new Map(Object.entries(seed));
  const env = {
    STATE_KV: {
      get: async (key: string) => {
        opts.readLog?.push(key);
        return store.get(key) ?? null;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async ({ prefix }: { prefix?: string } = {}) => ({
        keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
  };
  return env as unknown as Env;
}

function googleAccountSeed(account = ACCOUNT) {
  return {
    [`google_oauth_tokens:${account}`]: JSON.stringify({
      access_token: "tok",
      refresh_token: "r",
      expires_at: Date.now() + 3_600_000,
      updated_at: "now",
    }),
  };
}

/** Configured runtime state: the disposable smoke folder AND the production proposal folder (which the smoke must never read or write). */
function configuredEnv(opts: { readLog?: string[]; accounts?: string[] } = {}) {
  const accounts = opts.accounts ?? [ACCOUNT];
  const seed: Record<string, string> = {
    ...Object.assign({}, ...accounts.map(googleAccountSeed)),
    [`${GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX}:${ACCOUNT}`]: SMOKE_FOLDER,
    [`google_proposal_docs_folder:${ACCOUNT}`]: PRODUCTION_FOLDER,
  };
  return fakeEnv(seed, opts);
}

function smokeState(workId = WORK_ID, overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId,
    chatId: 0,
    unit: "Sales",
    hat: "Sales Executive",
    actionName: "proposal_draft",
    stage: "new",
    ...overrides,
  } as unknown as WorkState;
}

interface RunnerHarness {
  runner: GoogleDocsSmokeWorkRunner;
  ensureCalls: string[];
  closes: string[];
  flushes: Record<string, ExternalToolOperationRecord>[];
  setEnsureResult: (result: { ok: true } | { ok: false; reason: string }) => void;
}

function smokeRunner(state: WorkState, records: Record<string, ExternalToolOperationRecord> = {}): RunnerHarness {
  const ensureCalls: string[] = [];
  const closes: string[] = [];
  const flushes: Record<string, ExternalToolOperationRecord>[] = [];
  let ensureResult: { ok: true } | { ok: false; reason: string } = { ok: true };
  return {
    ensureCalls,
    closes,
    flushes,
    setEnsureResult: (result) => {
      ensureResult = result;
    },
    runner: {
      ensureGovernedWork: async (id: string) => {
        ensureCalls.push(id);
        return ensureResult;
      },
      runWithWorkPersistence: async (id: string, fn: (s: WorkState) => Promise<WorkState>) => {
        const installed = installStatePersistence(id, records, async () => {
          flushes.push(JSON.parse(JSON.stringify(records)) as Record<string, ExternalToolOperationRecord>);
        });
        try {
          return await fn(state);
        } finally {
          installed.release();
        }
      },
      closeGovernedWork: async (id: string) => {
        closes.push(id);
      },
    },
  };
}

interface GoogleCall {
  url: string;
  method: string;
  body?: any;
}

const REAL_FETCH = globalThis.fetch;

/** Scripts googleapis.com endpoints, counts every call, and swallows everything else (logActivity's Activity-Log write is best effort by design). */
function installGoogleFake(t: any, handler: (call: GoogleCall) => Response | Promise<Response>) {
  const calls: GoogleCall[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (!u.includes("googleapis.com")) {
      return new Response("{}", { status: 200 });
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url: u, method, body };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return { calls };
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

const driveCreates = (calls: GoogleCall[]) => calls.filter((c) => c.url.endsWith("/drive/v3/files") && c.method === "POST");

/** The happy document server: remembers what was created (title, text, folder) so read-backs and reconciliation searches verify against it. */
function docServer(initial?: { title?: string; text?: string; folder?: string }) {
  let title = initial?.title ?? "";
  let text = initial?.text ?? "";
  let folder = initial?.folder ?? "";
  return {
    get created() {
      return { title, text, folder };
    },
    handle(call: GoogleCall): Response {
      const { url, method, body } = call;
      if (url.includes("/oauth2/token")) return json({ access_token: "fresh", refresh_token: "r", expires_in: 3600 });
      if (url.endsWith("/drive/v3/files") && method === "POST") {
        title = body.name;
        folder = body.parents?.[0] ?? "";
        return json({ id: "doc-smoke-1" });
      }
      if (url.includes("/drive/v3/files") && method === "GET") {
        // The reconcile-by-title search (its URL carries a query string): the interrupted attempt's only identity.
        const found = title && folder ? [{ id: "doc-smoke-1", name: title }] : [];
        return json({ files: found });
      }
      if (url.includes(":batchUpdate")) {
        text = body.requests?.[0]?.insertText?.text ?? "";
        return json({});
      }
      if (url.includes("/documents/doc-smoke-1") && method === "GET") {
        return json({ title, body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } });
      }
      throw new Error(`Unexpected Google call: ${method} ${url}`);
    },
  };
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

// ---------------------------------------------------------------------------
// Pre-flight gates -- every one refuses before any Work exists or any
// Google request is made.
// ---------------------------------------------------------------------------

test("a non-smoke Work id is refused before any configuration read, Work, or request", async (t: any) => {
  const readLog: string[] = [];
  const env = configuredEnv({ readLog });
  const harness = smokeRunner(smokeState("df99c0e2-e522-4853-a994-51fae8dd2f06"));
  const { calls } = installGoogleFake(t, () => json({}));

  const result = await runGoogleDocsSmoke(env, "df99c0e2-e522-4853-a994-51fae8dd2f06", harness.runner);

  assert.equal(result.outcome, null);
  assert.match(result.blocked_reason ?? "", /smoke-googledocs-/);
  assert.equal(result.work_closed, false);
  assert.equal(harness.ensureCalls.length, 0);
  assert.equal(readLog.length, 0);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// `node:test`'s per-test context threads through `installGoogleFake` for
// fetch restoration; the pre-flight gates below assert zero calls anyway.
// ---------------------------------------------------------------------------

test("no authorized Google account blocks the smoke before any Work or request", async (t: any) => {
  const env = fakeEnv({
    [`${GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX}:${ACCOUNT}`]: SMOKE_FOLDER,
  });
  const harness = smokeRunner(smokeState());
  const { calls } = installGoogleFake(t, () => json({}));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome, null);
  assert.match(result.blocked_reason ?? "", /no Google account is authorized/);
  assert.equal(harness.ensureCalls.length, 0);
  assert.equal(calls.length, 0);
});

test("more than one authorized account blocks the smoke -- it never guesses which to use", async (t: any) => {
  const env = configuredEnv({ accounts: [ACCOUNT, "second@example.com"] });
  const harness = smokeRunner(smokeState());
  const { calls } = installGoogleFake(t, () => json({}));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome, null);
  assert.match(result.blocked_reason ?? "", /2 Google accounts are authorized/);
  assert.equal(harness.ensureCalls.length, 0);
  assert.equal(calls.length, 0);
});

test("a missing disposable folder configuration blocks before any Work or Drive request, and the production folder is never read", async (t: any) => {
  const readLog: string[] = [];
  const env = fakeEnv(
    {
      ...googleAccountSeed(),
      // The PRODUCTION folder is configured -- its presence must never be
      // mistaken for the smoke's own missing configuration.
      [`google_proposal_docs_folder:${ACCOUNT}`]: PRODUCTION_FOLDER,
    },
    { readLog },
  );
  const harness = smokeRunner(smokeState());
  const { calls } = installGoogleFake(t, () => json({}));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome, null);
  assert.match(result.blocked_reason ?? "", /google_smoke_test_folder:martin@example\.com/);
  assert.equal(harness.ensureCalls.length, 0);
  assert.equal(calls.length, 0);
  assert.ok(!readLog.includes(`google_proposal_docs_folder:${ACCOUNT}`), "the production proposal folder must never be read");
});

test("a Work that cannot be established (already exists) blocks with the runner's exact reason and no request", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState());
  harness.setEnsureResult({ ok: false, reason: "Work already exists -- refusing to re-initialize." });
  const { calls } = installGoogleFake(t, () => json({}));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome, null);
  assert.equal(result.blocked_reason, "Work already exists -- refusing to re-initialize.");
  assert.equal(harness.ensureCalls.length, 1);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The Authorization boundary at the invocation itself.
// ---------------------------------------------------------------------------

test("an Action that does not declare the operation is denied with ZERO Drive mutations, and the clean denial closes the Work", async (t: any) => {
  const env = configuredEnv();
  // create_entity is a declared Sales Executive WRITE Action -- but it
  // declares no Tool operations, so Access must refuse before any request.
  const harness = smokeRunner(smokeState(WORK_ID, { actionName: "create_entity" }));
  const { calls } = installGoogleFake(t, () => json({}));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "denied");
  assert.match(result.outcome?.reason ?? "", /does not declare Tool operation google_docs\.create_and_verify/);
  assert.equal(driveCreates(calls).length, 0);
  assert.deepEqual(harness.closes, [WORK_ID], "a denial proved no remote effect, so the smoke Work closes cleanly");
  assert.equal(result.work_closed, true);
});

// ---------------------------------------------------------------------------
// The happy path: disposable target binding, durable records, read-back.
// ---------------------------------------------------------------------------

test("create-and-verify succeeds through the Registry against the disposable folder, with durable records and read-back verification", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState());
  const server = docServer();
  installGoogleFake(t, (call) => server.handle(call));

  const result: GoogleDocsSmokeResult = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.work_id, WORK_ID);
  assert.equal(result.outcome?.state, "succeeded");
  assert.equal(result.outcome?.verified, true);
  assert.equal(result.outcome?.remote_resource?.document_id, "doc-smoke-1");
  assert.match(result.outcome?.remote_resource?.url ?? "", /doc-smoke-1/);
  assert.equal(result.work_closed, true);
  assert.deepEqual(harness.closes, [WORK_ID]);

  // Target binding: the disposable folder is the EXACT parent, and the
  // production folder appears nowhere in the traffic.
  assert.equal(server.created.folder, SMOKE_FOLDER);
  assert.ok(!JSON.stringify(result).includes(PRODUCTION_FOLDER));

  // Durable records: the intent landed in_progress BEFORE the effect, and
  // the terminal outcome landed after -- in the Work's own record store.
  const recordKey = operationRecordKey("google_docs.create_and_verify", `gdrive:folder:${SMOKE_FOLDER}`, googleDocsSmokeInput(WORK_ID, SMOKE_FOLDER, ACCOUNT));
  assert.equal(harness.flushes.length >= 2, true, "intent and outcome must each be flushed durably");
  assert.equal(harness.flushes[0][recordKey]?.status, "in_progress");
  assert.equal(harness.flushes[harness.flushes.length - 1][recordKey]?.status, "succeeded");
});

test("the production proposal folder is never read from runtime state during a successful smoke", async (t: any) => {
  const readLog: string[] = [];
  const env = configuredEnv({ readLog });
  const harness = smokeRunner(smokeState());
  const server = docServer();
  installGoogleFake(t, (call) => server.handle(call));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "succeeded");
  assert.ok(!readLog.includes(`google_proposal_docs_folder:${ACCOUNT}`), "the production proposal folder must never be read");
  assert.ok(readLog.includes(`${GOOGLE_DOCS_SMOKE_FOLDER_KEY_PREFIX}:${ACCOUNT}`));
});

// ---------------------------------------------------------------------------
// Failure, partial, and uncertain outcomes -- each keeps its honest shape
// and leaves the smoke Work OPEN with its durable record intact.
// ---------------------------------------------------------------------------

test("a definite creation failure (Google rejected the request) is reported failed and keeps the Work open", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState());
  installGoogleFake(t, (call) => {
    if (call.url.endsWith("/drive/v3/files") && call.method === "POST") return json({ error: "no" }, 500);
    return docServer().handle(call);
  });

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "failed");
  assert.match(result.outcome?.reason ?? "", /HTTP 500/);
  assert.equal(result.work_closed, false);
  assert.deepEqual(harness.closes, []);
});

test("an uncertain creation outcome (network error after the request may have left) is reported unverified, never as failure", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState());
  installGoogleFake(t, (call) => {
    if (call.url.endsWith("/drive/v3/files") && call.method === "POST") throw new Error("socket hang up");
    return docServer().handle(call);
  });

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "unverified");
  assert.equal(result.outcome?.reconciliation_required, true);
  assert.equal(result.work_closed, false);
  assert.deepEqual(harness.closes, []);
});

test("a creation answered without a usable document id is reported partially_completed and keeps the Work open", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState());
  installGoogleFake(t, (call) => {
    if (call.url.endsWith("/drive/v3/files") && call.method === "POST") return json({});
    return docServer().handle(call);
  });

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "partially_completed");
  assert.equal(result.outcome?.reconciliation_required, true);
  assert.equal(result.work_closed, false);
});

// ---------------------------------------------------------------------------
// Retry reconciliation -- an interrupted attempt is settled against the
// provider; a fresh duplicate creation never runs.
// ---------------------------------------------------------------------------

function inProgressSeed(): Record<string, ExternalToolOperationRecord> {
  const input = googleDocsSmokeInput(WORK_ID, SMOKE_FOLDER, ACCOUNT);
  return {
    [operationRecordKey("google_docs.create_and_verify", `gdrive:folder:${SMOKE_FOLDER}`, input)]: {
      work_id: WORK_ID,
      tool_id: "google_docs",
      operation_id: "google_docs.create_and_verify",
      version: "1.0",
      target_resource_id: `gdrive:folder:${SMOKE_FOLDER}`,
      status: "in_progress",
      updatedAt: new Date().toISOString(),
    },
  };
}

test("retry reconciliation: an interrupted attempt that already created the doc is verified WITHOUT a second creation", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState(), inProgressSeed());
  const input = googleDocsSmokeInput(WORK_ID, SMOKE_FOLDER, ACCOUNT);
  // The remote world left by the interrupted attempt: the doc exists in the
  // disposable folder, holding exactly the requested content.
  const server = docServer({ title: input.title, text: input.content, folder: SMOKE_FOLDER });
  const { calls } = installGoogleFake(t, (call) => server.handle(call));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "succeeded");
  assert.match(result.outcome?.reason ?? "", /reconciled/);
  assert.equal(driveCreates(calls).length, 0, "a verified existing effect must never be created again");
  assert.equal(result.work_closed, true);
});

test("reconciliation of an interrupted attempt whose document holds different content reports partially_completed and never recreates", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState(), inProgressSeed());
  const server = docServer({ title: "ENIG-REGISTRY-SMOKE-ABCD1234", text: "some other content entirely", folder: SMOKE_FOLDER });
  const { calls } = installGoogleFake(t, (call) => server.handle(call));

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "partially_completed");
  assert.equal(result.outcome?.reconciliation_required, true);
  assert.equal(driveCreates(calls).length, 0, "a mismatched existing document must be reconciled, never recreated");
  assert.equal(result.work_closed, false);
});

test("reconciliation uncertainty (the search itself fails) is held unverified and never becomes a fresh creation", async (t: any) => {
  const env = configuredEnv();
  const harness = smokeRunner(smokeState(), inProgressSeed());
  const { calls } = installGoogleFake(t, (call) => {
    if (call.url.includes("/drive/v3/files") && call.method === "GET") return json({ error: "boom" }, 500);
    return docServer().handle(call);
  });

  const result = await runGoogleDocsSmoke(env, WORK_ID, harness.runner);

  assert.equal(result.outcome?.state, "unverified");
  assert.equal(result.outcome?.reconciliation_required, true);
  assert.equal(driveCreates(calls).length, 0, "an unreadable remote state must never trigger a blind retry");
  assert.equal(result.work_closed, false);
});
