/**
 * Generic Action Registry: consequence-level declaration and dispatch
 * mechanism (ENIG Operating Model design doc, Migration path Step 3;
 * corrected per Architect's Action Registry review during Business
 * Development's manifest build -- see "The Unit Registry" /
 * "Business Development as conformance test" in the design doc).
 *
 * This is pure mechanism, proven here with a toy action set in
 * actionRegistry.test.ts -- it decides no real Unit's action list.
 * Business Development is the first real Unit wired to it
 * (businessDevelopmentManifest.ts); which of Sales, Marketing, Strategy,
 * or Finance's real actions map onto this model remains open.
 *
 * CORE PRINCIPLE (the actual fix): consequence and approval are two
 * different questions, not one.
 *   - consequence asks: does this action need managed execution state
 *     (a WorkSession it can pause and resume against)?
 *   - requiresApproval asks: does finishing this action's governed
 *     effect need Martin's explicit sign-off first?
 * WorkSession creation must never imply approval. An action can need
 * persisted state (to hold on missing evidence, wait for a reply) without
 * that state representing a privileged, externally-consequential
 * commitment. Only "write" actions (state effect: governed business
 * state, not just execution state) can ever set requiresApproval -- and
 * even then it is an explicit, per-action choice, never an automatic
 * consequence of being "write". A write that only changes an internal
 * record (no external commitment) can reasonably declare
 * requiresApproval: false.
 */

// A value import, and safe: skillRegistry.ts has no imports of its own and
// therefore no edge back to this module, so this creates no runtime cycle.
// (The erased-type rule below that motivated the old import was about
// *this* module importing Access; the Skill Registry is a leaf.)
import { SKILL_IDS, type SkillId } from "../platform/skillRegistry";

export type ConsequenceLevel = "read" | "internal" | "write";

/**
 * One exact Skill an Action requires the Worker to follow while performing
 * it.
 *
 * This is a DECLARED REQUIREMENT, not a call. The Worker resolves the Action,
 * resolves this list through the Skill Registry, and follows the resulting
 * methodology. Nothing here invokes a Skill, and a Skill never invokes
 * anything -- see skillRegistry.ts's own doc comment.
 */
export interface SkillRequirement {
  /** Exact, closed-union Skill id. Resolution is exact: no fuzzy match, no substitution, no fallback. */
  skill_id: SkillId;
}

/**
 * One exact Tool Operation an Action DECLARES it may request -- see
 * ActionDefinition.tool_operations.
 *
 * A declaration is the Action's permitted allowlist entry, nothing more. It
 * grants no permission by existing: the invocation boundary still resolves
 * the operation in the Tool Registry, resolves the Work's own Action, has
 * Access judge the effect, validates the input, and requires bound approval
 * evidence whenever this Action is approval-gated. An operation missing here
 * is refused fail-closed.
 */
export interface ActionToolOperation {
  /** The registered Tool's exact id -- e.g. "google_docs". Resolution is exact: no prefix match, no fallback. */
  tool_id: string;
  /** The registered operation's exact id -- e.g. "google_docs.create_and_verify". */
  operation_id: string;
  /**
   * Whether the Action's completion REQUIRES this operation. Required
   * entries are, by construction, part of the permitted allowlist, so
   * "every required operation must be permitted" is structural rather than a
   * separate question. Explicit true/false: omission is never a declaration.
   */
  required: boolean;
}

