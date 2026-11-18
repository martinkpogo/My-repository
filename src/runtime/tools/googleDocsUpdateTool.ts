/**
 * Registered Google Docs WRITE operation over an EXISTING document --
 * `google_docs.update_and_verify`, version 1.0, effect `external_mutation`:
 * bring THE document to the exact requested content and styling (delete +
 * insert + style in one batchUpdate), then read it back and claim success
 * only when it verifies.
 *
 * This operation is business-neutral: the caller supplies the exact document
 * content (text), paragraph-level styling (blocks), and inline styling
 * (styles). The operation validates those instructions, translates them into
 * Google Docs batchUpdate requests, executes them, and verifies the result.
 * It does not decide what a document should contain or how it should be
 * structured -- that is the responsibility of the calling Action.
 *
 * The document is targeted by its opaque Drive id, validated here and bound
 * by Access to any approval evidence; account selection is resolved from this
 * Worker's authorized accounts, never taken from a caller.
 *
 * Reconciliation is operation-specific: this operation acts on a KNOWN
 * document id (its target), so an interrupted attempt is settled by reading
 * that document back -- content matching the request means the effect
 * exists (recovered as a verified success, never rewritten again), content
 * differing means the requested effect was not applied (a fresh attempt may
 * proceed: update overwrites the body wholesale), an unreachable read keeps
 * the outcome unverified and held, and a vanished document is a definite
 * failure (this operation never creates documents).
 */
import type { Env } from "../../types";
import type { ResolvedToolTarget, ToolInvocationOutcome, ToolOperationDefinition } from "../toolRegistry";
import { extractDocText, getValidGoogleAccessToken, listAuthorizedGoogleAccounts, rewriteGoogleDoc } from "../../googleOAuth";
import type { ProposalDocLayout } from "../../proposalRedline";

export const GOOGLE_DOCS_UPDATE_OPERATION_ID = "google_docs.update_and_verify";

/** Exactly the declared input contract: the document to act on and the exact layout it must hold. */
const ALLOWED_INPUT_KEYS: readonly string[] = ["document_id", "account_identifier", "layout"];

/** An opaque url-safe Google document id -- never a path, URL or blank. */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The business-neutral document layout: text, paragraph blocks, and inline style ranges. */
interface DocLayoutInput {
  text: string;
  blocks: ProposalDocLayout["blocks"];
  styles: ProposalDocLayout["styles"];
}

interface DocWriteInput {
  document_id: string;
  account_identifier: string;
  layout: DocLayoutInput;
}

const BASE = { tool_id: "google_docs", operation_id: GOOGLE_DOCS_UPDATE_OPERATION_ID };

/**
 * Validates the input contract exactly: an object with precisely the three
 * declared fields; an opaque document id; a non-empty account identifier;
 * and a valid layout object with text, blocks, and styles. Returns the typed
 * input or the defect that made it invalid.
 */
