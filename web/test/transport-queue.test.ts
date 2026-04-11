import { describe, expect, it } from 'vitest';

import {
  extractTransportPendingMessages,
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
