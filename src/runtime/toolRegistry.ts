/**
 * TOOL REGISTRY -- the shared, typed invocation boundary for registered
 * external Tools (ENIG Operating Model: KERNEL -> WORK -> ... -> TOOLS; the
 * canonical Tool Registry contract under ENIG HQ > 6. Tools, and the Google
 * Docs child specification).
 *
 * Pure mechanism, on the same reasoning as the Action Registry: this module
 * decides no Unit's action list and holds no business logic. It supplies
 * controlled execution capability --
 *
 *   exact resolution -> input validation -> trusted target resolution ->
 *   Access authorization (the Work's own resolved Action) -> durable
 *   recovery (reconcile a prior uncertain effect) -> durable intent ->
 *   the registered handler -> durable outcome -> outcome validation --
 *
 * and every step fails closed: an unknown Tool or operation, an undeclared
 * Action-to-Tool combination, invalid input, an unresolvable target, a
 * denial, a missing durable-persistence adapter, or a malformed outcome can
 * never become a request. The five outcome states are the canonical ones:
 * succeeded, failed, partially_completed, unverified, denied. A denial is
 * the DENIED OUTCOME (the Access boundary's AccessDeniedError is caught and
 * reported here) -- it is never converted into a failure or any other state.
 *
 * Two invariants this boundary exists to keep:
 *   - a Tool's availability, a Skill, or a caller-supplied approval grants
 *     NOTHING: authorization comes only from the registered declarations and
 *     trusted execution state, and OAuth credentials are never consulted
 *     here (authentication is not ENIG authorization);
 *   - an uncertain remote effect is never blindly retried: a prior
 *     `partially_completed`/`unverified` outcome -- whether handed in by the
 *     caller or read back from the Work's own DURABLE operation record
 *     (src/runtime/workPersistence.ts) -- must be reconciled by the
 *     operation's own reconciliation step before anything new may run, and
 *     an uncertain outcome that cannot be reconciled refuses outright.
 *
 * Durable recovery (the interruption window): the intent is persisted to the
 * Work's Durable Object storage BEFORE the first protected external effect
 * and the outcome immediately after, keyed by operation identity (Work + exact
 * operation + trusted target + a digest of the request's own input, so two
 * different requested remote states are two logical operations). On resumption
 * a verified success is returned as-is (the mutation is never repeated), an
 * `in_progress` record whose outcome never landed is reconciled against the
 * provider, and a record whose remote state stays unknown keeps failing
 * closed. Two concurrent attempts at the same operation in the same Work
 * session are serialized by the in-flight guard below; cross-restart
 * uncertainty is carried by the durable record itself.
 *
 * Registration is static and code-owned (initial implementation boundary):
 * TOOL_OPERATIONS below is the only table, so no caller can register, select
 * or substitute a handler -- `invokeTool` names an id, never a function.
 */
import type { Env, ExternalToolOperationRecord } from "../types";
import type { AccessContext } from "../access";
import { AccessDeniedError, evaluateExternalMutationAccess } from "../access";
import type { ActionDefinition } from "../hats/actionRegistry";
import { googleDocsToolOperation } from "./tools/googleDocsTool";
import { googleDocsUpdateToolOperation } from "./tools/googleDocsUpdateTool";
import { googleDriveEnsureFolderToolOperation } from "./tools/googleDriveFolderTool";
import { getWorkPersistence, type ToolOperationPersistence } from "./workPersistence";

// ---------------------------------------------------------------------------
// Contract types.
// ---------------------------------------------------------------------------

/**
 * Effect classification of a registered operation. The initial
 * implementation registers exactly the one classification the canonical
 * contract defines; external READS remain on the read-only
 * EXTERNAL_EGRESS_TARGET path in Access and are a different question.
 */
export type ToolEffectClassification = "external_mutation";

/** The canonical outcome states of a Tool operation (Tool Registry contract). */
export type ToolOutcomeState = "succeeded" | "failed" | "partially_completed" | "unverified" | "denied";

const TOOL_OUTCOME_STATES: readonly ToolOutcomeState[] = ["succeeded", "failed", "partially_completed", "unverified", "denied"];

