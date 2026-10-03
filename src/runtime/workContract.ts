import type { Unit, WorkState } from "../types";

/**
 * The Work contract (ENIG Operating Model: "Work" owns identity, context,
 * task, current state, routing, Handoff relationship, continuation state,
 * approval state, result, failure, closure -- and does NOT own
 * organizational ownership definitions, Action selection, Skill selection,
 * Access authorization, Tool authorization, or business-specific execution
 * logic).
 *
 * This module is the contract itself plus the projection between the
 * canonical concepts and the WorkState fields this repository already
 * persists. It deliberately RENAMES NOTHING: WorkState stays as it is
 * (Access reads `WorkState.actionName` as its sole authority -- PR #221),
 * and this projection is how one Work is described in canonical terms.
 *
 * FIELD-BY-FIELD, WHICH EXISTING FIELD REPRESENTS WHICH CONCEPT:
 *
 *   identity.work_id          <- `workId`
 *   context.workspace         <- `chatId` + `threadId` (which Workspace
 *                                conversation this Work belongs to)
 *   state.stage               <- `stage` ("new" and the Unit's own
 *                                lifecycle stages)
 *   continuation.awaiting     <- `awaiting` (the paused state a reply
 *                                resumes)
 *   routing.unit              <- `unit`
 *   routing.hat               <- `hat`
 *   routing.action            <- `actionName` (the recorded resolved
 *                                Action -- the sanctioned output of
 *                                Resolution, written only by
 *                                `recordWorkAction`)
 *   routing.responsibility    <- NOT persisted: derived by Resolution from
 *                                the Hat manifest and carried on the
 *                                resolved execution context (see
 *                                runtime/actionResolution.ts). Persisting
 *                                a second copy would drift from the
 *                                manifest it is derived from, and nothing
 *                                authoritative reads it back.
 *   routing.specialization    <- same: carried on the execution context,
 *                                declared on the Hat manifest.
 *   routing.action_version    <- same: no canonical version source exists
 *                                in this repository (see Known gaps).
 *   handoff.handoff_id        <- `handoffId`
 *   task.matter_id            <- `matterId` (`matterToken`/`entityToken`
 *                                are the Handoff identity-boundary
 *                                tokens, not organizational facts)
 *   approval.state            <- `pendingApproval` (+ the Unit's own
 *                                pending-approval fields)
 *   closure.timestamps        <- `createdAt` / `updatedAt`
 *   failure.reason            <- `blockedReason`
 *
 * FIELDS CURRENTLY OVERLOADED (carry more than one canonical meaning):
 *
 *   - `entryType` ("inbound_enquiry" | "outbound_outreach" |
 *     "direct_request") is written by domain Handlers and copied into a
 *     Handoff's Reason text. It is NOT the Work origin Resolution
 *     evaluates -- resolution reads `current_context.origin`, which says
 *     HOW THIS WORK WAS ENTERED (direct request, Handoff pickup,
 *     lifecycle transition) and is supplied by the code that enters it.
 *   - `hat` is a registered Hat name for every manifest-dispatched Work,
 *     except Marketing's direct entry, which seeds a placeholder
 *     ("Marketing") before its own intake resolves the real Hat -- see
 *     "Known gaps and drift".
 *   - Unit-specific state fields (`quote`, `proposalDraft`,
 *     `strategyDiagnosis`, `marketingDraft`, ...) are business execution
 *     state the Work carries for its Handlers, not kernel concepts.
 */

/** Which Workspace interaction mode the Work was entered from. */
export type WorkMode = "chat" | "cowork";

/**
 * HOW the Work was entered -- the origin Action Resolution evaluates.
 * Distinct from `WorkState.entryType`, which is domain-authored text.
 */
export type WorkOrigin = "direct_request" | "handoff_pickup" | "lifecycle_transition";

/** Facts about the Handoff a Work was entered from, when there is one. */
export interface WorkHandoffContext {
  /** The Handoff's Notion page id -- opaque, never identity-bearing. */
  handoffId?: string;
  /** Destination Unit, as written on the Handoff. A FACT, not a proposal. */
  toUnit: string;
  /** Destination Hat, as written on the Handoff. Absent is possible; Resolution then falls back to single-Hat ownership or fails closed. */
  toHat?: string | null;
}

/**
 * The inputs Resolution operates on for one Work entry:
 * `Work.requested_outcome` + `Work.current_context`.
 */
