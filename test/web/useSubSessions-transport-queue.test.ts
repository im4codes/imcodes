import { describe, expect, it } from 'vitest';
import { buildTransportPendingSyncPatch, hasTransportPendingSyncSnapshot } from '../../web/src/transport-queue.js';

describe('sub-session transport queue sync patch', () => {
  it('applies structured queue snapshots with epoch, authority, version, and entries', () => {
    const patch = buildTransportPendingSyncPatch(
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        transportPendingMessages: ['A', 'stale-B'],
        transportPendingMessageEntries: [
          { clientMessageId: 'a', text: 'A' },
          { clientMessageId: 'b', text: 'stale-B' },
        ],
        transportPendingMessageVersion: 3,
      },
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageEntries: [{ clientMessageId: 'a', text: 'A' }],
        pendingMessageVersion: 4,
      },
      'deck_sub_a',
    );

    expect(patch).toMatchObject({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessages: ['A'],
      transportPendingMessageEntries: [{ clientMessageId: 'a', text: 'A' }],
      transportPendingMessageVersion: 4,
    });
  });

  it('treats structured empty snapshots as authoritative clears', () => {
    const patch = buildTransportPendingSyncPatch(
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        transportPendingMessages: ['stale-B'],
        transportPendingMessageEntries: [{ clientMessageId: 'b', text: 'stale-B' }],
        transportPendingMessageVersion: 3,
      },
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageEntries: [],
        pendingMessageVersion: 4,
      },
      'deck_sub_a',
    );

    expect(patch).toMatchObject({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
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

  it('ignores legacy text arrays and diagnostic pendingCount as live queue authority', () => {
    const patch = buildTransportPendingSyncPatch(
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        transportPendingMessageVersion: 3,
        transportPendingMessages: ['keep'],
        transportPendingMessageEntries: [{ clientMessageId: 'keep', text: 'keep' }],
      },
      {
        pendingMessages: [],
        transportPendingMessages: [],
        pendingCount: 0,
      },
      'deck_sub_a',
    );

    expect(hasTransportPendingSyncSnapshot({
      pendingMessages: [],
      transportPendingMessages: [],
      pendingCount: 0,
    })).toBe(false);
    expect(patch).toEqual({});
  });

  it('accepts new-protocol pendingMessageEntries and failedMessageEntries with epoch authority', () => {
    const patch = buildTransportPendingSyncPatch(
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        transportPendingMessageVersion: 1,
        transportPendingMessageEntries: [{ clientMessageId: 'old', text: 'old' }],
      },
      {
        queueEpoch: 'epoch-1',
        queueAuthorityId: 'authority-1',
        pendingMessageVersion: 2,
        pendingMessageEntries: [{ clientMessageId: 'live', text: 'line 1\nline 2' }],
        failedMessageEntries: [{ clientMessageId: 'failed', text: 'failed text' }],
      },
      'deck_sub_a',
    );

    expect(patch).toMatchObject({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessages: ['line 1\nline 2'],
      transportPendingMessageEntries: [{ clientMessageId: 'live', text: 'line 1\nline 2' }],
      failedMessageEntries: [{ clientMessageId: 'failed', text: 'failed text' }],
      transportPendingMessageVersion: 2,
    });
  });
});
