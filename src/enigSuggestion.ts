import type { Env, Unit } from "./types";
import type { InlineButton } from "./telegram";
import { ALL_HATS } from "./hats/registry";
import { findUnitManifest } from "./units/registry";
import { SALES_DIRECT_ENTRY_PAUSED } from "./sessionRouting";
import { kvDelete, kvGet, kvPut } from "./kvStore";

/**
 * Martin confirms, then the route enters Cowork as the Hat that owns the
 * work (Martin's decision, 2026-11-17, replacing the automatic re-send of
 * 2026-11-16, which had replaced "ENIG suggests, Martin confirms" of
 * 2026-11-09).
 *
 * When Martin asks ENIG for work without naming anyone, ENIG writes no plan
 * of its own: it ends with one `ROUTE: <name>` line. Nothing starts on that
 * line -- the runtime shows Martin one question (`coworkOfferText`) with an
 * "Enter Cowork as <name>" button and a "Not now" button, and only his tap
 * switches the thread to Cowork mode and re-sends Martin's ORIGINAL message
 * prefixed with that name ("Marketing, <text>") through routeIncomingText.
 * That is exactly what would run had Martin typed the name himself, now in
 * Cowork: the same deterministic addressee match, the same Action Registry
 * resolution, the same approval gates (every Hat's output still waits for
 * Martin's approval, and the Result Gate for his Result approval). A thread
 * entered this way goes back to Chat when its Work closes
 * (`revertEnigCoworkOffer`, src/sessionRouting.ts); a thread Martin set
 * with /mode himself is never touched. When more than one name could own
 * the work, ENIG asks instead (`ASK: <A> | <B>`), and Martin's pick starts
 * at once in Cowork as that Hat -- no second confirmation. Only exact,
 * startable names count: a ROUTE line naming anything else refuses ENIG's
 * whole reply (`ENIG_ROUTE_REFUSED_MESSAGE`), so work content never reaches
 * Martin without a routable owner behind it.
 *
 * The 2026-11-09 text, kept for the `SUGGEST:` line and the yes/no callback
 * values still in the wild:
 *
 * When Martin asks ENIG for work without naming a Unit, ENIG may end its
 * reply with one `SUGGEST: <name>` line. This module validates that name
 * against the exact addressees that can start governed work from chat,
 * strips the line, and turns it into a button. Tapping it re-sends
 * Martin's ORIGINAL message prefixed with that name ("Marketing, <text>")
 * through routeIncomingText -- so what runs is exactly what would run had
 * Martin typed the name himself: the same deterministic addressee match,
 * the same Action Registry resolution, the same approval gates.
 *
 * ENIG's suggestion selects nothing by itself. It is an input convenience,
 * never a second resolution mechanism: an invalid, unknown or paused name
 * refuses ENIG's whole reply instead of being routed or shown, and nothing
 * starts without Martin's tap. Each suggestion is single-use (consumed on
 * first tap) and expires in a day.
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
    "ROUTING (Martin's decision, 2026-11-17): you are the Chief of Staff, not the doer. When Martin asks for WORK -- a campaign, a strategy, a draft, a proposal, a diagnosis, a price, research for a piece of work -- that one of the names below owns, do NOT do the work and do NOT write a plan, steps or an example: the owning Hat does it.",
    "Instead reply with exactly one line:",
    "ROUTE: <name>",
    "That line starts nothing by itself: the runtime shows Martin the question \"This is <name>'s work. Enter Cowork as <name> and start?\" with Enter Cowork and Not now buttons, and only his tap on Enter Cowork switches the thread to Cowork and starts the work as that Hat. Write nothing else on a ROUTE reply -- whatever you add beside the line is discarded.",
    "Prefer the most specific Hat whose responsibility covers the request over its Unit.",
    // Martin, 2026-11-18: "Plan a campaign to get more clients" went to the
    // Hat that coordinates campaigns, which handed it straight on to the Hat
    // that owns marketing direction -- an extra step and an extra tap.
    "When the request still needs its direction decided -- what it should achieve, who it is for, the plan or strategy (\"plan a campaign\", \"how do we get more clients\") -- route it to the Hat that owns that direction or strategy, not to a Hat that carries out or coordinates work once the direction is set. Route to an executing Hat only when Martin's request already names what to produce (\"write the post\", \"schedule the calendar\").",
    "If two or three of the names could each own it and you cannot tell which, write one short question asking Martin which, and end with exactly one line:",
    "ASK: <name> | <name>",
    "There he picks with one tap and the work starts at once in Cowork as the Hat he picks -- no second confirmation.",
    `Every <name> is copied exactly from this list: ${names}.`,
    "For anything else -- a question, a status check, what is waiting on him, or work none of these names owns -- answer normally and write no ROUTE or ASK line. When this turn was given no records, a status check you cannot answer without them follows the RECORDS rule instead of guessing.",
  ].join("\n");
}

/**
 * The one question Martin taps to enter Cowork as the owning Hat. Written by
 * the runtime, never by ENIG, so what he confirms is always the same words
 * whatever the request was.
 */