function parseInput(input: unknown): DocWriteInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED_INPUT_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `unknown input field "${unknownKey}" -- the document update input contract is exactly ${ALLOWED_INPUT_KEYS.join(", ")}`;
  }
  const missing = ALLOWED_INPUT_KEYS.find((key) => record[key] === undefined || record[key] === null);
  if (missing !== undefined) return `input field "${missing}" is required`;
  if (typeof record.document_id !== "string" || !DOCUMENT_ID_PATTERN.test(record.document_id.trim())) {
    return "document_id must be an opaque url-safe Google document id";
  }
  if (typeof record.account_identifier !== "string" || record.account_identifier.trim().length === 0) {
    return "account_identifier must be a non-empty string";
  }
  // Validate layout
  const layout = record.layout as DocLayoutInput | undefined;
  if (!layout || typeof layout !== "object") {
    return "layout must be an object with {text, blocks, styles}";
  }
  if (typeof layout.text !== "string" || layout.text.trim().length === 0) {
    return "layout.text must be a non-empty string";
  }
  if (!Array.isArray(layout.blocks)) {
    return "layout.blocks must be an array";
  }
  if (!Array.isArray(layout.styles)) {
    return "layout.styles must be an array";
  }
  // Validate each block
  for (let i = 0; i < layout.blocks.length; i++) {
    const block = layout.blocks[i];
    if (!block || typeof block !== "object") return `blocks[${i}] must be an object`;
    if (typeof block.start !== "number" || block.start < 1) return `blocks[${i}].start must be a positive number`;
    if (typeof block.end !== "number" || block.end <= block.start) return `blocks[${i}].end must be greater than start`;
    if (typeof block.kind !== "string") return `blocks[${i}].kind must be a string`;
  }
  // Validate each style
  for (let i = 0; i < layout.styles.length; i++) {
    const style = layout.styles[i];
    if (!style || typeof style !== "object") return `styles[${i}] must be an object`;
    if (typeof style.start !== "number" || style.start < 1) return `styles[${i}].start must be a positive number`;
    if (typeof style.end !== "number" || style.end <= style.start) return `styles[${i}].end must be greater than start`;
    if (!["heading", "del", "add", "label"].includes(style.kind)) {
      return `styles[${i}].kind must be one of: heading, del, add, label`;
    }
  }
  return {
    document_id: record.document_id.trim(),
    account_identifier: record.account_identifier.trim(),
    layout: {
      text: layout.text,
      blocks: layout.blocks,
      styles: layout.styles,
    },
  };
}

/** Shared trusted-target resolution: opaque document id + an account this Worker is actually authorized for. */
async function resolveDocumentTarget(env: Env, input: unknown): Promise<{ ok: true; target: ResolvedToolTarget } | { ok: false; reason: string }> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") return { ok: false, reason: `the google_docs update target input is invalid: ${parsed}` };
  const accounts = await listAuthorizedGoogleAccounts(env);
  if (accounts.length === 0) {
    return { ok: false, reason: "no Google account is authorized for this Worker, so the target account cannot be resolved from trusted runtime state -- no external mutation may proceed" };
  }
  if (!accounts.includes(parsed.account_identifier)) {
    return {
      ok: false,
      reason: `account "${parsed.account_identifier}" is not one of the ${accounts.length} account(s) this Worker is authorized for -- a Tool invocation may not select an arbitrary account`,
    };
  }
  return { ok: true, target: { resourceId: `gdrive:document:${parsed.document_id}` } };
}

/** The canonical URL of a Drive document id (the same form createGoogleDoc reports). */
function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/**
 * Maps the existing rewrite stage results onto the five canonical outcome
 * states -- honestly: a request Google accepted whose read-back did not
 * confirm is partial, never a success and never "nothing happened", and a
 * pre-write refusal is a definite failure with no effect.
 */
function mapUpdateResult(result: { ok: true } | { ok: false; error: string }, documentId: string): ToolInvocationOutcome {
  const remote = { document_id: documentId, url: documentUrl(documentId) };
  if (result.ok) {
    return { ...BASE, state: "succeeded", verified: true, remote_resource: remote };
  }
  const error = result.error ?? "unknown error";
  if (error === "Google Workspace authorization missing or invalid") {
    // The token stage failed before the first Docs request.
    return { ...BASE, state: "failed", stage: "auth", reason: error };
  }
  if (error === "the Doc could not be read") {
    // The pre-write read failed: nothing was written.
    return { ...BASE, state: "failed", stage: "read", reason: error };
  }
  if (error.startsWith("network error")) {
    // The request may have reached Google with the response lost.
    return { ...BASE, state: "unverified", stage: "batch_update", reason: error, remote_resource: remote, reconciliation_required: true };
  }
  if (error.includes("HTTP")) {
    // Google answered with a rejection: a definite failure of this attempt.
    return { ...BASE, state: "failed", stage: "batch_update", reason: error };
  }
  if (error.includes("did not read back")) {
    // The batchUpdate was accepted but the verification read did not confirm
    // the intended final state: partial, reconciled before any retry.
    return { ...BASE, state: "partially_completed", stage: "verification", reason: error, remote_resource: remote, reconciliation_required: true };
  }
  // Unknown defect: the remote state cannot be assumed either way.
  return { ...BASE, state: "unverified", reason: error, remote_resource: remote, reconciliation_required: true };
}

