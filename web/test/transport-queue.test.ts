import { describe, expect, it } from 'vitest';

import {
  extractTransportPendingMessageEntries,
  extractTransportPendingMessages,
  mergeTransportPendingEntriesForRunningState,
  mergeTransportPendingMessagesForRunningState,
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

  it('preserves the existing queue when running reports an empty pendingMessages array', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one', 'queued two'], [], true)).toEqual(['queued one', 'queued two']);
  });

  it('replaces the queue when running reports a non-empty pendingMessages array', () => {
    expect(mergeTransportPendingMessagesForRunningState(['queued one'], ['queued two'], true)).toEqual(['queued two']);
  });

  it('returns an empty queue when nothing is queued yet', () => {
    expect(mergeTransportPendingMessagesForRunningState([], [], true)).toEqual([]);
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

describe('mergeTransportPendingEntriesForRunningState', () => {
  it('preserves the existing queued entries when running reports no pendingMessageEntries field', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], undefined, false)).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ]);
  });

  it('preserves the existing queued entries when running reports an empty pendingMessageEntries array', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ], [], true)).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);
  });

  it('replaces the queue when running reports non-empty pendingMessageEntries', () => {
    expect(mergeTransportPendingEntriesForRunningState([
      { clientMessageId: 'msg-1', text: 'queued one' },
    ], [
      { clientMessageId: 'msg-2', text: 'queued two' },
    ], true)).toEqual([
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);
  });
});
