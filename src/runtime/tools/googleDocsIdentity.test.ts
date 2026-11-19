/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";

import type { Env } from "../../types";
import type { ToolOperationDefinition } from "../toolRegistry";
import { buildInternalDocLayout, buildProposalDocLayout } from "../../proposalRedline";
import { findLeftoverBannedTerms, IDENTITY_PLACEHOLDERS } from "../../ai/identityRedaction";
import { AiPolicyExecutor } from "../../ai/policy";
import { DataBoundaryEvaluator } from "../../dataBoundary/policy";
import { aiText } from "../../ai";
import type { AiProvider, AiTask, ProviderAdapterResult } from "../../ai/types";

/**
 * Identity restoration at the Google Docs writing boundary (Martin's
 * decision, 2026-11-18): a Doc is a final internal, human-readable draft, so
 * the governed Docs operations write the restored names while every
 * stored/internal representation keeps the protected placeholders. These
 * tests drive the REAL registered operations against a scripted Docs fake --
 * no Google request leaves the process -- and check the exact text inserted
 * into the document.
 */

/**
 * The registered operations are loaded lazily: importing them statically
 * while the tool registry module is still initialising re-enters its own
 * import cycle, and the operation bindings are not yet established.
 */
const operations: { create?: ToolOperationDefinition; update?: ToolOperationDefinition; format?: ToolOperationDefinition } = {};
async function op(kind: "create" | "update" | "format"): Promise<ToolOperationDefinition> {
  if (kind === "create") operations.create ??= (await import("./googleDocsTool")).googleDocsToolOperation;
  if (kind === "update") operations.update ??= (await import("./googleDocsUpdateTool")).googleDocsUpdateToolOperation;
  if (kind === "format") operations.format ??= (await import("./googleDocsFormatTool")).googleDocsFormatToolOperation;
  return operations[kind]!;
}

const ACCOUNT = "martin@example.com";
const PLACEHOLDER_DRAFT = "[ENIG_OPERATOR] should review [ENIG_CONSULTANCY]'s proposed direction.";
const RESTORED_DRAFT = "Martin should review ENIG's proposed direction.";

