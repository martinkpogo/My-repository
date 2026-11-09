import test from "node:test";
import assert from "node:assert";
import { consumeEnigSuggestion, offerEnigSuggestion, parseEnigReply, suggestableAddressees } from "./enigSuggestion";
import { ENIG_HAT_DEFINITION_PAGE_ID, enigChatReply, runEnigTurn } from "./chat";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "./governance";
import type { Env } from "./types";

/**
 * ENIG suggests, Martin confirms: ENIG may propose the owning Unit/Hat for an
 * unaddressed request; only an exact, startable name becomes a button; a tap
 * yields exactly the addressed text Martin could have typed himself, once.
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
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-ds",
    AI_MODEL_LIGHT: "test-light-model",
    AI_MODEL_PRIMARY: "test-primary-model",
    STATE_KV: createMockKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "purpose: Keep Martin oriented.",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
    }) as any,
    ...overrides,
  } as Env;
}

function mockNotionFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (/\/data_sources\/[^/]+\/query/.test(String(url))) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("suggestable names: startable Units and their Hats, minus the paused Sales Executive path", () => {
  const names = suggestableAddressees();
  for (const name of ["Marketing", "Content Manager", "Lead Generation Specialist", "Finance", "Strategy", "Business Development"]) {
    assert.ok(names.includes(name), `${name} should be suggestable`);
  }
  for (const name of ["Sales Executive", "Sales", "Creative & Design", "Operations", "ENIG"]) {
    assert.ok(!names.includes(name), `${name} must not be suggestable`);
  }
});

test("parseEnigReply: a valid SUGGEST line is removed from the text and returned as the exact name", () => {
  const parsed = parseEnigReply("That's Marketing's work.\nSend: Marketing, draft a post about X\nSUGGEST: marketing");
  assert.strictEqual(parsed.text, "That's Marketing's work.\nSend: Marketing, draft a post about X");
  assert.strictEqual(parsed.addressee, "Marketing", "case-insensitive match returns the registered spelling");
  assert.strictEqual(parseEnigReply("Ok.\nSUGGEST: **Content Manager**").addressee, "Content Manager", "markdown emphasis tolerated");
});

test("parseEnigReply: an unknown or paused name is dropped -- the line is still hidden, no button", () => {
  for (const bad of ["Sales Executive", "Social Media Manager", "Operations", "Marketing, draft a post"]) {
    const parsed = parseEnigReply(`Here you go.\nSUGGEST: ${bad}`);
    assert.strictEqual(parsed.text, "Here you go.");
    assert.strictEqual(parsed.addressee, undefined, bad);
  }
  assert.deepStrictEqual(parseEnigReply("Just an answer."), { text: "Just an answer." });
});

test("a suggestion is single-use and yields exactly the addressed text Martin could have typed", async () => {
  const env = fakeEnv();
  const buttons = await offerEnigSuggestion(env, -100, 604, "draft a LinkedIn post about diagnosis", "Marketing");
  const [yes, no] = buttons[0];
  assert.match(yes.callback_data, /^enigsuggest:[0-9a-f]{12}:yes$/);
  assert.match(no.callback_data, /:no$/);
  assert.ok(yes.callback_data.length <= 64, "fits Telegram's callback_data limit");
  const id = yes.callback_data.split(":")[1];

  assert.deepStrictEqual(await consumeEnigSuggestion(env, id, "yes", -100, 604), {
    kind: "start",
    addressee: "Marketing",
    addressedText: "Marketing, draft a LinkedIn post about diagnosis",
  });
  assert.deepStrictEqual(await consumeEnigSuggestion(env, id, "yes", -100, 604), { kind: "unavailable" }, "a second tap starts nothing");
});

test("No declines; a tap from another thread, or an unknown id, is refused", async () => {
  const env = fakeEnv();
  const idOf = async () => (await offerEnigSuggestion(env, -100, 604, "x", "Finance"))[0][0].callback_data.split(":")[1];
  assert.deepStrictEqual(await consumeEnigSuggestion(env, await idOf(), "no", -100, 604), { kind: "declined" });
  assert.deepStrictEqual(await consumeEnigSuggestion(env, await idOf(), "yes", -100, 999), { kind: "unavailable" });
  assert.deepStrictEqual(await consumeEnigSuggestion(env, "000000000000", "yes", -100, 604), { kind: "unavailable" });
});

test("enigChatReply: ENIG's SUGGEST line becomes a Yes/No button and is hidden from Martin", async (t) => {
  mockNotionFetch(t);
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_m: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "That's Marketing's work.\nSUGGEST: Marketing" };
      },
    } as any,
  });
  const reply = await enigChatReply(env, -100, 604, "we need a post about diagnosing first");
  assert.strictEqual(reply.text, "That's Marketing's work.");
  assert.ok(reply.buttons);
  assert.strictEqual(reply.buttons![0][0].text, "✅ Yes, start with Marketing");
  assert.match(capturedSystem, /SUGGESTION BUTTON/);
});

test("runEnigTurn without the instruction (the morning brief's path) never asks for a SUGGEST line", async (t) => {
  mockNotionFetch(t);
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_m: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "brief" };
      },
    } as any,
  });
  await runEnigTurn(env, -100, 604, "Scheduled morning brief");
  assert.doesNotMatch(capturedSystem, /SUGGESTION BUTTON/);
});
