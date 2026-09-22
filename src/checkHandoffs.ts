import type { Env, Unit, WorkState } from "./types";
import { plainText, queryDataSource } from "./notion";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { getSessionStub, newWorkId, resolveUnitForThread, SALES_EXECUTIVE_PAUSED } from "./sessionRouting";

/**
 * Handoff discovery -- the single implementation behind the /checkhandoffs
 * Telegram command, the native Cloudflare Cron Trigger (index.ts's
 * scheduled() handler), the /admin/run-finance-discovery HTTP endpoint, and
 * (via runCheckHandoffs below) the automatic post-confirmation continuation
 * a Hat triggers right after successfully queuing a Handoff. One
 * implementation, four entry points -- moved here from index.ts so a Unit's
 * own Handoff-producing code (src/units/**) can call runCheckHandoffs
 * without index.ts having to import back from those same Unit files (which
 * would create a circular module dependency, since index.ts already imports
 * from every Unit file to wire up the Telegram command surface).
 */

/**
 * Runtime protection layer for every discovery loop below: a Durable Object
 * RPC call can fail at the transport level (not just inside the Hat logic
 * it invokes, which already has its own protection in session.ts's
 * execute()) — the Handoff stays Pending either way, so it's automatically
 * retried next cycle rather than silently dropped. Logs and notifies Martin
 * directly rather than aborting the rest of the batch.
 */
async function notifyMartinOfDiscoveryFailure(env: Env, handoffId: string, err: unknown): Promise<void> {
  console.error(`Automated pickup failed for Handoff ${handoffId}`, err);
  await sendMessage(
    env,
    Number(env.MARTIN_TELEGRAM_USER_ID),
    `⚠️ Automated pickup failed for Handoff ${handoffId}. Logged for review — it stays Pending and will retry next cycle.`,
  ).catch((notifyErr) => console.error(`Failed to notify Martin of pickup failure for ${handoffId}`, notifyErr));
}

/**
 * The Finance side of the Sales -> Finance execution boundary. Sales's Hat
 * code only ever creates the Handoff (Status: Pending) and records the
 * handoff_workitem mapping, then returns - it never calls into Finance
 * directly. This runs on its own schedule and discovers that Handoff
 * independently, the same way a separate Finance AI Workspace would.
 */
export async function discoverPendingFinanceHandoffs(env: Env): Promise<number> {
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: "Finance" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let pickedUp = 0;
  for (const handoff of pending) {
    let workId = await env.STATE_KV.get(`handoff_workitem:${handoff.id}`);
    if (!workId) {
      // No live Telegram session behind this Handoff -- e.g. created
      // directly in Notion by the isolated Sales Executive project, which
      // has no WorkState of its own in this Worker. Create a fresh
      // session instead of skipping it, so Finance can still pick it up.
      // Defaults to Martin's DM, his preferred front door for every
      // Unit/Hat's work, since there's no originating chat to inherit.
      try {
        workId = newWorkId();
        const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
        const threadId = undefined;
        // The later quote-approval step resolves the real Matter page ID
        // itself (via Matter_Token, the Handoffs schema no longer carries a
        // Matter relation) -- nothing to seed here.
        const stub = getSessionStub(env, workId);
        await stub.init(workId, chatId, "Finance", "Value-Based Pricing Assessor", threadId, { handoffId: handoff.id });
        await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, workId);
        console.log(`Created work item ${workId} for externally-created Finance Handoff ${handoff.id} (no prior session)`);
      } catch (err) {
        console.error(`Failed to create a work item for externally-created Finance Handoff ${handoff.id}`, err);
        await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
        continue;
      }
    }
    const stub = getSessionStub(env, workId);
    try {
      await stub.runFinancePickup();
      pickedUp++;
    } catch (err) {
      await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
    }
  }
  return pickedUp;
}

/**
 * The Sales side of the Finance -> Sales execution boundary — the return
 * leg of the same Handoff-queue pattern as discoverPendingFinanceHandoffs.
 * Finance's own approval handler only ever creates this Handoff (Status:
 * Pending) and records the handoff_workitem mapping, then returns — it
 * never calls into Sales directly. This runs on its own schedule and
 * discovers that Handoff independently, the same way discoverPendingFinanceHandoffs
 * does for the opposite direction.
 */
