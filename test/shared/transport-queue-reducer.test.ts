import { describe, expect, it } from 'vitest';

import {
  createTransportQueueReducerState,
  reduceTransportQueueEvent,
  selectFailedQueueEntries,
  selectLiveQueueCount,
  selectLiveQueueEntries,
  selectReceipt,
} from '../../shared/transport-queue-reducer.js';
import type { QueueProjectionEntry, QueueSnapshot } from '../../shared/transport-queue-types.js';

function entry(input: Partial<QueueProjectionEntry> & { clientMessageId: string; text?: string }): QueueProjectionEntry {
  return {
    clientMessageId: input.clientMessageId,
    text: input.text ?? input.clientMessageId,
    status: input.status ?? 'queued',
    placement: input.placement ?? 'normal',
    ordinal: input.ordinal ?? 0,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
    ...(input.commandId ? { commandId: input.commandId } : {}),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
  };
}

function snapshot(input: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    type: 'transport.queue.snapshot',
    sessionName: input.sessionName ?? 'deck',
    queueEpoch: input.queueEpoch ?? 'epoch-1',
    queueAuthorityId: input.queueAuthorityId ?? 'authority-1',
    pendingMessageVersion: input.pendingMessageVersion ?? 1,
    pendingMessageEntries: input.pendingMessageEntries ?? [],
    failedMessageEntries: input.failedMessageEntries ?? [],
    source: input.source ?? 'test',
    ...(input.resetReason ? { resetReason: input.resetReason } : {}),
  };
}

