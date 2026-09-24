import type { Env } from "./types";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { generalChatReply, generalDmReply } from "./chat";
import { maybeAutoContinueCheckHandoffs } from "./checkHandoffs";
import { LeadOpportunityDiscoveryCapability } from "./units/sales/leadGenerationDiscovery";
import { resolveWorkspaceRouting, type WorkspaceDecision } from "./workspaceRouter";
import {
  getActiveWorkId,
  getReplyMessageWorkId,
  getSessionStub,
  newWorkId,
  resolveStreamForThread,
  SALES_EXECUTIVE_PAUSED,
  setActiveWorkId,
} from "./sessionRouting";

// Every primitive previously defined directly in this file (newWorkId,
// getActiveWorkId/setActiveWorkId, getReplyMessageWorkId/
// setReplyMessageWorkId, getSessionStub, resolveStreamForThread/
// resolveUnitForThread/threadIdForUnit, SALES_EXECUTIVE_PAUSED) now lives in
// sessionRouting.ts -- re-exported here so every existing `from "./router"`
// import keeps working unchanged. See sessionRouting.ts's doc comment for
// why: checkHandoffs.ts needs these same primitives, and this file now
// needs to call back into checkHandoffs.ts (maybeAutoContinueCheckHandoffs,
// below) -- splitting the primitives out breaks that circular dependency.
export * from "./sessionRouting";

// Every other Unit's chat is business_sensitive (see chatSensitivityForUnit
// in chat.ts) and should normally succeed, so seeing this message there
// points to a genuine provider failure, not policy.
const AI_UNAVAILABLE_MESSAGE =
  "Couldn't generate a reply -- no AI provider is currently available. This points to a genuine provider failure, not an access restriction; please try again shortly.";

// User-facing text for a Sales enquiry that arrives while
// SALES_EXECUTIVE_PAUSED is true. Kept as one constant so the DM path and
// the Workspace-stream path can't drift apart.
const SALES_PAUSED_MESSAGE =
  "Sales Executive intake is paused here in this runtime by standing policy until an AI provider with an acceptable personal-data/training policy is available. This enquiry was not processed here -- it is being handled by the isolated Sales Executive project in Claude (with its own Notion and Gmail access), which owns and actively works this domain now.";