export async function discoverPendingSalesHandoffs(env: Env): Promise<number> {
  if (SALES_EXECUTIVE_PAUSED) {
    // Sales Executive is paused -- leave any Pending Finance->Sales
    // Handoff as-is for automatic pickup once it's back, rather than
    // routing proposal drafting through the frozen in-Worker code.
    return 0;
  }

  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: "Sales" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let pickedUp = 0;
  for (const handoff of pending) {
    const workId = await env.STATE_KV.get(`handoff_workitem:${handoff.id}`);
    if (!workId) {
      console.error(`Pending Sales Handoff ${handoff.id} has no known work item mapping — skipping automated pickup`);
      continue;
    }
    const stub = getSessionStub(env, workId);
    try {
      await stub.runProposalDrafting();
      pickedUp++;
    } catch (err) {
      await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
    }
  }
  return pickedUp;
}

/**
 * The R&I side of a <Unit> -> Research & Intelligence execution boundary,
 * mirroring discoverPendingFinanceHandoffs exactly -- the creating Unit's
 * Hat code only ever creates the Handoff (Status: Pending) and returns;
 * this runs on its own schedule and discovers it independently.
 */
export async function discoverPendingResearchHandoffs(env: Env): Promise<number> {
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: "Research & Intelligence" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let pickedUp = 0;
  for (const handoff of pending) {
    let workId = await env.STATE_KV.get(`handoff_workitem:${handoff.id}`);
    if (!workId) {
      // No live Telegram session behind this Handoff -- same
      // no-prior-session case discoverPendingFinanceHandoffs handles.
      // Defaults to Martin's DM, his preferred front door.
      try {
        workId = newWorkId();
        const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
        const threadId = undefined;
        const stub = getSessionStub(env, workId);
        await stub.init(workId, chatId, "Research & Intelligence", "Research & Intelligence Analyst", threadId, { handoffId: handoff.id });
        await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, workId);
        console.log(`Created work item ${workId} for externally-created Research Handoff ${handoff.id} (no prior session)`);
      } catch (err) {
        console.error(`Failed to create a work item for externally-created Research Handoff ${handoff.id}`, err);
        await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
        continue;
      }
    }
    const stub = getSessionStub(env, workId);
    try {
      await stub.runResearchPickup();
      pickedUp++;
    } catch (err) {
      await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
    }
  }
  return pickedUp;
}

/**
 * The Marketing side of the Research & Intelligence -> Marketing
 * execution boundary, mirroring discoverPendingResearchHandoffs exactly.
 * Currently the only creator of a To-Unit-Marketing Handoff is
 * researchAnalyst.ts's own auto-routing (routeToConsumingHat) once it
 * judges completed research directly relevant to Marketing Strategist's
 * work -- see Martin's "research has to find and feed the strategist hat
 * that needs it" direction.
 */
export async function discoverPendingMarketingHandoffs(env: Env): Promise<number> {
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: "Marketing" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let pickedUp = 0;
  for (const handoff of pending) {
    let workId = await env.STATE_KV.get(`handoff_workitem:${handoff.id}`);
    if (!workId) {
      try {
        workId = newWorkId();
        const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
        const threadId = undefined;
        const stub = getSessionStub(env, workId);
        await stub.init(workId, chatId, "Marketing", "Marketing Strategist", threadId, { handoffId: handoff.id });
        await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, workId);
        console.log(`Created work item ${workId} for externally-created Marketing Handoff ${handoff.id} (no prior session)`);
      } catch (err) {
        console.error(`Failed to create a work item for externally-created Marketing Handoff ${handoff.id}`, err);
        await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
        continue;
      }
    }
    const stub = getSessionStub(env, workId);
    try {
      await stub.runMarketingHandoffPickup();
      pickedUp++;
    } catch (err) {
      await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
    }
  }
  return pickedUp;
}

/**
 * The Strategy side of a <Unit> -> Strategy execution boundary, mirroring
 * discoverPendingResearchHandoffs/discoverPendingMarketingHandoffs exactly
 * -- the creating Unit's Hat code only ever creates the Handoff (Status:
 * Pending) and returns; this runs on its own schedule and discovers it
 * independently.
 */
