import type { Env, Unit } from "./types";
import type { InlineButton } from "./telegram";
import { ALL_HATS } from "./hats/registry";
import { findUnitManifest } from "./units/registry";
import { SALES_DIRECT_ENTRY_PAUSED } from "./sessionRouting";
import { kvDelete, kvGet, kvPut } from "./kvStore";

/**
 * ENIG routes work to the Hat that owns it (Martin's decision, 2026-11-16,
 * replacing "ENIG suggests, Martin confirms" of 2026-11-09).
 *
 * When Martin asks ENIG for work without naming anyone, ENIG writes no plan
 * of its own: it ends with one `ROUTE: <name>` line, and the runtime re-sends
 * Martin's ORIGINAL message prefixed with that name ("Marketing, <text>")
 * through routeIncomingText straight away -- exactly what would run had
 * Martin typed the name himself: the same deterministic addressee match, the
 * same Action Registry resolution, the same approval gates (every Hat's
 * output still waits for Martin's approval, and the Result Gate for his
 * Result approval). When more than one name could own the work, ENIG asks
 * instead (`ASK: <A> | <B>`), and Martin picks with one tap. Only exact,
 * startable names count; anything else is dropped and nothing starts.
 *
 * The 2026-11-09 text, kept for the Yes/No buttons still in the wild:
 *
 * When Martin asks ENIG for work without naming a Unit, ENIG may end its
 * reply with one `SUGGEST: <name>` line. This module validates that name
 * against the exact addressees that can start governed work from chat,
 * strips the line, and turns it into a Yes/No button. Yes re-sends
 * Martin's ORIGINAL message prefixed with that name ("Marketing, <text>")
 * through routeIncomingText -- so what runs is exactly what would run had
 * Martin typed the name himself: the same deterministic addressee match,
 * the same Action Registry resolution, the same approval gates.
 *
 * ENIG's suggestion selects nothing by itself. It is an input convenience,
 * never a second resolution mechanism: an invalid, unknown or paused name
 * is dropped silently, and nothing starts without Martin's tap. Each
 * suggestion is single-use (consumed on first tap) and expires in a day.
 */

/** `ROUTE:` (and the earlier `SUGGEST:`, still accepted) names the owner; `ASK:` lists candidates. */
const SUGGEST_LINE = /^\s*(?:ROUTE|SUGGEST):\s*(.+?)\s*$/i;
const ASK_LINE = /^\s*ASK:\s*(.+?)\s*$/i;
const MAX_CHOICES = 3;
const SUGGESTION_TTL_SECONDS = 24 * 60 * 60;
export const ENIG_SUGGEST_CALLBACK = "enigsuggest";

/**
 * Names ENIG may suggest: every registered Hat and Unit whose Unit can start
 * governed work from chat (it has a manifest), except Sales Executive and
 * the bare "Sales" Unit while Sales direct entry is paused -- Lead
 * Generation Specialist stays suggestable, as it is independent of that
 * pause. Hats first, so a specific Hat is preferred over its Unit.
 */
export function suggestableAddressees(): string[] {
  const startable = (unit: Unit) => findUnitManifest(unit) !== undefined;
  const hats = ALL_HATS.filter((h) => startable(h.unit as Unit))
    .filter((h) => !(SALES_DIRECT_ENTRY_PAUSED && h.name === "Sales Executive"))
    .map((h) => h.name);
  const units = (["Sales", "Marketing", "Business Development", "Finance", "Strategy"] as Unit[])
    .filter(startable)
    .filter((u) => !(SALES_DIRECT_ENTRY_PAUSED && u === "Sales"));
  return [...hats, ...units];
}

/** The instruction ENIG's conversational turn carries; the brief never does. */
export function suggestionInstruction(): string {
  const names = suggestableAddressees().join("; ");
  return [
    "ROUTING (Martin's decision, 2026-11-16): you are the Chief of Staff, not the doer. When Martin asks for WORK -- a campaign, a strategy, a draft, a proposal, a diagnosis, a price, research for a piece of work -- that one of the names below owns, do NOT do the work and do NOT write a plan, steps or an example: the owning Hat does it.",
    "Instead reply with exactly one line:",
    "ROUTE: <name>",
    "Prefer the most specific Hat whose responsibility covers the request over its Unit.",
    "If two or three of the names could each own it and you cannot tell which, write one short question asking Martin which, and end with exactly one line:",
    "ASK: <name> | <name>",
    `Every <name> is copied exactly from this list: ${names}.`,
    "For anything else -- a question, a status check, what is waiting on him, or work none of these names owns -- answer normally and write no ROUTE or ASK line.",
  ].join("\n");
}