export interface ToolInvocationOutcome {
  state: ToolOutcomeState;
  tool_id: string;
  operation_id: string;
  /** The remote resource, when one is known to exist. Carried through every post-effect state so a retry can reconcile instead of duplicating. */
  remote_resource?: { document_id?: string; url?: string };
  /** Present (true) on `succeeded` only: the read-back verification passed. */
  verified?: boolean;
  /** The implementation stage a non-success ended at, when the operation has stages. */
  stage?: string;
  /** Why the operation did not succeed as it did. Never carries document content or credentials. */
  reason?: string;
  /** True exactly when a remote effect may exist and MUST be reconciled before any retry. */
  reconciliation_required?: boolean;
}

export interface ToolInvocationRequest {
  tool_id: string;
  operation_id: string;
  input: unknown;
  /**
   * The outcome of a previous attempt at this same operation, when the
   * caller has one AND no durable operation record exists for it. The
   * Work's persisted record (`WorkState.externalOperations`, written by
   * this boundary via src/runtime/workPersistence.ts) always wins when
   * present: it is the authority on what a previous attempt actually did,
   * while this argument is only what a caller happens to remember. Both are
   * held to the same retry safety -- a prior uncertain outcome is
   * reconciled before anything new may run, and a malformed one refuses
   * outright.
   */
  prior_outcome?: ToolInvocationOutcome;
}

/** A target the operation resolved against trusted runtime state -- never accepted raw from a caller. */
export interface ResolvedToolTarget {
  /** The external resource the mutation acts on, in the operation's own namespaced form (e.g. `gdrive:folder:<id>`). Bound to approval evidence by Access. */
  resourceId: string;
}

/**
 * One registered operation: exact identifiers, declared effect, runtime
 * input validation, trusted target resolution, the trusted handler, and --
 * for operations with side effects that can be uncertain -- reconciliation.
 * A definition with a missing or inconsistent field is rejected by
 * `validateToolOperations` at registry assembly.
 */
export interface ToolOperationDefinition {
  /** Exact registered Tool id (e.g. "google_docs"). */
  toolId: string;
  /** Exact registered operation id -- namespaced by its Tool (e.g. "google_docs.create_and_verify"). */
  operationId: string;
  /** The operation contract's version (canonical Google Docs specification: "1.0"). */
  version: string;
  /** The operation's declared effect classification. */
  effect: ToolEffectClassification;
  /** Runtime input validation. Returns null when valid, or the defect. Runs before target resolution, Access, and any request. */
  validateInput(input: unknown): string | null;
  /** Resolves and validates the external target from trusted runtime state. Runs after input validation and before the Access decision (Access binds approval evidence to what this returns). */
  resolveTarget(env: Env, input: unknown): Promise<{ ok: true; target: ResolvedToolTarget } | { ok: false; reason: string }>;
  /**
   * Reconciles the remote state a prior uncertain outcome left behind.
   * Returning an outcome ends the invocation without a new effect; returning
   * null establishes that no remote effect exists, which is the only state
   * in which a fresh creation may proceed.
   */
  reconcile?(env: Env, prior: ToolInvocationOutcome, input: unknown): Promise<{ outcome: ToolInvocationOutcome | null }>;
  /** The trusted handler. Runs only after every validation and the Access decision have passed. */
  run(env: Env, input: unknown, target: ResolvedToolTarget): Promise<ToolInvocationOutcome>;
}

// ---------------------------------------------------------------------------
// The static registry.
// ---------------------------------------------------------------------------

/** The code-owned registration table. The ONLY source of handlers -- nothing is registered at runtime. */
const TOOL_OPERATIONS: readonly ToolOperationDefinition[] = [
  googleDocsToolOperation,
  googleDocsUpdateToolOperation,
  googleDriveEnsureFolderToolOperation,
];

/** Exact resolution: no prefix match, no substitution, no fallback. Returns null for anything not registered. */
export function resolveToolOperation(toolId: string, operationId: string): ToolOperationDefinition | null {
  if (typeof toolId !== "string" || typeof operationId !== "string") return null;
  return TOOL_OPERATIONS.find((operation) => operation.toolId === toolId && operation.operationId === operationId) ?? null;
}

