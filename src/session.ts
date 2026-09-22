import { DurableObject } from "cloudflare:workers";
import type { Env, WorkState, SessionSummary, Unit } from "./types";
import * as sales from "./units/sales/salesExecutive";
import * as finance from "./units/finance/valueBasedPricingAssessor";
import * as marketing from "./hats/executionEngine";
import * as research from "./units/research/researchAnalyst";
import * as strategy from "./units/strategy/strategyAnalyst";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { logActivity } from "./log";
import {
  handleGoogleAccountSelection,
  handleGoogleFolderSelection,
  handleGoogleActionApproval,
} from "./googleOAuth";
import { proposeLeadOpportunity, handleLeadOpportunityApproval } from "./units/sales/leadGenerationDiscovery";
import type { PendingLeadOpportunity } from "./units/sales/leadGenerationDiscovery";
import { SESSIONS_INDEX_PENDING_CAP, trimSessionsIndex, shouldAlertPendingApprovalBacklog } from "./sessionsIndex";
import { closeHandoffIfOpen } from "./handoffLifecycle";

export class WorkSession extends DurableObject<Env> {
  async init(
    workId: string,
    chatId: number,
    unit?: Unit,
    hat?: string,
    threadId?: number,
    extra?: { handoffId?: string; matterId?: string },
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
    await this.save(state);
  }

  async getState(): Promise<WorkState | undefined> {
    return this.ctx.storage.get<WorkState>("state");
  }

  async handleIncomingEnquiry(text: string): Promise<WorkState> {
    return this.execute((state) => sales.handleIncomingEnquiry(this.env, state, text));
  }

  async handleMarketingRequest(text: string): Promise<WorkState> {
    return this.execute((state) => marketing.handleMarketingIntake(this.env, state, text));
  }

  async handleResearchRequest(text: string): Promise<WorkState> {
    return this.execute((state) => research.handleDirectRequest(this.env, state, text));
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
        case "proposal_feedback":
          return sales.handleProposalFeedback(this.env, state, text);
        case "marketing_feedback":
          return marketing.handleMarketingFeedback(this.env, state, text);
        case "marketing_clarification":
          return marketing.handleMarketingClarification(this.env, state, text);
        case "research_clarification":
          return research.handleResearchClarification(this.env, state, text);
        case "research_feedback":
          return research.handleResearchFeedback(this.env, state, text);
        case "strategy_clarification":
          return strategy.handleStrategyClarification(this.env, state, text);
        case "strategy_feedback":
          return strategy.handleStrategyFeedback(this.env, state, text);
        case "strategy_refinement_reason":
          return strategy.handleStrategyRefinement(this.env, state, text);
        default:
          return sendMessage(
            this.env,
            state.chatId,
            "This work item isn't awaiting a reply right now. Use /sessions to switch context.",
            undefined,
            state.threadId,
          ).then(() => state);
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
    return this.execute((state) => finance.handlePickup(this.env, state));
  }

  /**
   * The R&I side of a <Unit> -> Research & Intelligence execution boundary,
   * invoked independently by index.ts's scheduled Research-Handoff
   * discovery once a Pending Handoff addressed to Research & Intelligence
   * is found — mirrors runFinancePickup exactly.
   */
  async runResearchPickup(): Promise<WorkState> {
    return this.execute((state) => research.handlePickup(this.env, state));
  }

  /**
   * Invoked independently by index.ts's scheduled Strategy-Handoff
   * discovery once a Pending Handoff addressed to Strategy is found --
   * mirrors runFinancePickup/runResearchPickup exactly.
   */
  async runStrategyPickup(): Promise<WorkState> {
    return this.execute((state) => strategy.handlePickup(this.env, state));
  }

  /**
   * The Marketing side of the Research & Intelligence -> Marketing
   * execution boundary, invoked independently by index.ts's scheduled
   * Marketing-Handoff discovery once a Pending Handoff addressed to
   * Marketing is found — mirrors runFinancePickup/runResearchPickup.
   */
  async runMarketingHandoffPickup(): Promise<WorkState> {
    return this.execute((state) => marketing.handleHandoffPickup(this.env, state));
  }

  /**
   * The return-leg mirror of runFinancePickup: invoked independently by
   * index.ts's scheduled Sales-Handoff discovery (never by Finance
   * directly) once a Pending Handoff addressed to Sales is found — the
   * approved quote queued by finance.handleQuoteApproval. Finance's own
   * call already returned before this ever runs.
   */
  async runProposalDrafting(): Promise<WorkState> {
    return this.execute((state) => sales.handleQuoteReceived(this.env, state));
  }

  /**
   * Presents an evidence-backed opportunity finding to Martin for explicit
   * approval before it may become a Lead -- invoked on a freshly created
   * WorkSession (see processCompletedLGSResearchHandoffs in
   * leadGenerationDiscovery.ts), the same way discoverPendingFinanceHandoffs
   * creates a session for an externally-originated Handoff with no live
   * chat behind it.
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
          await closeHandoffIfOpen(
            this.env,
            state.handoffId,
            "Work item cancelled by Martin -- rejected with no further direction. A materially new attempt requires a new Handoff.",
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
        case "entitynew":
          return sales.handleEntityCreationApproval(this.env, state, value === "approve");
        case "matter":
          return sales.handleMatterChoice(this.env, state, value);
        case "matternew":
          return sales.handleMatterCreationApproval(this.env, state, value === "approve");
        case "qualify":
          return sales.handleLeadToProspectApproval(this.env, state, value === "approve");
        case "proposal":
          return sales.handleProposalApproval(this.env, state, value === "approve");
        case "quote":
          return finance.handleQuoteApproval(this.env, state, value === "approve");
        case "markettransition":
          return marketing.handleTransitionApproval(this.env, state, value === "approve");
        case "marketdraft":
          return marketing.handleDraftApproval(this.env, state, value === "approve");
        case "marketpaid":
          return marketing.handlePaidMediaApproval(this.env, state, value === "approve");
        case "researchhandoff":
          return research.handleResearchHandoffApproval(this.env, state, value === "approve");
        case "strategyhandoff":
          return strategy.handleStrategyHandoffApproval(this.env, state, value === "approve");
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
        case "googleaccount":
          return handleGoogleAccountSelection(this.env, state, value);
        case "googlefolder":
          return handleGoogleFolderSelection(this.env, state, value);
        case "googleaction":
          return handleGoogleActionApproval(this.env, state, value === "approve");
        case "leadopportunity":
          return handleLeadOpportunityApproval(this.env, state, value === "approve");
        default:
          return Promise.resolve(state);
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
  private async execute(fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState> {
    const state = await this.require();
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