export async function routeIncomingText(
  env: Env,
  chatId: number,
  text: string,
  threadId?: number,
  options: {
    forceNewEnquiry?: boolean;
    replyToMessageId?: number;
    // Test-only injection seam, mirroring the AiPolicyExecutor injection
    // pattern already used in ai/policy.ts. Production callers never pass
    // this -- the real resolveWorkspaceRouting always runs. It exists so
    // tests can verify routeIncomingText/dispatchCowork's own dispatch
    // logic (which Unit/capability a given WorkspaceDecision reaches)
    // without depending on real KV-backed mode/clarification state.
    resolveRouting?: typeof resolveWorkspaceRouting;
  } = {},
): Promise<void> {
  if (text.startsWith("/")) return; // commands handled by caller

  if (!options.forceNewEnquiry) {
    // 1. Existing WorkSession association -- takes precedence over Workspace
    // mode entirely. Continuing already-governed work is never re-routed
    // through mode/responsibility resolution.

    // 1a. Explicit reply-to-message association (reply_msg:<messageId> -> workId)
    if (options.replyToMessageId) {
      const matchedWorkId = await getReplyMessageWorkId(env, options.replyToMessageId);
      if (matchedWorkId) {
        const stub = getSessionStub(env, matchedWorkId);
        const state = await stub.getState();
        if (state && state.awaiting) {
          const result = await stub.handleTextReply(text);
          await maybeAutoContinueCheckHandoffs(env, chatId, threadId, result);
          return;
        }
      }
    }

    // 1b. Active pointer check for non-DM topic streams
    const streamType = resolveStreamForThread(env, threadId);
    if (streamType !== "dm") {
      const activeId = await getActiveWorkId(env, chatId, threadId);
      if (activeId) {
        const stub = getSessionStub(env, activeId);
        const state = await stub.getState();
        if (state && state.awaiting) {
          const result = await stub.handleTextReply(text);
          await maybeAutoContinueCheckHandoffs(env, chatId, threadId, result);
          return;
        }
      }
    }
  }

  const groupChatId = env.TELEGRAM_GROUP_CHAT_ID ? Number(env.TELEGRAM_GROUP_CHAT_ID) : undefined;
  if (groupChatId !== undefined && chatId === groupChatId && threadId === undefined) {
    // General/main chat in supergroup: not an interactive Hat workspace. Fail closed.
    return;
  }

  if (threadId === undefined) {
    // Private DM: not an ENIG interactive workspace. Fail closed.
    return;
  }

  const streamType = resolveStreamForThread(env, threadId);
  if (streamType === "unmapped") {
    await sendMessage(env, chatId, "This topic isn't mapped to a Stream yet.", undefined, threadId);
    return;
  }

  if (streamType === "operations") {
    await sendMessage(
      env,
      chatId,
      "The Operations topic is reserved for background operational telemetry and system reporting. Interactive requests should be sent in the Workspace topic.",
      undefined,
      threadId,
    );
    return;
  }

  // Workspace stream, no existing WorkSession association. 2. Explicit
  // Workspace mode decides Chat vs Cowork -- fully deterministic, no AI
  // provider call anywhere in resolveWorkspaceRouting (see
  // workspaceRouter.ts). This is still only a routing decision: every
  // governed Unit entry point below runs in full, unmodified, with every
  // approval/Handoff/token-boundary/fail-closed check it already had.
  const resolveRouting = options.resolveRouting ?? resolveWorkspaceRouting;
  const decision = await resolveRouting(env, chatId, threadId, text);

  if (decision.mode === "blocked") {
    return;
  }

  if (decision.mode === "clarify") {
    await sendMessage(env, chatId, decision.question, undefined, threadId);
    return;
  }

  if (decision.mode === "chat") {
    // 3. Workspace mode = Chat. Ordinary Chat is a plain conversational
    // reply only -- it does not dispatch through the generic Workspace
    // capability registry (routeWorkspaceCapabilityAction). The currently
    // registered capabilities (Google Doc/Sheet creation, Lead Opportunity
    // Discovery) can themselves create a WorkSession or a Handoff, which
    // is governed state Chat must never create merely because an arbitrary
    // message arrived while mode is Chat -- see the read-only Chat
    // capability boundary inspection this correction resolves. Cowork
    // remains the entry point into governed capability/workflow paths
    // that are already wired to it (see dispatchCowork below); this
    // restores the boundary that existed before this Workspace mode
    // change, without altering the capabilities' own implementations.
    const reply = decision.unit
      ? await generalChatReply(env, decision.unit, chatId, threadId, text)
      : await generalDmReply(env, chatId, threadId, text);
    await sendMessage(env, chatId, reply || AI_UNAVAILABLE_MESSAGE, undefined, threadId);
    return;
  }

  // decision.mode === "cowork" from here.
  await dispatchCowork(env, chatId, threadId, text, decision);
}

/**
 * Enters the existing governed execution path for a "cowork" routing
 * decision. This function selects WHICH existing entry point to call; it
 * does not reimplement any of them. Every Unit dispatched to here uses the
 * exact same stub.init(...) + handle*Request(...) call, and the exact same
 * approval/Handoff/token-safety/fail-closed gates inside it, as before this
 * router existed. A Unit with no existing chat-triggered governed entry
 * point (Business Development, Finance, Strategy, Creative & Design,
 * Operations -- Finance and Strategy are only ever entered via a Handoff
 * from another Unit today, never directly from chat) fails closed with an
 * explicit message rather than inventing a new execution path.
 */
