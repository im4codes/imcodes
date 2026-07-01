import { describe, expect, it } from 'vitest';

import {
  buildTransportPendingSyncPatch,
  extractTransportPendingMessageEntries,
  extractTransportPendingMessages,
  extractTransportPendingVersion,
  mergeTransportPendingEntriesForIdleState,
  mergeTransportPendingEntriesForRunningState,
  mergeTransportPendingMessagesForIdleState,
  mergeTransportPendingMessagesForRunningState,
  nextTransportQueueVersion,
  normalizeTransportPendingEntries,
  removeTransportPendingEntryForUserMessage,
  shouldApplyTransportQueueSnapshot,
  synthesizeTransportPendingMessageEntries,
} from '../src/transport-queue.js';

describe('extractTransportPendingMessages', () => {
  it('rejects legacy text-only pending messages for live queue state', () => {
    expect(extractTransportPendingMessages([' one ', '', 1, null, 'two\nthree'])).toEqual([]);
  });
});

describe('mergeTransportPendingMessagesForRunningState', () => {
  it('preserves the existing queue when running reports no pendingMessages field', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one'], undefined, false)).toEqual(['queued one']);
  });

  it('ignores explicit empty legacy pending arrays instead of clearing live queue', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one', 'queued two'], [], true)).toEqual(['queued one', 'queued two']);
  });

  it('preserves queue when running event omits pending field (not queue-authoritative)', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one', 'queued two'], undefined, false)).toEqual(['queued one', 'queued two']);
  });

  it('rejects non-empty legacy pendingMessages arrays from running state', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one'], ['queued two'], true)).toEqual(['queued one']);
  });

  it('returns an empty queue when nothing is queued yet', () => {
    expect(mergeTransportPendingMessagesForRunningState([], [], true)).toEqual([]);
  });

  it('clears when running reports empty after drain (was: preserved, now authoritative)', () => {
    expect(mergeTransportPendingMessagesForRunningState(['a', 'b', 'c'], [], true)).toEqual(['a', 'b', 'c']);
  });

  it('does not accept partial legacy text-only drain snapshots', () => {
    expect(mergeTransportPendingMessagesForRunningState(['a', 'b', 'c'], ['c'], true)).toEqual(['a', 'b', 'c']);
  });
});

describe('extractTransportPendingMessageEntries', () => {
  it('keeps only entries with a stable id and non-empty lossless text', () => {
    expect(extractTransportPendingMessageEntries([
      { clientMessageId: ' msg-1 ', text: ' one\n ' },
      { clientMessageId: '', text: 'nope' },
      { clientMessageId: 'msg-2', text: '' },
      null,
      1,
      { clientMessageId: 'msg-3', text: 'two' },
    ])).toEqual([
      { clientMessageId: 'msg-1', text: ' one\n ' },
      { clientMessageId: 'msg-3', text: 'two' },
    ]);
  });
});

describe('synthesizeTransportPendingMessageEntries', () => {
  it('rejects legacy text-only pending messages for live queue state', () => {
    expect(synthesizeTransportPendingMessageEntries(['queued one', 'queued two'], 'deck_test')).toEqual([
    ]);
  });
});

