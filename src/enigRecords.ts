import type { Env } from "./types";
import type { InlineButton } from "./telegram";
import { kvDelete, kvGet, kvPut } from "./kvStore";

/**
 * Databases are read only when the request needs them (Martin's decision,
 * 2026-11-17).
 *
 * Before this, every ENIG chat turn loaded the business snapshot and the
 * cross-Unit Activity & Decision Log -- roughly seven Notion queries per
 * message, for a greeting as much as for a status question. Now ENIG's turn
 * reads them only when one of two things says so:
 *
 * 1. `recordsLikelyNeeded(message)` -- a deterministic check, no AI call --
 *    recognises an obvious status/money/recent-activity QUESTION (a records
 *    word, asked as a question or a plain "show me / catch me up", and never
 *    a request for work) and reads straight away, exactly as before. A false positive costs the same
 *    read as today; a false negative costs one tap, so the check errs towards
 *    reading.
 * 2. Otherwise the turn carries `RECORDS_NOT_READ_RULE` and, when its answer
 *    would need records, ENIG ends with one `READ: <what it needs>` line.
 *    The runtime turns that line into ONE question Martin taps -- "Read
 *    records" / "Not now" (`recordsOfferText`, `offerRecordsRead`) -- and only
 *    his tap re-runs the turn with the records actually loaded. Nothing is
 *    read from Martin's message alone, and a READ line is never shown to him
 *    raw: the runtime writes the question, so what he confirms is the same
 *    words whatever the request was. Same discipline as the Enter-Cowork
 *    offer (`src/enigSuggestion.ts`): single-use, refused from another
 *    chat/thread, one-day expiry, re-validated at tap time.
 *
 * A read that does happen is cached in memory for `RECORDS_CACHE_TTL_MS` so a
 * rapid follow-up ("and the proposals?") does not re-read the same rows. The
 * cache is deliberately NOT in KV: KV is capped at 1,000 writes/day (exhausted
 * in production on 2026-10-09) and this is disposable context, so an isolate
 * that misses simply reads again -- never worse than before. Only a fully
 * successful read is cached (see `isCacheable` in src/chat.ts): a transient
 * Notion failure must not be frozen for the whole TTL.
 *
 * The morning brief always reads (it is a status digest, `runEnigTurn`'s
 * `force` mode). A Unit's own topic chat still reads only that Unit's own
 * Activity Log -- one query, and its Evidence Rule depends on it; gating that
 * path is a separate change, not made here.
 */

/** Callback prefix for the Read-records / Not-now buttons (index.ts). */
export const ENIG_RECORDS_CALLBACK = "enigrecords";
const OFFER_TTL_SECONDS = 24 * 60 * 60;

/** How long one read serves ENIG's turns before it is fetched again. */
export const RECORDS_CACHE_TTL_MS = 3 * 60 * 1000;

/**
 * The deterministic check: does this message look like it needs live
 * records? No AI call, no cost, no data boundary -- a plain word match.
 * Errs towards reading: a false positive is the old behaviour, a false
 * negative costs Martin one tap.
 */
