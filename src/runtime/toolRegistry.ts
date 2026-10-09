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
 *   Access authorization (the Work's own resolved Action) -> retry-safety /
 *   reconciliation -> the registered handler -> outcome validation --
 *
 * and every step fails closed: an unknown Tool or operation, an undeclared
 * Action-to-Tool combination, invalid input, an unresolvable target, a
 * denial, or a malformed outcome can never become a request. The five outcome
 * states are the canonical ones: succeeded, failed, partially_completed,
 * unverified, denied. A denial is the DENIED OUTCOME (the Access boundary's
 * AccessDeniedError is caught and reported here) -- it is never converted
 * into a failure or any other state.
 *
 * Two invariants this boundary exists to keep:
 *   - a Tool's availability, a Skill, or a caller-supplied approval grants
 *     NOTHING: authorization comes only from the registered declarations and
 *     trusted execution state, and OAuth credentials are never consulted
 *     here (authentication is not ENIG authorization);
 *   - an uncertain remote effect is never blindly retried: a prior
 *     `partially_completed`/`unverified` outcome must be reconciled by the
 *     operation's own reconciliation step before another creation may start,
 *     and an uncertain outcome with nothing to reconcile refuses outright.
 *
 * Registration is static and code-owned (initial implementation boundary):
 * TOOL_OPERATIONS below is the only table, so no caller can register, select
 * or substitute a handler -- `invokeTool` names an id, never a function.
 */
import type { Env } from "../types";
import type { AccessContext } from "../access";
import { AccessDeniedError, evaluateExternalMutationAccess } from "../access";
import type { ActionDefinition } from "../hats/actionRegistry";
import { googleDocsToolOperation } from "./tools/googleDocsTool";

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
   * The outcome of a previous attempt at this same operation, when the caller
   * has one. Required by the boundary's retry safety: a prior uncertain
   * outcome is reconciled before anything new may run, and a malformed prior
   * outcome refuses outright.
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
const TOOL_OPERATIONS: readonly ToolOperationDefinition[] = [googleDocsToolOperation];

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
        return `action "${action.name}" declares Tool operation ${declaration.tool_id}.${declaration.operation_id}, which is not registered in the Tool Registry -- a declaration may name only an exact registered operation`;
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

  // 4. Retry safety -- after authorization, before anything that could act
  //    remotely. A prior uncertain outcome is reconciled first; creation is
  //    never repeated blindly.
  const prior = request.prior_outcome;
  if (prior !== undefined) {
    if (typeof prior !== "object" || prior === null || !isToolOutcomeState(prior.state) || prior.tool_id !== operation.toolId || prior.operation_id !== operation.operationId) {
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
      if (!operation.reconcile) {
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
        if (defect) return malformedOutcome(operation.toolId, operation.operationId, defect);
        return { ...outcome, tool_id: operation.toolId, operation_id: operation.operationId };
      }
      // Reconciliation established that no remote effect exists: a fresh
      // creation may proceed. A prior `failed`/`denied` outcome likewise
      // carried no remote effect and falls through to the same place.
    }
  }

  // 5. The registered handler, then contract validation of what it returned.
  const result = await operation.run(env, request.input, resolvedTarget.target);
  const defect = validateOutcomeShape(result, operation);
  if (defect) return malformedOutcome(operation.toolId, operation.operationId, defect);
  return result;
}
