import type { Env, SessionSummary, WorkState } from "./types";
import { queryDataSource, uniqueId } from "./notion";
import { workSessionReadContext } from "./access";
import { getSessionStub, setActiveWorkId } from "./sessionRouting";
import { continueExistingWork } from "./workContinuation";

/**
 * Matter-based continuation -- the runtime's derived Business Object ->
 * current Work index, and the one place it is resolved.
 *
 * THE SPLIT. Matter answers exactly one question -- "which Work should I
 * resume?" -- and stops at the workId. Work answers the rest: what is the
 * current execution state and where does it continue, decided by the
 * existing WorkSession from its own `unit`, `hat`, `actionName`, `stage`
 * and `awaiting`. This module therefore does no Unit/Hat/action resolution
 * and holds no execution state: after it resolves a workId, continuation
 * is `continueExistingWork` in src/workContinuation.ts -- the same path an
 * explicit message reply, this chat's `active:` pointer and the
 * `/sessions` switch button already use -- so there is exactly one resume
 * implementation in the runtime and Matter contributes no second one.
 *
 * THE MODEL (docs/enig-operating-model.md, "Matter is the continuation
 * anchor"). Work stays the canonical execution identity: it owns lifecycle,
 * state, routing, continuation, Handoffs, results, failure and closure, and
 * its id never changes for the life of the Work -- a Handoff crossing Units
 * keeps operating on the same WorkSession (see src/handoffOwnership.ts).
 * Matter is the user-facing anchor: a person thinks "continue MAT-20", not
 * "resume Work e0922db0... on session …", and must not have to name a Unit,
 * Hat, Work or Session to get back to work in progress. Session is
 * infrastructure and is deliberately not user-selectable.
 *
 * This module therefore maintains exactly one KV pointer per Matter:
 *
 *     matter_current_work:<matterId> -> workId
 *
 * …and resolves it back to the EXISTING WorkSession on demand. It is a
 * derived index, never a second source of truth: WorkState still decides
 * whether a Work is resumable, `sessions_index` still decides what is open,
 * and this pointer only remembers which of them the Matter is currently
 * pointed at.
 *
 * WHAT IT IS NOT:
 * - Not Matter state in Notion: nothing here writes to Notion, and the
 *   Matter Business Object gains no current-work field (KV only).
 * - Not a second Durable Object: the pointer resolves to the WorkSession
 *   that already exists.
 * - Not `active:<chatId>:<threadId>`: that stays an interaction-local
 *   pointer -- "what this chat/topic was last doing". A Matter must be
 *   resumable independently of it (a different chat, a DM, no pointer at
 *   all), so the two converge on the same Work rather than compete.
 * - Not `handoff_workitem:<handoffId>`: that stays the Handoff association
 *   discovery needs, independent of Matter continuation.
 *
 * LIFECYCLE (what makes a Work "the current Work for this Matter"):
 * 1. no current Work            -> this Work becomes current;
 * 2. already current            -> no-op;
 * 3. pointer names a resumable Work that is not this one
 *                                -> the pointer STAYS with it. Another Work
 *                                   that merely contains the same matterId
 *                                   does not become current;
 * 4. pointer names a Work that is gone or terminal
 *                                -> advances deterministically to this Work;
 * 5. this Work becomes terminal  -> the pointer advances to the one
 *                                   remaining resumable candidate, or is
 *                                   removed when there is none (and removed
 *                                   rather than guessed at when there are
 *                                   several).
 * `sessions_index` -- which this module already maintains a field on -- is
 * the runtime's own record of open Work, so resumability is read from it
 * rather than re-derived.
 *
 * FAIL CLOSED. Resolution never guesses: no current Work, a stale pointer
 * to a missing/terminal Work, an inconsistent Matter identity, or several
 * resumable candidates with nothing to choose between all return
 * `{ ok: false, reason }` -- the same resolution-failure convention
 * checkHandoffs.ts's deriveHandoffDestination uses -- so the caller refuses
 * instead of resuming the wrong Work. Nothing here throws: a derived index
 * must never be able to break the Work it indexes.
 */

/**
 * KV prefix for the derived pointer. Every raw key construction in the
 * runtime goes through matterCurrentWorkKey so the prefix lives in exactly
 * one place.
 */
export const MATTER_CURRENT_WORK_PREFIX = "matter_current_work:";

export function matterCurrentWorkKey(matterId: string): string {
  return `${MATTER_CURRENT_WORK_PREFIX}${matterId}`;
}

/**
 * The terminal-stage predicate, in one place: identical to the eviction
 * WorkSession.updateRegistry applies to sessions_index, so "what /sessions
 * treats as closed" and "what Matter continuation treats as non-resumable"
 * can never drift apart.
 */
