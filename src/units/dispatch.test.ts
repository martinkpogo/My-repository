import test from "node:test";
import assert from "node:assert";
import { resolveUnitRequest, tryResolveUnitAction, type UnitDispatchResult } from "./dispatch";
import type { UnitManifest, HatManifest } from "./unitManifest";
import type { Env } from "../types";
import { resolveSkill } from "../platform/skillRegistry";
import { bindExecutionSkills } from "../runtime/actionSkills";

/**
 * Covers tryResolveUnitAction -- the Chat-mode counterpart to
 * resolveUnitRequest (ENIG Operating Model design doc, "Chat is
 * action-capable, not read-only", 2026-09-28 decision). Uses a toy
 * manifest, not a real Unit's, the same testing philosophy
 * actionRegistry.test.ts already establishes for the underlying
 * dispatchAction mechanism -- this proves the mechanism generically
 * without depending on any real Unit's business logic. Reuses Business
 * Development's already-registered SemanticTaskIds (this toy manifest is
 * not BD itself) since a manifest's taskId must be a real registered
 * SemanticTaskId for aiJson to ever reach the mocked provider at all.
 */

type ToyAction = "check_status" | "internal_hold" | "update_price" | "send_proposal";

function toyManifest(overrides: Partial<HatManifest<ToyAction>> = {}): UnitManifest {
  const hat: HatManifest<ToyAction> = {
    name: "Toy Hat",
    responsibility: "Handles toy requests for this test.",
    responsibilityId: "toy_responsibility",
    actions: [
      { name: "check_status", responsibility: "toy_responsibility", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "check_status" }] }, description: "Read-only status check." },
      { name: "internal_hold", responsibility: "toy_responsibility", consequence: "internal", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "internal_hold" }] }, description: "May pause on missing input." },
      { name: "update_price", responsibility: "toy_responsibility", consequence: "write", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "update_price" }] }, description: "Mutates a price, not privileged." },
      { name: "send_proposal", responsibility: "toy_responsibility", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "send_proposal" }] }, description: "Sends a real proposal -- privileged." },
    ],
    readHandler: async (_env, actionName) => `handled:${actionName}`,
    entryHandler: async (_env, state) => state,
    awaitingHandlers: {},
    ...overrides,
  };
  return {
    unit: "Business Development",
    hats: { "Toy Hat": hat },
    intakeClassificationTaskId: "business_development.intake_classification",
    intakeIntroLine: "You route incoming toy requests.",
    actionClassificationTaskId: "business_development.hat_action_decision",
  };
}

function mockAi(env: Partial<Env>, responses: unknown[]): Env {
  let call = 0;
  return {
    STATE_KV: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
    AI: { run: async () => ({ response: JSON.stringify(responses[Math.min(call++, responses.length - 1)]) }) } as any,
    AI_MODEL_LIGHT: "test-light",
    AI_MODEL_PRIMARY: "test-primary",
    TELEGRAM_BOT_TOKEN: "test-token",
    ...env,
  } as Env;
}

function mockTelegramFetch(t: any) {
  const originalFetch = globalThis.fetch;
  const sent: { chatId: number; threadId?: number; text: string }[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(init?.body ?? "{}");
      sent.push({ chatId: body.chat_id, threadId: body.message_thread_id, text: body.text ?? "" });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return sent;
}

test("tryResolveUnitAction: a confidently-resolved read action replies directly to the given target, not the Workspace stream", async (t) => {
  const sent = mockTelegramFetch(t);
  const manifest = toyManifest();
  const env = mockAi(
    { TELEGRAM_GROUP_CHAT_ID: "-999", WORKSPACE_TOPIC_ID: "604" }, // Workspace stream configured but must NOT receive this reply
    // Single-Hat manifest -- Stage 1 is skipped (see the dedicated test
    // for that below), so the only AI call is Stage 2 (action).
    [{ action: "check_status" }],
  );

  const result = await tryResolveUnitAction(env, manifest, { chatId: 12345, threadId: 777 }, "what's the status?");

  assert.deepStrictEqual(result, { kind: "handled" });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].chatId, 12345, "must reply to the DM/topic the message actually came from");
  assert.strictEqual(sent[0].threadId, 777);
  assert.match(sent[0].text, /handled:check_status/);
});