/**
 * Settles an interrupted attempt by reading THE document it targeted.
 * Returns `outcome: null` only when the read establishes that the requested
 * effect does NOT exist (content differs), which is the one state in which a
 * fresh attempt may proceed; a content match is the effect, recovered as a
 * verified success; an unreachable read keeps the outcome unverified and
 * held; a vanished document is a definite failure (never a recreation).
 */
async function reconcileDocumentWrite(env: Env, input: unknown): Promise<{ outcome: ToolInvocationOutcome | null }> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") {
    return {
      outcome: {
        ...BASE,
        state: "unverified",
        reason: `the earlier attempt's remote effect cannot be reconciled (${parsed}) -- refusing to write again until it is resolved`,
        reconciliation_required: true,
      },
    };
  }
  const remote = { document_id: parsed.document_id, url: documentUrl(parsed.document_id) };
  const uncertain = (reason: string): ToolInvocationOutcome => ({ ...BASE, state: "unverified", reason, remote_resource: remote, reconciliation_required: true });
  const desired = parsed.layout.text;
  try {
    const token = await getValidGoogleAccessToken(env, parsed.account_identifier);
    if (!token) {
      return { outcome: uncertain("the authorized account has no valid access token, so the document could not be read back -- the account must be re-authorized before the earlier attempt can be resolved") };
    }
    const response = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(parsed.document_id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      // The targeted document no longer exists: the requested write's effect
      // definitively does not exist. This operation never creates documents.
      return {
        outcome: {
          ...BASE,
          state: "failed",
          stage: "read",
          reason: "the targeted document no longer exists, so the earlier attempt's write cannot exist either -- this operation never creates documents",
        },
      };
    }
    if (!response.ok) {
      return { outcome: uncertain(`reconciliation read of the document failed (HTTP ${response.status}) -- its state is still unconfirmed, so no new write may start`) };
    }
    const body: unknown = await response.json().catch(() => null);
    const text = extractDocText(body);
    if (!body || typeof text !== "string") {
      return { outcome: uncertain("the reconciliation read returned no readable document body -- no new write may start") };
    }
    if (text.trimEnd() === desired.trimEnd()) {
      // The earlier attempt already wrote the requested content: recovered
      // as a verified success, and the document is never rewritten again.
      return {
        outcome: {
          ...BASE,
          state: "succeeded",
          verified: true,
          remote_resource: remote,
          reason: "reconciled: the earlier attempt already wrote the requested content",
        },
      };
    }
    // The requested effect is not present; update overwrites the body
    // wholesale, so a fresh attempt is safe.
    return { outcome: null };
  } catch (error) {
    return { outcome: uncertain(`reconciliation read of the document failed: ${error instanceof Error ? error.message : "unknown error"} -- no new write may start`) };
  }
}

/** `google_docs.update_and_verify`: bring THE document to the exact requested content + styling, verified by read-back. */
export const googleDocsUpdateToolOperation: ToolOperationDefinition = {
  toolId: "google_docs",
  operationId: GOOGLE_DOCS_UPDATE_OPERATION_ID,
  version: "1.0",
  effect: "external_mutation",

  validateInput(input: unknown): string | null {
    const parsed = parseInput(input);
    return typeof parsed === "string" ? parsed : null;
  },

  resolveTarget: resolveDocumentTarget,

  async run(env: Env, input: unknown): Promise<ToolInvocationOutcome> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") {
      // Defensive: validateInput already ran. A failure here makes no request.
      return { ...BASE, state: "failed", stage: "validation", reason: `validation: ${parsed}` };
    }
    const layout: ProposalDocLayout = {
      text: parsed.layout.text,
      blocks: parsed.layout.blocks,
      styles: parsed.layout.styles,
    };
    const result = await rewriteGoogleDoc(env, parsed.account_identifier, parsed.document_id, layout);
    return mapUpdateResult(result, parsed.document_id);
  },

  reconcile: (env, _prior, input) => reconcileDocumentWrite(env, input),
};