describe('transport queue reducer', () => {
  it('rejects legacy-only payloads by requiring typed queue events', () => {
    const state = createTransportQueueReducerState('deck');
    const next = reduceTransportQueueEvent(state, {
      type: 'transport.queue.snapshot',
      sessionName: 'deck',
      queueEpoch: '',
      queueAuthorityId: '',
      pendingMessageVersion: Number.NaN,
      pendingMessageEntries: [],
      failedMessageEntries: [],
      source: 'legacy',
      pendingMessages: ['legacy text'],
      transportPendingMessages: ['legacy text'],
      pendingCount: 1,
    } as never);

    expect(selectLiveQueueCount(next)).toBe(0);
    expect(next.degradedEvidence).toContain('missing_epoch_authority_or_version');
  });

  it('applies same-epoch snapshots only when version is not stale', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageVersion: 2,
      pendingMessageEntries: [entry({ clientMessageId: 'newer' })],
    }));

    const stale = reduceTransportQueueEvent(state, snapshot({
      pendingMessageVersion: 1,
      pendingMessageEntries: [entry({ clientMessageId: 'stale' })],
    }));

    expect(selectLiveQueueEntries(stale).map((item) => item.clientMessageId)).toEqual(['newer']);
    expect(stale.degradedEvidence).toContain('stale_version');
  });

  it('rejects same-epoch authority mismatch and different-epoch authority reuse', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [entry({ clientMessageId: 'base' })],
    }));

    const sameEpochDifferentAuthority = reduceTransportQueueEvent(state, snapshot({
      queueAuthorityId: 'authority-2',
      pendingMessageVersion: 2,
      pendingMessageEntries: [entry({ clientMessageId: 'bad-1' })],
    }));
    expect(selectLiveQueueEntries(sameEpochDifferentAuthority).map((item) => item.clientMessageId)).toEqual(['base']);
    expect(sameEpochDifferentAuthority.degradedEvidence).toContain('same_epoch_authority_mismatch');

    const differentEpochSameAuthority = reduceTransportQueueEvent(state, snapshot({
      queueEpoch: 'epoch-2',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 1,
      pendingMessageEntries: [entry({ clientMessageId: 'bad-2' })],
    }));
    expect(selectLiveQueueEntries(differentEpochSameAuthority).map((item) => item.clientMessageId)).toEqual(['base']);
    expect(differentEpochSameAuthority.degradedEvidence).toContain('different_epoch_authority_reuse');
  });

  it('applies cross-epoch snapshots only with a recognized reset reason', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [entry({ clientMessageId: 'old' })],
    }));

    const rejected = reduceTransportQueueEvent(state, snapshot({
      queueEpoch: 'epoch-2',
      queueAuthorityId: 'authority-2',
      pendingMessageEntries: [entry({ clientMessageId: 'ignored' })],
    }));
    expect(selectLiveQueueEntries(rejected).map((item) => item.clientMessageId)).toEqual(['old']);

    const accepted = reduceTransportQueueEvent(state, snapshot({
      queueEpoch: 'epoch-2',
      queueAuthorityId: 'authority-2',
      resetReason: 'sqlite_restore',
      pendingMessageEntries: [entry({ clientMessageId: 'restored' })],
    }));
    expect(selectLiveQueueEntries(accepted).map((item) => item.clientMessageId)).toEqual(['restored']);
  });

  it('accepts every declared reset reason and rejects unknown reset reasons', () => {
    const base = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [entry({ clientMessageId: 'old' })],
    }));

    for (const reason of ['sqlite_restore', 'runtime_recreated', 'user_clear', 'authority_corrupt_reinitialized'] as const) {
      const reset = reduceTransportQueueEvent(base, snapshot({
        queueEpoch: `epoch-${reason}`,
        queueAuthorityId: `authority-${reason}`,
        resetReason: reason,
        pendingMessageEntries: [entry({ clientMessageId: `new-${reason}` })],
      }));
      expect(selectLiveQueueEntries(reset).map((item) => item.clientMessageId)).toEqual([`new-${reason}`]);
    }

    const rejected = reduceTransportQueueEvent(base, snapshot({
      queueEpoch: 'epoch-unknown',
      queueAuthorityId: 'authority-unknown',
      resetReason: 'unknown_reason' as never,
      pendingMessageEntries: [entry({ clientMessageId: 'bad' })],
    }));
    expect(selectLiveQueueEntries(rejected).map((item) => item.clientMessageId)).toEqual(['old']);
    expect(rejected.degradedEvidence).toContain('cross_epoch_without_recognized_reset');
  });

  it('records delivery tombstones and prevents same-epoch resurrection', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageVersion: 1,
      pendingMessageEntries: [entry({ clientMessageId: 'sent' }), entry({ clientMessageId: 'still' })],
    }));
    const delivered = reduceTransportQueueEvent(state, {
      type: 'transport.queue.delivery',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 2,
      clientMessageId: 'sent',
      deliveryFrameId: 'frame-1',
      deliveryFrameVersion: 1,
    });
    expect(selectLiveQueueEntries(delivered).map((item) => item.clientMessageId)).toEqual(['still']);

    const resurrecting = reduceTransportQueueEvent(delivered, snapshot({
      pendingMessageVersion: 3,
      pendingMessageEntries: [entry({ clientMessageId: 'sent' }), entry({ clientMessageId: 'still' })],
    }));
    expect(selectLiveQueueEntries(resurrecting).map((item) => item.clientMessageId)).toEqual(['still']);
  });

  it('settles a batch delivery frame idempotently for each clientMessageId', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageVersion: 1,
      pendingMessageEntries: [
        entry({ clientMessageId: 'one' }),
        entry({ clientMessageId: 'two' }),
        entry({ clientMessageId: 'three' }),
      ],
    }));
    const first = reduceTransportQueueEvent(state, {
      type: 'transport.queue.delivery',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 2,
      clientMessageId: 'one',
      deliveryFrameId: 'frame-batch',
      deliveryFrameVersion: 2,
    });
    const second = reduceTransportQueueEvent(first, {
      type: 'transport.queue.delivery',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 2,
      clientMessageId: 'two',
      deliveryFrameId: 'frame-batch',
      deliveryFrameVersion: 2,
    });
    const duplicate = reduceTransportQueueEvent(second, {
      type: 'transport.queue.delivery',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 2,
      clientMessageId: 'one',
      deliveryFrameId: 'frame-batch',
      deliveryFrameVersion: 2,
    });

    expect(selectLiveQueueEntries(duplicate).map((item) => item.clientMessageId)).toEqual(['three']);
    expect(duplicate.pendingMessageVersion).toBe(2);
    expect(Object.keys(duplicate.deliveredTombstones).sort()).toEqual(['epoch-1:one', 'epoch-1:two']);
  });

  it('sorts front placement ahead of normal placement deterministically', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [
        entry({ clientMessageId: 'normal', placement: 'normal', ordinal: 1 }),
        entry({ clientMessageId: 'front', placement: 'front', ordinal: 99 }),
      ],
    }));
    expect(selectLiveQueueEntries(state).map((item) => item.clientMessageId)).toEqual(['front', 'normal']);
  });

  it('preserves lossless multiline and repeated-space text', () => {
    const text = '  hello\n\nworld  with   spaces  ';
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [entry({ clientMessageId: 'multi', text })],
    }));
    expect(selectLiveQueueEntries(state)[0]?.text).toBe(text);
  });

  it('keeps failed entries separate from live pending entries', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [entry({ clientMessageId: 'live', status: 'queued' })],
      failedMessageEntries: [entry({ clientMessageId: 'failed', status: 'failed', failureReason: 'dispatch_failed' })],
    }));
    expect(selectLiveQueueCount(state)).toBe(1);
    expect(selectFailedQueueEntries(state).map((item) => item.clientMessageId)).toEqual(['failed']);
  });

  it('drops live entries on explicit failure/drop events without using pendingCount', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), snapshot({
      pendingMessageEntries: [
        entry({ clientMessageId: 'live-1' }),
        entry({ clientMessageId: 'live-2' }),
      ],
    }));

    const next = reduceTransportQueueEvent(state, {
      type: 'transport.queue.failure',
      sessionName: 'deck',
      queueEpoch: 'epoch-1',
      queueAuthorityId: 'authority-1',
      pendingMessageVersion: 2,
      clientMessageId: 'live-1',
      dropReason: 'user_stopped',
      pendingCount: 99,
    } as never);

    expect(selectLiveQueueEntries(next).map((item) => item.clientMessageId)).toEqual(['live-2']);
    expect(next.pendingMessageVersion).toBe(2);
  });

  it('treats command acknowledgements as receipts only', () => {
    const state = reduceTransportQueueEvent(createTransportQueueReducerState('deck'), {
      type: 'transport.queue.receipt',
      sessionName: 'deck',
      commandId: 'cmd-1',
      status: 'accepted',
    });
    expect(selectLiveQueueCount(state)).toBe(0);
    expect(selectReceipt(state, 'cmd-1')?.status).toBe('accepted');
  });
});
