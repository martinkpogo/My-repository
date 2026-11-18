import test from "node:test";
import assert from "node:assert";
import { buildStructureFacts, enigChatReply, ENIG_HAT_DEFINITION_PAGE_ID, ENIG_OFFER_NOT_SAVED_MESSAGE, ENIG_UNAVAILABLE_MESSAGE, generalChatReply, runEnigTurn } from "./chat";
import { clearEnigRecordsCache, recordsOfferText } from "./enigRecords";
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

test("buildStructureFacts: says what each Hat owns, from its manifest, so ENIG can route work to the Hat that does it", () => {
  const facts = buildStructureFacts();
  assert.match(facts, /· Lead Generation Specialist does: Identify and prepare potential commercial leads through proactive research and discovery/);
  assert.match(facts, /· Payments Clerk does: Record a client payment Martin reports as received/);
  assert.match(facts, /· Value-Based Pricing Assessor does: /);
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
  const reply = await enigChatReply(env, 1, 2, "where are we?");
  assert.strictEqual(reply.text, ENIG_UNAVAILABLE_MESSAGE);
  assert.strictEqual(reply.buttons, undefined);
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

  const reply = await enigChatReply(env, 1, 2, "where are we?");

  assert.strictEqual(reply.text, "We have one Qualified matter, MAT-12.");
  assert.strictEqual(reply.buttons, undefined, "a plain answer carries no suggestion button");
  assert.match(capturedSystem, /MARKER_ENIG_DEFINITION/);
  assert.match(capturedSystem, /MARKER_UNIVERSAL_ROLE_CONTRACT/);
  assert.match(capturedSystem, /LIVE BUSINESS SNAPSHOT/);
  assert.match(capturedSystem, /MAT-12 \[Qualified\]/);
  assert.match(capturedSystem, /ROUTE: <name>/, "ENIG's turn is given the ROUTE rule");
  assert.doesNotMatch(capturedSystem, /give him the exact one-line message to send/, "that rule belongs to a Unit's own topic chat only -- both together made ENIG hand Martin a message to type instead of routing (split, 2026-11-17)");
  assert.doesNotMatch(capturedSystem, /say plainly you can't perform actions/, "the old talk-him-out-of-it rule is gone");
});

test("Unit topic chat still hands Martin the exact one-line message to send (the split half ENIG no longer gets)", async (t) => {
  mockNotionFetch(t, {});
  let unitSystem = "";
  let enigSystem = "";
  const env = fakeEnv({
    STATE_KV: createMockKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "purpose: Keep Martin oriented.",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
    }) as any,
    AI: {
      run: async (_m: any, opts: any) => {
        const system = String(opts?.messages?.[0]?.content ?? "");
        if (system.includes("Marketing staff AI")) unitSystem = system;
        else enigSystem = system;
        return { response: "ok" };
      },
    } as any,
  });
  await generalChatReply(env, "Marketing", 1, 2, "what do we do?");
  await enigChatReply(env, 1, 2, "where are we?");
  assert.match(unitSystem, /give him the exact one-line message to send/);
  assert.match(unitSystem, /say so plainly/);
  assert.doesNotMatch(enigSystem, /give him the exact one-line message to send/);
  assert.match(enigSystem, /ROUTE: <name>/);
});

