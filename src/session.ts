import { DurableObject } from "cloudflare:workers";
import type { Env, WorkState, SessionSummary, Unit } from "./types";
import { handleMarketingIntake } from "./units/marketing/marketingManifest";
import type { ActionExecutionContext } from "./runtime/actionResolution";
import { bindExecutionSkills, runWithRecordedActionSkills } from "./runtime/actionSkills";
import { installWorkPersistence, workStatePersistence } from "./runtime/workPersistence";
import {
  runGoogleDocsSmoke as runGoogleDocsSmokeOperation,
  GOOGLE_DOCS_SMOKE_CHAT_ID,
  GOOGLE_DOCS_SMOKE_WORK,
  type GoogleDocsSmokeResult,
} from "./runtime/tools/googleDocsSmoke";
import { confirmGoogleDocsSmoke } from "./googleDocsSmokeFlow";
import { SkillResolutionError, type ResolvedActionSkillSet } from "./platform/skillRegistry";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { withLiveStatus } from "./runtime/liveStatus";
import { workLiveOutcome, workLiveStatusTarget, workStatusLiveSink } from "./runtime/workStatus";
import { notifyMartinOfDiscoveryFailure, unitsWithHandoffPickup } from "./checkHandoffs";
import { dispatchScheduledPickup, schedulePickupAlarm, type PickupKind } from "./sessionRouting";
import { migrateSavedWork } from "./workStateMigration";
import { hashContent } from "./contentHash";
import type { ActionDefinition } from "./hats/actionRegistry";
import { advisoryAssessmentDeps, assessmentDelivery, formatAdvisoryMessage, runAdvisoryAssessment, summarizeAssessment } from "./runtime/advisoryAssessment";
import { runUnitOperationOnWork } from "./units/unitOperations";
import { resolveAwaitingHandler } from "./units/awaitingDispatch";
import { logActivity } from "./log";
import {
  handleGoogleAccountSelection,
  handleGoogleFolderSelection,
  handleGoogleActionApproval,
} from "./googleOAuth";
import { SESSIONS_INDEX_PENDING_CAP, deriveSessionLabel, safeEntityTokenRef, safeMatterTokenRef, sanitizeSessionsIndex, trimSessionsIndex, shouldAlertPendingApprovalBacklog } from "./sessionsIndex";
import { closeHandoffIfOpen, closeHandoffOnResult } from "./handoffLifecycle";
import {
  applyResultReviewGate,
  ensureResultReviewContract,
  isSuccessfulResultStage,
  resolveResultReviewApprovalDecision,
  RESULT_REVIEW_BLOCKED_STAGE,
  recordOutputApprovalAsResultApproval,
  stageResultReviewApproval,
  resultReviewCallbackData,
} from "./resultReview";
import type { InlineButton } from "./telegram";
import { runWithAdoptedOwnership } from "./handoffOwnership";
import { ensureMatterIdentity, isTerminalWorkStage, syncMatterContinuationPointer } from "./matterContinuation";
import { findUnitManifest, findCallbackPrefixOwner } from "./units/registry";
import { findCallbackHandler } from "./units/unitManifest";
import { recordWorkAction } from "./units/dispatch";
import { workSessionContext } from "./access";
import { kvDelete, kvGet, kvPut } from "./kvStore";

import { strategyOf } from "./units/strategy/strategyState";
const RESULT_ACCEPTED_ON_OUTPUT_APPROVAL_MESSAGE =
  "✅ Result accepted. You approved this exact output as the last step, and the independent check passed, so no second Result approval is needed. The Work may close once saved.";

/** The storage flag that arms the Checker's advisory assessment for alarm(). */
const PENDING_ADVISORY_ASSESSMENT_KEY = "pendingAdvisoryAssessment";
/** How long after the draft is saved the assessment's alarm fires. */
const ADVISORY_ASSESSMENT_DELAY_MS = 2_000;

/** Restores the success stage a Work was refused from, once its Result review is satisfied (shared by the approval callback, Re-check and the output-approval path). */
function restoreResultReviewBlockedStage(state: WorkState): void {
  const review = state.resultReview;
  if (review?.preBlockStage && state.stage === RESULT_REVIEW_BLOCKED_STAGE) {
    state.stage = review.preBlockStage;
    review.preBlockStage = undefined;
    state.blockedReason = undefined;
  }
}

