import type { Env, Unit } from "./types";
import type { InlineButton } from "./telegram";
import { ALL_HATS } from "./hats/registry";
import { findUnitManifest } from "./units/registry";
import { SALES_DIRECT_ENTRY_PAUSED } from "./sessionRouting";
import { kvDelete, kvGet, kvPut } from "./kvStore";

/**
 * ENIG suggests, Martin confirms (Martin's decision, 2026-11-09).
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

const SUGGEST_LINE = /^\s*SUGGEST:\s*(.+?)\s*$/i;
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
  return [
    "SUGGESTION BUTTON: If, and only if, Martin is asking for work that one of the names below owns, end your reply with one final line, exactly:",
    "SUGGEST: <name>",
    `where <name> is copied exactly from this list: ${suggestableAddressees().join("; ")}.`,
    "The runtime turns that line into a Yes/No button for Martin and removes it from what he sees; it starts nothing by itself. For anything else -- a question, a brief, or work no listed name owns -- write no SUGGEST line.",
  ].join("\n");
}

export interface ParsedEnigReply {
  /** The reply as Martin should see it, with any SUGGEST line removed. */
  text: string;
  /** A validated, exact addressee name, or undefined. */
  addressee?: string;
}

/** Strips every SUGGEST line; keeps the last one only if it names a suggestable addressee exactly (case-insensitive). */
export function parseEnigReply(reply: string): ParsedEnigReply {
  const lines = reply.split("\n");
  let candidate: string | undefined;
  const kept = lines.filter((line) => {
    const m = SUGGEST_LINE.exec(line);
    if (!m) return true;
    candidate = m[1].replace(/[*_`"'.]+$/g, "").replace(/^[*_`"']+/g, "").trim();
    return false;
  });
  const text = kept.join("\n").trim();
  if (!candidate) return { text };
  const match = suggestableAddressees().find((name) => name.toLowerCase() === candidate!.toLowerCase());
  return match ? { text, addressee: match } : { text };
}

interface StoredSuggestion {
  text: string;
  addressee: string;
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
  if (choice !== "yes") return { kind: "declined" };
  // Re-validate at tap time: a Unit paused or removed since the offer is refused, not routed.
  if (!suggestableAddressees().includes(record.addressee)) return { kind: "unavailable" };
  return { kind: "start", addressee: record.addressee, addressedText: `${record.addressee}, ${record.text}` };
}