test("log is history (Martin, 2026-11-14): ENIG and Unit chat are told the Activity Log is the past, never the current state", async () => {
  const fs = await import("node:fs");
  const { LOG_IS_HISTORY_RULE } = await import("./chat");
  assert.match(LOG_IS_HISTORY_RULE, /HISTORY/);
  assert.match(LOG_IS_HISTORY_RULE, /ONLY from the business snapshot/);
  const src = fs.readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  assert.equal((src.match(/LOG_IS_HISTORY_RULE, `Recent Activity & Decision Log entries/g) ?? []).length, 2, "both chat paths carry the rule next to the log");
});

test("the Hat match is informed by each Hat's full declared responsibilities -- never the test-only smoke Action (Martin, 2026-11-17)", async () => {
  const { hatDuties, hatDutySummary } = await import("./chat");
  const facts = buildStructureFacts();
  assert.match(facts, /· Marketing Strategist does: Own ENIG's marketing plan and strategy[^\n]*Owns: The marketing plan and strategy/);
  assert.match(facts, /· Business Development Manager does: [^\n]*Commit to the next concrete action for an active opportunity/);
  assert.doesNotMatch(facts, /TEST ONLY|result_gate_smoke/i, "the smoke-test Action is never offered as work a Hat does");
  assert.match(hatDuties("Content Manager") ?? "", /Owns:/);
  assert.ok((hatDutySummary("Marketing Strategist") ?? "").length <= 160);
  assert.strictEqual(hatDuties("No Such Hat"), undefined);
});
function countingNotionFetch(t: any): () => number {
  const originalFetch = globalThis.fetch;
  let queries = 0;
  globalThis.fetch = (async (url: string) => {
    if (/\/data_sources\/[^/]+\/query/.test(String(url))) {
      queries++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return () => queries;
}

/** Governance pages seeded in KV, so a test reaches the turn instead of failing closed. */
function envWithGovernance(overrides: Partial<Env> = {}): Env {
  return fakeEnv({
    STATE_KV: createMockKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "hat:\n  name: ENIG\npurpose: Keep Martin oriented.",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
    }) as any,
    ...overrides,
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

test("buildStructureFacts: says what each Hat owns, from its manifest, so ENIG can route work to the Hat that does it", () => {
  const facts = buildStructureFacts();
  assert.match(facts, /· Lead Generation Specialist does: Identify and prepare potential commercial leads through proactive research and discovery/);
  assert.match(facts, /· Payments Clerk does: Record a client payment Martin reports as received/);
  assert.match(facts, /· Value-Based Pricing Assessor does: /);
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
  const reply = await enigChatReply(env, 1, 2, "where are we?");
  assert.strictEqual(reply.text, ENIG_UNAVAILABLE_MESSAGE);
  assert.strictEqual(reply.buttons, undefined);
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

  const reply = await enigChatReply(env, 1, 2, "where are we?");

  assert.strictEqual(reply.text, "We have one Qualified matter, MAT-12.");
  assert.strictEqual(reply.buttons, undefined, "a plain answer carries no suggestion button");
  assert.match(capturedSystem, /MARKER_ENIG_DEFINITION/);
  assert.match(capturedSystem, /MARKER_UNIVERSAL_ROLE_CONTRACT/);
  assert.match(capturedSystem, /LIVE BUSINESS SNAPSHOT/);
  assert.match(capturedSystem, /MAT-12 \[Qualified\]/);
  assert.match(capturedSystem, /ROUTE: <name>/, "ENIG's turn is given the ROUTE rule");
  assert.doesNotMatch(capturedSystem, /give him the exact one-line message to send/, "that rule belongs to a Unit's own topic chat only -- both together made ENIG hand Martin a message to type instead of routing (split, 2026-11-17)");
  assert.doesNotMatch(capturedSystem, /say plainly you can't perform actions/, "the old talk-him-out-of-it rule is gone");
});

test("Unit topic chat still hands Martin the exact one-line message to send (the split half ENIG no longer gets)", async (t) => {
  mockNotionFetch(t, {});
  let unitSystem = "";
  let enigSystem = "";
  const env = fakeEnv({
    STATE_KV: createMockKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "purpose: Keep Martin oriented.",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
    }) as any,
    AI: {
      run: async (_m: any, opts: any) => {
        const system = String(opts?.messages?.[0]?.content ?? "");
        if (system.includes("Marketing staff AI")) unitSystem = system;
        else enigSystem = system;
        return { response: "ok" };
      },
    } as any,
  });
  await generalChatReply(env, "Marketing", 1, 2, "what do we do?");
  await enigChatReply(env, 1, 2, "where are we?");
  assert.match(unitSystem, /give him the exact one-line message to send/);
  assert.match(unitSystem, /say so plainly/);
  assert.doesNotMatch(enigSystem, /give him the exact one-line message to send/);
  assert.match(enigSystem, /ROUTE: <name>/);
});

test("log is history (Martin, 2026-11-14): ENIG and Unit chat are told the Activity Log is the past, never the current state", async () => {
  const fs = await import("node:fs");
  const { LOG_IS_HISTORY_RULE } = await import("./chat");
  assert.match(LOG_IS_HISTORY_RULE, /HISTORY/);
  assert.match(LOG_IS_HISTORY_RULE, /ONLY from the business snapshot/);
  const src = fs.readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  assert.equal((src.match(/LOG_IS_HISTORY_RULE, `Recent Activity & Decision Log entries/g) ?? []).length, 2, "both chat paths carry the rule next to the log");
});

