import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { Env, WorkState } from "./types";
import { handleGoogleAccountSelection, handleGoogleActionApproval, handleGoogleFolderSelection, saveOpaqueOption } from "./googleOAuth";
import { getActiveWorkId } from "./sessionRouting";
import { confirmGoogleDocsSmoke, startGoogleDocsSmokeFlow, type GoogleDocsSmokeConfirmSeams } from "./googleDocsSmokeFlow";
import { GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX } from "./runtime/tools/googleDocsSmoke";

/**
 * The interactive Telegram Google Docs Tool Registry SMOKE flow (LOG-1069),
 * proven at its own boundary:
 *
 *  - initiation stages only smoke-flagged picker options on a fresh
 *    GOVERNED smoke Work (Sales / Sales Executive / proposal_draft, recorded
 *    at creation) and needs NO pre-configured folder key;
 *  - the existing account/folder pickers are reused verbatim, carrying the
 *    `smoke: true` discriminator through every staged option and the Work's
 *    `pendingSmokeSelection`, with the normal creation path provably
 *    untouched when the flag is absent;
 *  - the confirmation is a separate `googlesmokeconfirm:` callback that
 *    validates Work identity, pending selection, and staged option against
 *    each other before running EXACTLY ONE registered invocation through
 *    the shared smoke core -- stale, mismatched, and wrong-kind inputs all
 *    fail closed with ZERO Google requests;
 *  - cancel and every refusal create nothing; an uncertain outcome keeps
 *    the Work open with its durable records and clears the confirmation so
 *    it can never be blindly replayed;
 *  - every `callback_data` the flow can stage or emit obeys Telegram's
 *    64-UTF-8-byte inline-keyboard limit, which the bounded smoke Work id
 *    exists to guarantee (a full UUID overflowed it and both live picker
 *    sends were refused with HTTP 400 BUTTON_DATA_INVALID).
 *
 * Every Google interaction is a scripted fetch fake with call counters --
 * no real Google document is ever created -- and every refusal asserts
 * ZERO Drive mutation calls.
 */

const ACCOUNT = "martin@example.com";
const SECOND_ACCOUNT = "second@example.com";
const FOLDER_ID = "folder-disposable-1";
const FOLDER_NAME = "Smoke Disposable Folder";

// ---------------------------------------------------------------------------
// Fixtures (mirror googleDocsSmoke.test.ts's, plus Telegram + DO stubs).
// ---------------------------------------------------------------------------

function fakeEnv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const inits: any[][] = [];
  const env = {
    TELEGRAM_GROUP_CHAT_ID: "111",
    WORKSPACE_TOPIC_ID: "222",
    BOT_TOKEN: "test-token",
    STATE_KV: {
      get: async (key: string) => store.get(key) ?? null,
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
    WORK_SESSION: {
      idFromName: (id: string) => id,
      get: () => ({
        init: async (...args: any[]) => {
          inits.push(args);
        },
      }),
    },
  };
  const envOut = env as unknown as Env;
  (envOut as any).__store = store;
  (envOut as any).__inits = inits;
  return envOut;
}

function googleAccountSeed(account: string) {
  return {
    [`google_oauth_tokens:${account}`]: JSON.stringify({
      access_token: "tok",
      refresh_token: "r",
      expires_at: Date.now() + 3_600_000,
      updated_at: "now",
    }),
  };
}

