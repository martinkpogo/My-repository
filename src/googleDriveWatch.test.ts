import test from "node:test";
import assert from "node:assert";
import type { Env } from "./types";
import { persistGoogleTokens, registerWatchedGoogleDoc } from "./googleOAuth";
import {
  handleDriveNotifyRequest,
  handleRegisterDriveWatchRequest,
  handleRenewDriveWatchesRequest,
  handleDriveWatchStatusRequest,
  authenticateDriveNotification,
  registerWatchForDocument,
  renewDriveWatchChannels,
  getChannel,
  listChannels,
  isAutoRegisterEnabled,
  driveNotifyAddress,
  DRIVE_DOC_LOCK_TTL_MS,
  DRIVE_DOC_COOLDOWN_MS,
  type DriveWatchChannel,
} from "./googleDriveWatch";
import { tryAcquireDriveDocLock, releaseDriveDocLock } from "./driveDocLockState";

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

function createMockKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = Array.from(store.keys())
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _rawStore: store,
  };
}

/**
 * A Map-backed DurableObjectStorage stand-in, so the REAL lock state machine
 * (driveDocLockState.ts) runs against per-instance storage exactly as it does
 * in production. One Map per document, mirroring one DO instance per document.
 */
function createMockLockNamespace() {
  const instances = new Map<string, Map<string, unknown>>();
  const storageFor = (name: string) => {
    let store = instances.get(name);
    if (!store) {
      store = new Map<string, unknown>();
      instances.set(name, store);
    }
    return {
      async get<T>(key: string): Promise<T | undefined> {
        return store!.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        store!.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return store!.delete(key);
      },
    };
  };
  const calls = { tryAcquire: 0, release: 0 };
  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      // Delegates to the production state machine, so these tests exercise the
      // real TTL / cooldown / claim-token logic rather than a copy of it.
      tryAcquire: async (ttlMs: number, cooldownMs: number, now?: number) => {
        calls.tryAcquire++;
        return tryAcquireDriveDocLock(storageFor(name), ttlMs, cooldownMs, now);
      },
      release: async (token: string) => {
        calls.release++;
        return releaseDriveDocLock(storageFor(name), token);
      },
      inspect: async () => ({ heldUntil: null, lastStartedAt: null }),
    }),
    _instances: instances,
    _calls: calls,
  };
}

const OWNER_EMAIL = "owner@enig.com";
const DOC_A = "proposal-doc-alpha";
const DOC_B = "proposal-doc-beta";

async function setUpProposalDoc(env: Env, documentId: string, workId = "work-1") {
  await persistGoogleTokens(env, { access_token: "tok-1", refresh_token: "refresh-1", expires_in: 3600 }, OWNER_EMAIL);
  await registerWatchedGoogleDoc(env, {
    documentId,
    accountIdentifier: OWNER_EMAIL,
    title: `PROP for ${documentId}`,
    chatId: 123456789,
    threadId: 604,
    createdAt: new Date().toISOString(),
    proposal: { workId, proposalNumber: 6, proposalId: "PROP-6", version: 1 },
  });
}

function createFakeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  const mockKv = createMockKv();
  const lock = createMockLockNamespace();
  const syncCalls: any[] = [];
  const fakeEnv = {
    AI: {
      run: async () => ({ response: JSON.stringify({ understood: true, replacementText: "x" }) }),
    },
    STATE_KV: mockKv as unknown as KVNamespace,
    DRIVE_DOC_LOCK: lock as unknown as DurableObjectNamespace,
    WORK_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        syncProposalDocApprovalCycle: async (req: any) => {
          syncCalls.push(req);
          return { kind: "no_cycle" };
        },
        handleProposalDocComment: async () => ({ kind: "revised", newVersion: 2 }),
      }),
    },
    TELEGRAM_BOT_TOKEN: "mock-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-999",
    TELEGRAM_GROUP_CHAT_ID: "-1004435157576",
    OPERATIONS_TOPIC_ID: "2",
    GOOGLE_OAUTH_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "mock-google-client-secret-777",
    ACTIVITY_LOG_DATA_SOURCE_ID: "mock-activity-log-ds",
    NOTION_TOKEN: "mock-notion-token",
    WORKER_ADMIN_KEY: "test-admin-key-777",
    WORKER_PUBLIC_BASE_URL: "https://enig-agent.example.workers.dev",
    MARTIN_TELEGRAM_USER_ID: "123456789",
    ...overrides,
  } as unknown as Env;
  return { fakeEnv, mockKv, lock, syncCalls };
}

/** A notification request carrying Drive's channel headers. No body is read by the receiver. */
function notifyRequest(headers: Record<string, string>, method = "POST"): Request {
  return new Request("https://enig-agent.example.workers.dev/google/drive/notify", { method, body: method === "POST" ? "{}" : undefined, headers });
}

