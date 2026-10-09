/**
 * ACCESS -- the dedicated Access boundary (ENIG Operating Model: KERNEL ->
 * ACCESS; see docs/enig-operating-model.md).
 *
 * Access answers exactly one question, and nothing else:
 *
 *     "Is this operation permitted in the current execution context?"
 *
 * WHAT ACCESS IS NOT. These are separate capabilities with separate
 * owners, and this module deliberately answers none of them:
 *   - what information may cross an identity boundary
 *       -> src/ai/identityRedaction.ts, src/runtime/research/safeContext.ts
 *   - how a Handoff payload/schema is validated
 *       -> src/handoffWriter.ts (validateHandoffProperties,
 *          assertTokensPresent, protected-field/token checks)
 *   - which AI provider/task may execute
 *       -> src/ai/policy.ts, src/ai/outboundGate.ts
 *   - which Hat owns work / how work is routed
 *       -> src/units/registry.ts, src/units/dispatch.ts, src/router.ts
 *
 * This is deliberately a small, explicit operation-authorization check --
 * NOT a general enterprise authorization framework. There is no role
 * model, no permission table, and no policy language.
 *
 * WHERE THE AUTHORITY COMES FROM (the critical property). Two things are
 * resolved, never asserted:
 *
 *   1. WHICH ACTION. Read off the Work itself -- WorkState.actionName,
 *      recorded when the Work was created/dispatched and advanced only by the
 *      code performing a different registered operation. No AccessContext
 *      constructor accepts an Action name, so there is no parameter through
 *      which a call site could name a laxer Action and have the operation
 *      judged by it. A call site MAY pass `assertedActionName` as a
 *      cross-check, and a disagreement fails closed.
 *   2. THE APPROVAL REQUIREMENT. Read off that Action's registered
 *      ActionDefinition. `requiresApproval` is the single authority; there is
 *      no second field narrowing it (`approvalGatedTargets` was removed --
 *      see isApprovalGatedWrite) and no `requiresApproval` on AccessContext,
 *      so nothing a caller passes can declare an action un-gated.
 *
 * The Action's declared CONSEQUENCE is also checked against the requested
 * operation, in both directions. A "read" Action cannot authorize a write,
 * and a write Action's authorization is not reused as an implicit read
 * authorization.
 *
 * Everything fails closed: an unknown context kind, a Work recording no
 * Action where one is needed, an Action that cannot be resolved, an
 * operation the Action's consequence does not permit, a gated write with no
 * proof, a proof for the wrong Work / action / data source, a malformed
 * proof, and a Kernel system context aiming at anything other than the
 * Activity Log it owns.
 */

import type { ApprovalProof, Env, Unit, WorkState } from "./types";
import type { ActionDefinition } from "./hats/actionRegistry";
import type { ToolEffectClassification } from "./runtime/toolRegistry";
import { findUnitManifest } from "./units/registry";
import { findManifestAction } from "./units/unitManifest";

/**
 * The governed sources a Unit action can produce a committed effect in.
 *
 * This is a SYMBOLIC name, not a data source id: an ActionDefinition is
 * static and has no Env, so it cannot name `env.HANDOFFS_DATA_SOURCE_ID`.
 * Access maps the symbol to the concrete id from the live Env before
 * comparing anything, so a manifest can never be stale about, or assert,
 * an environment-specific id.
 */
export type GovernedSource = "entities" | "matters" | "proposals" | "handoffs" | "leads" | "activity_log" | "call_notes";

const allSources: readonly GovernedSource[] = ["entities", "matters", "proposals", "handoffs", "leads", "activity_log", "call_notes"];

/** The one operation an action can be approval-gated for. `create` and `update` are distinguished deliberately: an approval authorizes creating a governed record or changing an existing one, and these are different commitments. */
export type GovernedOperation = "create" | "update";

/** Which governed sources this kind of context is running under. */
export type AccessContextKind = "work_session" | "user_lookup" | "discovery_cron" | "system";

const ACCESS_CONTEXT_KINDS: readonly AccessContextKind[] = ["work_session", "user_lookup", "discovery_cron", "system"];

/**
 * The explicit execution context every governed operation must carry. It is
 * a plain, closed data shape -- it carries no capability of its own and
 * grants nothing by existing.
 *
 * Deliberately ABSENT: any `requiresApproval` field. A caller cannot declare
 * an action un-gated, because the requirement is read from the registered
 * ActionDefinition (see resolveActionRequirement).
 */
export interface AccessContext {
  /** Which kind of execution context this is -- see AccessContextKind. */
  kind: AccessContextKind;
  /** The Work item this operation belongs to, when there is one. Compared against ApprovalProof.workId for a gated write. */
  workId?: string;
  /** The owning Unit, when this operation runs as a Unit's work. */
  unit?: Unit;
  /** The owning Hat's registered name, when this operation runs as a Hat's work. */
  hat?: string;
  /**
   * The resolved Action's registered name -- ALWAYS the one recorded on the
   * Work (WorkState.actionName), never one a call site chose. Populated by
   * `workSessionContext(state)`, which reads it off the WorkState it is
   * handed; there is deliberately no way to construct a work_session context
   * with a hand-picked action name.
   */
  actionName?: string;
  /**
   * An optional cross-check only. A call site MAY name the Action it believes
   * it is performing; if it disagrees with the Work's recorded Action, Access
   * FAILS CLOSED rather than preferring either value. It is never a fallback
   * for a missing recorded action.
   */
  assertedActionName?: string;
  /**
   * The Handoff this Work item was itself picked up from, when it has one.
   * Populated by `workSessionContext(state)` from `state.handoffId`.
   *
   * It exists for exactly one decision -- see
   * `isWorkItemHandoffProgression`. It carries no authority of its own.
   */
  inboundHandoffId?: string;
  /** An ApprovalProof, when a verified approval callback has already minted one for this mutation. */
  proof?: ApprovalProof;
}