export interface ActionDefinition<A extends string> {
  /** The action's own registered name -- e.g. "status_check". Never invented on the spot; always one of a Unit's own declared verbs. */
  name: A;
  /**
   * The organizational Responsibility this Action is associated with -- the
   * duty owned by a Hat. Declaration only: the Action Registry records which
   * duty an operation serves, and never assigns a Hat, routes Work, or
   * becomes a second organizational hierarchy. A Hat's own registered name
   * remains the authoritative statement of which Hat owns the duty; this is
   * the operation-level restatement of it.
   */
  responsibility: string;
  /**
   * read -- no governed state mutation, no WorkSession, executes
   * immediately, never requires approval.
   * internal -- may need managed execution state (a WorkSession) and may
   * pause on an `awaiting` state for a later reply, but mutates only
   * execution/continuation state, not governed business state. Never
   * requires approval -- requiresApproval must be false here;
   * dispatchAction fails closed if it is not.
   * write -- creates or mutates governed business state. May need a
   * WorkSession the same way internal does. Whether it requires
   * approval is a separate, explicit, per-action decision (see
   * requiresApproval) -- write does not automatically mean privileged.
   */
  consequence: ConsequenceLevel;
  /**
   * THE authoritative approval requirement for this Action -- the single
   * source src/access.ts reads, per the ENIG Operating Model's Approval
   * section: "the requirement originates from the resolved action definition
   * and is resolved, not asserted."
   *
   * Only ever settable true when consequence is "write". When true, EVERY
   * governed write performed under this Action requires a matching
   * ApprovalProof. There is deliberately no per-target narrowing map:
   * `approvalGatedTargets` was removed rather than kept, because a second
   * field that could silence `requiresApproval` split one authority in two
   * and failed open whenever a manifest declared the flag but omitted the
   * list. An Action that performs un-gated execution bookkeeping (its own
   * Work's Handoff lifecycle) alongside a privileged effect must therefore
   * be declared as the operation that IS the privileged effect, with the
   * bookkeeping living on a separate Action -- which is exactly the
   * granularity Business Development already uses.
   *
   * Required (not optional): a write is not privileged by default, and an
   * Action must state which it is rather than relying on omission.
   */
  requiresApproval: boolean;
  /**
   * Exact Skills the Worker must follow while performing this Action.
   *
   * Optional: a simple Action may require no Skill, and none is forced. When
   * present, every entry is resolved through the Skill Registry by exact id
   * and validated (active status, approved version, Worker compatibility,
   * package format, package integrity) -- see `resolveActionSkills`. A Skill
   * supplies methodology only: it grants no access, authorizes no Tool, and
   * assigns no Work.
   */
  skill_requirements?: readonly SkillRequirement[];
  /**
   * The exact Tool Operations this Action DECLARES it may request -- the
   * permitted allowlist, with `required` marking the ones the Action's
   * completion needs (every required entry is an entry, so required is
   * permitted by construction). Declared here, next to the Skills the Worker
   * follows, because both are deterministic per-Action facts read from the
   * registered definition -- neither is authorization on its own: a Skill
   * grants no access, and a Tool declaration is only the allowlist half of
   * the decision the invocation boundary makes (registration + the Work's
   * own resolved Action + effect classification + Access + valid input +
   * bound ApprovalProof when this Action is approval-gated).
   *
   * Optional: an Action with no external Tool needs no declaration. When
   * present, each entry is shape-validated here and cross-checked against
   * the registered Tool Registry at registry assembly
   * (`validateActionToolDeclarations`, src/runtime/toolRegistry.ts), so a
   * declaration naming an unregistered operation fails before production
   * requests are served.
   */
  tool_operations?: readonly ActionToolOperation[];
  /**
   * THE declared deterministic applicability of this Action (ENIG
   * Operating Model, "Action Resolution"): the conditions under which this
   * Action may be resolved for a Work context. Action Resolution evaluates
   * these conditions and requires exactly one Action of the resolved
   * Hat/Responsibility to apply -- zero applicable, or more than one
   * without an explicit deterministic precedence, fails closed. Nothing
   * else selects an Action: not model similarity, not a model's
   * confidence, not "the only one left".
   *
   * Required (not optional), for the same reason requiresApproval is:
   * an Action with no declared applicability is an Action nobody may
   * resolve, and reading an omission as "always applicable" would make
   * every unanswered question a silent go-ahead.
   */
  applicability: ApplicabilityDeclaration;
  description: string;
}

/**
 * One deterministic applicability condition, evaluated against the resolved
 * Organization context or the current Work execution context -- never
 * against model output as such.
 *
 * `source: "work"` reads a field of the Work's current context
 * (`WorkContract`); `source: "organization"` reads the resolved
 * Organization (Unit/Hat/Responsibility). The only interpretation-shaped
 * field that exists today is `work.requested_action`: an intake
 * interpretation of the requested outcome (an exact Action id proposed by
 * an AI intake classification, or an id carried on a Handoff), which
 * Resolution treats as untrusted input -- it can only match a declared
 * condition exactly or fail, it is never a selection, and no condition may
 * be written against a model's similarity score or confidence.
 */
export interface ApplicabilityCondition {
  source: "work" | "organization";
  field: "origin" | "mode" | "requested_action" | "unit" | "hat" | "responsibility";
  operator: "equals" | "in";
  /** Exact value(s) -- never a pattern, never a similarity threshold. */
  value: string | readonly string[];
}