export async function dispatchCowork(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  text: string,
  decision: Extract<WorkspaceDecision, { mode: "cowork" }>,
): Promise<void> {
  if (decision.unit === "Sales") {
    if (decision.hat === "Lead Generation Specialist") {
      // Lead Discovery is a separate specialization from Sales Progression
      // intake -- independent of SALES_EXECUTIVE_PAUSED by design (see
      // sessionRouting.ts's own doc comment: Lead Discovery runs in this
      // shared Worker regardless of whether Sales Progression is paused,
      // the two are independent). Calls the capability's own governed
      // intake directly -- the same lead.discovery_ondemand_intake path
      // the /lead command and the (now Cowork-only) capability dispatch
      // already used, just entered deterministically via Cowork
      // responsibility resolution instead of generic capability matching.
      // No WorkSession is created here -- this capability never creates
      // one (confirmed by the Chat capability boundary audit); it acts
      // directly on chatId/threadId and queues its own Handoffs to R&I.
      const handled = await LeadOpportunityDiscoveryCapability.handleIntake(env, chatId, text, threadId);
      if (!handled) {
        await sendMessage(
          env,
          chatId,
          `That didn't look like a discovery request to Lead Generation Specialist -- try something like "find me 3 companies showing a positioning problem."`,
          undefined,
          threadId,
        );
      }
      return;
    }

    if (SALES_EXECUTIVE_PAUSED) {
      console.error(`Sales Executive intake paused — enquiry not processed (chat ${chatId})`);
      await sendMessage(env, chatId, SALES_PAUSED_MESSAGE, undefined, threadId);
      return;
    }
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Sales", decision.hat ?? "Sales Executive", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleIncomingEnquiry(text);
    return;
  }

  if (decision.unit === "Marketing") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Marketing", decision.hat ?? "Marketing", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleMarketingRequest(text);
    return;
  }

  if (decision.unit === "Research & Intelligence") {
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Research & Intelligence", decision.hat ?? "Research & Intelligence Analyst", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleResearchRequest(text);
    return;
  }

  if (decision.unit === "Strategy") {
    // direct_request origination path (ENIG Operating Model design doc,
    // Migration path Step 4) -- routes into strategy.handleDirectRequest,
    // the same governed diagnosis pipeline handlePickup uses, never a
    // parallel implementation.
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Strategy", decision.hat ?? "Strategy Analyst", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleStrategyRequest(text);
    return;
  }

  // Business Development, Finance, Creative & Design, Operations: no
  // existing chat-triggered governed entry point. Finance is only ever
  // entered via a Handoff from another Unit's own governed workflow today
  // -- fabricating a direct-chat entry point here would be a parallel
  // execution implementation, not routing into an existing one.
  console.error(`Workspace router: Cowork resolved for ${decision.unit}, which has no existing chat-triggered governed entry point (chat ${chatId})`);
  // This is a genuine UNSUPPORTED resolution -- responsibility resolved
  // correctly, but no execution path exists for it. The reply below goes
  // only to the Workspace topic it came from, reading like any other
  // response; without this, the fact that Cowork dispatch is a known no-op
  // for this Unit is invisible everywhere else. Mirrors the same
  // Operations-visibility pattern already used for other operational
  // signals (see e.g. WorkSession's alertPendingApprovalBacklog).
  await sendOperationsMessage(
    env,
    `⚠️ Cowork resolved to ${decision.unit}${decision.hat ? `/${decision.hat}` : ""}, which has no existing chat-triggered governed entry point -- nothing was started. (chat ${chatId})`,
  ).catch((err) => console.error("Failed to send UNSUPPORTED-Unit Operations notice", err));
  await sendMessage(
    env,
    chatId,
    `ENIG doesn't yet have a way to start governed ${decision.unit} work directly from chat in this runtime -- that Unit's governed work currently only begins via an existing workflow (e.g. a Handoff from another Unit). Nothing was started.`,
    undefined,
    threadId,
  );
}
