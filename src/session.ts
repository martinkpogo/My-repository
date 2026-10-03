import { DurableObject } from "cloudflare:workers";
import type { Env, WorkState, SessionSummary, Unit } from "./types";
import * as sales from "./units/sales/salesExecutive";
import * as finance from "./units/finance/valueBasedPricingAssessor";
import * as marketing from "./hats/executionEngine";
import * as strategy from "./units/strategy/strategyAnalyst";
import type { ActionExecutionContext } from "./runtime/actionResolution";
import { bindExecutionSkills, runWithRecordedActionSkills } from "./runtime/actionSkills";
import { SkillResolutionError, type ResolvedActionSkillSet } from "./platform/skillRegistry";
import * as salesProposal from "./units/sales/tokenSafeProposal";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { logActivity } from "./log";
import {
  handleGoogleAccountSelection,
  handleGoogleFolderSelection,
  handleGoogleActionApproval,
} from "./googleOAuth";
import { proposeLeadOpportunity } from "./units/sales/leadGenerationDiscovery";
import type { PendingLeadOpportunity } from "./units/sales/leadGenerationDiscovery";
import { SESSIONS_INDEX_PENDING_CAP, trimSessionsIndex, shouldAlertPendingApprovalBacklog } from "./sessionsIndex";
import { closeHandoffIfOpen } from "./handoffLifecycle";
import { findUnitManifest } from "./units/registry";
import { findCallbackHandler } from "./units/unitManifest";
import { recordWorkAction } from "./units/dispatch";
import { workSessionContext } from "./access";

export class WorkSession extends DurableObject<Env> {
  async init(
    workId: string,
    chatId: number,
    unit?: Unit,
    hat?: string,
    threadId?: number,
    extra?: { handoffId?: string; matterId?: string; actionName?: string },
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
    return this.ctx.storage.get<WorkState>("state");
  }

