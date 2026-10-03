import type { ConsequenceLevel, ApplicabilityCondition, ApplicabilityDeclaration } from "../hats/actionRegistry";
import type { HatManifest, UnitManifest } from "../units/unitManifest";
import {
  resolveActionSkills,
  SkillResolutionError,
  type SkillId,
} from "../platform/skillRegistry";
import type { OrganizationContext } from "./organization";
import type { WorkContract, WorkMode, WorkOrigin } from "./workContract";

/**
 * Deterministic Action Resolution and the resolved Action Execution
 * Context (ENIG Operating Model, current architecture: Action Resolution
 * evaluates ONLY the current Work execution context, the resolved
 * Responsibility, the manifest-exposed Actions, and each Action's declared
 * applicability conditions -- and requires exactly one applicable Action).
 *
 * Evaluation is pure: given the same Work context, the same resolved
 * Organization and the same manifest it always produces the same Action,
 * with its evidence. No AI provider call happens here. Where the Work
 * context alone cannot distinguish the Action (a Unit whose Actions differ
 * only by what the requester asked for), the caller supplies an intake
 * interpretation (`current_context.requested_action`) as untrusted input
 * -- it may match a declared condition exactly or it may fail; it is never
 * itself the selection, never a similarity score, and never a fallback.
 *
 * Fail-closed, without exception: zero applicable Actions, more than one
 * applicable Action without an explicit declared precedence, an Action not
 * exposed by this Hat, an Action whose declared Responsibility is not the
 * resolved one, a missing/invalid required Skill.
 */

/** One condition, evaluated -- the evidence records the actual value it was tested against. */
export interface EvaluatedCondition {
  action: string;
  condition: ApplicabilityCondition;
  /** The runtime value the condition was tested against; null when the field is absent in this context. */
  actual: string | null;
  result: boolean;
}

export interface ActionResolutionEvidence {
  /** The resolved Responsibility this Action serves. */
  responsibility: string;
  manifest: { unit: string; hat: string };
  /**
   * No canonical manifest version source exists in this repository (the
   * Unit Manifest has no version field, and Notion's is not readable from
   * here). Null rather than an invented number -- see Known gaps.
   */
  manifest_version: string | null;
  /** Every applicability condition evaluated, in manifest order, with its actual value and result. */
  evaluated_conditions: EvaluatedCondition[];
  /** Action name -> applicable, for every Action the resolved Hat exposes. */
  results: Record<string, boolean>;
  /** Set only when several Actions were applicable and an explicit declared precedence decided between them; null when resolution was "exactly one applicable". */
  precedence_used: string | null;
  resolved_action: string;
  /** As above: no canonical Action version source exists here. */
  resolved_action_version: string | null;
}

/** One resolved Skill, with the validations resolution performed on it. */
export interface ResolvedActionSkill {
  skill_id: SkillId;
  resolved_version: string;
  /** null: Skills in this repository are bundled content, not a package fetched from a location. */
  package_location: string | null;
  /** "compatible" only because resolution threw otherwise (package format + Worker runtime approval). */
  compatibility_status: "compatible";
  /** "verified" only because resolution threw otherwise (SHA-256 against the registered digest). */
  integrity_status: "verified";
}

/**
 * The Resolved Action Execution Context -- the handoff point between
 * Resolution and execution. Built once, at Resolution, and CONSUMED by
 * WorkSession/Worker; execution does not re-derive Unit, Hat,
 * Responsibility, Action or Skills from it.
 *
 * Deliberately in-memory (a parameter crossing router -> WorkSession, and
 * held on the Work while its entry Action runs): persisted Work state
 * carries `unit`/`hat`/`actionName` for Access and lifecycle, and a second
 * persisted copy of this context would go stale the moment the Work's
 * lifecycle advanced to a different Action.
 */