function smokeState(workId: string, overrides: Partial<WorkState> = {}): WorkState {
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

interface GoogleCall {
  url: string;
  method: string;
  body?: any;
}

const REAL_FETCH = globalThis.fetch;

/** Scripts googleapis.com endpoints, captures Telegram sends for text/button assertions, and swallows everything else. */
function installFake(t: any, handler: (call: GoogleCall) => Response | Promise<Response>) {
  const calls: GoogleCall[] = [];
  const telegram: GoogleCall[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("googleapis.com")) {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const call = { url: u, method, body };
      calls.push(call);
      return await handler(call);
    }
    if (u.includes("api.telegram.org")) {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      telegram.push({ url: u, method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return { calls, telegram };
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

const driveCreates = (calls: GoogleCall[]) => calls.filter((c) => c.url.endsWith("/drive/v3/files") && c.method === "POST");

const telegramTexts = (telegram: GoogleCall[]) => telegram.map((c) => String(c.body?.text ?? "")).join("\n");

const callbackDatas = (telegram: GoogleCall[]) =>
  telegram.flatMap((c) => (c.body?.reply_markup?.inline_keyboard ?? []).flatMap((row: any[]) => row.map((b: any) => String(b.callback_data))));

/** The happy document server (same shape as googleDocsSmoke.test.ts's). */
function docServer() {
  let title = "";
  let text = "";
  let folder = "";
  return {
    get created() {
      return { title, text, folder };
    },
    handle(call: GoogleCall): Response {
      const { url, method, body } = call;
      if (url.endsWith("/drive/v3/files") && method === "POST") {
        title = body.name;
        folder = body.parents?.[0] ?? "";
        return json({ id: "doc-smoke-1" });
      }
      if (url.includes("/drive/v3/files") && method === "GET") {
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

/** DO-side seams for confirmGoogleDocsSmoke: one state object, real durable-persistence installation, observable completes. */
function fakeSeams(state: WorkState) {
  const completes: string[] = [];
  const records: Record<string, unknown> = {};
  const seams: GoogleDocsSmokeConfirmSeams = {
    runExclusive: async (workId: string, fn: (s: WorkState) => Promise<WorkState>) => {
      const { installStatePersistence } = await import("./runtime/workPersistence");
      const installed = installStatePersistence(workId, records as any, async () => {});
      try {
        const next = await fn(state);
        Object.assign(state, next);
        return state;
      } finally {
        installed.release();
      }
    },
    markComplete: async (workId: string) => {
      completes.push(workId);
      state.stage = "complete";
      state.pendingSmokeSelection = undefined;
    },
  };
  return { seams, completes, records };
}

/** Stages a picker option exactly as the flow's own handlers do. */
async function stageOption(env: Env, workId: string, data: Record<string, unknown>): Promise<string> {
  return saveOpaqueOption(env, workId, data);
}

function store(env: Env): Map<string, string> {
  return (env as any).__store;
}

function inits(env: Env): any[][] {
  return (env as any).__inits;
}

const optionKeys = (env: Env, workId: string) => [...store(env).keys()].filter((k) => k.startsWith(`google_option:${workId}:`));

const stagedOptions = (env: Env, workId: string) =>
  optionKeys(env, workId).map((k) => JSON.parse(store(env).get(k) as string));

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

// ---------------------------------------------------------------------------
// Initiation: a fresh GOVERNED smoke Work, only smoke-flagged options, no
// configuration dependency, no Google request.
// ---------------------------------------------------------------------------

test("initiation stages smoke-flagged account options on a fresh governed smoke Work, with no folder configuration needed", async (t: any) => {
  // Deliberately NO google_smoke_test_folder key: the interactive flow must
  // not depend on manually configured runtime state.
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT), ...googleAccountSeed(SECOND_ACCOUNT) });
  const { calls, telegram } = installFake(t, () => json({}));

  await startGoogleDocsSmokeFlow(env, 111, 222);

  // A governed Work, recorded with its Action at creation.
  const initArgs = inits(env)[0];
  assert.ok(initArgs, "the flow must create its Work through the session DO");
  const [workId, chatId, unit, hat, threadId, extra] = initArgs;
  assert.ok(String(workId).startsWith(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX));
  assert.equal(chatId, 111);
  assert.equal(unit, "Sales");
  assert.equal(hat, "Sales Executive");
  assert.equal(threadId, 222);
  assert.equal(extra?.actionName, "proposal_draft");

  // The staged options carry the smoke discriminator and nothing else.
  const options = stagedOptions(env, workId);
  assert.equal(options.length, 2, "every authorized account gets one option");
  for (const option of options) {
    assert.equal(option.kind, "account");
    assert.equal(option.smoke, true);
    assert.equal(option.title, undefined, "the smoke flow stages no document content");
  }
  for (const account of [ACCOUNT, SECOND_ACCOUNT]) {
    assert.ok(options.some((o: any) => o.accountIdentifier === account), `no account may be assumed -- both must be offered (${account})`);
  }

  // The picker buttons use the SHARED account callback, so the existing
  // selection handler runs unchanged.
  assert.ok(callbackDatas(telegram).every((d) => d.startsWith(`googleaccount:${workId}:`)));

  // Active pointer set for resume; no Drive traffic; no smoke-folder config touched.
  assert.equal(await getActiveWorkId(env, 111, 222), workId);
  assert.equal(calls.length, 0);
  assert.ok(![...store(env).keys()].some((k) => k.startsWith("google_smoke_test_folder")), "the interactive flow needs no pre-configured folder key");
});

test("initiation with no authorized Google account refuses before creating any Work or making any request", async (t: any) => {
  const env = fakeEnv({});
  const { calls, telegram } = installFake(t, () => json({}));

  await startGoogleDocsSmokeFlow(env, 111, 222);

  assert.equal(inits(env).length, 0, "no Work may exist without an account to run under");
  assert.match(telegramTexts(telegram), /no Google account is authorized/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Account selection: the shared picker reused, smoke-discriminated.
// ---------------------------------------------------------------------------

test("smoke account selection stages smoke-flagged folder options with no creation buttons and no pending action", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w1`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT), ...googleAccountSeed(SECOND_ACCOUNT) });
  const state = smokeState(workId);
  const { calls, telegram } = installFake(t, (call) => {
    if (call.url.includes("/drive/v3/files")) return json({ files: [{ id: FOLDER_ID, name: FOLDER_NAME }] });
    return json({});
  });

  const opaqueId = await stageOption(env, workId, { kind: "account", smoke: true, accountIdentifier: ACCOUNT });
  const next = await handleGoogleAccountSelection(env, state, opaqueId);

  // Folder options carry the discriminator forward and drop all creation payload.
  const folderOptions = stagedOptions(env, workId).filter((o: any) => o.kind === "folder");
  assert.equal(folderOptions.length, 1);
  assert.equal(folderOptions[0].smoke, true);
  assert.equal(folderOptions[0].folderId, FOLDER_ID);
  assert.equal(folderOptions[0].title, undefined);
  assert.equal(folderOptions[0].content, undefined);
  assert.equal(folderOptions[0].docType, undefined);

  // Nothing of the creation path appears: no googleaction buttons, no
  // pendingGoogleAction, no Drive mutation.
  assert.ok(callbackDatas(telegram).every((d) => d.startsWith(`googlefolder:${workId}:`)));
  assert.equal(next.pendingGoogleAction, undefined);
  assert.equal(driveCreates(calls).length, 0);
  assert.match(telegramTexts(telegram), /GOVERNED TOOL REGISTRY SMOKE/);
});

test("normal account selection regression: without the smoke flag the staged folder options carry the creation payload unchanged", async (t: any) => {
  const workId = "df99c0e2-e522-4853-a994-51fae8dd2f06";
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { unit: undefined, hat: undefined, actionName: undefined });
  const { calls } = installFake(t, (call) => {
    if (call.url.includes("/drive/v3/files")) return json({ files: [{ id: FOLDER_ID, name: FOLDER_NAME }] });
    return json({});
  });

  const opaqueId = await stageOption(env, workId, { kind: "account", accountIdentifier: ACCOUNT, title: "My Doc", content: "Body text" });
  await handleGoogleAccountSelection(env, state, opaqueId);

  const folderOptions = stagedOptions(env, workId).filter((o: any) => o.kind === "folder");
  assert.equal(folderOptions.length, 1);
  assert.equal(folderOptions[0].smoke, undefined, "the normal path must never see the smoke discriminator");
  assert.equal(folderOptions[0].title, "My Doc");
  assert.equal(folderOptions[0].content, "Body text");
  assert.equal(folderOptions[0].docType, "doc");
  assert.equal(driveCreates(calls).length, 0);
});

// ---------------------------------------------------------------------------
// Folder selection: the explicit confirmation, bound to Work + account + folder.
// ---------------------------------------------------------------------------

test("smoke folder selection records the pending selection and stages only the explicit confirmation", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w2`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId);
  const { calls, telegram } = installFake(t, () => json({}));

  const opaqueId = await stageOption(env, workId, { kind: "folder", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  const next = await handleGoogleFolderSelection(env, state, opaqueId);

  // The discriminator is now ALSO in Work state, bound to this target.
  assert.deepEqual(
    { ...next.pendingSmokeSelection, createdAt: undefined },
    { accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME, createdAt: undefined },
  );

  // The normal creation approval is structurally unreachable: no
  // pendingGoogleAction, no googleaction: buttons, no creation message.
  assert.equal(next.pendingGoogleAction, undefined);
  assert.equal(next.pendingActionSummary, undefined);
  const datas = callbackDatas(telegram);
  assert.ok(datas.some((d) => d.startsWith(`googlesmokeconfirm:${workId}:`)), "the confirmation must use its own callback prefix");
  assert.ok(datas.includes(`googlesmokeconfirm:${workId}:cancel`));
  assert.ok(!datas.some((d) => d.startsWith("googleaction:")));

  // The confirmation names the exact account + folder.
  assert.match(telegramTexts(telegram), new RegExp(ACCOUNT));
  assert.match(telegramTexts(telegram), new RegExp(FOLDER_ID));

  // The staged confirm option is bound to the same target and smoke-flagged.
  const confirmOptions = stagedOptions(env, workId).filter((o: any) => o.kind === "smoke_confirm");
  assert.equal(confirmOptions.length, 1);
  assert.equal(confirmOptions[0].smoke, true);
  assert.equal(confirmOptions[0].accountIdentifier, ACCOUNT);
  assert.equal(confirmOptions[0].folderId, FOLDER_ID);

  assert.equal(driveCreates(calls).length, 0, "selection alone creates nothing");
});

test("normal folder selection regression: without the smoke flag the approval path is untouched", async (t: any) => {
  const workId = "df99c0e2-e522-4853-a994-51fae8dd2f06";
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { unit: undefined, hat: undefined, actionName: undefined });
  const { calls, telegram } = installFake(t, () => json({}));

  const opaqueId = await stageOption(env, workId, { kind: "folder", docType: "doc", accountIdentifier: ACCOUNT, title: "My Doc", content: "Body", folderId: FOLDER_ID, folderName: FOLDER_NAME });
  const next = await handleGoogleFolderSelection(env, state, opaqueId);

  assert.equal(next.pendingSmokeSelection, undefined, "the normal path must never touch the smoke state");
  assert.equal(next.pendingGoogleAction?.type, "create_doc");
  assert.ok(callbackDatas(telegram).some((d) => d.startsWith(`googleaction:${workId}:`)));
  assert.equal(driveCreates(calls).length, 0);
});

// ---------------------------------------------------------------------------
// Confirmation: Work/target/option agreement gates ONE registered invocation.
// ---------------------------------------------------------------------------

function pendingFixture() {
  return {
    accountIdentifier: ACCOUNT,
    folderId: FOLDER_ID,
    folderName: FOLDER_NAME,
    createdAt: new Date().toISOString(),
  };
}

test("confirmation executes exactly one registered invocation against the confirmed account and folder, then closes the Work", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w3`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const server = docServer();
  const { calls } = installFake(t, (call) => server.handle(call));
  const { seams, completes, records } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  const next = await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  // The Registry ran exactly once, through the shared core, against the
  // confirmed disposable folder -- no pre-configured key was involved.
  assert.equal(driveCreates(calls).length, 1);
  assert.equal(server.created.folder, FOLDER_ID);
  assert.deepEqual(completes, [workId], "a clean success closes the confirmed Work");
  assert.equal(next.stage, "complete");
  assert.equal(next.pendingSmokeSelection, undefined);

  // The durable operation record landed through the Work's persistence.
  assert.ok(Object.keys(records).length > 0, "the invocation must leave its durable operation record");
  assert.ok(
    Object.values(records).some((r: any) => r.status === "succeeded" && r.operation_id === "google_docs.create_and_verify"),
    "the terminal outcome must be recorded on the Work",
  );
});

test("confirmation under an account outside the Worker's authorized set is blocked with zero Drive requests", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w4`;
  // The environment only authorizes ACCOUNT; the pending/confirmed account is different.
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: { ...pendingFixture(), accountIdentifier: "ghost@example.com" } });
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: "ghost@example.com", folderId: FOLDER_ID, folderName: FOLDER_NAME });
  const next = await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.equal(driveCreates(calls).length, 0);
  assert.match(telegramTexts(telegram), /not one of the \d+ account\(s\) this Worker is authorized for/);
  assert.notEqual(next.stage, "complete", "a blocked confirmation must not present itself as a completed smoke");
});

test("a stale confirmation (pending selection already cleared) fails closed without consuming anything or making a request", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w5`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId); // no pendingSmokeSelection
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  const next = await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.match(telegramTexts(telegram), /no pending selection to confirm/);
  assert.equal(driveCreates(calls).length, 0);
  assert.ok(optionKeys(env, workId).length === 1, "the staged option must not be consumed before the Work-state gate");
  assert.notEqual(next.stage, "complete");
});

test("a confirmation that does not match the pending target fails closed with zero requests", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w6`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: ACCOUNT, folderId: "folder-some-other-one", folderName: "Other" });
  await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.match(telegramTexts(telegram), /does not match this Work's pending selection/);
  assert.equal(driveCreates(calls).length, 0);
});

test("a staged option of the wrong kind can never confirm a smoke", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w7`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "folder", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.match(telegramTexts(telegram), /invalid or expired/);
  assert.equal(driveCreates(calls).length, 0);
});

test("a smoke Work that lost its governed Action is refused before consuming the confirmation", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w8`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { actionName: "create_entity", pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.match(telegramTexts(telegram), /does not record the governed smoke Action/);
  assert.equal(driveCreates(calls).length, 0);
  assert.ok(optionKeys(env, workId).length === 1, "the confirmation must not be consumed");
});

test("a non-smoke Work id is refused by the confirmation", async (t: any) => {
  const workId = "df99c0e2-e522-4853-a994-51fae8dd2f06";
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.match(telegramTexts(telegram), /is not a Registry smoke Work/);
  assert.equal(driveCreates(calls).length, 0);
});

test("cancel completes the smoke Work, clears the pending selection, and creates nothing", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}w9`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, () => json({}));
  const { seams } = fakeSeams(state);

  const next = await confirmGoogleDocsSmoke(env, state, "cancel", seams);

  assert.equal(next.stage, "complete");
  assert.equal(next.pendingSmokeSelection, undefined);
  assert.match(telegramTexts(telegram), /cancelled -- nothing was created/);
  assert.equal(calls.length, 0, "cancel must make no request of any kind");
});

test("an unverified outcome keeps the smoke Work open for reconciliation and clears the confirmation so it can never be blindly replayed", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}wa`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, (call) => {
    if (call.url.endsWith("/drive/v3/files") && call.method === "POST") throw new Error("socket hang up");
    if (call.url.includes("/drive/v3/files") && call.method === "GET") return json({ files: [] });
    return json({});
  });
  const { seams } = fakeSeams(state);

  const opaqueId = await stageOption(env, workId, { kind: "smoke_confirm", smoke: true, accountIdentifier: ACCOUNT, folderId: FOLDER_ID, folderName: FOLDER_NAME });
  const next = await confirmGoogleDocsSmoke(env, state, opaqueId, seams);

  assert.equal(driveCreates(calls).length, 1, "exactly ONE attempt ever leaves -- an uncertain outcome must never be retried");
  assert.notEqual(next.stage, "complete", "an uncertain Work stays open with its durable records");
  assert.equal(next.pendingSmokeSelection, undefined, "the consumed confirmation can never be replayed");
  assert.match(telegramTexts(telegram), /UNVERIFIED/);
});

