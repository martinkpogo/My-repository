/**
 * Registered Google Docs STYLING operation over an EXISTING document --
 * `google_docs.format_and_verify`, version 1.0, effect `external_mutation`:
 * apply THE canonical Proposal layout styling to the document, change not one
 * character of its text, and claim success only after reading the document
 * back.
 *
 * This is the governed form of the presentation-only pass: it sends exactly
 * the requests `buildProposalDocStyleRequests` derives (paragraph hierarchy,
 * bullets, bold headings/labels, struck removed text, underlined added text)
 * through `restyleGoogleDoc`, which by construction contains no insert and no
 * delete. Everything else is the shared invocation boundary
 * (src/runtime/toolRegistry.ts): exact operation, strict input contract,
 * trusted target (validated document identity + an account this Worker is
 * actually authorized for), Access on the Work's own Action -- including a
 * bound ApprovalProof when that Action is approval-gated -- durable
 * intent/outcome records, and the canonical five outcomes.
 *
 * The input carries the same pure business data as `google_docs.update_and_verify`
 * (the document, the trusted account, the Proposal id and its exact Version
 * content in order); the operation rebuilds the canonical layout itself, so
 * no provider request structure and no styling detail ever enters the
 * contract. Because the layout is rebuilt from the Proposal's own Version
 * data, the styling a comment merely ASKED for can never select what is
 * applied: the Proposal is the source of truth.
 *
 * Reconciliation is operation-specific and must be more careful than a
 * rewrite's, because a styling pass leaves the text untouched -- text alone
 * can never show whether styles were applied. An interrupted attempt is
 * therefore settled by READING THE DOCUMENT'S ACTUAL STYLING: paragraph
 * named styles, bullets and indents (against the same canonical table the
 * requests came from) plus the inline marks. A Doc already showing the
 * canonical styling is the effect, recovered as a verified success and never
 * re-sent; a Doc showing otherwise has no styling effect to recover, so a
 * fresh (idempotent, text-verified) pass may proceed; an unreachable read
 * keeps the outcome unverified and held rather than guessing either way.
 */
import type { Env } from "../../types";
import type { ResolvedToolTarget, ToolInvocationOutcome, ToolOperationDefinition } from "../toolRegistry";
import { getValidGoogleAccessToken, listAuthorizedGoogleAccounts, readGoogleDocStyling, restyleGoogleDoc } from "../../googleOAuth";
import { buildProposalDocLayout, expectedDocParagraphStyles, type ProposalDocLayout } from "../../proposalRedline";

export const GOOGLE_DOCS_FORMAT_OPERATION_ID = "google_docs.format_and_verify";

/** Exactly the declared input contract: the document to style and the Proposal content whose canonical layout it must show. */
const ALLOWED_INPUT_KEYS: readonly string[] = ["document_id", "account_identifier", "proposal_id", "versions"];

/** An opaque url-safe Google document id -- never a path, URL or blank. */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One Proposal version's content, as the layout builder consumes it. */
interface DocWriteVersion {
  version: number;
  content: string;
}

interface DocFormatInput {
  document_id: string;
  account_identifier: string;
  proposal_id: string;
  versions: DocWriteVersion[];
}

const BASE = { tool_id: "google_docs", operation_id: GOOGLE_DOCS_FORMAT_OPERATION_ID };

/**
 * Validates the input contract exactly: an object with precisely the four
 * declared fields; an opaque document id; a non-empty Proposal id; and a
 * non-empty list of well-formed versions (integer number >= 1 + non-empty
 * content, no extra keys per entry, bounded count). Returns the typed input
 * or the defect that made it invalid.
 */
function parseInput(input: unknown): DocFormatInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !ALLOWED_INPUT_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `unknown input field "${unknownKey}" -- the document formatting input contract is exactly ${ALLOWED_INPUT_KEYS.join(", ")}`;
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
  if (record.versions.length > 200) return "versions carries more than 200 entries -- a document formatting input of that size is not a Proposal version list";
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
async function resolveTarget(env: Env, input: unknown): Promise<{ ok: true; target: ResolvedToolTarget } | { ok: false; reason: string }> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") return { ok: false, reason: `the google_docs formatting target input is invalid: ${parsed}` };
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