/**
 * The declared applicability of one Action: conditions combined by `mode`
 * ("all" every condition must hold; "any" at least one must hold).
 *
 * `precedence` is an explicit deterministic precedence key (lower number
 * wins). It is declared, not derived: multiple applicable Actions resolve
 * only when every applicable Action declares a distinct precedence, in
 * which case Resolution records `precedence_used` in its evidence.
 * Otherwise multiple applicable Actions fail closed.
 */
export interface ApplicabilityDeclaration {
  mode: "all" | "any";
  conditions: readonly ApplicabilityCondition[];
  precedence?: number;
}

export interface ReadActionResult {
  kind: "read";
  reply: string;
}

/**
 * Dispatch signal for both "internal" and "write" actions -- both need
 * managed execution state (a WorkSession) and route through the same
 * entry-handler/awaiting-handler machinery; they differ only in whether
 * the caller must route the entry handler's output through the approval
 * gate before finalizing the governed consequence (requiresApproval).
 * This function never executes the action itself -- it only signals the
 * caller to dispatch into the existing WorkSession/governed-execution
 * pipeline, applying the approval gate if and only if requiresApproval
 * is true.
 */
export interface ContinuableActionDispatch<A extends string> {
  kind: "continuable";
  action: A;
  consequence: "internal" | "write";
  requiresApproval: boolean;
}

export type ActionDispatchResult<A extends string> = ReadActionResult | ContinuableActionDispatch<A>;

/** Runs a resolved read action immediately and returns its reply -- no WorkSession, no approval gate. */
export type ReadActionHandler<A extends string> = (actionName: A, text: string) => Promise<string>;

export function findAction<A extends string>(
  actionName: string,
  registry: ActionDefinition<A>[],
): ActionDefinition<A> | undefined {
  return registry.find((a) => a.name === actionName);
}

/**
 * Resolves a registered action name against its declared consequence.
 * Read actions run immediately via readHandler and return their reply
 * directly -- the same low friction as Chat, just scoped to the right
 * context. Internal and write actions are never executed here; this
 * returns a dispatch signal for the caller to route into the existing
 * WorkSession/governed-execution pipeline, applying the approval gate
 * only when requiresApproval is true.
 *
 * Fails closed:
 *   - an action name not found in the registry returns null -- never
 *     guessed at or silently treated as any consequence level.
 *   - an "internal" action that declares requiresApproval: true throws --
 *     that combination violates the core principle (internal state never
 *     gates on approval) and must never be silently downgraded to a
 *     no-op approval or silently upgraded to gating anyway.
 */
export async function dispatchAction<A extends string>(
  actionName: string,
  text: string,
  registry: ActionDefinition<A>[],
  readHandler: ReadActionHandler<A>,
): Promise<ActionDispatchResult<A> | null> {
  const def = findAction(actionName, registry);
  if (!def) {
    return null;
  }

  if (def.consequence === "read") {
    const reply = await readHandler(def.name, text);
    return { kind: "read", reply };
  }

  if (def.consequence === "internal" && def.requiresApproval) {
    throw new Error(
      `${def.name}: declared consequence "internal" but requiresApproval is true -- internal actions mutate execution state only and must never gate on approval.`,
    );
  }

  return { kind: "continuable", action: def.name, consequence: def.consequence, requiresApproval: def.requiresApproval };
}

/**
 * Validates one registered Action definition in isolation.
 *
 * Fail-closed manifest completeness applies to an Action's own shape too: an
 * Action that cannot state its Responsibility, its consequence, or its
 * approval requirement unambiguously is an invalid Action, and a Kernel that
 * silently accepted one would be reading a guess as a declaration. Returns
 * the reason string on failure, or null when the definition is well-formed.
 *
 * Deliberately NOT checked here: whether a Hat is allowed to declare a given
 * consequence or approval requirement. That is a governance question about
 * the Unit's organizational model, not a shape question about one object.
 */