test("ENIG reads no database for a message that does not need one (Martin, 2026-11-17)", async (t) => {
  clearEnigRecordsCache();
  const queries = countingNotionFetch(t);
  let capturedSystem = "";
  const env = envWithGovernance({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "Happy to help." };
      },
    } as any,
  });

  const reply = await enigChatReply(env, 1, 2, "hi ENIG");

  assert.strictEqual(reply.text, "Happy to help.");
  assert.strictEqual(reply.buttons, undefined, "a plain answer carries no button");
  assert.strictEqual(queries(), 0, "a greeting costs zero Notion data-source queries");
  assert.match(capturedSystem, /NO LIVE RECORDS READ THIS TURN/);
  assert.match(capturedSystem, /READ: <a few words naming what you need>/, "ENIG is told how to ask for the records instead of guessing");
  assert.doesNotMatch(capturedSystem, /LIVE BUSINESS SNAPSHOT/, "no snapshot was loaded");
  assert.match(capturedSystem, /ROUTE: <name>/, "the ROUTE rule is still there");
});

test("ENIG's READ line becomes the runtime's one fixed question with Read records / Not now buttons -- nothing is read until Martin taps", async (t) => {
  clearEnigRecordsCache();
  const queries = countingNotionFetch(t);
  const env = envWithGovernance({
    AI: {
      run: async () => ({ response: "Let me check.\nREAD: overdue invoices" }),
    } as any,
  });

  const reply = await enigChatReply(env, 1, 2, "hi ENIG");

  assert.strictEqual(reply.text, recordsOfferText(), "the runtime writes the question, never ENIG's words");
  assert.strictEqual(queries(), 0, "the offer itself reads nothing");
  assert.strictEqual(reply.buttons?.length, 1);
  assert.strictEqual(reply.buttons?.[0][0].text, "📊 Read records");
  assert.strictEqual(reply.buttons?.[0][1].text, "Not now");
  assert.ok(reply.buttons?.[0][0].callback_data.startsWith("enigrecords:"), "the same callback index.ts dispatches on");
});

test("Martin's tap is what reads: the re-run turn carries the snapshot, and a stray READ line is stripped, never re-offered", async (t) => {
  clearEnigRecordsCache();
  const queries = countingNotionFetch(t);
  let capturedSystem = "";
  const env = envWithGovernance({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "Nothing is overdue.\nREAD: invoices" };
      },
    } as any,
  });

  const reply = await enigChatReply(env, 1, 2, "hi ENIG", { recordsAlreadyRead: true });

  assert.strictEqual(reply.text, "Nothing is overdue.", "the stray READ line is stripped, not offered again");
  assert.strictEqual(reply.buttons, undefined, "a records-read turn never re-offers (no loop)");
  assert.ok(queries() > 0, "the tap is what loads the records");
  assert.match(capturedSystem, /LIVE BUSINESS SNAPSHOT/);
  assert.doesNotMatch(capturedSystem, /RECORDS \(Martin's decision/, "the no-records rule only travels with a turn that read nothing");
});

test("runEnigTurn's force mode reads the records whatever the message says (the morning brief's path)", async (t) => {
  clearEnigRecordsCache();
  const queries = countingNotionFetch(t);
  let capturedSystem = "";
  const env = envWithGovernance({
    AI: {
      run: async (_model: any, opts: any) => {
        capturedSystem = String(opts?.messages?.[0]?.content ?? "");
        return { response: "☀️ brief" };
      },
    } as any,
  });

  const reply = await runEnigTurn(env, 1, 2, "Scheduled morning brief", undefined, "force");

  assert.strictEqual(reply, "☀️ brief");
  assert.ok(queries() > 0, "the brief always reads");
  assert.match(capturedSystem, /LIVE BUSINESS SNAPSHOT/);
  assert.doesNotMatch(capturedSystem, /READ: <a few words/, "a forced turn is never asked to ask");
});

// 17 Nov 2026: the day's KV writes were used up and every save threw, so
// ENIG answered "Something went wrong" instead of replying.
function fullKv(initial: Record<string, string>) {
  const kv = createMockKv(initial);
  return { ...kv, put: async () => { throw new Error("KV put() limit exceeded for the day."); } };
}

test("storage full: ENIG still replies when its chat history cannot be saved", async (t) => {
  clearEnigRecordsCache();
  countingNotionFetch(t);
  const env = envWithGovernance({
    STATE_KV: fullKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "hat:\n  name: ENIG",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
    }) as any,
    AI: { run: async () => ({ response: "Hello Martin." }) } as any,
  });
  const reply = await enigChatReply(env, 1, 2, "hi ENIG");
  assert.strictEqual(reply.text, "Hello Martin.");
});