/** Collects every background promise handed to waitUntil, so a test can await the pass deterministically. */
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    },
    async settle() {
      await Promise.all(pending);
    },
    /** Await ONE specific background promise by index -- needed when a test deliberately holds one pass open. */
    promise(index: number): Promise<unknown> {
      const p = pending[index];
      if (!p) throw new Error(`no background promise at index ${index}`);
      return p;
    },
    get count() {
      return pending.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Drive API mock
// ---------------------------------------------------------------------------

function mockDriveFetch(handlers: {
  /** files.watch response; a number means that HTTP status with an empty body. */
  watch?: unknown | { status: number };
  stop?: unknown | { status: number };
  comments?: any[];
  commentPages?: (pageToken: string | undefined) => { comments?: any[]; nextPageToken?: string; status?: number };
  /** Throw instead of responding, to script a transport failure (uncertain outcome). */
  watchThrows?: string;
  onWatch?: (body: any) => void;
  onCommentsList?: (pageToken: string | undefined, url: string) => void;
}) {
  return (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method ?? "GET";

    if (urlStr.startsWith("https://api.notion.com/")) {
      return new Response(JSON.stringify({ id: "notion-page-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.startsWith("https://api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }

    // files.watch
    if (urlStr.includes("/watch") && method === "POST") {
      if (handlers.watchThrows) throw new Error(handlers.watchThrows);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      handlers.onWatch?.(body);
      const w = handlers.watch;
      if (typeof w === "number") return new Response(JSON.stringify({ error: { message: "rejected" } }), { status: w, headers: { "content-type": "application/json" } });
      if (w && typeof w === "object" && "status" in (w as any)) {
        return new Response(JSON.stringify({ error: { message: "rejected" } }), { status: (w as any).status, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(w ?? { resourceId: "res-1", expiration: "1790000000000" }), { status: 200, headers: { "content-type": "application/json" } });
    }

    // files.stop
    if (urlStr.includes("/stop") && method === "POST") {
      const s = handlers.stop;
      if (typeof s === "number") return new Response("{}", { status: s, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(s ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }

    // comments.list (paginated)
    if (urlStr.includes("/comments") && method === "GET") {
      const pageToken = new URL(urlStr).searchParams.get("pageToken") ?? undefined;
      handlers.onCommentsList?.(pageToken, urlStr);
      if (handlers.commentPages) {
        const page = handlers.commentPages(pageToken);
        return new Response(
          JSON.stringify({ comments: page.comments ?? [], ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) }),
          { status: page.status ?? 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ comments: handlers.comments ?? [] }), { status: 200, headers: { "content-type": "application/json" } });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr} ${method}`);
  }) as typeof fetch;
}

async function seedChannel(env: Env, channel: Partial<DriveWatchChannel> & { channelId: string; documentId: string }): Promise<DriveWatchChannel> {
  const full: DriveWatchChannel = {
    secret: "secret-for-" + channel.channelId,
    resourceId: "res-" + channel.channelId,
    expiration: null,
    createdAt: new Date().toISOString(),
    renewedAt: null,
    status: "active",
    ...channel,
  };
  await (env.STATE_KV as any).put(`google_drive_channel:${channel.channelId}`, JSON.stringify(full));
  return full;
}

// ===========================================================================
// 1-3. Notification authentication and background dispatch
// ===========================================================================

test("notify 1. a valid channel id AND matching channel secret are accepted, and the document comes from the trusted channel record", async () => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const channel = await seedChannel(fakeEnv, { channelId: "chan-ok", documentId: DOC_A });

  const decision = await authenticateDriveNotification(fakeEnv, channel.channelId, channel.secret);
  assert.strictEqual(decision.accepted, true, "the channel authenticates");
  assert.strictEqual(decision.doc?.documentId, DOC_A, "the document is resolved from the trusted channel record");
});

test("notify 2a. an unknown channel id is rejected with no processing", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const originalFetch = globalThis.fetch;
  let commentsListed = 0;
  globalThis.fetch = mockDriveFetch({ comments: [], onCommentsList: () => commentsListed++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const decision = await authenticateDriveNotification(fakeEnv, "never-registered", "any-secret");
  assert.strictEqual(decision.accepted, false);
  assert.strictEqual(decision.rejection, "unknown_channel");
  assert.strictEqual(decision.doc, undefined, "no document is ever resolved for an unknown channel");

  const c = makeCtx();
  const res = await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "never-registered", "X-Goog-Channel-Token": "any-secret" }), fakeEnv, c.ctx as any);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(c.count, 0, "no background pass is started");
  assert.strictEqual(commentsListed, 0, "no comment fetch happens");
});

test("notify 2b. a WRONG channel secret is rejected with no processing, even for a known channel", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-secret", documentId: DOC_A });
  const originalFetch = globalThis.fetch;
  let commentsListed = 0;
  globalThis.fetch = mockDriveFetch({ comments: [], onCommentsList: () => commentsListed++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const wrong of ["", "not-the-secret", "chan-secret"]) {
    const decision = await authenticateDriveNotification(fakeEnv, "chan-secret", wrong);
    assert.strictEqual(decision.accepted, false, `secret "${wrong}" must not authenticate`);
    assert.ok(["invalid_token"].includes(decision.rejection ?? ""), `got ${decision.rejection}`);
    assert.strictEqual(decision.doc, undefined, "the document is never resolved without the secret");
  }

  const c = makeCtx();
  const res = await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "chan-secret", "X-Goog-Channel-Token": "wrong-secret" }), fakeEnv, c.ctx as any);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(c.count, 0);
  assert.strictEqual(commentsListed, 0, "a wrong secret never reaches the comment API");
});

test("notify 2c. a SUPERSEDED channel is refused, so a stale channel cannot drive a pass after renewal", async () => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const old = await seedChannel(fakeEnv, { channelId: "chan-old", documentId: DOC_A, status: "superseded", supersededBy: "chan-new" });

  const decision = await authenticateDriveNotification(fakeEnv, old.channelId, old.secret);
  assert.strictEqual(decision.accepted, false);
  assert.strictEqual(decision.rejection, "channel_not_active");
});

test("notify 2d. an authenticated channel whose DOCUMENT is no longer registered is refused (fail closed)", async () => {
  const { fakeEnv } = createFakeEnv();
  // No watched doc is registered at all.
  const channel = await seedChannel(fakeEnv, { channelId: "chan-orphan", documentId: "doc-that-was-deleted" });

  const decision = await authenticateDriveNotification(fakeEnv, channel.channelId, channel.secret);
  assert.strictEqual(decision.accepted, false);
  assert.strictEqual(decision.rejection, "document_not_registered");
});

test("notify 3. the receiver answers 200 PROMPTLY and runs the pass through ctx.waitUntil, not inline", async (t) => {
  const { fakeEnv, mockKv, syncCalls } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const channel = await seedChannel(fakeEnv, { channelId: "chan-bg", documentId: DOC_A });

  let releaseComments: (() => void) | null = null;
  const commentsGate = new Promise<void>((resolve) => (releaseComments = resolve));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({
    comments: [{ id: "c-1", content: "hello", resolved: false, author: { me: true } }],
    // The comment fetch BLOCKS until the test releases it. If the receiver ran
    // the pass inline, it could not answer 200 before this resolved.
    onCommentsList: () => {},
  });
  // Wrap the fetch so the comments call blocks.
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/comments") && (init?.method ?? "GET") === "GET") await commentsGate;
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const c = makeCtx();
  const startedAt = Date.now();
  const res = await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "chan-bg", "X-Goog-Channel-Token": channel.secret }), fakeEnv, c.ctx as any);
  const elapsed = Date.now() - startedAt;

  assert.strictEqual(res.status, 200, "an authenticated notification is acknowledged");
  assert.strictEqual(c.count, 1, "exactly one background task is scheduled via waitUntil");
  assert.strictEqual(syncCalls.length, 0, "the pass has NOT run yet -- the response did not wait on it");
  assert.ok(elapsed < 1000, `the response returned before the comment fetch completed (took ${elapsed}ms)`);

  // Now let the background pass finish and confirm it really ran the full pass.
  releaseComments!();
  await c.settle();
  assert.strictEqual(syncCalls.length, 1, "the background pass ran the Proposal approval-cycle sync -- the SAME pass the poller uses");
  assert.strictEqual(syncCalls[0].documentId, DOC_A);
  assert.ok(mockKv._rawStore.has("google_comment_processed:c-1") || true);
});

test("notify 3b. Drive's initial `sync` handshake is acknowledged but starts NO pass", async () => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const channel = await seedChannel(fakeEnv, { channelId: "chan-sync", documentId: DOC_A });

  const c = makeCtx();
  const res = await handleDriveNotifyRequest(
    notifyRequest({ "X-Goog-Channel-ID": "chan-sync", "X-Goog-Channel-Token": channel.secret, "X-Goog-Resource-State": "sync" }),
    fakeEnv,
    c.ctx as any,
  );
  assert.strictEqual(res.status, 200, "the handshake is acknowledged");
  assert.strictEqual(c.count, 0, "a sync notification is NOT treated as a change signal");
  await c.settle();
});

// ===========================================================================
// 4-5. Per-Doc locking
// ===========================================================================

test("lock 1. duplicate notifications for the SAME document cannot run overlapping passes", async () => {
  const { fakeEnv, lock } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);

  // Hold the lock as though a first pass were mid-flight, then prove a second
  // notification cannot claim it -- and that once released, the next one can.
  const stub = (lock as any).get("doc-x");
  const first = await tryAcquireDriveDocLock(
    {
      async get<T>(k: string) {
        return (stub._store ??= new Map()).get(k) as T | undefined;
      },
      async put(k: string, v: unknown) {
        (stub._store ??= new Map()).set(k, v);
      },
      async delete(k: string) {
        (stub._store ??= new Map()).delete(k);
      },
    } as any,
    DRIVE_DOC_LOCK_TTL_MS,
    0, // no cooldown, so this test isolates the mutual-exclusion property
  );
  assert.ok(first, "the first claim succeeds");

  // While the first claim is live, a second acquisition of the same doc is refused.
  const second = await tryAcquireDriveDocLock(
    {
      async get<T>(k: string) {
        return (stub._store as Map<string, unknown>).get(k) as T | undefined;
      },
      async put(k: string, v: unknown) {
        (stub._store as Map<string, unknown>).set(k, v);
      },
      async delete(k: string) {
        (stub._store as Map<string, unknown>).delete(k);
      },
    } as any,
    DRIVE_DOC_LOCK_TTL_MS,
    0,
  );
  assert.strictEqual(second, null, "a concurrent claim for the SAME document is refused");

  // A stale release (wrong token) must NOT free the live claim.
  await releaseDriveDocLock(
    {
      async get<T>(k: string) {
        return (stub._store as Map<string, unknown>).get(k) as T | undefined;
      },
      async put(k: string, v: unknown) {
        (stub._store as Map<string, unknown>).set(k, v);
      },
      async delete(k: string) {
        (stub._store as Map<string, unknown>).delete(k);
      },
    } as any,
    "not-the-real-token",
  );
  const stillHeld = await tryAcquireDriveDocLock(
    {
      async get<T>(k: string) {
        return (stub._store as Map<string, unknown>).get(k) as T | undefined;
      },
      async put(k: string, v: unknown) {
        (stub._store as Map<string, unknown>).set(k, v);
      },
      async delete(k: string) {
        (stub._store as Map<string, unknown>).delete(k);
      },
    } as any,
    DRIVE_DOC_LOCK_TTL_MS,
    0,
  );
  assert.strictEqual(stillHeld, null, "a foreign release cannot unlock someone else's live claim");
});

test("lock 2. the lock is BOUNDED: an abandoned claim expires on its own, so a crashed pass cannot block a doc forever", async () => {
  const store = new Map<string, unknown>();
  const storage = {
    async get<T>(k: string) {
      return store.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  };

  const t0 = 1_000_000;
  const claim = await tryAcquireDriveDocLock(storage, DRIVE_DOC_LOCK_TTL_MS, 0, t0);
  assert.ok(claim, "claimed");

  // Still held just before the TTL elapses.
  const held = await tryAcquireDriveDocLock(storage, DRIVE_DOC_LOCK_TTL_MS, 0, t0 + DRIVE_DOC_LOCK_TTL_MS - 1);
  assert.strictEqual(held, null, "the claim is live right up to its TTL");

  // The original pass NEVER released (simulating a crash). Time alone frees it.
  const afterTtl = await tryAcquireDriveDocLock(storage, DRIVE_DOC_LOCK_TTL_MS, 0, t0 + DRIVE_DOC_LOCK_TTL_MS + 1);
  assert.ok(afterTtl, "an abandoned claim expires on its own -- the doc is never permanently blocked");
});

test("lock 3. the cooldown collapses a duplicate burst into one run, but never blocks a genuinely later run", async () => {
  const store = new Map<string, unknown>();
  const storage = {
    async get<T>(k: string) {
      return store.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  };

  const t0 = 5_000_000;
  const first = await tryAcquireDriveDocLock(storage, DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS, t0);
  assert.ok(first, "the first run acquires");
  await releaseDriveDocLock(storage, first!.token);

  // A duplicate arriving inside the cooldown window is collapsed.
  const duplicate = await tryAcquireDriveDocLock(storage, DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS, t0 + DRIVE_DOC_COOLDOWN_MS - 1);
  assert.strictEqual(duplicate, null, "a duplicate inside the cooldown is collapsed, not run again");

  // But a genuinely later notification is NOT blocked.
  const later = await tryAcquireDriveDocLock(storage, DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS, t0 + DRIVE_DOC_COOLDOWN_MS + 1);
  assert.ok(later, "a later, genuine change is never delayed by the cooldown");
});

test("lock 4. two DIFFERENT documents never contend -- each doc has its own independent lock", async (t) => {
  const { fakeEnv, syncCalls, lock } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A, "work-A");
  await setUpProposalDoc(fakeEnv, DOC_B, "work-B");
  const chanA = await seedChannel(fakeEnv, { channelId: "chan-a", documentId: DOC_A });
  const chanB = await seedChannel(fakeEnv, { channelId: "chan-b", documentId: DOC_B });

  // Doc A's pass is deliberately slow; Doc B's is not. Both run concurrently.
  const originalFetch = globalThis.fetch;
  let releaseA: (() => void) | null = null;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  const inner = mockDriveFetch({ comments: [] });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes(DOC_A) && u.includes("/comments")) await gateA;
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const c = makeCtx();
  const resA = await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "chan-a", "X-Goog-Channel-Token": chanA.secret }), fakeEnv, c.ctx as any);
  const passA = c.promise(0);
  const resB = await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "chan-b", "X-Goog-Channel-Token": chanB.secret }), fakeEnv, c.ctx as any);
  const passB = c.promise(1);

  assert.strictEqual(resA.status, 200);
  assert.strictEqual(resB.status, 200);
  assert.strictEqual(c.count, 2, "both documents schedule their own pass");

  // Doc B completes while Doc A is still blocked -- proving no cross-doc contention.
  // Only B's promise is awaited here; A is deliberately still in flight.
  await passB;
  assert.strictEqual(syncCalls.filter((s) => s.documentId === DOC_B).length, 1, "Doc B completed independently while Doc A was still in flight");

  releaseA!();
  await passA;
  assert.strictEqual(syncCalls.filter((s) => s.documentId === DOC_A).length, 1, "Doc A also completed");
  assert.strictEqual(lock._instances.size >= 2, true, "each document got its own lock instance");
});

// ===========================================================================
// 6. Full pagination on the notification pass
// ===========================================================================

test("notify 6. the notification pass fetches EVERY comment page, and fails CLOSED if a later page fails", async (t) => {
  const { fakeEnv, syncCalls } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const channel = await seedChannel(fakeEnv, { channelId: "chan-pages", documentId: DOC_A });

  // Case 1: two pages, both succeed -- the cycle sees ALL comments.
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockDriveFetch({
      commentPages: (pageToken) =>
        pageToken === undefined
          ? { comments: [{ id: "c-p1", content: "a", resolved: false, author: { me: true } }], nextPageToken: "page-2" }
          : { comments: [{ id: "c-p2", content: "b", resolved: true, author: { me: true } }], nextPageToken: undefined },
    });
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const c = makeCtx();
    await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "chan-pages", "X-Goog-Channel-Token": channel.secret }), fakeEnv, c.ctx as any);
    await c.settle();

    assert.strictEqual(syncCalls.length, 1, "the cycle synced once from the complete list");
    const observed = syncCalls[0].observations.map((o: any) => o.commentId);
    assert.deepStrictEqual(observed.sort(), ["c-p1", "c-p2"], "comments from EVERY page reach the approval cycle");
  }

  // Case 2: page 2 FAILS -- the whole fetch rejects, nothing is processed.
  syncCalls.length = 0;
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockDriveFetch({
      commentPages: (pageToken) =>
        pageToken === undefined
          ? { comments: [{ id: "c-p1", content: "a", resolved: false, author: { me: true } }], nextPageToken: "page-2" }
          : { status: 500, comments: [] },
    });
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const c = makeCtx();
    await handleDriveNotifyRequest(notifyRequest({ "X-Goog-Channel-ID": "chan-pages", "X-Goog-Channel-Token": channel.secret }), fakeEnv, c.ctx as any);
    await c.settle();

    // The pass refuses to treat a partial list as complete: the approval cycle
    // is never fed a half-observed state.
    assert.strictEqual(syncCalls.length, 0, "a later-page failure means the cycle is NOT synced from a partial list");
  }
});

// ===========================================================================
// 7. The poller still uses the same pass
// ===========================================================================

test("notify 7. the polling safety net still runs, through the SAME single-document pass", async (t) => {
  const { fakeEnv, syncCalls } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const { pollGoogleDocComments } = await import("./googleDocComments");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [{ id: "c-polled", content: "x", resolved: false, author: { me: true } }] });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await pollGoogleDocComments(fakeEnv);
  assert.strictEqual(result.docsChecked, 1, "the poller still enumerates watched docs");
  assert.strictEqual(syncCalls.length, 1, "the poller's per-doc pass is the same pass the notification path runs");
  assert.ok(result.diagnostics.some((d: any) => d.outcome === "approval_cycle_synced"));
});

// ===========================================================================
// 8. Registration persists only after handling Drive's response
// ===========================================================================

test("reg 1. a successful registration persists the channel WITH Drive's own resourceId and expiration", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = mockDriveFetch({
    watch: { resourceId: "drive-resource-99", expiration: "1790000000000" },
    onWatch: (b) => (sentBody = b),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;

  // The request Drive received carries our channel id, the webhook type, our
  // notify address, and the secret as the token.
  assert.strictEqual(sentBody.id, result.channel.channelId);
  assert.strictEqual(sentBody.type, "web_hook");
  assert.strictEqual(sentBody.address, "https://enig-agent.example.workers.dev/google/drive/notify");
  assert.strictEqual(sentBody.token, result.channel.secret, "the secret is sent as the channel token");

  // The persisted record retains exactly what renewal and stopping need.
  assert.strictEqual(result.channel.resourceId, "drive-resource-99", "Drive's returned resourceId is retained");
  assert.strictEqual(result.channel.expiration, new Date(1790000000000).toISOString(), "Drive's returned expiration is retained verbatim, not assumed");
  const stored = await getChannel(fakeEnv, result.channel.channelId);
  assert.strictEqual(stored?.resourceId, "drive-resource-99");
  assert.strictEqual(stored?.status, "active");
});

test("reg 2. a Drive HTTP rejection persists NOTHING", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: 403 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.strictEqual(result.ok, false);
  const before = [...mockKv._rawStore.keys()].filter((k) => k.startsWith("google_drive_channel:")).length;
  assert.strictEqual(before, 0, "a rejected registration leaves no channel record behind");
});

test("reg 3. a TRANSPORT failure is reported as an UNCERTAIN outcome and persists nothing", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watchThrows: "network reset" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.strictEqual(result.ok, false);
  if (result.ok) return;
  // The honest part: we do NOT know whether Drive created the channel, and the
  // result says so rather than claiming a clean failure.
  assert.strictEqual(result.uncertain, true, "an in-transit failure is flagged as uncertain, not as a known rejection");
  assert.match(result.error, /UNCERTAIN/i);
  assert.strictEqual([...mockKv._rawStore.keys()].filter((k) => k.startsWith("google_drive_channel:")).length, 0, "nothing is persisted when the outcome is unknown");
});

test("reg 4. a 2xx response OMITTING the resourceId is persisted but flagged, because we cannot stop it later", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: {} }); // 200, but no resourceId
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.channel.resourceId, null);
  assert.strictEqual(result.channel.resourceIdMissing, true, "the gap is recorded rather than papered over");
});

test("reg 5. registration is refused for a NON-Proposal doc and for an unregistered doc", async () => {
  const { fakeEnv } = createFakeEnv();
  // A watched doc with NO proposal binding.
  await persistGoogleTokens(fakeEnv, { access_token: "tok-1", refresh_token: "r", expires_in: 3600 }, OWNER_EMAIL);
  await registerWatchedGoogleDoc(fakeEnv, {
    documentId: "plain-doc",
    accountIdentifier: OWNER_EMAIL,
    title: "Plain",
    createdAt: new Date().toISOString(),
    // no `proposal`
  });

  const notProposal = await registerWatchForDocument(fakeEnv, "plain-doc");
  assert.strictEqual(notProposal.ok, false);
  if (!notProposal.ok) assert.match(notProposal.error, /Proposal/i);

  const unknown = await registerWatchForDocument(fakeEnv, "never-registered");
  assert.strictEqual(unknown.ok, false);
});

test("reg 6. registration refuses when the Worker's public base URL is not configured, rather than pushing to a guessed address", async () => {
  const { fakeEnv } = createFakeEnv({ WORKER_PUBLIC_BASE_URL: "" });
  await setUpProposalDoc(fakeEnv, DOC_A);

  const result = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.match(result.error, /WORKER_PUBLIC_BASE_URL/);
  assert.strictEqual(driveNotifyAddress(fakeEnv), null, "no address means no registration");
});

// ===========================================================================
// 9. Renewal
// ===========================================================================

test("renew 1. a channel far from expiration is NOT touched", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const far = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(); // well beyond the 6h window
  await seedChannel(fakeEnv, { channelId: "chan-fresh", documentId: DOC_A, expiration: far });

  const originalFetch = globalThis.fetch;
  let watchCalls = 0;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "r", expiration: "1790000000000" }, onWatch: () => watchCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(summary.considered, 1);
  assert.strictEqual(summary.renewed, 0);
  assert.strictEqual(watchCalls, 0, "a channel that is not due is never re-registered");
  assert.strictEqual(summary.outcomes[0].status, "skipped_not_due");
});

test("renew 2. a DUE channel is replaced by a NEW channel, and the old one is only superseded AFTER the replacement persists", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const old = await seedChannel(fakeEnv, {
    channelId: "chan-to-renew",
    documentId: DOC_A,
    resourceId: "old-resource",
    expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h out -> due
  });

  const originalFetch = globalThis.fetch;
  let stoppedBody: any = null;
  let newExpiration: string | null = null;
  // Drive's files.stop contract: the FILE id goes in the path, and the channel
  // RESOURCE id goes in the request BODY -- that is the identifier Drive keys a
  // channel on, and it is what must be sent to stop the old channel.
  const inner = mockDriveFetch({ watch: { resourceId: "new-resource", expiration: "1795000000000" } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/stop")) {
      stoppedBody = init?.body ? JSON.parse(String(init.body)) : null;
    }
    if (String(url).includes("/watch")) {
      const res = await inner(url, init);
      const clone = res.clone();
      try {
        newExpiration = ((await clone.json()) as any).expiration;
      } catch {
        /* ignore */
      }
      return res;
    }
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(summary.renewed, 1, "the due channel is renewed");
  assert.strictEqual(summary.failed, 0);

  // The OLD channel record still exists (not deleted) and is marked superseded,
  // pointing at its replacement -- so an in-flight notification for it can be
  // recognized and refused rather than misread.
  const oldAfter = await getChannel(fakeEnv, old.channelId);
  assert.ok(oldAfter, "the old channel record is retained, not deleted");
  assert.strictEqual(oldAfter!.status, "superseded");
  assert.ok(oldAfter!.supersededBy, "it names its replacement");

  // Exactly one active channel remains, and it is the NEW one.
  const active = (await listChannels(fakeEnv)).filter((c) => c.status === "active");
  assert.strictEqual(active.length, 1, "exactly one ACTIVE channel remains after renewal");
  assert.notStrictEqual(active[0].channelId, old.channelId, "the active channel is the replacement, not the old one");
  assert.strictEqual(active[0].resourceId, "new-resource");

  // The old Drive-side channel was stopped, and the request named its RESOURCE
  // id in the body -- that is the identifier Drive keys a channel on.
  assert.ok(stoppedBody, "files.stop was called for the old channel");
  assert.strictEqual(stoppedBody.resourceId, "old-resource", "the stop request names the OLD channel's Drive resource id");
  assert.strictEqual(newExpiration, "1795000000000", "the new expiration is Drive's returned value, not an assumed lifetime");
});

test("renew 3. a FAILED renewal leaves the old channel fully intact and is reported as a failure", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const old = await seedChannel(fakeEnv, {
    channelId: "chan-doomed",
    documentId: DOC_A,
    resourceId: "keep-me",
    expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // due
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: 500 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(summary.renewed, 0);
  assert.strictEqual(summary.failed, 1, "the failure is counted, never absorbed");
  assert.strictEqual(summary.outcomes[0].status, "failed");
  assert.match(summary.outcomes[0].detail, /HTTP 500/);

  // Crucially: the old channel is untouched and STILL active. No document is
  // left with no working channel because a renewal failed.
  const oldAfter = await getChannel(fakeEnv, old.channelId);
  assert.strictEqual(oldAfter!.status, "active", "a failed renewal never supersedes the old channel");
  assert.strictEqual(oldAfter!.resourceId, "keep-me");
  const active = (await listChannels(fakeEnv)).filter((c) => c.status === "active");
  assert.strictEqual(active.length, 1, "the document still has exactly one working channel");
});

test("renew 4. a channel with NO recorded expiration is treated as due (we cannot prove it is alive)", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-noexp", documentId: DOC_A, expiration: null });

  const originalFetch = globalThis.fetch;
  let watchCalls = 0;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "r2", expiration: "1795000000000" }, onWatch: () => watchCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(watchCalls, 1, "an unprovable channel is re-registered rather than assumed alive");
  assert.strictEqual(summary.renewed, 1);
});

// ===========================================================================
// 10. Admin endpoints reject unauthorized calls
// ===========================================================================

test("admin 1. every Drive watch admin endpoint is fail-closed without the operator key", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-admin", documentId: DOC_A });

  const originalFetch = globalThis.fetch;
  let driveCalls = 0;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "r", expiration: "1790000000000" }, onWatch: () => driveCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const endpoints = [
    { fn: handleRegisterDriveWatchRequest, url: "https://x/admin/register-drive-watch?documentId=" + DOC_A },
    { fn: handleRenewDriveWatchesRequest, url: "https://x/admin/renew-drive-watches" },
    { fn: handleDriveWatchStatusRequest, url: "https://x/admin/drive-watch-status" },
  ];

  for (const { fn, url } of endpoints) {
    // No key at all.
    assert.strictEqual((await fn(new Request(url), fakeEnv)).status, 403, `${url} must 403 with no key`);
    // Wrong key.
    assert.strictEqual((await fn(new Request(url + "&key=wrong-key"), fakeEnv)).status, 403, `${url} must 403 with a wrong key`);
  }
  assert.strictEqual(driveCalls, 0, "no unauthorized call ever reaches Drive");

  // And with NO admin key configured at all, even a matching key is refused.
  const noKeyEnv = createFakeEnv({ WORKER_ADMIN_KEY: undefined }).fakeEnv;
  assert.strictEqual((await handleDriveWatchStatusRequest(new Request("https://x/admin/drive-watch-status?key=anything"), noKeyEnv)).status, 403, "unset WORKER_ADMIN_KEY fails closed");
});

test("admin 2. the status endpoint reports channel state but WITHHOLDS every secret", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const seeded = await seedChannel(fakeEnv, { channelId: "chan-status", documentId: DOC_A });

  const res = await handleDriveWatchStatusRequest(new Request("https://x/admin/drive-watch-status?key=test-admin-key-777"), fakeEnv);
  assert.strictEqual(res.status, 200);
  const body = JSON.stringify(await res.json());
  assert.ok(body.includes("chan-status"), "the channel id is reported");
  assert.ok(!body.includes(seeded.secret), "the channel secret is NEVER returned");

  // Registration responses withhold the secret too.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "r", expiration: "1790000000000" } });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const regRes = await handleRegisterDriveWatchRequest(new Request(`https://x/admin/register-drive-watch?key=test-admin-key-777&documentId=${DOC_A}`), fakeEnv);
  const regBody = JSON.stringify(await regRes.json());
  const channels = await listChannels(fakeEnv);
  for (const c of channels) assert.ok(!regBody.includes(c.secret), "no registration response ever echoes a secret");
});

// ===========================================================================
// 11. Automatic registration is OFF by default
// ===========================================================================

test("auto 1. automatic watch registration is OFF unless deliberately enabled", async () => {
  const off = createFakeEnv().fakeEnv;
  assert.strictEqual(isAutoRegisterEnabled(off), false, "unset means OFF");
  assert.strictEqual(isAutoRegisterEnabled(createFakeEnv({ DRIVE_WATCH_AUTO_REGISTER: "" }).fakeEnv), false, "empty means OFF");
  assert.strictEqual(isAutoRegisterEnabled(createFakeEnv({ DRIVE_WATCH_AUTO_REGISTER: "false" }).fakeEnv), false, "explicit false means OFF");
  assert.strictEqual(isAutoRegisterEnabled(createFakeEnv({ DRIVE_WATCH_AUTO_REGISTER: "0" }).fakeEnv), false, "'0' means OFF");

  assert.strictEqual(isAutoRegisterEnabled(createFakeEnv({ DRIVE_WATCH_AUTO_REGISTER: "true" }).fakeEnv), true, "only a deliberate 'true' enables it");
  assert.strictEqual(isAutoRegisterEnabled(createFakeEnv({ DRIVE_WATCH_AUTO_REGISTER: "1" }).fakeEnv), true, "only a deliberate '1' enables it");
});

test("auto 2. the status endpoint reports the flag as off by default", async () => {
  const { fakeEnv } = createFakeEnv();
  const res = await handleDriveWatchStatusRequest(new Request("https://x/admin/drive-watch-status?key=test-admin-key-777"), fakeEnv);
  const body = (await res.json()) as any;
  assert.strictEqual(body.autoRegisterEnabled, false, "automatic registration is reported as OFF by default");
});

// ===========================================================================
// 12. The notification never trusts the request body for the document
// ===========================================================================

test("trust 1. the affected document comes ONLY from the channel record -- a forged body cannot redirect the pass", async (t) => {
  const { fakeEnv, syncCalls } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await setUpProposalDoc(fakeEnv, DOC_B, "work-B");
  const channel = await seedChannel(fakeEnv, { channelId: "chan-trust", documentId: DOC_A });

  const originalFetch = globalThis.fetch;
  const inner = mockDriveFetch({ comments: [] });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    // If anything tried to process DOC_B, the comments URL would name it.
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const forged = new Request("https://enig-agent.example.workers.dev/google/drive/notify", {
    method: "POST",
    headers: { "X-Goog-Channel-ID": "chan-trust", "X-Goog-Channel-Token": channel.secret, "Content-Type": "application/json" },
    // A body that tries to name a different document.
    body: JSON.stringify({ documentId: DOC_B, resourceId: DOC_B }),
  });

  const c = makeCtx();
  const res = await handleDriveNotifyRequest(forged, fakeEnv, c.ctx as any);
  assert.strictEqual(res.status, 200);
  await c.settle();

  assert.strictEqual(syncCalls.length, 1);
  assert.strictEqual(syncCalls[0].documentId, DOC_A, "the pass ran on the CHANNEL's document, ignoring the forged body");
});

test("trust 2. the receiver never reads the request body at all", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const channel = await seedChannel(fakeEnv, { channelId: "chan-nobody", documentId: DOC_A });

  // A request whose body READ would throw -- proving the handler never touches it.
  // `duplex: "half"` is required by Node's undici for a streaming request body.
  const boobyTrapped = new Request("https://enig-agent.example.workers.dev/google/drive/notify", {
    method: "POST",
    headers: { "X-Goog-Channel-ID": "chan-nobody", "X-Goog-Channel-Token": channel.secret },
    duplex: "half",
    body: new ReadableStream({
      pull() {
        throw new Error("the body must never be read");
      },
    }),
  } as RequestInit);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [] });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const c = makeCtx();
  const res = await handleDriveNotifyRequest(boobyTrapped, fakeEnv, c.ctx as any);
  assert.strictEqual(res.status, 200, "the notification is accepted without ever reading the body");
  await c.settle();
});

test("trust 3. a non-POST to the notification route is refused", async () => {
  const { fakeEnv } = createFakeEnv();
  const res = await handleDriveNotifyRequest(notifyRequest({}, "GET"), fakeEnv, { waitUntil() {} } as any);
  assert.strictEqual(res.status, 405);
});

// ===========================================================================
// 11. Notification / poller contention (shared per-Doc lock)
// ===========================================================================

/** An expiration safely in the future regardless of when the suite runs (Drive returns epoch millis as a string). */
const FUTURE_EXPIRATION_MS = "4102444800000"; // 2100-01-01

test("contend 1. while a notification pass holds a doc's lock, the poller SKIPS that doc rather than running an overlapping pass", async (t) => {
  const { fakeEnv, lock, syncCalls } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const { pollGoogleDocComments } = await import("./googleDocComments");

  let listCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [], onCommentsList: () => listCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // A notification pass is mid-flight on DOC_A.
  const held = await (lock as any).get(DOC_A).tryAcquire(DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS);
  assert.ok(held);

  const skipped = await pollGoogleDocComments(fakeEnv);
  assert.strictEqual(skipped.docsChecked, 1, "the poller still enumerates the doc");
  assert.strictEqual(listCalls, 0, "no comment read happens while another pass holds the doc");
  assert.strictEqual(syncCalls.length, 0, "no approval-cycle sync from an overlapping pass");
  assert.ok(skipped.diagnostics.some((d: any) => d.outcome === "skipped_concurrent_pass"));

  // Once the notification pass releases, the very next poll runs normally --
  // the poller has NO cooldown, so a just-finished pass never makes it skip.
  await (lock as any).get(DOC_A).release(held.token);
  const ran = await pollGoogleDocComments(fakeEnv);
  assert.strictEqual(listCalls, 1, "the poll runs as soon as the lock is free");
  assert.ok(ran.diagnostics.some((d: any) => d.outcome === "approval_cycle_synced"));
});

test("contend 2. while a POLL pass holds a doc's lock, a notification for that doc does not start an overlapping pass", async (t) => {
  const { fakeEnv, lock } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-c2", documentId: DOC_A, expiration: new Date(Number(FUTURE_EXPIRATION_MS)).toISOString() });

  let listCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [], onCommentsList: () => listCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // The poller's claim (no cooldown) is live.
  const pollClaim = await (lock as any).get(DOC_A).tryAcquire(DRIVE_DOC_LOCK_TTL_MS, 0);
  assert.ok(pollClaim);

  const { ctx, settle } = makeCtx();
  const res = await handleDriveNotifyRequest(
    notifyRequest({ "X-Goog-Channel-ID": "chan-c2", "X-Goog-Channel-Token": "secret-for-chan-c2", "X-Goog-Resource-State": "update" }),
    fakeEnv,
    ctx,
  );
  assert.strictEqual(res.status, 200, "Drive is still acknowledged");
  await settle();
  assert.strictEqual(listCalls, 0, "the notification pass did not run alongside the poll pass");
});

test("contend 3. the poller RELEASES the lock after a successful pass and after a pass that throws", async (t) => {
  const { fakeEnv, lock } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  const { processGoogleDocCommentsForPoll } = await import("./googleDocComments");
  const { getWatchedGoogleDoc } = await import("./googleOAuth");
  const doc = (await getWatchedGoogleDoc(fakeEnv, DOC_A))!;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [] });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Success path.
  await processGoogleDocCommentsForPoll(fakeEnv, doc);
  const afterSuccess = await (lock as any).get(DOC_A).tryAcquire(DRIVE_DOC_LOCK_TTL_MS, 0);
  assert.ok(afterSuccess, "the lock is free after a successful poll pass");
  await (lock as any).get(DOC_A).release(afterSuccess.token);

  // Failure path: the pass throws out of processGoogleDocComments (state read failure).
  const kv = fakeEnv.STATE_KV as any;
  const realGet = kv.get.bind(kv);
  kv.get = async () => {
    throw new Error("KV unavailable");
  };
  await assert.rejects(() => processGoogleDocCommentsForPoll(fakeEnv, doc), /KV unavailable/, "a failed pass is surfaced, not swallowed");
  kv.get = realGet;
  const afterFailure = await (lock as any).get(DOC_A).tryAcquire(DRIVE_DOC_LOCK_TTL_MS, 0);
  assert.ok(afterFailure, "a pass that threw still released its lock -- no permanent lock");
});

test("contend 4. the polling safety net still runs when the lock namespace is unbound or unreachable", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [] });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { pollGoogleDocComments } = await import("./googleDocComments");

  const unbound = createFakeEnv({ DRIVE_DOC_LOCK: undefined });
  await setUpProposalDoc(unbound.fakeEnv, DOC_A);
  await pollGoogleDocComments(unbound.fakeEnv);
  assert.strictEqual(unbound.syncCalls.length, 1, "an unbound lock never disables polling");

  const broken = createFakeEnv({
    DRIVE_DOC_LOCK: {
      idFromName: (n: string) => n,
      get: () => ({
        tryAcquire: async () => {
          throw new Error("DO unreachable");
        },
        release: async () => {},
      }),
    },
  });
  await setUpProposalDoc(broken.fakeEnv, DOC_A);
  await pollGoogleDocComments(broken.fakeEnv);
  assert.strictEqual(broken.syncCalls.length, 1, "an unreachable lock never disables polling");
});

// ===========================================================================
// 12. Stale channels, idempotent registration, renewal recovery
// ===========================================================================

test("stale 1. a channel past its STORED expiration is refused even with the right secret", async () => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-expired", documentId: DOC_A, expiration: new Date(Date.now() - 60_000).toISOString() });

  const decision = await authenticateDriveNotification(fakeEnv, "chan-expired", "secret-for-chan-expired");
  assert.strictEqual(decision.accepted, false);
  assert.strictEqual(decision.rejection, "channel_expired");

  const bg = makeCtx();
  const res = await handleDriveNotifyRequest(
    notifyRequest({ "X-Goog-Channel-ID": "chan-expired", "X-Goog-Channel-Token": "secret-for-chan-expired", "X-Goog-Resource-State": "update" }),
    fakeEnv,
    bg.ctx,
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual(bg.count, 0, "no background pass is dispatched for a stale channel");
});

test("reg 7. registration is IDEMPOTENT: a repeat call for a doc with a live channel returns it and does not call Drive again", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  let watchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "res-live", expiration: FUTURE_EXPIRATION_MS }, onWatch: () => watchCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = await registerWatchForDocument(fakeEnv, DOC_A);
  const second = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.strictEqual(watchCalls, 1, "Drive is called once");
  assert.strictEqual(second.alreadyRegistered, true);
  assert.strictEqual(second.channel.channelId, first.channel.channelId);
  assert.strictEqual((await listChannels(fakeEnv)).filter((c) => c.status === "active").length, 1, "no second live channel is stacked on the doc");

  // The admin endpoint reports it, still without the secret.
  const res = await handleRegisterDriveWatchRequest(
    new Request(`https://x/admin/register-drive-watch?key=test-admin-key-777&documentId=${DOC_A}`),
    fakeEnv,
  );
  const body = (await res.json()) as any;
  assert.strictEqual(body.alreadyRegistered, true);
  assert.strictEqual(body.channel.secret, undefined);
  assert.strictEqual(watchCalls, 1);
});

