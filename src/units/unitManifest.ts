import type { Env, Unit, WorkState } from "../types";
import type { ActionDefinition, ConsequenceLevel } from "../hats/actionRegistry";
import { validateActionDefinition } from "../hats/actionRegistry";
import type { RelationshipDefinition } from "../hats/relationships";
import type { SemanticTaskId } from "../dataBoundary/types";
import type { ResolvedActionSkillSet } from "../platform/skillRegistry";

/**
 * Generic Unit Manifest contract (ENIG Operating Model design doc, "The
 * Unit Registry" section) -- wired into all three chokepoints it was
 * built to replace (dispatchCowork, WorkSession, handleTextReply). Per
 * the design doc's "don't design the final schema up front" guidance,
 * this shape was deliberately built against Business Development's real,
 * already-defined actions (businessDevelopmentManifest.ts) rather than
 * invented in the abstract.
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
export type EntryHandler<A extends string = string> = (
  env: Env,
  state: WorkState,
  actionName: A,
  text: string,
  /** The Skills this Action declared, resolved and integrity-verified by the Registry. A handler follows these and never looks Skill content up itself. Empty for an Action that declares none. */
  skills: ResolvedActionSkillSet,
) => Promise<WorkState>;

/**
 * A Handoff-specific pickup executor for Work whose Action was already
 * resolved and recorded from the Handoff's destination facts. Not an
 * EntryHandler: it reconstructs Handoff context first. It receives the Skills
 * its recorded Action declared, resolved and integrity-verified exactly as an
 * entry would -- empty for an Action that declares none.
 */
export type PickupHandler = (env: Env, state: WorkState, skills: ResolvedActionSkillSet) => Promise<WorkState>;

/**
 * How a Unit takes in Handoffs addressed to it. Declared on the Unit's
 * manifest so the generic Worker (checkHandoffs.ts discovery, WorkSession's
 * pickup alarm) never names a Unit: it finds Pending Work Handoffs for each
 * Unit that declares this, registers their Work, and runs this Unit's
 * `handler` under the Action recorded from the Handoff's destination.
 *
 * Deliberately NOT an EntryHandler: a pickup reconstructs Handoff context
 * first, which a free-text entry has no equivalent for (see each manifest's
 * doc comment), so it stays a separate declaration rather than being folded
 * into an entry Action.
 */
export interface HandoffPickupDeclaration {
  /** Runs the pickup for Work whose Action was resolved and recorded from the Handoff's destination facts. */
  handler: PickupHandler;
  /**
   * Optional intake screen, run on a Pending Handoff BEFORE any Work is
   * registered for it. "skip" leaves the Handoff exactly as found (no Work,
   * no claim) -- e.g. a Handoff this Unit no longer takes. Default "accept".
   */
  screen?: (env: Env, handoff: { id: string; properties?: Record<string, any> }) => Promise<"accept" | "skip">;
  /**
   * Optional hold, run AFTER the Work is registered. Returning true means
   * the Handoff is registered and discoverable but is NOT scheduled for
   * pickup this cycle (execution waits for a deliberate human step).
   * Default false.
   */
  hold?: (env: Env, handoff: { id: string; properties?: Record<string, any> }) => Promise<boolean>;
}

/**
 * An operation a Unit exposes on a Work it owns, for callers that reach a
 * specific Work only through its Durable Object stub -- the Doc-comment
 * poller, the Drive notification path, a discovery run. Declared on the
 * manifest (UnitManifest.operations) so WorkSession carries ONE generic entry
 * (`runUnitOperation`) instead of a named method per Unit feature.
 *
 * `run` executes inside the Work's own execute cycle (so its state change is
 * saved with the rest of the Work, and a thrown failure is reported and rolled
 * back exactly like any other Work step) and returns the new state plus the
 * result the caller wants. `failed` is what the caller receives when `run`
 * threw: the execute cycle reports the failure and swallows it, so the caller
 * gets this declared, honest answer instead of an exception.
 */
export interface UnitOperation<I = any, R = any> {
  run: (env: Env, state: WorkState, input: I) => Promise<{ state: WorkState; result: R }>;
  failed: R;
}

/** Resumes a WorkSession left paused on one of this Hat's own `awaiting` states. */
export type AwaitingStateHandler = (
  env: Env,
  state: WorkState,
  text: string,
  /** The Skills declared by the Action this Work already recorded, resolved through the Registry before the handler runs. */
  skills: ResolvedActionSkillSet,
) => Promise<WorkState>;

