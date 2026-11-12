import { describe, expect, it } from 'vitest';
import { normalizePinnedServers, normalizeServerOrder, sortServersByPreference, toggleServerPin } from '../src/server-order.js';

const servers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('server preference ordering', () => {
  it('keeps API order by default and appends new servers', () => {
    expect(normalizeServerOrder(servers, [])).toEqual(['a', 'b', 'c']);
    expect(normalizeServerOrder(servers, ['c', 'stale', 'c'])).toEqual(['c', 'a', 'b']);
    expect(sortServersByPreference(servers, [], [])).toEqual(servers);
    expect(sortServersByPreference(servers, 'corrupt' as unknown as string[], { bad: true } as unknown as string[]))
      .toEqual(servers);
  });

  it('puts pinned servers first in earliest-pin order', () => {
    expect(sortServersByPreference(servers, ['b', 'a', 'c'], ['c', 'a']))
      .toEqual([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
  });

  it('only explicit toggles change saved pin intent, regardless of visible inventory', () => {
    expect(toggleServerPin(['absent', 'b', 'b'], 'a')).toEqual(['absent', 'b', 'a']);
    expect(toggleServerPin(['absent', 'b'], 'b')).toEqual(['absent']);
    expect(toggleServerPin('corrupt' as unknown as string[], 'a')).toEqual(['a']);
    expect(normalizePinnedServers([], ['absent', 'b'])).toEqual([]);
    expect(normalizePinnedServers([{ id: 'absent' }], ['absent', 'b'])).toEqual(['absent']);
  });

  it('prunes unknown and duplicate pinned IDs without changing other order', () => {
    expect(normalizePinnedServers(servers, ['stale', 'b', 'b', 'a'])).toEqual(['b', 'a']);
    expect(sortServersByPreference(servers, ['c', 'b', 'a'], ['stale', 'b', 'b']))
      .toEqual([{ id: 'b' }, { id: 'c' }, { id: 'a' }]);
  });
});
