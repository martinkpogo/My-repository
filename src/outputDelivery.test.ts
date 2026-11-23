import assert from "node:assert/strict";
import { test } from "node:test";

import type { Env, WorkState } from "./types";
import { captureApprovedOutput, isDeliveryTokenSafe, outputDeliveryOfferButtons, OUTPUT_DELIVERY_CALLBACK, OUTPUT_DELIVERY_OFFER_TEXT } from "./outputDelivery";
import { evaluateExternalMutationAccess, mintExternalToolApprovalProof, workSessionContext, SHARED_OUTPUT_DELIVERY_OPERATION_ID, SHARED_OUTPUT_REPLACE_OPERATION_ID } from "./access";
import { findUnitManifest } from "./units/registry";

/**
 * The shared output-delivery feature (Martin's decision, 2026-11-17). These
 * tests prove its two load-bearing guarantees without any Google request:
 *
 *  - capture is the only producer and fails closed: an empty or
 *    identity-bearing approved output is NOT stored (nothing is offered that
 *    could leak identity into a Doc);
 *  - the Access rule is one shared exemption: any Work's own approved output
 *    may run `google_docs.create_and_verify` WITHOUT a per-Action
 *    declaration, and ONLY with a proof minted from the final picker tap and
 *    bound to the exact picked folder. A different operation, a non-write
 *    Action, a missing/mis-bound proof, or a non-work_session context is
 *    still denied.
 */

function fakeEnv(): Env {
  return {
    TELEGRAM_GROUP_CHAT_ID: "111",
    WORKSPACE_TOPIC_ID: "222",
    BOT_TOKEN: "test-token",
    STATE_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true }),
    },
  } as unknown as Env;
}

function workState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    workId: "work-1",
    chatId: 111,
    threadId: 222,
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    stage: "awaiting_intervention_approval",
    ...overrides,
  } as WorkState;
}

// ---------------------------------------------------------------------------
// captureApprovedOutput: the only producer, fail-closed
// ---------------------------------------------------------------------------

test("captureApprovedOutput stores a clean approved output", async () => {
  const state = workState({ entityToken: "ENT-1", matterToken: "MAT-1" });
  const next = await captureApprovedOutput(fakeEnv(), state, { title: "Plan", text: "A clean token-only plan body." });
  assert.ok(next.outputDelivery, "the approved output is captured");
  assert.equal(next.outputDelivery!.title, "Plan");
  assert.match(next.outputDelivery!.text, /token-only plan body/);
});

test("captureApprovedOutput sends the save offer with its buttons right after approval (2026-11-18: it was captured but never offered)", async () => {
  const state = workState({ entityToken: "ENT-1", matterToken: "MAT-1" });
  const sent: Array<{ text: string; buttons?: unknown }> = [];
  await captureApprovedOutput(fakeEnv(), state, { title: "Plan", text: "A clean token-only plan body." }, {
    send: (async (_env: Env, _target: unknown, text: string, buttons?: unknown) => {
      sent.push({ text, buttons });
    }) as any,
  });
  assert.strictEqual(sent.length, 1, "exactly one offer is sent");
  assert.strictEqual(sent[0].text, OUTPUT_DELIVERY_OFFER_TEXT);
  assert.deepStrictEqual(sent[0].buttons, outputDeliveryOfferButtons(state.workId));
});

test("captureApprovedOutput never offers a refused output", async () => {
  const state = workState({ entityDraft: { email: "real@acme.example" } as any });
  const sent: string[] = [];
  await captureApprovedOutput(fakeEnv(), state, { title: "Plan", text: "Contact real@acme.example" }, {
    send: (async (_e: Env, _t: unknown, text: string) => { sent.push(text); }) as any,
  });
  assert.ok(!sent.includes(OUTPUT_DELIVERY_OFFER_TEXT), "no save buttons for an output that failed the identity check");
});

test("captureApprovedOutput refuses an empty output (nothing offered)", async () => {
  const state = workState();
  const next = await captureApprovedOutput(fakeEnv(), state, { title: "Plan", text: "   " });
  assert.equal(next.outputDelivery, undefined, "an empty output is not stored");
});

test("captureApprovedOutput refuses identity-bearing output (fail closed)", async () => {
  const state = workState({ entityToken: "ENT-1", matterToken: "MAT-1", entityDraft: { email: "real@acme.example" } as any });
  const next = await captureApprovedOutput(fakeEnv(), state, {
    title: "Plan",
    text: "Contact real@acme.example about the renewal.",
  });
  assert.equal(next.outputDelivery, undefined, "identity-bearing output is not stored");
});

test("isDeliveryTokenSafe: token-only passes, a known real value fails", () => {
  const state = workState({ entityDraft: { email: "real@acme.example" } as any });
  assert.equal(isDeliveryTokenSafe(state, "No contact detail here, only MAT-1."), true);
  assert.equal(isDeliveryTokenSafe(state, "Reach them at real@acme.example"), false);
});

// ---------------------------------------------------------------------------
// The offer buttons
// ---------------------------------------------------------------------------

