/**
 * The registered Google Docs Tool -- `google_docs`, operation
 * `google_docs.create_and_verify`, version 1.0, effect `external_mutation`
 * (ENIG HQ > 6. Tools > Google Docs, canonical specification).
 *
 * This module owns the CONCRETE operation: input contract, trusted target
 * resolution, the mapped outcomes of the existing creation sequence, and the
 * reconciliation read for uncertain outcomes. It deliberately reuses the
 * established Google implementation -- `createGoogleDoc` (create the Drive
 * file, insert the content, read it back and verify title/content),
 * `listAuthorizedGoogleAccounts`, `getValidGoogleAccessToken` -- rather than
 * growing a second Google Docs client, and it holds no policy: whether an
 * invocation is permitted is decided by Access through the invocation
 * boundary (src/runtime/toolRegistry.ts) before any Google request.
 *
 * Credential boundary: the account is resolved from THIS Worker's own
 * authorized accounts in STATE_KV (trusted runtime state) -- OAuth tokens
 * are never accepted from a caller, and holding them grants no authorization.
 */
import type { Env } from "../../types";
import type { ResolvedToolTarget, ToolInvocationOutcome, ToolOperationDefinition } from "../toolRegistry";
import { createGoogleDoc, getValidGoogleAccessToken, listAuthorizedGoogleAccounts } from "../../googleOAuth";

export const GOOGLE_DOCS_TOOL_ID = "google_docs";
export const GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID = "google_docs.create_and_verify";

/** The exact input contract of google_docs.create_and_verify (canonical spec: title, content, folder_id, account_identifier). */
const ALLOWED_INPUT_KEYS: readonly string[] = ["title", "content", "folder_id", "account_identifier"];

/** A Drive folder id is opaque and url-safe; anything else (paths, blanks, separators) is not a resolvable folder. */
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface GoogleDocsCreateAndVerifyInput {
  title: string;
  content: string;
  folder_id: string;
  account_identifier: string;
}

const BASE = { tool_id: GOOGLE_DOCS_TOOL_ID, operation_id: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID };

/**
 * Validates the input contract exactly: an object with precisely the four
 * declared non-empty string fields, nothing more. Returns the typed input or
 * the defect that made it invalid.
 */
function parseInput(input: unknown): GoogleDocsCreateAndVerifyInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input must be an object";
  }
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED_INPUT_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `unknown input field "${unknownKey}" -- the ${GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID} input contract is exactly ${ALLOWED_INPUT_KEYS.join(", ")}`;
  }
  const defect = ALLOWED_INPUT_KEYS.find((key) => typeof record[key] !== "string" || (record[key] as string).trim().length === 0);
  if (defect !== undefined) {
    return `input field "${defect}" must be a non-empty string`;
  }
  return {
    title: (record.title as string).trim(),
    content: record.content as string,
    folder_id: (record.folder_id as string).trim(),
    account_identifier: (record.account_identifier as string).trim(),
  };
}

/** Maps the existing createGoogleDoc stage result onto the five canonical outcome states -- honestly: a verification failure is never reported as "nothing happened". */
function mapCreateResult(result: Awaited<ReturnType<typeof createGoogleDoc>>): ToolInvocationOutcome {
  if (result.ok) {
    return {
      ...BASE,
      state: "succeeded",
      verified: true,
      ...(result.documentId ? { remote_resource: { document_id: result.documentId, ...(result.documentUrl ? { url: result.documentUrl } : {}) } } : {}),
    };
  }
  const stage = result.stage ?? "unknown";
  const error = result.error ?? "unknown error";
  const reason = `${stage}: ${error}`;
  if (stage === "validation" || stage === "auth") {
    // Nothing was attempted remotely: validation runs before the first
    // request, and the token stage before the first Drive call.
    return { ...BASE, state: "failed", stage, reason };
  }
  if (stage === "creation") {
    if (error.startsWith("Network error")) {
      // The request may have reached Google with the response lost -- a
      // possible remote effect that cannot be confirmed.
      return { ...BASE, state: "unverified", stage, reason, reconciliation_required: true };
    }
    if (error.includes("HTTP")) {
      // Google answered with a rejection: a definite failure, no file.
      return { ...BASE, state: "failed", stage, reason };
    }
    // A creation response arrived but no usable id (invalid JSON / missing
    // id): the file may exist with no identifier to reconcile against.
    return { ...BASE, state: "partially_completed", stage, reason, reconciliation_required: true };
  }
  if (stage === "insertion") {
    // The file was created (its id is known); the content step did not
    // complete. Partial, not a failure of the whole operation.
    return {
      ...BASE,
      state: "partially_completed",
      stage,
      reason,
      ...(result.documentId ? { remote_resource: { document_id: result.documentId, ...(result.documentUrl ? { url: result.documentUrl } : {}) } } : {}),
      reconciliation_required: true,
    };
  }
  // verification (or an unknown stage): the file exists, but the read-back
  // could not confirm the final state -- uncertain, never a definite failure.
  return {
    ...BASE,
    state: "unverified",
    stage,
    reason,
    ...(result.documentId ? { remote_resource: { document_id: result.documentId, ...(result.documentUrl ? { url: result.documentUrl } : {}) } } : {}),
    reconciliation_required: true,
  };
}

