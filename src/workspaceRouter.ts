import type { Env, Unit } from "./types";
import { ALL_HATS } from "./hats/registry";
import { getWorkspaceMode, isCoworkClarificationPending, setCoworkClarificationPending } from "./sessionRouting";

/**
 * The deterministic Workspace interaction boundary (CHAT/COWORK).
 *
 * This module decides ONLY, and decides deterministically -- no AI provider
 * call is made anywhere in this file, for either mode determination or
 * responsibility resolution. It never creates a WorkSession, never writes
 * to Notion, never calls a governed execution handler. router.ts is the
 * only caller that acts on its result, and every "cowork" decision still
 * passes through the exact same existing governed entry points
 * (dispatchCowork -> stub.init + handle*Request) and every gate inside
 * them (approval, Handoff, token-boundary, fail-closed checks) exactly as
 * before this module existed.
 *
 * Mode (Chat/Cowork) is Workspace-thread interaction state, deliberately
 * distinct from WorkState (a WorkSession's own governed-work state) -- a
 * Workspace conversation can exist with no WorkSession at all, and an
 * existing WorkSession must survive a mode switch untouched (see
 * sessionRouting.ts's getWorkspaceMode/setWorkspaceMode doc comment).
 *
 * This replaces the prior AI-based classifier
 * (routing.workspace_classification, now fully removed from the
 * SemanticTaskId registry and Data Boundary policy tables -- see
 * dataBoundary/types.ts, registry.ts, policy.ts). That task was
 * client_confidential with no eligible production provider, so the prior
 * architecture always failed closed for every fresh Workspace message.
 * This module never reintroduces that dependency: mode is Martin's own
 * explicit choice (a deterministic Telegram callback), and responsibility
 * resolution is deterministic structural matching against the finite
 * Unit/Hat registry (ALL_HATS) -- never semantic inference from subject
 * matter ("positioning" does not imply Strategy; "pricing" does not imply
 * Finance).
 */

export type WorkspaceDecision =
  | { mode: "chat"; unit?: Unit }
  | { mode: "cowork"; unit: Unit; hat?: string }
  | { mode: "clarify"; question: string }
  | { mode: "blocked"; reason: string };

const VALID_UNITS: Unit[] = [
  "Sales",
  "Marketing",
  "Business Development",
  "Finance",
  "Strategy",
  "Research & Intelligence",
  "Creative & Design",
  "Operations",
];

/**
 * Small, explicit, finite alias table for well-established abbreviations
 * already used throughout this codebase's own examples and prompts (e.g.
 * "R&I, what does this market look like?"). Deliberately NOT a fuzzy/
 * similarity matcher -- each entry is an exact alternate spelling for one
 * specific, uniquely-identifiable registered Unit, added only where no
 * other registered name could reasonably match it. This is the entire
 * "conservative near-match" surface this module supports; nothing else is
 * treated as a near-match.
 */
const UNIT_ALIASES: Record<string, Unit> = {
  "R&I": "Research & Intelligence",
};

const CLARIFICATION_QUESTION =
  "Who should own this work? Name the Unit or Hat (e.g. Sales, Strategy, Finance, Marketing, Research & Intelligence).";

interface Addressee {
  name: string;
  unit: Unit;
  hat?: string;
}

/** Every name a message could deterministically address, longest-first so a specific Hat wins over its bare Unit name. */
function buildAddresseeCandidates(): Addressee[] {
  const hatEntries: Addressee[] = ALL_HATS.map((h) => ({ name: h.name, unit: h.unit as Unit, hat: h.name }));
  const unitEntries: Addressee[] = VALID_UNITS.map((u) => ({ name: u, unit: u }));
  const aliasEntries: Addressee[] = Object.entries(UNIT_ALIASES).map(([alias, unit]) => ({ name: alias, unit }));
  return [...hatEntries, ...unitEntries, ...aliasEntries].sort((a, b) => b.name.length - a.name.length);
}

/**
 * True when `text` structurally addresses `name` -- a case-insensitive
 * match at the very start of the message, followed by a clear boundary
 * (end of string, or punctuation/whitespace that isn't a continuing
 * letter). This is the vocative pattern every example throughout this
 * design uses ("Finance, ...", "Strategy, ...", "Marketing Strategist,
 * ..."). Deliberately anchored to the START of the message only -- a Unit
 * name appearing mid-sentence ("should we loop in Finance on this?") is
 * never treated as addressing, which is what keeps this structural rather
 * than semantic.
 */