test("tryResolveUnitAction: an internal/write action resolves to 'continue', with no reply sent yet", async (t) => {
  const sent = mockTelegramFetch(t);
  const manifest = toyManifest();
  const env = mockAi({}, [{ action: "update_price" }]); // single-Hat manifest -- Stage 1 skipped

  const result = await tryResolveUnitAction(env, manifest, { chatId: 1, threadId: 2 }, "set the price to 500");

  assert.strictEqual(result.kind, "continue");
  const continuation = result as Extract<UnitDispatchResult, { kind: "continue" }>;
  assert.strictEqual(continuation.hat, "Toy Hat");
  assert.strictEqual(continuation.actionName, "update_price");
  // The Worker receives the whole resolved Action Execution Context --
  // responsibility, consequence, approval requirement and auditable
  // evidence -- not just a name to act on.
  assert.strictEqual(continuation.execution.action.action_id, "update_price");
  assert.strictEqual(continuation.execution.action.responsibility, "toy_responsibility");
  assert.strictEqual(continuation.execution.action.requires_approval, false);
  assert.strictEqual(continuation.execution.evidence.resolved_action, "update_price");
  assert.strictEqual(sent.length, 0, "a write action's own entryHandler decides what to send, not this function");
});

test("tryResolveUnitAction: ambiguous Hat resolution returns silently -- no message sent, matching Chat's fail-open discipline", async (t) => {
  const sent = mockTelegramFetch(t);
  const manifest: UnitManifest = {
    ...toyManifest(),
    hats: {
      "Toy Hat": toyManifest().hats["Toy Hat"],
      "Other Hat": { ...toyManifest().hats["Toy Hat"], name: "Other Hat" },
    },
  };
  const env = mockAi({}, [{ candidates: [] }]); // no Hat clearly matches

  const result = await tryResolveUnitAction(env, manifest, { chatId: 1, threadId: 2 }, "just chatting, nothing specific");

  assert.deepStrictEqual(result, { kind: "ambiguous" });
  assert.strictEqual(sent.length, 0, "must never send a clarifying question -- that would defeat Chat's low-friction point");
});

test("tryResolveUnitAction: ambiguous action resolution (Hat resolved, no action fits) also returns silently", async (t) => {
  const sent = mockTelegramFetch(t);
  const manifest = toyManifest();
  const env = mockAi({}, [{ action: null, reason: "nothing matches" }]);

  const result = await tryResolveUnitAction(env, manifest, { chatId: 1, threadId: 2 }, "just chatting", "Toy Hat");

  assert.deepStrictEqual(result, { kind: "ambiguous" });
  assert.strictEqual(sent.length, 0);
});

test("tryResolveUnitAction: a priorHat naming an undeclared Hat fails silent, not closed", async (t) => {
  const sent = mockTelegramFetch(t);
  const manifest = toyManifest();
  const env = mockAi({}, [{}]);

  const result = await tryResolveUnitAction(env, manifest, { chatId: 1, threadId: 2 }, "text", "Nonexistent Hat");

  assert.deepStrictEqual(result, { kind: "ambiguous" });
  assert.strictEqual(sent.length, 0);
});

test("tryResolveUnitAction: a single-Hat manifest skips Stage 1 entirely (no AI call needed to pick the only Hat)", async (t) => {
  mockTelegramFetch(t);
  const manifest = toyManifest();
  let aiCalls = 0;
  const env = {
    ...mockAi({}, [{ action: "check_status" }]),
    AI: {
      run: async () => {
        aiCalls++;
        return { response: JSON.stringify({ action: "check_status" }) };
      },
    } as any,
  };

  await tryResolveUnitAction(env, manifest, { chatId: 1, threadId: 2 }, "status?");

  assert.strictEqual(aiCalls, 1, "only Stage 2 (action) should call AI -- Stage 1 is skipped for a single-Hat manifest");
});

// --- Declared Skills reach execution through the resolved Action ----------------

function skilledManifest(skillId: string, received: { skills: any[] }): UnitManifest {
  const base = toyManifest();
  const hat = base.hats["Toy Hat"];
  const skilled = (name: string, consequence: "read" | "write"): any => ({
    name,
    responsibility: "toy_responsibility",
    consequence,
    requiresApproval: false,
    skill_requirements: [{ skill_id: skillId }],
    applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: name }] },
    description: `Skilled ${consequence} action.`,
  });
  return {
    ...base,
    hats: {
      "Toy Hat": {
        ...hat,
        actions: [skilled("skilled_read", "read"), skilled("skilled_write", "write")],
        readHandler: async (_env, _name, _text, skills) => {
          received.skills.push(skills);
          return `skills:${skills.declared.join(",")}`;
        },
      },
    },
  };
}