export function validateActionDefinition(action: ActionDefinition<string>): string | null {
  if (!action.name || !action.name.trim()) return "an Action must have a non-empty registered name";
  if (!action.responsibility || !action.responsibility.trim()) {
    return `${action.name}: an Action must declare the organizational Responsibility it serves`;
  }
  if (!CONSEQUENCE_LEVELS.includes(action.consequence)) {
    return `${action.name}: unknown consequence "${String(action.consequence)}"`;
  }
  if (typeof action.requiresApproval !== "boolean") {
    return `${action.name}: requiresApproval must be stated explicitly as true or false -- omission is never a declaration`;
  }
  if (action.consequence === "read" && action.requiresApproval) {
    return `${action.name}: declared consequence "read" but requiresApproval is true -- a read has no governed effect to approve`;
  }
  if (action.consequence === "internal" && action.requiresApproval) {
    return `${action.name}: declared consequence "internal" but requiresApproval is true -- internal actions mutate execution state only and must never gate on approval`;
  }
  for (const requirement of action.skill_requirements ?? []) {
    if (!SKILL_IDS.includes(requirement.skill_id)) {
      return `${action.name}: declares an unknown Skill id "${String(requirement.skill_id)}" -- Skill requirements resolve by exact id only`;
    }
  }
  const declaredToolOperations = new Set<string>();
  for (const declaration of action.tool_operations ?? []) {
    if (typeof declaration?.tool_id !== "string" || !declaration.tool_id.trim()) {
      return `${action.name}: a declared Tool operation must carry a non-empty tool id -- omission is never "any Tool"`;
    }
    if (typeof declaration.operation_id !== "string" || !declaration.operation_id.trim()) {
      return `${action.name}: a declared Tool operation must carry a non-empty operation id -- omission is never "any operation"`;
    }
    if (typeof declaration.required !== "boolean") {
      return `${action.name}: declared Tool operation ${declaration.tool_id}.${declaration.operation_id} must state "required" explicitly -- omission is never a declaration`;
    }
    const key = `${declaration.tool_id}.${declaration.operation_id}`;
    if (declaredToolOperations.has(key)) {
      return `${action.name}: declares Tool operation ${key} more than once -- a declaration is stated exactly once`;
    }
    declaredToolOperations.add(key);
  }
  const applicabilityDefect = validateApplicability(action.name, action.applicability);
  if (applicabilityDefect) return applicabilityDefect;
  return null;
}

/**
 * Shape validation for one declared applicability (deliberately after the
 * Responsibility/consequence/approval/Skill checks above: an Action that is
 * wrong about *what it serves* must fail on that first).
 *
 * Fail-closed: a missing declaration, an empty condition list, an unknown
 * source/field/operator, or a non-exact value is a malformed Action -- the
 * Kernel must not resolve an applicability question it cannot read as
 * declared.
 */
function validateApplicability(actionName: string, declaration: ApplicabilityDeclaration | undefined): string | null {
  if (!declaration) {
    return `${actionName}: an Action must declare its deterministic applicability conditions -- omission is never "always applicable"`;
  }
  if (declaration.mode !== "all" && declaration.mode !== "any") {
    return `${actionName}: applicability mode must be "all" or "any", got "${String(declaration.mode)}"`;
  }
  if (!Array.isArray(declaration.conditions) || declaration.conditions.length === 0) {
    return `${actionName}: applicability must declare at least one condition`;
  }
  if (declaration.precedence !== undefined && !Number.isFinite(declaration.precedence)) {
    return `${actionName}: applicability precedence must be a finite number when declared`;
  }
  for (const condition of declaration.conditions) {
    if (!APPLICABILITY_SOURCES.includes(condition.source)) {
      return `${actionName}: unknown applicability source "${String(condition.source)}"`;
    }
    if (!APPLICABILITY_FIELDS.includes(condition.field)) {
      return `${actionName}: unknown applicability field "${String(condition.field)}"`;
    }
    if (condition.operator !== "equals" && condition.operator !== "in") {
      return `${actionName}: unknown applicability operator "${String(condition.operator)}"`;
    }
    const values: readonly unknown[] = Array.isArray(condition.value) ? condition.value : [condition.value];
    if (values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
      return `${actionName}: an applicability condition must carry a non-empty exact value`;
    }
    if (condition.operator === "in" && !Array.isArray(condition.value)) {
      return `${actionName}: operator "in" requires an array of exact values`;
    }
    if (condition.operator === "equals" && Array.isArray(condition.value)) {
      return `${actionName}: operator "equals" requires a single exact value`;
    }
  }
  return null;
}

const CONSEQUENCE_LEVELS: readonly ConsequenceLevel[] = ["read", "internal", "write"];

/** The sources/fields an applicability condition may read -- a closed set, so a typo fails closed instead of never matching. */
const APPLICABILITY_SOURCES: readonly ApplicabilityCondition["source"][] = ["work", "organization"];
const APPLICABILITY_FIELDS: readonly ApplicabilityCondition["field"][] = [
  "origin",
  "mode",
  "requested_action",
  "unit",
  "hat",
  "responsibility",
];