export interface AccessRequest {
  /** Reads, creates, and updates are distinguished: they are not the same question. */
  operation: "read" | GovernedOperation;
  /**
   * The data source this operation targets. For an update this MUST be the
   * data source resolved authoritatively from the page being written, never
   * a caller-supplied guess -- see notion.ts's updatePage. For a read of a
   * page that lives in no governed data source (a standalone governance
   * page, say) it is `NON_GOVERNED_PAGE_TARGET`, which only a read may use.
   */
  dataSourceId: string;
  /** The page being written, for diagnostics. */
  pageId?: string;
}

/**
 * The target marker for a read of a page that lives outside every governed
 * data source.
 *
 * It exists so that "every governed operation is evaluated by Access" stays
 * true without pretending a standalone page belongs to a governed source. It
 * is deliberately usable for reads only: a write against it is refused,
 * because "no governed source" is a reason a mutation cannot be authorized,
 * never a reason one may proceed.
 */
export const NON_GOVERNED_PAGE_TARGET = "non-governed:page";

/**
 * The target marker for an outbound request to an EXTERNAL provider --
 * Tavily, or any other third-party API this codebase later calls.
 *
 * The governed sources above are all Notion data sources ENIG owns. An
 * external API is not one, and inventing a fake data-source id for it would
 * make the request look like a Notion read and let it through unexamined.
 * Naming it explicitly keeps it in the same decision function instead of
 * leaving the one genuinely outbound call in this codebase behind a bare
 * `fetch`.
 *
 * It is usable for READS ONLY, for the same reason NON_GOVERNED_PAGE_TARGET is:
 * "not a governed record" is a reason an operation cannot be authorized as a
 * governed write, never a reason one may proceed. A write against this target
 * is refused outright, because there is no Notion mutation to authorize and
 * any outbound request that CHANGES remote state is a different question that
 * no registered Action currently answers (see evaluateExternalEgress).
 */
export const EXTERNAL_EGRESS_TARGET = "external:egress";

/**
 * The only external provider endpoint any registered Action authorizes
 * reading from. Enumerated HERE, in the Access boundary, on the same
 * reasoning as `kernelOwnedWriteDataSourceIds`: a generic "system context"
 * that could name its own external target would let any caller redirect a
 * governed Work's data at an endpoint of its choosing, which is precisely the
 * arbitrary-target bypass this module exists to prevent.
 */
const AUTHORIZED_EXTERNAL_READ_TARGETS: readonly string[] = [EXTERNAL_EGRESS_TARGET];

/**
 * The target marker on an ApprovalProof that authorizes an EXTERNAL Tool
 * mutation (a registered operation with effect `external_mutation`) instead
 * of a Notion write.
 *
 * External reads and external state changes are different questions, and this
 * is the second, separate answer -- `EXTERNAL_EGRESS_TARGET` above stays
 * read-only and untouched. The marker exists because the external resource
 * (a Google Drive folder, say) must not be written into
 * `ApprovalProof.targetDataSourceId`: that field asks "which governed Notion
 * source", and reusing it for an external target would make a Notion-shaped
 * proof authorize a non-Notion effect. With this marker the two proof kinds
 * can never substitute for each other: verifyProof (Notion writes) compares
 * `targetDataSourceId` to the real governed source, and verifyExternalToolProof
 * requires this marker plus an exact `toolOperation` binding.
 *
 * Usable only as the proof's target marker -- never as a target inside an
 * AccessRequest, which continues to recognize only governed Notion sources,
 * NON_GOVERNED_PAGE_TARGET, and the read-only EXTERNAL_EGRESS_TARGET.
 */
export const EXTERNAL_TOOL_TARGET = "external:tool";

