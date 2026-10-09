/**
 * Registered Google Docs WRITE operation over an EXISTING document --
 * `google_docs.update_and_verify`, version 1.0, effect `external_mutation`:
 * bring THE document to the exact requested Proposal-version content plus the
 * canonical styling (delete + insert + style in one batchUpdate), then read
 * it back and claim success only when it verifies.
 *
 * This is the mutation `ensureProposalDoc` previously issued as a direct
 * Docs batchUpdate call, in both of its paths: bringing an existing Doc up
 * to a newer Version (a revision), and the canonical styling pass that
 * immediately follows creation. It now runs through the shared invocation
 * boundary (src/runtime/toolRegistry.ts): exact operation, strict input
 * contract, trusted target (validated document identity + an account this
 * Worker is actually authorized for), Access on the Work's own Action,
 * durable intent/outcome records, and the canonical five outcomes.
 *
 * The input carries pure business data only -- the Proposal id and the exact
 * Version content -- and the operation rebuilds the canonical layout itself
 * (buildProposalDocLayout), so no provider request structures and no styling
 * details ever enter the input contract. The document is targeted by its
 * opaque Drive id, validated here and bound by Access to any approval
 * evidence; account selection is resolved from this Worker's authorized
 * accounts, never taken from a caller.
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
import { buildProposalDocLayout } from "../../proposalRedline";

export const GOOGLE_DOCS_UPDATE_OPERATION_ID = "google_docs.update_and_verify";

/** Exactly the declared input contract: the document to act on and the Proposal content it must hold. */
const ALLOWED_INPUT_KEYS: readonly string[] = ["document_id", "account_identifier", "proposal_id", "versions"];

/** An opaque url-safe Google document id -- never a path, URL or blank. */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One Proposal version's content, as the layout builder consumes it. */
interface DocWriteVersion {
  version: number;
  content: string;
}

interface DocWriteInput {
  document_id: string;
  account_identifier: string;
  proposal_id: string;
  versions: DocWriteVersion[];
}

const BASE = { tool_id: "google_docs", operation_id: GOOGLE_DOCS_UPDATE_OPERATION_ID };

/**
 * Validates the input contract exactly: an object with precisely the four
 * declared fields; an opaque document id; a non-empty Proposal id; and a
 * non-empty list of well-formed versions (integer number >= 1 + non-empty
 * content, no extra keys per entry, bounded count). Returns the typed input
 * or the defect that made it invalid.
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
  if (typeof record.proposal_id !== "string" || record.proposal_id.trim().length === 0) {
    return "proposal_id must be a non-empty string";
  }
  if (!Array.isArray(record.versions) || record.versions.length === 0) {
    return "versions must be a non-empty array of the Proposal's versions in order";
  }
  if (record.versions.length > 200) return "versions carries more than 200 entries -- a document update input of that size is not a Proposal version list";
  const versions: DocWriteVersion[] = [];
  for (let i = 0; i < record.versions.length; i++) {
    const entry = record.versions[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `versions[${i}] must be an object with {version, content}`;
    const versionRecord = entry as Record<string, unknown>;
    const unexpected = Object.keys(versionRecord).find((key) => key !== "version" && key !== "content");
    if (unexpected !== undefined) return `versions[${i}] has unknown field "${unexpected}" -- each entry is exactly {version, content}`;
    if (typeof versionRecord.version !== "number" || !Number.isInteger(versionRecord.version) || versionRecord.version < 1) {
      return `versions[${i}].version must be an integer >= 1`;
    }
    if (typeof versionRecord.content !== "string" || versionRecord.content.trim().length === 0) {
      return `versions[${i}].content must be a non-empty string`;
    }
    versions.push({ version: versionRecord.version, content: versionRecord.content });
  }
  return {
    document_id: record.document_id.trim(),
    account_identifier: record.account_identifier.trim(),
    proposal_id: record.proposal_id.trim(),
    versions,
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
  let desired: string;
  try {
    desired = buildProposalDocLayout(parsed.proposal_id, parsed.versions).text;
  } catch (error) {
    return { outcome: uncertain(`the requested document state could not be rebuilt to compare against (${error instanceof Error ? error.message : "unknown error"}) -- no new write may start`) };
  }
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

/** `google_docs.update_and_verify`: bring THE document to the exact requested content + canonical styling, verified by read-back. */
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
    const layout = buildProposalDocLayout(parsed.proposal_id, parsed.versions);
    const result = await rewriteGoogleDoc(env, parsed.account_identifier, parsed.document_id, layout);
    return mapUpdateResult(result, parsed.document_id);
  },

  reconcile: (env, _prior, input) => reconcileDocumentWrite(env, input),
};