export interface ParsedEnigReply {
  /** The reply as Martin should see it, with any ROUTE/SUGGEST/ASK line removed. */
  text: string;
  /** A validated, exact addressee name to route to, or undefined. */
  addressee?: string;
  /** Validated candidates ENIG asks Martin to choose between (an ASK line), or undefined. */
  choices?: string[];
}

function exactName(candidate: string): string | undefined {
  const clean = candidate.replace(/[*_`"'.]+$/g, "").replace(/^[*_`"']+/g, "").trim().toLowerCase();
  return suggestableAddressees().find((name) => name.toLowerCase() === clean);
}

/** Strips every ROUTE/SUGGEST/ASK line; keeps the last route (or ask) only when it names exact, startable addressees. */
export function parseEnigReply(reply: string): ParsedEnigReply {
  let route: string | undefined;
  let ask: string | undefined;
  const kept = reply.split("\n").filter((line) => {
    const r = SUGGEST_LINE.exec(line);
    if (r) {
      route = r[1];
      return false;
    }
    const a = ASK_LINE.exec(line);
    if (a) {
      ask = a[1];
      return false;
    }
    return true;
  });
  const text = kept.join("\n").trim();
  const addressee = route ? exactName(route) : undefined;
  if (addressee) return { text, addressee };
  const choices = ask ? [...new Set(ask.split("|").map(exactName).filter((n): n is string => Boolean(n)))].slice(0, MAX_CHOICES) : [];
  return choices.length ? { text, choices } : { text };
}

/** The exact text Martin would have typed to start the work with `addressee` himself. */
export function addressedText(addressee: string, text: string): string {
  return `${addressee}, ${text}`;
}

interface StoredSuggestion {
  text: string;
  /** The 2026-11-09 Yes/No suggestion's one name. */
  addressee?: string;
  /** The names ENIG asked Martin to choose between (2026-11-16). */
  choices?: string[];
  chatId: number;
  threadId?: number;
}

function suggestionKey(id: string): string {
  return `enig_suggest:${id}`;
}

/** Stores the pending suggestion and returns the Yes/No buttons for it. */
export async function offerEnigSuggestion(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  originalText: string,
  addressee: string,
): Promise<InlineButton[][]> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const record: StoredSuggestion = { text: originalText, addressee, chatId, threadId };
  await kvPut(env, suggestionKey(id), JSON.stringify(record), { expirationTtl: SUGGESTION_TTL_SECONDS });
  return [
    [
      { text: `✅ Yes, start with ${addressee}`, callback_data: `${ENIG_SUGGEST_CALLBACK}:${id}:yes` },
      { text: "No", callback_data: `${ENIG_SUGGEST_CALLBACK}:${id}:no` },
    ],
  ];
}

/** Stores ENIG's question and returns one button per candidate (value `c<index>`), plus "None of these". */
export async function offerEnigChoices(env: Env, chatId: number, threadId: number | undefined, originalText: string, choices: string[]): Promise<InlineButton[][]> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const record: StoredSuggestion = { text: originalText, choices, chatId, threadId };
  await kvPut(env, suggestionKey(id), JSON.stringify(record), { expirationTtl: SUGGESTION_TTL_SECONDS });
  return [...choices.map((name, i) => [{ text: name, callback_data: `${ENIG_SUGGEST_CALLBACK}:${id}:c${i}` }]), [{ text: "None of these", callback_data: `${ENIG_SUGGEST_CALLBACK}:${id}:no` }]];
}

export type ConsumedSuggestion =
  | { kind: "start"; addressedText: string; addressee: string }
  | { kind: "declined" }
  | { kind: "unavailable" };

/**
 * Consumes a suggestion on Martin's tap (single use: it is deleted before
 * anything else happens). A suggestion tapped from a different chat/thread
 * than it was offered in is refused. "start" carries the exact addressed
 * text the caller routes through routeIncomingText.
 */
export async function consumeEnigSuggestion(
  env: Env,
  id: string,
  choice: string,
  chatId: number,
  threadId: number | undefined,
): Promise<ConsumedSuggestion> {
  const raw = await kvGet(env, suggestionKey(id));
  if (!raw) return { kind: "unavailable" };
  await kvDelete(env, suggestionKey(id));
  let record: StoredSuggestion;
  try {
    record = JSON.parse(raw);
  } catch {
    return { kind: "unavailable" };
  }
  if (record.chatId !== chatId || record.threadId !== threadId) return { kind: "unavailable" };
  const picked = choice === "yes" ? record.addressee : /^c\d$/.test(choice) ? record.choices?.[Number(choice.slice(1))] : undefined;
  if (!picked) return { kind: "declined" };
  // Re-validate at tap time: a Unit paused or removed since the offer is refused, not routed.
  if (!suggestableAddressees().includes(picked)) return { kind: "unavailable" };
  return { kind: "start", addressee: picked, addressedText: addressedText(picked, record.text) };
}
