import { describe, expect, it } from 'vitest';
import { createProjectionOwnerCache } from '../../src/daemon/memory-projection-owner-cache.js';

describe('projection-owner cache', () => {
  it('stores and retrieves a projection → server mapping', () => {
    const cache = createProjectionOwnerCache(10);
    cache.set('proj-1', 'srv-A');
    expect(cache.get('proj-1')).toBe('srv-A');
    expect(cache.size()).toBe(1);
  });

  it('refreshes recency on get so the entry survives later evictions', () => {
    const cache = createProjectionOwnerCache(3);
    cache.set('proj-1', 'srv-A');
    cache.set('proj-2', 'srv-B');
    cache.set('proj-3', 'srv-C');
    // Touch proj-1 so it moves to the tail.
    expect(cache.get('proj-1')).toBe('srv-A');
    // Insert proj-4 — without the recency refresh on read, proj-1 would
    // be the oldest and would be dropped here. With it, proj-2 (now the
    // oldest) is dropped instead.
    cache.set('proj-4', 'srv-D');
    expect(cache.size()).toBe(3);
    expect(cache.get('proj-1')).toBe('srv-A');
    expect(cache.get('proj-2')).toBeUndefined();
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const cache = createProjectionOwnerCache(2);
    cache.set('proj-1', 'srv-A');
    cache.set('proj-2', 'srv-B');
    cache.set('proj-3', 'srv-C');
    expect(cache.size()).toBe(2);
    expect(cache.get('proj-1')).toBeUndefined();
    expect(cache.get('proj-2')).toBe('srv-B');
    expect(cache.get('proj-3')).toBe('srv-C');
  });

  it('refreshes recency on set when the key already exists', () => {
    const cache = createProjectionOwnerCache(2);
    cache.set('proj-1', 'srv-A');
    cache.set('proj-2', 'srv-B');
    // Re-set proj-1 (with the same value) — should move to the tail.
    cache.set('proj-1', 'srv-A');
    // Adding proj-3 now drops proj-2, not proj-1.
    cache.set('proj-3', 'srv-C');
    expect(cache.get('proj-1')).toBe('srv-A');
    expect(cache.get('proj-2')).toBeUndefined();
    expect(cache.get('proj-3')).toBe('srv-C');
  });

  it('ignores empty inputs without disrupting state', () => {
    const cache = createProjectionOwnerCache(10);
    cache.set('', 'srv-A');
    cache.set('proj-1', '');
    cache.set('proj-2', 'srv-B');
    expect(cache.size()).toBe(1);
    expect(cache.get('')).toBeUndefined();
    expect(cache.get('proj-1')).toBeUndefined();
    expect(cache.get('proj-2')).toBe('srv-B');
  });

  it('delete and clear behave as expected', () => {
    const cache = createProjectionOwnerCache(10);
    cache.set('proj-1', 'srv-A');
    cache.set('proj-2', 'srv-B');
    expect(cache.delete('proj-1')).toBe(true);
    expect(cache.delete('proj-1')).toBe(false);
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
