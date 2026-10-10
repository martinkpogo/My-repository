/**
 * Registered Google Drive folder operation -- `google_drive.ensure_folder`,
 * version 1.0, effect `external_mutation`: bring ONE named folder into
 * existence on an authorized account (find-or-create), verified by an actual
 * Drive read before success is claimed.
 *
 * This is the mutation `ensureProposalDoc` previously issued as a direct
 * Drive files.create call. It runs through the shared invocation boundary
 * (src/runtime/toolRegistry.ts): exact operation, strict input contract,
 * trusted target (folder identity + an account this Worker is actually
 * authorized for), Access on the Work's own Action, durable intent/outcome
 * records, and the canonical five outcomes. The KV cache the established
 * `ensureGoogleFolder` mechanism uses is honored and updated here -- it is
 * ENIG's own controlled persistence, not a second source of authorization,
 * and a cache hit is still read-verified against Drive before it is reported
 * as a verified success.
 *
 * Reconciliation is operation-specific: this operation's effect is "a folder
 * with this name exists on this account", so an interrupted attempt is
 * settled by LISTING folders by exact name -- found means the effect exists
 * (recovered as verified success, cache updated), absent means a fresh
 * attempt may proceed, an unreachable read keeps the outcome held.
 */
import type { Env } from "../../types";
import type { ResolvedToolTarget, ToolInvocationOutcome, ToolOperationDefinition } from "../toolRegistry";
import { ensureGoogleFolder, getValidGoogleAccessToken, listAuthorizedGoogleAccounts } from "../../googleOAuth";
import { kvDelete, kvPut } from "./../../kvStore";

export const GOOGLE_DRIVE_TOOL_ID = "google_drive";
export const GOOGLE_DRIVE_ENSURE_FOLDER_OPERATION_ID = "google_drive.ensure_folder";

/** Exactly the declared input contract: which account, which folder, under which ENIG cache key. */
const ALLOWED_INPUT_KEYS: readonly string[] = ["account_identifier", "folder_name", "kv_key"];

/** A folder name is human text: non-empty, bounded, no control characters -- not an id, path or query. */
function isValidFolderName(name: string): boolean {
  return name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(name);
}

/** The ENIG-internal KV cache key the folder id is memoized under: a plain lowercase key, never arbitrary input. */
const KV_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;

interface EnsureFolderInput {
  account_identifier: string;
  folder_name: string;
  kv_key: string;
}

const BASE = { tool_id: GOOGLE_DRIVE_TOOL_ID, operation_id: GOOGLE_DRIVE_ENSURE_FOLDER_OPERATION_ID };

function parseInput(input: unknown): EnsureFolderInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED_INPUT_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `unknown input field "${unknownKey}" -- the ${GOOGLE_DRIVE_ENSURE_FOLDER_OPERATION_ID} input contract is exactly ${ALLOWED_INPUT_KEYS.join(", ")}`;
  }
  const defect = ALLOWED_INPUT_KEYS.find((key) => typeof record[key] !== "string" || (record[key] as string).trim().length === 0);
  if (defect !== undefined) return `input field "${defect}" must be a non-empty string`;
  const folderName = (record.folder_name as string).trim();
  if (!isValidFolderName(folderName)) return "folder_name must be a plain folder name (at most 100 characters, no control characters)";
  const kvKey = (record.kv_key as string).trim();
  if (!KV_KEY_PATTERN.test(kvKey)) return `kv_key "${kvKey}" is not a valid ENIG folder cache key (lowercase letters, digits and underscores only)`;
  return {
    account_identifier: (record.account_identifier as string).trim(),
    folder_name: folderName,
    kv_key: kvKey,
  };
}