  // Marketing's own intake resolves WHICH Marketing Hat owns a direct
  // request (executionEngine.handleMarketingIntake runs Stage 1 itself) and
  // captures the task text -- so unlike every other manifest Unit, Marketing
  // still enters through this dedicated wrapper rather than the generic
  // handleUnitAction below, and records its Action for the same reason it
  // does (resolve Hat -> resolve Action -> persist Action identity on Work
  // -> execute). Documented as a known migration gap: moving Marketing onto
  // the Organization boundary means moving its Hat interpretation ahead of
  // dispatch, with its relationship-based tie-breaking preserved.
  async handleMarketingRequest(text: string): Promise<WorkState> {
    return this.execute((state) => {
      recordWorkAction(state, "handle_request");
      return marketing.handleMarketingIntake(this.env, state, text);
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
      switch (state.awaiting) {
        case "call_notes":
          return sales.handleCallNotes(this.env, state, text);
        case "intervention":
          return sales.handleInterventionText(this.env, state, text);
        case "value_context_more":
          return sales.handleMoreValueContext(this.env, state, text);
        case "quote_redo_reason":
          return finance.handleQuoteRedoReason(this.env, state, text);
        case "matter_redo_reason":
          return sales.handleMatterRedoReason(this.env, state, text);
        case "entity_redo_reason":
          return sales.handleEntityRedoReason(this.env, state, text);
        case "sales_proposal_revision":
          return salesProposal.handleSalesProposalRevisionText(this.env, state, text);
        case "marketing_feedback":
          return marketing.handleMarketingFeedback(this.env, state, text);
        case "marketing_clarification":
          return marketing.handleMarketingClarification(this.env, state, text);
        case "strategy_clarification":
          return strategy.handleStrategyClarification(this.env, state, text);
        case "strategy_direct_request_matter":
          return strategy.handleDirectRequestClarification(this.env, state, text);
        case "finance_direct_request_matter":
          return finance.handleDirectRequestClarification(this.env, state, text);
        case "finance_direct_request_context":
          return finance.handleDirectRequestContext(this.env, state, text);
        case "strategy_feedback":
          return strategy.handleStrategyFeedback(this.env, state, text);
        case "strategy_refinement_reason":
          return strategy.handleStrategyRefinement(this.env, state, text);
        default: {
          // Generic manifest lookup for a Unit built on the Unit Registry
          // pattern -- checked only as a fallback, after every existing
          // hand-written case above, so no legacy Unit's behavior changes.
          // Per the design doc's fail-closed manifest completeness: a
          // state.awaiting value the resolved Hat doesn't declare in its
          // own awaitingHandlers still falls through to the same "not
          // awaiting" message below, never a silent no-op.
          const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
          const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
          const awaitingHandler = hat && state.awaiting ? hat.awaitingHandlers[state.awaiting] : undefined;
          if (awaitingHandler && hat) {
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
        }
      }
    });
  }

  /**
   * Invoked independently by index.ts's scheduled Finance-Handoff discovery
   * (never by Sales directly) once a Pending Handoff addressed to Finance is
   * found. This is the actual cross-Unit execution boundary: Sales's own
   * call already returned before this ever runs.
   */
  async runFinancePickup(): Promise<WorkState> {
    return this.execute((state) => this.runUnderRecordedSkills(state, (skills) => finance.handlePickup(this.env, state, skills)));
  }

  /**
   * Invoked independently by index.ts's scheduled Strategy-Handoff
   * discovery once a Pending Handoff addressed to Strategy is found --
   * mirrors runFinancePickup exactly.
   */
  async runStrategyPickup(): Promise<WorkState> {
    return this.execute((state) => this.runUnderRecordedSkills(state, (skills) => strategy.handlePickup(this.env, state, skills)));
  }

  /**
   * The Marketing side of a <Unit> -> Marketing execution boundary,
   * invoked independently by index.ts's scheduled Marketing-Handoff
   * discovery once a Pending Handoff addressed to Marketing is found —
   * mirrors runFinancePickup.
   */
  async runMarketingHandoffPickup(): Promise<WorkState> {
    return this.execute((state) => this.runUnderRecordedSkills(state, (skills) => marketing.handleHandoffPickup(this.env, state, skills)));
  }

  /**
   * Runtime Sales Executive pickup of a Finance -> Sales Handoff: produces
   * the one canonical token-safe Proposal and asks Martin to authorize its
   * exact Version (see units/sales/tokenSafeProposal.ts). Invoked only by
   * checkHandoffs.ts's Sales discovery, never by Finance directly.
   */
  async runTokenSafeProposal(): Promise<WorkState> {
    return this.execute((state) => this.runUnderRecordedSkills(state, (skills) => salesProposal.handleProposalHandoffPickup(this.env, state, skills)));
  }

  /**
   * Runtime Sales Executive pickup of a call-notes Handoff created by the
   * isolated Sales Executive Claude project (Section 6A of its Project
   * Instructions) -- runs the commercial-value-evidence-extraction and
   * qualification reasoning against the Handoff's already de-identified
   * content. Invoked only by checkHandoffs.ts's Sales discovery, never
   * directly. Mirrors runFinancePickup/runTokenSafeProposal exactly.
   */
  async runCallNotesPickup(): Promise<WorkState> {
    return this.execute((state) => this.runUnderRecordedSkills(state, (skills) => sales.handleCallNotesHandoffPickup(this.env, state, skills)));
  }

  /**
   * Presents an evidence-backed opportunity finding to Martin for explicit
   * approval before it may become a Lead -- invoked on a freshly created
   * WorkSession with no live chat behind it. Currently has no caller:
   * the only one (the Research & Intelligence Handoff consumer) was
   * removed with that retired Unit, and the owning Action that will feed
   * this gate is not yet designed.
   */
  async proposeLeadOpportunity(opportunity: PendingLeadOpportunity): Promise<WorkState> {
    return this.execute((state) => proposeLeadOpportunity(this.env, state, opportunity));
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
      state.pendingStrategyApproval = undefined;
      state.pendingStrategyHandoff = undefined;
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
    return this.execute((state) => {
      switch (action) {
        case "entity":
          return sales.handleEntityChoice(this.env, state, value);
        case "matter":
          return sales.handleMatterChoice(this.env, state, value);
        case "sprop": {
          // value is "<proposalVersion>.<a|r|j>" -- joined with "." (not
          // ":") specifically so it survives index.ts's plain
          // data.split(":") destructure into [action, workId, value]
          // unchanged. Deliberately compact: Telegram's callback_data has a
          // hard 64-byte limit, and workId alone (a 36-char UUID, required
          // for index.ts to resolve the right WorkSession) already leaves
          // no room for a second UUID -- see developStrategyProposal's
          // button construction for the full rationale.
          const dot = value.lastIndexOf(".");
          const versionStr = dot === -1 ? "" : value.slice(0, dot);
          const decisionChar = dot === -1 ? "" : value.slice(dot + 1);
          const proposalVersion = Number(versionStr);
          const decision = decisionChar === "a" ? "approve" : decisionChar === "r" ? "refine" : decisionChar === "j" ? "reject" : "";
          if ((decision !== "approve" && decision !== "refine" && decision !== "reject") || !Number.isFinite(proposalVersion)) {
            return Promise.resolve(state);
          }
          return strategy.handleInterventionApproval(this.env, state, proposalVersion, decision);
        }
        case salesProposal.PROPOSAL_CALLBACK_ACTION: {
          // value is "<proposalNumber>.<version>.<a|r>" -- binds the decision
          // to the exact Proposal ID + Version; "." keeps it intact through
          // index.ts's split(":") and well under Telegram's 64-byte limit.
          const m = value.match(/^(\d+)\.(\d+)\.([ar])$/);
          if (!m) return Promise.resolve(state);
          return salesProposal.handleSalesProposalDecision(
            this.env,
            state,
            Number(m[1]),
            Number(m[2]),
            m[3] === "a" ? "approve" : "revise",
          );
        }
        case "googleaccount":
          return handleGoogleAccountSelection(this.env, state, value);
        case "googlefolder":
          return handleGoogleFolderSelection(this.env, state, value);
        case "googleaction":
          return handleGoogleActionApproval(this.env, state, value === "approve");
        default: {
          // Generic manifest lookup for an approval-callback prefix a Hat
          // has migrated onto HatManifest.callbackHandlers -- checked only
          // as a fallback, after every existing hand-written case above, so
          // no legacy prefix's behavior changes. Mirrors handleTextReply's
          // own default-case manifest fallback for awaitingHandlers.
          const manifest = state.unit ? findUnitManifest(state.unit) : undefined;
          const hat = manifest && state.hat ? manifest.hats[state.hat] : undefined;
          const callbackHandler = hat ? findCallbackHandler(action, hat) : undefined;
          if (callbackHandler) {
            return callbackHandler(this.env, state, value === "approve");
          }
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

  private async execute(fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState> {
    const state = await this.require();
    // Reset every call -- see WorkState.pendingHandoffAutoCheck's doc
    // comment. Only the specific handler invoked by fn() below may set
    // this true again, so a caller inspecting the returned state never
    // sees a stale signal left over from an earlier, unrelated call.
    state.pendingHandoffAutoCheck = false;
    try {
      return await this.save(await fn(state));
    } catch (err) {
      console.error(`WorkSession ${state.workId} execution failed`, err);
      const detail = err instanceof Error ? err.message : String(err);
      await sendOperationsMessage(
        this.env,
        `⚠️ WorkSession ${state.workId} (${state.unit ? `${state.unit}/${state.hat}` : "Standalone Capability"}) execution failed: ${detail.slice(0, 500)}`,
      ).catch((notifyErr) => console.error(`WorkSession ${state.workId} failure notification also failed`, notifyErr));
      return state;
    }
  }

  private async save(state: WorkState): Promise<WorkState> {
    state.updatedAt = new Date().toISOString();
    await this.ctx.storage.put("state", state);
    await this.updateRegistry(state);
    return state;
  }

  private async updateRegistry(state: WorkState): Promise<void> {
    const hasPendingApproval = !!state.pendingActionSummary;
    const summary: SessionSummary = {
      workId: state.workId,
      unit: state.unit,
      hat: state.hat,
      stage: state.stage,
      label: state.pendingActionSummary?.label ?? state.entityName ?? state.matterName ?? state.enquiryText?.slice(0, 40) ?? "(new)",
      updatedAt: state.updatedAt,
      hasPendingApproval,
    };
    const key = "sessions_index";
    const raw = await this.env.STATE_KV.get(key);
    const index: SessionSummary[] = raw ? JSON.parse(raw) : [];
    const withoutSelf = index.filter((s) => s.workId !== state.workId);
    const isTerminal = state.stage === "complete" || state.stage === "closed_not_qualified" || state.stage === "cancelled";
    // Terminal work items drop out of the index (they no longer show as "open").
    const combined = isTerminal ? withoutSelf : [...withoutSelf, summary];

    const kept = trimSessionsIndex(combined);
    await this.env.STATE_KV.put(key, JSON.stringify(kept));

    const pendingCount = combined.filter((s) => s.hasPendingApproval).length;
    await this.alertPendingApprovalBacklog(pendingCount);

    if (isTerminal) {
      const activeKey = `active:${state.chatId}:${state.threadId ?? "dm"}`;
      const active = await this.env.STATE_KV.get(activeKey);
      if (active === state.workId) await this.env.STATE_KV.delete(activeKey);
      if (state.financeThreadId !== undefined && state.financeThreadId !== state.threadId) {
        const financeActiveKey = `active:${state.chatId}:${state.financeThreadId}`;
        const financeActive = await this.env.STATE_KV.get(financeActiveKey);
        if (financeActive === state.workId) await this.env.STATE_KV.delete(financeActiveKey);
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
    const lastAlert = await this.env.STATE_KV.get(key);
    if (!shouldAlertPendingApprovalBacklog(count, lastAlert, Date.now())) return;
    await sendOperationsMessage(
      this.env,
      `⚠️ ${count} pending approvals now at or above the /sessions index's visible limit (${SESSIONS_INDEX_PENDING_CAP}) -- the oldest may no longer be listed there, though nothing has been deleted. Please work through the backlog via /sessions.`,
    ).catch((err) => console.error("Failed to send pending-approval backlog alert", err));
    await this.env.STATE_KV.put(key, String(Date.now())).catch((err) =>
      console.error("Failed to record pending-approval backlog alert timestamp", err),
    );
  }
}
