import { DurableObject } from "cloudflare:workers";
import type { Env, WorkState, SessionSummary, Unit } from "./types";
import * as sales from "./hats/salesExecutive";
import * as finance from "./hats/financeValueBasedPricing";
import { sendMessage } from "./telegram";

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
    const state = await this.require();
    return this.save(await sales.handleIncomingEnquiry(this.env, state, text));
  }

  async handleTextReply(text: string): Promise<WorkState> {
    const state = await this.require();
    switch (state.awaiting) {
      case "call_notes":
        return this.save(await sales.handleCallNotes(this.env, state, text));
      case "intervention":
        return this.save(await sales.handleInterventionText(this.env, state, text));
      case "value_context_more":
        return this.save(await sales.handleMoreValueContext(this.env, state, text));
      case "proposal_feedback":
        return this.save(await sales.handleProposalFeedback(this.env, state, text));
      default:
        await sendMessage(this.env, state.chatId, "This work item isn't awaiting a reply right now. Use /sessions to switch context.", undefined, state.threadId);
        return state;
    }
  }

  /**
   * Invoked independently by index.ts's scheduled Finance-Handoff discovery
   * (never by SM&BD directly) once a Pending Handoff addressed to Finance is
   * found. This is the actual cross-Unit execution boundary: SM&BD's own
   * call already returned before this ever runs.
   */
  async runFinancePickup(): Promise<WorkState> {
    const state = await this.require();
    return this.save(await finance.handlePickup(this.env, state));
  }

  async handleCallback(action: string, value: string): Promise<WorkState> {
    const state = await this.require();
    switch (action) {
      case "entity":
        return this.save(await sales.handleEntityChoice(this.env, state, value));
      case "matter":
        return this.save(await sales.handleMatterChoice(this.env, state, value));
      case "qualify":
        return this.save(await sales.handleLeadToProspectApproval(this.env, state, value === "approve"));
      case "proposal":
        return this.save(await sales.handleProposalApproval(this.env, state, value === "approve"));
      default:
        return state;
    }
  }

  private async require(): Promise<WorkState> {
    const state = await this.getState();
    if (!state) throw new Error("Work session state missing");
    return state;
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
    const isTerminal = state.stage === "complete" || state.stage === "closed_not_qualified";
    // Terminal work items drop out of the index (they no longer show as "open").
    const kept = isTerminal ? withoutSelf.slice(-50) : [...withoutSelf, summary].slice(-50);
    await this.env.STATE_KV.put(key, JSON.stringify(kept));
    if (isTerminal) {
      const activeKey = `active:${state.chatId}`;
      const active = await this.env.STATE_KV.get(activeKey);
      if (active === state.workId) await this.env.STATE_KV.delete(activeKey);
    }
  }
}
