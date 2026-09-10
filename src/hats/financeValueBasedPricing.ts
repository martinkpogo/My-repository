import type { Env, WorkState } from "../types";
import { getPage, plainText, relationIds, richText, select, updatePage } from "../notion";
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

interface HandoffBusinessContext {
  entityName: string;
  matterName: string;
  judgmentContext: string;
}

/**
 * Reconstructs the business context this Hat needs directly from the
 * Handoff's own canonical Notion records (Handoff -> Matter -> Entity),
 * per the Handoff Business Object's context_transfer rule — the receiving
 * Unit must be able to continue from what the Handoff itself carries, not
 * from the sending Unit's session state. Returns null on any failure
 * (missing relation, missing referenced page, or empty required field);
 * callers must treat null as "cannot proceed," never substitute WorkState
 * in its place.
 */
async function resolveHandoffBusinessContext(env: Env, handoffId: string): Promise<HandoffBusinessContext | null> {
  try {
    const handoff = await getPage(env, handoffId);
    const judgmentContext = plainText(handoff.properties["Verified Facts & Sources"]);

    const matterId = relationIds(handoff.properties.Matter)[0];
    if (!matterId) throw new Error("Handoff has no Matter relation");
    const matter = await getPage(env, matterId);
    const matterName = plainText(matter.properties.Matter);

    const entityId = relationIds(matter.properties.Entity)[0];
    if (!entityId) throw new Error("Matter has no Entity relation");
    const entity = await getPage(env, entityId);
    const entityName = plainText(entity.properties.Name);

    if (!entityName || !judgmentContext) throw new Error("reconstructed context was empty");

    return { entityName, matterName, judgmentContext };
  } catch (err) {
    console.error(`Handoff business-context reconstruction failed for ${handoffId}`, err);
    return null;
  }
}

export async function handlePickup(env: Env, state: WorkState): Promise<WorkState> {
  // Finance is its own Unit with its own topic/workspace - it speaks there,
  // not wherever the enquiry happened to originate (state.threadId, usually
  // SM&BD's topic). Falls back to state.threadId if Finance has no topic
  // configured, so this is a no-op when UNIT_TOPIC_MAP is unset.
  const financeThreadId = threadIdForUnit(env, "Finance") ?? state.threadId;

  // Business context and governance are both checked BEFORE the Handoff is
  // marked Picked-up, so a Notion outage leaves it Pending and it's retried
  // automatically on the next discovery cycle, rather than stuck in a
  // Picked-up limbo needing manual recovery.
  const context = await resolveHandoffBusinessContext(env, state.handoffId!);
  if (!context) {
    console.error(`Finance handlePickup: business-context reconstruction failed for handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Finance pickup blocked — could not reconstruct business context from Handoff ${state.handoffId}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale:
        "Could not read the required business context from the Handoff's own Notion records (Handoff, Matter, or Entity). Refusing to execute without it; Handoff left Pending for automatic retry.",
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `*Finance couldn't pick up a quote request* (Handoff ${state.handoffId}).\n\nCouldn't reconstruct the business context from the Handoff's Notion records. Not proceeding without it — will retry automatically on the next discovery cycle.`,
      undefined,
      financeThreadId,
    );
    return state;
  }

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
      entry: `Finance pickup blocked — governance retrieval failed: ${context.matterName}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: `Could not retrieve canonical governance from Notion (${missing}). Refusing to execute without it; Handoff left Pending for automatic retry.`,
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `*Finance couldn't pick up the quote request* for *${context.entityName}*.\n\nCouldn't retrieve its canonical governance from Notion (${missing}). Not proceeding without it — will retry automatically on the next discovery cycle.`,
      undefined,
      financeThreadId,
    );
    return state;
  }

  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });
  await logActivity(env, {
    entry: `Handoff picked up: ${context.matterName}`,
    type: "Activity",
    area: "Finance",
    activity: "Value-Based Pricing Assessor picked up quote request.",
    outcome: "Active",
  });

  const judgement = await aiJson<PriceJudgement>(env, {
    system: buildFinanceSystemPrompt(hatDefinition, universalRoleContract),
    user: `Entity: ${context.entityName}\nProposed intervention and value context:\n${context.judgmentContext}`,
  });

  if (!judgement || judgement.sufficient !== true || typeof judgement.price !== "number") {
    const reason = judgement?.reason_if_insufficient ?? "Value context insufficient to price responsibly.";
    await updatePage(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(reason),
    });
    await logActivity(env, {
      entry: `Handoff held — insufficient value context: ${context.matterName}`,
      type: "Blocker",
      area: "Finance",
      decisionRationale: reason,
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `*Finance held the quote request* for *${context.entityName}*.\n\nReason: ${reason}\n\nSend more value context (not a budget figure) and I'll re-submit to Finance.`,
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
    entry: `Quote judged: $${judgement.price} — ${context.matterName}`,
    type: "Decision",
    area: "Finance",
    decisions: `Value-based quote: $${judgement.price}`,
    decisionRationale: judgement.rationale ?? "",
    outcome: "Complete",
  });
  await sendMessage(
    env,
    state.chatId,
    `*Finance quote ready* for *${context.entityName}*: $${judgement.price}\n\nRationale: ${judgement.rationale}\n\nPreparing the Draft Proposal now.`,
    undefined,
    financeThreadId,
  );

  state.quote = { price: judgement.price, rationale: judgement.rationale ?? "" };
  state.stage = "quote_received";
  return sales.handleQuoteReceived(env, state);
}
