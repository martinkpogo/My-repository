/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { handleMarketingIntake } from "./marketingManifest";
import type { Env, WorkState } from "../../types";

/**
 * Martin's real messages, 2026-11-18. These pin the routing outcome and the
 * wording the Hat sees for the three messages that exposed the problem:
 *
 *  - "Plan a campaign to get more clients" stayed with Marketing Strategist
 *    (it did not hand the whole job to a later step).
 *  - "Write a strategy that will be used to develop content" stayed with
 *    Marketing Strategist, because the strategy is its own even though
 *    content will later be built from it.
 *  - "Turn the approved strategy into content themes" went to Content
 *    Strategist, which owns the content strategy built from that direction.
 *
 * The AI provider is a queued mock: Stage 1 names the candidate the
 * classifier would return, then the Hat's own deciding/drafting passes run.
 * The point is the deterministic outcome and the prompt the Hat receives,
 * not a live model's judgement.
 */

const WORKSPACE_CHAT = -999;
const WORKSPACE_THREAD = 604;

interface AiCall {
  model: string;
  system: string;
  user: string;
}

interface Harness {
  env: Env;
  aiCalls: AiCall[];
  sentMessages: string[];
  logBodies: string[];
}

function makeHarness(t: any, responses: string[]): Harness {
  const aiCalls: AiCall[] = [];
  let call = 0;
  const sentMessages: string[] = [];
  const logBodies: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("api.telegram.org")) {
      try {
        const body = JSON.parse(init?.body ?? "{}");
        if (body.text) sentMessages.push(body.text);
      } catch {
        // editMessageText and text-less actions carry no capturable text
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (u.includes("/blocks/") && u.includes("/children")) {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Governance content." }] } }] }),
        { status: 200 },
      );
    }
    if (method === "GET" && u.includes("/v1/pages/")) {
      const id = u.split("/v1/pages/").pop()!.split("?")[0];
      return new Response(JSON.stringify({ id, url: u, parent: { type: "page", page_id: "governance-root" }, properties: {} }), { status: 200 });
    }
    if (method === "POST" && u.endsWith("/v1/pages")) {
      logBodies.push(init?.body ?? "");
      return new Response(JSON.stringify({ id: "log-entry", url: "https://notion.so/log-entry", parent: { type: "data_source_id", data_source_id: "activity-log-ds" }, properties: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in marketingRealMessageRouting test: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_GROUP_CHAT_ID: String(WORKSPACE_CHAT),
    WORKSPACE_TOPIC_ID: String(WORKSPACE_THREAD),
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    AI_MODEL_PRIMARY: "test-primary",
    AI_MODEL_LIGHT: "test-light",
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
    AI: {
      run: async (model: string, opts: any) => {
        aiCalls.push({ model, system: String(opts?.messages?.[0]?.content ?? ""), user: String(opts?.messages?.[1]?.content ?? "") });
        const response = responses[Math.min(call++, responses.length - 1)] ?? "null";
        return { response };
      },
    },
  } as Env;

  return { env, aiCalls, sentMessages, logBodies };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function workState(): WorkState {
  return {
    workId: "work-real-message-1",
    chatId: 12345,
    threadId: 777,
    unit: "Marketing",
    hat: "Marketing",
    stage: "new",
    marketing: { taskText: "" },
  } as WorkState;
}

function allPromptText(h: Harness): string {
  return h.aiCalls.map((c) => `${c.system}\n${c.user}`).join("\n");
}

const DRAFT = json({
  action: "draft",
  draft: "The marketing plan and strategy: audience, goals, core message, channels, targets.",
  involves_spend: false,
  next_step: { to_hat: "Content Strategist", for_what: "turn it into content themes and briefs" },
});

test('"Plan a campaign to get more clients" stays with Marketing Strategist and plans the campaign itself', async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist"], establishing: false, reason: "sets the campaign plan and strategy" }), DRAFT]);

  const result = await handleMarketingIntake(h.env, workState(), "Plan a campaign to get more clients");

  assert.strictEqual(result.hat, "Marketing Strategist");
  assert.strictEqual(result.stage, "awaiting_marketing_draft_approval");
  assert.strictEqual(result.marketing?.pendingNextStep?.toHat, "Content Strategist");
  assert.ok(!h.sentMessages.some((m) => m.includes("Proposed handing this to")), "a later step must not make the Hat hand on the whole request");
  const prompt = allPromptText(h);
  assert.match(prompt, /never hand on the whole request just because a later step belongs to another Hat/);
  assert.match(prompt, /Usually hands over to/);
  assert.match(prompt, /Content Strategist -- to turn it into content themes and briefs/);
  assert.match(prompt, /The Consultancy Profile describes what/);
});

test('"Write a strategy that will be used to develop content" stays with Marketing Strategist -- content later does not move the strategy', async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Marketing Strategist"], establishing: false, reason: "owns the strategy even when content follows" }), DRAFT]);

  const result = await handleMarketingIntake(h.env, workState(), "Write a strategy that will be used to develop content");

  assert.strictEqual(result.hat, "Marketing Strategist");
  assert.strictEqual(result.stage, "awaiting_marketing_draft_approval");
  assert.ok(!h.sentMessages.some((m) => m.includes("Proposed handing this to")), "the strategy is this Hat's own work, not a whole-request handoff");
  const prompt = allPromptText(h);
  assert.match(prompt, /including when content will later be built from it/);
  assert.match(prompt, /Content strategy -- the content themes, pillars and briefs built from the marketing direction/);
  assert.match(prompt, /Owning the marketing plan and strategy is not limited by content later being built from it/);
});

test('"Turn the approved strategy into content themes" goes to Content Strategist', async (t) => {
  const h = makeHarness(t, [json({ candidates: ["Content Strategist"], establishing: false, reason: "builds content strategy from the approved direction" }), DRAFT]);

  const result = await handleMarketingIntake(h.env, workState(), "Turn the approved strategy into content themes");

  assert.strictEqual(result.hat, "Content Strategist");
  assert.strictEqual(result.stage, "awaiting_marketing_draft_approval");
  const prompt = allPromptText(h);
  assert.match(prompt, /built from whatever marketing direction exists/);
  assert.match(prompt, /The marketing plan and strategy -- audience, goals, core message, channels and targets \(Marketing Strategist\)/);
  assert.match(prompt, /Content Manager -- to build the content calendar and production/);
});
