import type { Env, WorkState } from "../types";
import { richText, select, updatePage } from "../notion";
import { aiJson } from "../ai";
import { logActivity } from "../log";
import { sendMessage } from "../telegram";
import * as sales from "./salesExecutive";

interface PriceJudgement {
  sufficient: boolean;
  price?: number;
  rationale?: string;
  reason_if_insufficient?: string;
}

export async function handlePickup(env: Env, state: WorkState): Promise<WorkState> {
  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });
  await logActivity(env, {
    entry: `Handoff picked up: ${state.matterName}`,
    type: "Activity",
    area: "Finance",
    activity: "Value-Based Pricing Assessor picked up quote request.",
    outcome: "Active",
  });

  const judgement = await aiJson<PriceJudgement>(env, {
    system:
      "You are the Value-Based Pricing Assessor Hat at ENIG. Judge a value-based price (USD) for the proposed intervention using ONLY the value context given. You have NOT been given, and must NOT infer or use, any disclosed budget or willingness-to-pay figure. If the value context is insufficient to responsibly judge a price, do not estimate around the gap. Return JSON: {\"sufficient\": true, \"price\": <number>, \"rationale\": \"...\"} or {\"sufficient\": false, \"reason_if_insufficient\": \"...\"}.",
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
    );
    state.stage = "handoff_held";
    state.awaiting = "value_context_more";
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
  );

  state.quote = { price: judgement.price, rationale: judgement.rationale ?? "" };
  state.stage = "quote_received";
  return sales.handleQuoteReceived(env, state);
}
