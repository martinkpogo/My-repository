import type { Env, WorkState } from "../types";
import { richText, select, updatePage } from "../notion";
import { aiJson } from "../ai";
import { logActivity } from "../log";
import { sendMessage } from "../telegram";
import { setActiveWorkId, threadIdForUnit } from "../router";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../governance";
import * as sales from "./salesExecutive";

interface PriceJudgement {
  sufficient: boolean;
  price?: number;
  rationale?: string;
  reason_if_insufficient?: string;
}

// Canonical Notion governance source for this Hat, verified live in the
// audit that preceded this change. Explicit page ID, not title search, per
// the Universal Role Contract's evidence rule (a consequential source must
// be attributable, not guessed at by name match).
const FINANCE_HAT_DEFINITION_PAGE_ID = "3cecb004-e583-81f9-a52e-e24872a52eff";

function buildFinanceSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for your role, responsibilities, authority limits, and stop conditions — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    'Return JSON: {"sufficient": true, "price": <number>, "rationale": "..."} if you can judge a value-based price responsibly per the Hat Definition above, or {"sufficient": false, "reason_if_insufficient": "..."} if the Hat Definition\'s own rule for insufficient context applies to this case.',
  ].join("\n\n");
}

export async function handlePickup(env: Env, state: WorkState): Promise<WorkState> {
  // Finance is its own Unit with its own topic/workspace - it speaks there,
  // not wherever the enquiry happened to originate (state.threadId, usually
  // SM&BD's topic). Falls back to state.threadId if Finance has no topic
  // configured, so this is a no-op when UNIT_TOPIC_MAP is unset.
  const financeThreadId = threadIdForUnit(env, "Finance") ?? state.threadId;

  // Governance is checked BEFORE the Handoff is marked Picked-up, so a
  // Notion outage leaves it Pending and it's retried automatically on the
  // next discovery cycle, rather than stuck in a Picked-up limbo needing
  // manual recovery.
  const [hatDefinition, universalRoleContract] = await Promise.all([
    getGovernance(env, FINANCE_HAT_DEFINITION_PAGE_ID, "Finance Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);

  if (!hatDefinition || !universalRoleContract) {
    const missing = [
      !hatDefinition ? "Finance Hat Definition" : null,
      !universalRoleContract ? "Universal Role Contract" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    console.error(`Finance handlePickup: governance retrieval failed (${missing}) for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Finance pickup blocked — governance retrieval failed: ${state.matterName}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: `Could not retrieve canonical governance from Notion (${missing}). Refusing to execute without it; Handoff left Pending for automatic retry.`,
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `*Finance couldn't pick up the quote request* for *${state.entityName}*.\n\nCouldn't retrieve its canonical governance from Notion (${missing}). Not proceeding without it — will retry automatically on the next discovery cycle.`,
      undefined,
      financeThreadId,
    );
    return state;
  }

  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });
  await logActivity(env, {
    entry: `Handoff picked up: ${state.matterName}`,
    type: "Activity",
    area: "Finance",
    activity: "Value-Based Pricing Assessor picked up quote request.",
    outcome: "Active",
  });

  const judgement = await aiJson<PriceJudgement>(env, {
    system: buildFinanceSystemPrompt(hatDefinition, universalRoleContract),
    user: `Entity: ${state.entityName}\nProposed intervention and value context:\n${state.proposedIntervention}`,
  });

  if (!judgement || judgement.sufficient !== true || typeof judgement.price !== "number") {
    const reason = judgement?.reason_if_insufficient ?? "Value context insufficient to price responsibly.";
    await updatePage(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(reason),
    });
    await logActivity(env, {
      entry: `Handoff held — insufficient value context: ${state.matterName}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: reason,
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `*Finance held the quote request* for *${state.entityName}*.\n\nReason: ${reason}\n\nSend more value context (not a budget figure) and I'll re-submit to Finance.`,
      undefined,
      financeThreadId,
    );
    state.stage = "handoff_held";
    state.awaiting = "value_context_more";
    state.financeThreadId = financeThreadId;
    if (financeThreadId !== undefined) {
      await setActiveWorkId(env, state.chatId, financeThreadId, state.workId);
    }
    return state;
  }

  await updatePage(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText(`Quoted price: $${judgement.price}. Rationale: ${judgement.rationale ?? ""}`.slice(0, 1900)),
  });
  await logActivity(env, {
    entry: `Quote judged: $${judgement.price} — ${state.matterName}`,
    type: "Decision",
    area: "Finance",
    decisions: `Value-based quote: $${judgement.price}`,
    decisionRationale: judgement.rationale ?? "",
    outcome: "Complete",
  });
  await sendMessage(
    env,
    state.chatId,
    `*Finance quote ready* for *${state.entityName}*: $${judgement.price}\n\nRationale: ${judgement.rationale}\n\nPreparing the Draft Proposal now.`,
    undefined,
    financeThreadId,
  );

  state.quote = { price: judgement.price, rationale: judgement.rationale ?? "" };
  state.stage = "quote_received";
  return sales.handleQuoteReceived(env, state);
}