/**
 * Resolves one of this Hat's own approval-callback prefixes -- the
 * propose/approve-or-reject choreography every requiresApproval action
 * already uses (a propose* function stores a domain-specific pending
 * field + Telegram approve/reject buttons; approved is derived from
 * which button Martin pressed). Not the same shape as AwaitingStateHandler:
 * that resumes on a typed text reply, this resolves a callback_data button
 * press, a mechanism the manifest had no field for at all until this one.
 */
export type ApprovalCallbackHandler = (
  env: Env,
  state: WorkState,
  approved: boolean,
  /**
   * The raw `callback_data` value (everything after `<prefix>:<workId>:`,
   * as index.ts's `split(":")` destructure produced it), forwarded so an
   * entry whose buttons carry a richer payload than one approve/reject
   * flag -- the entity/matter pickers' chosen page id or "new", the
   * intervention's "<version>.<a|r|j>", the sales proposal's
   * "<number>.<version>.<a|r>" -- can parse it exactly as its former
   * `handleCallback` switch case did. `approved` is still derived from
   * the button value exactly as before; approve/reject entries ignore
   * this argument and are unchanged.
   */
  value?: string,
) => Promise<WorkState>;

export interface HatManifest<A extends string = string> {
  /** Matches this Hat's HatIdentity.name in src/hats/registry.ts -- not duplicated, only referenced. */
  name: string;

  /**
   * Matches this Hat's HatIdentity.specialization in src/hats/registry.ts,
   * when that Hat has one. Documentation/display only -- dispatch keys
   * purely on `name` (manifest.hats is keyed by it, and state.hat stores
   * it); this field is never used to resolve or distinguish Hats.
   */
  specialization?: string;

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

  /**
   * The stable identifier for the Responsibility this Hat owns -- the short
   * slug its actions name in `ActionDefinition.responsibility`.
   *
   * A Hat owns exactly one Responsibility, so a single id is the truthful
   * shape; the prose above is the same statement in human-readable form. Every
   * Action this Hat declares must name this id, which is what makes "an Action
   * is an executable operation associated with a Responsibility" checkable
   * rather than aspirational -- and what stops an Action list from quietly
   * becoming a second organizational hierarchy: an Action can only serve the
   * Responsibility of a Hat that already declares it, and the Action Registry
   * still never assigns a Hat or routes Work.
   */
  responsibilityId: string;

  /** This Hat's full action list, each declaring its own read/write consequence. Fail-closed: an action referenced anywhere but missing here is never guessed at. */
  actions: ActionDefinition<A>[];

