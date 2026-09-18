import { jest } from '@jest/globals';
import { canonicalCacheKey, createSearchCache } from '../src/services/searchCache.js';

describe('cache ricerche bounded TTL/LRU', () => {
  test('normalizza l’ordine delle chiavi e riusa il risultato', async () => {
    const cache = createSearchCache({ ttlMs: 1000, maxEntries: 10 });
    const loader = jest.fn(async () => ({ flights: [{ id: 'f1' }] }));
    const firstKey = canonicalCacheKey('flight', { country: 'IT', filters: { date: '2026-10-01', seats: 2 } });
    const secondKey = canonicalCacheKey('flight', { filters: { seats: 2, date: '2026-10-01' }, country: 'IT' });

    await expect(cache.getOrSet(firstKey, loader)).resolves.toEqual({ flights: [{ id: 'f1' }] });
    await expect(cache.getOrSet(secondKey, loader)).resolves.toEqual({ flights: [{ id: 'f1' }] });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  test('scade con TTL e limita la memoria con eviction LRU', async () => {
    let clock = 0;
    const cache = createSearchCache({ ttlMs: 100, maxEntries: 2, now: () => clock });
    await cache.getOrSet('a', async () => 'A');
    await cache.getOrSet('b', async () => 'B');
    expect(cache.get('a')).toBe('A'); // a diventa il più recente
    await cache.getOrSet('c', async () => 'C');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    clock = 101;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.snapshot()).toMatchObject({ evictions: 1, size: 1 });
  });

  test('coalesca richieste concorrenti e invalida tutte le entry', async () => {
    const cache = createSearchCache({ ttlMs: 1000, maxEntries: 10 });
    let resolve;
    const loader = jest.fn(() => new Promise((done) => { resolve = done; }));
    const first = cache.getOrSet('same', loader);
    const second = cache.getOrSet('same', loader);
    await Promise.resolve();
    resolve({ result: 'fresh' });
    await expect(Promise.all([first, second])).resolves.toEqual([{ result: 'fresh' }, { result: 'fresh' }]);
    expect(loader).toHaveBeenCalledTimes(1);
    cache.invalidate();
    expect(cache.get('same')).toBeUndefined();
    expect(cache.snapshot().invalidations).toBe(1);
  });
});
