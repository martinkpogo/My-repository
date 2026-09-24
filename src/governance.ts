import type { Env } from "./types";
import { getPageContent } from "./notion";

// Kernel document, applies automatically to every Hat in every Unit — one
// canonical page ID shared across all Hats, not restated per Hat.
export const UNIVERSAL_ROLE_CONTRACT_PAGE_ID = "3cecb004-e583-81ee-8f1e-f0d58532f4aa";

// Bounded so a Notion edit takes effect within a known window rather than
// indefinitely — matches the current Finance-discovery cadence.
const GOVERNANCE_CACHE_TTL_SECONDS = 15 * 60;

/**
 * Strips the canonical Hat/Business-Object documentation convention's own
 * object-identifying "name: <value>" YAML line (e.g. "name: Sales
 * Executive", "name: Entity") from governance content before it ever
 * reaches a prompt. This field names the object itself, not a person --
 * but its shape ("name:" followed by one or more capitalized words) is
 * indistinguishable from src/ai/outboundGate.ts's NAME_FIELD_PATTERN
 * detector, which exists to catch a genuine labeled personal-identity
 * field and treats any match as DEFINITELY_PROHIBITED, blocking every
 * eligible provider. Confirmed live: this false positive silently blocked
 * sales.call_qualification_handoff's every attempt (and, by the same
 * mechanism, would equally affect finance.quote_judgment/strategy.diagnosis,
 * which embed their own Hat Definition's "name:" field the same way). The
 * gate itself is deliberately strict and is not weakened here -- this only
 * removes genuinely redundant content (the Hat/object's own name, already
 * implied by the surrounding governance text and by this repo's own code,
 * which already knows which Hat/object it fetched) before it's ever sent
 * outbound. Anchored to the start of a line so it only matches this exact
 * YAML field, never a substring of a differently-named key (e.g.
 * "Entity_name:" does not match, since "Entity_" precedes "name" on that
 * line rather than only whitespace).
 */
export function stripObjectNameField(content: string): string {
  return content.replace(/^[ \t]*name:[ \t]*\S.*$/gim, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * Retrieves one governance page's content, cached in STATE_KV under a
 * clearly namespaced key with a bounded TTL. Returns null on any failure
 * (cache and live fetch both unavailable, or the page came back empty) —
 * callers must treat null as "cannot proceed," never substitute hardcoded
 * text in its place.
 */
export async function getGovernance(env: Env, pageId: string, label: string): Promise<string | null> {
  const cacheKey = `governance:${pageId}`;
  try {
    const cached = await env.STATE_KV.get(cacheKey);
    if (cached) return stripObjectNameField(cached);
  } catch (err) {
    console.error(`Governance cache read failed for ${label} (${pageId})`, err);
  }
  try {
    const content = await getPageContent(env, pageId);
    if (!content.trim()) throw new Error("retrieved page content was empty");
    env.STATE_KV.put(cacheKey, content, { expirationTtl: GOVERNANCE_CACHE_TTL_SECONDS }).catch((err) => {
      console.error(`Governance cache write failed for ${label} (${pageId})`, err);
    });
    return stripObjectNameField(content);
  } catch (err) {
    console.error(`Governance retrieval failed for ${label} (${pageId})`, err);
    return null;
  }
}
