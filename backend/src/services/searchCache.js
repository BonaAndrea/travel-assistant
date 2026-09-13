import { metrics as productMetrics } from './metrics.js';

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 500;

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalCacheKey(namespace, input) {
  return `${namespace}:${JSON.stringify(canonicalize(input))}`;
}

export function createSearchCache({
  ttlMs = Number(process.env.SEARCH_CACHE_TTL_MS) || DEFAULT_TTL_MS,
  maxEntries = Number(process.env.SEARCH_CACHE_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const pending = new Map();
  const metrics = { hits: 0, misses: 0, evictions: 0, invalidations: 0 };

  function get(key) {
    const entry = entries.get(key);
    if (!entry || entry.expiresAt <= now()) {
      if (entry) entries.delete(key);
      metrics.misses += 1;
      productMetrics.increment('search_cache_operations_total', { outcome: 'miss' });
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry); // accesso recente: ordine LRU
    metrics.hits += 1;
    productMetrics.increment('search_cache_operations_total', { outcome: 'hit' });
    return structuredClone(entry.value);
  }

  function set(key, value) {
    if (maxEntries <= 0 || ttlMs <= 0) return value;
    entries.delete(key);
    entries.set(key, { value: structuredClone(value), expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
      metrics.evictions += 1;
      productMetrics.increment('search_cache_operations_total', { outcome: 'eviction' });
    }
    return value;
  }

  async function getOrSet(key, loader) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const operation = Promise.resolve().then(loader);
    pending.set(key, operation);
    try {
      const value = await operation;
      return set(key, value);
    } finally {
      pending.delete(key);
    }
  }

  function invalidate() {
    entries.clear();
    metrics.invalidations += 1;
    productMetrics.increment('search_cache_operations_total', { outcome: 'invalidation' });
  }

  function snapshot() {
    return { ...metrics, size: entries.size, ttlMs, maxEntries };
  }

  return { get, set, getOrSet, invalidate, snapshot };
}

export const searchCache = createSearchCache();
export const invalidateSearchCache = () => searchCache.invalidate();
export const getSearchCacheMetrics = () => searchCache.snapshot();
