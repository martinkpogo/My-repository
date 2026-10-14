import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cachedWatchRegistry, invalidateWatchRegistry, type CacheLike } from "./watchRegistryCache";

function fakeCache(): CacheLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async match(request) {
      const body = store.get(request.url);
      return body === undefined ? undefined : new Response(body);
    },
    async put(request, response) {
      store.set(request.url, await response.text());
    },
    async delete(request) {
      return store.delete(request.url);
    },
  };
}

test("second read within the TTL is served from the cache, not the loader", async () => {
  const cache = fakeCache();
  let loads = 0;
  const load = async () => (loads++, [{ id: "a" }]);
  assert.deepEqual(await cachedWatchRegistry("docs", load, { cache }), [{ id: "a" }]);
  assert.deepEqual(await cachedWatchRegistry("docs", load, { cache }), [{ id: "a" }]);
  assert.equal(loads, 1);
});

test("docs and sheets are cached separately", async () => {
  const cache = fakeCache();
  assert.deepEqual(await cachedWatchRegistry("docs", async () => [{ d: 1 }], { cache }), [{ d: 1 }]);
  assert.deepEqual(await cachedWatchRegistry("sheets", async () => [{ s: 1 }], { cache }), [{ s: 1 }]);
});

test("invalidate drops the entry so the next read loads the current list", async () => {
  const cache = fakeCache();
  let current = [{ id: "a" }];
  const load = async () => current;
  await cachedWatchRegistry("docs", load, { cache });
  current = [{ id: "a" }, { id: "b" }];
  await invalidateWatchRegistry("docs", cache);
  assert.deepEqual(await cachedWatchRegistry("docs", load, { cache }), current);
});

test("fresh: true bypasses a cached list and refreshes it", async () => {
  const cache = fakeCache();
  await cachedWatchRegistry("docs", async () => [{ id: "old" }], { cache });
  assert.deepEqual(await cachedWatchRegistry("docs", async () => [{ id: "new" }], { cache, fresh: true }), [{ id: "new" }]);
  assert.deepEqual(await cachedWatchRegistry("docs", async () => [{ id: "unused" }], { cache }), [{ id: "new" }]);
});

test("no cache available (tests, local): always loads", async () => {
  let loads = 0;
  const load = async () => (loads++, [1]);
  await cachedWatchRegistry("docs", load, { cache: undefined });
  await cachedWatchRegistry("docs", load, { cache: undefined });
  assert.equal(loads, 2);
});

test("a failing cache never breaks the read: match, put and delete errors fall through", async () => {
  const broken: CacheLike = {
    async match() { throw new Error("match down"); },
    async put() { throw new Error("put down"); },
    async delete() { throw new Error("delete down"); },
  };
  assert.deepEqual(await cachedWatchRegistry("docs", async () => [{ id: "x" }], { cache: broken }), [{ id: "x" }]);
  await invalidateWatchRegistry("docs", broken);
});

test("registering a Doc or Sheet invalidates its cached list, and the account re-point reads fresh", () => {
  const src = readFileSync(join(__dirname, "googleOAuth.ts"), "utf8");
  assert.match(src, /JSON\.stringify\(doc\)\);\s*await invalidateWatchRegistry\("docs"\)/);
  assert.match(src, /JSON\.stringify\(sheet\)\);\s*await invalidateWatchRegistry\("sheets"\)/);
  assert.match(src, /listWatchedGoogleDocs\(env, \{ fresh: true \}\)/);
});

test("discovery-run timestamps are throttled heartbeats, never a write per run", () => {
  for (const file of ["index.ts", "checkHandoffs.ts"]) {
    const src = readFileSync(join(__dirname, file), "utf8");
    assert.doesNotMatch(src, /kvPut\(env, "last_(native_)?cron_run"/, `${file} writes a cron timestamp on every run`);
  }
  const index = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.match(index, /kvPutHeartbeat\(env, "last_native_cron_run", CRON_STAMP_MIN_INTERVAL_MS\)/);
});
