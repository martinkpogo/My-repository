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