test("a read Action's declared Skill is resolved by the Registry and handed to its readHandler -- the content the Registry validated", async (t) => {
  const sent = mockTelegramFetch(t);
  const received = { skills: [] as any[] };
  const env = mockAi({}, [{ action: "skilled_read" }]);

  const result = await tryResolveUnitAction(env, skilledManifest("research_signal", received), { chatId: 1, threadId: 2 }, "read with skill");

  assert.deepStrictEqual(result, { kind: "handled" });
  assert.strictEqual(received.skills.length, 1);
  assert.deepStrictEqual(received.skills[0].declared, ["research_signal"]);
  assert.strictEqual(received.skills[0].get("research_signal").content, resolveSkill("research_signal").content);
  assert.match(sent[0].text, /skills:research_signal/);
  assert.throws(() => received.skills[0].get("opportunity_qualification_gate"), /not declared/);
});

test("a read Action requiring a Skill the Registry cannot resolve never reaches its handler (fail closed before execution)", async (t) => {
  mockTelegramFetch(t);
  const received = { skills: [] as any[] };
  const env = mockAi({}, [{ action: "skilled_read" }]);

  const result = await tryResolveUnitAction(env, skilledManifest("ghost_skill", received), { chatId: 1, threadId: 2 }, "read with a ghost skill");

  assert.strictEqual(received.skills.length, 0, "the handler must not run when a required Skill cannot be resolved");
  assert.notStrictEqual(result.kind, "continue");
});

test("a write Action's execution context carries its resolved Skill content to the Worker, which binds it from the same Registry-verified package", async (t) => {
  mockTelegramFetch(t);
  const received = { skills: [] as any[] };
  const manifest = skilledManifest("opportunity_forward_planning", received);
  const env = mockAi({}, [{ action: "skilled_write" }]);

  const result = await tryResolveUnitAction(env, manifest, { chatId: 1, threadId: 2 }, "write with skill");

  assert.strictEqual(result.kind, "continue");
  const { execution } = result as Extract<UnitDispatchResult, { kind: "continue" }>;
  assert.strictEqual(execution.skills[0].skill_id, "opportunity_forward_planning");
  assert.strictEqual(execution.skills[0].content, resolveSkill("opportunity_forward_planning").content);
  const action = manifest.hats["Toy Hat"].actions.find((a) => a.name === "skilled_write")!;
  const bound = await bindExecutionSkills(execution.skills, action);
  assert.strictEqual(bound.get("opportunity_forward_planning").content, resolveSkill("opportunity_forward_planning").content);
  assert.strictEqual(received.skills.length, 0, "a write Action never runs a readHandler");
});

// ---------------------------------------------------------------------------
// Live work status (src/runtime/workStatus.ts) for read Actions: in Cowork
// mode the read reports one status run in the Workspace stream; Chat mode
// keeps its one-reply contract (the tryResolveUnitAction tests above).
// ---------------------------------------------------------------------------

test("resolveUnitRequest: a Cowork read Action reports a status run in the Workspace stream, ending before its answer", async (t) => {
  const sent = mockTelegramFetch(t);
  const env = mockAi({ TELEGRAM_GROUP_CHAT_ID: "-999", WORKSPACE_TOPIC_ID: "604" }, [{ action: "check_status" }]);

  const result = await resolveUnitRequest(env, toyManifest(), { chatId: -999, threadId: 604 }, "what's the status?");

  assert.deepStrictEqual(result, { kind: "handled" });
  assert.ok(sent.some((m) => m.text === ""), "the typing indicator (a text-less chat action) ran during the read");
  assert.deepStrictEqual(
    sent.filter((m) => m.text !== "").map((m) => m.text),
    [
      // Markdown-escaped, so Telegram accepts it on the first call.
      "Hat: Toy Hat.\n\n🧭 Toy Hat — check\\_status\n⏳ Running check status",
      "Hat: Toy Hat.\n\n🧭 Toy Hat — check\\_status\n✓ Running check status\n✅ Done -- the answer is below.",
      "Hat: Toy Hat.\n\nhandled:check_status",
    ],
  );
  assert.ok(sent.every((m) => m.chatId === -999 && (m.threadId === 604 || m.threadId === undefined)), "everything goes to the Workspace stream");
});