export function isTerminalWorkStage(stage: string): boolean {
  return stage === "complete" || stage === "closed_not_qualified" || stage === "cancelled";
}

/** A Matter lookup that could not decide -- the caller refuses, never guesses. */
export type MatterContinuationResult =
  | { ok: true; workId: string; state: WorkState; matterId: string }
  | { ok: false; reason: string };

async function readSessionsIndex(env: Env): Promise<SessionSummary[]> {
  const raw = await env.STATE_KV.get("sessions_index");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // An unreadable index is not permission to guess which Work is open.
    console.error("matterContinuation: sessions_index could not be parsed -- treating it as empty", err);
    return [];
  }
}

/** Open (resumable) Works this Matter currently has, from the runtime's own index. */
function resumableCandidates(index: SessionSummary[], matterId: string): SessionSummary[] {
  return index.filter((s) => s.matterId === matterId && !isTerminalWorkStage(s.stage));
}

/**
 * Deterministically resolves an ENIG Matter token (e.g. "MAT-20") to the
 * Matter's page id -- the identity the continuation pointer is keyed on.
 * Same fail-closed matching as identityResolution: exact unique_id match
 * against the token's own number, and the Matter must actually relate to an
 * Entity; null otherwise, never a guess. A read, never a write -- Notion is
 * untouched by this task's own machinery beyond this lookup.
 */
export async function resolveMatterIdFromToken(env: Env, matterToken: string): Promise<string | null> {
  const token = matterToken.trim().toUpperCase();
  const shape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(token);
  if (!shape) return null;
  const number = Number(shape[2]);
  const candidates = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, workSessionReadContext(), {
    property: "Matter_ID",
    unique_id: { equals: number },
  });
  const matter = candidates.find((m) => uniqueId(m.properties.Matter_ID) === token);
  if (!matter) return null;
  // A Matter with no related Entity is not a resolvable Matter (mirrors
  // resolveMatterFromText's own fail-closed requirement).
  if (!matter.properties.Entity?.relation?.[0]?.id) return null;
  return matter.id;
}

/**
 * Derives `state.matterId` from `state.matterToken` the first time it can,
 * so the pointer can be keyed canonically (page id) no matter which Unit
 * learned the Matter first: Sales learns the page id directly, Strategy and
 * Finance only ever see the opaque token.
 *
 * Runs from WorkSession.save before the state is persisted, so a resolved
 * id is stored with the Work it belongs to and is never re-resolved. Never
 * throws: a transient read failure is retried on the next save (deliberately
 * not cached), while a token that simply does not resolve to a real Matter
 * is remembered as unresolvable so it is not re-queried on every save.
 */
export async function ensureMatterIdentity(env: Env, state: WorkState): Promise<void> {
  if (state.matterId?.trim()) return;
  if (state.matterIdUnresolved) return;
  const token = state.matterToken?.trim();
  if (!token) return;
  try {
    const matterId = await resolveMatterIdFromToken(env, token);
    if (matterId) {
      state.matterId = matterId;
    } else {
      state.matterIdUnresolved = true;
      console.error(
        `matterContinuation: Matter token "${token}" (work ${state.workId}) did not resolve to a real Matter -- no continuation pointer will be established for this Work`,
      );
    }
  } catch (err) {
    console.error(`matterContinuation: could not resolve Matter token "${token}" (work ${state.workId}) -- will retry on the next save`, err);
  }
}

/**
 * Establishes or advances the pointer when a Work is saved -- called from
 * WorkSession.updateRegistry AFTER sessions_index has been written, so the
 * index already reflects this Work's latest stage (and, for a terminal
 * save, already excludes it).
 *
 * Never throws: this is a derived index, and a failure here must not fail
 * the Work it indexes.
 */
export async function syncMatterContinuationPointer(env: Env, state: WorkState, isTerminal: boolean): Promise<void> {
  const matterId = state.matterId?.trim();
  if (!matterId) return;
  try {
    if (isTerminal) {
      await advanceMatterPointerOnTerminal(env, state, matterId);
    } else {
      await establishMatterCurrentWork(env, state, matterId);
    }
  } catch (err) {
    console.error(`matterContinuation: pointer sync failed for work ${state.workId} (Matter ${matterId})`, err);
  }
}

/**
 * Lifecycle rules 1-4 above: this Work becomes the Matter's current Work
 * only when nothing else resumable is already current.
 */