/** Reads a documents.get response body back as plain text, or null when the shape cannot be read. */
function extractGoogleDocText(data: unknown): string | null {
  const content = (data as { body?: { content?: unknown } })?.body?.content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const element of content) {
    const elements = (element as { paragraph?: { elements?: unknown } })?.paragraph?.elements;
    if (!Array.isArray(elements)) continue;
    for (const item of elements) {
      const run = (item as { textRun?: { content?: unknown } })?.textRun?.content;
      if (typeof run === "string") text += run;
    }
  }
  return text;
}

/**
 * Reconciles the remote state left by an uncertain earlier attempt BEFORE any
 * new creation: reads the document back by its preserved id and reports what
 * is actually there. Returns `outcome: null` only when the read establishes
 * that no document exists (404) -- the one case a fresh creation may proceed.
 * An unreachable read keeps the outcome unverified; it never becomes a
 * definite failure.
 */
async function reconcileGoogleDocCreation(
  env: Env,
  prior: ToolInvocationOutcome,
  input: unknown,
): Promise<{ outcome: ToolInvocationOutcome | null }> {
  const documentId = prior.remote_resource?.document_id;
  const parsed = parseInput(input);
  const uncertain = (reason: string): ToolInvocationOutcome => ({
    ...BASE,
    state: "unverified",
    reason,
    ...(prior.remote_resource ? { remote_resource: prior.remote_resource } : {}),
    reconciliation_required: true,
  });
  if (!documentId || typeof parsed === "string") {
    return { outcome: uncertain("the earlier attempt's remote effect cannot be reconciled (no usable document id or input) -- refusing to create again until it is resolved") };
  }
  try {
    const token = await getValidGoogleAccessToken(env, parsed.account_identifier);
    if (!token) {
      return {
        outcome: uncertain(`the authorized account has no valid access token, so the earlier document could not be read back -- still unverified; the account must be re-authorized before retrying`),
      };
    }
    const response = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      // The earlier attempt left nothing behind: creation may proceed.
      return { outcome: null };
    }
    if (!response.ok) {
      return { outcome: uncertain(`reconciliation read of the earlier document failed (HTTP ${response.status}) -- its state is still unconfirmed, so no new creation may start`) };
    }
    const data: unknown = await response.json();
    const title = (data as { title?: unknown })?.title;
    const text = extractGoogleDocText(data);
    if (typeof title === "string" && title === parsed.title && text !== null && text.includes(parsed.content)) {
      return {
        outcome: {
          ...BASE,
          state: "succeeded",
          verified: true,
          remote_resource: { document_id: documentId, ...(prior.remote_resource?.url ? { url: prior.remote_resource.url } : {}) },
          reason: "reconciled: the earlier attempt already created this document with the requested content",
        },
      };
    }
    return {
      outcome: {
        ...BASE,
        state: "partially_completed",
        remote_resource: { document_id: documentId, ...(prior.remote_resource?.url ? { url: prior.remote_resource.url } : {}) },
        reason: "reconciled: the earlier attempt's document exists but does not hold the requested content -- it must be reconciled, not recreated",
        reconciliation_required: true,
      },
    };
  } catch (error) {
    return { outcome: uncertain(`reconciliation read of the earlier document failed: ${error instanceof Error ? error.message : "unknown error"} -- no new creation may start`) };
  }
}

export const googleDocsToolOperation: ToolOperationDefinition = {
  toolId: GOOGLE_DOCS_TOOL_ID,
  operationId: GOOGLE_DOCS_CREATE_AND_VERIFY_OPERATION_ID,
  version: "1.0",
  effect: "external_mutation",

  validateInput(input: unknown): string | null {
    const parsed = parseInput(input);
    return typeof parsed === "string" ? parsed : null;
  },

  async resolveTarget(env: Env, input: unknown): Promise<{ ok: true; target: ResolvedToolTarget } | { ok: false; reason: string }> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") {
      return { ok: false, reason: `the google_docs target input is invalid: ${parsed}` };
    }
    if (!FOLDER_ID_PATTERN.test(parsed.folder_id)) {
      return {
        ok: false,
        reason: `folder_id "${parsed.folder_id}" is not a valid Drive folder identifier -- the external target must resolve to one folder, not an arbitrary path or blank`,
      };
    }
    const accounts = await listAuthorizedGoogleAccounts(env);
    if (accounts.length === 0) {
      return {
        ok: false,
        reason: "no Google account is authorized for this Worker, so the target account cannot be resolved from trusted runtime state -- no external mutation may proceed",
      };
    }
    if (!accounts.includes(parsed.account_identifier)) {
      return {
        ok: false,
        reason: `account "${parsed.account_identifier}" is not one of the ${accounts.length} account(s) this Worker is authorized for -- a Tool invocation may not select an arbitrary account`,
      };
    }
    return { ok: true, target: { resourceId: `gdrive:folder:${parsed.folder_id}` } };
  },

  async run(env: Env, input: unknown): Promise<ToolInvocationOutcome> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") {
      // Defensive: validateInput already ran. A failure here makes no request.
      return { ...BASE, state: "failed", stage: "validation", reason: `validation: ${parsed}` };
    }
    const result = await createGoogleDoc(env, {
      type: "create_doc",
      title: parsed.title,
      content: parsed.content,
      folderId: parsed.folder_id,
      accountIdentifier: parsed.account_identifier,
    });
    return mapCreateResult(result);
  },

  reconcile: reconcileGoogleDocCreation,
};
