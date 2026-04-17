import { describe, expect, it } from 'vitest';

import {
  extractTransportPendingMessageEntries,
  extractTransportPendingMessages,
  isLegacyTransportPendingMessageId,
  mergeTransportPendingEntriesForIdleState,
  mergeTransportPendingEntriesForRunningState,
  mergeTransportPendingMessagesForIdleState,
  mergeTransportPendingMessagesForRunningState,
  normalizeTransportPendingEntries,
  synthesizeTransportPendingMessageEntries,
} from '../src/transport-queue.js';

describe('extractTransportPendingMessages', () => {
  it('keeps only non-empty string entries', () => {
    expect(extractTransportPendingMessages([' one ', '', 1, null, 'two'])).toEqual(['one', 'two']);
  });
});

describe('mergeTransportPendingMessagesForRunningState', () => {
  it('preserves the existing queue when running reports no pendingMessages field', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one'], undefined, false)).toEqual(['queued one']);
  });

  it('clears queue when running reports explicit empty pending (drain completed)', () => {
    // Daemon emits explicit empty on drain — messages moved to timeline via user.message
    expect(mergeTransportPendingMessagesForRunningState(['queued one', 'queued two'], [], true)).toEqual([]);
  });

  it('preserves queue when running event omits pending field (not queue-authoritative)', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one', 'queued two'], undefined, false)).toEqual(['queued one', 'queued two']);
  });

  it('replaces the queue when running reports a non-empty pendingMessages array', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one'], ['queued two'], true)).toEqual(['queued two']);
  });

  it('returns an empty queue when nothing is queued yet', () => {
    expect(mergeTransportPendingMessagesForRunningState([], [], true)).toEqual([]);
  });

  it('clears when running reports empty after drain (was: preserved, now authoritative)', () => {
    expect(mergeTransportPendingMessagesForRunningState(['a', 'b', 'c'], [], true)).toEqual([]);
  });

  it('updates to remaining queue after partial drain', () => {
    expect(mergeTransportPendingMessagesForRunningState(['a', 'b', 'c'], ['c'], true)).toEqual(['c']);
  });
});

describe('extractTransportPendingMessageEntries', () => {
  it('keeps only entries with a stable id and non-empty text', () => {
    expect(extractTransportPendingMessageEntries([
      { clientMessageId: ' msg-1 ', text: ' one ' },
      { clientMessageId: '', text: 'nope' },
      { clientMessageId: 'msg-2', text: '' },
      null,
      1,
      { clientMessageId: 'msg-3', text: 'two' },
    ])).toEqual([
      { clientMessageId: 'msg-1', text: 'one' },
      { clientMessageId: 'msg-3', text: 'two' },
    ]);
  });
});

describe('synthesizeTransportPendingMessageEntries', () => {
  it('builds stable legacy entries from pending messages', () => {
    expect(synthesizeTransportPendingMessageEntries(['queued one', 'queued two'], 'deck_test')).toEqual([
      { clientMessageId: 'deck_test:legacy:0:queued one', text: 'queued one' },
      { clientMessageId: 'deck_test:legacy:1:queued two', text: 'queued two' },
    ]);
  });
});

describe('isLegacyTransportPendingMessageId', () => {
  it('detects synthesized fallback ids only within the same queue scope', () => {
    expect(isLegacyTransportPendingMessageId('deck_test:legacy:0:queued one', 'deck_test')).toBe(true);
    expect(isLegacyTransportPendingMessageId('deck_other:legacy:0:queued one', 'deck_test')).toBe(false);
    expect(isLegacyTransportPendingMessageId('msg-real-1', 'deck_test')).toBe(false);
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

  it('fills missing queued entries from pendingMessages when entries are partial', () => {
    expect(normalizeTransportPendingEntries([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], ['queued one', 'queued two'], 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'deck_test:legacy:1:queued two', text: 'queued two' },
    ]);
  });

  it('synthesizes legacy entries when only pending messages are present', () => {
    expect(normalizeTransportPendingEntries([], ['queued one', 'queued two'], 'deck_test')).toEqual([
      { clientMessageId: 'deck_test:legacy:0:queued one', text: 'queued one' },
      { clientMessageId: 'deck_test:legacy:1:queued two', text: 'queued two' },
    ]);
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

  it('clears entries when running reports explicit empty pending (drain completed)', () => {
    const existing = [
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ];
    expect(mergeTransportPendingEntriesForRunningState(existing, [], [], true, 'deck_test')).toEqual([]);
  });

  it('preserves entries when running event omits pending field', () => {
    const existing = [
      { clientMessageId: 'msg-1', text: 'queued one' },
    ];
    expect(mergeTransportPendingEntriesForRunningState(existing, undefined, undefined, false, 'deck_test')).toEqual(existing);
  });

  it('replaces the queue when running reports non-empty pendingMessageEntries', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-2', text: 'queued two' },
    ], ['queued two'], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);
  });

  it('fills missing running queued entries from pendingMessages when entries are partial', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], ['queued one', 'queued two'], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'deck_test:legacy:1:queued two', text: 'queued two' },
    ]);
  });

  it('clears entries when running reports empty after drain (authoritative)', () => {
    const existing = [
      { clientMessageId: 'msg-1', text: 'a' },
      { clientMessageId: 'msg-2', text: 'b' },
      { clientMessageId: 'msg-3', text: 'c' },
    ];
    expect(mergeTransportPendingEntriesForRunningState(existing, [], [], true, 'deck_test')).toEqual([]);
  });

  it('updates to remaining entries after partial drain', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'a' },
      { clientMessageId: 'msg-2', text: 'b' },
    ], [
      { clientMessageId: 'msg-2', text: 'b' },
    ], ['b'], true, 'deck_test')).toEqual([
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

  it('clears the queue when idle reports explicit empty pending', () => {
    expect(mergeTransportPendingMessagesForIdleState(['queued one'], [], true)).toEqual([]);
  });

  it('replaces the queue when idle reports explicit pending messages', () => {
    expect(mergeTransportPendingMessagesForIdleState(['queued one'], ['queued two'], true)).toEqual(['queued two']);
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

  it('clears entries when idle reports explicit empty queue', () => {
    expect(mergeTransportPendingEntriesForIdleState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [], [], true, 'deck_test')).toEqual([]);
  });

  it('replaces entries when idle reports an explicit queue snapshot', () => {
    expect(mergeTransportPendingEntriesForIdleState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-2', text: 'queued two' },
    ], ['queued two'], true, 'deck_test')).toEqual([
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);
  });
});