export class AccessDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Access denied: ${reason}`);
    this.name = "AccessDeniedError";
    this.reason = reason;
  }
}

/** Maps a symbolic GovernedSource to the concrete data source id in this Env. */
export function governedSourceDataSourceId(env: Env, source: GovernedSource): string {
  switch (source) {
    case "entities":
      return env.ENTITY_DATA_SOURCE_ID;
    case "matters":
      return env.MATTERS_DATA_SOURCE_ID;
    case "proposals":
      return env.PROPOSALS_DATA_SOURCE_ID;
    case "handoffs":
      return env.HANDOFFS_DATA_SOURCE_ID;
    case "leads":
      return env.LEADS_DATA_SOURCE_ID;
    case "activity_log":
      return env.ACTIVITY_LOG_DATA_SOURCE_ID;
    case "call_notes":
      return env.CALL_NOTES_DATA_SOURCE_ID;
  }
}

function describe(request: AccessRequest, context: AccessContext): string {
  const where = request.pageId ? ` page ${request.pageId}` : "";
  return `${request.operation} of data source ${request.dataSourceId}${where} under context "${context.kind}"${
    context.unit ? ` (${context.unit}${context.hat ? `/${context.hat}` : ""})` : ""
  }${context.actionName ? ` action "${context.actionName}"` : ""}`;
}

export interface ResolvedAction {
  action: ActionDefinition<string>;
  /** The authoritative requirement -- read from the ActionDefinition, never from the caller. */
  requiresApproval: boolean;
}

/**
 * Resolves a context's (unit, hat, actionName) against the Unit Registry.
 *
 * Returns null only when the context names no action at all. When an
 * action IS named but cannot be resolved -- no manifest for the Unit, no
 * such Hat, no such action on that Hat -- this THROWS, because an
 * unresolvable action reference is invalid state and must never be read as
 * "un-gated".
 */
export function resolveActionRequirement(context: AccessContext): ResolvedAction | null {
  if (context.actionName === undefined) {
    if (context.unit !== undefined || context.hat !== undefined) {
      throw new AccessDeniedError(
        `a Unit/Hat was named (${context.unit ?? "?"}/${context.hat ?? "?"}) but the Work records no Action, so no action could be resolved -- refusing to treat this as an un-gated operation.`,
      );
    }
    return null;
  }

  if (context.unit === undefined || context.hat === undefined) {
    throw new AccessDeniedError(`action "${context.actionName}" was recorded on a Work with no Unit and/or Hat -- refusing to guess which action it is.`);
  }

  // The caller's belief about the Action is a cross-check, never a source.
  // Disagreement is a defect in the code performing the operation, and the
  // only safe response to an operation that may be the wrong one is refusal.
  if (context.assertedActionName !== undefined && context.assertedActionName !== context.actionName) {
    throw new AccessDeniedError(
      `this call site is performing action "${context.assertedActionName}" but the Work records "${context.actionName}" -- a caller can never substitute the Action an operation is judged by.`,
    );
  }

  const manifest = findUnitManifest(context.unit);
  if (!manifest) {
    throw new AccessDeniedError(`${context.unit} has no registered manifest, so action "${context.actionName}" cannot be resolved.`);
  }
  const hat = manifest.hats[context.hat];
  if (!hat) {
    throw new AccessDeniedError(`${context.unit} declares no Hat "${context.hat}", so action "${context.actionName}" cannot be resolved.`);
  }
  const action = findManifestAction(context.actionName, hat);
  if (!action) {
    throw new AccessDeniedError(`${context.unit}/${context.hat} declares no action "${context.actionName}" -- refusing to treat an undeclared action as un-gated.`);
  }

  return { action, requiresApproval: action.requiresApproval };
}

/**
 * Whether a resolved Action's declared consequence permits the requested
 * operation at all.
 *
 * This is the check that stops a read Action from authorizing a write, and
 * is the reason an Action's name can never be used to launder authority: the
 * Action says what KIND of operation it is, and an operation of a different
 * kind is not a lesser version of the same one.
 *
 *   "read"     -- only "read".
 *   "internal" -- "read" and execution-state operations. A governed write is
 *                 NEVER permitted: internal Actions exist precisely because
 *                 they must not touch governed business state.
 *   "write"    -- "read", "create", "update".
 */
export function consequencePermits(action: ActionDefinition<string>, operation: AccessRequest["operation"]): boolean {
  switch (action.consequence) {
    case "read":
      return operation === "read";
    case "internal":
      return operation === "read";
    case "write":
      return operation !== undefined;
  }
}

/**
 * Whether this write is the Work item's OWN progression of the Handoff it was
 * picked up from -- Pending -> Picked-up -> Held/Closed -- rather than an
 * effect of some Unit's approved work.
 *
 * The architecture already treats a Work item's progress as the Kernel's
 * execution state: `stage` and `awaiting` are persisted by the Kernel itself
 * and advanced by the code performing each transition. The Handoff's `Status`
 * is the same progression, written to Notion instead of KV, so that other
 * Hats and humans can see which Handoffs are still open. Treating it as an
 * approval-gated governed effect would mean no Handoff could ever be marked
 * picked up -- the pickup happens BEFORE the approval the gate waits for.
 *
 * This is deliberately NOT an Action-declared exemption, which is what
 * `approvalGatedTargets` was and why it was removed: a second field an Action
 * could populate to silence `requiresApproval` split one authority in two and
 * failed open whenever it was omitted. This rule is decided here, in the
 * Access boundary, from facts about the request that a caller cannot assert:
 *
 *   - it must be an `update` (never a `create` -- creating a Handoff IS a
 *     governed commitment and is always fully gated);
 *   - the target must be the Handoffs data source; and
 *   - the exact page must be the one this Work item was picked up from
 *     (`context.inboundHandoffId`), compared page-for-page.
 *
 * So a Work item may advance its own Handoff and nothing else. It cannot
 * advance another Work's Handoff, cannot create a Handoff by this route, and
 * cannot write Entities, Matters, Proposals, or Leads by it. Every other
 * consequence -- including any write to the Handoff's own content fields --
 * remains fully gated by the resolved Action's `requiresApproval`.
 */
function isWorkItemHandoffProgression(env: Env, request: AccessRequest, context: AccessContext): boolean {
  if (request.operation !== "update") return false;
  if (context.inboundHandoffId === undefined || context.inboundHandoffId.length === 0) return false;
  if (request.pageId !== context.inboundHandoffId) return false;
  return request.dataSourceId === env.HANDOFFS_DATA_SOURCE_ID;
}

/**
 * Whether this write is approval-gated, and therefore needs Martin's
 * ApprovalProof.
 *
 * The requirement comes from ONE place -- the resolved ActionDefinition's own
 * `requiresApproval` -- read straight off the registered object. There is no
 * second field that can narrow it. `approvalGatedTargets` was removed: a
 * second list able to silence `requiresApproval` split one authority in two,
 * and failed OPEN whenever an Action declared the flag but omitted the list
 * (Business Development and Marketing each had gated Actions and no list at
 * all). Narrowing by target is no longer needed because an Action that also
 * performs un-gated privileged work is declared as the operation that IS its
 * privileged effect -- the granularity Business Development already used.
 *
 * The single exception is not Action-declared at all: see
 * `isWorkItemHandoffProgression`.
 *
 * Reads are never gated: an approval authorizes a committed change, and
 * reading is not one.
 */
export function isApprovalGatedWrite(env: Env, action: ActionDefinition<string>, request: AccessRequest, context: AccessContext): boolean {
  if (!action.requiresApproval) return false;
  if (request.operation === "read") return false;
  if (isWorkItemHandoffProgression(env, request, context)) return false;
  return true;
}

/**
 * Verifies an ApprovalProof against the mutation it is being offered for.
 * Every field is checked; a proof either wholly authorizes this exact
 * mutation or it authorizes nothing.
 */
function verifyProof(proof: ApprovalProof, request: AccessRequest, context: AccessContext, actionName: string): void {
  if (typeof proof.approvalToken !== "string" || proof.approvalToken.length < 8) {
    throw new AccessDeniedError(`the supplied approval proof has no usable approval token for ${describe(request, context)}.`);
  }
  if (typeof proof.approvedAt !== "string" || proof.approvedAt.length === 0) {
    throw new AccessDeniedError(`the supplied approval proof has no approval timestamp for ${describe(request, context)}.`);
  }
  if (proof.workId !== context.workId) {
    throw new AccessDeniedError(
      `the supplied approval proof is for Work ${proof.workId}, not the current Work ${context.workId ?? "(none)"} -- an approval never carries across work items.`,
    );
  }
  if (proof.actionName !== actionName) {
    throw new AccessDeniedError(`the supplied approval proof is for action "${proof.actionName}", not the resolved action "${actionName}".`);
  }
  if (proof.targetDataSourceId !== request.dataSourceId) {
    throw new AccessDeniedError(
      `the supplied approval proof authorizes data source ${proof.targetDataSourceId}, not the target ${request.dataSourceId} -- an approval never carries across governed sources.`,
    );
  }
}

/**
 * The governed sources the Kernel itself owns and may write with no Unit
 * Action behind it.
 *
 * This is the Activity & Decision Log, and only that. It is a Kernel-owned
 * record of what happened, not a business object, and it is written from
 * inside any Unit's own operation -- so requiring a Unit Action to write it
 * would mean no log entry could ever be written by the code that caused the
 * event. It is enumerated HERE, in the Access boundary, rather than chosen
 * by the caller: a generic "system context" that could name its own target
 * would be exactly the arbitrary-write bypass this module exists to prevent.
 */
function kernelOwnedWriteDataSourceIds(env: Env): readonly string[] {
  return [env.ACTIVITY_LOG_DATA_SOURCE_ID];
}

/** Every governed data source in this Env, in symbolic order. The only targets a Notion operation may name. */
function governedDataSourceIds(env: Env): readonly string[] {
  return allSources.map((source) => governedSourceDataSourceId(env, source));
}

/**
 * THE rule for an outbound request to a third-party provider.
 *
 * Reached only when the target is EXTERNAL_EGRESS_TARGET. Three checks, all
 * fail-closed:
 *
 *   1. It must be a read. Every external call this codebase makes today
 *      discloses a query and retrieves results; none of them changes remote
 *      state. An outbound CREATE/UPDATE has no registered Action behind it, so
 *      it is refused rather than admitted under a read's authority.
 *   2. The target must be one Access itself enumerates. A caller cannot name
 *      its own endpoint.
 *   3. A Unit's outbound read must be backed by a resolved Action whose
 *      consequence permits reading. This is the same consequence check
 *      `evaluateAccess` applies to a Notion read, and it is why a
 *      work_session context with no recorded Action -- which is authorized to
 *      read ENIG's OWN records -- is NOT authorized to send a query to a third
 *      party. Reading ENIG's records and disclosing content externally are
 *      different acts and are authorized by different things.
 *
 * Note what this deliberately does NOT do: it does not inspect, redact, or
 * sanitize the query. Whether a particular string may leave the boundary is a
 * data-boundary question owned by src/dataBoundary and by the redaction that
 * runs before this point (see webSearch.ts's redactIdentityTerms call). This
 * module decides only WHO may make the request, not what it contains -- adding
 * a content check here would be a second, competing data-boundary mechanism.
 */
function evaluateExternalEgress(request: AccessRequest, context: AccessContext): void {
  if (request.operation !== "read") {
    throw new AccessDeniedError(
      `an outbound ${request.operation} to an external provider is not authorized under any registered Action -- only an outbound read is, and changing remote state has no Action behind it.`,
    );
  }
  if (!AUTHORIZED_EXTERNAL_READ_TARGETS.includes(request.dataSourceId)) {
    throw new AccessDeniedError(
      `"${request.dataSourceId}" is not an external target Access authorizes -- a caller may not name its own external endpoint.`,
    );
  }

  // A Kernel-owned read (no Unit operation behind it) is permitted ONLY for the
  // contexts that are genuinely Kernel-owned. A user lookup answers questions
  // about ENIG's own records and discloses nothing; the discovery cron is the
  // Kernel's own loop and is exactly who performs the scheduled searches. A
  // work_session context that records no Action is a different thing: it is a
  // read of ENIG's OWN records (see workSessionReadContext), and reading those
  // is not authority to send one to a third party.
  const resolved = resolveActionRequirement(context);
  if (resolved === null) {
    if (context.kind === "user_lookup") {
      throw new AccessDeniedError(
        `a "user_lookup" read answers questions about ENIG's own records and may not disclose anything to a third party.`,
      );
    }
    if (context.kind === "work_session") {
      throw new AccessDeniedError(
        `this Work records no Action, so there is no registered operation behind an outbound read -- reading ENIG's own records is not authority to disclose one externally.`,
      );
    }
    return;
  }
  if (!consequencePermits(resolved.action, "read")) {
    throw new AccessDeniedError(
      `action "${resolved.action.name}" is declared "${resolved.action.consequence}" and does not permit an outbound read -- ${describe(request, context)}.`,
    );
  }
}

