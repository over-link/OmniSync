/**
 * services/ttlCache.js
 * A small in-memory cache for slow, read-only lookups (e.g. which Revizto
 * licenses someone administers, a license's project list) — so opening
 * "Modify pairing" doesn't repeat the same round of API calls. Stores the
 * promise, so callers asking at the same moment share one lookup; a
 * failed lookup isn't kept. In memory only: a restart starts empty.
 *
 * createTtlCache(ttlMs).get(key, load, { fresh }) → load()'s result,
 * reused for ttlMs. `fresh: true` skips the cache (and refills it) — use
 * it where a decision must not rest on a few-minutes-old answer.
 */
function createTtlCache(ttlMs) {
  const entries = new Map(); // key -> { at, promise }
  const MAX_ENTRIES = 200; // expired entries are swept once the cache grows past this
  return {
    get(key, load, { fresh = false } = {}) {
      const hit = entries.get(key);
      if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.promise;
      if (entries.size >= MAX_ENTRIES) {
        for (const [k, e] of entries) if (Date.now() - e.at >= ttlMs) entries.delete(k);
      }
      const promise = Promise.resolve().then(load);
      entries.set(key, { at: Date.now(), promise });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      return promise;
    },
    clear() {
      entries.clear();
    },
    /** Drops every entry whose key satisfies `predicate(key)`. */
    deleteWhere(predicate) {
      for (const key of entries.keys()) if (predicate(key)) entries.delete(key);
    },
  };
}

module.exports = { createTtlCache };
