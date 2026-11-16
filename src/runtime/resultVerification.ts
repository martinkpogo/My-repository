/**
 * BD-13 Machinery Worker Result verification -- the Work-lifecycle trigger
 * that closes BD-8's one missing path: WHO performs the independent Checker
 * verification when a Unit produces its Result. Per Martin's approved
 * design (BD-13, Notion 2026-10-31), the Checker is a Machinery Worker
 * identified by the canonical Organization model: the runtime reads its
 * identity and its `verify_work_result` capability grant LIVE from the
 * canonical Operations page (never hard-coded, never asserted by a caller),
 * and the Work's own lifecycle invokes the check at the Result verification
 * gate. No new Unit, Hat, Action, workflow or trigger is introduced: the
 * verdict enters WorkState through the ONE sanctioned recorder
 * (`recordCheckerVerdict` in src/resultReview.ts), is hash-bound to the
 * exact snapshot it judged, and Martin's separate Result approval stays
 * exactly what BD-8 condition 3 requires -- a PASS is verification, never
 * approval.
 *
 * FAIL CLOSED, specifically. The Machinery Worker assignment is Martin's
 * BD-12 authority to record in Notion; until that `result_verification_`
 * `authority:` block exists on the Operations page (and names a Machinery
 * Worker granted `verify_work_result` by martin), every verification
 * attempt returns a specific `unavailableReason` and records NO verdict --
 * the gate then refuses successful closure with its own "no Checker verdict"
 * reason, exactly as before this module existed. Nothing is substituted for
 * the missing assignment; nothing is hard-coded in its place.
 *
 * DETERMINISTIC RE-VERIFICATION (loop-free). `needsResultVerification`
 * answers "does the verdict in force cover the Work's CURRENT snapshot?" --
 * true only when no verdict exists, the assembled evidence refs differ from
 * the refs the verdict bound to, or the verdict hash no longer recomputes.
 * A verdict recorded by this module over the exact current refs therefore
 * makes the next check a no-op: one verification per real snapshot change,
 * never a loop. The deterministic evidence assembly (work record + Handoff +
 * durable external operations + the producing Unit's own recorded Result
 * evidence) is what makes that comparison stable.
 */

import type { Env, WorkState } from "../types";
import type { ResultReviewEvidenceItem, ResultReviewEvidenceRef } from "../types";
import {
  MAX_RESULT_EVIDENCE_CONTENT_CHARS,
  recordCheckerVerdict,
  verdictStaleReason,
} from "../resultReview";
import { hashContent } from "../contentHash";
import { generate } from "../ai";
import { getPageContent } from "../notion";
import { systemContext } from "../access";

/** The canonical Operations page (the authority source of record for the Machinery Worker assignment). */
export const RESULT_VERIFICATION_AUTHORITY_PAGE_ID = "3cecb004-e583-8104-961e-dba9e2a915e7";
/** The one capability a Machinery Worker must be granted to verify Work Results. */
export const VERIFY_WORK_RESULT_CAPABILITY = "verify_work_result";
/** This task's own registered SemanticTaskId (dataBoundary registry/policy). */
export const RESULT_VERIFICATION_TASK_ID = "work.result_verification" as const;

// ---------------------------------------------------------------------------
// Authority parsing -- live from the canonical page, fail-closed on anything
// missing, malformed, or not Martin's grant.
// ---------------------------------------------------------------------------

export interface ResultVerificationAuthority {
  machineryWorkerId: string;
  grantedBy: string;
  grantedCapabilities: string[];
}

export type ResultVerificationAuthorityParse =
  | { ok: true; authority: ResultVerificationAuthority }
  | { ok: false; reason: string };

/**
 * Parses the `result_verification_authority:` block from the live Operations
 * page content: the block starts at that anchor line and ends at the next
 * top-level key that is not one of its own (machinery_worker_id, granted_by,
 * granted_capabilities) -- so both a flat YAML block and an indented one
 * parse correctly, and an unknown column-0 key after the block stops it.
 * Requires an explicit `machinery_worker_id`, an explicit `granted_by:
 * martin`, and a granted capability list containing `verify_work_result` --
 * every absence or mismatch yields its own specific fail-closed reason
 * (Martin can see exactly what his Operations page is missing), never a
 * guess and never a default worker.
 */
const AUTHORITY_BLOCK_KEYS = new Set(["machinery_worker_id", "granted_by", "granted_capabilities"]);

