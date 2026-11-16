import test from "node:test";
import assert from "node:assert";
import { consumeEnigSuggestion, offerEnigChoices, offerEnigSuggestion, parseEnigReply, suggestableAddressees } from "./enigSuggestion";
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

test("enigChatReply: a ROUTE line hands the work to the Hat -- ENIG's own plan is discarded, nothing to tap (Martin, 2026-11-16)", async (t) => {
  mockNotionFetch(t);
  let capturedSystem = "";
  const env = fakeEnv({
    AI: {
      run: async (_m: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "1. Identify the audience\n2. Build a landing page\nROUTE: Campaign & Marketing Communications Manager" };
      },
    } as any,
  });
  const reply = await enigChatReply(env, -100, 604, "create a campaign offering free consultancy to build an email list");
  assert.strictEqual(reply.text, "Passing this to Campaign & Marketing Communications Manager.", "ENIG never does the work itself");
  assert.strictEqual(reply.buttons, undefined);
  assert.deepStrictEqual(reply.route, {
    addressee: "Campaign & Marketing Communications Manager",
    addressedText: "Campaign & Marketing Communications Manager, create a campaign offering free consultancy to build an email list",
  });
  assert.match(capturedSystem, /ROUTING/);
  assert.match(capturedSystem, /do NOT do the work/);
});

test("enigChatReply: an ASK line becomes one button per valid candidate; a tap yields that Hat's addressed text, once", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv({ AI: { run: async () => ({ response: "Is this a marketing campaign or a positioning question?\nASK: Marketing | Strategy | Nobody Real" }) } as any });
  const reply = await enigChatReply(env, -100, 604, "work out how we talk about diagnosis");
  assert.strictEqual(reply.route, undefined, "unsure: nothing starts");
  assert.strictEqual(reply.text, "Is this a marketing campaign or a positioning question?");
  const rows = reply.buttons!;
  assert.deepStrictEqual(rows.map((r) => r[0].text), ["Marketing", "Strategy", "None of these"], "an unknown name is dropped");
  const [, id, value] = rows[1][0].callback_data.split(":");
  assert.ok(rows[1][0].callback_data.length <= 64);
  assert.deepStrictEqual(await consumeEnigSuggestion(env, id, value, -100, 604), { kind: "start", addressee: "Strategy", addressedText: "Strategy, work out how we talk about diagnosis" });
  assert.deepStrictEqual(await consumeEnigSuggestion(env, id, "c0", -100, 604), { kind: "unavailable" }, "single use");
  const none = (await offerEnigChoices(env, -100, 604, "x", ["Marketing"]))[1][0].callback_data.split(":");
  assert.deepStrictEqual(await consumeEnigSuggestion(env, none[1], none[2], -100, 604), { kind: "declined" });
});

test("parseEnigReply: ROUTE (and the earlier SUGGEST) route only to an exact startable name; a plain answer routes nothing", () => {
  assert.strictEqual(parseEnigReply("ROUTE: marketing").addressee, "Marketing");
  assert.strictEqual(parseEnigReply("ROUTE: Sales Executive").addressee, undefined, "paused: never routed");
  assert.deepStrictEqual(parseEnigReply("You have 2 approvals waiting."), { text: "You have 2 approvals waiting." });
  assert.strictEqual(parseEnigReply("Which?\nASK: Operations | Sales Executive").choices, undefined, "no valid candidate: no buttons");
});

test("deliverEnigReply: a route is announced in one line and re-routed as the addressed text; otherwise the reply is sent as is", async () => {
  const { deliverEnigReply } = await import("./router");
  const sent: Array<{ text: string; buttons?: unknown }> = [];
  const rerouted: string[] = [];
  const send = async (text: string, buttons?: unknown) => void sent.push({ text, buttons });
  await deliverEnigReply({ text: "Passing this to Marketing.", route: { addressee: "Marketing", addressedText: "Marketing, do X" } }, send, async (t) => void rerouted.push(t));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, "Passing this to Marketing.");
  assert.strictEqual(sent[0].buttons, undefined, "nothing to tap");
  assert.deepStrictEqual(rerouted, ["Marketing, do X"]);
  await deliverEnigReply({ text: "Two approvals are waiting." }, send, async (t) => void rerouted.push(t));
  assert.strictEqual(sent.at(-1)!.text, "Two approvals are waiting.");
  assert.strictEqual(rerouted.length, 1, "an answer re-routes nothing");
});

test("runEnigTurn without the instruction (the morning brief's path) never asks for a ROUTE line", async (t) => {
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
  assert.doesNotMatch(capturedSystem, /ROUTING/);
});