// ---------------------------------------------------------------------------
// Structural fall-through protection: the legacy creation approval is
// unreachable from the smoke Work because pendingGoogleAction is never set.
// ---------------------------------------------------------------------------

test("a stale creation-approval button on a smoke Work cannot create anything", async (t: any) => {
  const workId = `${GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX}wb`;
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const state = smokeState(workId, { pendingSmokeSelection: pendingFixture() });
  const { calls, telegram } = installFake(t, () => json({}));

  const next = await handleGoogleActionApproval(env, state, true);

  assert.match(telegramTexts(telegram), /No valid pending Google action found/);
  assert.equal(driveCreates(calls).length, 0);
  assert.equal(next.pendingSmokeSelection?.folderId, FOLDER_ID, "the smoke state is not disturbed by the stale approval attempt");
});

// ---------------------------------------------------------------------------
// Telegram callback_data byte-length invariant: the bounded smoke Work id
// keeps EVERY callback shape the smoke flow can stage or emit within
// Telegram's inline-keyboard limit (1-64 UTF-8 bytes). The pre-fix full
// UUID embedded in these callbacks measured 76 bytes for the account picker
// and both live sends were refused with HTTP 400 BUTTON_DATA_INVALID
// (2026-10-10). Bytes are always measured with TextEncoder -- JavaScript
// string length would silently miss multi-byte content.
// ---------------------------------------------------------------------------

