import type { Env } from "./types";
import { getWatchedGoogleDoc, getValidGoogleAccessToken, type WatchedGoogleDoc } from "./googleOAuth";
import { processGoogleDocComments } from "./googleDocComments";
import { sendOperationsMessage } from "./telegram";
import { kvGet, kvPut, kvList } from "./kvStore";
import { DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS, driveDocLockStub } from "./driveDocLockState";

/**
 * Google Drive `files.watch` push notifications for watched Proposal Docs.
 *
 * WHY THIS EXISTS. The comment poller (googleDocComments.ts) is driven by an
 * external cron hitting /admin/poll-google-doc-comments on an interval. That
 * interval is the floor on how fast a Martin comment or resolve reaches the
 * approval cycle. Drive's `files.watch` API pushes a notification when a
 * watched file changes, so a change can start its pass within seconds instead
 * of waiting out the poll.
 *
 * WHAT A NOTIFICATION IS, AND IS NOT. A `files.watch` notification says only
 * "this file changed". Drive does not tell the receiver WHICH comment changed,
 * whether it was resolved, or what it says -- and comment-level change detail
 * is explicitly not something this design trusts. So a notification is NEVER
 * treated as an incremental event record. It is a signal to re-read the
 * document's COMPLETE comment list through the exact same single-document pass
 * the poller uses (processGoogleDocComments), because
 * syncProposalDocApprovalCycle's input is the full observed resolution state.
 * Inferring anything from notification headers would silently corrupt that.
 *
 * THE POLLER STAYS. This is a promptness optimization, never a replacement.
 * Notifications can be lost, delayed, duplicated, or arrive with no useful
 * detail; the poller remains the mechanism that guarantees a doc is eventually
 * fully processed. Both paths run the SAME pass, so they cannot drift.
 *
 * TRUST BOUNDARY. The only thing an incoming request may name is a CHANNEL ID
 * and a CHANNEL TOKEN, both of which this system minted at registration time.
 * The channel record -- which document it is bound to, and the secret that
 * authenticates it -- lives in Cloudflare KV, written only by the
 * admin-authorized registration path. The document that gets processed is read
 * from that trusted record, NEVER from the request body or any header. An
 * unknown channel, a wrong token, or a channel whose document is no longer
 * registered all fail closed with no processing at all.
 */

// ---------------------------------------------------------------------------
// Channel records (Cloudflare KV only -- never Notion, never the Turso
// fallback; see kvStore.ts NEVER_FALLBACK_EXACT_PREFIXES).
// ---------------------------------------------------------------------------

/**
 * A registered Drive watch channel. One channel binds exactly one channel id
 * and secret to exactly one document.
 *
 * `resourceId` and `expiration` come back from Drive's own `files.watch`
 * response and are retained because renewal and stopping an old channel both
 * need them: Drive identifies a channel by its resourceId (not the client-chosen
 * channel id) on `files.stop`, and expiration is the ONLY authority on when the
 * channel dies -- Drive watches expire within 24h, but the exact lifetime is
 * Drive's to choose, so it is always read from the response rather than assumed.
 */
export interface DriveWatchChannel {
  /** The client-chosen channel id. This is what arrives in X-Goog-Channel-ID. */
  channelId: string;
  /**
   * The per-channel secret. Sent by Drive as X-Goog-Channel-Token on every
   * notification for this channel. Stored ONLY in Cloudflare KV; never logged,
   * never returned in a response, never committed.
   */
  secret: string;
  /** The document this channel is bound to, captured from trusted config at registration. */
  documentId: string;
  /** Drive's returned resource id -- required to stop this channel later. Null when Drive did not return one. */
  resourceId: string | null;
  /** Drive's returned expiration, as an absolute timestamp. Null when Drive did not return one. */
  expiration: string | null;
  createdAt: string;
  /** Last successful renewal, if any. */
  renewedAt: string | null;
  /**
   * `active` channels authenticate notifications. `superseded` ones are kept
   * (not deleted) so an in-flight notification for the old channel can be
   * recognized and refused rather than misread, and so the old resourceId stays
   * available if the old channel still needs to be stopped.
   */
  status: "active" | "superseded";
  /** When superseded, the channel id that replaced it. */
  supersededBy?: string;
  /**
   * Set when Drive answered 2xx but omitted the resourceId. The channel is
   * live in Drive, so its notifications are still accepted (they are
   * authenticated and the document is known), but without a resourceId this
   * runtime cannot cleanly stop it. Surfaced honestly rather than papered over.
   */
  resourceIdMissing?: boolean;
}

