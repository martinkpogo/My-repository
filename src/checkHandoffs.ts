import type { Env, Unit, WorkState } from "./types";
import { plainText, queryDataSource } from "./notion";
import { sendMessage, sendOperationsMessage } from "./telegram";
import { getSessionStub, newWorkId, resolveUnitForThread } from "./sessionRouting";
import { discoveryCronContext } from "./access";
import { findUnitManifest, getUnitManifests } from "./units/registry";
import type { HandoffPickupDeclaration, UnitManifest } from "./units/unitManifest";
import { resolveOrganization } from "./runtime/organization";
import { resolveActionExecution } from "./runtime/actionResolution";
import { workContractForRequest, type WorkRequest } from "./runtime/workContract";
import { resolveMatterIdFromToken } from "./matterContinuation";
import { kvDelete, kvGet, kvPut } from "./kvStore";

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
export async function notifyMartinOfDiscoveryFailure(env: Env, handoffId: string, err: unknown): Promise<void> {
  console.error(`Automated pickup failed for Handoff ${handoffId}`, err);
  await sendMessage(
    env,
    Number(env.MARTIN_TELEGRAM_USER_ID),
    `⚠️ Automated pickup failed for Handoff ${handoffId}. Logged for review — it stays Pending and will retry next cycle.`,
  ).catch((notifyErr) => console.error(`Failed to notify Martin of pickup failure for ${handoffId}`, notifyErr));
}

export type HandoffDestination =
  | { ok: true; unit: Unit; hat: string; actionName: string }
  | { ok: false; reason: string };

/**
 * Resolves the Organization (Unit/Hat/Responsibility) and exactly one
 * Action for Handoff-originated Work through the SAME resolution
 * boundaries every direct request uses (ENIG Operating Model: Organization
 * owns organizational resolution; Action Resolution requires exactly one
 * declared applicable Action) -- before the Work is created, and again at
 * the pickup boundary where an EXISTING Work adopts that destination (see
 * src/handoffOwnership.ts).
 *
 * The Handoff's destination is a FACT, consumed as established: `To Unit`
 * says which Unit owns the Work, `To Hat` which of that Unit's Hats. This
 * function never re-decides, reclassifies, or defaults it, and no intake
 * interpretation runs for a pickup -- `origin: "handoff_pickup"` is what
 * Action Resolution evaluates, so only an Action whose declared
 * applicability admits a Handoff pickup can resolve (`price`,
 * `proposal_draft`, `handle_request`, `diagnose` -- exactly
 * the Actions the pickup methods these loops call perform).
 *
 * Returns `{ ok: false, reason }` -- never a guess -- when resolution fails
 * closed: a record whose `To Unit` doesn't match the caller's Unit, a
 * destination naming a Hat the Unit doesn't declare, a Handoff naming no
 * Hat for a multi-Hat Unit, or an Action its declarations don't admit at
 * pickup. The caller decides what that stops (discovery leaves the Handoff
 * Pending for the next cycle; a pickup aborts before it claims anything),
 * but a hardcoded Hat is never substituted for one the record does not
 * establish.
 *
 * Deliberately free of notifications and side effects so both callers can
 * report a failure through their own existing channel -- discovery through
 * notifyMartinOfDiscoveryFailure, a pickup through WorkSession.execute's
 * Operations message.
 */