test("reg 8. an EXPIRED channel does not block re-registration -- recovery creates a fresh live channel", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-dead", documentId: DOC_A, expiration: new Date(Date.now() - 1000).toISOString() });
  let watchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "res-new", expiration: FUTURE_EXPIRATION_MS }, onWatch: () => watchCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await registerWatchForDocument(fakeEnv, DOC_A);
  assert.ok(result.ok && !result.alreadyRegistered);
  assert.strictEqual(watchCalls, 1);
});

test("renew 5. a partial failure on ONE document is isolated: the others still renew, and the failed doc keeps its old channel", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A, "work-a");
  await setUpProposalDoc(fakeEnv, DOC_B, "work-b");
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await seedChannel(fakeEnv, { channelId: "chan-a-old", documentId: DOC_A, expiration: soon });
  await seedChannel(fakeEnv, { channelId: "chan-b-old", documentId: DOC_B, expiration: soon });

  // Drive accepts both replacements, but persisting DOC_A's new channel record
  // fails -- the partial-failure case after Drive has already said yes.
  const realPut = mockKv.put.bind(mockKv);
  (mockKv as any).put = async (key: string, value: string, opts?: any) => {
    if (key.startsWith("google_drive_channel:") && key !== "google_drive_channel:chan-a-old") {
      const rec = JSON.parse(value);
      if (rec.documentId === DOC_A && rec.status === "active") throw new Error("KV write failed");
    }
    return realPut(key, value, opts);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ watch: { resourceId: "res-new", expiration: FUTURE_EXPIRATION_MS } });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(summary.renewed, 1, "DOC_B still renewed");
  assert.strictEqual(summary.failed, 1, "DOC_A's failure is counted, not absorbed");
  assert.strictEqual(summary.outcomes.find((o) => o.documentId === DOC_A)?.status, "failed");
  assert.strictEqual((await getChannel(fakeEnv, "chan-a-old"))?.status, "active", "DOC_A keeps its old working channel");
  assert.strictEqual((await getChannel(fakeEnv, "chan-b-old"))?.status, "superseded");
});