/**
 * THE Access decision. Called by src/notion.ts immediately before any
 * network dispatch of a read or a mutation. Throws AccessDeniedError on
 * refusal; returns normally when the operation is permitted.
 *
 * In order: the context kind must be recognized; the target must resolve;
 * the Action (if any) must resolve from the Work's own record; the Action's
 * consequence must permit this operation; and if the Action requires
 * approval, a matching ApprovalProof must be present. Anything unresolvable,
 * unpermitted, or ambiguous is a denial.
 *
 * READS: require a recognized context kind, and that the resolved Action's
 * consequence permits reading. Read access never acquires extra restrictions
 * merely for symmetry with writes, and -- critically -- write authorization
 * is never used as an implicit read authorization or vice versa: the same
 * consequence check runs for both directions.
 */
export function evaluateAccess(env: Env, request: AccessRequest, context: AccessContext): void {
  if (!ACCESS_CONTEXT_KINDS.includes(context.kind)) {
    throw new AccessDeniedError(`unknown execution context kind "${String(context.kind)}" for ${describe(request, context)} -- refusing to proceed unclassified.`);
  }
  if (typeof request.dataSourceId !== "string" || request.dataSourceId.length === 0) {
    throw new AccessDeniedError(`${request.operation} was requested without a resolvable target data source.`);
  }
  if (request.dataSourceId === NON_GOVERNED_PAGE_TARGET && request.operation !== "read") {
    throw new AccessDeniedError(
      `a ${request.operation} was requested against a page that lives in no governed source -- a governed record cannot be created or changed where there is no governed record to change.`,
    );
  }
  if (request.dataSourceId === EXTERNAL_EGRESS_TARGET) {
    evaluateExternalEgress(request, context);
    return;
  }
  // Every other target must be one of THIS Env's governed sources, or the
  // NON_GOVERNED_PAGE_TARGET marker Access itself defines. Without this, a
  // caller that named its own target string would land in the read path
  // below, which resolves no Action and permits any read -- turning "target
  // must be a governed source" into "target must be non-empty". A target is
  // therefore recognized by being one Access already knows about, never by the
  // caller recognising it. NON_GOVERNED_PAGE_TARGET is excluded because it is
  // one of those markers, resolved by src/notion.ts from the page's real
  // parent rather than supplied by a call site.
  if (request.dataSourceId !== NON_GOVERNED_PAGE_TARGET && !governedDataSourceIds(env).includes(request.dataSourceId)) {
    throw new AccessDeniedError(
      `"${request.dataSourceId}" is not a governed data source in this environment -- a caller may not name its own target, and an unrecognized target is never read as "nothing in particular".`,
    );
  }

  // A user lookup answers questions about ENIG's own records. It is
  // read-only by construction, and carries neither an Action nor a proof:
  // there is no Unit operation behind a lookup.
  if (context.kind === "user_lookup") {
    if (request.operation !== "read") {
      throw new AccessDeniedError(`a "user_lookup" context may not perform a ${request.operation} -- user lookups are read-only.`);
    }
    if (context.actionName !== undefined || context.assertedActionName !== undefined || context.proof !== undefined) {
      throw new AccessDeniedError(`a "user_lookup" read must not carry a resolved action or an approval proof.`);
    }
    return;
  }

  const resolved = resolveActionRequirement(context);

  // No Action resolved. Permitted only for a Kernel-owned write to a source
  // the Kernel itself owns, or for any read performed by a helper that has
  // no Unit operation behind it. Everything else is a denial -- a governed
  // business write with no Action behind it is exactly the arbitrary-write
  // bypass that must not exist.
  if (resolved === null) {
    if (context.assertedActionName !== undefined) {
      throw new AccessDeniedError(`${describe(request, context)} names an expected action, but the Work records none -- refusing to proceed without a resolvable Action.`);
    }
    if (request.operation === "read") return;
    if (context.kind !== "system") {
      throw new AccessDeniedError(
        `a ${request.operation} to ${request.dataSourceId} with no resolved Unit Action is only permitted as a Kernel-owned "system" write, not under context "${context.kind}" -- ${describe(request, context)}.`,
      );
    }
    if (!kernelOwnedWriteDataSourceIds(env).includes(request.dataSourceId)) {
      throw new AccessDeniedError(
        `"system" context may not write data source ${request.dataSourceId} -- a Kernel system context authorizes only the Activity & Decision Log it owns, and every other governed source requires a Work's own Action.`,
      );
    }
    return;
  }

  // The Action's declared consequence must permit this operation. This runs
  // for reads and writes alike, so a "read" Action can never authorize a
  // write and an "internal" Action can never reach governed state.
  if (!consequencePermits(resolved.action, request.operation)) {
    throw new AccessDeniedError(
      `action "${resolved.action.name}" is declared "${resolved.action.consequence}" and does not permit a ${request.operation} of data source ${request.dataSourceId} -- ${describe(request, context)}.`,
    );
  }

  if (isApprovalGatedWrite(env, resolved.action, request, context)) {
    if (!context.proof) {
      throw new AccessDeniedError(
        `action "${resolved.action.name}" requires Martin's explicit approval before ${describe(request, context)} may proceed, and no ApprovalProof was supplied.`,
      );
    }
    verifyProof(context.proof, request, context, resolved.action.name);
    return;
  }

  if (context.proof) {
    verifyProof(context.proof, request, context, resolved.action.name);
  }
}