export async function discoverPendingStrategyHandoffs(env: Env): Promise<number> {
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: "Strategy" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let pickedUp = 0;
  for (const handoff of pending) {
    let workId = await env.STATE_KV.get(`handoff_workitem:${handoff.id}`);
    if (!workId) {
      try {
        workId = newWorkId();
        const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
        const threadId = undefined;
        const stub = getSessionStub(env, workId);
        await stub.init(workId, chatId, "Strategy", "Strategy Analyst", threadId, { handoffId: handoff.id });
        await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, workId);
        console.log(`Created work item ${workId} for externally-created Strategy Handoff ${handoff.id} (no prior session)`);
      } catch (err) {
        console.error(`Failed to create a work item for externally-created Strategy Handoff ${handoff.id}`, err);
        await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
        continue;
      }
    }
    const stub = getSessionStub(env, workId);
    try {
      await stub.runStrategyPickup();
      pickedUp++;
    } catch (err) {
      await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
    }
  }
  return pickedUp;
}

/**
 * Read-only count of Pending Work Handoffs addressed to a Unit, independent
 * of whether automated pickup can actually process them (that depends on a
 * handoff_workitem KV mapping the discovery functions require -- see
 * runCheckHandoffs). Used both for Units with no pickup logic at all and to
 * detect Finance/Sales Handoffs that are genuinely pending but stuck for
 * lack of that mapping.
 */
export async function countPendingHandoffsForUnit(env: Env, unit: Unit): Promise<number> {
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    and: [
      { property: "To Unit", select: { equals: unit } },
      { property: "Status", select: { equals: "Pending" } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });
  return pending.length;
}

// A digest only needs to reach Martin when the outstanding set actually
// changes, or as a backstop so a stuck item is never silently forgotten --
// resending the identical list every discovery tick is just noise.
const STALE_HANDOFF_DIGEST_BACKSTOP_MS = 24 * 60 * 60 * 1000;

// Runs on every discovery tick, but only actually messages Martin when the
// set of outstanding (Pending/Held) Handoffs has changed since the last
// digest, or the backstop interval has elapsed with no change at all.
export async function checkStaleHandoffs(env: Env): Promise<void> {
  const results = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
    or: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "Status", select: { equals: "Held" } },
    ],
  });
  if (results.length === 0) return;

  const lastSentKey = "stale_handoff_digest_last_sent";
  const lastFingerprintKey = "stale_handoff_digest_last_fingerprint";
  const fingerprint = results
    .map((p) => `${p.id}:${plainText(p.properties.Status)}`)
    .sort()
    .join(",");

  const [lastSent, lastFingerprint] = await Promise.all([
    env.STATE_KV.get(lastSentKey),
    env.STATE_KV.get(lastFingerprintKey),
  ]);

  const changed = fingerprint !== lastFingerprint;
  const backstopDue = !lastSent || Date.now() - Number(lastSent) >= STALE_HANDOFF_DIGEST_BACKSTOP_MS;
  if (!changed && !backstopDue) return;

  const lines = results.map((p) => {
    const status = plainText(p.properties.Status);
    const toUnit = plainText(p.properties["To Unit"]);
    const name = plainText(p.properties.Handoff);
    return `• [${status}] ${name} → ${toUnit}`;
  });
  await sendOperationsMessage(
    env,
    `*Handoff check-in* — ${results.length} item(s) not Closed:\n\n${lines.join("\n")}`,
  );
  await env.STATE_KV.put(lastSentKey, String(Date.now()));
  await env.STATE_KV.put(lastFingerprintKey, fingerprint);
}

// Guards runCheckHandoffs's automatic (auto:true) invocations against
// overlapping/recursive re-entry -- see runCheckHandoffs's doc comment.
// Deliberately NOT applied to a manual /checkhandoffs invocation (Martin
// must always be able to run the command directly, even if an automatic
// continuation happens to be mid-flight).
const AUTO_CHECKHANDOFFS_GUARD_KEY = "checkhandoffs_auto_inflight";
const AUTO_CHECKHANDOFFS_GUARD_TTL_SECONDS = 30;