/**
 * Shape/integrity validation for a set of operation definitions (the real
 * registry, or a defective fixture). Used at registry assembly so a
 * malformed, duplicate or misnamespaced definition fails before production
 * requests are served rather than being resolvable at runtime.
 */
export function validateToolOperations(operations: readonly ToolOperationDefinition[]): string | null {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (typeof operation?.toolId !== "string" || !operation.toolId.trim()) return "a registered Tool operation must carry a non-empty toolId";
    if (typeof operation?.operationId !== "string" || !operation.operationId.trim()) return "a registered Tool operation must carry a non-empty operationId";
    if (!operation.operationId.startsWith(`${operation.toolId}.`)) {
      return `registered operation "${operation.operationId}" is not namespaced by its Tool id "${operation.toolId}" -- operation ids are exact and Tool-scoped`;
    }
    if (typeof operation.version !== "string" || !operation.version.trim()) {
      return `registered operation ${operation.operationId} must declare a version`;
    }
    if (operation.effect !== "external_mutation") {
      return `registered operation ${operation.operationId} declares unknown effect "${String(operation.effect)}"`;
    }
    for (const member of ["validateInput", "resolveTarget", "run"] as const) {
      if (typeof operation[member] !== "function") {
        return `registered operation ${operation.operationId} is missing its ${member} implementation -- a definition without one is not executable and must not be registered`;
      }
    }
    if (operation.reconcile !== undefined && typeof operation.reconcile !== "function") {
      return `registered operation ${operation.operationId} declares a non-function reconcile step`;
    }
    if (seen.has(operation.operationId)) {
      return `Tool operation "${operation.operationId}" is registered more than once -- registration is exact and single`;
    }
    seen.add(operation.operationId);
  }
  return null;
}

/** The code-owned registration table's own integrity, validated at registry assembly (see validateToolOperations). */
export function validateToolRegistry(): string | null {
  return validateToolOperations(TOOL_OPERATIONS);
}

/**
 * The registry half of manifest validation: every Tool operation an Action
 * DECLARES must be an exactly registered operation, checked where manifests
 * assemble (buildUnitRegistry) so a declaration naming an unknown operation
 * fails the test/deploy gate rather than surfacing on a live request. Shape
 * (non-empty ids, explicit `required`, no duplicates) is checked earlier, by
 * `validateActionDefinition`.
 */
