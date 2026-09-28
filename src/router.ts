import type { Env } from "./types";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { generalChatReply, generalDmReply } from "./chat";
import { maybeAutoContinueCheckHandoffs } from "./checkHandoffs";
import { resolveWorkspaceRouting, type WorkspaceDecision } from "./workspaceRouter";
import { classifyDataLookupRequest, runConversationalDataLookup } from "./dataLookup";
import { findUnitManifest } from "./units/registry";
import { resolveUnitRequest, tryResolveUnitAction } from "./units/dispatch";
import {
  getActiveWorkId,
  getReplyMessageWorkId,
  getSessionStub,
  newWorkId,
  resolveStreamForThread,
  setActiveWorkId,
} from "./sessionRouting";

// Every primitive previously defined directly in this file (newWorkId,
// getActiveWorkId/setActiveWorkId, getReplyMessageWorkId/
// setReplyMessageWorkId, getSessionStub, resolveStreamForThread/
// resolveUnitForThread/threadIdForUnit) now lives in
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
    // Test-only injection seam for Chat's Unit manifest lookup, same
    // rationale as resolveRouting above. Production callers never pass
    // this -- the real findUnitManifest always runs. Exists so tests can
    // exercise Chat mode's action-dispatch wiring (tryResolveUnitAction)
    // against a toy UnitManifest instead of depending on a real Unit's
    // full business logic and registered AI tasks.
    resolveUnitManifestForChat?: typeof findUnitManifest;
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

  // A conversation about what's in one of ENIG's own databases -- checked
  // here, before mode resolution, for the same reason the /lookup command
  // (index.ts) is never mode-dependent: it never creates or touches
  // governed work, only reads, so there is no reason a plain lookup
  // question ("check the Matters database") should ever hit Cowork's
  // Unit/Hat ownership clarification gate just because free text with no
  // explicit addressee is currently unresolved in that mode. Deliberately
  // bypasses any pending Cowork clarification too -- the original governed
  // request that triggered it is untouched and will still be asked about
  // on the next non-lookup message.
  //
  // Runs unconditionally ahead of every other message in this stream now
  // (not just Chat mode's own fallback, as before), so a failure here must
  // never take down message processing for a completely unrelated
  // enquiry/Cowork dispatch -- fail open into ordinary routing below,
  // exactly like recentActivitySnapshot's own Notion-read fallback in
  // chat.ts, rather than letting the webhook's top-level catch turn every
  // message into "something went wrong" whenever the classifier, the
  // lookup's own Notion read, or the conversational reply has a transient
  // failure.
  let lookupReply: string | undefined;
  try {
    const lookup = await classifyDataLookupRequest(env, text);
    if (lookup) lookupReply = await runConversationalDataLookup(env, chatId, threadId, lookup.source, lookup.filter, text);
  } catch (err) {
    console.error("Data lookup check failed -- falling through to ordinary Workspace routing", err);
  }
  if (lookupReply !== undefined) {
    await sendMessage(env, chatId, lookupReply, undefined, threadId);
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
    // 3. Workspace mode = Chat. Per the ENIG Operating Model design doc's
    // 2026-09-28 decision ("Chat is action-capable, not read-only"), Chat
    // now attempts the same Unit/Hat/Action resolution and dispatch
    // Cowork uses (tryResolveUnitAction -- same Action Registry, same
    // approval-gate semantics for privileged writes) whenever an
    // addressee resolved to a Unit with a registered manifest, before
    // falling back to plain conversation. Unlike Cowork, an unresolved
    // action never blocks with a clarifying question -- it falls straight
    // through to the existing conversational reply, since low-friction
    // chat (not forcing explicit direction) is the whole point of this
    // mode. A Unit with no manifest yet (most of them, as of this
    // decision) always falls through here, exactly as before.
    if (decision.unit) {
      const manifest = (options.resolveUnitManifestForChat ?? findUnitManifest)(decision.unit);
      if (manifest) {
        const dispatchResult = await tryResolveUnitAction(env, manifest, { chatId, threadId }, text);
        if (dispatchResult.kind === "handled") {
          return;
        }
        if (dispatchResult.kind === "continue") {
          const workId = newWorkId();
          const stub = getSessionStub(env, workId);
          await stub.init(workId, chatId, decision.unit, dispatchResult.hat, threadId);
          await setActiveWorkId(env, chatId, threadId, workId);
          await stub.handleUnitAction(dispatchResult.actionName, text);
          return;
        }
        // "ambiguous" -- fall through to ordinary conversation below.
      }
    }
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

  if (decision.unit === "Finance") {
    // direct_request origination path, mirroring Strategy's exactly --
    // routes into finance.handleDirectRequest, the same governed pricing
    // pipeline handlePickup uses, never a parallel implementation. A
    // direct-entry quote completes standalone on approval (no Strategy
    // boundary block, no Finance -> Sales Handoff) -- see
    // handleQuoteApproval's own handling of !state.handoffId.
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, "Finance", decision.hat ?? "Value-Based Pricing Assessor", threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleFinanceRequest(text);
    return;
  }

  // Unit Registry manifest dispatch (ENIG Operating Model design doc, "The
  // Unit Registry") -- a generic lookup, not a per-Unit branch: any Unit
  // registered in src/units/registry.ts routes through here identically.
  // Only Business Development is registered today; Creative & Design and
  // Operations fall through to the UNSUPPORTED path below exactly as
  // before, since neither has a manifest yet.
  const manifest = findUnitManifest(decision.unit);
  if (manifest) {
    const dispatchResult = await resolveUnitRequest(env, manifest, { chatId, threadId }, text, decision.hat);
    if (dispatchResult.kind === "handled" || dispatchResult.kind === "ambiguous") {
      // Stage 1/2 already replied directly (a "read" action's answer, or
      // an ambiguity/clarification message) -- no WorkSession needed, per
      // the design doc's read/write split ("Read -- no WorkSession
      // created"). "ambiguous" is unreachable from resolveUnitRequest
      // itself (see the Lead Generation Specialist branch's own note
      // above) -- included only to narrow against the shared
      // UnitDispatchResult type.
      return;
    }
    const workId = newWorkId();
    const stub = getSessionStub(env, workId);
    await stub.init(workId, chatId, decision.unit, dispatchResult.hat, threadId);
    await setActiveWorkId(env, chatId, threadId, workId);
    await stub.handleUnitAction(dispatchResult.actionName, text);
    return;
  }

  // Creative & Design, Operations: no existing chat-triggered governed
  // entry point -- fabricating a direct-chat entry point here would be a
  // parallel execution implementation, not routing into an existing one.
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