/**
 * The exact existing /checkhandoffs command body, factored out so it can be
 * invoked from two places with identical behavior: the manual /checkhandoffs
 * Telegram command (index.ts), and the automatic post-confirmation
 * continuation a Hat triggers right after successfully queuing a Handoff
 * (opts.auto: true — see each Unit's producer call site, e.g.
 * salesExecutive.ts's handleInterventionText). Same discovery calls, same
 * reply formatting, same per-Unit/dm/unmapped branching -- nothing about
 * command semantics changes based on how it was invoked, per the Handoff
 * automation task's explicit requirement not to alter what /checkhandoffs
 * means.
 *
 * chatId/threadId determine which Telegram stream the reply lands in and
 * which Unit's topic resolveUnitForThread resolves to -- exactly the same
 * as if Martin had typed /checkhandoffs in that same chat/thread himself.
 * Every discovery function above always sweeps all five pickup directions
 * regardless of unitHere (only which summary line is sent back differs) --
 * so calling this from the chat/thread a Hat's own confirmation was just
 * sent to reliably discovers and picks up the Handoff that was just queued,
 * without needing to resolve or guess which specific Handoff to check.
 *
 * opts.auto guards against overlapping automatic re-entry (see
 * AUTO_CHECKHANDOFFS_GUARD_KEY) -- a short-lived KV flag, not a call-count
 * limit, since by construction (every Hat pickup stops at an approval gate
 * before it would ever queue a further Handoff on its own -- see the
 * automation task's recursion analysis) an automatic invocation cannot
 * actually cause another automatic invocation to fire; this guard exists
 * as an explicit, testable safety net regardless.
 */
