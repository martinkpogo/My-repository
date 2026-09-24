/**
 * Generic Action Registry: consequence-level declaration and dispatch
 * mechanism (ENIG Operating Model design doc, Migration path Step 3).
 *
 * This is pure mechanism, proven here with a toy action set in
 * actionRegistry.test.ts -- it decides no real Unit's action list and is
 * not wired into router.ts/dispatchCowork for any Unit. Which of Sales,
 * Marketing, Strategy, or Finance's real actions are read vs. write
 * remains an open product decision (see docs/enig-operating-model.md's
 * Open questions); a Unit adopts this by registering its own
 * ActionDefinition<A>[] and a read handler once that decision is made,
 * the same way Marketing adopted the generic Stage 1/2 classification
 * mechanics in intakeClassification.ts/relationships.ts rather than each
 * Unit reimplementing its own version.
 */

export type ConsequenceLevel = "read" | "write";

export interface ActionDefinition<A extends string> {
  /** The action's own registered name -- e.g. "status_check". Never invented on the spot; always one of a Unit's own declared verbs. */
  name: A;
  /**
   * Read -- no side effects (a status check, an explanation, a lookup).
   * Runs immediately via the read handler, no WorkSession created, no
   * approval gate.
   * Write -- creates or mutates governed state. Goes through the
   * existing full pipeline, unchanged: WorkSession, governed execution,
   * approval gate. This function never executes a write itself -- it
   * only signals the caller to dispatch into that existing pipeline.
   */
  consequence: ConsequenceLevel;
  description: string;
}

export interface ReadActionResult {
  kind: "read";
  reply: string;
}

export interface WriteActionDispatch<A extends string> {
  kind: "write";
  action: A;
}

export type ActionDispatchResult<A extends string> = ReadActionResult | WriteActionDispatch<A>;

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
 * context. Write actions are never executed here; this returns a
 * dispatch signal for the caller to route into the existing
 * WorkSession/governed-execution/approval pipeline, unchanged.
 *
 * Fails closed: an action name not found in the registry returns null --
 * never guessed at or silently treated as either consequence level.
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

  return { kind: "write", action: def.name };
}