export async function deriveHandoffDestination(
  handoff: { id: string; properties?: Record<string, any> },
  expectedUnit: Unit,
): Promise<HandoffDestination> {
  const fail = (reason: string): HandoffDestination => ({ ok: false, reason });

  const toUnit = plainText(handoff.properties?.["To Unit"]) || expectedUnit;
  if (toUnit !== expectedUnit) {
    return fail(
      `destination Unit "${toUnit}" does not match this discovery loop's Unit "${expectedUnit}" -- the destination is a fact and cannot be redirected`,
    );
  }
  const toHat = plainText(handoff.properties?.["To Hat"]) || null;
  const request: WorkRequest = {
    // Carried as evidence of what this Work is for; resolution reads the
    // context below, never parses this text for ownership or Action.
    requested_outcome: plainText(handoff.properties?.Reason) || `Handoff ${handoff.id}`,
    current_context: {
      mode: "cowork",
      origin: "handoff_pickup",
      addressed_unit: expectedUnit,
      handoff: { handoffId: handoff.id, toUnit, toHat },
    },
  };
  const contract = workContractForRequest(request);
  const manifest = findUnitManifest(expectedUnit);
  const organization = resolveOrganization(contract, manifest);
  if (organization.kind === "failed") {
    return fail(`Organization (${organization.reason}): ${organization.detail}`);
  }
  const resolution = await resolveActionExecution(manifest, organization.organization, contract);
  if (resolution.kind === "need_interpretation") {
    return fail(
      "no Action is determined by the Handoff's destination facts, and a pickup is never re-interpreted -- the destination must determine exactly one Action",
    );
  }
  if (resolution.kind === "failed") {
    return fail(`Action (${resolution.reason}): ${resolution.detail}`);
  }
  return {
    ok: true,
    unit: expectedUnit,
    hat: organization.organization.hat,
    actionName: resolution.execution.action.action_id,
  };
}

/**
 * Discovery's wrapper over deriveHandoffDestination: the same resolution,
 * reported through the discovery failure channel the loops below already
 * use. Returns null, with Martin notified, so the loop skips that Handoff
 * and it stays Pending -- ambiguity stops rather than guessing the
 * destination, and retries next cycle.
 */
async function resolveHandoffEntry(
  env: Env,
  handoff: { id: string; properties?: Record<string, any> },
  expectedUnit: Unit,
): Promise<{ hat: string; actionName: string } | null> {
  const destination = await deriveHandoffDestination(handoff, expectedUnit);
  if (destination.ok) return { hat: destination.hat, actionName: destination.actionName };
  await notifyMartinOfDiscoveryFailure(env, handoff.id, new Error(`Handoff entry resolution failed: ${destination.reason}`));
  return null;
}

/**
 * Matter identity at the ONE boundary where a Handoff creates a new Work.
 *
 * `Matter_Token` is a fact the Handoff already carries, so the new Work is
 * born with the canonical Matter page id it will be indexed and pointed at
 * by, instead of waiting for a later business action to discover it (the
 * gap that left a Work's persisted state with no `matterId`, so Matter
 * Continue had nothing to match against).
 *
 * Resolution is the existing canonical mechanism -- `resolveMatterIdFromToken`
 * in src/matterContinuation.ts, the same lookup WorkSession.save's
 * `ensureMatterIdentity` and Matter Continue use (exact unique_id match plus
 * the required Entity relation). No second Matter lookup is introduced here,
 * and identity is never inferred from a label, a title, Entity data, Handoff
 * ordering or AI output. A read: nothing is written to Notion.
 *
 * Returns null when the Handoff names no token or the token does not resolve
 * -- reported through the same discovery failure channel `resolveHandoffEntry`
 * uses. The calling loop then creates NO Work and NO `handoff_workitem`
 * mapping and leaves the Handoff Pending: failing closed beats a Work that is
 * falsely associated with a Matter.
 *
 * Consulted ONLY where a new Work is about to be created. A Handoff that
 * already has a `handoff_workitem` mapping continues its existing Work and
 * never reaches this function, so same-Work Handoff continuity is untouched.
 */
async function resolveHandoffMatterIdentity(
  env: Env,
  handoff: { id: string; properties?: Record<string, any> },
): Promise<{ matterId: string; matterToken: string } | null> {
  const matterToken = plainText(handoff.properties?.Matter_Token).trim();
  if (!matterToken) {
    await notifyMartinOfDiscoveryFailure(
      env,
      handoff.id,
      new Error("Handoff Matter resolution failed: the Handoff carries no Matter_Token -- no Work was created without a canonical Matter"),
    );
    return null;
  }
  const matterId = await resolveMatterIdFromToken(env, matterToken);
  if (!matterId) {
    await notifyMartinOfDiscoveryFailure(
      env,
      handoff.id,
      new Error(`Handoff Matter resolution failed: Matter_Token "${matterToken}" does not resolve to an existing Matter -- no Work was created`),
    );
    return null;
  }
  return { matterId, matterToken };
}

