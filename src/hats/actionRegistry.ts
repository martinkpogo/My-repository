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

export type ConsequenceLevel = "read" | "internal" | "write";

export interface ActionDefinition<A extends string> {
  /** The action's own registered name -- e.g. "status_check". Never invented on the spot; always one of a Unit's own declared verbs. */
  name: A;
  /**
   * read -- no governed state mutation, no WorkSession, executes
   * immediately, never requires approval.
   * internal -- may need managed execution state (a WorkSession) and may
   * pause on an `awaiting` state for a later reply, but mutates only
   * execution/continuation state, not governed business state. Never
   * requires approval -- requiresApproval must be false/omitted here;
   * dispatchAction fails closed if it is not.
   * write -- creates or mutates governed business state. May need a
   * WorkSession the same way internal does. Whether it requires
   * approval is a separate, explicit, per-action decision (see
   * requiresApproval) -- write does not automatically mean privileged.
   */
  consequence: ConsequenceLevel;
  /**
   * Only ever meaningful (and only ever settable true) when consequence
   * is "write" -- an action whose governed effect is privileged enough
   * to need Martin's sign-off before it is considered final. Must be
   * false or omitted for "read"/"internal"; dispatchAction fails closed
   * if an "internal" action declares it true. Defaults to false when
   * omitted on a "write" action -- a write is not privileged by default,
   * it is privileged only when explicitly declared so.
   */
  requiresApproval?: boolean;
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

  return { kind: "continuable", action: def.name, consequence: def.consequence, requiresApproval: def.requiresApproval ?? false };
}
