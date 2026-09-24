import type { Env, Unit, WorkState } from "../types";
import type { ActionDefinition, ConsequenceLevel } from "../hats/actionRegistry";

/**
 * Generic Unit Manifest contract (ENIG Operating Model design doc, "The
 * Unit Registry" section) -- draft, not yet wired into any of the three
 * chokepoints it is meant to replace (dispatchCowork, WorkSession,
 * handleTextReply). Per the design doc's "don't design the final schema
 * up front" guidance, this shape is deliberately built against Business
 * Development's real, already-defined actions
 * (businessDevelopmentManifest.ts) rather than invented in the abstract --
 * expect it to change once BD's manifest is actually exercised end to end.
 *
 * Action lists are scoped per Hat, not flattened across the whole Unit:
 * BD's own three Hats each declare a `determine_next_move`,
 * `handoff_to_sales`, and `handoff_to_strategy` action with the same
 * name and different handlers, matching Marketing's existing two-stage
 * resolution (Stage 1 picks the Hat, Stage 2 picks the action within
 * that Hat's own declared list -- see "The Action Registry" in the
 * design doc). A Unit-wide flat action list would silently collide on
 * these; per-Hat scoping is a manifest-shape requirement, not a
 * BD-specific detail.
 *
 * The manifest declares Unit-specific facts (what Hats/actions exist,
 * what they consequence-level as, which handler runs them). It must
 * never declare kernel behaviour (how approval, WorkSession creation, or
 * Handoff enforcement work) -- those stay owned by the shared runtime.
 * See the design doc's "hard invariant."
 *
 * Consequence vs. approval (per Architect's Action Registry correction):
 * "internal" and "write" actions both route through the same
 * entryHandler/awaitingHandlers machinery below -- both need managed
 * execution state (a WorkSession), and the manifest does not declare two
 * separate handler shapes for them. What differs is whether the kernel
 * gates the entry handler's output on Martin's approval before finalizing
 * it (requiresApproval, declared per action in actionRegistry.ts) --
 * WorkSession creation itself never implies approval. A "read" action
 * never reaches entryHandler at all; it only ever runs readHandler.
 */
export type EntryHandler<A extends string = string> = (env: Env, state: WorkState, actionName: A, text: string) => Promise<WorkState>;

/** Resumes a WorkSession left paused on one of this Hat's own `awaiting` states. */
export type AwaitingStateHandler = (env: Env, state: WorkState, text: string) => Promise<WorkState>;

export interface HatManifest<A extends string = string> {
  /** Matches this Hat's HatIdentity.name in src/hats/registry.ts -- not duplicated, only referenced. */
  name: string;

  /**
   * This Hat's single responsibility statement -- lifted directly from
   * its Notion Hat Definition's Purpose/Core responsibility text, not
   * invented here. Deliberately one statement covering the whole action
   * list, not a per-action or many-to-many structure: every Hat drafted
   * so far (all three of BD's) has exactly one responsibility spanning
   * all of its actions, so a many-to-many shape would be designed
   * against a case with no real evidence yet. Exists to give the future
   * action-resolution AI task real framing ("this Hat is responsible
   * for X; here are its actions") instead of a bare list of verbs --
   * declarative Unit-specific fact, not kernel behaviour.
   */
  responsibility: string;

  /** This Hat's full action list, each declaring its own read/write consequence. Fail-closed: an action referenced anywhere but missing here is never guessed at. */
  actions: ActionDefinition<A>[];

  /** Runs a read action immediately -- no WorkSession, no approval gate. Every action.name with consequence "read" must have a case here; missing one fails closed, never falls through. */
  readHandler: (env: Env, actionName: A, text: string) => Promise<string>;

  /**
   * Starts/continues managed execution for an "internal" or "write"
   * action -- both route here, since both need a WorkSession. Every
   * action.name with consequence "internal" or "write" must reach this;
   * it decides internally what to do per action. Whether the kernel then
   * gates the result on approval is decided by the action's own
   * requiresApproval, not by this handler.
   */
  entryHandler: EntryHandler<A>;

  /**
   * This Hat's own `awaiting` states, keyed exactly as `state.awaiting` is set when a WorkSession pauses for a reply.
   * Empty if the Hat has no multi-turn flows. A state referenced in `state.awaiting` but missing here fails closed
   * (per the design doc's fail-closed manifest completeness) rather than falling through to legacy handleTextReply behaviour.
   */
  awaitingHandlers: Record<string, AwaitingStateHandler>;
}

export interface UnitManifest {
  unit: Unit;

  /**
   * This Unit's Hats, keyed by HatIdentity.name. Each Hat's action union
   * is its own type (HatManifest<A>), so storing heterogeneous Hats in
   * one Unit-wide map necessarily erases that to `any` here -- the same
   * type-erasure boundary a plugin registry always needs where callers
   * resolve a specific Hat first (narrowing back to its own A) before
   * touching its actions, matching how dispatch actually works: Hat
   * resolution happens before action resolution, never the two at once.
   */
  hats: Record<string, HatManifest<any>>;
}

export function findHatManifest(hatName: string | undefined, manifest: UnitManifest): HatManifest | undefined {
  if (!hatName) return undefined;
  return manifest.hats[hatName];
}

export function findManifestAction<A extends string>(
  actionName: string,
  hat: HatManifest<A>,
): ActionDefinition<A> | undefined {
  return hat.actions.find((a) => a.name === actionName);
}

/** Consequence lookup convenience -- undefined means the action is not declared on this Hat at all (fail closed at the caller). */
export function actionConsequence<A extends string>(actionName: string, hat: HatManifest<A>): ConsequenceLevel | undefined {
  return findManifestAction(actionName, hat)?.consequence;
}