/** Reads one Drive file back by id, or classifies why its state could not be read. */
async function readDriveFile(
  env: Env,
  accountIdentifier: string,
  fileId: string,
): Promise<{ ok: true; file: { id?: string; name?: string; mimeType?: string; trashed?: boolean } } | { ok: false; missing: boolean; reason: string }> {
  try {
    const token = await getValidGoogleAccessToken(env, accountIdentifier);
    if (!token) return { ok: false, missing: false, reason: "Google Workspace authorization missing or invalid" };
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,trashed`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return { ok: false, missing: true, reason: `the folder id no longer exists on Drive (HTTP 404)` };
    if (!response.ok) return { ok: false, missing: false, reason: `the folder could not be read back (HTTP ${response.status})` };
    const file = (await response.json().catch(() => ({}))) as { id?: string; name?: string; mimeType?: string; trashed?: boolean };
    return { ok: true, file };
  } catch (error) {
    return { ok: false, missing: false, reason: `the folder read failed: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

/** Maps the established ensureGoogleFolder stage result onto the five canonical outcome states. */
function mapEnsureResult(result: { ok: true; folderId: string } | { ok: false; error: string }): ToolInvocationOutcome {
  if (result.ok) {
    return { ...BASE, state: "succeeded", verified: true, remote_resource: { document_id: result.folderId } };
  }
  const error = result.error ?? "unknown error";
  if (error === "Google Workspace authorization missing or invalid") {
    // The token stage failed before the first Drive request.
    return { ...BASE, state: "failed", stage: "auth", reason: error };
  }
  if (error.startsWith("Network error")) {
    // The request may have reached Google with the response lost.
    return { ...BASE, state: "unverified", stage: "creation", reason: error, reconciliation_required: true };
  }
  if (error.includes("HTTP")) {
    // Google answered with a rejection: a definite failure, no folder.
    return { ...BASE, state: "failed", stage: "creation", reason: error };
  }
  // A creation response arrived but no usable id: a folder may exist with no
  // identifier to reconcile against.
  return { ...BASE, state: "partially_completed", stage: "creation", reason: error, reconciliation_required: true };
}

/** Escapes a literal value for use inside a Drive query string. */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Reconciles an interrupted ensure by LISTING folders with this exact name:
 * found (any count) is the desired effect, verified from the list read and
 * memoized into ENIG's own cache so later ensures reuse it; none found means
 * no effect exists and a fresh creation may proceed; an unreachable list keeps
 * the outcome unverified and held.
 */
async function reconcileFolderEnsure(env: Env, input: unknown): Promise<{ outcome: ToolInvocationOutcome | null }> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") {
    return {
      outcome: {
        ...BASE,
        state: "unverified",
        reason: `the earlier attempt's remote effect cannot be reconciled (${parsed}) -- refusing to create again until it is resolved`,
        reconciliation_required: true,
      },
    };
  }
  try {
    const token = await getValidGoogleAccessToken(env, parsed.account_identifier);
    if (!token) {
      return {
        outcome: {
          ...BASE,
          state: "unverified",
          reason: "the authorized account has no valid access token, so the earlier folder could not be read back -- the account must be re-authorized before the attempt can be resolved",
          reconciliation_required: true,
        },
      };
    }
    const query = `name='${escapeQueryValue(parsed.folder_name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return {
        outcome: {
          ...BASE,
          state: "unverified",
          reason: `reconciliation list of existing folders failed (HTTP ${response.status}) -- the remote state is still unconfirmed, so no new creation may start`,
          reconciliation_required: true,
        },
      };
    }
    const data = (await response.json().catch(() => ({}))) as { files?: { id?: string; name?: string }[] };
    const files = (data.files ?? []).filter((file) => typeof file.id === "string" && file.id.length > 0 && file.name === parsed.folder_name);
    if (files.length === 0) {
      // Confirmed absence: no folder with this name exists, so the earlier
      // attempt left nothing behind and a fresh creation may proceed.
      return { outcome: null };
    }
    const folderId = files[0].id!;
    // Memoize into ENIG's own cache (the same key ensureGoogleFolder uses),
    // so the next ensure reuses the folder this reconciliation recovered.
    // Truthful post-effect failure: this key class is Cloudflare-only (its
    // key embeds the account email), so a refused cache write must NOT be
    // reported as "unverified" -- the reconciliation above succeeded and
    // the recovered folder id is real. Log the degraded cache instead.
    try {
      await kvPut(env, `${parsed.kv_key}:${parsed.account_identifier}`, folderId);
    } catch (cacheErr) {
      console.error(
        `googleDriveFolderTool: reconciliation recovered folder ${folderId} but its folder-id cache write was refused -- the id is returned; a later ensure may re-create this folder while the cache is unwritable`,
        cacheErr,
      );
    }
    return {
      outcome: {
        ...BASE,
        state: "succeeded",
        verified: true,
        remote_resource: { document_id: folderId, url: `https://drive.google.com/drive/folders/${folderId}` },
        reason:
          files.length === 1
            ? "reconciled: the earlier attempt already created this folder"
            : `reconciled: ${files.length} folders with this name already exist; using the first`,
      },
    };
  } catch (error) {
    return {
      outcome: {
        ...BASE,
        state: "unverified",
        reason: `reconciliation list of existing folders failed: ${error instanceof Error ? error.message : "unknown error"} -- no new creation may start`,
        reconciliation_required: true,
      },
    };
  }
}