/** The canonical layout for a validated input: rebuilt from the Proposal's OWN Version data, never from a comment. */
function layoutFor(parsed: DocFormatInput): ProposalDocLayout {
  return buildProposalDocLayout(parsed.proposal_id, parsed.versions);
}

/**
 * Maps the styling pass results onto the five canonical outcome states --
 * honestly. A pass that read back byte-identical is the one verified success;
 * a refusal BEFORE the batchUpdate (no token, unreadable Doc, drifted text)
 * is a definite failure with no effect; a rejected request is a definite
 * failure of this attempt; a lost response may have reached Google and an
 * unconfirmed read-back may have applied styles, so both are uncertain and
 * must be reconciled rather than repeated.
 */
function mapFormatResult(result: { ok: true } | { ok: false; error: string }, documentId: string): ToolInvocationOutcome {
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
    // The pre-format read failed: nothing was styled.
    return { ...BASE, state: "failed", stage: "read", reason: error };
  }
  if (error.startsWith("the Doc's text no longer matches")) {
    // The drift gate refused BEFORE the batchUpdate: nothing was styled, and
    // nothing may be -- the document no longer shows the Version it is bound
    // to, which is a refusal, never a partial effect.
    return { ...BASE, state: "failed", stage: "baseline", reason: error };
  }
  if (error.startsWith("network error")) {
    // The request may have reached Google with the response lost.
    return { ...BASE, state: "unverified", stage: "batch_update", reason: error, remote_resource: remote, reconciliation_required: true };
  }
  if (error.includes("HTTP")) {
    // Google answered with a rejection: a definite failure of this attempt.
    return { ...BASE, state: "failed", stage: "batch_update", reason: error };
  }
  if (error === "the Doc's text changed while it was being formatted") {
    // The batchUpdate was accepted but the verification read no longer
    // matched: styles may be applied and the text moved underneath it.
    // Partial, reconciled before any retry -- never a success claim.
    return { ...BASE, state: "partially_completed", stage: "verification", reason: error, remote_resource: remote, reconciliation_required: true };
  }
  // Unknown defect: the remote state cannot be assumed either way.
  return { ...BASE, state: "unverified", reason: error, remote_resource: remote, reconciliation_required: true };
}

/** True when the text runs the observed styling covers exactly the inline marks the canonical layout asks for. */
function inlineMarksMatch(observed: { start: number; end: number; bold: boolean; strikethrough: boolean; underline: boolean }[], layout: ProposalDocLayout): boolean {
  const covered = (range: { start: number; end: number }, mark: (run: { bold: boolean; strikethrough: boolean; underline: boolean }) => boolean): boolean => {
    const overlapping = observed.filter((run) => run.start < range.end && run.end > range.start);
    if (overlapping.length === 0) return false;
    return overlapping.every((run) => mark(run));
  };
  return layout.styles.every((style) => {
    if (style.kind === "heading" || style.kind === "label") return covered(style, (run) => run.bold);
    if (style.kind === "del") return covered(style, (run) => run.strikethrough);
    return covered(style, (run) => run.underline);
  });
}

/**
 * True when the Doc actually shows the canonical styling this layout asks
 * for: the same number of paragraphs, each carrying the named style, bullet
 * and indent the canonical table derives, and every inline mark the layout
 * declares actually present. Derived from the SAME tables the style requests
 * came from, so "applied" can only ever mean "the canonical layout".
 */
function stylingMatches(observed: { paragraphs: { namedStyleType: string; bulleted: boolean; indentStartPt: number; text: string }[]; runs: { start: number; end: number; bold: boolean; strikethrough: boolean; underline: boolean }[] }, layout: ProposalDocLayout): boolean {
  const observedParagraphs = [...observed.paragraphs];
  // The Docs body always carries one required trailing empty paragraph after
  // a text that ends in a newline (which every canonical layout does). It is
  // the API's own bookkeeping, not a styled block, so it is not compared.
  const last = observedParagraphs[observedParagraphs.length - 1];
  if (last && last.text === "") observedParagraphs.pop();
  const expected = expectedDocParagraphStyles(layout);
  if (observedParagraphs.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    const got = observedParagraphs[i];
    if (got.namedStyleType !== want.namedStyleType) return false;
    if (got.bulleted !== want.bulleted) return false;
    // Google stores points as exact values here, but compare with a hair of
    // tolerance so a unit conversion cannot read as a mismatch.
    if (Math.abs(got.indentStartPt - want.indentStartPt) > 0.5) return false;
  }
  return inlineMarksMatch(observed.runs, layout);
}