describe('normalizeTransportPendingMessageEntries', () => {
  it('prefers explicit pending entries when present', () => {
    expect(normalizeTransportPendingEntries([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], ['queued one'], 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('treats present entries as authoritative instead of filling legacy tails', () => {
    expect(normalizeTransportPendingEntries([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], ['queued one', 'queued two'], 'deck_test', { hasEntriesField: true, hasMessagesField: true })).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('rejects legacy entries when only pending messages are present', () => {
    expect(normalizeTransportPendingEntries(undefined, ['queued one', 'queued two'], 'deck_test', {
      hasEntriesField: false,
      hasMessagesField: true,
    })).toEqual([]);
  });
});

describe('removeTransportPendingEntryForUserMessage', () => {
  it('removes the echoed queued entry by clientMessageId', () => {
    expect(removeTransportPendingEntryForUserMessage(
      [
        { clientMessageId: 'msg-1', text: 'queued one' },
        { clientMessageId: 'msg-2', text: 'queued two' },
      ],
      ['queued one', 'queued two'],
      { clientMessageId: 'msg-1', text: 'queued one' },
      'deck_test',
    )).toEqual({
      messages: ['queued two'],
      entries: [{ clientMessageId: 'msg-2', text: 'queued two' }],
      changed: true,
    });
  });

  it('does not fall back to normalized text when the echoed user message has no id', () => {
    expect(removeTransportPendingEntryForUserMessage(
      [],
      ['queued   one', 'queued two'],
      { text: 'queued one' },
      'deck_test',
    )).toEqual({
      messages: [],
      entries: [],
      changed: false,
    });
  });

  it('leaves the queue untouched when no echoed entry matches', () => {
    expect(removeTransportPendingEntryForUserMessage(
      [{ clientMessageId: 'msg-1', text: 'queued one' }],
      ['queued one'],
      { clientMessageId: 'msg-2', text: 'other' },
      'deck_test',
    )).toEqual({
      messages: ['queued one'],
      entries: [{ clientMessageId: 'msg-1', text: 'queued one' }],
      changed: false,
    });
  });
});

describe('mergeTransportPendingEntriesForRunningState', () => {
  it('preserves the existing queued entries when running reports no pendingMessageEntries field', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], undefined, undefined, false, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('ignores explicit empty legacy entry snapshots instead of clearing live entries', () => {
    const existing = [
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ];
    expect(mergeTransportPendingEntriesForRunningState(existing, [], [], true, 'deck_test')).toEqual(existing);
  });

  it('preserves entries when running event omits pending field', () => {
    const existing = [
      { clientMessageId: 'msg-1', text: 'queued one' },
    ];
    expect(mergeTransportPendingEntriesForRunningState(existing, undefined, undefined, false, 'deck_test')).toEqual(existing);
  });

  it('ignores non-structured pendingMessageEntries outside the strict queue patch helper', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-2', text: 'queued two' },
    ], ['queued two'], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('treats running entries as authoritative instead of filling legacy tails', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], ['queued one', 'queued two'], true, 'deck_test', true)).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('clears entries when running reports empty after drain (authoritative)', () => {
    const existing = [
      { clientMessageId: 'msg-1', text: 'a' },
      { clientMessageId: 'msg-2', text: 'b' },
      { clientMessageId: 'msg-3', text: 'c' },
    ];
    expect(mergeTransportPendingEntriesForRunningState(existing, [], [], true, 'deck_test')).toEqual(existing);
  });

  it('updates to remaining entries after partial drain', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'a' },
      { clientMessageId: 'msg-2', text: 'b' },
    ], [
      { clientMessageId: 'msg-2', text: 'b' },
    ], ['b'], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'a' },
      { clientMessageId: 'msg-2', text: 'b' },
    ]);
  });

  it('preserves existing when hasPendingMessagesField is false regardless of event data', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'keep' },
    ], [], [], false, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'keep' },
    ]);
  });
});

describe('mergeTransportPendingMessagesForIdleState', () => {
  it('preserves the existing queue when idle reports no pendingMessages field', () => {
    expect(mergeTransportPendingMessagesForIdleState(['queued one'], undefined, false)).toEqual(['queued one']);
  });

  it('ignores explicit empty legacy pending arrays while idle', () => {
    expect(mergeTransportPendingMessagesForIdleState(['queued one'], [], true)).toEqual(['queued one']);
  });

  it('rejects non-empty legacy pending messages from idle state', () => {
    expect(mergeTransportPendingMessagesForIdleState(['queued one'], ['queued two'], true)).toEqual(['queued one']);
  });
});

