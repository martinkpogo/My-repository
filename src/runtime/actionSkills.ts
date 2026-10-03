import type { ActionDefinition } from "../hats/actionRegistry";
import type { HatManifest } from "../units/unitManifest";
import {
  createResolvedActionSkillSet,
  resolveActionSkills,
  resolveSkill,
  SkillResolutionError,
  verifySkillIntegrity,
  type ResolvedActionSkillSet,
} from "../platform/skillRegistry";
import type { ResolvedActionSkill } from "./actionResolution";

/**
 * The generic Action -> Skill -> execution boundary.
 *
 * Action Resolution (actionResolution.ts) resolves an Action's declared Skills
 * and carries them on the Resolved Action Execution Context. This module is
 * where execution CONSUMES them: it turns what resolution produced into the
 * `ResolvedActionSkillSet` every Hat handler receives, so that a handler never
 * looks Skill content up for itself.
 *
 * Nothing here knows about any Unit, Hat or Skill by name. It does not grant
 * access, authorize a Tool, assign Work or satisfy an approval -- Access owns
 * all of that; a Skill is methodology only.
 *
 * Two entry points, one rule (a Skill reaches a handler only if the Action
 * declared it AND the Registry verified it):
 *  - bindExecutionSkills: the Skills carried on an execution context, checked
 *    against the Action's declaration and re-verified against the Registry at
 *    the point of use, because the context crosses the router -> Worker
 *    boundary and the Worker consumes rather than trusts it.
 *  - resolveRecordedActionSkills: for execution that RESUMES a Work (an
 *    awaiting reply) and so has no execution context, only the Action the
 *    Work already recorded; resolved through the same Registry path.
 *
 * Both fail closed (SkillResolutionError) before any handler runs.
 */

/**
 * Binds the Skills carried on a resolved execution context to the Action's own
 * declaration. Fails closed when the carried set is not exactly the declared
 * set, or when any carried Skill is not the Registry's own verified content.
 */
export async function bindExecutionSkills(
  carried: readonly ResolvedActionSkill[],
  action: Pick<ActionDefinition<string>, "name" | "skill_requirements">,
): Promise<ResolvedActionSkillSet> {
  const declared = (action.skill_requirements ?? []).map((requirement) => requirement.skill_id);
  const carriedIds = carried.map((skill) => skill.skill_id);
  const sameSet = declared.length === carriedIds.length && declared.every((id) => carriedIds.includes(id)) && new Set(carriedIds).size === carriedIds.length;
  if (!sameSet) {
    throw new SkillResolutionError(
      `Action "${action.name}" declares Skills [${declared.join(", ")}] but its execution context carries [${carriedIds.join(", ")}] -- refusing to run with a different Skill set than the Action declared`,
    );
  }

  const verified = [];
  for (const skill of carried) {
    const registered = resolveSkill(skill.skill_id);
    await verifySkillIntegrity(skill.skill_id);
    if (skill.resolved_version !== registered.version || skill.content !== registered.content) {
      throw new SkillResolutionError(`Skill "${skill.skill_id}" carried on the execution context is not the Registry's verified package -- refusing to follow it`);
    }
    verified.push(registered);
  }
  return createResolvedActionSkillSet(verified);
}

/**
 * Resolves, through the Registry, the Skills declared by the Action a Work has
 * ALREADY recorded. For execution that resumes a Work and so carries no
 * execution context. An unrecorded or undeclared Action yields the empty set:
 * nothing is inferred, and a handler asking for a Skill then fails closed.
 */
export async function resolveRecordedActionSkills(hat: Pick<HatManifest, "actions">, actionName: string | undefined): Promise<ResolvedActionSkillSet> {
  const action = actionName ? hat.actions.find((a) => a.name === actionName) : undefined;
  return createResolvedActionSkillSet(await resolveActionSkills(action?.skill_requirements ?? []));
}

/** The outcome of running a handler under a recorded Action's Skills. */
export type RecordedSkillRun<T> = { kind: "ran"; result: T } | { kind: "refused"; reason: string };

/**
 * Runs a handler for Work that ALREADY has a recorded Action -- a resumed
 * awaiting reply, or a Handoff pickup -- under that Action's declared Skills.
 * The Skills are resolved through `resolveRecordedActionSkills` (the Registry,
 * integrity-verified); this adds no resolution of its own and selects no
 * Action. If they cannot be resolved the handler is NEVER invoked and the run
 * is `refused`. Errors the handler itself throws are not caught here.
 */
export async function runWithRecordedActionSkills<T>(
  hat: Pick<HatManifest, "actions">,
  actionName: string | undefined,
  run: (skills: ResolvedActionSkillSet) => Promise<T>,
): Promise<RecordedSkillRun<T>> {
  let skills: ResolvedActionSkillSet;
  try {
    skills = await resolveRecordedActionSkills(hat, actionName);
  } catch (err) {
    if (!(err instanceof SkillResolutionError)) throw err;
    return { kind: "refused", reason: err.reason };
  }
  return { kind: "ran", result: await run(skills) };
}