export function parseResultVerificationAuthority(page: string): ResultVerificationAuthorityParse {
  const lines = (page ?? "").split(/\r?\n/);
  const anchorIndex = lines.findIndex((l) => /^\s*result_verification_authority\s*:/.test(l));
  if (anchorIndex === -1) {
    return {
      ok: false,
      reason:
        "the canonical Operations authority page declares no `result_verification_authority` block -- Martin's BD-12 Machinery Worker assignment is not recorded there, so Result verification is unavailable and successful closure stays blocked.",
    };
  }
  const blockLines: string[] = [];
  for (let i = anchorIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      blockLines.push(line);
      continue;
    }
    // A column-0 key that is NOT one of the block's own keys ends the block.
    const columnZeroKey = line.match(/^([A-Za-z0-9_]+)\s*:/)?.[1];
    if (columnZeroKey && !AUTHORITY_BLOCK_KEYS.has(columnZeroKey)) break;
    if (/^#{1,6}\s/.test(line)) break; // a heading ends the block too
    blockLines.push(line);
  }
  const block = blockLines.join("\n");

  const workerId = block.match(/^\s*machinery_worker_id\s*:\s*(.+?)\s*$/m)?.[1];
  if (!workerId) {
    return {
      ok: false,
      reason: "the `result_verification_authority` block declares no `machinery_worker_id` -- there is no Checker identity to verify with, so Result verification is unavailable (fail closed).",
    };
  }
  const grantedBy = block.match(/^\s*granted_by\s*:\s*(\S+)\s*$/m)?.[1];
  if (!grantedBy || grantedBy.toLowerCase() !== "martin") {
    return {
      ok: false,
      reason: `the Result verification capability is not Martin's grant (recorded granted_by: ${grantedBy ?? "nothing"}) -- only Martin may grant the Machinery Worker its verification authority, so Result verification is unavailable (fail closed).`,
    };
  }
  let capabilities: string[] = [];
  const inline = block.match(/^\s*granted_capabilities\s*:\s*\[([^\]]*)\]/m);
  if (inline) {
    capabilities = inline[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  } else {
    const capStart = blockLines.findIndex((l) => /^\s*granted_capabilities\s*:/.test(l));
    if (capStart !== -1) {
      for (let i = capStart + 1; i < blockLines.length; i++) {
        const line = blockLines[i];
        if (!line.trim()) continue;
        if (/^\s*[-*]\s+/.test(line)) {
          capabilities.push(line.replace(/^\s*[-*]\s+/, "").trim().replace(/^["']|["']$/g, ""));
          continue;
        }
        // A non-list, non-blank line at or before the key's own indentation
        // ends the capability list (the block's next key or prose).
        if (/^\s*[A-Za-z0-9_]+\s*:/.test(line)) break;
        capabilities.push(line.trim().replace(/^["']|["']$/g, ""));
      }
    }
  }
  if (!capabilities.includes(VERIFY_WORK_RESULT_CAPABILITY)) {
    return {
      ok: false,
      reason: `the declared Machinery Worker ${workerId} is not granted the \`${VERIFY_WORK_RESULT_CAPABILITY}\` capability (recorded capabilities: ${capabilities.length ? capabilities.join(", ") : "none"}) -- Result verification is unavailable (fail closed).`,
    };
  }
  return { ok: true, authority: { machineryWorkerId: workerId, grantedBy: "martin", grantedCapabilities: capabilities } };
}

// ---------------------------------------------------------------------------
// Deterministic evidence assembly and the re-verification trigger.
// ---------------------------------------------------------------------------

export interface ResultVerificationSnapshot {
  workId: string;
  unit?: string;
  hat?: string;
  action?: string;
  entryType?: string;
  stage: string;
  expectedResult: string;
  completionCriteria: readonly string[];
  evidence: readonly ResultReviewEvidenceItem[];
}

/**
 * Assembles the exact evidence set a verification judges -- deterministic,
 * Unit-free, and stable across saves for an unchanged Work, which is what
 * makes re-verification loop-free. The Work's own record is always first
 * (the producing side of every Result), then its inbound Handoff (when it
 * has one), then each durable external operation record, then the producing
 * Unit's own recorded Result evidence (src/resultReview.ts's
 * recordResultEvidence -- captured at Result-production time). Refs are
 * deduplicated by kind+ref; content is bounded per item. Refs are what a
 * verdict binds to; items (with content) are what the check prompt carries.
 */
export function assembleResultVerificationEvidence(state: WorkState): {
  refs: ResultReviewEvidenceRef[];
  items: ResultReviewEvidenceItem[];
} {
  const refs: ResultReviewEvidenceRef[] = [];
  const items: ResultReviewEvidenceItem[] = [];
  const push = (kind: string, ref: string, note: string | undefined, content: string): void => {
    if (refs.some((r) => r.kind === kind && r.ref === ref)) return;
    refs.push({ kind, ref, ...(note ? { note } : {}) });
    items.push({ kind, ref, ...(note ? { note } : {}), content: content.slice(0, MAX_RESULT_EVIDENCE_CONTENT_CHARS) });
  };
  push(
    "work_record",
    state.workId,
    undefined,
    JSON.stringify({
      workId: state.workId,
      unit: state.unit ?? null,
      hat: state.hat ?? null,
      action: state.actionName ?? null,
      entryType: state.entryType ?? null,
      stage: state.stage,
      createdAt: state.createdAt ?? null,
      updatedAt: state.updatedAt ?? null,
    }),
  );
  if (state.handoffId) {
    push("handoff", state.handoffId, "the Work's own inbound Handoff", `Handoff ${state.handoffId} -- the Work's inbound Handoff.`);
  }
  for (const [key, op] of Object.entries(state.externalOperations ?? {})) {
    push(
      "external_operation",
      op.operation_id || key,
      op.tool_id,
      `Tool ${op.tool_id} operation ${op.operation_id || key}: status ${op.status}${op.outcome ? `, outcome ${JSON.stringify(op.outcome)}` : ""}${op.remote_resource?.document_id ? `, remote resource ${op.remote_resource.document_id}` : ""}.`,
    );
  }
  for (const item of state.resultReview?.evidence ?? []) {
    push(item.kind, item.ref, item.note, item.content);
  }
  return { refs, items };
}

function refsDiffer(
  current: readonly ResultReviewEvidenceRef[],
  recorded: readonly ResultReviewEvidenceRef[] | undefined,
): boolean {
  if (!recorded || recorded.length !== current.length) return true;
  return current.some(
    (ref, i) => ref.kind !== recorded[i]?.kind || ref.ref !== recorded[i]?.ref || (ref.note ?? "") !== (recorded[i]?.note ?? ""),
  );
}

/**
 * Does this Work need a (fresh) Machinery Worker verification? True when a
 * Result contract is declared and the verdict in force does NOT cover the
 * Work's current snapshot: no verdict at all, different evidence refs than
 * the verdict bound to, or a stale verdict hash. False on every unchanged
 * snapshot -- the loop-freedom guarantee (BD-13: fresh authority per real
 * snapshot change, one check per change).
 */
export async function needsResultVerification(state: WorkState): Promise<boolean> {
  const review = state.resultReview;
  if (!review?.expectedResult?.trim() || !review.completionCriteria?.length) return false;
  const { refs } = assembleResultVerificationEvidence(state);
  const verdict = review.checker;
  if (!verdict) return true;
  if (refsDiffer(refs, verdict.evidenceRefs)) return true;
  return (await verdictStaleReason(state)) !== null;
}

// ---------------------------------------------------------------------------
// The verification run.
// ---------------------------------------------------------------------------

/** Injected I/O: the live authority-page read and the independent check itself. */
export interface ResultVerificationDeps {
  fetchAuthorityPage: () => Promise<string>;
  runCheck: (input: {
    snapshot: ResultVerificationSnapshot;
    authority: ResultVerificationAuthority;
    evidence: readonly ResultReviewEvidenceItem[];
  }) => Promise<{ outcome: "pass" | "fail"; reason: string } | null>;
}

export type ResultVerificationRun =
  | { recorded: true; outcome: "passed" | "failed"; reason?: string; snapshotKey: string }
  | { recorded: false; unavailableReason: string; snapshotKey?: string };

/**
 * Runs one Machinery Worker verification over the Work's current snapshot.
 * Every failure path is fail-closed and returns a specific
 * `unavailableReason` touching NOTHING except the audit record
 * (`verificationAttempt`): no contract, the independence guard (the
 * verification never verifies Operations' own Work or the Result
 * Verification responsibility's own Work), an unreadable/absent/malformed
 * authority assignment, or a check that produced no usable verdict. A
 * missing producing-Unit evidence set is SUBSTANTIVE evidence
 * insufficiency and is recorded as a FAILED verdict (the gate then shows
 * exactly why the Result cannot close); everything unavailable records no
 * verdict at all (the gate shows its own "no Checker verdict" reason).
 */
export async function runMachineryResultVerification(state: WorkState, deps: ResultVerificationDeps): Promise<ResultVerificationRun> {
  const review = state.resultReview;
  const attempt = (snapshotKey: string, outcome: "passed" | "failed" | "unavailable", reason?: string): void => {
    if (review) {
      review.verificationAttempt = { snapshotKey, outcome, ...(reason ? { reason } : {}), at: new Date().toISOString() };
    }
  };

  if (!review?.expectedResult?.trim() || !review.completionCriteria?.length) {
    const reason = "this Work declares no complete Result contract to verify against.";
    attempt("", "unavailable", reason);
    return { recorded: false, unavailableReason: reason };
  }
  if (state.unit === "Operations" || state.hat === "Result Verification") {
    const reason =
      "the Machinery Worker verification never verifies Work performed by Operations itself or by the Result Verification responsibility -- a Checker cannot verify its own Work (BD-8 independence).";
    attempt("", "unavailable", reason);
    return { recorded: false, unavailableReason: reason };
  }

  const { refs, items } = assembleResultVerificationEvidence(state);
  const snapshot: ResultVerificationSnapshot = {
    workId: state.workId,
    unit: state.unit,
    hat: state.hat,
    action: state.actionName,
    entryType: state.entryType,
    stage: state.stage,
    expectedResult: review.expectedResult,
    completionCriteria: review.completionCriteria,
    evidence: review.evidence ?? [],
  };
  const snapshotKey = await hashContent(
    JSON.stringify([
      ["work", state.workId],
      ["unit", state.unit ?? ""],
      ["hat", state.hat ?? ""],
      ["action", state.actionName ?? ""],
      ["entry_type", state.entryType ?? ""],
      ["stage", state.stage],
      ["expected_result", review.expectedResult],
      ["criteria", review.completionCriteria],
      ["evidence_refs", refs.map((r) => [r.kind, r.ref, r.note ?? ""])],
    ]),
  );

  let page: string;
  try {
    page = await deps.fetchAuthorityPage();
  } catch (err) {
    const reason = `the canonical Result verification authority page could not be read (${err instanceof Error ? err.message : String(err)}) -- Result verification is unavailable (fail closed).`;
    attempt(snapshotKey, "unavailable", reason);
    return { recorded: false, unavailableReason: reason, snapshotKey };
  }
  const parsed = parseResultVerificationAuthority(page ?? "");
  if (!parsed.ok) {
    attempt(snapshotKey, "unavailable", parsed.reason);
    return { recorded: false, unavailableReason: parsed.reason, snapshotKey };
  }

  // The producing Unit recorded no Result evidence: substantive evidence
  // insufficiency, recorded as a FAILED verdict so the gate's visible block
  // reason names it -- verification judges criteria against evidence, and
  // there is none to judge them against.
  if (!review.evidence?.length) {
    const reason =
      "the producing Unit recorded no Result evidence for this Result (recordResultEvidence was never called at Result production) -- evidence insufficiency fails closed.";
    const recorded = await recordCheckerVerdict(state, {
      checkerId: parsed.authority.machineryWorkerId,
      outcome: "failed",
      reason,
      evidenceRefs: refs,
    });
    if (!recorded.ok) {
      attempt(snapshotKey, "unavailable", recorded.reason);
      return { recorded: false, unavailableReason: recorded.reason, snapshotKey };
    }
    attempt(snapshotKey, "failed", reason);
    return { recorded: true, outcome: "failed", reason, snapshotKey };
  }

  let check: { outcome: "pass" | "fail"; reason: string } | null;
  try {
    check = await deps.runCheck({ snapshot, authority: parsed.authority, evidence: items });
  } catch {
    check = null;
  }
  if (!check || (check.outcome !== "pass" && check.outcome !== "fail") || !check.reason?.trim()) {
    const reason =
      "the independent verification check produced no usable verdict -- Result verification is unavailable (fail closed), nothing was recorded.";
    attempt(snapshotKey, "unavailable", reason);
    return { recorded: false, unavailableReason: reason, snapshotKey };
  }

  const outcome = check.outcome === "pass" ? "passed" : "failed";
  const reason = check.reason.trim();
  const recorded = await recordCheckerVerdict(state, {
    checkerId: parsed.authority.machineryWorkerId,
    outcome,
    reason,
    evidenceRefs: refs,
  });
  if (!recorded.ok) {
    attempt(snapshotKey, "unavailable", recorded.reason);
    return { recorded: false, unavailableReason: recorded.reason, snapshotKey };
  }
  attempt(snapshotKey, outcome, reason);
  return { recorded: true, outcome, reason, snapshotKey };
}

// ---------------------------------------------------------------------------
// Production dependencies -- the live authority read and the independent
// check, both through the established mechanisms (live-fetched canonical
// page, generate() with this task's own registered SemanticTaskId so the
// Data Boundary and Outbound Data Gate govern the call like any other).
// ---------------------------------------------------------------------------

/**
 * Production deps for `runMachineryResultVerification`: the authority page
 * read live from Notion (system kernel read, same pattern as getGovernance)
 * and the independent check through generate() under this task's own
 * SemanticTaskId. The prompt carries ONLY the token-safe snapshot (canonical
 * ids, Unit/Hat/Action names, stage, the declared contract and the recorded
 * evidence content) -- never raw enquiry text, never identity-bearing state
 * slices; the Outbound Data Gate inspects the actual payload and a blocked
 * or failed call degrades to null, which runMachineryResultVerification
 * treats as unavailable (fail closed), never as a verdict.
 */
export function resultVerificationDeps(env: Env): ResultVerificationDeps {
  return {
    fetchAuthorityPage: () => getPageContent(env, RESULT_VERIFICATION_AUTHORITY_PAGE_ID, systemContext()),
    runCheck: async ({ snapshot, authority, evidence }) => {
      const evidenceText = evidence
        .map((item, i) => `[${i + 1}] ${item.kind} (${item.ref})${item.note ? ` -- ${item.note}` : ""}\n${item.content}`)
        .join("\n\n");
      const result = await generate<{ outcome?: unknown; reason?: unknown }>(env, {
        taskId: RESULT_VERIFICATION_TASK_ID,
        mode: "json",
        parts: buildResultCheckPromptParts(snapshot, authority, evidenceText),
      });
      if (!result || typeof result.outcome !== "string" || typeof result.reason !== "string") return null;
      const outcome = result.outcome.trim().toLowerCase();
      if (outcome !== "pass" && outcome !== "fail") return null;
      const reason = result.reason.trim();
      if (!reason) return null;
      return { outcome, reason };
    },
  };
}

/**
 * The exact answer shape the Checker must return (2026-11-14). Live: the
 * check answered but its reply was refused as "no usable verdict" -- the
 * prompt asked for a verdict and a reason but never named the JSON keys or
 * the allowed values, so the model chose its own. The parser above accepts
 * only this shape; nothing about what the Checker judges changes.
 */
export const RESULT_CHECK_RESPONSE_FORMAT = [
  "=== RESPONSE FORMAT (execution mechanics) ===",
  'Reply ONLY with JSON exactly in this shape: {"outcome": "pass", "reason": "<which criteria the evidence meets>"} or {"outcome": "fail", "reason": "<which criteria the evidence does not meet, and why>"}.',
  'The "outcome" value must be exactly "pass" or "fail" -- no other word, no other key names.',
].join("\n");

/** The Checker's prompt parts. Exported so the answer-format instruction is testable. */
export function buildResultCheckPromptParts(
  snapshot: ResultVerificationSnapshot,
  authority: { machineryWorkerId: string },
  evidenceText: string,
) {
  return {
    persona: `You are ENIG's independent Machinery Worker Result Checker "${authority.machineryWorkerId}". You did not perform this Work and you are not its producer; you verify only, and your verdict is never an approval.`,
    skillContent:
      "Verify the recorded evidence against EVERY completion criterion of the declared Expected Result. PASS only when every criterion is met by the recorded evidence itself. FAIL when any criterion is unmet or unsupported by the evidence. Never infer evidence that is not recorded, and never treat the Work's own claim as proof. Always give a concrete reason naming which criteria the evidence does or does not meet.",
    context: `Expected Result: ${snapshot.expectedResult}\n\nCompletion criteria:\n${snapshot.completionCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n${RESULT_CHECK_RESPONSE_FORMAT}`,
    situation: `Work ${snapshot.workId} (${snapshot.unit ?? "unassigned"}/${snapshot.hat ?? "unassigned"}, action ${snapshot.action ?? "unassigned"}, stage ${snapshot.stage}).\n\nRecorded evidence:\n\n${evidenceText || "(no evidence recorded)"}`,
  };
}