// ---------------------------------------------------------------------------
// External mutations -- the dedicated, explicit model for a registered
// operation whose effect changes remote state OUTSIDE Notion.
//
// This is a separate decision function on purpose: EXTERNAL_EGRESS_TARGET
// stays read-only above, and "read from an external API" and "mutate external
// state" are never the same question. An external mutation is judged ONLY
// from trusted execution state -- the Work's own resolved Action, the Action's
// declaration, its consequence, its authoritative approval requirement, and a
// proof bound to work + action + operation + external target. Nothing about
// the decision comes from a model response, Skill content, invocation
// arguments, or a caller-supplied approval boolean, and OAuth credentials
// never appear here: holding Google API access is authentication, not ENIG
// authorization. Every failure throws AccessDeniedError, which the invocation
// boundary reports as the `denied` outcome BEFORE any external request.
// ---------------------------------------------------------------------------

/**
 * The request `evaluateExternalMutationAccess` judges. Every field is a fact
 * the invocation boundary resolved from REGISTERED definitions and validated
 * runtime state -- never a value a Tool caller can choose: `toolId` and
 * `operationId` come from the exact registry lookup, `effect` from the
 * registered operation's own declaration, and `targetResourceId` from the
 * boundary's trusted target resolution (see `invokeTool`,
 * src/runtime/toolRegistry.ts).
 */