async function establishMatterCurrentWork(env: Env, state: WorkState, matterId: string): Promise<void> {
  const key = matterCurrentWorkKey(matterId);
  const existing = await env.STATE_KV.get(key);
  if (existing === state.workId) return;
  if (existing) {
    const holder = (await readSessionsIndex(env)).find((s) => s.workId === existing);
    if (holder && !isTerminalWorkStage(holder.stage)) {
      // Rule 3: a resumable Work is already designated current. This Work
      // holds the same Matter but has not become current -- recorded in
      // sessions_index like any other open Work, and picked up if/when the
      // holder terminates (rule 5). Deliberately not overwritten.
      return;
    }
    // Rule 4: the holder is gone or terminal -- advance deterministically.
  }
  await env.STATE_KV.put(key, state.workId);
}

/**
 * Lifecycle rule 5: when the Work that IS current terminates, the pointer
 * advances to the single remaining resumable Work for this Matter, or is
 * removed when there is none. With several candidates there is nothing to
 * choose between, so the pointer is removed (and logged) rather than
 * guessed -- resolution then fails closed as ambiguous instead of resuming
 * an arbitrary Work. No Work is ever invented to satisfy the pointer.
 */
async function advanceMatterPointerOnTerminal(env: Env, state: WorkState, matterId: string): Promise<void> {
  const key = matterCurrentWorkKey(matterId);
  if ((await env.STATE_KV.get(key)) !== state.workId) return; // the pointer already names another Work
  const candidates = resumableCandidates(await readSessionsIndex(env), matterId);
  if (candidates.length === 1) {
    await env.STATE_KV.put(key, candidates[0].workId);
    return;
  }
  await env.STATE_KV.delete(key);
  if (candidates.length > 1) {
    console.error(
      `matterContinuation: Matter ${matterId} has ${candidates.length} resumable Works after Work ${state.workId} terminated -- pointer removed rather than guessing which is current`,
    );
  }
}

/**
 * The resolution half: matter_current_work:<matterId> -> workId, checked
 * against the runtime's own record of open Work. KV/index only -- the caller
 * (resumeMatterWork) reads the WorkSession itself.
 *
 * Fail-closed reasons (never a guess):
 * - no Matter identity supplied;
 * - the pointer is absent and NO Work for the Matter is resumable;
 * - the pointer is absent and SEVERAL Works are resumable.
 * A pointer that IS present is authoritative (that is what makes it a
 * pointer); its staleness is caught by resumeMatterWork against the real
 * WorkState, which is the authority for whether a Work exists at all.
 * A pointer absent with exactly ONE resumable candidate is the pointer
 * having been lost while the answer stays unique -- it is re-established,
 * not guessed.
 */
export async function resolveMatterCurrentWork(env: Env, matterId: string): Promise<{ ok: true; workId: string } | { ok: false; reason: string }> {
  const id = matterId.trim();
  if (!id) return { ok: false, reason: "no Matter identity was supplied" };
  const key = matterCurrentWorkKey(id);
  const pointer = await env.STATE_KV.get(key);
  if (pointer) return { ok: true, workId: pointer };

  const candidates = resumableCandidates(await readSessionsIndex(env), id);
  if (candidates.length === 1) {
    await env.STATE_KV.put(key, candidates[0].workId);
    return { ok: true, workId: candidates[0].workId };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: "it has no current Work" };
  }
  return {
    ok: false,
    reason: `it has ${candidates.length} resumable Works and no current Work to choose between -- refusing to guess`,
  };
}

/**
 * What the user's argument may name a Matter by:
 * - an ENIG token ("MAT-20") -- what a person actually types;
 * - the Matter's own page id -- the canonical identity, accepted so the
 *   pointer can be reached without a lookup.
 */
export function parseMatterArgument(argument: string): { kind: "token"; token: string } | { kind: "page_id"; matterId: string } | { kind: "invalid"; reason: string } {
  const trimmed = argument.trim();
  if (!trimmed) return { kind: "invalid", reason: "no Matter was named" };
  if (/^[A-Za-z]{1,6}-\d{1,6}$/.test(trimmed)) return { kind: "token", token: trimmed.toUpperCase() };
  const hex = trimmed.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return { kind: "page_id", matterId: hex.toLowerCase() };
  return { kind: "invalid", reason: `"${trimmed}" is neither a Matter token (e.g. MAT-20) nor a Matter page id` };
}

/**
 * The Matter half of the boundary, and nothing more: a Matter argument ->
 * the identity of the Work to resume. Resolves the argument to a Matter
 * page id, then `matter_current_work:<matterId>` to a workId. It stops
 * before touching any WorkSession -- "which Work should I resume?" is the
 * only question Matter answers, and every failure here is a reason the
 * caller can show (never a guess): the argument is not a Matter, the token
 * resolves to no Matter, or the Matter has no unambiguous current Work.
 */
