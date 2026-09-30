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
  description: string;
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
  return null;
}

const CONSEQUENCE_LEVELS: readonly ConsequenceLevel[] = ["read", "internal", "write"];