export interface ExternalMutationRequest {
  /** Exact registered Tool id, resolved by the invocation boundary. */
  toolId: string;
  /** Exact registered operation id, resolved by the invocation boundary. */
  operationId: string;
  /** The registered operation's declared effect classification. */
  effect: ToolEffectClassification;
  /** The external resource the mutation targets, resolved and validated by the invocation boundary. */
  targetResourceId: string;
}

function describeExternalMutation(request: ExternalMutationRequest, context: AccessContext): string {
  // The operation id is already Tool-scoped ("google_docs.create_and_verify"), so it is named alone -- no doubled prefix.
  return `external mutation ${request.operationId} on ${request.targetResourceId} under context "${context.kind}"${
    context.unit ? ` (${context.unit}${context.hat ? `/${context.hat}` : ""})` : ""
  }${context.actionName ? ` action "${context.actionName}"` : ""}`;
}

/**
 * Authorizes one external mutation. Returns void or throws AccessDeniedError;
 * it performs nothing itself and is always called before the external request.
 *
 * In order, all fail-closed:
 *  1. a known context kind, and specifically a `work_session` -- an external
 *     mutation is only ever judged by a Work's own Action, so system,
 *     discovery_cron and user_lookup contexts are denied outright;
 *  2. a known effect classification (no effect, no request);
 *  3. a resolvable Action (no recorded Action, unknown Unit/Hat/Action ->
 *     denial, never "un-gated");
 *  4. the Action's declared consequence permits the effect (`external_mutation`
 *     requires `write` -- read/internal Actions can never reach external
 *     state);
 *  5. the Work's own resolved Action DECLARES this exact operation;
 *  6. approval evidence, per the ONE authoritative source -- the resolved
 *     Action's `requiresApproval`: required -> a bound proof must exist;
 *     not required -> any proof that IS supplied is still verified, so a
 *     supplied proof can only tighten, never loosen.
 */
export function evaluateExternalMutationAccess(env: Env, request: ExternalMutationRequest, context: AccessContext): void {
  void env;
  if (!ACCESS_CONTEXT_KINDS.includes(context.kind)) {
    throw new AccessDeniedError(`unknown execution context kind "${String(context.kind)}" for ${describeExternalMutation(request, context)} -- refusing to proceed unclassified.`);
  }
  if (request.effect !== "external_mutation") {
    throw new AccessDeniedError(`unknown effect classification "${String(request.effect)}" on ${describeExternalMutation(request, context)} -- only a registered, known effect can be judged.`);
  }
  if (context.kind !== "work_session") {
    throw new AccessDeniedError(
      `${describeExternalMutation(request, context)} requires a "work_session" context carrying the Work's own resolved Action -- an external state change is never authorized by a "${context.kind}" context.`,
    );
  }
  if (typeof request.targetResourceId !== "string" || request.targetResourceId.length === 0) {
    throw new AccessDeniedError(`${describeExternalMutation(request, context)} has no resolvable external target -- an external mutation without a resolved target cannot proceed.`);
  }

  const resolved = resolveActionRequirement(context);
  if (resolved === null) {
    throw new AccessDeniedError(
      `${describeExternalMutation(request, context)} has no resolved Unit Action -- an external mutation requires a registered Action behind it and is never permitted as an action-less operation.`,
    );
  }
  if (resolved.action.consequence !== "write") {
    throw new AccessDeniedError(
      `action "${resolved.action.name}" is declared "${resolved.action.consequence}" and cannot carry effect "external_mutation" on ${describeExternalMutation(request, context)} -- only a "write" Action may mutate external state.`,
    );
  }
  const declared = (resolved.action.tool_operations ?? []).some(
    (declaration) => declaration.tool_id === request.toolId && declaration.operation_id === request.operationId,
  );
  if (!declared) {
    throw new AccessDeniedError(
      `action "${resolved.action.name}" does not declare Tool operation ${request.operationId} -- a Tool operation is permitted only when the Work's own resolved Action declares it, and availability of the Tool grants nothing.`,
    );
  }

  const binding = {
    workId: context.workId ?? "",
    actionName: resolved.action.name,
    toolId: request.toolId,
    operationId: request.operationId,
    targetResourceId: request.targetResourceId,
  };
  if (resolved.action.requiresApproval) {
    if (!context.proof) {
      throw new AccessDeniedError(
        `action "${resolved.action.name}" requires Martin's explicit approval before ${describeExternalMutation(request, context)} may proceed, and no ApprovalProof was supplied.`,
      );
    }
    verifyExternalToolProof(context.proof, binding);
    return;
  }
  if (context.proof) {
    verifyExternalToolProof(context.proof, binding);
  }
}

