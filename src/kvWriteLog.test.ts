import test from "node:test";
import assert from "node:assert/strict";
import { kvKeyClass, kvPut } from "./kvStore";
import type { Env } from "./types";

test("kvKeyClass keeps the prefix up to the first colon and drops the identifying suffix", () => {
  assert.equal(kvKeyClass("google_comment_processed:AAACIWH0Yuk"), "google_comment_processed:");
  assert.equal(kvKeyClass("google_oauth_tokens:person@example.com"), "google_oauth_tokens:");
  assert.equal(kvKeyClass("handoff_workitem:3f3cb004-e583-8124"), "handoff_workitem:");
  assert.equal(kvKeyClass("last_cron_run"), "last_cron_run");
  assert.equal(kvKeyClass("a:b:c"), "a:");
});

test("kvPut logs one kv_write line with the key class and never the key suffix", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  const puts: string[] = [];
  try {
    const env = { STATE_KV: { put: async (k: string) => void puts.push(k) } } as unknown as Env;
    await kvPut(env, "google_oauth_tokens:person@example.com", "v");
  } finally {
    console.log = original;
  }
  assert.deepEqual(puts, ["google_oauth_tokens:person@example.com"]);
  assert.deepEqual(lines, ["kv_write class=google_oauth_tokens: path=put"]);
  assert.ok(!lines.join("\n").includes("person@example.com"));
});