export function validateActionToolDeclarations(
  actions: readonly Pick<ActionDefinition<string>, "name" | "tool_operations">[],
): string | null {
  for (const action of actions) {
    for (const declaration of action.tool_operations ?? []) {
      if (!resolveToolOperation(declaration.tool_id, declaration.operation_id)) {
        return `action "${action.name}" declares Tool operation ${declaration.operation_id}, which is not registered in the Tool Registry -- a declaration may name only an exact registered operation`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The invocation boundary.
// ---------------------------------------------------------------------------

function isToolOutcomeState(value: unknown): value is ToolOutcomeState {
  return TOOL_OUTCOME_STATES.includes(value as ToolOutcomeState);
}

/**
 * Validates a handler's outcome against the contract, returning the defect
 * (fail-closed) or null. The rules that keep the five states honest:
 * `succeeded` must carry verified read-back plus the remote resource;
 * `failed` must say why and may neither claim verification nor demand
 * reconciliation (it asserts no remote effect); the two uncertain states must
 * demand reconciliation; `denied` may claim no remote resource at all, since
 * denial happens before any external request.
 */
export function validateOutcomeShape(outcome: ToolInvocationOutcome, operation: ToolOperationDefinition): string | null {
  if (typeof outcome !== "object" || outcome === null) return "the handler returned a non-object outcome";
  if (!isToolOutcomeState(outcome.state)) return `the handler returned unknown outcome state "${String(outcome.state)}"`;
  if (outcome.tool_id !== operation.toolId || outcome.operation_id !== operation.operationId) {
    return `the handler returned an outcome for ${String(outcome.tool_id)}.${String(outcome.operation_id)}, not ${operation.toolId}.${operation.operationId}`;
  }
  switch (outcome.state) {
    case "succeeded":
      if (outcome.verified !== true) return "a succeeded outcome must carry verified: true -- success is claimed only after read-back verification";
      if (typeof outcome.remote_resource?.document_id !== "string" || outcome.remote_resource.document_id.length === 0) {
        return "a succeeded outcome must carry the remote resource id it verified";
      }
      return null;
    case "failed":
      if (typeof outcome.reason !== "string" || outcome.reason.length === 0) return "a failed outcome must state why it failed";
      if (outcome.verified === true) return "a failed outcome may not claim verification";
      if (outcome.reconciliation_required !== undefined && outcome.reconciliation_required !== false) {
        return "a failed outcome may not demand reconciliation -- it asserts that no remote effect exists";
      }
      return null;
    case "partially_completed":
    case "unverified":
      if (outcome.reconciliation_required !== true) {
        return `a ${outcome.state} outcome must set reconciliation_required: true -- its remote effect must be reconciled before any retry`;
      }
      return null;
    case "denied":
      if (outcome.remote_resource !== undefined) return "a denied outcome may not claim a remote resource -- denial happens before any external request";
      if (outcome.reconciliation_required !== undefined && outcome.reconciliation_required !== false) {
        return "a denied outcome may not demand reconciliation -- no external request was made";
      }
      return null;
  }
}

/** A malformed outcome is never reported as any other result: conservatively unverified, with reconciliation demanded, because the remote state is genuinely unknown. */
function malformedOutcome(tool_id: string, operation_id: string, defect: string): ToolInvocationOutcome {
  return {
    state: "unverified",
    tool_id,
    operation_id,
    reason: `the registered handler returned a malformed outcome (${defect}) -- failing closed: the remote state is unknown and must be reconciled before any retry`,
    reconciliation_required: true,
  };
}

function denied(tool_id: string, operation_id: string, reason: string): ToolInvocationOutcome {
  return { state: "denied", tool_id, operation_id, reason };
}

// ---------------------------------------------------------------------------
// Durable recovery: operation identity, record validation, persistence.
// ---------------------------------------------------------------------------

/**
 * The stable operation identity on a Work: exact operation + trusted target +
 * a digest of the request's OWN input. The Work id is implicit -- records live
 * ON that Work's own state -- so one logical operation (this Work, this
 * operation, this target, this exact requested remote state) always maps to
 * exactly one durable record.
 *
 * The input digest is what keeps two DIFFERENT requested remote states from
 * collapsing into one record: bringing THE Proposal Doc to v1 and bringing
 * the same Doc to v2 are two logical operations on one target, and a verified
 * success for the first must never be returned as "already done" for the
 * second (that would silently skip the write). The same request always
 * derives the same identity, so an interrupted attempt is still found and
 * reconciled instead of repeated.
 */
export function operationRecordKey(operationId: string, targetResourceId: string, input: unknown): string {
  return `${operationId}|${targetResourceId}|${stableInputDigest(input)}`;
}

/** Deterministic JSON with sorted object keys, so an equivalent input always digests identically. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** A small deterministic 64-bit FNV-1a-style digest of an invocation's own input. Never used as a security primitive -- only as an identity. */
function stableInputDigest(input: unknown): string {
  const text = stableStringify(input);
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 16777619) >>> 0;
    low = Math.imul(low + code, 2246822519) >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

/**
 * Validates a record read back from Work storage against this exact
 * invocation: right Work, right operation, right target, right contract
 * version, and a status/outcome pair that agrees with itself. Returns the
 * defect (fail-closed) or null.
 */
function validateStoredRecord(record: unknown, operation: ToolOperationDefinition, targetResourceId: string, workId: string): string | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return "the persisted record is not an object";
  const stored = record as ExternalToolOperationRecord;
  if (stored.work_id !== workId) return `the persisted record belongs to Work ${String(stored.work_id)}, not ${workId}`;
  if (stored.tool_id !== operation.toolId || stored.operation_id !== operation.operationId) {
    return `the persisted record is for operation ${String(stored.operation_id)} (Tool ${String(stored.tool_id)}), not ${operation.operationId}`;
  }
  if (stored.target_resource_id !== targetResourceId) {
    return `the persisted record targets ${String(stored.target_resource_id)}, not the resolved target ${targetResourceId}`;
  }
  if (stored.version !== operation.version) {
    return `the persisted record was written under operation version ${String(stored.version)}, and the registered contract is ${operation.version}`;
  }
  if (stored.status !== "in_progress" && !isToolOutcomeState(stored.status)) {
    return `the persisted record carries unknown status ${String(stored.status)}`;
  }
  if (stored.status === "in_progress") {
    if (stored.outcome !== undefined) return "the persisted record is marked in_progress yet already carries an outcome";
    return null;
  }
  if (typeof stored.outcome !== "object" || stored.outcome === null) {
    return `the persisted record has terminal status ${stored.status} but carries no outcome`;
  }
  if (stored.outcome.state !== stored.status) {
    return `the persisted record's status ${stored.status} disagrees with its outcome state ${String(stored.outcome.state)}`;
  }
  return null;
}

/**
 * The prior attempt a durable record describes. An `in_progress` record IS
 * the interruption window -- intent persisted, outcome never landed -- so it
 * surfaces as an unverified effect that must be reconciled before anything
 * new may run; a terminal record surfaces as its persisted outcome.
 */
function priorFromStoredRecord(record: ExternalToolOperationRecord, operation: ToolOperationDefinition): ToolInvocationOutcome | undefined {
  if (record.status === "in_progress") {
    return {
      tool_id: operation.toolId,
      operation_id: operation.operationId,
      state: "unverified",
      reason: "an earlier attempt persisted its execution intent but never its outcome -- whatever it did remotely must be reconciled before anything new may run",
      ...(record.remote_resource ? { remote_resource: record.remote_resource } : {}),
      reconciliation_required: true,
    };
  }
  return record.outcome ? { ...record.outcome, tool_id: operation.toolId, operation_id: operation.operationId } : undefined;
}

/**
 * Persists a terminal outcome over a record's identity. A save failure never
 * rewrites what was actually observed: the durable record stays `in_progress`
 * and the NEXT invocation reconciles it against the provider -- conservative
 * in the safe direction, never "assume it failed" and never "assume it worked".
 */
async function persistOperationOutcome(
  persistence: ToolOperationPersistence,
  recordKey: string,
  record: ExternalToolOperationRecord,
  outcome: ToolInvocationOutcome,
): Promise<void> {
  try {
    await persistence.save(recordKey, {
      ...record,
      status: outcome.state,
      outcome: { ...outcome },
      ...(outcome.remote_resource ? { remote_resource: outcome.remote_resource } : {}),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`invokeTool: could not persist the outcome of ${record.operation_id} (state: ${outcome.state})`, error);
  }
}

/**
 * In-flight guard: at most one concurrent attempt per (Work, operation,
 * target) in this session. A Durable Object interleaves events while awaiting
 * a provider response, so without this two racing attempts inside the same
 * Work could each start the same remote effect; the loser is refused before
 * any request. Uncertainty that outlives the process is carried by the
 * durable record instead.
 */
const IN_FLIGHT_OPERATIONS = new Set<string>();

/**
 * THE invocation boundary used by Work execution. Everything a caller can
 * supply is the request; the authority is the trusted `context` (built by
 * `workSessionContext`, which reads the Action off the Work itself) and the
 * registered definitions. The caller cannot pass a handler, replace the
 * Work's Action, pick a laxer path, or assert an approval: the exact
 * operation resolves from the static table, Access judges the Work's own
 * resolved Action, and approval evidence -- when the Action requires it --
 * must be bound to this work, action, operation and external target.
 *
 * Returns one of the five canonical states; the Access boundary's denials
 * surface here as `denied`. Throws only for genuine runtime faults (an
 * unexpected error from Access itself or from the handler's environment),
 * never as a substitute for a denial or failure outcome.
 */
export async function invokeTool(env: Env, request: ToolInvocationRequest, context: AccessContext): Promise<ToolInvocationOutcome> {
  const operation = resolveToolOperation(request.tool_id, request.operation_id);
  if (!operation) {
    return denied(
      String(request.tool_id),
      String(request.operation_id),
      `tool operation ${String(request.tool_id)}.${String(request.operation_id)} is not registered in the Tool Registry -- an unknown Tool or operation is never treated as an unguarded one`,
    );
  }
  const base = { tool_id: operation.toolId, operation_id: operation.operationId };

  // 1. Input contract.
  const inputDefect = operation.validateInput(request.input);
  if (inputDefect) {
    return denied(operation.toolId, operation.operationId, `invalid input for ${operation.operationId}: ${inputDefect}`);
  }

  // 2. Trusted target resolution (account set and folder shape from this
  //    Worker's own runtime state) -- before Access, so approval evidence
  //    binds to what Access is about to judge.
  const resolvedTarget = await operation.resolveTarget(env, request.input);
  if (!resolvedTarget.ok) {
    return denied(operation.toolId, operation.operationId, resolvedTarget.reason);
  }

  // 3. Authorization -- the Work's own resolved Action, its declaration, its
  //    effect classification, and bound approval evidence when gated.
  try {
    evaluateExternalMutationAccess(
      env,
      {
        toolId: operation.toolId,
        operationId: operation.operationId,
        effect: operation.effect,
        targetResourceId: resolvedTarget.target.resourceId,
      },
      context,
    );
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return denied(operation.toolId, operation.operationId, error.reason);
    }
    throw error;
  }

  // 4. Durable recovery. The Work's own persisted operation record is the
  //    authority on what any previous attempt actually did; the caller's
  //    `prior_outcome` is consulted only when no record exists. Without the
  //    Work's durable persistence adapter no effect may start at all -- an
  //    operation that could not be recovered after an interruption must not
  //    be initiated, so a missing adapter fails closed here.
  const persistence = getWorkPersistence(String(context.workId ?? ""));
  if (!persistence) {
    return denied(
      operation.toolId,
      operation.operationId,
      "durable operation persistence is not available for this Work (no WorkSession persistence adapter is installed) -- refusing to initiate an external effect that could not be recovered after an interruption",
    );
  }
  const recordKey = operationRecordKey(operation.operationId, resolvedTarget.target.resourceId, request.input);
  let stored: ExternalToolOperationRecord | undefined;
  try {
    stored = await persistence.load(recordKey);
  } catch (error) {
    return denied(
      operation.toolId,
      operation.operationId,
      `the persisted operation record could not be read (${error instanceof Error ? error.message : "unknown error"}) -- its remote state is unknown, so no new attempt may run`,
    );
  }
  if (stored !== undefined) {
    const defect = validateStoredRecord(stored, operation, resolvedTarget.target.resourceId, String(context.workId ?? ""));
    if (defect) {
      return denied(
        operation.toolId,
        operation.operationId,
        `a persisted operation record for this invocation is incompatible (${defect}) -- refusing to proceed rather than risk a duplicate remote effect`,
      );
    }
  }
  const prior: ToolInvocationOutcome | undefined = stored ? priorFromStoredRecord(stored, operation) : request.prior_outcome;

  // In-flight guard: one concurrent attempt per (Work, operation, target) in
  // this session. A Durable Object interleaves events while awaiting a
  // provider response, so without this two racing attempts in the same Work
  // could each start the same remote effect; the loser is refused before any
  // request. It is deliberately COARSER than the record identity above: two
  // concurrent attempts that request DIFFERENT states of the same document
  // would race each other, so only one of them may be in flight at a time.
  // Cross-restart uncertainty is carried by the durable record.
  const guardKey = `${String(context.workId ?? "")}|${operation.operationId}|${resolvedTarget.target.resourceId}`;
  if (IN_FLIGHT_OPERATIONS.has(guardKey)) {
    return denied(
      operation.toolId,
      operation.operationId,
      "another attempt at this exact operation is already in progress for this Work -- a concurrent duplicate may not initiate a second remote effect",
    );
  }
  IN_FLIGHT_OPERATIONS.add(guardKey);
  try {
    // Retry safety -- after authorization, before anything that could act
    // remotely. A prior uncertain effect is reconciled first; a verified
    // success is returned as-is and never repeated.
    const baseRecord: ExternalToolOperationRecord = stored ?? {
      work_id: String(context.workId ?? ""),
      tool_id: operation.toolId,
      operation_id: operation.operationId,
      version: operation.version,
      target_resource_id: resolvedTarget.target.resourceId,
      status: "in_progress",
      updatedAt: new Date().toISOString(),
    };
    if (prior !== undefined) {
      if (
        !stored &&
        (typeof prior !== "object" ||
          prior === null ||
          !isToolOutcomeState(prior.state) ||
          prior.tool_id !== operation.toolId ||
          prior.operation_id !== operation.operationId)
      ) {
        return denied(
          operation.toolId,
          operation.operationId,
          "a malformed prior_outcome was supplied (wrong operation or unknown state) -- refusing to proceed rather than risk a duplicate remote effect",
        );
      }
      if (prior.state === "succeeded") {
        // The effect already exists and was verified: return it, never recreate.
        return { ...prior, tool_id: operation.toolId, operation_id: operation.operationId };
      }
      if (prior.state === "partially_completed" || prior.state === "unverified") {
        if (!operation.reconcile) {
          if (!prior.remote_resource?.document_id) {
            return {
              ...base,
              state: "unverified",
              ...(prior.remote_resource ? { remote_resource: prior.remote_resource } : {}),
              reason:
                "a previous attempt left an uncertain remote effect with no resource identifier to reconcile -- refusing to create again; the remote state must be resolved first",
              reconciliation_required: true,
            };
          }
          return {
            ...base,
            state: "unverified",
            remote_resource: prior.remote_resource,
            reason: "a previous attempt left an uncertain remote effect and this operation declares no reconciliation step -- refusing to repeat it",
            reconciliation_required: true,
          };
        }
        const reconciliation = await operation.reconcile(env, prior, request.input);
        const outcome = reconciliation.outcome;
        if (outcome !== null && outcome !== undefined) {
          const defect = validateOutcomeShape(outcome, operation);
          const finalOutcome = defect
            ? malformedOutcome(operation.toolId, operation.operationId, defect)
            : { ...outcome, tool_id: operation.toolId, operation_id: operation.operationId };
          await persistOperationOutcome(persistence, recordKey, baseRecord, finalOutcome);
          return finalOutcome;
        }
        // Reconciliation established that the desired remote effect does not
        // exist: a fresh attempt may proceed. A prior `failed`/`denied`
        // record likewise carried no remote effect and falls through to the
        // same place.
      }
    }

    // Persist the execution intent BEFORE the first protected external
    // effect: if the process dies from here on, resumption finds an
    // `in_progress` record and reconciles instead of repeating.
    const intent: ExternalToolOperationRecord = { ...baseRecord, status: "in_progress", updatedAt: new Date().toISOString() };
    try {
      await persistence.save(recordKey, intent);
    } catch (error) {
      return {
        ...base,
        state: "failed",
        stage: "persistence",
        reason: `the execution intent could not be persisted to this Work's storage (${error instanceof Error ? error.message : "unknown error"}) -- refusing to start an external effect that could not be recovered after an interruption`,
      };
    }

    // 5. The registered handler, then contract validation of what it
    //    returned, then the durable outcome. A failed outcome save never
    //    rewrites what was actually observed: the record stays `in_progress`
    //    and the next invocation reconciles it against the provider.
    const result = await operation.run(env, request.input, resolvedTarget.target);
    const defect = validateOutcomeShape(result, operation);
    const finalOutcome = defect
      ? malformedOutcome(operation.toolId, operation.operationId, defect)
      : { ...result, tool_id: operation.toolId, operation_id: operation.operationId };
    await persistOperationOutcome(persistence, recordKey, intent, finalOutcome);
    return finalOutcome;
  } finally {
    IN_FLIGHT_OPERATIONS.delete(guardKey);
  }
}