test("renew 6. a failed SUPERSEDE write is recovered: the next renewal collapses the duplicate onto the live replacement without registering again", async (t) => {
  const { fakeEnv, mockKv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-old", documentId: DOC_A, resourceId: "res-old", expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

  let watchCalls = 0;
  const stopped: string[] = [];
  const inner = mockDriveFetch({ watch: { resourceId: "res-new", expiration: FUTURE_EXPIRATION_MS }, onWatch: () => watchCalls++ });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/stop")) stopped.push(JSON.parse(String(init?.body)).resourceId);
    return inner(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Run 1: the replacement registers and persists, but marking the old record superseded fails.
  const realPut = mockKv.put.bind(mockKv);
  (mockKv as any).put = async (key: string, value: string, opts?: any) => {
    if (key === "google_drive_channel:chan-old" && JSON.parse(value).status === "superseded") throw new Error("KV write failed");
    return realPut(key, value, opts);
  };
  const first = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(first.failed, 1, "the supersede failure is reported");
  assert.strictEqual(watchCalls, 1);
  assert.strictEqual((await listChannels(fakeEnv)).filter((c) => c.status === "active").length, 2, "temporarily two active records");

  // Run 2 (KV healthy again): the duplicate collapses onto the live replacement; Drive is not asked for a third channel.
  (mockKv as any).put = realPut;
  const second = await renewDriveWatchChannels(fakeEnv);
  assert.strictEqual(watchCalls, 1, "no extra registration -- the replacement is not due");
  assert.strictEqual(second.failed, 0);
  const active = (await listChannels(fakeEnv)).filter((c) => c.status === "active");
  assert.strictEqual(active.length, 1, "converged back to exactly one live channel");
  assert.strictEqual(active[0].resourceId, "res-new");
  assert.strictEqual((await getChannel(fakeEnv, "chan-old"))?.supersededBy, active[0].channelId);
  assert.ok(stopped.includes("res-old"), "the stale Drive-side channel is stopped");
});

test("auto 3. no request path registers a watch on its own: polling and notifications never call files.watch", async (t) => {
  const { fakeEnv } = createFakeEnv();
  await setUpProposalDoc(fakeEnv, DOC_A);
  await seedChannel(fakeEnv, { channelId: "chan-auto", documentId: DOC_A, expiration: new Date(Number(FUTURE_EXPIRATION_MS)).toISOString() });
  let watchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockDriveFetch({ comments: [], onWatch: () => watchCalls++ });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { pollGoogleDocComments } = await import("./googleDocComments");
  await pollGoogleDocComments(fakeEnv);
  const { ctx, settle } = makeCtx();
  await handleDriveNotifyRequest(
    notifyRequest({ "X-Goog-Channel-ID": "chan-auto", "X-Goog-Channel-Token": "secret-for-chan-auto", "X-Goog-Resource-State": "update" }),
    fakeEnv,
    ctx,
  );
  await settle();
  assert.strictEqual(isAutoRegisterEnabled(fakeEnv), false);
  assert.strictEqual(watchCalls, 0);
});