const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

function assertWithinTelegramLimit(shape: string, data: string): void {
  assert.ok(
    utf8Bytes(data) <= TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    `${shape} callback_data is ${utf8Bytes(data)} UTF-8 bytes -- Telegram refuses anything over ` +
      `${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes with BUTTON_DATA_INVALID: ${data}`,
  );
}

test("the generated smoke Work id keeps the required prefix with an exact bounded 16-hex-char suffix, and its account-picker callbacks fit Telegram's 64-byte limit", async (t: any) => {
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT), ...googleAccountSeed(SECOND_ACCOUNT) });
  const { calls, telegram } = installFake(t, () => json({}));

  await startGoogleDocsSmokeFlow(env, 111, 222);

  // The id the flow actually generated this run: prefix preserved for
  // routing/validation, exactly 16 hex chars after it -- never a full UUID.
  const workId = String(inits(env)[0][0]);
  assert.ok(workId.startsWith(GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX), "routing, isGoogleDocsSmokeWorkId, and the admin gate key off this prefix");
  assert.match(workId, /^smoke-googledocs-[0-9a-f]{16}$/, "the suffix must be exactly 16 lowercase hex characters");
  assert.equal(workId.length, GOOGLE_DOCS_SMOKE_WORK_ID_PREFIX.length + 16);

  // Both authorized accounts are offered, every account-picker callback
  // carries the generated id, and every one is within the byte limit.
  const datas = callbackDatas(telegram);
  assert.ok(datas.length >= 2, "both authorized accounts must be offered");
  for (const data of datas) {
    assert.ok(data.startsWith(`googleaccount:${workId}:`), `unexpected account-picker callback: ${data}`);
    assertWithinTelegramLimit("googleaccount (account picker)", data);
  }

  assert.equal(calls.length, 0, "the shorter id costs nothing: initiation still makes no Google request");
});