/** The exact facts an ApprovalProof must match to authorize one external mutation. */
export interface ExternalToolProofBinding {
  workId: string;
  actionName: string;
  toolId: string;
  operationId: string;
  targetResourceId: string;
}

/**
 * Verifies an ApprovalProof against the exact external mutation it is being
 * offered for. Every field is checked; a proof either wholly authorizes this
 * operation on this resource or it authorizes nothing. A Notion-bound proof
 * (targetDataSourceId set to a governed source, or no `toolOperation` binding)
 * can never pass here, and vice versa -- see EXTERNAL_TOOL_TARGET.
 */
export function verifyExternalToolProof(proof: ApprovalProof, binding: ExternalToolProofBinding): void {
  if (typeof proof.approvalToken !== "string" || proof.approvalToken.length < 8) {
    throw new AccessDeniedError(`the supplied approval proof has no usable approval token for ${binding.operationId}.`);
  }
  if (typeof proof.approvedAt !== "string" || proof.approvedAt.length === 0) {
    throw new AccessDeniedError(`the supplied approval proof has no approval timestamp for ${binding.operationId}.`);
  }
  if (proof.workId !== binding.workId) {
    throw new AccessDeniedError(
      `the supplied approval proof is for Work ${proof.workId}, not the current Work ${binding.workId || "(none)"} -- an approval never carries across work items.`,
    );
  }
  if (proof.actionName !== binding.actionName) {
    throw new AccessDeniedError(`the supplied approval proof is for action "${proof.actionName}", not the resolved action "${binding.actionName}".`);
  }
  if (proof.targetDataSourceId !== EXTERNAL_TOOL_TARGET) {
    throw new AccessDeniedError(
      `the supplied approval proof targets ${proof.targetDataSourceId}, not an external Tool operation -- a Notion-bound approval never authorizes an external mutation, and an external approval must be minted against "${EXTERNAL_TOOL_TARGET}".`,
    );
  }
  const bound = proof.toolOperation;
  if (!bound) {
    throw new AccessDeniedError(`the supplied approval proof carries no external Tool operation binding, so it cannot authorize ${binding.operationId}.`);
  }
  if (bound.toolId !== binding.toolId || bound.operationId !== binding.operationId) {
    throw new AccessDeniedError(
      `the supplied approval proof authorizes Tool operation ${bound.operationId}, not ${binding.operationId} -- an approval never carries across operations.`,
    );
  }
  if (bound.targetResourceId !== binding.targetResourceId) {
    throw new AccessDeniedError(
      `the supplied approval proof authorizes external target ${bound.targetResourceId}, not ${binding.targetResourceId} -- an approval never carries across external targets.`,
    );
  }
}

/**
 * The sanctioned minter for an external-mutation ApprovalProof: bound to the
 * Action the Work ACTUALLY records (same rule as mintApprovalProofForWork --
 * a call site never names the Action) plus the exact operation and external
 * target. It goes through mintApprovalProof, the only sanctioned way to
 * produce a proof, with EXTERNAL_TOOL_TARGET standing in for the Notion data
 * source so the two proof kinds stay mutually exclusive.
 *
 * Fails closed when the Work records no Action: there is no operation to bind
 * an approval to, and a proof without one could never be verified.
 */
export function mintExternalToolApprovalProof(
  state: WorkState,
  binding: { toolId: string; operationId: string; targetResourceId: string },
): ApprovalProof {
  if (typeof state.actionName !== "string" || state.actionName.length === 0) {
    throw new AccessDeniedError(
      `Work ${state.workId} records no Action, so Martin's approval of ${binding.operationId} cannot be bound to one -- refusing to mint a proof that could not be verified.`,
    );
  }
  return mintApprovalProof({
    workId: state.workId,
    actionName: state.actionName,
    targetDataSourceId: EXTERNAL_TOOL_TARGET,
    toolOperation: binding,
  });
}

/** The single input a verified approval callback needs to mint a proof. */
export interface MintApprovalProofInput {
  workId: string;
  actionName: string;
  targetDataSourceId: string;
  /** The exact external Tool Operation this proof authorizes -- required for an external mutation (minted via mintExternalToolApprovalProof), never set for a Notion write. */
  toolOperation?: { toolId: string; operationId: string; targetResourceId: string };
  /** Injected for deterministic tests; production callers omit it and get crypto.randomUUID(). */
  token?: string;
  /** Injected for deterministic tests; production callers omit it and get the current time. */
  approvedAt?: string;
}

/**
 * The ONLY sanctioned way to produce an ApprovalProof.
 *
 * Call this from inside a verified approval callback, at the moment the
 * staged approval it corresponds to is being consumed -- never before the
 * callback has verified Martin's decision, and never from anywhere that
 * has not just consumed a staged approval. The staged approval is consumed
 * as the proof is minted, so a replayed Telegram callback finds nothing
 * left to consume and never reaches minting at all.
 *
 * Note the token is a fresh unguessable value per mint, not a check
 * against a stored one: the real replay protection is the consumption of
 * the staged approval, and the proof is the artifact that consumption
 * produces.
 */