/**
 * The ONE Handoff discovery loop. For a Unit that declares
 * `handoffPickup` in its manifest, finds its Pending Work Handoffs,
 * registers a Work for each that has none, and schedules that Unit's pickup
 * on the Work's own WorkSession alarm. It names no Unit: everything
 * Unit-specific (the handler, an intake screen, a hold) is the Unit's own
 * declaration (UnitManifest.handoffPickup).
 *
 * The creating Unit's Hat code only ever creates the Handoff (Status:
 * Pending) and records the handoff_workitem mapping, then returns -- it never
 * calls into the receiving Unit directly. This runs on its own schedule (and
 * on the Notion webhook / `/checkhandoffs`) and discovers the Handoff
 * independently, the same way a separate AI Workspace would.
 *
 * Returns how many Handoffs were scheduled for pickup. A Unit that declares
 * no pickup schedules nothing (its Pending Handoffs are only counted, see
 * countPendingHandoffsForUnit).
 *
 * `declaration` defaults to the Unit's manifest and exists so a Unit's
 * variant (e.g. Sales while paused) can be exercised in tests; production
 * callers never pass it.
 */
export async function discoverPendingHandoffsForUnit(
  env: Env,
  unit: Unit,
  declaration: HandoffPickupDeclaration | undefined = findUnitManifest(unit)?.handoffPickup,
): Promise<number> {
  if (!declaration) return 0;
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, discoveryCronContext(), {
    and: [
      { property: "Status", select: { equals: "Pending" } },
      { property: "To Unit", select: { equals: unit } },
      { property: "Type", select: { equals: "Work" } },
    ],
  });

  let scheduled = 0;
  for (const handoff of pending) {
    // The Unit's own intake screen runs BEFORE anything is registered: a
    // skipped Handoff gets no Work and no claim and is left exactly as found.
    if (declaration.screen && (await declaration.screen(env, handoff)) === "skip") continue;

    let workId = await kvGet(env, `handoff_workitem:${handoff.id}`);
    if (!workId) {
      // No live Telegram session behind this Handoff -- e.g. created
      // directly in Notion by the isolated Sales Executive project, which
      // has no WorkState of its own in this Worker. Create a fresh session
      // instead of skipping it, so the receiving Unit can still pick it up.
      // Defaults to Martin's DM, his preferred front door for every
      // Unit/Hat's work, since there's no originating chat to inherit.
      //
      // The destination facts (To Unit / To Hat) resolve the Organization and
      // the Action BEFORE the Work exists -- a failure, or an ambiguous
      // multi-Hat destination, stops here rather than registering Work under
      // a guessed Hat/Action.
      const entry = await resolveHandoffEntry(env, handoff, unit);
      if (!entry) continue;
      // Matter identity is resolved BEFORE the Work exists (the Handoff's own
      // Matter_Token fact -> canonical page id), so the new Work is created
      // already carrying it. A token that does not resolve stops here: no
      // Work, no handoff_workitem mapping, Handoff stays Pending.
      const matter = await resolveHandoffMatterIdentity(env, handoff);
      if (!matter) continue;
      try {
        workId = newWorkId();
        const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
        const threadId = undefined;
        const stub = getSessionStub(env, workId);
        await stub.init(workId, chatId, unit, entry.hat, threadId, {
          handoffId: handoff.id,
          // The RESOLVED pickup Action is recorded at creation, so
          // Work.actionName is the authority Access reads from the moment
          // this Work exists.
          actionName: entry.actionName,
          // Canonical Matter identity, resolved above: WorkSession.save
          // persists both, sessions_index then carries matterId, and the
          // existing syncMatterContinuationPointer establishes the
          // matter_current_work pointer -- no new write path.
          matterId: matter.matterId,
          matterToken: matter.matterToken,
        });
        await kvPut(env, `handoff_workitem:${handoff.id}`, workId);
        console.log(`Created work item ${workId} for externally-created ${unit} Handoff ${handoff.id} (no prior session)`);
      } catch (err) {
        console.error(`Failed to create a work item for externally-created ${unit} Handoff ${handoff.id}`, err);
        await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
        continue;
      }
    }

    // Detected and registered -- a hold means that is the whole job this
    // cycle: execution waits for a deliberate human step, not this loop.
    if (declaration.hold && (await declaration.hold(env, handoff))) continue;

    const stub = getSessionStub(env, workId);
    try {
      await stub.schedulePickup(unit);
      scheduled++;
    } catch (err) {
      await notifyMartinOfDiscoveryFailure(env, handoff.id, err);
    }
  }
  return scheduled;
}

