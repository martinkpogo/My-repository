/**
 * Registered Google Docs WRITE operation over an EXISTING document --
 * `google_docs.update_and_verify`, version 1.0, effect `external_mutation`:
 * bring THE document to the exact body the resolved Action's
 * `document_specification` describes (text + structure + styling in one
 * batchUpdate), then read it back and claim success only when the COMPLETE
 * specification verifies -- the text is exactly what was requested AND the
 * declared paragraph styles, bullets, indentation and inline marks are
 * actually shown. Matching text alone is never proof of success.
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
 * The input carries the document to act on, the trusted account, and the
 * Action's declarative `document_specification` -- validated and mapped to
 * provider requests by the Tool's neutral specification module
 * (src/googleDocSpec.ts). This operation contains no business layout logic:
 * what the document shows (content, sections, ordering, structure,
 * presentation intent) is the Action's decision, and an instruction this
 * operation does not support fails validation explicitly rather than being
 * dropped. The specification keeps the PROTECTED identity form of the
 * content it was assembled from; the declared
 * `presentation.restore_identity_placeholders` is applied here, at the final
 * internal-presentation boundary of the write, with the declared ranges
 * remapped onto the restored text by the one shared restoration function.
 * The document is targeted by its opaque Drive id, validated here and bound
 * by Access to any approval evidence; account selection is resolved from
 * this Worker's authorized accounts, never taken from a caller.
 *
 * Reconciliation is operation-specific: this operation acts on a KNOWN
 * document id (its target), so an interrupted attempt is settled by reading
 * that document back -- BOTH halves of the specification: a document
 * showing the exact requested text with its declared styling means the
 * effect exists (recovered as a verified success, never rewritten again),
 * while differing text OR matching text with missing/wrong styling means
 * the requested effect was not applied (a fresh attempt may proceed: update
 * overwrites the body and its styling wholesale), an unreachable read keeps
 * the outcome unverified and held, and a vanished document is a definite
 * failure (this operation never creates documents).
 */
import type { Env } from "../../types";
import type { ResolvedToolTarget, ToolInvocationOutcome, ToolOperationDefinition } from "../toolRegistry";
import { getValidGoogleAccessToken, listAuthorizedGoogleAccounts, parseGoogleDocStyling, rewriteGoogleDoc } from "../../googleOAuth";
import { materializeDocumentSpecification, observedStylingMatches, parseDocumentSpecification, type DocumentSpecification, type GoogleDocLayout } from "../../googleDocSpec";

export const GOOGLE_DOCS_UPDATE_OPERATION_ID = "google_docs.update_and_verify";

/** Exactly the declared input contract: the document to act on and the specification of the body it must hold. */
const ALLOWED_INPUT_KEYS: readonly string[] = ["document_id", "account_identifier", "document_specification"];

/** An opaque url-safe Google document id -- never a path, URL or blank. */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface DocWriteInput {
  document_id: string;
  account_identifier: string;
  document_specification: DocumentSpecification;
  /** The specification resolved to the exact body this operation writes and verifies (presentation applied, ranges remapped). */
  layout: GoogleDocLayout;
}

const BASE = { tool_id: "google_docs", operation_id: GOOGLE_DOCS_UPDATE_OPERATION_ID };

/**
 * Validates the input contract exactly: an object with precisely the three
 * declared fields; an opaque document id; a non-empty account; and a
 * well-formed `document_specification` (text plus optional, well-formed
 * structure/styling ranges in the supported vocabulary, resolved to a
 * writable body). Returns the typed input or the defect that made it
 * invalid.
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
  const specification = parseDocumentSpecification(record.document_specification, { allow_layout: true });
  if (typeof specification === "string") return `document_specification is invalid: ${specification}`;
  const materialized = materializeDocumentSpecification(specification);
  if (!materialized.ok) return `document_specification is invalid: ${materialized.reason}`;
  return {
    document_id: record.document_id.trim(),
    account_identifier: record.account_identifier.trim(),
    document_specification: specification,
    layout: materialized.layout,
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
  if (error.startsWith("the Doc read back with the wrong formatting")) {
    // The batchUpdate was accepted and the text is exactly what was
    // requested, but the declared styling is not actually shown: the write
    // did not produce the complete specification. Partial, reconciled by
    // reading the document's ACTUAL styling before any retry -- matching
    // text alone is never a verified success.
    return { ...BASE, state: "partially_completed", stage: "verification", reason: error, remote_resource: remote, reconciliation_required: true };
  }
  // Unknown defect: the remote state cannot be assumed either way.
  return { ...BASE, state: "unverified", reason: error, remote_resource: remote, reconciliation_required: true };
}

/**
 * Settles an interrupted attempt by reading THE document it targeted --
 * both halves of the specification, not just its text. Returns
 * `outcome: null` only when the read establishes that the requested effect
 * does NOT exist (text differs, or the text matches while the declared
 * styling, paragraph hierarchy, bullets or indentation are missing or
 * wrong), which is the one state in which a fresh attempt may proceed (an
 * update overwrites the body wholesale, so it is safe); a document showing
 * the COMPLETE specification is the effect, recovered as a verified
 * success and never rewritten; an unreachable read keeps the outcome
 * unverified and held; a vanished document is a definite failure (never a
 * recreation). Matching text alone is never enough: a body without its
 * declared formatting is not the requested effect.
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
  // The requested body was already resolved during validation (parseInput),
  // so the comparison target is exactly what a fresh write would produce.
  const desired = parsed.layout;
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
    if (!body) {
      return { outcome: uncertain("the reconciliation read returned no readable document body -- no new write may start") };
    }
    const observed = parseGoogleDocStyling(body);
    if (observed.text.trimEnd() !== desired.text.trimEnd()) {
      // The requested effect is not present; update overwrites the body
      // wholesale, so a fresh attempt is safe.
      return { outcome: null };
    }
    if (!observedStylingMatches(desired, observed)) {
      // The text matches but the declared formatting does not: the earlier
      // attempt did NOT produce the complete specification, so it is never
      // recovered as a success on text alone. A fresh attempt is safe (the
      // update rewrites the body and its styling wholesale), so it may
      // proceed.
      return { outcome: null };
    }
    // The earlier attempt already wrote the complete requested specification:
    // recovered as a verified success, and the document is never rewritten.
    return {
      outcome: {
        ...BASE,
        state: "succeeded",
        verified: true,
        remote_resource: remote,
        reason: "reconciled: the earlier attempt already wrote the requested content with its declared styling",
      },
    };
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
    const result = await rewriteGoogleDoc(env, parsed.account_identifier, parsed.document_id, parsed.layout);
    return mapUpdateResult(result, parsed.document_id);
  },

  reconcile: (env, _prior, input) => reconcileDocumentWrite(env, input),
};
