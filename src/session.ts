import { DurableObject } from "cloudflare:workers";
import type { Env, WorkState, SessionSummary, Unit } from "./types";
import * as sales from "./hats/salesExecutive";
import * as finance from "./hats/financeValueBasedPricing";
import * as marketing from "./hats/marketingEngine";
import { sendMessage } from "./telegram";
import { logActivity } from "./log";

export class WorkSession extends DurableObject<Env> {
  async init(workId: string, chatId: number, unit: Unit, hat: string, threadId?: number): Promise<void> {
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
   * (never by SM&BD directly) once a Pending Handoff addressed to Finance is
   * found. This is the actual cross-Unit execution boundary: SM&BD's own
   * call already returned before this ever runs.
   */
  async runFinancePickup(): Promise<WorkState> {
    return this.execute((state) => finance.handlePickup(this.env, state));
  }

  /**
   * The return-leg mirror of runFinancePickup: invoked independently by
   * index.ts's scheduled SM&BD-Handoff discovery (never by Finance
   * directly) once a Pending Handoff addressed to SM&BD is found — the
   * approved quote queued by finance.handleQuoteApproval. Finance's own
   * call already returned before this ever runs.
   */
  async runProposalDrafting(): Promise<WorkState> {
    return this.execute((state) => sales.handleQuoteReceived(this.env, state));
  }

  async cancel(): Promise<WorkState> {
    return this.execute(async (state) => {
      state.stage = "cancelled";
      state.awaiting = undefined;
      await logActivity(this.env, {
        entry: `Work item cancelled: ${state.entityName ?? state.matterName ?? state.workId}`,
        type: "Activity",
        area: state.unit,
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
      await sendMessage(
        this.env,
        state.chatId,
        `⚠️ Something went wrong processing this work item. The error has been logged for review and nothing further was changed — try again, or use /sessions to check its current state.`,
        undefined,
        state.threadId,
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
    const summary: SessionSummary = {
      workId: state.workId,
      unit: state.unit,
      hat: state.hat,
      stage: state.stage,
      label: state.entityName ?? state.matterName ?? state.enquiryText?.slice(0, 40) ?? "(new)",
      updatedAt: state.updatedAt,
    };
    const key = "sessions_index";
    const raw = await this.env.STATE_KV.get(key);
    const index: SessionSummary[] = raw ? JSON.parse(raw) : [];
    const withoutSelf = index.filter((s) => s.workId !== state.workId);
    const isTerminal = state.stage === "complete" || state.stage === "closed_not_qualified" || state.stage === "cancelled";
    // Terminal work items drop out of the index (they no longer show as "open").
    const kept = isTerminal ? withoutSelf.slice(-50) : [...withoutSelf, summary].slice(-50);
    await this.env.STATE_KV.put(key, JSON.stringify(kept));
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
}
