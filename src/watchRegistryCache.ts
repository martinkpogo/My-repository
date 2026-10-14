/**
 * Short-lived cache in front of the Google Doc / Sheet watch-record lists.
 *
 * WHY: the comment polls run every 5 minutes, and each one enumerated its
 * watch records with a KV list (24 lists an hour, all day, while the free
 * tier allows 1,000 a day) to find the same few records. The records change
 * only when a Doc or Sheet is registered, so the list is cached with the
 * Workers Cache API (per data centre, not counted against KV) for
 * WATCH_REGISTRY_CACHE_TTL_SECONDS and dropped whenever this isolate's data
 * centre registers one.
 *
 * Boundary: the records carry the account email and file titles
 * (Cloudflare-only data, see kvStore.ts), and the Cache API stays inside
 * Cloudflare, so the data-class policy is unchanged.
 *
 * Staleness: a Doc registered while a poll runs in a DIFFERENT data centre is
 * first polled at most WATCH_REGISTRY_CACHE_TTL_SECONDS later. Pass
 * `fresh: true` where the current list is required (the account re-point
 * cleanup). A cache error or an unavailable Cache API (tests, local) falls
 * through to the loader, so the cache can only ever save a list, never break
 * a poll.
 */
export const WATCH_REGISTRY_CACHE_TTL_SECONDS = 10 * 60;

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

function defaultCache(): CacheLike | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default?: CacheLike }).default;
}

function cacheKey(name: string): Request {
  return new Request(`https://enig-watch-registry.invalid/${name}`);
}

export async function cachedWatchRegistry<T>(
  name: "docs" | "sheets",
  load: () => Promise<T[]>,
  options: { fresh?: boolean; cache?: CacheLike | undefined } = {},
): Promise<T[]> {
  const cache = "cache" in options ? options.cache : defaultCache();
  if (cache && !options.fresh) {
    try {
      const hit = await cache.match(cacheKey(name));
      if (hit) return (await hit.json()) as T[];
    } catch {
      // unreadable cache entry: load below
    }
  }
  const loaded = await load();
  if (cache) {
    try {
      await cache.put(
        cacheKey(name),
        new Response(JSON.stringify(loaded), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${WATCH_REGISTRY_CACHE_TTL_SECONDS}` },
        }),
      );
    } catch {
      // a cache that cannot be written only costs the next poll a list
    }
  }
  return loaded;
}

export async function invalidateWatchRegistry(name: "docs" | "sheets", cache: CacheLike | undefined = defaultCache()): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(cacheKey(name));
  } catch {
    // best effort: the TTL bounds the staleness anyway
  }
}