  /** Runs a read action immediately -- no WorkSession, no approval gate. Every action.name with consequence "read" must have a case here; missing one fails closed, never falls through. */
  readHandler: (env: Env, actionName: A, text: string, skills: ResolvedActionSkillSet) => Promise<string>;

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
   * (per the design doc's fail-closed manifest completeness): handleTextReply resolves nothing and sends its unchanged
   * "not awaiting a reply right now" fallback message, rather than reaching any handler.
   */
  awaitingHandlers: Record<string, AwaitingStateHandler>;

  /**
   * This Hat's own approval-callback prefixes, keyed exactly as the
   * callback_data prefix a propose function or entryHandler sets when it
   * sends its Telegram approve/reject buttons (e.g. "bdopportunityhandoff" for
   * "bdopportunityhandoff:<workId>:approve"). Optional and defaults to
   * none. A prefix declared here is dispatched generically through
   * session.ts's handleCallback's default case instead of needing its own
   * switch case -- since WP7 that switch holds only the Google OAuth
   * infrastructure prefixes; every business prefix lives here. A prefix
   * NOT declared here simply isn't reachable through this mechanism yet,
   * and stays exactly as it was. Entries whose buttons carry richer
   * payloads than a single approve/reject flag (the entity/matter
   * pickers, salesprop, sprop) receive the raw callback_data value
   * through ApprovalCallbackHandler's optional `value` argument and parse
   * it exactly as their former switch case did.
   */
  callbackHandlers?: Record<string, ApprovalCallbackHandler>;
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

  /**
   * This Unit's own registered SemanticTaskId for Stage 1 (which Hat)
   * classification -- never shared across Units (Data Boundary
   * sensitivity is resolved per task). A Unit-specific fact declared
   * here, not a kernel decision.
   */
  intakeClassificationTaskId: SemanticTaskId;
  /** One sentence naming this Unit for Stage 1's prompt -- e.g. "You route incoming Business Development requests for ENIG, among its three parallel specialist Hats." */
  intakeIntroLine: string;

  /**
   * This Unit's own registered SemanticTaskId for Stage 2 (which action,
   * within the resolved Hat's own declared list) classification -- one
   * per Unit, shared across all of its Hats (sensitivity is about the
   * Unit's business content, not which Hat within it), never shared
   * across Units.
   */
  actionClassificationTaskId: SemanticTaskId;

  /**
   * This Unit's own registered sequential Hat relationships, for Units whose
   * Stage 1 intake can propose SEVERAL genuinely plausible candidate Hats
   * and that resolve the tie between them through registered, deterministic
   * relationships rather than by ambiguity (the shape of Marketing's
   * Stage 1/2 intake: candidates + establishing in, one Hat or a fail-closed
   * reason out -- see hats/relationships.ts's resolveCandidateRelationships).
   *
   * Declared DATA (the Unit's own registered RelationshipDefinition list,
   * e.g. Marketing declares REGISTERED_MARKETING_RELATIONSHIPS by identity),
   * never inferred rules and never kernel behaviour: the evaluation itself
   * is the generic, pure resolveCandidateRelationships, invoked by the
   * Organization boundary (resolveOrganization) when -- and only when -- all
   * of these hold: the Work was addressed to no Hat, is from no Handoff
   * destination, Stage 1 consulted an interpretation, and that interpretation
   * validated to MORE than one Hat this Unit declares. A single validated
   * candidate still resolves directly, exactly as before.
   *
   * Everything stays fail-closed: candidates are first validated against
   * this Unit's declared Hats (an unregistered candidate never reaches
   * relationship evaluation, so it can never become the selected Hat); a
   * conditional relationship with no explicit establishing value, no
   * registered relationship between the candidates, or several conflicting
   * relationships all fail closed (ambiguous_ownership) rather than
   * guessing. Optional, and absent for a Unit whose ambiguity must stop the
   * request (the unchanged behaviour of every manifest that declares
   * nothing here).
   */
  hatRelationships?: RelationshipDefinition<string>[];

  /**
   * How this Unit takes in Handoffs addressed to it -- see
   * HandoffPickupDeclaration. Absent for a Unit with no automated pickup:
   * its Pending Handoffs are counted and reported but never picked up.
   */
  handoffPickup?: HandoffPickupDeclaration;

  /**
   * Reads this Unit's OLD saved-state shape (loose top-level fields) into its
   * slice of WorkState and removes the loose fields. Only a Unit that has
   * moved its state into its own slice declares this. Must be idempotent and
   * must never overwrite a value already in the slice; applied to every saved
   * Work on load (src/workStateMigration.ts), so in-flight Works convert on
   * their next save.
   */
  migrateWorkState?: (saved: Record<string, unknown>) => void;

  /**
   * The operations this Unit exposes on a Work it owns, keyed by name -- see
   * UnitOperation. Reached through `WorkSession.runUnitOperation(unit, name,
   * input)`. A name no Unit declares is refused, never guessed.
   */
  operations?: Record<string, UnitOperation>;
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

/** Approval-callback lookup convenience -- undefined means this Hat declares no handler for this callback_data prefix (fail closed at the caller, e.g. fall through to a legacy switch case or a no-op). */
export function findCallbackHandler(prefix: string, hat: HatManifest): ApprovalCallbackHandler | undefined {
  return hat.callbackHandlers?.[prefix];
}

/**
 * Validates one Hat's manifest in isolation, returning the first reason it is
 * malformed or null when it is well-formed.
 *
 * Fail-closed manifest completeness extends to the Action/Responsibility
 * relationship: an Action that does not name its own Hat's Responsibility, or
 * a Hat that declares no Responsibility id at all, is a manifest defect. The
 * Kernel must not resolve either by guessing -- an Action whose Responsibility
 * is unresolvable is an Action whose authority framing is unresolvable, and
 * silently proceeding would let the Action list drift into an independent
 * organizational hierarchy.
 */
export function validateHatManifest(hat: HatManifest): string | null {
  if (!hat.name || !hat.name.trim()) return "a Hat manifest must declare the Hat's registered name";
  if (!hat.responsibilityId || !hat.responsibilityId.trim()) {
    return `${hat.name}: a Hat must declare the id of the Responsibility it owns, for its Actions to be associated with`;
  }
  if (hat.actions.length === 0) {
    return `${hat.name}: a Hat must declare at least one Action`;
  }
  const seen = new Set<string>();
  for (const action of hat.actions) {
    const defect = validateActionDefinition(action);
    if (defect) return `${hat.name}: ${defect}`;
    if (action.responsibility !== hat.responsibilityId) {
      return `${hat.name}: action "${action.name}" declares Responsibility "${action.responsibility}", which is not the Responsibility this Hat owns ("${hat.responsibilityId}")`;
    }
    if (seen.has(action.name)) {
      return `${hat.name}: action "${action.name}" is declared more than once -- resolution must be unambiguous`;
    }
    seen.add(action.name);
  }
  return null;
}