/**
 * Settles an interrupted formatting attempt by reading THE document it
 * targeted -- its actual styling, since its text cannot show whether styles
 * were applied. Returns `succeeded` (recovered, never re-sent) only when the
 * Doc already shows the canonical styling; `outcome: null` when it does not,
 * which is the one state in which a fresh pass may proceed (idempotent and
 * text-verified by construction); and an unverified, held outcome whenever
 * the remote state genuinely cannot be established.
 */
async function reconcileFormatting(env: Env, input: unknown): Promise<{ outcome: ToolInvocationOutcome | null }> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") {
    return {
      outcome: {
        ...BASE,
        state: "unverified",
        reason: `the earlier attempt's remote effect cannot be reconciled (${parsed}) -- no new styling may be applied until it is resolved`,
        reconciliation_required: true,
      },
    };
  }
  const remote = { document_id: parsed.document_id, url: documentUrl(parsed.document_id) };
  const held = (reason: string): ToolInvocationOutcome => ({ ...BASE, state: "unverified", reason, remote_resource: remote, reconciliation_required: true });
  let layout: ProposalDocLayout;
  try {
    layout = layoutFor(parsed);
  } catch (error) {
    return { outcome: held(`the canonical layout could not be rebuilt to compare against (${error instanceof Error ? error.message : "unknown error"}) -- no new styling may be applied`) };
  }
  try {
    const token = await getValidGoogleAccessToken(env, parsed.account_identifier);
    if (!token) {
      return { outcome: held("the authorized account has no valid access token, so the document could not be read back -- the account must be re-authorized before the earlier attempt can be resolved") };
    }
    const observed = await readGoogleDocStyling(token, parsed.document_id);
    if (!observed) {
      return { outcome: held("the document's styling could not be read back, so the earlier attempt's effect is still unconfirmed -- no new styling may be applied") };
    }
    if (observed.text.trimEnd() !== layout.text.trimEnd()) {
      // The document no longer shows the Version this operation was asked to
      // style: the styling pass's own drift gate would refuse a fresh attempt
      // too, so nothing is recovered and nothing may be applied.
      return {
        outcome: {
          ...BASE,
          state: "failed",
          stage: "baseline",
          reason: "the document's text no longer matches the Version it is bound to, so the earlier attempt's styling cannot be confirmed and no styling may be applied to drifted content",
          remote_resource: remote,
        },
      };
    }
    if (stylingMatches(observed, layout)) {
      // The Doc already shows the canonical styling: the effect exists and is
      // verified, so it is recovered and never re-sent.
      return {
        outcome: {
          ...BASE,
          state: "succeeded",
          verified: true,
          remote_resource: remote,
          reason: "reconciled: the document already shows the canonical styling",
        },
      };
    }
    // No styling effect to recover, and a fresh styling pass is idempotent
    // and text-verified, so it may proceed without duplicating or corrupting
    // anything.
    return { outcome: null };
  } catch (error) {
    return { outcome: held(`the document's styling could not be read back: ${error instanceof Error ? error.message : "unknown error"} -- no new styling may be applied`) };
  }
}

/** `google_docs.format_and_verify`: apply the canonical Proposal styling, change no text, verify by read-back. */
export const googleDocsFormatToolOperation: ToolOperationDefinition = {
  toolId: "google_docs",
  operationId: GOOGLE_DOCS_FORMAT_OPERATION_ID,
  version: "1.0",
  effect: "external_mutation",

  validateInput(input: unknown): string | null {
    const parsed = parseInput(input);
    return typeof parsed === "string" ? parsed : null;
  },

  resolveTarget,

  async run(env: Env, input: unknown): Promise<ToolInvocationOutcome> {
    const parsed = parseInput(input);
    if (typeof parsed === "string") {
      // Defensive: validateInput already ran. A failure here makes no request.
      return { ...BASE, state: "failed", stage: "validation", reason: `validation: ${parsed}` };
    }
    const result = await restyleGoogleDoc(env, parsed.account_identifier, parsed.document_id, layoutFor(parsed));
    return mapFormatResult(result, parsed.document_id);
  },

  reconcile: (env, _prior, input) => reconcileFormatting(env, input),
};