test("storage full: an offer whose buttons cannot be saved says so plainly, shows no dead buttons, and starts nothing", async (t) => {
  clearEnigRecordsCache();
  countingNotionFetch(t);
  const env = envWithGovernance({
    STATE_KV: fullKv({
      [`governance:${ENIG_HAT_DEFINITION_PAGE_ID}`]: "hat:\n  name: ENIG",
      [`governance:${UNIVERSAL_ROLE_CONTRACT_PAGE_ID}`]: "Universal Role Contract text",
    }) as any,
    AI: { run: async () => ({ response: "ROUTE: Marketing Strategist" }) } as any,
  });
  const reply = await enigChatReply(env, 1, 2, "Plan a campaign to get more clients");
  assert.strictEqual(reply.text, ENIG_OFFER_NOT_SAVED_MESSAGE);
  assert.strictEqual(reply.buttons, undefined);
});

// 17 Nov 2026: ENIG's prompt passed the 8,000 tokens the free backup
// providers accept, so when Workers AI's daily allowance ran out none could answer.
test("prompt size: only the newest history that fits is sent; the stored history is unchanged", async () => {
  const { historyForPrompt, HISTORY_PROMPT_MAX_CHARS } = await import("./chat");
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i}:${"x".repeat(900)}` }));
  const sent = historyForPrompt(turns);
  assert.ok(sent.reduce((n, t) => n + t.content.length, 0) <= HISTORY_PROMPT_MAX_CHARS);
  assert.strictEqual(sent[sent.length - 1], turns[19], "the newest turn is always kept");
  assert.ok(sent.length < turns.length && sent[0].content.startsWith(`${20 - sent.length}:`), "the oldest turns are dropped first, in order");
  assert.strictEqual(turns.length, 20, "the stored history is not modified");
  const huge = historyForPrompt([{ role: "assistant", content: "a".repeat(10_000) + "END" }]);
  assert.strictEqual(huge[0].content.length, HISTORY_PROMPT_MAX_CHARS);
  assert.ok(huge[0].content.endsWith("END"), "a single long turn keeps its end");
});

test("prompt size: Hat duties keep every declared Action but drop the responsibility's elaboration", async () => {
  const { hatDuties, hatDutiesBrief } = await import("./chat");
  for (const hat of ALL_HATS) {
    const full = hatDuties(hat.name);
    const brief = hatDutiesBrief(hat.name);
    if (!full) continue;
    assert.ok(brief && brief.length <= full.length, hat.name);
  }
});

// Martin, 2026-11-17: ENIG's own turn fits the free backup providers.
test("ENIG's contract: the sections that do not apply to ENIG are left out, everything else is kept", async () => {
  const { enigContract } = await import("./chat");
  const contract = [
    "```yaml",
    "universal_role_contract:",
    "  status: canonical",
    "  gate_discipline:",
    "    rule: >",
    "      stop and resolve",
    "  understand_before_producing:",
    "    applies_to: \"Substantial work\"",
    "    required_behavior:",
    "      ask_result_format:",
    "        rule: \"always ask\"",
    "",
    "    proportion: \"simple needs none\"",
    "  hat_selection:",
    "    chat_driven_request: match",
    "  architect_hat_execution:",
    "    rule: architect may operate",
    "    failure:",
    "      prohibited:",
    "        - infer_operating_hat",
    "```",
    "",
    "## HUMAN-READABLE EXPLANATION",
    "",
    "Every Hat inherits this contract.",
  ].join("\n");
  const out = enigContract(contract);
  for (const kept of ["gate_discipline", "stop and resolve", "hat_selection", "chat_driven_request", "status: canonical"]) assert.ok(out.includes(kept), kept);
  for (const dropped of ["understand_before_producing", "ask_result_format", "proportion", "architect_hat_execution", "infer_operating_hat", "HUMAN-READABLE", "Every Hat inherits"]) assert.ok(!out.includes(dropped), dropped);
  assert.ok(out.trimEnd().endsWith("```"), "the YAML block stays closed");
  assert.strictEqual(enigContract("a page with no such sections"), "a page with no such sections", "nothing else is ever dropped");
});

test("ENIG reads the Consultancy Profile only when Martin asks about the business itself", async () => {
  const { asksAboutTheBusiness } = await import("./chat");
  for (const m of ["what do we sell?", "Who do we serve?", "how much do we charge for a project?", "what is ENIG?", "tell me what our services are", "how does an engagement with us work?"]) assert.ok(asksAboutTheBusiness(m), m);
  for (const m of ["Plan a campaign to get more clients", "hi ENIG", "any overdue invoices?", "draft a post to attract leads", "find leads in Lagos"]) assert.ok(!asksAboutTheBusiness(m), m);
});