function fakeEnv(): Env {
  const store = new Map<string, string>([
    [
      `google_oauth_tokens:${ACCOUNT}`,
      JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000, updated_at: "now" }),
    ],
  ]);
  return {
    STATE_KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async ({ prefix }: { prefix?: string } = {}) => ({
        keys: [...store.keys()].filter((key) => !prefix || key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
  } as unknown as Env;
}

/**
 * A scripted Docs fake: creation, the batchUpdate that rewrites the body, and
 * the read-back the operations verify against. It records the exact text the
 * document ends up holding, which is what these tests assert on.
 */
function installGoogleFake(t: any) {
  const doc = { text: "", title: "", batches: [] as any[] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (u.endsWith("/drive/v3/files") && method === "POST") {
      doc.title = body.name;
      return json({ id: "doc-1" });
    }
    if (u.endsWith("/documents/doc-1:batchUpdate") && method === "POST") {
      doc.batches.push(body.requests);
      for (const request of body.requests) {
        if (request.deleteContentRange) doc.text = "";
        if (request.insertText) doc.text = request.insertText.text;
      }
      return json({});
    }
    if (u.endsWith("/documents/doc-1") && method === "GET") {
      return json({ title: doc.title, body: { content: [{ endIndex: doc.text.length + 2, paragraph: { elements: [{ textRun: { content: doc.text } }] } }] } });
    }
    throw new Error(`Unexpected Google call in this test: ${method} ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return doc;
}

/**
 * The trusted target the invocation boundary would resolve. These operations
 * take their target from trusted state (the authorized account / the known
 * document id) and never read it from the input, so the value only satisfies
 * the handler contract.
 */
const TARGET = { resourceId: "gdrive:doc:doc-1" };

function createInput(content: string) {
  return {
    title: "PROP-9 v1",
    // The Action's specification carries the PROTECTED draft (the input is
    // the durable intent record) and declares the presentation the Doc needs;
    // the Tool applies the shared restoration at the write.
    document_specification: { text: content, presentation: { restore_identity_placeholders: true } },
    folder_id: "folder-1",
    account_identifier: ACCOUNT,
  };
}

function updateInput(content: string) {
  const layout = buildProposalDocLayout("PROP-9", [{ version: 1, content }]);
  return {
    document_id: "doc-1",
    account_identifier: ACCOUNT,
    document_specification: {
      text: layout.text,
      styles: layout.styles,
      blocks: layout.blocks,
      presentation: { restore_identity_placeholders: true },
    },
  };
}

test("Google Docs creation writes the human-readable draft: real names restored, no placeholders in the document", async (t) => {
  const doc = installGoogleFake(t);
  const outcome = await (await op("create")).run(fakeEnv(), createInput(PLACEHOLDER_DRAFT), TARGET);

  assert.equal(outcome.state, "succeeded", outcome.state === "succeeded" ? "" : outcome.reason);
  assert.ok(doc.text.includes(RESTORED_DRAFT), `the Doc must hold the restored draft, got: ${doc.text}`);
  assert.ok(!doc.text.includes("[ENIG_"), "no identity placeholder may reach the document");
});

test("Google Docs update writes the human-readable draft and its read-back verification accepts it", async (t) => {
  const doc = installGoogleFake(t);
  const outcome = await (await op("update")).run(fakeEnv(), updateInput(PLACEHOLDER_DRAFT), TARGET);

  assert.equal(outcome.state, "succeeded", outcome.state === "succeeded" ? "" : outcome.reason);
  assert.ok(doc.text.includes(RESTORED_DRAFT), `the rewritten Doc must hold the restored draft, got: ${doc.text}`);
  assert.ok(!doc.text.includes("[ENIG_"), "no identity placeholder may reach the document");
});

test("Google Docs formatting accepts the Doc the update wrote: the layout it compares against is the human-readable one", async (t) => {
  const doc = installGoogleFake(t);
  const update = await op("update");
  const updated = await update.run(fakeEnv(), updateInput(PLACEHOLDER_DRAFT), TARGET);
  assert.equal(updated.state, "succeeded", updated.state === "succeeded" ? "" : updated.reason);

  const formatted = await (await op("format")).run(fakeEnv(), updateInput(PLACEHOLDER_DRAFT), TARGET);
  assert.equal(
    formatted.state,
    "succeeded",
    formatted.state === "succeeded" ? "" : `formatting must not refuse the Doc it wrote: ${formatted.reason}`,
  );
  assert.ok(doc.text.includes(RESTORED_DRAFT), "a styling pass never changes the document text");
});

test("the human-readable layout builder restores names and keeps every style range aligned with the restored text", () => {
  const layout = buildInternalDocLayout("PROP-9", [{ version: 1, content: PLACEHOLDER_DRAFT }]);

  assert.ok(layout.text.includes(RESTORED_DRAFT));
  assert.ok(!layout.text.includes("[ENIG_"));
  assert.ok(layout.styles.length > 0 && layout.blocks.length > 0, "the layout still carries its styling");

  // Every range must address the restored text, never the longer placeholder
  // form -- a range computed on the protected content would overrun it.
  for (const style of layout.styles) {
    assert.ok(style.end <= layout.text.length + 1, `style range ${style.start}-${style.end} overruns the restored text (${layout.text.length})`);
  }
  for (const block of layout.blocks) {
    assert.ok(block.end <= layout.text.length + 2, `block range ${block.start}-${block.end} overruns the restored text (${layout.text.length})`);
  }
  const heading = layout.styles.find((style) => style.kind === "heading")!;
  assert.equal(layout.text.slice(heading.start - 1, heading.end - 1), "PROP-9 v1 -- current version", "the heading range still addresses the heading");
});

test("the base layout builder remains representation-preserving -- only the Doc-specific builder restores", () => {
  const protectedLayout = buildProposalDocLayout("PROP-9", [{ version: 1, content: PLACEHOLDER_DRAFT }]);
  assert.ok(protectedLayout.text.includes(IDENTITY_PLACEHOLDERS.operator));
  assert.ok(protectedLayout.text.includes(IDENTITY_PLACEHOLDERS.consultancy));
  assert.equal(buildInternalDocLayout("PROP-9", [{ version: 1, content: "No identity here." }]).text, buildProposalDocLayout("PROP-9", [{ version: 1, content: "No identity here." }]).text);
});

// ---------------------------------------------------------------------------
// Doc content that later reaches a provider.
// ---------------------------------------------------------------------------

class CapturingProvider implements AiProvider {
  public readonly id = "p1";
  public sent: string[] = [];
  public isEligible(): boolean {
    return true;
  }
  public async execute(_env: Env, task: AiTask): Promise<ProviderAdapterResult> {
    this.sent.push(task.messages.map((message) => message.content).join("\n"));
    return { success: true, response: { rawText: "ok" } };
  }
}

const boundaryEvaluator = new DataBoundaryEvaluator({
  taskSensitivities: { "chat.general_reply": "public" },
  providerEligibility: { p1: { providerId: "p1", allowedSensitivities: new Set(["public"]) } },
});

test("content read back from a restored Doc is protected again before it reaches a provider", async () => {
  const layout = buildInternalDocLayout("PROP-9", [{ version: 1, content: PLACEHOLDER_DRAFT }]);
  const provider = new CapturingProvider();
  const executor = new AiPolicyExecutor([provider], boundaryEvaluator);

  // This is the text a human would quote from the Doc -- the restored form.
  await aiText(fakeEnv(), "chat.general_reply", "You represent ENIG.", `The document says: ${layout.text}`, {}, executor);

  assert.equal(provider.sent.length, 1);
  assert.deepStrictEqual(findLeftoverBannedTerms(provider.sent[0]), [], "no restored name may reach the provider");
  assert.ok(provider.sent[0].includes(IDENTITY_PLACEHOLDERS.operator), "the operator placeholder is what the provider sees");
  assert.ok(provider.sent[0].includes(IDENTITY_PLACEHOLDERS.consultancy), "the consultancy placeholder is what the provider sees");
});
