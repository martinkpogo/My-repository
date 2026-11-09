import test from "node:test";
import assert from "node:assert";
import { buildStructureFacts, generalDmReply, ENIG_HAT_DEFINITION_PAGE_ID, ENIG_UNAVAILABLE_MESSAGE } from "./chat";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "./governance";
import { ALL_HATS } from "./hats/registry";
import type { Env } from "./types";

/**
 * chat.ts: the structure facts every chat reply is grounded in, and ENIG --
 * the Operations Hat Martin talks to when he addresses no Unit -- which
 * reads its definition live from Notion and fails closed without it.
 */

function createMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-ds",
    AI_MODEL_LIGHT: "test-light-model",
    AI_MODEL_PRIMARY: "test-primary-model",
    STATE_KV: createMockKv() as any,
    ...overrides,
  } as Env;
}

function mockNotionFetch(t: any, resultsByDataSource: Record<string, any[]>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const match = /\/data_sources\/([^/]+)\/query/.exec(String(url));
    if (match) return new Response(JSON.stringify({ results: resultsByDataSource[match[1]] ?? [] }), { status: 200 });
    // Any page/block read (the governance pages when uncached) is unreadable.
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("buildStructureFacts: lists every registered Hat, so the facts can't drift from the router's own registry", () => {
  const facts = buildStructureFacts();
  for (const hat of ALL_HATS) assert.ok(facts.includes(hat.name), `facts must name ${hat.name}`);
  assert.doesNotMatch(facts, /ZERO Hats/, "the old hand-written claim that most Units had no Hats is gone");
});

test("buildStructureFacts: says which Units can start governed work from chat, from the manifest registry", () => {
  const facts = buildStructureFacts();
  for (const unit of ["Sales", "Marketing", "Business Development", "Finance", "Strategy"]) {
    assert.match(facts, new RegExp(`- ${unit}: .*Governed work CAN be started from chat\\.`), unit);
  }
  for (const unit of ["Creative & Design", "Operations"]) {
    assert.match(facts, new RegExp(`- ${unit}: .*Governed work can NOT be started from chat\\.`), unit);
  }
  assert.match(facts, /ENIG \(Chief of Staff\)/);
});

test("ENIG: fails closed with no AI call when its Notion definition is unreadable", async (t) => {
  mockNotionFetch(t, {});
  let aiCalled = false;
  const env = fakeEnv({
    AI: {
      run: async () => {
        aiCalled = true;
        return { response: "should not happen" };
      },
    } as any,
  });
  const reply = await generalDmReply(env, 1, 2, "where are we?");
  assert.strictEqual(reply, ENIG_UNAVAILABLE_MESSAGE);
  assert.strictEqual(aiCalled, false);
});

test("ENIG: answers from its live definition, the business snapshot and the how-work-starts rule", async (t) => {
  mockNotionFetch(t, {
    "matters-ds": [
      { id: "m1", archived: false, in_trash: false, properties: { Matter_ID: { unique_id: { prefix: "MAT", number: 12 } }, Status: { select: { name: "Qualified" } } } },
    ],
  });
  let capturedSystem = "";
  const env = fakeEnv({
    STATE_KV: createMockKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "hat:\n  name: ENIG\npurpose: Keep Martin oriented. MARKER_ENIG_DEFINITION",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "MARKER_UNIVERSAL_ROLE_CONTRACT",
    }) as any,
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "We have one Qualified matter, MAT-12." };
      },
    } as any,
  });

  const reply = await generalDmReply(env, 1, 2, "where are we?");

  assert.strictEqual(reply, "We have one Qualified matter, MAT-12.");
  assert.match(capturedSystem, /MARKER_ENIG_DEFINITION/);
  assert.match(capturedSystem, /MARKER_UNIVERSAL_ROLE_CONTRACT/);
  assert.match(capturedSystem, /LIVE BUSINESS SNAPSHOT/);
  assert.match(capturedSystem, /MAT-12 \[Qualified\]/);
  assert.match(capturedSystem, /give him the exact one-line message to send/);
  assert.doesNotMatch(capturedSystem, /say plainly you can't perform actions/, "the old talk-him-out-of-it rule is gone");
});
