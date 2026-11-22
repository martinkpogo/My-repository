import test from "node:test";
import assert from "node:assert";
import {
  listDriveFolderContents,
  getMyDriveRoot,
} from "./googleDriveBrowse";

// Fetch replacement pattern copied from src/googleOAuth.test.ts: assign
// globalThis.fetch, restore it in finally, so no test leaks into the next.
type FetchCall = { url: string; init?: RequestInit };

async function withMockFetch(
  mock: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return mock(String(url), init);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a) exactly one fetch with the exact q, orderBy, pageSize, fields and Authorization header", async () => {
  await withMockFetch(
    () => jsonResponse({ files: [] }),
    async (calls) => {
      const result = await listDriveFolderContents("token-abc123", "parent_1-2");
      assert.strictEqual(result.ok, true);
      assert.strictEqual(calls.length, 1, "EXACTLY one fetch call");

      const url = new URL(calls[0].url);
      assert.strictEqual(`${url.origin}${url.pathname}`, "https://www.googleapis.com/drive/v3/files");
      assert.strictEqual(url.searchParams.get("q"), "'parent_1-2' in parents and trashed=false");
      assert.strictEqual(url.searchParams.get("orderBy"), "folder,name");
      assert.strictEqual(url.searchParams.get("pageSize"), "1000");
      assert.strictEqual(url.searchParams.get("fields"), "files(id,name,mimeType,webViewLink),nextPageToken");

      assert.strictEqual(calls[0].init?.method, "GET");
      const headers = new Headers(calls[0].init?.headers);
      assert.strictEqual(headers.get("Authorization"), "Bearer token-abc123");
    },
  );
});

test("b) mixed scrambled response -> folders first, then files, each A-Z ignoring case", async () => {
  await withMockFetch(
    () =>
      jsonResponse({
        files: [
          { id: "f1", name: "zeta.txt", mimeType: "text/plain" },
          { id: "d1", name: "banana", mimeType: "application/vnd.google-apps.folder" },
          { id: "f2", name: "Alpha.txt", mimeType: "text/plain" },
          { id: "d2", name: "apple", mimeType: "application/vnd.google-apps.folder" },
          { id: "f3", name: "beta.txt", mimeType: "application/pdf" },
          { id: "d3", name: "Citrus", mimeType: "application/vnd.google-apps.folder" },
        ],
      }),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.deepStrictEqual(
        result.items.map((item) => item.name),
        ["apple", "banana", "Citrus", "Alpha.txt", "beta.txt", "zeta.txt"],
        "folders first then files, each group A-Z case-insensitive",
      );
      assert.deepStrictEqual(
        result.items.map((item) => item.kind),
        ["folder", "folder", "folder", "file", "file", "file"],
      );
    },
  );
});

test("c) nextPageToken present -> truncated true, still exactly one fetch call", async () => {
  await withMockFetch(
    () =>
      jsonResponse({
        files: [{ id: "f1", name: "a.txt", mimeType: "text/plain" }],
        nextPageToken: "page-2-token",
      }),
    async (calls) => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(calls.length, 1, "nextPageToken must never trigger a second request");
    },
  );
});

test("d) empty folder (files: []) -> ok, items []", async () => {
  await withMockFetch(
    () => jsonResponse({ files: [] }),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.deepStrictEqual(result, { ok: true, items: [], truncated: false });
    },
  );
});

test("e) missing files key -> ok, items []", async () => {
  await withMockFetch(
    () => jsonResponse({}),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.deepStrictEqual(result, { ok: true, items: [], truncated: false });
    },
  );
});

test("f) HTTP 401 and HTTP 500 -> ok false, reason http, the right status", async () => {
  for (const status of [401, 500]) {
    await withMockFetch(
      () => new Response("denied", { status }),
      async () => {
        const result = await listDriveFolderContents("tok", "parent123");
        assert.deepStrictEqual(result, { ok: false, reason: "http", status });
      },
    );
  }
});

test("g) fetch throws -> ok false, reason network", async () => {
  await withMockFetch(
    () => {
      throw new Error("connection reset");
    },
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.deepStrictEqual(result, { ok: false, reason: "network" });
    },
  );
});

test("h) invalid JSON body -> ok false, reason malformed", async () => {
  await withMockFetch(
    () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.deepStrictEqual(result, { ok: false, reason: "malformed" });
    },
  );
});

test("i) invalid parent ids -> ok false, reason invalid_parent, ZERO fetch calls", async () => {
  for (const parentId of ["abc'; drop", ""]) {
    await withMockFetch(
      () => jsonResponse({ files: [] }),
      async (calls) => {
        const result = await listDriveFolderContents("tok", parentId);
        assert.deepStrictEqual(result, { ok: false, reason: "invalid_parent" });
        assert.strictEqual(calls.length, 0, `no fetch for invalid parentId ${JSON.stringify(parentId)}`);
      },
    );
  }
});