export interface ActionExecutionContext {
  work_id: string | null;
  action: {
    action_id: string;
    version: string | null;
    responsibility: string;
    consequence: ConsequenceLevel;
    requires_approval: boolean;
    definition_source: "unit_manifest";
  };
  organization: OrganizationContext;
  inputs: {
    requested_outcome: string;
    /** null when no intake interpretation was consulted for this resolution. */
    requested_action: string | null;
    origin: WorkOrigin;
    mode: WorkMode;
  };
  skills: ResolvedActionSkill[];
  /**
   * The Access identity this execution runs under -- a RECORD of what
   * src/access.ts resolves from persisted Work state, never a grant and
   * never read by Access (WorkState.actionName remains the sole Access
   * authority, PR #221).
   */
  access_context: { kind: "work_session"; unit: string; hat: string; action: string };
  /** No Action in this repository declares entry preconditions yet. */
  preconditions: null;
  /** Resolved from the Action definition: whether this Action's effect needs Martin's sign-off. Clearance itself stays with Access/approval. */
  approval_state: { required: boolean };
  /** Not declared by any Action yet. */
  expected_result: null;
  /** Not declared by any Action yet. */
  completion_criteria: null;
  /** Data Boundary classification is resolved per AI task at execution time (src/dataBoundary/policy.ts), not per Action. */
  data_context: null;
  /** No Tool registry exists in this repository. */
  tool_context: null;
  evidence: ActionResolutionEvidence;
}

export type ActionFailureReason =
  | "missing_manifest"
  | "hat_not_declared"
  | "responsibility_mismatch"
  | "undeclared_action"
  | "zero_applicable"
  | "multiple_applicable"
  | "skill_resolution_failed";

export type ActionResolution =
  | { kind: "resolved"; execution: ActionExecutionContext }
  /** Zero applicable, the Work context cannot decide alone, and some Action declares a `requested_action` condition: an intake interpretation is required before this can resolve. */
  | { kind: "need_interpretation" }
  | { kind: "failed"; reason: ActionFailureReason; detail: string };

/**
 * Resolves exactly one Action for a Work entry, or fails closed.
 *
 * Interpretation state is read from `contract.current_context.requested_action`:
 * `undefined` means no intake interpretation has been attempted yet (Resolution
 * may then return `need_interpretation`), `null` means one was attempted and
 * yielded nothing usable, a string is the proposed exact Action id.
 */
export async function resolveActionExecution(
  manifest: UnitManifest | undefined,
  organization: OrganizationContext,
  contract: WorkContract,
): Promise<ActionResolution> {
  const requestedAction = contract.current_context.requested_action;
  if (!manifest) {
    return { kind: "failed", reason: "missing_manifest", detail: "no manifest was supplied for this resolution" };
  }
  const hat: HatManifest | undefined = manifest.hats[organization.hat];
  if (!hat) {
    return {
      kind: "failed",
      reason: "hat_not_declared",
      detail: `${manifest.unit} declares no Hat "${organization.hat}" -- the resolved Organization cannot be matched to a manifest-exposed Hat`,
    };
  }
  if (hat.responsibilityId !== organization.responsibility) {
    return {
      kind: "failed",
      reason: "responsibility_mismatch",
      detail: `resolved Responsibility "${organization.responsibility}" is not ${manifest.unit}/${hat.name}'s own ("${hat.responsibilityId}")`,
    };
  }

  const contextValues = {
    origin: contract.current_context.origin,
    mode: contract.current_context.mode,
    requested_action: contract.current_context.requested_action ?? null,
    unit: organization.unit,
    hat: organization.hat,
    responsibility: organization.responsibility,
  };

  const evaluatedConditions: EvaluatedCondition[] = [];
  const results: Record<string, boolean> = {};
  const applicable: (typeof hat.actions)[number][] = [];
  let declaresRequestedActionCondition = false;
  let conditionallyApplicableWithResponsibilityMismatch = false;

  for (const action of hat.actions) {
    const declaration: ApplicabilityDeclaration = action.applicability;
    if (declaration.conditions.some((condition) => condition.field === "requested_action")) {
      declaresRequestedActionCondition = true;
    }
    const responsibilityMismatch = action.responsibility !== organization.responsibility;
    const perCondition = declaration.conditions.map((condition) => {
      const actual = contextValues[condition.field] ?? null;
      const result = evaluateCondition(condition, actual);
      evaluatedConditions.push({ action: action.name, condition, actual, result });
      return result;
    });
    const conditionsHold = declaration.mode === "all" ? perCondition.every(Boolean) : perCondition.some(Boolean);
    const isApplicable = conditionsHold && !responsibilityMismatch;
    results[action.name] = isApplicable;
    if (conditionsHold && responsibilityMismatch) {
      conditionallyApplicableWithResponsibilityMismatch = true;
    }
    if (isApplicable) applicable.push(action);
  }

  if (applicable.length === 1) {
    return finalize(manifest, hat, organization, contract, applicable[0], evaluatedConditions, results, null);
  }

  if (applicable.length > 1) {
    const declared = applicable.map((action) => action.applicability.precedence);
    const allDeclared = declared.every((value) => typeof value === "number" && Number.isFinite(value));
    const distinct = new Set(declared).size === declared.length;
    if (allDeclared && distinct) {
      const winner = applicable.reduce((best, action) =>
        (action.applicability.precedence ?? Infinity) < (best.applicability.precedence ?? Infinity) ? action : best,
      );
      return finalize(
        manifest,
        hat,
        organization,
        contract,
        winner,
        evaluatedConditions,
        results,
        `declared precedence ${String(winner.applicability.precedence)}`,
      );
    }
    return {
      kind: "failed",
      reason: "multiple_applicable",
      detail: `${applicable.length} of ${hat.name}'s declared Actions apply to this Work context (${applicable.map((action) => action.name).join(", ")}) and no explicit precedence distinguishes them -- resolution requires exactly one`,
    };
  }

  // Zero applicable.
  if (requestedAction !== undefined && requestedAction !== null) {
    const named = hat.actions.find((action) => action.name === requestedAction);
    if (!named) {
      return {
        kind: "failed",
        reason: "undeclared_action",
        detail: `"${requestedAction}" is not an Action ${manifest.unit}/${hat.name} exposes -- resolution only ever resolves manifest-exposed Actions`,
      };
    }
    if (named.responsibility !== organization.responsibility) {
      return {
        kind: "failed",
        reason: "responsibility_mismatch",
        detail: `Action "${named.name}" serves Responsibility "${named.responsibility}", not the resolved Responsibility "${organization.responsibility}"`,
      };
    }
  }

  if (requestedAction === undefined && declaresRequestedActionCondition) {
    return { kind: "need_interpretation" };
  }

  return {
    kind: "failed",
    reason: conditionallyApplicableWithResponsibilityMismatch ? "responsibility_mismatch" : "zero_applicable",
    detail: conditionallyApplicableWithResponsibilityMismatch
      ? `the only Actions matching this Work context serve a different Responsibility than the resolved one ("${organization.responsibility}")`
      : `no declared Action of ${manifest.unit}/${hat.name} is applicable to this Work context (origin "${contextValues.origin}", mode "${contextValues.mode}") -- resolution fails closed rather than picking one`,
  };
}

