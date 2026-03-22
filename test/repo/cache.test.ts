import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { RepoCache } from '../../src/repo/cache.js';

describe('RepoCache', () => {
  let cache: RepoCache;

  beforeEach(() => {
    cache = new RepoCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buildKey', () => {
    it('generates composite key from dir and resource', () => {
      const key = RepoCache.buildKey('/home/user/project', 'issues');
      expect(key).toBe('/home/user/project:issues:');
    });

    it('includes sorted params in key', () => {
      const key = RepoCache.buildKey('/proj', 'prs', { state: 'open', page: 1 });
      expect(key).toContain('/proj:prs:');
      expect(key).toContain('"page":1');
      expect(key).toContain('"state":"open"');
    });

    it('produces stable keys regardless of param insertion order', () => {
      const key1 = RepoCache.buildKey('/p', 'x', { b: 2, a: 1 });
      const key2 = RepoCache.buildKey('/p', 'x', { a: 1, b: 2 });
      expect(key1).toBe(key2);
    });
  });

  describe('get / set', () => {
    it('returns null for unknown key', () => {
      expect(cache.get('missing')).toBeNull();
    });

    it('stores and retrieves data', () => {
      cache.set('k1', { items: [1, 2] }, '/proj');
      expect(cache.get('k1')).toEqual({ items: [1, 2] });
    });
  });

  describe('TTL expiry', () => {
    it('returns data within default TTL (30s)', () => {
      cache.set('k', 'data', '/proj');
      vi.advanceTimersByTime(29_000);
      expect(cache.get('k')).toBe('data');
    });

    it('expires after default TTL (30s)', () => {
      cache.set('k', 'data', '/proj');
      vi.advanceTimersByTime(31_000);
      expect(cache.get('k')).toBeNull();
    });

    it('expires error-state entries after 5s', () => {
      cache.set('k', 'err-data', '/proj', true);
      vi.advanceTimersByTime(4_000);
      expect(cache.get('k')).toBe('err-data');

      vi.advanceTimersByTime(2_000); // total 6s
      expect(cache.get('k')).toBeNull();
    });

    it('error-state entries do not last 30s', () => {
      cache.set('k', 'err', '/proj', true);
      vi.advanceTimersByTime(10_000);
      expect(cache.get('k')).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('removes all entries for a projectDir', () => {
      cache.set(RepoCache.buildKey('/proj', 'issues'), 'a', '/proj');
      cache.set(RepoCache.buildKey('/proj', 'prs'), 'b', '/proj');
      cache.set(RepoCache.buildKey('/other', 'issues'), 'c', '/other');

      cache.invalidate('/proj');

      expect(cache.get(RepoCache.buildKey('/proj', 'issues'))).toBeNull();
      expect(cache.get(RepoCache.buildKey('/proj', 'prs'))).toBeNull();
      expect(cache.get(RepoCache.buildKey('/other', 'issues'))).toBe('c');
    });

    it('removes only matching resource when scoped', () => {
      cache.set(RepoCache.buildKey('/proj', 'issues'), 'a', '/proj');
      cache.set(RepoCache.buildKey('/proj', 'prs'), 'b', '/proj');

      cache.invalidate('/proj', 'issues');

      expect(cache.get(RepoCache.buildKey('/proj', 'issues'))).toBeNull();
      expect(cache.get(RepoCache.buildKey('/proj', 'prs'))).toBe('b');
    });
  });

  describe('invalidateAll', () => {
    it('clears everything', () => {
      cache.set('a', 1, '/x');
      cache.set('b', 2, '/y');
      cache.invalidateAll();
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
    });
  });

  describe('shared entries', () => {
    it('two consumers reading same key get same cached data', () => {
      cache.set(RepoCache.buildKey('/proj', 'issues'), { items: [1] }, '/proj');
      const a = cache.get(RepoCache.buildKey('/proj', 'issues'));
      const b = cache.get(RepoCache.buildKey('/proj', 'issues'));
      expect(a).toEqual(b);
      // Same reference
      expect(a).toBe(b);
    });
  });
});