test("j) shortcut mimeType -> kind file", async () => {
  await withMockFetch(
    () =>
      jsonResponse({
        files: [{ id: "s1", name: "Link to doc", mimeType: "application/vnd.google-apps.shortcut" }],
      }),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.strictEqual(result.items[0].kind, "file");
    },
  );
});

test("k) entries missing id or name are skipped, the others are kept", async () => {
  await withMockFetch(
    () =>
      jsonResponse({
        files: [
          { name: "no-id.txt", mimeType: "text/plain" },
          { id: "no-name-id", mimeType: "text/plain" },
          null,
          { id: "kept-id", name: "kept.txt", mimeType: "text/plain" },
        ],
      }),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.strictEqual(result.items.length, 1);
      assert.strictEqual(result.items[0].id, "kept-id");
      assert.strictEqual(result.items[0].name, "kept.txt");
    },
  );
});

test("l) webViewLink is passed through when present, omitted when absent", async () => {
  await withMockFetch(
    () =>
      jsonResponse({
        files: [
          { id: "a", name: "linked.txt", mimeType: "text/plain", webViewLink: "https://drive.google.com/file/d/a/view" },
          { id: "b", name: "plain.txt", mimeType: "text/plain" },
        ],
      }),
    async () => {
      const result = await listDriveFolderContents("tok", "parent123");
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      const [linked, plain] = result.items;
      assert.strictEqual(linked.webViewLink, "https://drive.google.com/file/d/a/view");
      assert.strictEqual(plain.webViewLink, undefined);
    },
  );
});

test("m) getMyDriveRoot: exactly one fetch to files/root with id,name fields and Bearer auth", async () => {
  await withMockFetch(
    () => jsonResponse({ id: "0AAbc_123-x", name: "My Drive" }),
    async (calls) => {
      const result = await getMyDriveRoot("token-abc123");
      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.strictEqual(calls.length, 1, "EXACTLY one fetch call");
      assert.strictEqual(calls[0].url, "https://www.googleapis.com/drive/v3/files/root?fields=id,name");
      assert.strictEqual(calls[0].init?.method, "GET");
      const headers = new Headers(calls[0].init?.headers);
      assert.strictEqual(headers.get("Authorization"), "Bearer token-abc123");
      assert.deepStrictEqual(result, { ok: true, id: "0AAbc_123-x", name: "My Drive" });
    },
  );
});

test("n) getMyDriveRoot: missing or empty name -> ok, name \"My Drive\"", async () => {
  for (const body of [{ id: "0AAbc_123-x" }, { id: "0AAbc_123-x", name: "" }]) {
    await withMockFetch(
      () => jsonResponse(body),
      async () => {
        const result = await getMyDriveRoot("tok");
        assert.deepStrictEqual(result, { ok: true, id: "0AAbc_123-x", name: "My Drive" });
      },
    );
  }
});

test("o) getMyDriveRoot: id === \"root\" -> ok false, reason malformed", async () => {
  await withMockFetch(
    () => jsonResponse({ id: "root", name: "My Drive" }),
    async () => {
      const result = await getMyDriveRoot("tok");
      assert.deepStrictEqual(result, { ok: false, reason: "malformed" });
    },
  );
});

test("p) getMyDriveRoot: id missing / not a string / contains / or ' -> reason malformed", async () => {
  for (const body of [
    { name: "My Drive" },
    { id: 12345, name: "My Drive" },
    { id: "a/b", name: "My Drive" },
    { id: "a'b", name: "My Drive" },
    { id: "a;b", name: "My Drive" },
  ]) {
    await withMockFetch(
      () => jsonResponse(body),
      async () => {
        const result = await getMyDriveRoot("tok");
        assert.deepStrictEqual(result, { ok: false, reason: "malformed" });
      },
    );
  }
});

test("q) getMyDriveRoot: HTTP 401 and HTTP 404 -> reason http with status", async () => {
  for (const status of [401, 404]) {
    await withMockFetch(
      () => new Response("denied", { status }),
      async () => {
        const result = await getMyDriveRoot("tok");
        assert.deepStrictEqual(result, { ok: false, reason: "http", status });
      },
    );
  }
});

test("r) getMyDriveRoot: fetch throws -> reason network", async () => {
  await withMockFetch(
    () => {
      throw new Error("connection reset");
    },
    async () => {
      const result = await getMyDriveRoot("tok");
      assert.deepStrictEqual(result, { ok: false, reason: "network" });
    },
  );
});

test("s) getMyDriveRoot: invalid JSON body -> reason malformed", async () => {
  await withMockFetch(
    () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      const result = await getMyDriveRoot("tok");
      assert.deepStrictEqual(result, { ok: false, reason: "malformed" });
    },
  );
});
