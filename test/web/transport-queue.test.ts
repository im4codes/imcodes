import { describe, expect, it } from 'vitest';
import {
  hasExplicitTransportPendingSnapshot,
  normalizeTransportPendingEntries,
  nextTransportQueueVersion,
  removeTransportPendingEntryForUserMessage,
  shouldApplyTransportQueueSnapshot,
  shouldApplyTransportQueueSnapshotForPayload,
} from '../../web/src/transport-queue.js';

describe('transport queue reconciliation', () => {
  it('does not apply unversioned snapshots after a versioned baseline exists', () => {
    expect(shouldApplyTransportQueueSnapshot(undefined, undefined)).toBe(true);
    expect(shouldApplyTransportQueueSnapshot(3, undefined)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(3, 0)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(3, 2)).toBe(false);
    expect(shouldApplyTransportQueueSnapshot(3, 3)).toBe(true);
    expect(shouldApplyTransportQueueSnapshot(3, 4)).toBe(true);
    expect(nextTransportQueueVersion(3, 0)).toBe(3);
  });

  it('rejects explicit empty unversioned clear after a versioned baseline', () => {
    expect(shouldApplyTransportQueueSnapshotForPayload(3, undefined, {
      hasExplicitSnapshot: true,
      isExplicitEmpty: true,
    })).toBe(false);
    expect(shouldApplyTransportQueueSnapshotForPayload(3, undefined, {
      hasExplicitSnapshot: false,
      isExplicitEmpty: true,
    })).toBe(false);
    expect(shouldApplyTransportQueueSnapshotForPayload(3, undefined, {
      hasExplicitSnapshot: true,
      isExplicitEmpty: false,
    })).toBe(false);
  });

  it('treats entries as authoritative when legacy messages disagree', () => {
    const entries = normalizeTransportPendingEntries(
      [{ clientMessageId: 'stable-a', text: 'same text' }],
      ['same   text'],
      'session-a',
    );
    expect(entries).toEqual([{ clientMessageId: 'stable-a', text: 'same text' }]);
  });



  it('treats present entries as fully authoritative and does not append legacy message tails', () => {
    const entries = normalizeTransportPendingEntries(
      [{ clientMessageId: 'stable-a', text: 'A' }],
      ['A', 'stale-B'],
      'session-a',
      { hasEntriesField: true, hasMessagesField: true },
    );

    expect(entries).toEqual([{ clientMessageId: 'stable-a', text: 'A' }]);
  });

  it('treats present empty entries as an authoritative empty queue', () => {
    const entries = normalizeTransportPendingEntries(
      [],
      ['stale-B'],
      'session-a',
      { hasEntriesField: true, hasMessagesField: true },
    );

    expect(entries).toEqual([]);
  });

  it('rejects legacy messages when entries are absent', () => {
    const entries = normalizeTransportPendingEntries(
      undefined,
      ['legacy-A'],
      'session-a',
      { hasEntriesField: false, hasMessagesField: true },
    );

    expect(entries).toEqual([]);
  });

  it('detects explicit snapshots from structured queue fields only', () => {
    expect(hasExplicitTransportPendingSnapshot({ pendingMessageEntries: [] })).toBe(true);
    expect(hasExplicitTransportPendingSnapshot({ transportPendingMessageEntries: [] })).toBe(false);
    expect(hasExplicitTransportPendingSnapshot({ state: 'running' })).toBe(false);
  });

  it('text fallback refuses ambiguous duplicate pending entries', () => {
    const result = removeTransportPendingEntryForUserMessage(
      [
        { clientMessageId: 'a', text: 'same text' },
        { clientMessageId: 'b', text: 'same   text' },
      ],
      ['same text', 'same   text'],
      { text: 'same text' },
      'session-a',
    );

    expect(result.changed).toBe(false);
    expect(result.entries.map((entry) => entry.clientMessageId)).toEqual(['a', 'b']);
  });

  it('does not let a wrong id fall back to deleting by text', () => {
    const result = removeTransportPendingEntryForUserMessage(
      [{ clientMessageId: 'queued-a', text: 'same text' }],
      ['same text'],
      { clientMessageId: 'delivered-other', text: 'same text' },
      'session-a',
    );

    expect(result.changed).toBe(false);
    expect(result.entries.map((entry) => entry.clientMessageId)).toEqual(['queued-a']);
  });

  it('does not clear legacy-shaped queued entries by text with a different delivered id', () => {
    const result = removeTransportPendingEntryForUserMessage(
      [{ clientMessageId: 'session-a:legacy:0:same text', text: 'same text' }],
      ['same text'],
      { clientMessageId: 'real-command-id', text: 'same text' },
      'session-a',
    );

    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([{ clientMessageId: 'session-a:legacy:0:same text', text: 'same text' }]);
    expect(result.messages).toEqual(['same text']);
  });
});
