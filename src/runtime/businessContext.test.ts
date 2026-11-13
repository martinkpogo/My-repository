import test from "node:test";
import assert from "node:assert";
import type { Env } from "../types";
import type { AiTask } from "../ai/types";
import { augmentTaskWithBusinessContext, BUSINESS_CONTEXT_TASKS, CONSULTANCY_PROFILE_PAGE_ID } from "./businessContext";

/**
 * Every Hat knows what ENIG is (2026-11-13): the canonical Consultancy
 * Profile, read live from Notion, joins every Hat step -- never routing or
 * extraction -- and an unreadable Profile never stops the step.
 */

function env(profile: string | null): Env {
  return {
    STATE_KV: { get: async (k: string) => (k === `governance:${CONSULTANCY_PROFILE_PAGE_ID}` ? profile : null), put: async () => {}, delete: async () => {} },
    NOTION_TOKEN: "n",
    NOTION_VERSION: "2025-09-03",
  } as unknown as Env;
}
function task(taskId: string): AiTask {
  return {
    taskId,
    type: "json",
    boundaryContext: { segments: [{ type: "system", content: "persona", provenance: "p" }] },
    messages: [
      { role: "system", content: "persona" },
      { role: "user", content: "what should I talk about?" },
    ],
  } as AiTask;
}

test("every Hat step gets the Profile; routing, extraction, verification and research steps never do", () => {
  for (const id of ["chat.general_reply", "marketing.hat_action_decision", "strategy.diagnosis", "finance.quote_judgment", "sales.call_qualification", "business_development.develop_opportunity"]) assert.ok(BUSINESS_CONTEXT_TASKS.has(id as any), id);
  for (const id of ["chat.data_lookup", "marketing.intake_classification", "sales.enquiry_extraction", "work.result_verification", "research.synthesis", "runtime.research_need"]) assert.ok(!BUSINESS_CONTEXT_TASKS.has(id as any), id);
});

test("a Hat step gets the canonical Profile as labelled context, held to the step's own sensitivity", async () => {
  const out = await augmentTaskWithBusinessContext(env("ENIG solves positioning, perception and communication problems."), task("marketing.hat_action_decision"));
  assert.match(out.messages[0].content, /=== ENIG CONSULTANCY PROFILE \(canonical, read live from Notion\) ===\n[^\n]*not evidence about any client[\s\S]*positioning, perception and communication[\s\S]*=== END ENIG CONSULTANCY PROFILE ===/);
  const seg = out.boundaryContext.segments.at(-1)!;
  assert.strictEqual(seg.provenance, "runtime:consultancy_profile");
  assert.strictEqual(seg.sensitivity, "business_sensitive", "the step's own effective level (marketing.hat_action_decision's task level)");
});

test("a step whose segments are stamped lower than its task default (ENIG's chat) gets the Profile at that same stamped level -- never the stricter default that would lock every provider out", async () => {
  const enig = {
    taskId: "chat.general_reply",
    type: "text",
    boundaryContext: { segments: [{ type: "system", content: "s", provenance: "s", sensitivity: "business_sensitive" }, { type: "user", content: "u", provenance: "u", sensitivity: "business_sensitive" }] },
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
  } as AiTask;
  const out = await augmentTaskWithBusinessContext(env("ENIG profile"), enig);
  assert.strictEqual(out.boundaryContext.segments.at(-1)!.sensitivity, "business_sensitive");
  assert.ok(out.boundaryContext.segments.every((s) => s.sensitivity === "business_sensitive"), "no segment above the step's own level");
});

test("a step outside the set is untouched", async () => {
  const t = task("marketing.intake_classification");
  assert.strictEqual(await augmentTaskWithBusinessContext(env("x"), t), t);
});

test("an unreadable Profile never stops the step: it runs unchanged", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const t0 = task("chat.general_reply");
  assert.strictEqual(await augmentTaskWithBusinessContext(env(null), t0), t0);
});