/** Every Unit whose manifest declares a Handoff pickup, in registry order. */
export function unitsWithHandoffPickup(): Unit[] {
  return (Object.entries(getUnitManifests()) as [Unit, UnitManifest | undefined][]).filter(([, manifest]) => manifest?.handoffPickup).map(([unit]) => unit);
}

/**
 * Runs the one discovery loop for every Unit that declares a Handoff pickup,
 * in registry order. Units run in sequence; an error that escapes one Unit's
 * discovery (a failed Notion query) propagates to the caller, which reports
 * it -- exactly as the former four separate calls did. Returns the scheduled
 * count per Unit.
 */
export async function discoverPendingHandoffsAllUnits(env: Env): Promise<Partial<Record<Unit, number>>> {
  const counts: Partial<Record<Unit, number>> = {};
  for (const unit of unitsWithHandoffPickup()) {
    counts[unit] = await discoverPendingHandoffsForUnit(env, unit);
  }
  return counts;
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
  const pending = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, discoveryCronContext(),  {
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
  const results = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, discoveryCronContext(),  {
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
    kvGet(env, lastSentKey),
    kvGet(env, lastFingerprintKey),
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
  await kvPut(env, lastSentKey, String(Date.now()));
  await kvPut(env, lastFingerprintKey, fingerprint);
}

// Guards runCheckHandoffs's non-manual invocations ("runtime_auto" and
// "notion_webhook") against overlapping/recursive re-entry -- see
// runCheckHandoffs's doc comment. Deliberately NOT applied to a manual
// /checkhandoffs invocation (Martin must always be able to run the command
// directly, even if a background continuation happens to be mid-flight).
// Shared across both non-manual sources: both are background sweeps of the
// exact same discovery functions, so overlapping either with the other is
// exactly as wasteful/risky as overlapping it with itself.
const AUTO_CHECKHANDOFFS_GUARD_KEY = "checkhandoffs_auto_inflight";
// Cloudflare KV rejects any expirationTtl below 60 seconds (confirmed
// live: "Invalid expiration_ttl of 30. Expiration TTL must be at least
// 60.", which made every notion_webhook/runtime_auto-sourced
// runCheckHandoffs call throw on the KV PUT below before ever reaching
// the discovery sweep). 60 is the platform minimum and the closest
// approximation to this guard's original short-lived intent.
const AUTO_CHECKHANDOFFS_GUARD_TTL_SECONDS = 60;

/** Which caller invoked runCheckHandoffs -- see runCheckHandoffs's doc comment for the semantics of each. */
export type CheckHandoffsSource = "manual" | "runtime_auto" | "notion_webhook";

/**
 * The exact existing /checkhandoffs command body, factored out so it can be
 * invoked identically from three places:
 *
 * - "manual" (default) -- the /checkhandoffs Telegram command (index.ts).
 *   Unchanged behavior: replies in the same chat/thread it was invoked from.
 * - "runtime_auto" -- the automatic post-confirmation continuation a Hat
 *   triggers right after successfully queuing a Handoff inside this Worker
 *   (see maybeAutoContinueCheckHandoffs, and each Unit's producer call
 *   site, e.g. salesExecutive.ts's handleInterventionText). Same reply
 *   behavior as "manual" -- this is still a reaction to something that
 *   just happened in the same chat/thread, just triggered by the runtime
 *   instead of Martin typing the command.
 * - "notion_webhook" -- background/event-driven detection of a Handoff
 *   created directly in Notion by an authorized external writer (see
 *   notionWebhook.ts). No Telegram user is waiting on a reply in any
 *   particular chat/thread here, so this source never sends the
 *   manual/runtime_auto per-unit or cross-unit summary reply -- Operations
 *   telemetry for a webhook-triggered run comes entirely from the
 *   discovery functions' own existing signals (a Hat's own pickup
 *   confirmation when it actually processes something, the Sales-specific
 *   "SALES HANDOFF READY" notification, and notifyMartinOfDiscoveryFailure
 *   on error) -- never a synthetic /checkhandoffs message and never a fake
 *   reply into the Conversation topic.
 *
 * Same discovery calls, same claim/pickup gates, same per-Unit/dm/unmapped
 * routing logic in every case -- nothing about what counts as a Handoff or
 * how it's processed changes based on source; only whether/how a summary
 * reply is sent does.
 *
 * chatId/threadId determine which Telegram stream a reply (for "manual"/
 * "runtime_auto") lands in and which Unit's topic resolveUnitForThread
 * resolves to. Every discovery function above always sweeps all five
 * pickup directions regardless of unitHere (only which summary line is
 * sent back differs) -- so calling this from the chat/thread a Hat's own
 * confirmation was just sent to reliably discovers and picks up the
 * Handoff that was just queued, without needing to resolve or guess which
 * specific Handoff to check. "notion_webhook" always passes Martin's own
 * DM (undefined threadId) since a webhook event has no Telegram thread of
 * its own -- resolveUnitForThread(undefined) is "dm", so it runs the same
 * full cross-Unit sweep the dm/unmapped branch always has, just without
 * that branch's own summary reply.
 *
 * "runtime_auto"/"notion_webhook" guard against overlapping re-entry (see
 * AUTO_CHECKHANDOFFS_GUARD_KEY) -- a short-lived KV flag, not a call-count
 * limit, since by construction (every Hat pickup stops at an approval gate
 * before it would ever queue a further Handoff on its own -- see the
 * automation task's recursion analysis) a background invocation cannot
 * actually cause another one to fire; this guard exists as an explicit,
 * testable safety net regardless. "manual" never applies or checks it.
 */
export async function runCheckHandoffs(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  opts: { source?: CheckHandoffsSource } = {},
): Promise<void> {
  const source = opts.source ?? "manual";
  const guarded = source === "runtime_auto" || source === "notion_webhook";

  if (guarded) {
    const inflight = await kvGet(env, AUTO_CHECKHANDOFFS_GUARD_KEY);
    if (inflight) {
      console.log(`Background /checkhandoffs continuation (${source}) skipped -- already in flight (recursion guard)`);
      return;
    }
    await kvPut(env, AUTO_CHECKHANDOFFS_GUARD_KEY, "1", { expirationTtl: AUTO_CHECKHANDOFFS_GUARD_TTL_SECONDS });
  }

  try {
    // Same discovery logic /admin/run-finance-discovery and the 30-minute
    // native Cron Trigger already run -- exposed as a command (and now
    // also as an automatic continuation and a webhook-triggered run) so it
    // can run immediately rather than waiting for the next scheduled cycle.
    await kvPut(env, "last_cron_run", new Date().toISOString()).catch((err) =>
      console.error("Failed to record last_cron_run", err),
    );
    const unitHere = resolveUnitForThread(env, threadId);
    try {
      if (unitHere !== "dm" && unitHere !== "unmapped" && unitsWithHandoffPickup().includes(unitHere)) {
        // Every Unit that declares a Handoff pickup (Marketing's is
        // Handoff-only -- chat-originated Marketing work still goes through
        // handleMarketingIntake directly, never this discovery path).
        // Discovery only counts a Handoff as scheduled for pickup if it has
        // (or can register) a work item; a Handoff created directly in
        // Notion -- e.g. by the isolated Sales Executive project -- has no
        // handoff_workitem mapping until discovery registers one, and a
        // Handoff that cannot be registered stays Pending though genuinely
        // there. Query Notion directly too, so the reply can tell "nothing
        // pending" apart from "pending but stuck" instead of reporting both
        // as the same "No Handoffs pending" message.
        const scheduledByUnit = await discoverPendingHandoffsAllUnits(env);
        await checkStaleHandoffs(env);
        // notion_webhook always passes threadId undefined (Martin's DM),
        // so resolveUnitForThread never resolves to a specific Unit here --
        // this branch only ever runs for "manual"/"runtime_auto".
        const pendingCount = await countPendingHandoffsForUnit(env, unitHere);
        const scheduledForThisUnit = scheduledByUnit[unitHere] ?? 0;
        let reply: string;
        if (pendingCount === 0) {
          reply = `No Handoffs pending for ${unitHere}.`;
        } else if (scheduledForThisUnit >= pendingCount) {
          reply = `Scheduled pickup for ${scheduledForThisUnit} Handoff(s) for ${unitHere}.`;
        } else {
          reply = `${pendingCount} Handoff(s) pending for ${unitHere}, but pickup could not be scheduled for ${pendingCount - scheduledForThisUnit} of them (no handoff_workitem mapping -- likely created outside a live Telegram session, e.g. directly in Notion or by the isolated Sales Executive project). Needs manual follow-up.`;
        }
        await sendMessage(env, chatId, reply, undefined, threadId);
      } else if (unitHere === "dm" || unitHere === "unmapped") {
        // No specific Unit to scope to -- fall back to the combined
        // summary across all real pickup directions.
        const scheduledByUnit = await discoverPendingHandoffsAllUnits(env);
        await checkStaleHandoffs(env);
        if (source === "notion_webhook") {
          // Background/event-driven: no Telegram user is waiting on a
          // reply anywhere, and there is no per-Handoff context to target
          // one at -- Operations telemetry for this run comes entirely
          // from the discovery functions' own signals above (a Hat's own
          // pickup confirmation, the Sales-specific ready notification,
          // and notifyMartinOfDiscoveryFailure on error), never a
          // synthetic summary message.
          return;
        }
        // This is a cross-Unit operational summary, not a reply about any
        // single work item -- belongs in the Operations stream (per
        // Martin's explicit request), not wherever /checkhandoffs happened
        // to be typed. The per-Unit branch above still replies in-thread,
        // since that IS about the specific work item(s) in that topic.
        await sendOperationsMessage(
          env,
          `Checked Handoffs: pickup scheduled for ${Object.entries(scheduledByUnit)
            .map(([unit, count]) => `${count} ${unit} Handoff(s)`)
            .join(", ")}.`,
        );
      } else {
        // A Unit that declares no Handoff pickup (Business Development,
        // Creative & Design, Operations) -- just report whether anything is
        // queued for it rather than attempting a pickup that doesn't exist.
        const pendingCount = await countPendingHandoffsForUnit(env, unitHere);
        const reply =
          pendingCount > 0
            ? `${pendingCount} Handoff(s) pending for ${unitHere} — no automated pickup exists yet for this Unit.`
            : `No Handoffs pending for ${unitHere}.`;
        await sendMessage(env, chatId, reply, undefined, threadId);
      }
    } catch (err) {
      console.error("Unhandled error in /checkhandoffs", err);
      if (source !== "notion_webhook") {
        await sendMessage(env, chatId, "Handoff discovery failed unexpectedly. Logged for review — will retry next cycle.", undefined, threadId);
      }
    }
  } finally {
    if (guarded) {
      await kvDelete(env, AUTO_CHECKHANDOFFS_GUARD_KEY).catch((err) =>
        console.error("Failed to clear the /checkhandoffs background-continuation recursion guard", err),
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
  await runCheckHandoffs(env, chatId, threadId, { source: "runtime_auto" }).catch((err) =>
    console.error("Automatic /checkhandoffs continuation failed", err),
  );
}