const CHANNEL_KEY = "google_drive_channel:";

function channelKey(channelId: string): string {
  return `${CHANNEL_KEY}${channelId}`;
}

async function putChannel(env: Env, channel: DriveWatchChannel): Promise<void> {
  await kvPut(env, channelKey(channel.channelId), JSON.stringify(channel));
}

export async function getChannel(env: Env, channelId: string): Promise<DriveWatchChannel | null> {
  if (!channelId) return null;
  const raw = await kvGet(env, channelKey(channelId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DriveWatchChannel;
  } catch {
    return null;
  }
}

export async function listChannels(env: Env): Promise<DriveWatchChannel[]> {
  const channels: DriveWatchChannel[] = [];
  let cursor: string | undefined;
  do {
    const page = await kvList(env, { prefix: CHANNEL_KEY, cursor });
    for (const key of page.keys) {
      const raw = await kvGet(env, key.name);
      if (!raw) continue;
      try {
        channels.push(JSON.parse(raw) as DriveWatchChannel);
      } catch {
        // corrupt record -- skipped rather than failing the whole listing
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return channels;
}

// ---------------------------------------------------------------------------
// Authentication of an incoming notification
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of the channel token Drive sent against the secret
 * stored at registration. A naive `===` short-circuits on the first differing
 * byte, which leaks how many leading characters matched and turns secret
 * verification into an oracle. Both sides are hashed to a fixed width first so
 * the comparison itself is length-independent as well as content-independent.
 */
async function tokenMatches(sent: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(sent)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export type DriveNotifyRejection =
  | "missing_channel_id"
  | "unknown_channel"
  | "invalid_token"
  | "channel_not_active"
  | "channel_expired"
  | "document_not_registered";

export interface DriveNotifyDecision {
  accepted: boolean;
  rejection?: DriveNotifyRejection;
  channel?: DriveWatchChannel;
  doc?: WatchedGoogleDoc;
}

/**
 * Decides whether an incoming notification may proceed, using ONLY trusted
 * server-side channel state. Nothing in the request except the two channel
 * identifiers is read, and neither identifier is allowed to name a document --
 * the document comes from the channel record this system wrote at registration.
 *
 * Every rejection path is a hard stop: no document is resolved and no pass is
 * started.
 */
export async function authenticateDriveNotification(env: Env, channelId: string, channelToken: string, nowMs: number = Date.now()): Promise<DriveNotifyDecision> {
  if (!channelId) return { accepted: false, rejection: "missing_channel_id" };

  const channel = await getChannel(env, channelId);
  if (!channel) return { accepted: false, rejection: "unknown_channel" };

  // The secret check is the authorization gate. An attacker who can guess or
  // observe a channel id still cannot get a pass to run without the secret.
  if (!channelToken || !(await tokenMatches(channelToken, channel.secret))) {
    return { accepted: false, rejection: "invalid_token", channel };
  }

  if (channel.status !== "active") return { accepted: false, rejection: "channel_not_active", channel };

  // A channel past Drive's own recorded expiration is stale: Drive no longer
  // delivers for it, so anything still presenting it is not a live channel.
  // Refused rather than trusted; renewal (which treats it as due) is what
  // brings the document back under a live channel.
  const exp = expirationMs(channel);
  if (exp !== null && exp <= nowMs) return { accepted: false, rejection: "channel_expired", channel };

  // The document is resolved from the trusted record, not the request. If it
  // is no longer a registered watched doc, there is nothing this runtime is
  // allowed to process -- fail closed rather than act on a stale binding.
  const doc = await getWatchedGoogleDoc(env, channel.documentId);
  if (!doc) return { accepted: false, rejection: "document_not_registered", channel };

  return { accepted: true, channel, doc };
}

// ---------------------------------------------------------------------------
// The per-Doc pass, run in the background under a lock
// ---------------------------------------------------------------------------

// The lock constants and stub live in driveDocLockState.ts so the polling
// safety net (googleDocComments.ts) can take the SAME per-Doc lock without a
// circular import. Re-exported here for existing callers.
export { DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS };
const lockStub = driveDocLockStub;

/**
 * Runs one document's complete comment pass under the per-Doc lock.
 *
 * Duplicate notifications are safe here for two independent reasons. First, the
 * lock refuses a second concurrent pass for the SAME document, so two near
 * -simultaneous notifications cannot run overlapping passes (and the marker
 * semantics from PR #278 make a repeat pass idempotent anyway). Second, the
 * cooldown collapses a burst into one run plus a single catch-up, rather than
 * one run per duplicate.
 *
 * The lock is ALWAYS released, success or failure, in a finally block -- and
 * even a release that never happens is bounded by the TTL above. A failure in
 * the pass itself is reported, never swallowed into a claim of success.
 */
export async function runDriveDocPass(env: Env, documentId: string): Promise<{ ran: boolean; reason?: string }> {
  const stub = lockStub(env, documentId);
  if (!stub) {
    // No lock available means no pass. An unbound namespace must never be
    // treated as "unlocked" -- that would let duplicate notifications overlap
    // exactly when the control meant to prevent it is missing. The polling
    // safety net does not take this lock and remains responsible for the doc.
    console.error(`runDriveDocPass: DRIVE_DOC_LOCK is not bound; refusing to run an unlocked pass for ${documentId}`);
    return { ran: false, reason: "lock_unavailable" };
  }

  let claim: { token: string } | null = null;
  try {
    claim = await stub.tryAcquire(DRIVE_DOC_LOCK_TTL_MS, DRIVE_DOC_COOLDOWN_MS);
  } catch (err) {
    // A lock that cannot be consulted must not be walked through: without it,
    // duplicate notifications WOULD overlap. Refuse the run and let the poller
    // (which does not take this lock) remain the safety net.
    console.error(`runDriveDocPass: could not acquire the lock for ${documentId}`, err);
    return { ran: false, reason: "lock_unavailable" };
  }

  if (!claim) return { ran: false, reason: "already_running_or_recently_ran" };

  try {
    const doc = await getWatchedGoogleDoc(env, documentId);
    if (!doc) {
      // The channel outlived its document registration. Not an error in the
      // pass -- the binding is simply stale, and there is nothing to process.
      return { ran: false, reason: "document_not_registered" };
    }
    const result = await processGoogleDocComments(env, doc);
    return { ran: true, reason: `${result.commentsProcessed} comment(s) processed` };
  } catch (err) {
    console.error(`runDriveDocPass: pass failed for ${documentId}`, err);
    // Reported, never claimed as success. The pass itself records per-comment
    // outcomes; this is the outer guard for anything that escaped it.
    await sendOperationsMessage(
      env,
      `⚠️ Drive comment pass failed\nDocument: ${documentId}\nReason: ${err instanceof Error ? err.message : String(err)}\n\nThe polling safety net will retry this document on its next interval.`,
    ).catch((notifyErr) => console.error("runDriveDocPass: could not send the failure alert", notifyErr));
    return { ran: false, reason: "pass_failed" };
  } finally {
    // Release with the SAME token this pass was given. If the pass hung past
    // the TTL and a successor has since claimed the lock, this token no longer
    // matches and the release is a no-op -- it can never unlock a live pass.
    await stub.release(claim.token).catch((err: unknown) => console.error(`runDriveDocPass: could not release the lock for ${documentId}`, err));
  }
}

// ---------------------------------------------------------------------------
// Drive API calls (mockable in tests via the global fetch, same convention as
// the comment pollers)
// ---------------------------------------------------------------------------

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface WatchRegistrationSuccess {
  ok: true;
  resourceId: string | null;
  expiration: string | null;
  raw: unknown;
}

export interface WatchRegistrationFailure {
  ok: false;
  /** `http` = Drive rejected it; `transport` = we never got an answer, so the outcome is genuinely unknown. */
  failureKind: "http" | "transport";
  status?: number;
  detail: string;
  /**
   * True when the request may have reached Drive even though we have no
   * successful response -- a thrown fetch. In that case a channel MAY exist on
   * Drive's side that this runtime cannot see or stop. Callers must not claim
   * success, and must surface the ambiguity rather than assume either way.
   */
  outcomeUncertain?: boolean;
}

export type WatchRegistrationResult = WatchRegistrationSuccess | WatchRegistrationFailure;

/**
 * Calls Drive's `files.watch` for one file, creating (or re-creating) a push
 * channel to `address`.
 *
 * `id` is the client-chosen channel id and `token` is the per-channel secret;
 * Drive echoes the token back on every notification. `expiration` is OPTIONAL
 * and deliberately NOT computed here: Drive owns the channel lifetime (at most
 * 24h), so the only correct value is the one Drive returns, and this function
 * returns that response verbatim rather than inventing one.
 *
 * Failure is reported honestly in two distinct shapes. An HTTP rejection is a
 * known failure -- Drive did not create the channel. A thrown fetch is an
 * UNCERTAIN outcome: the request may or may not have reached Drive, so a
 * channel may exist that this runtime never learned about. The caller is told
 * which it is, because claiming a clean failure when the true state is unknown
 * would be exactly the kind of unfounded success this codebase refuses to make.
 */
export async function callFilesWatch(token: string, fileId: string, channelId: string, channelSecret: string, address: string): Promise<WatchRegistrationResult> {
  let res: Response;
  try {
    res = await fetch(`${DRIVE_API}/files/${fileId}/watch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address,
        token: channelSecret,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      failureKind: "transport",
      detail: err instanceof Error ? err.message : String(err),
      outcomeUncertain: true,
    };
  }

  if (!res.ok) {
    return { ok: false, failureKind: "http", status: res.status, detail: `HTTP ${res.status}` };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = null;
  }
  const body = (raw ?? {}) as { resourceId?: string; expiration?: string };
  return {
    ok: true,
    resourceId: typeof body.resourceId === "string" && body.resourceId ? body.resourceId : null,
    // Drive returns expiration as epoch-milliseconds-as-a-string; normalize to
    // an absolute ISO timestamp so every consumer compares like with like. An
    // absent or unparseable value stays null rather than being guessed.
    expiration: normalizeExpiration(body.expiration),
    raw,
  };
}

/**
 * Calls Drive's `files.stop` for one file's channel, so an OLD channel is
 * stopped as soon as its replacement is safely in place.
 *
 * Drive's contract here is specific and easy to get wrong: the FILE id goes in
 * the path, but the CHANNEL is identified by its `resourceId` in the request
 * body -- not by the client-chosen channel id. Sending an empty body would
 * silently stop nothing, leaving an orphaned channel still delivering
 * notifications. Best-effort by design: a failure here is logged and reported,
 * never fatal, because the old channel also ages out on its own within Drive's
 * 24h cap.
 */
export async function callFilesStop(token: string, fileId: string, resourceId: string, channelId?: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(`${DRIVE_API}/files/${fileId}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // `resourceId` is what Drive actually keys the channel on; `id` is the
      // client-chosen channel id, included because Drive's Channel schema
      // accepts both and it disambiguates when several channels touched one file.
      body: JSON.stringify({ ...(channelId ? { id: channelId } : {}), resourceId }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error(`callFilesStop: stop failed for ${fileId}/${resourceId}`, err);
    return { ok: false };
  }
}

function normalizeExpiration(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  // Epoch millis as a string, which is what Drive returns from files.watch.
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The public base URL this Worker is reachable at -- the address Drive must
 * push notifications TO. Configured rather than hardcoded so a staging Worker
 * or a future custom domain does not require a code change.
 */
export function driveNotifyAddress(env: Env): string | null {
  const base = env.WORKER_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/google/drive/notify`;
}

/** A fresh channel id: opaque, unique, and safe to expose in a Drive request body. */
function newChannelId(): string {
  return crypto.randomUUID();
}

/** A fresh per-channel secret: 32 random bytes, base64url. Stored in KV only. */
function newChannelSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type RegisterWatchResult =
  | { ok: true; channel: DriveWatchChannel; alreadyRegistered?: boolean }
  | { ok: false; error: string; uncertain?: boolean };

/** The live (active, not past its stored expiration) channel for a document, if one exists -- the latest-expiring one when a partial failure left more than one. */
async function findLiveChannelForDocument(env: Env, documentId: string, nowMs: number): Promise<DriveWatchChannel | null> {
  const live = (await listChannels(env)).filter((c) => {
    if (c.documentId !== documentId || c.status !== "active") return false;
    const exp = expirationMs(c);
    return exp === null || exp > nowMs;
  });
  live.sort((a, b) => (expirationMs(b) ?? 0) - (expirationMs(a) ?? 0));
  return live[0] ?? null;
}

/**
 * Registers a `files.watch` channel for exactly one document.
 *
 * GUARD: the document must be a currently-registered watched doc AND a
 * Proposal Doc. Both checks read this system's own trusted configuration --
 * there is no path by which a caller can point a channel at an arbitrary
 * document id, because the document is resolved from the registration record
 * that only this runtime writes.
 *
 * PERSISTENCE ORDERING (the part that must not be got wrong): the channel
 * record is written ONLY after Drive has answered, and the record is written
 * with Drive's OWN resourceId and expiration. Nothing is persisted before the
 * response, because a half-written channel would authenticate notifications for
 * a channel Drive never created. A Drive rejection persists nothing at all. A
 * transport failure (outcomeUncertain) also persists nothing, because there is
 * nothing truthful to persist -- but the caller is told the outcome is unknown
 * so it can be surfaced rather than assumed.
 *
 * IDEMPOTENCY: unless `replace` is set (renewal), a document that already has a
 * live channel gets that channel back (`alreadyRegistered`) and Drive is not
 * called, so repeating an admin registration -- e.g. after a response was lost
 * -- never stacks a second live channel on the same document.
 */
export async function registerWatchForDocument(
  env: Env,
  documentId: string,
  options: { replace?: boolean; nowMs?: number } = {},
): Promise<RegisterWatchResult> {
  const address = driveNotifyAddress(env);
  if (!address) return { ok: false, error: "WORKER_PUBLIC_BASE_URL is not configured -- cannot determine where Drive should push notifications" };

  const doc = await getWatchedGoogleDoc(env, documentId);
  if (!doc) return { ok: false, error: "document is not a registered watched Google Doc" };
  if (!doc.proposal) return { ok: false, error: "document is not bound to a Proposal -- watch registration is Proposal-only" };

  if (!options.replace) {
    const existing = await findLiveChannelForDocument(env, documentId, options.nowMs ?? Date.now());
    if (existing) return { ok: true, channel: existing, alreadyRegistered: true };
  }

  const accessToken = await getValidGoogleAccessToken(env, doc.accountIdentifier);
  if (!accessToken) return { ok: false, error: "no valid Google access token for this document's account (re-authorization needed)" };

  const channelId = newChannelId();
  const secret = newChannelSecret();

  const result = await callFilesWatch(accessToken, documentId, channelId, secret, address);
  if (!result.ok) {
    return {
      ok: false,
      error: result.failureKind === "transport"
        ? `Drive registration outcome is UNCERTAIN: the request failed in transit (${result.detail}). A channel may or may not exist on Drive's side; it was NOT recorded here.`
        : `Drive rejected the watch registration: ${result.detail}`,
      uncertain: result.outcomeUncertain === true,
    };
  }

  const channel: DriveWatchChannel = {
    channelId,
    secret,
    documentId,
    resourceId: result.resourceId,
    expiration: result.expiration,
    createdAt: new Date().toISOString(),
    renewedAt: null,
    status: "active",
    ...(result.resourceId ? {} : { resourceIdMissing: true }),
  };

  await putChannel(env, channel);
  return { ok: true, channel };
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

/** How far ahead of actual expiration a channel is considered due for renewal. Renewing early is free; renewing late loses the channel. */
export const RENEW_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface RenewalOutcome {
  channelId: string;
  documentId: string;
  status: "renewed" | "skipped_not_due" | "skipped_no_document" | "failed";
  detail: string;
}

export interface RenewalSummary {
  considered: number;
  renewed: number;
  failed: number;
  outcomes: RenewalOutcome[];
}

function expirationMs(channel: DriveWatchChannel): number | null {
  if (!channel.expiration) return null;
  const ms = Date.parse(channel.expiration);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Renews every active channel that is due, for cron-job.org to call daily.
 *
 * Drive watch channels die within 24h, so a daily call is the minimum that
 * keeps them alive. Each channel is renewed by registering a NEW channel for
 * the same document -- a fresh channel id and secret -- and only once that new
 * registration has SUCCEEDED AND been persisted is the old channel marked
 * superseded. That ordering is the whole point: the old channel is never
 * dropped, forgotten, or stopped before its replacement is known-good, so a
 * failure partway through can never leave the document with no working channel.
 *
 * The new expiration is always the one Drive returns, never an assumed lifetime.
 * A channel whose renewal fails keeps its old record untouched and is reported
 * as failed -- the next daily call will try again, and the old channel's own
 * expiration still bounds how long it can linger.
 */
export async function renewDriveWatchChannels(env: Env, nowMs: number = Date.now()): Promise<RenewalSummary> {
  const channels = await listChannels(env);
  const active = channels.filter((c) => c.status === "active");
  const outcomes: RenewalOutcome[] = [];
  let renewed = 0;
  let failed = 0;

  // Renewal works per DOCUMENT, not per channel. Normally each document has one
  // active channel; more than one means an earlier renewal registered a
  // replacement but failed to supersede the old record. Renewing each of those
  // separately would multiply channels every day, so the group converges back
  // to exactly one: the latest-expiring channel is the current one, the rest
  // are superseded by it (or all by a fresh replacement when it is due).
  const byDocument = new Map<string, DriveWatchChannel[]>();
  for (const c of active) {
    const group = byDocument.get(c.documentId) ?? [];
    group.push(c);
    byDocument.set(c.documentId, group);
  }

  for (const [documentId, group] of byDocument) {
    group.sort((a, b) => (expirationMs(b) ?? 0) - (expirationMs(a) ?? 0));
    const current = group[0];
    const exp = expirationMs(current);
    // A channel with NO recorded expiration is treated as due: we cannot prove
    // it is still alive, and Drive's own lifetime cap means it may already be
    // dead. Re-registering is the safe direction.
    const due = exp === null || exp - nowMs <= RENEW_WINDOW_MS;

    // Each document is isolated: an exception for one (a KV write failing
    // after Drive accepted the replacement, say) is reported for that document
    // and never aborts renewal of the others.
    try {
      let replacement: DriveWatchChannel;
      let toSupersede: DriveWatchChannel[];
      if (due) {
        const result = await registerWatchForDocument(env, documentId, { replace: true, nowMs });
        if (!result.ok) {
          for (const channel of group) {
            failed++;
            outcomes.push({
              channelId: channel.channelId,
              documentId,
              status: "failed",
              detail: `${result.error}${result.uncertain ? " (outcome uncertain -- old channel left in place)" : ""}`,
            });
          }
          continue;
        }
        replacement = result.channel;
        toSupersede = group;
      } else {
        outcomes.push({ channelId: current.channelId, documentId, status: "skipped_not_due", detail: `expires ${current.expiration}` });
        replacement = current;
        toSupersede = group.slice(1);
      }

      for (const channel of toSupersede) {
        try {
          await supersedeChannel(env, channel, replacement.channelId);
        } catch (err) {
          // The replacement is live and persisted; only the old record's
          // status write failed. The next renewal sees two active channels for
          // this document and collapses them -- reported, never claimed.
          console.error(`renewDriveWatchChannels: could not supersede ${channel.channelId} for ${documentId}`, err);
          failed++;
          outcomes.push({
            channelId: channel.channelId,
            documentId,
            status: "failed",
            detail: `replacement ${replacement.channelId} is active, but marking this channel superseded failed; the next renewal collapses it`,
          });
          continue;
        }
        renewed++;
        outcomes.push({
          channelId: channel.channelId,
          documentId,
          status: "renewed",
          detail: `replaced by ${replacement.channelId}; new expiration ${replacement.expiration ?? "unset"}`,
        });
      }
    } catch (err) {
      console.error(`renewDriveWatchChannels: renewal threw for ${documentId}`, err);
      for (const channel of group) {
        failed++;
        outcomes.push({
          channelId: channel.channelId,
          documentId,
          status: "failed",
          detail: `renewal threw (${err instanceof Error ? err.message : String(err)}); existing channel records left in place`,
        });
      }
    }
  }

  return { considered: active.length, renewed, failed, outcomes };
}

/**
 * Marks one channel superseded by its replacement, then best-effort stops it on
 * Drive's side. The record is kept, not deleted, so its resourceId stays
 * available and an in-flight notification for it can still be recognized and
 * refused. Only ever called AFTER the replacement is live and persisted.
 */
async function supersedeChannel(env: Env, channel: DriveWatchChannel, replacementChannelId: string): Promise<void> {
  await putChannel(env, { ...channel, status: "superseded", supersededBy: replacementChannelId });

  // Best-effort cleanup of the old Drive-side channel. Its resourceId is what
  // Drive actually keys on. A channel registered without a resourceId has
  // nothing to stop, and a failed stop is not a renewal failure -- the old
  // channel simply ages out on its own within Drive's 24h cap.
  if (channel.resourceId) {
    try {
      const doc = await getWatchedGoogleDoc(env, channel.documentId);
      if (doc) {
        const token = await getValidGoogleAccessToken(env, doc.accountIdentifier);
        if (token) await callFilesStop(token, channel.documentId, channel.resourceId, channel.channelId);
      }
    } catch (err) {
      console.error(`supersedeChannel: best-effort stop failed for ${channel.channelId}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Automatic registration -- DISABLED BY DEFAULT
// ---------------------------------------------------------------------------

/**
 * Whether automatic watch registration is enabled. Defaults OFF.
 *
 * Registration is deliberately opt-in and explicit: it creates real external
 * state in a third party's system (a live Drive push channel bound to a
 * production Proposal Doc), so it is gated behind an explicit admin call, never
 * something the runtime decides to do on its own. This flag exists so the
 * AUTOMATIC path -- e.g. registering a watch the moment a new Proposal Doc is
 * created -- can be turned on later, deliberately, once the notification path
 * has earned trust in production. Off means off: no code path registers a watch
 * unless an operator explicitly asks for it.
 */
export function isAutoRegisterEnabled(env: Env): boolean {
  const raw = env.DRIVE_WATCH_AUTO_REGISTER?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// ---------------------------------------------------------------------------
// Admin-protected route handlers
//
// These live here rather than inline in index.ts so the authorization and
// failure contracts are testable directly -- the same convention
// workSessionInspect.ts and notionWebhook.ts follow. index.ts only wires the
// routes to them.
//
// Every one of them is fail-closed on the SAME shared operator key the rest of
// the /admin surface checks (WORKER_ADMIN_KEY via ?key=): no key configured,
// or a wrong key, is a 403 that never reaches any Drive or document work.
// ---------------------------------------------------------------------------

function adminJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Shared fail-closed admin gate for the Drive watch endpoints. Returns a Response to send, or null when authorized. */
function requireAdminKey(request: Request, env: Env): Response | null {
  const key = new URL(request.url).searchParams.get("key");
  if (!env.WORKER_ADMIN_KEY || key !== env.WORKER_ADMIN_KEY) {
    return adminJson(403, { ok: false, error: "forbidden" });
  }
  return null;
}

/**
 * GET /admin/register-drive-watch?key=...&documentId=...
 *
 * Registers a Drive files.watch channel for EXACTLY ONE explicitly named
 * Proposal Doc. Deliberately opt-in and one-at-a-time -- there is no "watch
 * everything" action, because each channel is a live external binding to a
 * production Proposal Doc and each must be a deliberate, auditable act. The
 * document is validated against this system's own watched-doc registry AND must
 * be Proposal-bound; a caller cannot point a channel at an arbitrary document.
 *
 * Registering does NOT touch the polling safety net and does NOT enable
 * automatic registration. IMPLEMENTING this endpoint is not permission to call
 * it against a live Proposal Doc -- that remains a separate, explicit act.
 */
export async function handleRegisterDriveWatchRequest(request: Request, env: Env): Promise<Response> {
  const denied = requireAdminKey(request, env);
  if (denied) return denied;

  const documentId = new URL(request.url).searchParams.get("documentId")?.trim();
  if (!documentId) {
    return adminJson(400, { ok: false, error: "documentId query parameter is required" });
  }

  try {
    const result = await registerWatchForDocument(env, documentId);
    if (!result.ok) {
      // 502 for an UNCERTAIN outcome (the request may have reached Drive, so a
      // channel may exist that we cannot see), 400 for a known rejection. The
      // distinction is honest reporting, not decoration.
      return adminJson(result.uncertain ? 502 : 400, { ok: false, error: result.error, uncertain: result.uncertain ?? false });
    }
    // The secret is deliberately NOT echoed back -- it lives in KV and in
    // Drive, nowhere else. Everything needed to identify and later stop this
    // channel is returned.
    const { secret: _withheld, ...safeChannel } = result.channel;
    return adminJson(200, { ok: true, alreadyRegistered: result.alreadyRegistered === true, channel: safeChannel, notifyAddress: driveNotifyAddress(env) });
  } catch (err) {
    console.error("Unhandled error in /admin/register-drive-watch", err);
    return adminJson(500, { ok: false, error: "internal error, logged" });
  }
}

/**
 * GET /admin/renew-drive-watches?key=...
 *
 * Renews every Drive watch channel that is due, for cron-job.org to call
 * DAILY (Drive watch channels expire within at most 24h). Each due channel is
 * replaced by registering a NEW channel for the same document, and the old
 * channel is only marked superseded AFTER the replacement is registered and
 * persisted -- so a failure partway through can never leave a document with no
 * working channel. New expiration always comes from Drive's own response,
 * never an assumed lifetime. Failures are reported per channel and never
 * claimed as success.
 */
export async function handleRenewDriveWatchesRequest(request: Request, env: Env): Promise<Response> {
  const denied = requireAdminKey(request, env);
  if (denied) return denied;

  try {
    const summary = await renewDriveWatchChannels(env);
    return adminJson(200, { ok: summary.failed === 0, ...summary });
  } catch (err) {
    console.error("Unhandled error in /admin/renew-drive-watches", err);
    return adminJson(500, { ok: false, error: "internal error, logged" });
  }
}

/**
 * GET /admin/drive-watch-status?key=...
 *
 * Diagnostic: the current state of the Drive watch surface -- every channel
 * record (WITHOUT secrets), plus whether automatic registration is on.
 * Secrets are withheld for the same reason the registration response withholds
 * them: this response can be read by anyone holding the admin key, and the
 * secret's only job is to be unguessable by someone who does not.
 */
export async function handleDriveWatchStatusRequest(request: Request, env: Env): Promise<Response> {
  const denied = requireAdminKey(request, env);
  if (denied) return denied;

  try {
    const channels = await listChannels(env);
    const safe = channels.map(({ secret: _withheld, ...rest }) => rest);
    return adminJson(200, {
      ok: true,
      autoRegisterEnabled: isAutoRegisterEnabled(env),
      notifyAddress: driveNotifyAddress(env),
      channelCount: safe.length,
      channels: safe,
    });
  } catch (err) {
    console.error("Unhandled error in /admin/drive-watch-status", err);
    return adminJson(500, { ok: false, error: "internal error, logged" });
  }
}

// ---------------------------------------------------------------------------
// Notification receiver
// ---------------------------------------------------------------------------

/** The subset of ExecutionContext this handler needs -- matches the existing notionWebhook convention. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Handles POST /google/drive/notify.
 *
 * Contract, in order:
 *  1. Authenticate the channel id and channel token against trusted KV state.
 *     Unknown channel, wrong token, inactive channel, or an unregistered
 *     document are all hard refusals with NO processing.
 *  2. Acknowledge with HTTP 200 IMMEDIATELY, before any document work. Drive's
 *     delivery must not wait on a full comment pass, and Cloudflare's
 *     background window is what actually runs the pass.
 *  3. Start the pass in the background via ctx.waitUntil, under the per-Doc
 *     lock, so duplicate notifications cannot overlap.
 *
 * Drive's initial `sync` handshake notification (X-Goog-Resource-State: sync)
 * is acknowledged but deliberately does NOT start a pass: it confirms channel
 * delivery, carries no change information, and running a pass on it would be
 * exactly the mistake of treating a notification as an event record.
 */
export async function handleDriveNotifyRequest(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const channelId = request.headers.get("X-Goog-Channel-ID") ?? "";
  const channelToken = request.headers.get("X-Goog-Channel-Token") ?? "";
  const resourceState = request.headers.get("X-Goog-Resource-State") ?? "";

  const decision = await authenticateDriveNotification(env, channelId, channelToken);
  if (!decision.accepted || !decision.channel || !decision.doc) {
    // Refused before any document work. No body is read and no detail of the
    // refusal is echoed back -- an unauthenticated caller learns only that it
    // was refused.
    return new Response("forbidden", { status: 403 });
  }

  // Authenticated. Acknowledge NOW; the pass runs in the background.
  if (resourceState === "sync") {
    // Channel-registration handshake. Acknowledged, nothing to re-read.
    return new Response(JSON.stringify({ ok: true, synced: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const documentId = decision.doc.documentId;
  ctx.waitUntil(
    runDriveDocPass(env, documentId)
      .then((r) => {
        if (!r.ran && r.reason && r.reason !== "already_running_or_recently_ran") {
          console.error(`Drive notify: pass did not run for ${documentId}: ${r.reason}`);
        }
      })
      .catch((err) => console.error(`Drive notify: background pass threw for ${documentId}`, err)),
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