export class WorkSession extends DurableObject<Env> {
  /**
   * Creates the Work. `matterId`/`matterToken` are the ALREADY-RESOLVED
   * Matter identity (canonical page id + the token it came from), passed in
   * only by the one boundary that creates a Work from a Handoff -- see
   * checkHandoffs.ts's resolveHandoffMatterIdentity. Persisting them here is
   * what lets sessions_index carry `matterId` and the existing
   * syncMatterContinuationPointer establish `matter_current_work` from this
   * Work's very first save. Optional for every other creation path, whose
   * behavior is unchanged.
   */
  async init(
    workId: string,
    chatId: number,
    unit?: Unit,
    hat?: string,
    threadId?: number,
    extra?: { handoffId?: string; matterId?: string; matterToken?: string; actionName?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const state: WorkState = {
      workId,
      chatId,
      threadId,
      unit,
      hat,
      stage: "new",
      createdAt: now,
      updatedAt: now,
      ...(extra?.handoffId ? { handoffId: extra.handoffId } : {}),
      ...(extra?.matterId ? { matterId: extra.matterId } : {}),
      ...(extra?.matterToken ? { matterToken: extra.matterToken } : {}),
    };
    // The resolved Action identity is recorded at creation, before anything
    // can be performed, and validated against the Work's own manifest. Absent
    // actionName is legitimate only for genuinely action-less Work (the
    // standalone Google Workspace control Work) -- every Unit's Work must
    // name the Action it was created for, including Handoff-driven Work.
    if (extra?.actionName) {
      recordWorkAction(state, extra.actionName);
    }
    await this.save(state);
  }

  async getState(): Promise<WorkState | undefined> {
    return migrateSavedWork(await this.ctx.storage.get<WorkState>("state"));
  }

  // Marketing's own intake resolves WHICH Marketing Hat owns a direct
  // request (marketingManifest.handleMarketingIntake runs Stage 1 itself)
  // and captures the task text -- so unlike every other manifest Unit,
  // Marketing still enters through this dedicated wrapper rather than the
  // generic handleUnitAction below, and records its Action for the same
  // reason it does (resolve Hat -> resolve Action -> persist Action
  // identity on Work -> execute). Documented as a known migration gap:
  // moving Marketing onto the Organization boundary means moving its Hat
  // interpretation ahead of dispatch, with its relationship-based
  // tie-breaking preserved.
  async handleMarketingRequest(text: string): Promise<WorkState> {
    return this.execute((state) => {
      recordWorkAction(state, "handle_request");
      return handleMarketingIntake(this.env, state, text);
    });
  }

  /**
   * Generic entry point for a Unit built on the Unit Registry manifest
   * pattern (ENIG Operating Model: "The Unit Registry" / Action Resolution)
   * -- the entry every manifest-registered Unit uses (Sales, Finance,
   * Strategy, Business Development). dispatchCowork
   * has already resolved Organization + Action statelessly via
   * resolveUnitRequest before creating this WorkSession (an
   * "internal"/"write" action only -- "read" never reaches here at all, per
   * resolveUnitRequest's own contract). Fails closed if state.unit/state.hat
   * don't resolve to a registered manifest/Hat rather than silently
   * no-op'ing.
   *
   * TAKES THE RESOLVED EXECUTION CONTEXT, not an action name. The Worker
   * consumes what Resolution produced instead of selecting a Unit, Hat,
   * Responsibility, Action or Skill for its own Work, and refuses to run a
   * context that doesn't describe this Work (unit/hat/work id/Responsibility
   * mismatch below) rather than quietly executing someone else's resolution.
   *
   * RECORDS THE RESOLVED ACTION before running the entry handler. The Action
   * the resolver produced IS the Work's Action, so it is persisted here --
   * the architecturally required order is resolve Hat -> resolve Action ->
   * persist Action identity on Work -> execute. Recording it here rather than
   * trusting the init call site is what makes Work.actionName the authority
   * Access later reads.
   */
  async handleUnitAction(execution: ActionExecutionContext, text: string): Promise<WorkState> {
    return this.execute((state) => {
      const actionName = execution.action.action_id;
      const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
      const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
      if (!manifest || !hat) {
        console.error(`handleUnitAction: no registered manifest/Hat for ${state.unit}/${state.hat} (work ${state.workId})`);
        return sendMessage(
          this.env,
          state.chatId,
          `${state.unit ?? "This Unit"} isn't wired for direct dispatch.`,
          undefined,
          state.threadId,
        ).then(() => state);
      }
      const contextDescribesThisWork =
        execution.organization.unit === state.unit &&
        execution.organization.hat === state.hat &&
        (execution.work_id === null || execution.work_id === state.workId) &&
        execution.action.responsibility === hat.responsibilityId;
      if (!contextDescribesThisWork) {
        console.error(
          `handleUnitAction: resolved context (${execution.organization.unit}/${execution.organization.hat}/${actionName}) does not describe Work ${state.workId} (${state.unit}/${state.hat}) -- refusing to run it`,
        );
        return sendMessage(
          this.env,
          state.chatId,
          "This Work's resolved execution context doesn't match the Work itself -- nothing was run.",
          undefined,
          state.threadId,
        ).then(() => state);
      }
      // The Skills this Action declared, resolved by Action Resolution and
      // carried on the context. Re-verified against the Registry here, before
      // the handler can run: a declared Skill that is missing, substituted or
      // integrity-drifted stops the Work rather than letting the handler follow
      // unverified methodology.
      const declaredAction = hat.actions.find((a) => a.name === actionName);
      if (!declaredAction) {
        console.error(`handleUnitAction: ${state.unit}/${state.hat} declares no action "${actionName}" (work ${state.workId})`);
        return sendMessage(this.env, state.chatId, `"${actionName}" isn't a registered action on this Hat.`, undefined, state.threadId).then(() => state);
      }
      return bindExecutionSkills(execution.skills, declaredAction).then(
        (skills) => {
          recordWorkAction(state, actionName);
          return hat.entryHandler(this.env, state, actionName, text, skills);
        },
        (err) => {
          if (!(err instanceof SkillResolutionError)) throw err;
          console.error(`handleUnitAction: required Skill resolution failed for ${actionName} (work ${state.workId}): ${err.reason}`);
          return sendMessage(this.env, state.chatId, "A Skill this action requires could not be verified -- nothing was run.", undefined, state.threadId).then(() => state);
        },
      );
    });
  }

  async handleTextReply(text: string): Promise<WorkState> {
    return this.execute((state) => {
      // Every awaiting state resolves through the owning Hat's own
      // awaitingHandlers in its Unit's manifest (the hardcoded switch is
      // gone -- each case was moved to its Unit's manifest entry first,
      // then deleted). Per the design doc's fail-closed manifest
      // completeness: a state.awaiting value the resolved Hat doesn't
      // declare in its own awaitingHandlers still falls through to the
      // same "not awaiting" message below, never a silent no-op.
      const awaitingHandler = resolveAwaitingHandler(state);
      if (awaitingHandler) {
        // The resumed Work runs under the Action it already recorded; that
        // Action's declared Skills are resolved through the Registry before
        // the handler runs, exactly as at entry.
        return this.runUnderRecordedSkills(state, (skills) => awaitingHandler(this.env, state, text, skills));
      }
      return sendMessage(
        this.env,
        state.chatId,
        "This work item isn't awaiting a reply right now. Use /sessions to switch context.",
        undefined,
        state.threadId,
      ).then(() => state);
    });
  }

  /**
   * Invoked by Handoff discovery (checkHandoffs.ts's discovery loops) INSTEAD
   * of awaiting the pickup inline: this only records the pending pickup kind
   * on the WorkSession's own storage and arms this Durable Object's alarm.
   * The pickup itself runs later from alarm() below, so a webhook's
   * ctx.waitUntil window (cancelled by Cloudflare ~30 s after the response)
   * never has to hold an entire AI diagnosis. See
   * docs/enig-operating-model.md, "Infrastructure".
   */
  async schedulePickup(kind: PickupKind): Promise<void> {
    await schedulePickupAlarm(this.ctx.storage, kind);
  }

  /**
   * Cloudflare invokes this when the alarm armed by schedulePickup fires. It
   * runs EXACTLY the one pickup discovery scheduled (the pending kind is
   * cleared before the runner starts, so a duplicate or re-fired alarm can
   * never run the same pickup twice; duplicate Handoff claims remain guarded
   * by claimPendingHandoff exactly as before -- no second dedupe mechanism).
   * Failures report through the same notifyMartinOfDiscoveryFailure path the
   * discovery loops use and are deliberately not rethrown: the Handoff stays
   * Pending and the next discovery cycle retries, matching the loops' own
   * catch-and-notify behaviour.
   */
  async alarm(): Promise<void> {
    try {
      // One runner per Unit that declares a Handoff pickup in its manifest.
      const runners: Partial<Record<PickupKind, () => Promise<unknown>>> = {};
      for (const unit of unitsWithHandoffPickup()) runners[unit] = () => this.runHandoffPickup(unit);
      await dispatchScheduledPickup(this.ctx.storage, runners);
    } catch (err) {
      const state = await this.getState().catch(() => undefined);
      await notifyMartinOfDiscoveryFailure(this.env, state?.handoffId ?? "(unknown)", err);
    }
    // The Checker's advisory second opinion, scheduled by execute() (see
    // scheduleAdvisoryAssessment). Never throws and never blocks a pickup.
    await this.runPendingAdvisoryAssessment();
  }

  /**
   * Every scheduled pickup runs through runWithAdoptedOwnership first: the
   * Handoff's own destination facts (To Unit / To Hat) become this Work's
   * recorded Unit/Hat/Action before its handler runs, so the receiving Unit
   * owns the interaction from here on (buttons, awaiting replies, declared
   * Skills, Access authority, the sessions index). See
   * src/handoffOwnership.ts for why, and docs/enig-operating-model.md's
   * "Handoff is a Business Object". It is a no-op when the Work already
   * records that destination -- the external path, which inits the session
   * with it -- so those pickups are unchanged.
   *
   * ONE runner for every Unit: the handler is whatever the receiving Unit's
   * manifest declares as its `handoffPickup` (UnitManifest.handoffPickup), so
   * this class names no Unit. Invoked only from alarm(), after Handoff
   * discovery (checkHandoffs.ts) scheduled it for this Work. It is the actual
   * cross-Unit execution boundary: the sending Unit's own call already
   * returned before this ever runs. Fails closed (throws, so nothing is
   * claimed or persisted and the Handoff stays Pending) for a Unit that
   * declares no pickup.
   */
  async runHandoffPickup(unit: Unit): Promise<WorkState> {
    const declaration = findUnitManifest(unit)?.handoffPickup;
    if (!declaration) throw new Error(`${unit} declares no Handoff pickup -- nothing to run`);
    return this.execute((state) =>
      runWithAdoptedOwnership(this.env, state, unit, (adopted) =>
        this.runUnderRecordedSkills(adopted, (skills) => declaration.handler(this.env, adopted, skills)),
      ),
    );
  }


  /**
   * GOVERNED GOOGLE DOCS SMOKE (LOG-1069 live verification; Martin-approved
   * option (b), 2026-10-10). Runs EXACTLY one registered
   * `google_docs.create_and_verify` through the shared Tool Registry on a
   * genuine smoke Work created through this Durable Object's own `init` --
   * the smoke's recorded Action is validated against the Unit Manifest by
   * `recordWorkAction` like any other Work, Access judges the Work's own
   * recorded Action, and durable operation persistence is installed by
   * `execute` exactly as for any handler. The target is the DISPOSABLE
   * folder configured in runtime state (`google_smoke_test_folder:<account>`,
   * see src/runtime/tools/googleDocsSmoke.ts); the production proposal
   * folder is never read or written, and missing configuration refuses
   * before any Work exists or any Google request is made. Invoked only by
   * the admin-key-gated `/admin/smoke-google-docs` route in src/index.ts,
   * never by dispatch, a Handoff, or any chat. The smoke Work belongs to no
   * chat (chatId 0 is never a real recipient and this path sends nothing),
   * and is closed through the governed lifecycle only after a clean
   * terminal end (succeeded/denied) -- an uncertain effect keeps it open
   * with its durable records intact for reconciliation.
   */
  async runGoogleDocsSmoke(workId: string): Promise<GoogleDocsSmokeResult> {
    return runGoogleDocsSmokeOperation(this.env, workId, {
      ensureGovernedWork: async (id: string) => {
        if (await this.getState()) {
          return {
            ok: false,
            reason: `Work ${id} already exists in this session -- the smoke never re-initializes an existing Work or overwrites its durable operation records; run a fresh invocation instead.`,
          };
        }
        await this.init(id, GOOGLE_DOCS_SMOKE_CHAT_ID, GOOGLE_DOCS_SMOKE_WORK.unit, GOOGLE_DOCS_SMOKE_WORK.hat, undefined, {
          actionName: GOOGLE_DOCS_SMOKE_WORK.actionName,
        });
        return { ok: true };
      },
      runWithWorkPersistence: async (id: string, fn: (state: WorkState) => Promise<WorkState>) => {
        const state = await this.require();
        if (state.workId !== id) {
          throw new Error(`smoke Work mismatch: this session holds ${state.workId} but the smoke asked for ${id} -- refusing to run the invocation against another Work.`);
        }
        return this.execute(fn);
      },
      closeGovernedWork: async () => {
        await this.cancel();
      },
    });
  }

  /**
   * The interactive Telegram smoke confirmation (src/googleDocsSmokeFlow.ts):
   * validates the pending smoke Work and its selected disposable target, then
   * runs the SAME shared invocation core the admin entry uses. Runs outside
   * the generic handleCallback execute because the invocation installs its
   * own durable operation persistence through this session's execute cycle;
   * every state change here goes through one explicit execute at a time.
   */
  async runGoogleDocsSmokeConfirmation(value: string): Promise<WorkState> {
    const state = await this.require();
    return confirmGoogleDocsSmoke(this.env, state, value, {
      runExclusive: async (workId: string, fn: (s: WorkState) => Promise<WorkState>) => {
        const current = await this.require();
        if (current.workId !== workId) {
          throw new Error(`smoke confirmation Work mismatch: this session holds ${current.workId} but the flow asked for ${workId} -- refusing to continue.`);
        }
        return this.execute(fn);
      },
      markComplete: async (workId: string) => {
        await this.execute(async (s) => {
          if (s.workId !== workId) return s;
          s.stage = "complete";
          s.pendingSmokeSelection = undefined;
          return s;
        });
      },
    });
  }

  /**
   * The ONE generic entry for what a Unit lets a caller do to a Work it owns
   * (UnitManifest.operations): Sales's Proposal-Doc comment handling and Lead
   * cards, for example, which used to be a named method each on this class.
   * Runs the operation inside this Work's execute cycle and returns its result,
   * or the operation's declared `failed` answer if it threw. Fails closed for a
   * Unit that declares no such operation. The logic lives with the Unit.
   */
  async runUnitOperation(unit: Unit, name: string, input: unknown): Promise<unknown> {
    return runUnitOperationOnWork(this.env, unit, name, input, (fn) => this.execute(fn));
  }


  /**
   * The existing, generic terminal action for any work item -- this is
   * also the runtime's existing mechanism for "explicit rejection with no
   * further direction" (e.g. declining a Strategy intervention outright):
   * no dedicated per-domain reject button exists anywhere in this Worker
   * (every approval gate offers Approve + a revise/redo action, never a
   * third terminal-reject button), so per the instruction not to invent a
   * new user-facing action without inspecting the existing mechanism
   * first, /cancel is that action. Enhanced here (not overridden per-Hat)
   * to also close whatever Handoff is currently in play, if any and if it
   * isn't already terminal -- previously a silent gap: cancelling left the
   * Handoff dangling at Pending/Picked-up/Held indefinitely. A materially
   * new attempt after this must use a new Handoff, per the existing
   * Closed-Handoff-is-terminal discipline every pickup already enforces.
   */
  async cancel(): Promise<WorkState> {
    return this.execute(async (state) => {
      if (state.handoffId) {
        try {
          // Closing the Handoff this Work item was picked up from is execution
          // bookkeeping on a record it already owns -- Martin's /cancel is the
          // instruction, and it advances no Unit's governed output. Judged
          // against the Work's own recorded Action, whose consequence permits
          // the write; ungated because the Action Martin approved is not this
          // one.
          await closeHandoffIfOpen(
            this.env,
            state.handoffId,
            "Work item cancelled by Martin -- rejected with no further direction. A materially new attempt requires a new Handoff.",
            workSessionContext(state),
          );
        } catch (err) {
          console.error(`WorkSession ${state.workId} cancel: failed to close Handoff ${state.handoffId}`, err);
        }
      }
      state.stage = "cancelled";
      state.awaiting = undefined;
      state.pendingActionSummary = undefined;
      strategyOf(state).pendingApproval = undefined;
      strategyOf(state).pendingHandoff = undefined;
      await logActivity(this.env, {
        entry: `Work item cancelled: ${state.entityName ?? state.matterName ?? state.workId}`,
        type: "Activity",
        area: state.unit ?? "Operations",
        decisionRationale: state.handoffId ? `Handoff ${state.handoffId} closed with the cancellation recorded, if not already terminal.` : undefined,
        outcome: "Complete",
      });
      return state;
    });
  }





  async handleCallback(action: string, value: string): Promise<WorkState> {
    // The interactive Tool Registry smoke confirmation is handled OUTSIDE
    // the generic execute below: its invocation installs its own durable
    // operation persistence through this session's execute cycle, and
    // nesting the two would clobber the installed adapter. No other prefix
    // changes behaviour here.
    if (action === "googlesmokeconfirm") {
      return this.runGoogleDocsSmokeConfirmation(value);
    }
    return this.execute((state) => {
      switch (action) {
        // The four business prefixes that used to live here -- entity,
        // matter, sprop and salesprop -- are now declared on their owning
        // Hat's HatManifest.callbackHandlers (salesManifest.ts and
        // strategyManifest.ts) and reach their exact handlers through the
        // generic manifest lookup below (WP7). Only the infrastructure
        // callbacks remain hardcoded: they authorize cross-system OAuth
        // flows and belong to no Unit's business decisions.
        case "googleaccount":
          return handleGoogleAccountSelection(this.env, state, value);
        case "googlefolder":
          return handleGoogleFolderSelection(this.env, state, value);
        case "googleaction":
          return handleGoogleActionApproval(this.env, state, value === "approve");
        case "resultreview": {
          // Kernel-owned Work lifecycle, same class as the three
          // infrastructure prefixes above: Martin's Result-review decision
          // (BD-8 condition 3) returns through this verified callback, never
          // through free text. The value carries the staged card's own token
          // plus the decision; resolveResultReviewApprovalDecision consumes
          // the staged approval as it records the decision, so a replayed
          // button finds nothing left to consume.
          // The button carries the Work id in the routing slot (index.ts
          // splits callback_data as action:workId:value) and, in the value,
          // a one-letter kind plus the staged card's token prefix -- the
          // earlier `resultreview:<token>:<decision>` shape put the token
          // where the Work id belongs and could never reach this Work
          // (2026-11-14). "c" is Martin's Re-check of a blocked Work.
          const kind = value.charAt(0);
          if (kind === "c") return this.recheckResultReview(state);
          const fullToken = state.resultReview?.pendingApproval?.token;
          const prefix = value.slice(1);
          if ((kind !== "a" && kind !== "r") || !prefix) {
            return sendMessage(this.env, state.chatId, "That Result review button is malformed -- nothing was recorded.", undefined, state.threadId).then(() => state);
          }
          // A prefix that does not match the staged card is passed through
          // unchanged so the shared resolver refuses it with its own reason.
          const token = fullToken && fullToken.startsWith(prefix) ? fullToken : prefix;
          return resolveResultReviewApprovalDecision(state, { approved: kind === "a", token }).then(
            (outcome) => {
              if (!outcome.ok) {
                return sendMessage(this.env, state.chatId, `This Result review decision was already resolved or does not match the current card -- nothing was recorded. (${outcome.reason})`, undefined, state.threadId).then(() => state);
              }
              state.pendingActionSummary = undefined;
              if (outcome.approval) {
                // BD-8/BD-13 recovery: a Work refused into
                // `result_review_blocked` remembered the success stage it was
                // refused FROM (preBlockStage, recorded by
                // applyResultReviewGate). Martin's recorded Result approval
                // is what restores it -- a blocked stage is deliberately not
                // a success stage, so without this the gate would never look
                // at the Work again after the one refusal and the refused
                // Handoff closure (pendingClosure) would never be retried.
                // The restored stage flows into save(), which re-evaluates
                // the gate (now satisfied) and completes the pending
                // closure.
                restoreResultReviewBlockedStage(state);
              }
              const reply = outcome.approval
                ? "✅ Result approved. The approval is recorded against this exact Result, criteria and Checker verdict; the Work may close once saved."
                : "❌ Result rejected. The rejection is recorded and the Work stays open with the reason visible.";
              return sendMessage(this.env, state.chatId, reply, undefined, state.threadId).then(() => state);
            },
            (err) => {
              console.error(`WorkSession ${state.workId}: resultreview callback failed`, err);
              return sendMessage(this.env, state.chatId, "The Result review decision could not be recorded -- nothing was changed.", undefined, state.threadId).then(() => state);
            },
          );
        }
        default: {
          // Generic manifest lookup for an approval-callback prefix a Hat
          // has migrated onto HatManifest.callbackHandlers -- checked only
          // as a fallback, after every remaining hand-written case above,
          // so no legacy prefix's behavior changes. The raw value is
          // forwarded alongside the derived `approved` flag so entries
          // whose buttons carry richer payloads (entity/matter pickers,
          // sprop, salesprop) parse them exactly as their former switch
          // case did. Mirrors handleTextReply's own default-case manifest
          // fallback for awaitingHandlers.
          const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
          const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
          const callbackHandler = hat ? findCallbackHandler(action, hat) : undefined;
          if (callbackHandler) {
            return callbackHandler(this.env, state, value === "approve", value);
          }
          // A prefix this Work's own Hat does not declare, but another
          // registered Unit/Hat does, is a STALE button: work ownership moved
          // on (a Handoff pickup adopts the destination -- see
          // src/handoffOwnership.ts) and the old Unit's buttons must not act
          // on the new Unit's state. Refuse out loud instead of doing
          // nothing, and still return the state unchanged.
          const owner = findCallbackPrefixOwner(action);
          if (owner) {
            const message =
              owner.unit === state.unit
                ? `This button belongs to ${owner.unit}'s ${owner.hat} Hat, but this work item runs as ${state.hat ?? "another Hat"} -- nothing was run.`
                : `This button belongs to ${owner.unit}, but this work item now runs as ${state.unit ?? "another Unit"} -- nothing was run.`;
            return sendMessage(this.env, state.chatId, message, undefined, state.threadId).then(() => state);
          }
          // An unknown prefix still resolves the state unchanged, as before.
          return Promise.resolve(state);
        }
      }
    });
  }

  private async require(): Promise<WorkState> {
    const state = await this.getState();
    if (!state) throw new Error("Work session state missing");
    return state;
  }

  /**
   * Runtime protection layer (Gap B of the architecture audit): every
   * public execution method routes through here. Fetches state once,
   * runs the Hat logic, and saves the result — but if the Hat logic throws
   * (a Notion outage, a malformed response not already handled by a
   * fail-closed check, or any other unexpected defect), the error is
   * logged and Martin is notified directly in the topic this work item
   * belongs to, instead of the request failing silently. Nothing partial
   * is treated as success: the pre-error state is what gets saved, since
   * a thrown error means whatever write it was attempting did not
   * complete. This is a safety net, not a substitute for the fail-closed
   * governance checks already inside each Hat function — those still run
   * first and produce their own explicit, specific messages.
   */
  /**
   * Runs a handler for Work whose Action is ALREADY recorded (an awaiting
   * resume, or a Handoff pickup) under that Action's declared Skills,
   * resolved through the Skill Registry before the handler runs. If they
   * cannot be resolved or verified, nothing runs and Martin is told. Access
   * and approval are not touched here: they remain what the handler's own
   * governed operations evaluate from the recorded Action.
   */
  private async runUnderRecordedSkills(state: WorkState, run: (skills: ResolvedActionSkillSet) => Promise<WorkState>): Promise<WorkState> {
    const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
    const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
    if (!hat) {
      console.error(`runUnderRecordedSkills: no registered manifest/Hat for ${state.unit}/${state.hat} (work ${state.workId}) -- nothing was run`);
      await sendMessage(this.env, state.chatId, `${state.unit ?? "This Unit"} isn't wired for this action -- nothing was run.`, undefined, state.threadId);
      return state;
    }
    const outcome = await runWithRecordedActionSkills(hat, state.actionName, run);
    if (outcome.kind === "refused") {
      console.error(`required Skill resolution failed for ${state.actionName} (work ${state.workId}): ${outcome.reason}`);
      await sendMessage(this.env, state.chatId, "A Skill this action requires could not be verified -- nothing was run.", undefined, state.threadId);
      return state;
    }
    return outcome.result;
  }

  /**
   * The Result contract (BD-8) the Work's OWN recorded Action declares, read
   * live from the registered manifest -- never hard-coded, never asserted by
   * the caller. Returns undefined for a Work that records no registered
   * Action; the gate then refuses its successful closure with that reason.
   */
  private recordedActionResult(state: WorkState): { expectedResult?: string; completionCriteria?: readonly string[]; outputApprovalClosesWork?: boolean; advisoryAssessment?: NonNullable<ActionDefinition<string>["advisoryAssessment"]> } | undefined {
    if (!state.unit || !state.hat || !state.actionName) return undefined;
    const manifest = findUnitManifest(state.unit);
    const hat = manifest ? manifest.hats[state.hat] : undefined;
    return hat?.actions.find((a) => a.name === state.actionName);
  }

  private async execute(fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState> {
    const state = await this.require();
    // Reset every call -- see WorkState.pendingHandoffAutoCheck's doc
    // comment. Only the specific handler invoked by fn() below may set
    // this true again, so a caller inspecting the returned state never
    // sees a stale signal left over from an earlier, unrelated call.
    state.pendingHandoffAutoCheck = false;
    // Result review contract (BD-8): loaded once per mutation cycle, from
    // the Work's OWN recorded Action as registered on its Unit's manifest --
    // so dispatch entries and adopted Handoff pickups are covered by one
    // mechanism, and the contract can never be hand-written onto state.
    ensureResultReviewContract(state, this.recordedActionResult(state));
    // Durable operation persistence for THIS Work and THIS call only (see
    // src/runtime/workPersistence.ts): the Tool Registry persists its
    // execution intent and outcome into `state.externalOperations` and
    // flushes them straight to this Work's own DO storage, so the records
    // survive even when the handler throws and `save` below never runs --
    // which is exactly the interruption window recovery exists for. The flush
    // writes ONLY those operation records over the last saved state; a thrown
    // handler still rolls back its own partial state exactly as before.
    const release = installWorkPersistence(
      String(state.workId),
      workStatePersistence(state, async () => {
        const persisted = migrateSavedWork(await this.ctx.storage.get<WorkState>("state")) ?? state;
        await this.ctx.storage.put("state", { ...persisted, externalOperations: state.externalOperations });
      }),
    );
    try {
      // Universal live status (src/runtime/liveStatus.ts): every Work run
      // reports what it is doing, from the shared chokepoints, with no
      // per-Hat code. Where the Hat reports its own named steps, those lead.
      // The run also carries this Work's own Access context, which the
      // universal web research tool (src/runtime/webResearch.ts) uses.
      const saved = await withLiveStatus(this.env, workLiveStatusTarget(state), async () => this.save(await fn(state)), workLiveOutcome, workStatusLiveSink(this.env, state), {
        access: () => workSessionContext(state),
      });
      // The independent Checker's advisory second opinion (Martin's decision,
      // 2026-11-14): AFTER the draft is saved and with Martin, never before.
      // It is only SCHEDULED here (a storage write and an alarm); it runs from
      // alarm() in its own invocation, because run inline it shared this
      // invocation's subrequest budget -- already spent by the research and the
      // draft -- and failed ("Too many subrequests"), and it would have held
      // the Telegram webhook open besides.
      await this.scheduleAdvisoryAssessment(saved);
      return saved;
    } catch (err) {
      console.error(`WorkSession ${state.workId} execution failed`, err);
      const detail = err instanceof Error ? err.message : String(err);
      await sendOperationsMessage(
        this.env,
        `⚠️ WorkSession ${state.workId} (${state.unit ? `${state.unit}/${state.hat}` : "Standalone Capability"}) execution failed: ${detail.slice(0, 500)}`,
      ).catch((notifyErr) => console.error(`WorkSession ${state.workId} failure notification also failed`, notifyErr));
      return state;
    } finally {
      release();
    }
  }

  private async save(state: WorkState): Promise<WorkState> {
    state.updatedAt = new Date().toISOString();
    // The independent Checker is ADVISORY (Martin's decision, 2026-11-14): it
    // is no longer run here as a prerequisite of closure. Its assessment of a
    // draft is sent to Martin after the draft, separately, and never blocks,
    // delays or invalidates his approval or redo (see runAdvisoryAssessment).
    // Output approval closes the Work (Martin's decision, 2026-11-14): where
    // the Action declares it and the evidence records Martin's approval of
    // the exact output (the last step of the Work), that approval stands as
    // his Result approval -- no second tap. Anything else leaves the Result
    // approval card as the path.
    if (state.resultReview?.outputApprovalClosesWork && (isSuccessfulResultStage(state.stage) || state.stage === RESULT_REVIEW_BLOCKED_STAGE)) {
      const closed = await recordOutputApprovalAsResultApproval(state).catch((err) => {
        console.error(`WorkSession ${state.workId}: output-approval Result approval failed`, err);
        return { ok: false as const, reason: String(err) };
      });
      if (closed.ok) {
        restoreResultReviewBlockedStage(state);
        await sendMessage(this.env, state.chatId, RESULT_ACCEPTED_ON_OUTPUT_APPROVAL_MESSAGE, undefined, state.threadId).catch((err) => console.error("output-approval notice failed", err));
      }
    }
    // Result review gate (BD-8): a Work may not REMAIN recorded as
    // successfully closed while its Result review is unsatisfied. This is
    // defence in depth behind closeHandoffOnResult (the point where the
    // Handoff itself is closed) -- here the Work's own stage is refused into
    // `result_review_blocked` with the reason kept visible, and Martin is
    // told once per transition with the staged Result approval card and its
    // Approve/Reject buttons.
    const gateResult = await applyResultReviewGate(state, (s, reason) => this.reportResultReviewBlocked(s, reason));
    // BD-8 resumption: a successful Handoff closure the gate refused is kept
    // on the review (pendingClosure, recorded by closeHandoffOnResult) and
    // retried HERE the moment the review is actually satisfied -- a refusal
    // is delay, never silent loss of the Unit's own completion write. Only
    // when the gate just PASSED (gateStatus "passed" recomputed on this
    // save's snapshot), so an unsatisfied review never re-attempts the
    // closure; closeHandoffOnResult itself re-evaluates the gate before any
    // Notion call and manages pendingClosure (cleared on success, refreshed
    // on a fresh refusal).
    if (!gateResult.blocked && state.resultReview?.gateStatus === "passed" && state.resultReview.pendingClosure) {
      const pending = state.resultReview.pendingClosure;
      const closure = await closeHandoffOnResult(this.env, state, pending.handoffId, pending.resultNote, workSessionContext(state));
      if (!closure.closed) {
        console.error(`WorkSession ${state.workId}: pending Handoff closure ${pending.handoffId} still refused after review satisfaction: ${closure.reason}`);
      }
    }
    // Derive this Work's canonical Matter identity (its page id) from its
    // token before it is persisted, so the Matter -> current Work pointer
    // can be keyed the same way no matter which Unit learned the Matter
    // first. Derived index only: never throws, and a Work with no Matter
    // identity pays nothing (no KV, no read).
    await ensureMatterIdentity(this.env, state);
    await this.ctx.storage.put("state", state);
    await this.updateRegistry(state);
    return state;
  }

  /**
   * One-shot operational visibility when a Work transitions into
   * `result_review_blocked` (BD-8: "the unresolved state and reason remain
   * visible"). Either the Work awaits an independent Checker verification
   * and says so with the exact reason, or a passing bound verdict already
   * exists and Martin's Result approval card is staged -- its Approve and
   * Reject buttons bound to this exact staged card by token, resolved only
   * through the `resultreview` callback (never free text), with the staged
   * approval consumed on the first decision so a replay finds nothing.
   * Never throws: a failed notification must not fail the Work's save.
   */
  /**
   * Martin's 🔁 Re-check of a Work refused into `result_review_blocked`
   * (2026-11-14). The independent Checker is advisory and no longer part of
   * closure, so this re-presents the one thing the Work is waiting on:
   * where the Action declares output approval closes the Work and the
   * evidence records that approval, it is recorded now; otherwise the Result
   * approval card is staged (or the open one is pointed to). Nothing closes
   * without his approval.
   */
  private async recheckResultReview(state: WorkState): Promise<WorkState> {
    const say = (text: string) => sendMessage(this.env, state.chatId, text, undefined, state.threadId).then(() => state);
    if (state.stage !== RESULT_REVIEW_BLOCKED_STAGE || !state.resultReview) return say("This Work is not waiting on a Result approval -- nothing to re-check.");
    const closed = await recordOutputApprovalAsResultApproval(state);
    if (closed.ok) {
      restoreResultReviewBlockedStage(state);
      return say(RESULT_ACCEPTED_ON_OUTPUT_APPROVAL_MESSAGE);
    }
    const review = state.resultReview;
    if (review.pendingApproval || review.approval) return say("Your Result approval card is already open above.");
    await this.reportResultReviewBlocked(state, review.blockReason);
    return state;
  }

  /**
   * Arms the Checker's advisory second opinion for a draft awaiting Martin's
   * decision, if the Work's Action declares `advisoryAssessment`: a storage
   * flag and an alarm a couple of seconds out, nothing more. The assessment
   * runs from alarm() in its own invocation with its own subrequest budget,
   * after the cycle that produced the draft has SAVED, and never delays
   * Approve, Redo or the webhook. Never throws.
   */
  private async scheduleAdvisoryAssessment(state: WorkState): Promise<void> {
    try {
      const declaration = this.recordedActionResult(state)?.advisoryAssessment;
      if (!declaration || state.stage !== declaration.awaitingStage || !state.pendingActionSummary) return;
      const output = declaration.output(state);
      if (!output?.trim()) return;
      if (state.resultReview?.assessment?.outputHash === (await hashContent(output))) return; // this exact draft was already assessed
      await this.ctx.storage.put(PENDING_ADVISORY_ASSESSMENT_KEY, true);
      // One alarm per Durable Object: if a pickup already armed it, that same
      // firing runs both (alarm() handles the pickup, then the assessment).
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ADVISORY_ASSESSMENT_DELAY_MS);
    } catch (err) {
      console.error(`WorkSession ${state.workId}: could not schedule the advisory assessment (nothing is blocked)`, err);
    }
  }

  /**
   * Sends Martin the Checker's second opinion on a draft awaiting his
   * decision. Runs from alarm(); holds no state while the AI call runs, and
   * re-reads the Work before recording or sending -- so a decision Martin
   * makes meanwhile is never overwritten (the read and the write below share
   * no await) and an assessment of a draft he has moved on from is dropped.
   * Never throws; a missing, late or failed assessment changes nothing.
   */
  private async runPendingAdvisoryAssessment(): Promise<void> {
    try {
      if (!(await this.ctx.storage.get(PENDING_ADVISORY_ASSESSMENT_KEY))) return;
      await this.ctx.storage.delete(PENDING_ADVISORY_ASSESSMENT_KEY); // a re-fired alarm never assesses twice
      const state = await this.getState();
      if (!state) return;
      const declaration = this.recordedActionResult(state)?.advisoryAssessment;
      if (!declaration || state.stage !== declaration.awaitingStage || !state.pendingActionSummary) return;
      const output = declaration.output(state);
      if (!output?.trim()) return;
      const outputHash = await hashContent(output);
      if (state.resultReview?.assessment?.outputHash === outputHash) return;
      const result = await runAdvisoryAssessment(
        { output, request: declaration.request?.(state), criteria: declaration.criteria, unit: state.unit, hat: state.hat },
        advisoryAssessmentDeps(this.env),
      );
      if (!result) return;
      // Re-read the saved Work and record in ONE step (no await between the
      // read and the write), so this can never overwrite a decision Martin
      // made while the assessment ran.
      const fresh = migrateSavedWork(await this.ctx.storage.get<WorkState>("state"));
      if (!fresh) return;
      const delivery = assessmentDelivery(fresh, output, declaration.output, declaration.awaitingStage);
      if (delivery === "skip") return;
      if (fresh.resultReview) {
        fresh.resultReview.assessment = result;
        await this.ctx.storage.put("state", fresh);
      }
      // "🔁 Redo with this note": only while the assessed draft still awaits his
      // decision, only when the Checker recommends a redo with a note, and only
      // where the Action's Hat declares the callback.
      const redoButtons: InlineButton[][] | undefined =
        delivery === "before" && result.recommended === "redo" && result.note && declaration.redoCallbackPrefix
          ? [[{ text: "🔁 Redo with this note", callback_data: `${declaration.redoCallbackPrefix}:${fresh.workId}:go` }]]
          : undefined;
      await sendMessage(this.env, fresh.chatId, formatAdvisoryMessage(result, delivery), redoButtons, fresh.threadId);
    } catch (err) {
      console.error("WorkSession: advisory assessment failed (nothing is blocked)", err);
    }
  }

  private async reportResultReviewBlocked(state: WorkState, reason?: string): Promise<void> {
    try {
      const review = state.resultReview;
      if (review && !review.approval && !review.pendingApproval) {
        const staged = await stageResultReviewApproval(state);
        if (staged.ok) {
          const message =
            `📐 *Result review awaiting your approval*\n\nWork ${state.workId} (${state.unit ?? "unassigned"}/${state.hat ?? "unassigned"}) completed its declared Result. BD-8 requires your Result approval before the Work may close.\n\n${review.assessment ? `\n\n${summarizeAssessment(review.assessment)}` : ""}\n\nApprove or Reject below; the decision is bound to this exact Result and its recorded evidence.`;
          const buttons: InlineButton[][] = [
            [
              { text: "✅ Approve Result", callback_data: resultReviewCallbackData(state.workId, "a", staged.pending.token) },
              { text: "❌ Reject", callback_data: resultReviewCallbackData(state.workId, "r", staged.pending.token) },
            ],
          ];
          await sendMessage(this.env, state.chatId, message, buttons, state.threadId);
          state.pendingActionSummary = {
            label: "Result review: awaiting Martin's Result approval",
            message,
            buttons,
            createdAt: staged.pending.createdAt,
          };
          return;
        }
        console.error(`WorkSession ${state.workId}: could not stage the Result approval card -- ${staged.reason}`);
      }
      await sendMessage(
        this.env,
        state.chatId,
        `⛔ *Work ${state.workId} cannot close yet* (${state.unit ?? "unassigned"}/${state.hat ?? "unassigned"}).\n\n${reason ?? "The Result review gate refused successful closure."}\n\nThe Work stays open with the reason recorded; it keeps running and cancellation is unaffected. Successful closure (and the Handoff's own close) resumes once your Result approval is recorded against this exact Result.`,
        [[{ text: "🔁 Re-check", callback_data: resultReviewCallbackData(state.workId, "c") }]],
        state.threadId,
      );
    } catch (err) {
      console.error(`WorkSession ${state.workId}: failed to report the Result review block`, err);
    }
  }

  private async updateRegistry(state: WorkState): Promise<void> {
    const hasPendingApproval = !!state.pendingActionSummary;
    // Value-level data boundary for this index (Architect ruling): the label
    // is DERIVED from canonical token references (or fixed generic metadata)
    // and never from state.entityName/matterName/enquiryText or a
    // pendingActionSummary label -- those can carry human names, organisation
    // names and raw enquiry text, which must never enter a value that may
    // fall back to Turso. The entityName/matterName fallbacks are accepted
    // only because the role-exact canonical shapes are what is tested
    // (safeEntityTokenRef `ENT-<n>` / safeMatterTokenRef `MAT-<n>`, the live
    // Notion unique_id displays) -- some Sales paths carry the token on the
    // name field, and a real name cannot pass either shape.
    const entityToken = safeEntityTokenRef(state.entityToken) ?? safeEntityTokenRef(state.entityName);
    const matterToken = safeMatterTokenRef(state.matterToken) ?? safeMatterTokenRef(state.matterName);
    const summary: SessionSummary = {
      workId: state.workId,
      unit: state.unit,
      hat: state.hat,
      stage: state.stage,
      label: deriveSessionLabel({ entityToken, matterToken, hasPendingApproval }),
      updatedAt: state.updatedAt,
      hasPendingApproval,
      matterId: state.matterId,
      entityToken,
      matterToken,
    };
    const key = "sessions_index";
    const raw = await kvGet(this.env, key);
    const index: SessionSummary[] = raw ? JSON.parse(raw) : [];
    const withoutSelf = index.filter((s) => s.workId !== state.workId);
    const isTerminal = isTerminalWorkStage(state.stage);
    // Terminal work items drop out of the index (they no longer show as "open").
    const combined = isTerminal ? withoutSelf : [...withoutSelf, summary];

    // Sanitize the WHOLE array, not just this Work's entry: legacy entries
    // written before this contract carry free-text labels, and one save
    // rewrites every entry so no free-text label survives in the stored JSON.
    const kept = trimSessionsIndex(sanitizeSessionsIndex(combined));
    await kvPut(this.env, key, JSON.stringify(kept));

    // Matter continuation (src/matterContinuation.ts): the derived
    // matter_current_work pointer is established/advanced from the index
    // state this very write just made current -- a resumable save makes this
    // Work current only when nothing else resumable already is, and a
    // terminal save advances or removes the pointer. It runs AFTER the index
    // write for exactly that reason (the index is how resumability is read),
    // and never throws: a derived index must not fail the Work it indexes.
    await syncMatterContinuationPointer(this.env, state, isTerminal);

    const pendingCount = combined.filter((s) => s.hasPendingApproval).length;
    await this.alertPendingApprovalBacklog(pendingCount);

    if (isTerminal) {
      const activeKey = `active:${state.chatId}:${state.threadId ?? "dm"}`;
      const active = await kvGet(this.env, activeKey);
      if (active === state.workId) await kvDelete(this.env, activeKey);
      if (state.finance?.threadId !== undefined && state.finance?.threadId !== state.threadId) {
        const financeActiveKey = `active:${state.chatId}:${state.finance?.threadId}`;
        const financeActive = await kvGet(this.env, financeActiveKey);
        if (financeActive === state.workId) await kvDelete(this.env, financeActiveKey);
      }
    }
  }

  /**
   * Fires when the sessions_index pending-approval pool is at or above its
   * cap -- the oldest pending entries may no longer be listed by /sessions.
   * This is a visible operational signal (Operations stream), not a silent
   * eviction: the underlying WorkSession/DO state is never touched or lost
   * by this, only its discoverability via the index. Rate-limited the same
   * way the existing stale-Handoff watchdog in index.ts is.
   */
  private async alertPendingApprovalBacklog(count: number): Promise<void> {
    const key = "pending_approval_backlog_last_alert";
    const lastAlert = await kvGet(this.env, key);
    if (!shouldAlertPendingApprovalBacklog(count, lastAlert, Date.now())) return;
    await sendOperationsMessage(
      this.env,
      `⚠️ ${count} pending approvals now at or above the /sessions index's visible limit (${SESSIONS_INDEX_PENDING_CAP}) -- the oldest may no longer be listed there, though nothing has been deleted. Please work through the backlog via /sessions.`,
    ).catch((err) => console.error("Failed to send pending-approval backlog alert", err));
    await kvPut(this.env, key, String(Date.now())).catch((err) =>
      console.error("Failed to record pending-approval backlog alert timestamp", err),
    );
  }
}
