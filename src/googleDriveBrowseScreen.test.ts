import test from "node:test";
import assert from "node:assert";
import type { BrowseAction, BrowseScreen } from "./googleDriveBrowseScreen";
import type { Env } from "./types";
import {
  saveBrowseScreen,
  readBrowseScreen,
  buildBrowseCallback,
  parseBrowseValue,
} from "./googleDriveBrowseScreen";
import { parseCallbackData } from "./telegramCallbackData";

// A real UUID work id (36 chars), as used by the flow.
const WORK_ID = "550e8400-e29b-41d4-a716-446655440000";
const SCREEN_ID = "ab12cd34";

const screen: BrowseScreen = {
  kind: "drivebrowse",
  folderId: "0AF8j3k2lm",
  folderName: "My Drive",
  items: [
    {
      id: "d1",
      name: "Receipts",
      kind: "folder",
      mimeType: "application/vnd.google-apps.folder",
    },
    { id: "f1", name: "notes.txt", kind: "file", mimeType: "text/plain" },
  ],
  truncated: false,
  context: { account: "martin@example.com", title: "Pick a folder", smoke: true },
};

interface TestEnv extends Env {
  puts: Array<{ key: string; value: string; ttl: number | undefined }>;
  gets: string[];
}

function env(
  store = new Map<string, string>(),
  failPut = false,
  failGet = false,
): TestEnv {
  // Simple in-memory STATE_KV fake with NO Turso settings, like the env()
  // helper at the top of src/telegramWebhookDedup.test.ts.
  const puts: TestEnv["puts"] = [];
  const gets: string[] = [];
  const e: TestEnv = {
    STATE_KV: {
      get: async (k: string) => {
        gets.push(k);
        if (failGet) throw new Error("kv down");
        return store.get(k) ?? null;
      },
      put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
        if (failPut) throw new Error("kv down");
        puts.push({ key: k, value: v, ttl: opts?.expirationTtl });
        store.set(k, v);
      },
      delete: async () => {
        // never called by this module; present to satisfy KVNamespace shape
      },
    },
    puts,
    gets,
  } as unknown as TestEnv;
  return e;
}

function keyFor(screenId: string): string {
  return `google_option:${WORK_ID}:${screenId}`;
}

test("a) save then read returns an identical screen, context included", async () => {
  const e = env();
  const result = await saveBrowseScreen(e, WORK_ID, screen);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(
    /^[a-f0-9]{8}$/.test(result.screenId),
    true,
    "screenId is 8 lowercase hex chars",
  );
  const back = await readBrowseScreen(e, WORK_ID, result.screenId);
  assert.deepStrictEqual(back, screen, "screen round-trips identically, context included");
});

test("b) save makes exactly ONE kvPut, to the right key, with expirationTtl 1800", async () => {
  const e = env();
  const result = await saveBrowseScreen(e, WORK_ID, screen);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(e.puts.length, 1, "exactly one kvPut");
  assert.strictEqual(e.puts[0].key, keyFor(result.screenId), "right key");
  assert.strictEqual(e.puts[0].ttl, 1800, "expirationTtl 1800");
  assert.deepStrictEqual(JSON.parse(e.puts[0].value), screen, "stored value is the screen JSON");
});

test("c) kvPut throws -> { ok: false }", async () => {
  const e = env(new Map<string, string>(), true);
  const result = await saveBrowseScreen(e, WORK_ID, screen);
  assert.deepStrictEqual(result, { ok: false });
});

test("d) read: missing key / invalid JSON / wrong kind -> null", async () => {
  const missing = env();
  assert.strictEqual(
    await readBrowseScreen(missing, WORK_ID, SCREEN_ID),
    null,
    "missing key -> null",
  );

  const badJson = env();
  await badJson.STATE_KV.put(keyFor(SCREEN_ID), "{not json");
  assert.strictEqual(
    await readBrowseScreen(badJson, WORK_ID, SCREEN_ID),
    null,
    "invalid JSON -> null",
  );

  const wrongKind = env();
  await wrongKind.STATE_KV.put(
    keyFor(SCREEN_ID),
    JSON.stringify({
      kind: "folderlist",
      folderId: "x",
      folderName: "y",
      items: [],
      truncated: false,
      context: {},
    }),
  );
  assert.strictEqual(
    await readBrowseScreen(wrongKind, WORK_ID, SCREEN_ID),
    null,
    "kind !== drivebrowse -> null",
  );

  const wrongFieldType = env();
  await wrongFieldType.STATE_KV.put(
    keyFor(SCREEN_ID),
    JSON.stringify({ ...screen, truncated: "yes" }),
  );
  assert.strictEqual(
    await readBrowseScreen(wrongFieldType, WORK_ID, SCREEN_ID),
    null,
    "wrong field type -> null",
  );
});