async function resolveMatterWorkForArgument(env: Env, argument: string): Promise<{ ok: true; matterId: string; workId: string } | { ok: false; reason: string }> {
  const parsed = parseMatterArgument(argument);
  if (parsed.kind === "invalid") return { ok: false, reason: parsed.reason };

  let matterId: string | null;
  if (parsed.kind === "page_id") {
    matterId = parsed.matterId;
  } else {
    try {
      matterId = await resolveMatterIdFromToken(env, parsed.token);
    } catch (err) {
      console.error(`matterContinuation: Matter token lookup failed for "${parsed.token}"`, err);
      return { ok: false, reason: `the Matter token "${parsed.token}" could not be looked up right now -- try again` };
    }
    if (!matterId) return { ok: false, reason: `"${parsed.token}" does not resolve to an existing Matter` };
  }

  const resolved = await resolveMatterCurrentWork(env, matterId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, matterId, workId: resolved.workId };
}

/**
 * The fail-closed checks that belong to resuming a *pointer's* Work:
 * the pointer may be stale (Work gone or already terminal) or point at a
 * Work that records a different Matter. Shared by both public entries so
 * the refusal reasons cannot drift between them. Purely about state the
 * Work already owns -- it never mutates `unit`, `hat`, `actionName` or any
 * other execution identity, because selecting a Matter is not a reason for
 * the Work to become something else.
 */
function validateResumedMatterWork(state: WorkState, matterId: string): MatterContinuationResult {
  if (isTerminalWorkStage(state.stage)) {
    return { ok: false, reason: `its current Work ${state.workId} is already ${state.stage}` };
  }
  if (state.matterId !== matterId) {
    return {
      ok: false,
      reason: `its current Work ${state.workId} records a different Matter -- identity is inconsistent, refusing to resume it`,
    };
  }
  return { ok: true, workId: state.workId, state, matterId };
}

/**
 * Matter -> the existing WorkSession's current state, without entering it.
 * No Unit, Hat, Work or Session is chosen by the caller; every
 * disambiguation happens here or fails closed with a reason the caller can
 * show (see validateResumedMatterWork).
 *
 * Kept as the resolution-only entry (used where only the identity/state
 * answer is wanted); `continueMatterWork` is the one that actually enters
 * the Work's continuation path.
 */
export async function resumeMatterWork(env: Env, argument: string): Promise<MatterContinuationResult> {
  const resolved = await resolveMatterWorkForArgument(env, argument);
  if (!resolved.ok) return resolved;

  const state = await getSessionStub(env, resolved.workId).getState();
  if (!state) {
    return { ok: false, reason: `its current Work ${resolved.workId} no longer exists` };
  }
  return validateResumedMatterWork(state, resolved.matterId);
}

/**
 * **Open Matter -> Continue.** The user-facing entry point, in full:
 *
 *   Matter argument -> matter_current_work:<matterId> -> workId
 *     -> continueExistingWork(...)  <- the shared Work path (workContinuation.ts)
 *     -> this chat's interaction-local active pointer, pointing at that Work
 *
 * Matter resolution stops at the workId; from there this is the SAME path
 * `routeIncomingText`'s `reply_msg:`/active-pointer association and the
 * `/sessions` switch button use to pick up an existing Work -- no Unit,
 * Hat, Work or Session is selected by the caller, no Unit/Hat/action
 * resolution is re-implemented here, and no second Matter-specific resume
 * engine exists. The `active:` pointer is written *after* resolution as
 * the interaction-local effect (exactly as switching does) so the next
 * reply in this chat converges on the same Work; it is never read here,
 * so Matter continuation neither requires nor is overridden by it.
 *
 * Fail closed before anything is claimed: a stale pointer (Work missing or
 * terminal) or an inconsistent Matter identity refuses with a reason and
 * writes no pointer at all -- and no Work is ever created to make a
 * refusal unnecessary.
 */
export async function continueMatterWork(env: Env, chatId: number, threadId: number | undefined, argument: string): Promise<MatterContinuationResult> {
  const resolved = await resolveMatterWorkForArgument(env, argument);
  if (!resolved.ok) return resolved;

  const entered = await continueExistingWork(env, chatId, threadId, resolved.workId);
  if (entered.kind === "missing") {
    return { ok: false, reason: `its current Work ${resolved.workId} no longer exists` };
  }
  const validated = validateResumedMatterWork(entered.state, resolved.matterId);
  if (!validated.ok) return validated;

  await setActiveWorkId(env, chatId, threadId, validated.workId);
  return validated;
}
