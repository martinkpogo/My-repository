import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_KEY_HEADER, constantTimeEqual, isAdminAuthorized } from "./adminAuth";

const KEY = "correct-horse-battery-staple";
const env = { WORKER_ADMIN_KEY: KEY };
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("authorized by the X-Worker-Admin-Key header", () => {
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x", { [ADMIN_KEY_HEADER]: KEY }), env), true);
});

test("authorized by ?key= (still accepted for schedulers and browser-opened OAuth links)", () => {
  assert.equal(isAdminAuthorized(req(`https://w.example/admin/x?key=${KEY}`), env), true);
});

test("fails closed: no credential, wrong credential, or empty credential", () => {
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x"), env), false);
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x?key=nope"), env), false);
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x", { [ADMIN_KEY_HEADER]: "nope" }), env), false);
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x?key="), env), false);
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x", { [ADMIN_KEY_HEADER]: "" }), env), false);
});

test("fails closed when the WORKER_ADMIN_KEY secret is not configured, even if the caller sends an empty or matching-looking value", () => {
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x?key="), { WORKER_ADMIN_KEY: "" }), false);
  assert.equal(isAdminAuthorized(req("https://w.example/admin/x?key=undefined"), { WORKER_ADMIN_KEY: undefined as unknown as string }), false);
});

test("when a header is sent it is the credential: a wrong header is not rescued by a correct ?key=", () => {
  assert.equal(isAdminAuthorized(req(`https://w.example/admin/x?key=${KEY}`, { [ADMIN_KEY_HEADER]: "wrong" }), env), false);
});

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("ADMIN_REJECT_QUERY_KEY on: ?key= is refused even when correct, the header still works", () => {
  for (const flag of ["1", "true", "TRUE", " 1 "]) {
    const strict = { WORKER_ADMIN_KEY: KEY, ADMIN_REJECT_QUERY_KEY: flag };
    assert.equal(isAdminAuthorized(req(`https://w.example/admin/x?key=${KEY}`), strict), false, flag);
    assert.equal(isAdminAuthorized(req("https://w.example/admin/x", { [ADMIN_KEY_HEADER]: KEY }), strict), true, flag);
    assert.equal(isAdminAuthorized(req(`https://w.example/admin/x?key=${KEY}`, { [ADMIN_KEY_HEADER]: KEY }), strict), true, flag);
  }
});

test("ADMIN_REJECT_QUERY_KEY off (unset, \"0\", or anything else): ?key= is still accepted", () => {
  for (const flag of [undefined, "", "0", "false", "yes"]) {
    assert.equal(isAdminAuthorized(req(`https://w.example/admin/x?key=${KEY}`), { WORKER_ADMIN_KEY: KEY, ADMIN_REJECT_QUERY_KEY: flag }), true, String(flag));
  }
});

test("the query channel logs path and outcome only: never the presented key, a wrong guess, or the query string", () => {
  const guess = "a-wrong-guess-value";
  const lines = captureLogs(() => {
    isAdminAuthorized(req(`https://w.example/admin/last-cron-run?key=${KEY}&x=1`), env);
    isAdminAuthorized(req(`https://w.example/admin/last-cron-run?key=${guess}`), env);
    isAdminAuthorized(req(`https://w.example/admin/last-cron-run?key=${KEY}`), { ...env, ADMIN_REJECT_QUERY_KEY: "1" });
  });
  assert.deepEqual(lines, [
    "admin_auth channel=query outcome=accepted path=/admin/last-cron-run",
    "admin_auth channel=query outcome=denied path=/admin/last-cron-run",
    "admin_auth channel=query outcome=rejected_by_policy path=/admin/last-cron-run",
  ]);
  for (const line of lines) assert.ok(!line.includes(KEY) && !line.includes(guess) && !line.includes("x=1"));
});

test("the header channel writes no log line, and no credential at all writes none", () => {
  const lines = captureLogs(() => {
    isAdminAuthorized(req("https://w.example/admin/x", { [ADMIN_KEY_HEADER]: KEY }), env);
    isAdminAuthorized(req("https://w.example/admin/x"), env);
  });
  assert.deepEqual(lines, []);
});

test("constantTimeEqual: equal, prefix, longer, shorter and multi-byte values", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("abcd", "abc"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual("é", "e"), false);
});

test("no source file compares the admin key inline: src/adminAuth.ts is the only place that does", () => {
  const dir = __dirname;
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "adminAuth.ts")
    .filter((f) => /[!=]==?\s*env\.WORKER_ADMIN_KEY|env\.WORKER_ADMIN_KEY\s*[!=]==?/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(offenders, []);
});