const RECORDS_HINTS =
  /\b(overdue|invoice|invoices|payment|payments|paid|owe|owes|owed|owing|deposit|deposits|money|cash|revenue|amount|amounts|balance|how\s+much|how\s+many|open|waiting|pending|approval|approvals|handoff|handoffs|lead|leads|matter|matters|proposal|proposals|pipeline|stage|stages|status|latest|recent|recently|last|snapshot|activity|log|decision|decisions|brief|update|updates|summary|where\s+are\s+we|what(?:'s|\s+is)\s+(?:happening|going\s+on)|due|yesterday|today|this\s+week|this\s+month|since\s+we\s+last|standing)\b/i;

/**
 * A request for WORK ("draft a post to attract leads", "write a brief for the
 * proposal"): it goes to the owning Hat, which reads what its own work needs,
 * so ENIG's turn never reads the records for it -- even when it uses a
 * records word. Leading politeness ("please", "can you", "ENIG,") is allowed.
 */
const WORK_REQUEST =
  /^(?:(?:hey|hi|ok|okay|so|now|enig)[\s,.:;!-]+)*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+|let'?s\s+|help\s+me\s+(?:to\s+)?)?(?:draft|write|create|make|prepare|plan|design|build|develop|produce|generate|craft|compose|outline|propose|research|find|put\s+together|come\s+up\s+with|start|launch|run|set\s+up|organi[sz]e|review|analy[sz]e|improve|rewrite|edit|redo)\b/i;

/** Asked as a question: ends with "?" or opens with a question word. */
const QUESTION_FORM =
  /\?\s*$|^(?:(?:hey|hi|ok|okay|so|and|now|enig)[\s,.:;!-]+)*(?:what|what's|whats|how|where|which|who|when|why|any|anything|is|are|was|were|do|does|did|has|have|had|should)\b/i;

/** A plain request to be told the state: "show me the pipeline", "status", "catch me up". */
const STATUS_REQUEST =
  /^(?:(?:hey|hi|ok|okay|so|and|now|enig)[\s,.:;!-]+)*(?:please\s+)?(?:show|list|give\s+me|tell\s+me|remind\s+me|check|update\s+me|catch\s+me\s+up|brief\s+me|status|summary|snapshot|overview)\b/i;

/**
 * True when Martin's message plainly ASKS about records -- read immediately,
 * no offer. A records word alone is not enough: the message must be a status
 * question or a plain request to be told the state, and never a request for
 * work (which routes to a Hat without reading).
 */
export function recordsLikelyNeeded(message: string): boolean {
  const text = message.trim();
  if (!RECORDS_HINTS.test(text)) return false;
  if (WORK_REQUEST.test(text)) return false;
  return QUESTION_FORM.test(text) || STATUS_REQUEST.test(text);
}

/**
 * The instruction ENIG's turn carries INSTEAD of the records when no
 * database was read for it: never claim a record was read, and ask for one
 * with the READ line rather than guessing.
 */
export const RECORDS_NOT_READ_RULE = [
  "RECORDS (Martin's decision, 2026-11-17): no database was read for this reply -- no business snapshot, no Activity & Decision Log. You have no live connection to any record system.",
  "Never state or imply a count, status, amount, date, recent event, open item or 'nothing is waiting' from memory, from this conversation's history, or from the AUTHORITATIVE FACTS: those are records, and you have not read them. Never claim a database was read when it was not.",
  "If the answer needs them, reply with exactly one line and nothing else:",
  "READ: <a few words naming what you need>",
  "The runtime then asks Martin \"This needs the live records, which ENIG has not read. Read them now?\" with Read records / Not now buttons; only his tap re-runs this turn with the records actually read. Never write a READ line when the records WERE provided above.",
  "Otherwise answer normally from this conversation and the AUTHORITATIVE FACTS only, and say plainly when something is simply not recorded there.",
].join("\n");

/** Replaces the business snapshot in ENIG's context when nothing was read. */
export const RECORDS_NOT_READ_CONTEXT =
  "=== NO LIVE RECORDS READ THIS TURN ===\nNo database was read for this reply: not the business snapshot, not the Activity & Decision Log. Do not state or imply any count, status, amount, date or recent event as if you had read them -- see the RECORDS rule in your instructions.";

/** Replaces the Activity & Decision Log lines in ENIG's context when nothing was read. */
export const RECORDS_NOT_READ_LOG = "(NOT READ this turn -- no database was read for this reply)";

/**
 * The one question Martin taps to let ENIG read the records. Written by the
 * runtime, never by ENIG, so what he confirms is always the same words
 * whatever the request was.
 */
export function recordsOfferText(): string {
  return "This needs the live records, which ENIG has not read. Read them now?";
}

const READ_LINE = /^\s*READ:\s*(.+?)\s*$/i;

export interface StrippedReadReply {
  /** The reply with every READ line removed. */
  text: string;
  /** True when ENIG asked for the records. */
  requested: boolean;
}

/** Strips every READ line from ENIG's reply; `requested` says it asked for the records. */
export function stripReadLine(reply: string): StrippedReadReply {
  let requested = false;
  const kept = reply.split("\n").filter((line) => {
    if (READ_LINE.test(line)) {
      requested = true;
      return false;
    }
    return true;
  });
  return { text: kept.join("\n").trim(), requested };
}

interface StoredRecordsOffer {
  /** Martin's original message, re-run with the records loaded on his tap. */
  text: string;
  chatId: number;
  threadId?: number;
}

function offerKey(id: string): string {
  return `enig_records:${id}`;
}

/** Stores the pending read and returns the Read-records / Not-now buttons. */
export async function offerRecordsRead(env: Env, chatId: number, threadId: number | undefined, originalText: string): Promise<InlineButton[][]> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const record: StoredRecordsOffer = { text: originalText, chatId, threadId };
  await kvPut(env, offerKey(id), JSON.stringify(record), { expirationTtl: OFFER_TTL_SECONDS });
  return [
    [
      { text: "📊 Read records", callback_data: `${ENIG_RECORDS_CALLBACK}:${id}:yes` },
      { text: "Not now", callback_data: `${ENIG_RECORDS_CALLBACK}:${id}:no` },
    ],
  ];
}

export type ConsumedRecordsOffer =
  | { kind: "read"; text: string }
  | { kind: "declined" }
  | { kind: "unavailable" };

/**
 * Consumes the read offer on Martin's tap (single use: deleted before
 * anything else happens). An offer tapped from a different chat/thread than
 * it was offered in is refused, and "read" carries the exact message the
 * caller re-runs through enigChatReply with the records loaded.
 */
export async function consumeRecordsOffer(
  env: Env,
  id: string,
  choice: string,
  chatId: number,
  threadId: number | undefined,
): Promise<ConsumedRecordsOffer> {
  const raw = await kvGet(env, offerKey(id));
  if (!raw) return { kind: "unavailable" };
  await kvDelete(env, offerKey(id));
  let record: StoredRecordsOffer;
  try {
    record = JSON.parse(raw);
  } catch {
    return { kind: "unavailable" };
  }
  if (record.chatId !== chatId || record.threadId !== threadId) return { kind: "unavailable" };
  if (choice !== "yes") return { kind: "declined" };
  return { kind: "read", text: record.text };
}

/**
 * In-memory TTL cache of the last successful read (see the module comment:
 * deliberately not KV, and never holding a failed read). Module-level on
 * purpose -- an isolate that misses simply reads again.
 */
interface CachedRecords {
  snapshot: string;
  activity: string;
  expiresAt: number;
}

let cachedRecords: CachedRecords | undefined;

/** The cached read, or undefined when there is none or it has expired. */
export function getCachedEnigRecords(now: number = Date.now()): CachedRecords | undefined {
  if (!cachedRecords || cachedRecords.expiresAt <= now) return undefined;
  return cachedRecords;
}

/** Stores a fully successful read for `RECORDS_CACHE_TTL_MS`. */
export function setCachedEnigRecords(snapshot: string, activity: string, now: number = Date.now()): void {
  cachedRecords = { snapshot, activity, expiresAt: now + RECORDS_CACHE_TTL_MS };
}

/** Tests start from a cold cache, never from another test's read. */
export function clearEnigRecordsCache(): void {
  cachedRecords = undefined;
}