test("outputDeliveryOfferButtons: Save as Doc (likely-first) and Keep in chat, both bounded", () => {
  const buttons = outputDeliveryOfferButtons("work-1");
  const flat = buttons.flat();
  assert.equal(flat.length, 2);
  assert.match(flat[0].text, /Save as Doc/);
  assert.equal(flat[0].callback_data, `${OUTPUT_DELIVERY_CALLBACK}:work-1:start`);
  assert.match(flat[1].text, /Keep in chat/);
  // Telegram callback_data limit is 64 UTF-8 bytes.
  for (const b of flat) assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= 64, `callback_data too long: ${b.callback_data}`);
});

// ---------------------------------------------------------------------------
// The one Access exemption
// ---------------------------------------------------------------------------

const DOCS_BINDING = { toolId: "google_docs", operationId: "google_docs.create_and_verify", targetResourceId: "gdrive:folder:folder-1" };
const REPLACE_BINDING = { toolId: "google_docs", operationId: "google_docs.update_and_verify", targetResourceId: "gdrive:document:doc-1" };

function accessEnv(): Env {
  return fakeEnv();
}

test("Access: an undeclared Action may still run the shared save with a bound proof", () => {
  // Strategy's diagnose does NOT declare google_docs.create_and_verify.
  const manifest = findUnitManifest("Strategy");
  const hat = manifest?.hats["Strategy Analyst"];
  const diagnose = hat?.actions.find((a) => a.name === "diagnose");
  assert.ok(diagnose, "Strategy diagnose action exists");
  const declaresDocs = (diagnose!.tool_operations ?? []).some(
    (d) => d.tool_id === "google_docs" && d.operation_id === "google_docs.create_and_verify",
  );
  assert.equal(declaresDocs, false, "the test premise: diagnose does NOT declare the operation");

  const state = workState({ actionName: "diagnose" });
  const proof = mintExternalToolApprovalProof(state, DOCS_BINDING);
  // Must NOT throw: the shared exemption authorizes it without a declaration.
  evaluateExternalMutationAccess(
    accessEnv(),
    { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: DOCS_BINDING.targetResourceId },
    workSessionContext(state, proof),
  );
});

test("Access: the exemption is TWO named operations -- any other operation is still refused", () => {
  const state = workState({ actionName: "diagnose" });
  const proof = mintExternalToolApprovalProof(state, { ...DOCS_BINDING, operationId: "google_docs.format_and_verify" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.format_and_verify", effect: "external_mutation", targetResourceId: DOCS_BINDING.targetResourceId },
        workSessionContext(state, proof),
      ),
    /does not declare Tool operation google_docs\.format_and_verify/,
  );
});

test("Access: an approval-gated Action still REQUIRES a bound proof even for the shared save", () => {
  // Finance's `price` is an approval-gated write; the exemption must not drop
  // the proof requirement where the Action declares one.
  const state = workState({ unit: "Finance", hat: "Value-Based Pricing Assessor", actionName: "price" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: DOCS_BINDING.targetResourceId },
        workSessionContext(state), // no proof
      ),
    /requires Martin's explicit approval/,
  );
});

test("Access: even an ungated Action (diagnose) needs Martin's tap -- the shared save always requires a bound proof", () => {
  const state = workState({ actionName: "diagnose" });
  // diagnose has requiresApproval: false, but the shared save is authorized
  // only by Martin's final picker tap (2026-11-17), so no proof means no save.
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: DOCS_BINDING.targetResourceId },
        workSessionContext(state),
      ),
    /no ApprovalProof was supplied/,
  );
  // With the tap's proof, bound to this folder, it is allowed.
  evaluateExternalMutationAccess(
    accessEnv(),
    { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: DOCS_BINDING.targetResourceId },
    workSessionContext(state, mintExternalToolApprovalProof(state, DOCS_BINDING)),
  );
});

test("Access: a proof bound to a DIFFERENT folder cannot authorize this folder", () => {
  const state = workState({ actionName: "diagnose" });
  const wrongFolderProof = mintExternalToolApprovalProof(state, { ...DOCS_BINDING, targetResourceId: "gdrive:folder:folder-OTHER" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: "gdrive:folder:folder-1" },
        workSessionContext(state, wrongFolderProof),
      ),
    /authorizes external target gdrive:folder:folder-OTHER, not gdrive:folder:folder-1/,
  );
});

test("Access: a non-work_session context is still denied (the exemption is not a bypass)", () => {
  const state = workState({ actionName: "diagnose" });
  const proof = mintExternalToolApprovalProof(state, DOCS_BINDING);
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.create_and_verify", effect: "external_mutation", targetResourceId: DOCS_BINDING.targetResourceId },
        { kind: "user_lookup", proof } as any,
      ),
    /requires a "work_session" context/,
  );
});

// ---------------------------------------------------------------------------
// R2-1: overwrite an existing Doc under the same shared exemption
// ---------------------------------------------------------------------------