export function coworkOfferText(addressee: string): string {
  return `This is ${addressee}'s work. Enter Cowork as ${addressee} and start?\n\nTap a button below, or reply yes or no.`;
}

/** Appended to ENIG's ASK question so a bare candidate button says what a tap does. */
export const ASK_PICK_EFFECT = "Pick one and it starts straight away in Cowork as that Hat.";

/**
 * Shown instead of ENIG's reply when it wrote a ROUTE/SUGGEST line naming
 * something that is not an exact, startable addressee. Fail-closed: ENIG's
 * own words on such a reply are work content with no routable owner behind
 * them, so none of it is delivered and nothing is started.
 */
export const ENIG_ROUTE_REFUSED_MESSAGE =
  "ENIG named something the runtime will not route to, so nothing was started. Name the Unit or Hat yourself (for example \"Marketing, <request>\") and it runs exactly as you typed it.";

export interface ParsedEnigReply {
  /** The reply as Martin should see it, with any ROUTE/SUGGEST/ASK line removed. */
  text: string;
  /** A validated, exact addressee name to route to, or undefined. */
  addressee?: string;
  /** Validated candidates ENIG asks Martin to choose between (an ASK line), or undefined. */
  choices?: string[];
  /** Set only when a ROUTE/SUGGEST line named something that is not an exact, startable addressee: the whole reply is refused. */
  refused?: true;
}

function exactName(candidate: string): string | undefined {
  const clean = candidate.replace(/[*_`"'.]+$/g, "").replace(/^[*_`"']+/g, "").trim().toLowerCase();
  return suggestableAddressees().find((name) => name.toLowerCase() === clean);
}

/** Strips every ROUTE/SUGGEST/ASK line; keeps the last route (or ask) only when it names exact, startable addressees, and refuses the reply outright when a ROUTE line names anything else. */
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
  // Fail-closed on a ROUTE line the registry does not recognise: the reply
  // carried an intent to hand work over that the runtime cannot honour, so
  // it is refused as a whole rather than delivered without the hand-over.
  if (route && !addressee) return { text, refused: true };
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

function latestOfferKey(chatId: number, threadId: number | undefined): string {
  return `enig_suggest_latest:${chatId}:${threadId ?? "dm"}`;
}

const TYPED_YES = /^\s*(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|start|do it|enter cowork)\s*[.!]*\s*$/i;
const TYPED_NO = /^\s*(n|no|nope|not now|no thanks|cancel)\s*[.!]*\s*$/i;

/** "yes" / "no" when Martin's whole message is a plain yes or no, else undefined. */
export function typedOfferAnswer(text: string): "yes" | "no" | undefined {
  if (TYPED_YES.test(text)) return "yes";
  if (TYPED_NO.test(text)) return "no";
  return undefined;
}

/**
 * A typed "yes" / "no" answering the thread's latest Enter-Cowork offer, with
 * the same single-use, same-thread, tap-time checks as the button (it consumes
 * the very same stored offer). Undefined when the message is not a plain
 * yes/no or no offer is waiting -- the message is then handled as usual.
 */
export async function consumeTypedOfferAnswer(env: Env, chatId: number, threadId: number | undefined, text: string): Promise<ConsumedSuggestion | undefined> {
  const answer = typedOfferAnswer(text);
  if (!answer) return undefined;
  const id = await kvGet(env, latestOfferKey(chatId, threadId));
  if (!id) return undefined;
  await kvDelete(env, latestOfferKey(chatId, threadId));
  const consumed = await consumeEnigSuggestion(env, id, answer, chatId, threadId);
  return consumed.kind === "unavailable" ? undefined : consumed;
}

/** Stores the pending confirmation and returns its Enter-Cowork/Not-now buttons. */
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
  // The thread's latest Enter-Cowork offer, so a typed "yes" / "no" answers it
  // like a tap (Martin, 2026-11-17: the buttons can appear late).
  await kvPut(env, latestOfferKey(chatId, threadId), id, { expirationTtl: SUGGESTION_TTL_SECONDS });
  return [
    [
      { text: `🤝 Enter Cowork as ${addressee}`, callback_data: `${ENIG_SUGGEST_CALLBACK}:${id}:yes` },
      { text: "Not now", callback_data: `${ENIG_SUGGEST_CALLBACK}:${id}:no` },
    ],
  ];
}

/** Stores ENIG's question and returns one button per candidate (value `c<index>`), plus "None of these". A candidate tap starts immediately in Cowork as that Hat (Martin, 2026-11-17) -- no second confirmation. */
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
 * text the caller first switches the thread to Cowork for and then routes
 * through routeIncomingText.
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