describe('mergeTransportPendingEntriesForIdleState', () => {
  it('preserves existing queued entries when idle reports no queue fields', () => {
    expect(mergeTransportPendingEntriesForIdleState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], undefined, undefined, false, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('ignores explicit empty legacy entry snapshots while idle', () => {
    expect(mergeTransportPendingEntriesForIdleState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [], [], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('ignores non-structured idle queue snapshots outside the strict queue patch helper', () => {
    expect(mergeTransportPendingEntriesForIdleState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-2', text: 'queued two' },
    ], ['queued two'], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });
});

describe('extractTransportPendingVersion', () => {
  it('returns finite numbers and undefined otherwise', () => {
    expect(extractTransportPendingVersion(0)).toBe(0);
    expect(extractTransportPendingVersion(7)).toBe(7);
    expect(extractTransportPendingVersion(undefined)).toBeUndefined();
    expect(extractTransportPendingVersion(null)).toBeUndefined();
    expect(extractTransportPendingVersion('3')).toBeUndefined();
    expect(extractTransportPendingVersion(Number.NaN)).toBeUndefined();
    expect(extractTransportPendingVersion(Infinity)).toBeUndefined();
  });
});

describe('shouldApplyTransportQueueSnapshot', () => {
  it('applies unversioned snapshots only before a versioned baseline exists', () => {
    expect(shouldApplyTransportQueueSnapshot(5, undefined)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(undefined, undefined)).toBe(true);
  });
  it('applies when there is no baseline yet', () => {
    expect(shouldApplyTransportQueueSnapshot(undefined, 3)).toBe(true);
  });
  it('drops strictly-older snapshots (the stale-snapshot resurrection guard)', () => {
    expect(shouldApplyTransportQueueSnapshot(3, 2)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(10, 1)).toBe(false);
  });
  it('applies equal or newer versions (idempotent + forward progress)', () => {
    expect(shouldApplyTransportQueueSnapshot(3, 3)).toBe(true);
    expect(shouldApplyTransportQueueSnapshot(3, 4)).toBe(true);
  });
  it('rejects version 0 after a higher baseline instead of treating it as a reset', () => {
    expect(shouldApplyTransportQueueSnapshot(9, 0)).toBe(false);
  });
});

describe('nextTransportQueueVersion', () => {
  it('keeps baseline when snapshot is unversioned', () => {
    expect(nextTransportQueueVersion(5, undefined)).toBe(5);
    expect(nextTransportQueueVersion(undefined, undefined)).toBeUndefined();
  });
  it('does not reset to 0 after a higher baseline', () => {
    expect(nextTransportQueueVersion(9, 0)).toBe(9);
  });
  it('advances monotonically', () => {
    expect(nextTransportQueueVersion(undefined, 2)).toBe(2);
    expect(nextTransportQueueVersion(2, 5)).toBe(5);
    expect(nextTransportQueueVersion(5, 5)).toBe(5);
    // Never moves backward even if a caller passes a stale value.
    expect(nextTransportQueueVersion(5, 3)).toBe(5);
  });
});

describe('buildTransportPendingSyncPatch new queue protocol', () => {
  it('applies structured epoch/authority snapshots without normalizing multiline text', () => {
    const patch = buildTransportPendingSyncPatch({}, {
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 1,
      pendingMessageEntries: [
        { clientMessageId: 'msg-1', text: '  hello\n\nworld   ' },
      ],
      failedMessageEntries: [
        { clientMessageId: 'msg-failed', text: 'failed text' },
      ],
    }, 'deck_test');

    expect(patch).toEqual({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 1,
      transportPendingMessages: ['  hello\n\nworld   '],
      transportPendingMessageEntries: [{ clientMessageId: 'msg-1', text: '  hello\n\nworld   ' }],
      failedMessageEntries: [{ clientMessageId: 'msg-failed', text: 'failed text' }],
    });
  });

  it('rejects same-epoch authority mismatch', () => {
    const patch = buildTransportPendingSyncPatch({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 3,
      transportPendingMessageEntries: [{ clientMessageId: 'msg-1', text: 'keep' }],
    }, {
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-2',
      pendingMessageVersion: 4,
      pendingMessageEntries: [{ clientMessageId: 'msg-2', text: 'reject' }],
    }, 'deck_test');

    expect(patch).toEqual({});
  });

  it('does not treat wire pendingCount or legacy text arrays as live queue evidence', () => {
    const patch = buildTransportPendingSyncPatch({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 2,
      transportPendingMessageEntries: [{ clientMessageId: 'keep', text: 'keep\nmultiline' }],
      transportPendingMessages: ['keep\nmultiline'],
    }, {
      transportPendingMessages: ['legacy stale text'],
      pendingCount: 12,
    }, 'deck_test');

    expect(patch).toEqual({});
  });

  it('applies recognized runtime_recreated reset and does not resurrect old entries', () => {
    const patch = buildTransportPendingSyncPatch({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 5,
      transportPendingMessageEntries: [{ clientMessageId: 'old', text: 'old text' }],
      transportPendingMessages: ['old text'],
    }, {
      queueEpoch: 'epoch-2',
      queueAuthorityId: 'authority-2',
      pendingMessageVersion: 1,
      resetReason: 'runtime_recreated',
      pendingMessageEntries: [{ clientMessageId: 'new', text: 'new\ntext' }],
    }, 'deck_test');

    expect(patch.transportPendingMessageEntries).toEqual([{ clientMessageId: 'new', text: 'new\ntext' }]);
    expect(patch.transportPendingMessages).toEqual(['new\ntext']);
    expect(patch.queueEpoch).toBe('epoch-2');
    expect(patch.queueAuthorityId).toBe('authority-2');
  });

  it('rejects unknown cross-epoch resets even when pendingCount is non-zero', () => {
    const patch = buildTransportPendingSyncPatch({
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      transportPendingMessageVersion: 5,
      transportPendingMessageEntries: [{ clientMessageId: 'old', text: 'old text' }],
      transportPendingMessages: ['old text'],
    }, {
      queueEpoch: 'epoch-2',
      queueAuthorityId: 'authority-2',
      pendingMessageVersion: 1,
      resetReason: 'not_real',
      pendingMessageEntries: [{ clientMessageId: 'bad', text: 'bad text' }],
      pendingCount: 1,
    }, 'deck_test');

    expect(patch).toEqual({});
  });
});