test("e) read with invalid screenId -> null and ZERO reads", async () => {
  const e = env();
  await e.STATE_KV.put(keyFor(SCREEN_ID), JSON.stringify(screen));
  for (const bad of ["ABC", "1234567", "../x"]) {
    assert.strictEqual(await readBrowseScreen(e, WORK_ID, bad), null, `${JSON.stringify(bad)} -> null`);
    assert.strictEqual(e.gets.length, 0, `${JSON.stringify(bad)} performs zero reads`);
  }
});

test("f) read does not delete the record (read twice, both succeed)", async () => {
  const e = env();
  const result = await saveBrowseScreen(e, WORK_ID, screen);
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const first = await readBrowseScreen(e, WORK_ID, result.screenId);
  const second = await readBrowseScreen(e, WORK_ID, result.screenId);
  assert.deepStrictEqual(first, screen);
  assert.deepStrictEqual(second, screen);
});

test("g) buildBrowseCallback: byte limit and index range", async () => {
  const ok = buildBrowseCallback(WORK_ID, SCREEN_ID, { type: "open", index: 999 });
  assert.strictEqual(typeof ok, "string");
  if (!ok) return;
  assert.strictEqual(
    ok,
    `googlefolder:${WORK_ID}:${SCREEN_ID}:o999`,
    "exact callback shape",
  );
  assert.ok(new TextEncoder().encode(ok).length <= 64, `at most 64 bytes: ${ok}`);

  assert.strictEqual(buildBrowseCallback(WORK_ID, SCREEN_ID, { type: "open", index: 1000 }), null, "index 1000 -> null");
  assert.strictEqual(buildBrowseCallback(WORK_ID, SCREEN_ID, { type: "open", index: -1 }), null, "index -1 -> null");
  assert.strictEqual(
    buildBrowseCallback(WORK_ID, SCREEN_ID, { type: "file", index: -1 }),
    null,
    "file index -1 -> null",
  );
  assert.strictEqual(
    buildBrowseCallback(WORK_ID, SCREEN_ID, { type: "open", index: 3.5 }),
    null,
    "non-integer -> null",
  );
});

test("j) buildBrowseCallback returns null when the result exceeds 64 bytes", async () => {
  // 41 ASCII chars -> 13 + 41 + 1 + 8 + 1 + 1 = 65 bytes > 64 -> null.
  const longAscii = "a".repeat(41);
  assert.strictEqual(
    buildBrowseCallback(longAscii, SCREEN_ID, { type: "save" }),
    null,
    "41-char ASCII workId with save exceeds 64 bytes -> null",
  );

  // "é" + 36 ASCII = 37 characters but 38 UTF-8 bytes:
  // 13 + 38 + 1 + 8 + 1 + 4 = 65 bytes > 64 -> null.
  // Proves bytes are counted, not characters.
  const longUtf8 = "é" + "a".repeat(36);
  assert.strictEqual(
    buildBrowseCallback(longUtf8, SCREEN_ID, { type: "open", index: 999 }),
    null,
    "37-char workId (38 UTF-8 bytes) with open 999 exceeds 64 bytes -> null",
  );
});

test("h) build -> parseCallbackData -> parseBrowseValue round-trips all four action types", async () => {
  const actions: BrowseAction[] = [
    { type: "open", index: 0 },
    { type: "open", index: 999 },
    { type: "file", index: 7 },
    { type: "save" },
    { type: "back" },
  ];
  for (const action of actions) {
    const callback = buildBrowseCallback(WORK_ID, SCREEN_ID, action);
    assert.strictEqual(typeof callback, "string", `callback exists for ${JSON.stringify(action)}`);
    if (!callback) return;
    const parsed = parseCallbackData(callback);
    assert.strictEqual(parsed.action, "googlefolder", "outer action is googlefolder");
    assert.strictEqual(parsed.workId, WORK_ID, "workId carried through");
    const browse = parseBrowseValue(parsed.value);
    assert.deepStrictEqual(
      browse,
      { screenId: SCREEN_ID, action },
      `round-trip of ${JSON.stringify(action)}`,
    );
  }
});

test("i) parseBrowseValue rejects malformed values", async () => {
  for (const bad of [
    "ab12cd34",
    "ab12cd34:",
    "ab12cd34:x",
    "ab12cd34:o",
    "ab12cd34:o07",
    "ab12cd34:o1000",
    "AB12CD34:s",
    "",
  ]) {
    assert.strictEqual(parseBrowseValue(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test("parseBrowseValue accepts the valid codes", async () => {
  const cases: Array<[string, BrowseAction]> = [
    ["ab12cd34:s", { type: "save" }],
    ["ab12cd34:b", { type: "back" }],
    ["ab12cd34:o0", { type: "open", index: 0 }],
    ["ab12cd34:o999", { type: "open", index: 999 }],
    ["ab12cd34:f7", { type: "file", index: 7 }],
  ];
  for (const [value, expected] of cases) {
    assert.deepStrictEqual(
      parseBrowseValue(value),
      { screenId: SCREEN_ID, action: expected },
      `accepts ${JSON.stringify(value)}`,
    );
  }
});
