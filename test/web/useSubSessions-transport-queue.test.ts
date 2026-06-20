import { describe, expect, it } from 'vitest';
import { buildTransportPendingSyncPatch, hasTransportPendingSyncSnapshot } from '../../web/src/transport-queue.js';

describe('sub-session transport queue sync patch', () => {
  it('derives messages from authoritative entries-only snapshots and drops stale message tails', () => {
    const patch = buildTransportPendingSyncPatch(
      {
        transportPendingMessages: ['A', 'stale-B'],
        transportPendingMessageEntries: [
          { clientMessageId: 'a', text: 'A' },
          { clientMessageId: 'b', text: 'stale-B' },
        ],
        transportPendingMessageVersion: 3,
      },
      {
        transportPendingMessageEntries: [{ clientMessageId: 'a', text: 'A' }],
        transportPendingMessageVersion: 4,
      },
      'deck_sub_a',
    );

    expect(patch).toMatchObject({
      transportPendingMessages: ['A'],
      transportPendingMessageEntries: [{ clientMessageId: 'a', text: 'A' }],
      transportPendingMessageVersion: 4,
    });
  });

  it('treats entries-only empty snapshots as authoritative clears', () => {
    const patch = buildTransportPendingSyncPatch(
      {
        transportPendingMessages: ['stale-B'],
        transportPendingMessageEntries: [{ clientMessageId: 'b', text: 'stale-B' }],
        transportPendingMessageVersion: 3,
      },
      {
        transportPendingMessageEntries: [],
        transportPendingMessageVersion: 4,
      },
      'deck_sub_a',
    );

    expect(patch).toMatchObject({
      transportPendingMessages: [],
      transportPendingMessageEntries: [],
      transportPendingMessageVersion: 4,
    });
  });

  it('does not treat version-only payloads as pending queue content sync', () => {
    expect(hasTransportPendingSyncSnapshot({ transportPendingMessageVersion: 5 })).toBe(false);
    expect(buildTransportPendingSyncPatch(
      {
        transportPendingMessages: ['stale-B'],
        transportPendingMessageEntries: [{ clientMessageId: 'b', text: 'stale-B' }],
        transportPendingMessageVersion: 3,
      },
      { transportPendingMessageVersion: 5 },
      'deck_sub_a',
    )).toEqual({});
  });
});