function matchesAddressPrefix(text: string, name: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length < name.length) return false;
  if (trimmed.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false;
  const rest = trimmed.slice(name.length);
  return rest.length === 0 || /^[\s,:;\-–—.!]/.test(rest);
}

/**
 * Deterministic structural matching only -- exact registered Hat/Unit
 * names and the small explicit alias table above, matched as a leading
 * vocative address. Returns null on no match (never guesses); the caller
 * treats null as "no explicit addressee," which routes to clarification,
 * never to invented ownership.
 */
export function resolveAddressee(text: string): Addressee | null {
  const candidates = buildAddresseeCandidates();
  for (const candidate of candidates) {
    if (matchesAddressPrefix(text, candidate.name)) return candidate;
  }
  return null;
}

/** True when the text is plausibly Martin's answer to the clarification question -- reuses the exact same addressee matcher, never a separate parser. */
function resolveClarificationAnswer(text: string): Addressee | null {
  // Martin's answer may name the Unit/Hat anywhere reasonable in a short
  // reply ("Strategy" / "That's Strategy work" / "Strategy please") rather
  // than strictly as a leading vocative -- still exact structural matching
  // against the same finite registry, just checked as a whole-message
  // case-insensitive containment rather than a leading-prefix match, since
  // a direct answer to a direct question is not the same shape as an
  // address inside a work request.
  const candidates = buildAddresseeCandidates();
  const lower = text.toLowerCase();
  for (const candidate of candidates) {
    const needle = candidate.name.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx === -1) continue;
    const before = idx === 0 ? "" : lower[idx - 1];
    const after = lower[idx + needle.length] ?? "";
    const boundaryBefore = before === "" || /[\s,:;\-–—."'(]/.test(before);
    const boundaryAfter = after === "" || /[\s,:;\-–—.!"')]/.test(after);
    if (boundaryBefore && boundaryAfter) return candidate;
  }
  return null;
}

/**
 * The single deterministic Workspace routing decision for a fresh message
 * already established as belonging to the Workspace stream, with no
 * existing WorkSession association (router.ts checks reply-association and
 * the active-pointer/awaiting continuation BEFORE ever calling this --
 * existing WorkSession identity always takes precedence, per the mode
 * priority order). No AI provider call is made here, ever.
 */
export async function resolveWorkspaceRouting(
  env: Env,
  chatId: number,
  threadId: number | undefined,
  text: string,
): Promise<WorkspaceDecision> {
  const mode = await getWorkspaceMode(env, chatId, threadId);

  if (mode === "chat") {
    // Chat mode never resolves responsibility for governed work -- this
    // addressee lookup only picks which Unit persona voices the reply
    // (see chat.ts's generalChatReply), the same deterministic structural
    // match resolveAddressee already uses for Cowork, reused here rather
    // than duplicated. It never creates a WorkSession and never implies
    // ownership of anything.
    const addressee = resolveAddressee(text);
    return addressee ? { mode: "chat", unit: addressee.unit } : { mode: "chat" };
  }

  // mode === "cowork" from here.
  const pending = await isCoworkClarificationPending(env, chatId, threadId);
  if (pending) {
    const answer = resolveClarificationAnswer(text);
    if (!answer) {
      // Still unresolved -- ask again, stay pending. Never guesses.
      return { mode: "clarify", question: CLARIFICATION_QUESTION };
    }
    await setCoworkClarificationPending(env, chatId, threadId, false);
    return { mode: "cowork", unit: answer.unit, hat: answer.hat };
  }

  const addressee = resolveAddressee(text);
  if (addressee) {
    return { mode: "cowork", unit: addressee.unit, hat: addressee.hat };
  }

  // No explicit addressee, and no deterministic structural/contextual rule
  // applies (this module never infers responsibility from subject matter --
  // "positioning" does not imply Strategy, "pricing" does not imply
  // Finance). Ask, and remember we're waiting for the answer.
  await setCoworkClarificationPending(env, chatId, threadId, true);
  return { mode: "clarify", question: CLARIFICATION_QUESTION };
}