test("every callback_data shape the smoke flow can stage or emit -- account, folder, confirm, cancel, and the sessions switch row -- stays within Telegram's 64-byte limit", async (t: any) => {
  const env = fakeEnv({ ...googleAccountSeed(ACCOUNT) });
  const { telegram } = installFake(t, (call) => {
    if (call.url.includes("/drive/v3/files")) return json({ files: [{ id: FOLDER_ID, name: FOLDER_NAME }] });
    return json({});
  });

  const measured: { shape: string; data: string }[] = [];
  const capture = (shape: string) => {
    for (const data of callbackDatas(telegram)) measured.push({ shape, data });
    telegram.length = 0; // isolate each stage's own sends
  };

  // Stage 1 -- account picker (startGoogleDocsSmokeFlow):
  // googleaccount:<workId>:<opaqueId>
  await startGoogleDocsSmokeFlow(env, 111, 222);
  const workId = String(inits(env)[0][0]);
  capture("googleaccount");

  // Stage 2 -- folder picker (shared handleGoogleAccountSelection, smoke
  // branch): googlefolder:<workId>:<opaqueId>
  const state = smokeState(workId);
  const accountOptionId = await stageOption(env, workId, { kind: "account", smoke: true, accountIdentifier: ACCOUNT });
  await handleGoogleAccountSelection(env, state, accountOptionId);
  capture("googlefolder");

  // Stage 3 -- confirmation (shared handleGoogleFolderSelection, smoke
  // branch): googlesmokeconfirm:<workId>:<opaqueId> + ...:<workId>:cancel
  const folderOptionKey = optionKeys(env, workId).find((k) => JSON.parse(store(env).get(k) as string).kind === "folder");
  assert.ok(folderOptionKey, "the folder option must have been staged");
  const folderOptionId = String(folderOptionKey.split(":").pop());
  await handleGoogleFolderSelection(env, state, folderOptionId);
  capture("googlesmokeconfirm");

  // Stage 4 -- the /sessions row for this still-open smoke Work, built in
  // index.ts's listSessions as `switch:${s.workId}:` (index.ts loads the
  // Workers runtime and cannot be imported here -- this is that exact
  // template literal, exercised against the generated id).
  measured.push({ shape: "switch", data: `switch:${workId}:` });

  // Every shape the smoke Work can reach is present...
  assert.ok(measured.some((m) => m.shape === "googleaccount" && m.data.startsWith(`googleaccount:${workId}:`)));
  assert.ok(measured.some((m) => m.shape === "googlefolder" && m.data.startsWith(`googlefolder:${workId}:`)));
  assert.ok(
    measured.some((m) => m.shape === "googlesmokeconfirm" && m.data.startsWith(`googlesmokeconfirm:${workId}:`) && !m.data.endsWith(":cancel")),
    "the confirm button must be staged",
  );
  assert.ok(measured.some((m) => m.shape === "googlesmokeconfirm" && m.data === `googlesmokeconfirm:${workId}:cancel`), "the cancel button must be staged");
  assert.ok(measured.some((m) => m.shape === "switch" && m.data === `switch:${workId}:`));
  assert.equal(measured.some((m) => m.data.startsWith("googleaction:")), false, "the smoke flow never stages legacy creation-approval callbacks");

  // ...and every single value is within Telegram's hard byte limit.
  for (const { shape, data } of measured) {
    assertWithinTelegramLimit(shape, data);
  }
});