function evaluateCondition(condition: ApplicabilityCondition, actual: string | null): boolean {
  if (actual === null || actual === "") return false;
  if (condition.operator === "equals") return actual === condition.value;
  return (condition.value as readonly string[]).includes(actual);
}

async function finalize(
  manifest: UnitManifest,
  hat: HatManifest,
  organization: OrganizationContext,
  contract: WorkContract,
  action: (typeof hat.actions)[number],
  evaluatedConditions: EvaluatedCondition[],
  results: Record<string, boolean>,
  precedenceUsed: string | null,
): Promise<ActionResolution> {
  let skills: ResolvedActionSkill[];
  try {
    const resolved = await resolveActionSkills(action.skill_requirements ?? []);
    skills = resolved.map((skill) => ({
      skill_id: skill.id,
      resolved_version: skill.version,
      package_location: null,
      compatibility_status: "compatible" as const,
      integrity_status: "verified" as const,
    }));
  } catch (err) {
    if (err instanceof SkillResolutionError) {
      return { kind: "failed", reason: "skill_resolution_failed", detail: err.reason };
    }
    throw err;
  }

  return {
    kind: "resolved",
    execution: {
      work_id: null,
      action: {
        action_id: action.name,
        version: null,
        responsibility: action.responsibility,
        consequence: action.consequence,
        requires_approval: action.requiresApproval,
        definition_source: "unit_manifest",
      },
      organization,
      inputs: {
        requested_outcome: contract.requested_outcome,
        requested_action: contract.current_context.requested_action ?? null,
        origin: contract.current_context.origin,
        mode: contract.current_context.mode,
      },
      skills,
      access_context: {
        kind: "work_session",
        unit: organization.unit,
        hat: organization.hat,
        action: action.name,
      },
      preconditions: null,
      approval_state: { required: action.requiresApproval },
      expected_result: null,
      completion_criteria: null,
      data_context: null,
      tool_context: null,
      evidence: {
        responsibility: organization.responsibility,
        manifest: { unit: manifest.unit, hat: hat.name },
        manifest_version: null,
        evaluated_conditions: evaluatedConditions,
        results,
        precedence_used: precedenceUsed,
        resolved_action: action.name,
        resolved_action_version: null,
      },
    },
  };
}