export async function runCheckHandoffs(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  opts: { auto?: boolean } = {},
): Promise<void> {
  if (opts.auto) {
    const inflight = await env.STATE_KV.get(AUTO_CHECKHANDOFFS_GUARD_KEY);
    if (inflight) {
      console.log("Automatic /checkhandoffs continuation skipped -- already in flight (recursion guard)");
      return;
    }
    await env.STATE_KV.put(AUTO_CHECKHANDOFFS_GUARD_KEY, "1", { expirationTtl: AUTO_CHECKHANDOFFS_GUARD_TTL_SECONDS });
  }

  try {
    // Same discovery logic /admin/run-finance-discovery and the 5-minute
    // GitHub Actions cron already run -- exposed as a command (and now
    // also as an automatic continuation) so it can run immediately rather
    // than waiting for the next scheduled cycle.
    await env.STATE_KV.put("last_cron_run", new Date().toISOString()).catch((err) =>
      console.error("Failed to record last_cron_run", err),
    );
    const unitHere = resolveUnitForThread(env, threadId);
    try {
      if (unitHere === "Finance" || unitHere === "Sales" || unitHere === "Research & Intelligence" || unitHere === "Marketing" || unitHere === "Strategy") {
        // These five are the only Units with real pickup logic (Marketing's
        // is Handoff-only -- see discoverPendingMarketingHandoffs -- chat-
        // originated Marketing work still goes through handleMarketingIntake
        // directly, never this discovery path). Discovery only counts a
        // Handoff as "picked up" if it has a handoff_workitem KV mapping
        // (tied to a live Telegram session); a Handoff created directly in
        // Notion -- e.g. by the isolated Sales Executive project -- has no
        // such mapping, so discovery finds it but silently skips it, and
        // picked stays 0 even though it's genuinely Pending. Query Notion
        // directly too, so the reply can tell "nothing pending" apart from
        // "pending but stuck for lack of a work-item mapping" instead of
        // reporting both as the same "No Handoffs pending" message.
        const picked = await discoverPendingFinanceHandoffs(env);
        const pickedForSales = await discoverPendingSalesHandoffs(env);
        const pickedForResearch = await discoverPendingResearchHandoffs(env);
        const pickedForMarketing = await discoverPendingMarketingHandoffs(env);
        const pickedForStrategy = await discoverPendingStrategyHandoffs(env);
        await checkStaleHandoffs(env);
        const pendingCount = await countPendingHandoffsForUnit(env, unitHere);
        const pickedForThisUnit =
          unitHere === "Finance"
            ? picked
            : unitHere === "Sales"
              ? pickedForSales
              : unitHere === "Marketing"
                ? pickedForMarketing
                : unitHere === "Strategy"
                  ? pickedForStrategy
                  : pickedForResearch;
        let reply: string;
        if (pendingCount === 0) {
          reply = `No Handoffs pending for ${unitHere}.`;
        } else if (pickedForThisUnit >= pendingCount) {
          reply = `Picked up ${pickedForThisUnit} Handoff(s) for ${unitHere}.`;
        } else {
          reply = `${pendingCount} Handoff(s) pending for ${unitHere}, but automated pickup couldn't process ${pendingCount - pickedForThisUnit} of them (no handoff_workitem mapping -- likely created outside a live Telegram session, e.g. directly in Notion or by the isolated Sales Executive project). Needs manual follow-up.`;
        }
        await sendMessage(env, chatId, reply, undefined, threadId);
      } else if (unitHere === "dm" || unitHere === "unmapped") {
        // No specific Unit to scope to -- fall back to the combined
        // summary across all real pickup directions.
        const picked = await discoverPendingFinanceHandoffs(env);
        const pickedForSales = await discoverPendingSalesHandoffs(env);
        const pickedForResearch = await discoverPendingResearchHandoffs(env);
        const pickedForMarketing = await discoverPendingMarketingHandoffs(env);
        const pickedForStrategy = await discoverPendingStrategyHandoffs(env);
        await checkStaleHandoffs(env);
        // This is a cross-Unit operational summary, not a reply about any
        // single work item -- belongs in the Operations stream (per
        // Martin's explicit request), not wherever /checkhandoffs happened
        // to be typed. The per-Unit branch above still replies in-thread,
        // since that IS about the specific work item(s) in that topic.
        await sendOperationsMessage(
          env,
          `Checked Handoffs: ${picked} picked up for Finance, ${pickedForSales} picked up for Sales, ${pickedForResearch} picked up for Research & Intelligence, ${pickedForMarketing} picked up for Marketing, ${pickedForStrategy} picked up for Strategy.`,
        );
      } else {
        // Business Development, Strategy, Creative & Design, and
        // Operations -- no pickup logic exists for any of these, so just
        // report whether anything is queued for this Unit rather than
        // attempting a pickup that doesn't exist.
        const pendingCount = await countPendingHandoffsForUnit(env, unitHere);
        const reply =
          pendingCount > 0
            ? `${pendingCount} Handoff(s) pending for ${unitHere} — no automated pickup exists yet for this Unit.`
            : `No Handoffs pending for ${unitHere}.`;
        await sendMessage(env, chatId, reply, undefined, threadId);
      }
    } catch (err) {
      console.error("Unhandled error in /checkhandoffs", err);
      await sendMessage(env, chatId, "Handoff discovery failed unexpectedly. Logged for review — will retry next cycle.", undefined, threadId);
    }
  } finally {
    if (opts.auto) {
      await env.STATE_KV.delete(AUTO_CHECKHANDOFFS_GUARD_KEY).catch((err) =>
        console.error("Failed to clear the /checkhandoffs auto-continuation recursion guard", err),
      );
    }
  }
}

/**
 * Called by router.ts/index.ts immediately after any WorkSession call that
 * returns a WorkState -- i.e. AFTER the Durable Object's own method
 * invocation has fully completed and control has returned to the Worker's
 * own isolate. This is deliberate: runCheckHandoffs's discovery loop can
 * end up calling back into the SAME WorkSession (via its own stub) to pick
 * up the Handoff it just queued, and issuing that call only once the prior
 * DO invocation has genuinely finished avoids any risk of a Durable Object
 * receiving a new request for itself while still processing the one that
 * triggered it. A Hat handler must never call runCheckHandoffs directly
 * from inside its own execution for this reason -- it only ever sets
 * state.pendingHandoffAutoCheck and returns.
 *
 * A no-op whenever the returned state has no pendingHandoffAutoCheck flag
 * set (the overwhelming majority of calls) or is missing entirely.
 */
export async function maybeAutoContinueCheckHandoffs(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  state: WorkState | undefined | null,
): Promise<void> {
  if (!state?.pendingHandoffAutoCheck) return;
  await runCheckHandoffs(env, chatId, threadId, { auto: true }).catch((err) =>
    console.error("Automatic /checkhandoffs continuation failed", err),
  );
}
