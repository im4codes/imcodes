import { describe, expect, it } from 'vitest';
import {
  removeTransportPendingEntryForUserMessage,
  shouldApplyTransportQueueSnapshot,
  shouldApplyTransportQueueSnapshotForPayload,
} from '../../web/src/transport-queue.js';

describe('transport queue reconciliation', () => {
  it('does not apply unversioned snapshots after a versioned baseline exists', () => {
    expect(shouldApplyTransportQueueSnapshot(undefined, undefined)).toBe(true);
    expect(shouldApplyTransportQueueSnapshot(3, undefined)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(3, 2)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(3, 3)).toBe(true);
    expect(shouldApplyTransportQueueSnapshot(3, 4)).toBe(true);
  });

  it('applies only explicit empty unversioned clear after a versioned baseline', () => {
    expect(shouldApplyTransportQueueSnapshotForPayload(3, undefined, {
      hasExplicitSnapshot: true,
      isExplicitEmpty: true,
    })).toBe(true);
    expect(shouldApplyTransportQueueSnapshotForPayload(3, undefined, {
      hasExplicitSnapshot: false,
      isExplicitEmpty: true,
    })).toBe(false);
    expect(shouldApplyTransportQueueSnapshotForPayload(3, undefined, {
      hasExplicitSnapshot: true,
      isExplicitEmpty: false,
    })).toBe(false);
  });

  it('text fallback consumes only one matching pending entry', () => {
    const result = removeTransportPendingEntryForUserMessage(
      [
        { clientMessageId: 'a', text: 'same text' },
        { clientMessageId: 'b', text: 'same   text' },
      ],
      ['same text', 'same   text'],
      { text: 'same text' },
      'session-a',
    );

    expect(result.changed).toBe(true);
    expect(result.entries.map((entry) => entry.clientMessageId)).toEqual(['b']);
    expect(result.messages).toEqual(['same   text']);
  });
});