export interface WorkRequest {
  /** The outcome the Work exists to produce, as stated by the requester (message text) or the Handoff (Required Next Action). Free text; carried as data, never parsed for ownership here. */
  requested_outcome: string;
  current_context: {
    mode: WorkMode;
    origin: WorkOrigin;
    /** The Unit this Work is addressed to / destined for, already resolved deterministically (workspaceRouter's addressee resolution for chat/cowork; the Handoff's `To Unit` for a pickup). Resolution validates it against the canonical Unit registry -- it never infers a Unit. */
    addressed_unit?: string;
    /** An addressee already resolved deterministically by workspaceRouter (Cowork only) -- never inferred here. */
    addressed_hat?: string;
    /** Hat candidates proposed by an AI intake interpretation, when the Unit has several Hats and no addressee. Untrusted input: Resolution validates them against the canonical definitions and may only reject, never substitute. */
    interpreted_hats?: readonly string[];
    /** An exact Action id proposed by an AI intake interpretation (or carried by a Handoff), when the Work context alone does not determine one Action. `undefined` means no interpretation has been attempted yet (Resolution may then require one); `null` means one was attempted and yielded nothing usable. Untrusted input: it can only match a declared applicability condition exactly or fail. */
    requested_action?: string | null;
    /** Destination facts when this Work is entered from a Handoff. */
    handoff?: WorkHandoffContext;
  };
}

/**
 * The Work contract -- Work described in canonical terms. Built either for
 * a Work that is about to be created (Resolution runs before `init`) or
 * projected from persisted WorkState (`toWorkContract`).
 *
 * `identity.work_id` is null only for a request whose Work has not been
 * created yet (a resolved "read" Action never creates one).
 */
export interface WorkContract {
  identity: { work_id: string | null };
  requested_outcome: string;
  current_context: WorkRequest["current_context"];
  state: { stage: string | null; awaiting: string | null };
  routing: {
    unit: Unit | null;
    hat: string | null;
    responsibility: string | null;
    specialization: string | null;
    action: string | null;
    action_version: string | null;
  };
  handoff: { handoff_id: string | null; to_unit: string | null; to_hat: string | null };
  task: { matter_id: string | null };
  approval: { pending_approval: boolean };
  failure: { blocked_reason: string | null };
  closure: { created_at: string | null; updated_at: string | null };
}

/**
 * Builds the contract for a Work that is about to be entered from a
 * request -- the shape Resolution receives.
 */
export function workContractForRequest(
  request: WorkRequest,
  workId: string | null = null,
): WorkContract {
  const { handoff } = request.current_context;
  return {
    identity: { work_id: workId },
    requested_outcome: request.requested_outcome,
    current_context: request.current_context,
    state: { stage: null, awaiting: null },
    routing: {
      unit: null,
      hat: null,
      responsibility: null,
      specialization: null,
      action: null,
      action_version: null,
    },
    handoff: {
      handoff_id: handoff?.handoffId ?? null,
      to_unit: handoff?.toUnit ?? null,
      to_hat: handoff?.toHat ?? null,
    },
    task: { matter_id: null },
    approval: { pending_approval: false },
    failure: { blocked_reason: null },
    closure: { created_at: null, updated_at: null },
  };
}

/**
 * Projects persisted WorkState into the Work contract -- the Worker's view
 * of its own Work. Used by execution to compare what was resolved against
 * what this Work is, so the Worker consumes the resolved context instead of
 * re-deriving Unit/Hat/Responsibility/Action itself.
 *
 * `request` supplies the current entry's context when the caller has one
 * (the fields WorkState does not persist, because they describe entry, not
 * steady state).
 */
export function toWorkContract(state: WorkState, request?: WorkRequest): WorkContract {
  const { handoff } = request?.current_context ?? {};
  return {
    identity: { work_id: state.workId },
    requested_outcome: request?.requested_outcome ?? "",
    current_context: request?.current_context ?? {
      mode: "cowork",
      origin: "lifecycle_transition",
    },
    state: { stage: state.stage ?? null, awaiting: state.awaiting ?? null },
    routing: {
      unit: state.unit ?? null,
      hat: state.hat ?? null,
      // Not persisted (see the module doc): responsibility/specialization
      // are declared on the Hat manifest and carried on the resolved
      // execution context, so a second persisted copy could only drift.
      responsibility: null,
      specialization: null,
      action: state.actionName ?? null,
      action_version: null,
    },
    handoff: {
      handoff_id: state.handoffId ?? null,
      to_unit: handoff?.toUnit ?? null,
      to_hat: handoff?.toHat ?? null,
    },
    task: { matter_id: state.matterId ?? null },
    approval: { pending_approval: state.pendingApproval !== undefined },
    failure: { blocked_reason: state.blockedReason ?? null },
    closure: { created_at: state.createdAt ?? null, updated_at: state.updatedAt ?? null },
  };
}
