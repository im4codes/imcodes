import { describe, expect, it } from 'vitest';
import {
  appendMissingServerOrder,
  normalizePinnedServers,
  normalizeServerOrder,
  reorderServerOrder,
  sortServersByPreference,
  toggleServerPin,
} from '../src/server-order.js';

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

  it('appendMissingServerOrder converges across two windows with disjoint shared servers without stripping unseen IDs', () => {
    const winAServers = [{ id: 'owned-1' }, { id: 'shared-x' }];
    const winBServers = [{ id: 'owned-1' }, { id: 'shared-y' }];

    // Round 1: Window A initializes order with owned + shared-x
    let sharedOrder = appendMissingServerOrder(winAServers, []);
    expect(sharedOrder).toEqual(['owned-1', 'shared-x']);

    // Window B syncs with its [owned-1, shared-y]: appends shared-y while keeping shared-x
    sharedOrder = appendMissingServerOrder(winBServers, sharedOrder);
    expect(sharedOrder).toEqual(['owned-1', 'shared-x', 'shared-y']);

    // Subsequent alternating sync rounds between Window A and Window B perform zero rewrites
    for (let i = 0; i < 6; i += 1) {
      expect(appendMissingServerOrder(winAServers, sharedOrder)).toEqual(sharedOrder);
      expect(appendMissingServerOrder(winBServers, sharedOrder)).toEqual(sharedOrder);
    }

    // Empty / failed inventory must never erase persisted IDs
    expect(appendMissingServerOrder([], sharedOrder)).toEqual(sharedOrder);
  });

  it('reorderServerOrder preserves unseen, offline, and unrelated server IDs in their exact slots', () => {
    const prevOrder = ['other-win', 'owned-1', 'pinned-srv', 'owned-2'];
    const displayed = [{ id: 'pinned-srv' }, { id: 'owned-1' }, { id: 'owned-2' }];
    expect(reorderServerOrder(prevOrder, displayed, 'owned-2', 'owned-1', false)).toEqual([
      'other-win',
      'owned-2',
      'owned-1',
      'pinned-srv',
    ]);
  });
});