export function mintApprovalProof(input: MintApprovalProofInput): ApprovalProof {
  if (!input.workId) throw new AccessDeniedError("cannot mint an approval proof without a Work id.");
  if (!input.actionName) throw new AccessDeniedError("cannot mint an approval proof without an action name.");
  if (!input.targetDataSourceId) throw new AccessDeniedError("cannot mint an approval proof without a target data source.");
  return {
    workId: input.workId,
    actionName: input.actionName,
    targetDataSourceId: input.targetDataSourceId,
    approvalToken: input.token ?? crypto.randomUUID(),
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    ...(input.toolOperation ? { toolOperation: input.toolOperation } : {}),
  };
}

// ---------------------------------------------------------------------------
// Context constructors.
//
// These exist to keep the many call sites honest and readable: each still has
// to say which kind of context it runs under and, for a Unit's work, which
// Work it is acting for. They add no capability and no default that could
// loosen a check -- a context built here is evaluated by exactly the same
// evaluateAccess as one written out by hand. In particular none of them takes
// an Action name as a parameter: the Action is read off the Work, so there is
// no constructor through which a caller can choose which Action its operation
// is judged by.
// ---------------------------------------------------------------------------

/**
 * Kernel-owned operation that is not any Unit's business action.
 *
 * Narrow on purpose. As a WRITE this authorizes exactly one target -- the
 * Activity & Decision Log the Kernel owns (see kernelOwnedWriteDataSourceIds)
 * -- and as a READ it authorizes reading ENIG's own records. It is NOT a
 * general "trusted caller" context: holding one does not let anything write an
 * Entity, Matter, Proposal, Handoff, or Lead. Those require a Work's own
 * recorded Action, and a gated one additionally requires a proof.
 */
export function systemContext(workId?: string): AccessContext {
  return { kind: "system", ...(workId ? { workId } : {}) };
}

/** A read answering a question about ENIG's own records. Read-only by construction. */
export function userLookupContext(workId?: string): AccessContext {
  return { kind: "user_lookup", ...(workId ? { workId } : {}) };
}

/** The scheduled cross-Unit Handoff pickup loop (Class C -- stays outside manifest dispatch). Performs no governed write of its own. */
export function discoveryCronContext(workId?: string): AccessContext {
  return { kind: "discovery_cron", ...(workId ? { workId } : {}) };
}

/**
 * A read performed on behalf of a live Work item, by a helper that is not
 * itself one Hat's action (token resolution, a shared record lookup).
 *
 * Deliberately carries no Unit/Hat/Action: there is no registered operation
 * behind it, so claiming one would be inventing authority. Because it resolves
 * no Action, it authorizes reads and nothing else -- any write through this
 * context is a denial.
 */
export function workSessionReadContext(workId?: string): AccessContext {
  return { kind: "work_session", ...(workId ? { workId } : {}) };
}

/**
 * An operation performed on behalf of a live Work item, judged by the Action
 * THAT WORK RECORDS.
 *
 * This is the structural half of "no caller can downgrade a governed
 * operation". The authority is read off `state.actionName` -- recorded on the
 * Work at creation/dispatch, and advanced only by the code performing a
 * different registered operation -- so there is no parameter through which a
 * call site could name a laxer Action. Handing this function a WorkState is
 * the only way to build a work_session context with an Action behind it.
 *
 * `assertedActionName` is optional and is a cross-check only: pass the Action
 * the call site believes it is performing, and a disagreement with the Work's
 * record fails closed rather than resolving to either value.
 *
 * A Work that records no Action yields a context with no Action, which
 * authorizes reads only. That is correct for genuinely action-less Work, and a
 * denial for a governed business write.
 */
export function workSessionContext(state: WorkState, proof?: ApprovalProof, assertedActionName?: string): AccessContext {
  if (typeof state?.workId !== "string" || state.workId.length === 0) {
    throw new AccessDeniedError("cannot build a work_session Access context without a Work id.");
  }
  return {
    kind: "work_session",
    workId: state.workId,
    ...(state.unit !== undefined ? { unit: state.unit } : {}),
    ...(state.hat !== undefined ? { hat: state.hat } : {}),
    ...(state.actionName !== undefined ? { actionName: state.actionName } : {}),
    ...(assertedActionName !== undefined ? { assertedActionName } : {}),
    ...(state.handoffId !== undefined ? { inboundHandoffId: state.handoffId } : {}),
    ...(proof ? { proof } : {}),
  };
}

/**
 * Mints an ApprovalProof bound to the Action the Work ACTUALLY records.
 *
 * Prefer this over `mintApprovalProof` at any approval callback. Access
 * resolves the Action from `WorkState.actionName` and then checks the proof
 * against THAT name, so a proof minted here cannot name a different operation
 * than the one the write will be judged by -- which closes the last place a
 * call site could have picked its own authority.
 *
 * Fails closed when the Work records no Action: there is no operation to bind
 * an approval to, and a proof without one could never be verified.
 */
export function mintApprovalProofForWork(state: WorkState, targetDataSourceId: string): ApprovalProof {
  if (typeof state.actionName !== "string" || state.actionName.length === 0) {
    throw new AccessDeniedError(
      `Work ${state.workId} records no Action, so Martin's approval of it cannot be bound to one -- refusing to mint a proof that could not be verified.`,
    );
  }
  return mintApprovalProof({
    workId: state.workId,
    actionName: state.actionName,
    targetDataSourceId,
  });
}
