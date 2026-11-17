import test from "node:test";
import assert from "node:assert";
import { ASK_PICK_EFFECT, consumeEnigSuggestion, coworkOfferText, ENIG_ROUTE_REFUSED_MESSAGE, offerEnigChoices, offerEnigSuggestion, parseEnigReply, suggestableAddressees } from "./enigSuggestion";
import { ENIG_HAT_DEFINITION_PAGE_ID, enigChatReply, runEnigTurn } from "./chat";
import { UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "./governance";
import type { Env } from "./types";

/**
 * Martin confirms, then the route enters Cowork as the owning Hat: ENIG may
 * propose the owning Unit/Hat for an unaddressed request, but only as a
 * confirmation ("Enter Cowork as <Hat>?"); only an exact, startable name
 * becomes a button, a tap yields exactly the addressed text Martin could
 * have typed himself (resolved in Cowork), once, and a ROUTE line naming
 * anything else refuses ENIG's whole reply.
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

test("parseEnigReply: an unknown or paused name is dropped -- the line is still hidden, and the reply is refused", () => {
  for (const bad of ["Sales Executive", "Social Media Manager", "Operations", "Marketing, draft a post"]) {
    const parsed = parseEnigReply(`Here you go.\nSUGGEST: ${bad}`);
    assert.strictEqual(parsed.text, "Here you go.", bad);
    assert.strictEqual(parsed.addressee, undefined, bad);
    assert.strictEqual(parsed.refused, true, `${bad}: fail-closed, the whole reply is refused`);
  }
  assert.deepStrictEqual(parseEnigReply("Just an answer."), { text: "Just an answer." });
});

test("a suggestion is single-use and yields exactly the addressed text Martin could have typed", async () => {
  const env = fakeEnv();
  const buttons = await offerEnigSuggestion(env, -100, 604, "draft a LinkedIn post about diagnosis", "Marketing");
  const [yes, no] = buttons[0];
  assert.strictEqual(yes.text, "🤝 Enter Cowork as Marketing", "the tap says what it does: enter Cowork as the owning Hat");
  assert.strictEqual(no.text, "Not now");
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

test("enigChatReply: a ROUTE line asks Martin to enter Cowork as the owning Hat -- nothing starts, ENIG's own plan is discarded (Martin, 2026-11-17)", async (t) => {
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
  assert.strictEqual(reply.text, coworkOfferText("Campaign & Marketing Communications Manager"), "the runtime's own confirmation question, never ENIG's words");
  assert.strictEqual(reply.text.includes("landing page"), false, "ENIG's plan is discarded -- it never does the work");
  assert.strictEqual((reply as { route?: unknown }).route, undefined, "nothing is dispatched before Martin taps");
  const [[enter, notNow]] = reply.buttons!;
  assert.strictEqual(enter.text, "🤝 Enter Cowork as Campaign & Marketing Communications Manager");
  assert.strictEqual(notNow.text, "Not now");
  const [, id, value] = enter.callback_data.split(":");
  assert.deepStrictEqual(await consumeEnigSuggestion(env, id, value, -100, 604), {
    kind: "start",
    addressee: "Campaign & Marketing Communications Manager",
    addressedText: "Campaign & Marketing Communications Manager, create a campaign offering free consultancy to build an email list",
  });
  assert.match(capturedSystem, /ROUTING/);
  assert.match(capturedSystem, /do NOT do the work/);
  assert.match(capturedSystem, /Enter Cowork as <name> and start\?/, "the instruction says the line starts nothing by itself");
  assert.doesNotMatch(capturedSystem, /give him the exact one-line message to send/, "ENIG's turn carries the ROUTE rule, not the Unit-chat hand-him-a-message rule");
});

test("enigChatReply: a ROUTE line naming something the registry will not accept refuses the whole reply -- ENIG's work content is never delivered", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv({ AI: { run: async () => ({ response: "1. Find the audience\n2. Build the landing page\nROUTE: Social Media Manager" }) } as any });
  const reply = await enigChatReply(env, -100, 604, "run a campaign");
  assert.strictEqual(reply.text, ENIG_ROUTE_REFUSED_MESSAGE, "fail-closed: a hand-over the runtime cannot honour refuses the reply");
  assert.strictEqual(reply.buttons, undefined, "no button: nothing can start");
  assert.strictEqual(reply.text.includes("landing page"), false, "the work content never reaches Martin");
});

test("enigChatReply: an ASK line becomes one button per valid candidate; a pick starts immediately in Cowork, once", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv({ AI: { run: async () => ({ response: "Is this a marketing campaign or a positioning question?\nASK: Marketing | Strategy | Nobody Real" }) } as any });
  const reply = await enigChatReply(env, -100, 604, "work out how we talk about diagnosis");
  assert.strictEqual(reply.text, `Is this a marketing campaign or a positioning question?\n\n${ASK_PICK_EFFECT}`, "a bare candidate button says what a tap does");
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

test("deliverEnigReply: the confirmation carries its buttons and nothing is re-routed here; an answer is sent as is", async () => {
  const { deliverEnigReply } = await import("./router");
  const sent: Array<{ text: string; buttons?: unknown }> = [];
  const send = async (text: string, buttons?: unknown) => void sent.push({ text, buttons });
  await deliverEnigReply(
    { text: coworkOfferText("Marketing"), buttons: [[{ text: "🤝 Enter Cowork as Marketing", callback_data: "enigsuggest:abcdef123456:yes" }]] },
    send,
  );
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, coworkOfferText("Marketing"));
  assert.notStrictEqual(sent[0].buttons, undefined, "the confirmation buttons reach Martin; the tap is what dispatches");
  await deliverEnigReply({ text: "Two approvals are waiting." }, send);
  assert.strictEqual(sent.at(-1)!.text, "Two approvals are waiting.");
  assert.strictEqual(sent.at(-1)!.buttons, undefined, "an answer carries no buttons");
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