test("R2-1: an undeclared Action (Strategy 'diagnose') may overwrite with a proof bound to that exact document", () => {
  // Strategy's diagnose does NOT declare google_docs.update_and_verify.
  const manifest = findUnitManifest("Strategy");
  const hat = manifest?.hats["Strategy Analyst"];
  const diagnose = hat?.actions.find((a) => a.name === "diagnose");
  assert.ok(diagnose, "Strategy diagnose action exists");
  const declaresReplace = (diagnose!.tool_operations ?? []).some(
    (d) => d.tool_id === "google_docs" && d.operation_id === "google_docs.update_and_verify",
  );
  assert.equal(declaresReplace, false, "the test premise: diagnose does NOT declare the replace operation");

  const state = workState({ actionName: "diagnose" });
  const proof = mintExternalToolApprovalProof(state, REPLACE_BINDING);
  // Must NOT throw: the shared exemption authorizes overwriting doc-1 without a declaration.
  evaluateExternalMutationAccess(
    accessEnv(),
    { toolId: "google_docs", operationId: "google_docs.update_and_verify", effect: "external_mutation", targetResourceId: REPLACE_BINDING.targetResourceId },
    workSessionContext(state, proof),
  );
});

test("R2-1: overwrite with NO proof throws 'no ApprovalProof was supplied'", () => {
  const state = workState({ actionName: "diagnose" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.update_and_verify", effect: "external_mutation", targetResourceId: REPLACE_BINDING.targetResourceId },
        workSessionContext(state),
      ),
    /no ApprovalProof was supplied/,
  );
});

test("R2-1: a proof minted for create_and_verify cannot authorise update_and_verify", () => {
  const state = workState({ actionName: "diagnose" });
  const createProof = mintExternalToolApprovalProof(state, { ...REPLACE_BINDING, operationId: "google_docs.create_and_verify" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.update_and_verify", effect: "external_mutation", targetResourceId: REPLACE_BINDING.targetResourceId },
        workSessionContext(state, createProof),
      ),
    /authorizes Tool operation google_docs.create_and_verify, not google_docs.update_and_verify/,
  );
});

test("R2-1: a proof bound to 'gdrive:document:doc-2' cannot authorise doc-1", () => {
  const state = workState({ actionName: "diagnose" });
  const wrongDocProof = mintExternalToolApprovalProof(state, { ...REPLACE_BINDING, targetResourceId: "gdrive:document:doc-2" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.update_and_verify", effect: "external_mutation", targetResourceId: "gdrive:document:doc-1" },
        workSessionContext(state, wrongDocProof),
      ),
    /authorizes external target gdrive:document:doc-2, not gdrive:document:doc-1/,
  );
});

test("R2-1: an approval-gated Action (Finance 'price') with no proof throws 'requires Martin's explicit approval'", () => {
  const state = workState({ unit: "Finance", hat: "Value-Based Pricing Assessor", actionName: "price" });
  assert.throws(
    () =>
      evaluateExternalMutationAccess(
        accessEnv(),
        { toolId: "google_docs", operationId: "google_docs.update_and_verify", effect: "external_mutation", targetResourceId: REPLACE_BINDING.targetResourceId },
        workSessionContext(state), // no proof
      ),
    /requires Martin's explicit approval/,
  );
});

test("R2-1: SHARED_OUTPUT_REPLACE_OPERATION_ID equals google_docs.update_and_verify, and SHARED_OUTPUT_DELIVERY_OPERATION_ID still equals google_docs.create_and_verify", () => {
  assert.equal(SHARED_OUTPUT_REPLACE_OPERATION_ID, "google_docs.update_and_verify");
  assert.equal(SHARED_OUTPUT_DELIVERY_OPERATION_ID, "google_docs.create_and_verify");
});

test("Approve and save (2026-11-18): the button reuses the Hat's own approve callback, fits Telegram's limit, and an approval under it opens the picker instead of offering", async () => {
  const { approveAndSaveRow, runWithSaveOnApproval, SAVE_ON_APPROVAL_SUFFIX } = await import("./outputDelivery");
  const uuid = "x".repeat(36);
  for (const approve of [`marketdraft:${uuid}:approve`, `sprop:${uuid}:99.a`, `quote:${uuid}:approve`]) {
    const [button] = approveAndSaveRow(approve);
    assert.equal(button.callback_data, `${approve}${SAVE_ON_APPROVAL_SUFFIX}`);
    assert.ok(new TextEncoder().encode(button.callback_data).length <= 64, approve);
  }
  const state = workState();
  const sent: string[] = [];
  await runWithSaveOnApproval(() =>
    captureApprovedOutput(fakeEnv(), state, { title: "Plan", text: "A clean token-only plan body." }, {
      send: (async (_e: Env, _t: unknown, text: string) => { sent.push(text); }) as any,
    }),
  );
  assert.equal(state.outputDelivery?.saveRequested, true, "the session will open the picker");
  assert.ok(!sent.includes(OUTPUT_DELIVERY_OFFER_TEXT), "no separate offer when Martin already asked to save");
});
