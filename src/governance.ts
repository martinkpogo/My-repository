import type { Env } from "./types";
import { getPageContent } from "./notion";

// Kernel document, applies automatically to every Hat in every Unit — one
// canonical page ID shared across all Hats, not restated per Hat.
export const UNIVERSAL_ROLE_CONTRACT_PAGE_ID = "3cecb004-e583-81ee-8f1e-f0d58532f4aa";

// Bounded so a Notion edit takes effect within a known window rather than
// indefinitely — matches the current Finance-discovery cadence.
const GOVERNANCE_CACHE_TTL_SECONDS = 15 * 60;

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
    if (cached) return cached;
  } catch (err) {
    console.error(`Governance cache read failed for ${label} (${pageId})`, err);
  }
  try {
    const content = await getPageContent(env, pageId);
    if (!content.trim()) throw new Error("retrieved page content was empty");
    env.STATE_KV.put(cacheKey, content, { expirationTtl: GOVERNANCE_CACHE_TTL_SECONDS }).catch((err) => {
      console.error(`Governance cache write failed for ${label} (${pageId})`, err);
    });
    return content;
  } catch (err) {
    console.error(`Governance retrieval failed for ${label} (${pageId})`, err);
    return null;
  }
}