export const googleDriveEnsureFolderToolOperation: ToolOperationDefinition = {
  toolId: GOOGLE_DRIVE_TOOL_ID,
  operationId: GOOGLE_DRIVE_ENSURE_FOLDER_OPERATION_ID,
  version: "1.0",
  effect: "external_mutation",

  validateInput(input: unknown): string | null {
    const parsed = parseInput(input);
    return typeof parsed === "string" ? parsed : null;
  },

  async resolveTarget(env: Env, input: unknown): Promise<{ ok: true; target: ResolvedToolTarget } | { ok: false; reason: string }> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") return { ok: false, reason: `the google_drive target input is invalid: ${parsed}` };
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
    return { ok: true, target: { resourceId: `gdrive:folder:${parsed.account_identifier}:${parsed.folder_name}` } };
  },

  async run(env: Env, input: unknown): Promise<ToolInvocationOutcome> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") {
      // Defensive: validateInput already ran. A failure here makes no request.
      return { ...BASE, state: "failed", stage: "validation", reason: `validation: ${parsed}` };
    }
    const ensured = await ensureGoogleFolder(env, parsed.account_identifier, parsed.folder_name, parsed.kv_key);
    if (!ensured.ok) return mapEnsureResult(ensured);
    // Success is claimed only after an actual Drive read confirms this exact
    // folder id is the named folder (the KV cache may be stale).
    const verified = await readDriveFile(env, parsed.account_identifier, ensured.folderId);
    if (verified.ok) {
      const file = verified.file;
      if (file.id && file.name === parsed.folder_name && file.mimeType === "application/vnd.google-apps.folder" && file.trashed !== true) {
        return {
          ...BASE,
          state: "succeeded",
          verified: true,
          remote_resource: { document_id: file.id, url: `https://drive.google.com/drive/folders/${file.id}` },
        };
      }
      return {
        ...BASE,
        state: "unverified",
        stage: "verification",
        reason: "the folder id did not read back as the requested folder on Drive -- its state is unconfirmed, so it must be reconciled, not reused",
        ...(file.id ? { remote_resource: { document_id: file.id } } : {}),
        reconciliation_required: true,
      };
    }
    if (verified.missing) {
      if (!ensured.ok) {
        // Both the creation attempt and the read say nothing is there.
        return { ...BASE, state: "failed", stage: "verification", reason: `the folder could not be created and its id does not exist on Drive: ${verified.reason}` };
      }
      // The cached/just-created id does not exist (stale cache): clear the
      // memo and create the folder for real, once.
      await kvDelete(env, `${parsed.kv_key}:${parsed.account_identifier}`);
      const retry = await ensureGoogleFolder(env, parsed.account_identifier, parsed.folder_name, parsed.kv_key);
      if (!retry.ok) return mapEnsureResult(retry);
      const retried = await readDriveFile(env, parsed.account_identifier, retry.folderId);
      if (retried.ok && retried.file.id && retried.file.name === parsed.folder_name && retried.file.mimeType === "application/vnd.google-apps.folder" && retried.file.trashed !== true) {
        return { ...BASE, state: "succeeded", verified: true, remote_resource: { document_id: retried.file.id, url: `https://drive.google.com/drive/folders/${retried.file.id}` } };
      }
      return {
        ...BASE,
        state: "unverified",
        stage: "verification",
        reason: "the recreated folder could not be verified on Drive -- its state is unconfirmed and must be reconciled before any further attempt",
        reconciliation_required: true,
      };
    }
    // The folder (from cache or creation) may exist but could not be read.
    return {
      ...BASE,
      state: "unverified",
      stage: "verification",
      reason: verified.reason,
      ...(ensured.ok ? { remote_resource: { document_id: ensured.folderId } } : {}),
      reconciliation_required: true,
    };
  },

  reconcile: (env, _prior, input) => reconcileFolderEnsure(env, input),
};
