import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTransportQueueReducerState, reduceTransportQueueEvent } from '../../shared/transport-queue-reducer.js';
import type { QueueDeliveryFact, QueueEvent, QueueSnapshot } from '../../shared/transport-queue-types.js';
import { containsLegacyLiveQueueEvidence, isValidTransportQueueWireEvent } from '../../shared/transport-queue-wire.js';
import { TransportQueueStore } from '../../src/daemon/transport-queue-store.js';

let dir: string;
let dbPath: string;
let store: TransportQueueStore;

function reopenStore(): TransportQueueStore {
  store.close();
  store = new TransportQueueStore({ dbPath });
  return store;
}

function expectWireClean(event: QueueEvent): void {
  expect(isValidTransportQueueWireEvent(event)).toBe(true);
  expect(containsLegacyLiveQueueEvidence(event)).toBe(false);
  const encoded = JSON.stringify(event);
  expect(encoded).not.toContain('pendingMessages');
  expect(encoded).not.toContain('transportPendingMessages');
  expect(encoded).not.toContain('pendingCount');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imcodes-queue-sync-e2e-'));
  dbPath = join(dir, 'transport-queue.sqlite');
  store = new TransportQueueStore({ dbPath });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('transport queue sync deterministic E2E fixture', () => {
  it('covers reorder, reconnect, daemon restart handoff, remote bridge projection, and explicit removal reasons', () => {
    store.enqueue({ sessionName: 'deck_e2e', clientMessageId: 'normal-1', text: 'normal one', now: 100 });
    store.enqueue({ sessionName: 'deck_e2e', clientMessageId: 'normal-2', text: 'normal two', now: 101 });
    const frontSnapshot = store.enqueue({
      sessionName: 'deck_e2e',
      clientMessageId: 'front-1',
      text: 'front\nmessage',
      placement: 'front',
      now: 102,
    });

    expect(frontSnapshot.pendingMessageEntries.map((entry) => entry.clientMessageId))
      .toEqual(['front-1', 'normal-1', 'normal-2']);
    expectWireClean(frontSnapshot);

    let remoteView = reduceTransportQueueEvent(createTransportQueueReducerState('deck_e2e'), frontSnapshot);
    expect(remoteView.pendingMessageEntries.map((entry) => entry.clientMessageId))
      .toEqual(['front-1', 'normal-1', 'normal-2']);

    store.markHandoffInFlight('deck_e2e', ['front-1'], 10, 200);
    reopenStore();
    const restoredAfterDaemonRestart = store.restoreExpiredHandoffs('deck_e2e', 211);
    expect(restoredAfterDaemonRestart.pendingMessageEntries.map((entry) => [entry.clientMessageId, entry.status]))
      .toEqual([
        ['front-1', 'queued'],
        ['normal-1', 'queued'],
        ['normal-2', 'queued'],
      ]);
    expect(restoredAfterDaemonRestart.pendingMessageVersion).toBeGreaterThan(frontSnapshot.pendingMessageVersion);
    expectWireClean(restoredAfterDaemonRestart);

    remoteView = reduceTransportQueueEvent(remoteView, restoredAfterDaemonRestart);
    expect(remoteView.pendingMessageEntries.map((entry) => entry.clientMessageId))
      .toEqual(['front-1', 'normal-1', 'normal-2']);

    const sent = store.finalizeSentBatch('deck_e2e', ['front-1', 'normal-1', 'normal-2'], 'frame-e2e', 300);
    expect(sent.snapshot.pendingMessageEntries).toEqual([]);
    expect(sent.deliveryFacts.map((fact) => fact.clientMessageId)).toEqual(['front-1', 'normal-1', 'normal-2']);
    expectWireClean(sent.snapshot);
    for (const fact of sent.deliveryFacts as QueueDeliveryFact[]) {
      expectWireClean(fact);
      remoteView = reduceTransportQueueEvent(remoteView, fact);
    }
    remoteView = reduceTransportQueueEvent(remoteView, sent.snapshot);
    expect(remoteView.pendingMessageEntries).toEqual([]);

    const staleSameEpochSnapshot: QueueSnapshot = {
      ...restoredAfterDaemonRestart,
      source: 'stale-reconnect',
    };
    remoteView = reduceTransportQueueEvent(remoteView, staleSameEpochSnapshot);
    expect(remoteView.pendingMessageEntries).toEqual([]);
    expect(Object.keys(remoteView.deliveredTombstones).length).toBe(3);

    store.enqueue({ sessionName: 'deck_e2e', clientMessageId: 'stop-queued', text: 'stop me', now: 400 });
    const stopped = store.dropAll('deck_e2e', 'user_stopped', 401);
    expect(stopped.pendingMessageEntries).toEqual([]);
    expect(stopped.dropReason).toBe('user_stopped');
    expectWireClean(stopped);

    store.enqueue({ sessionName: 'deck_e2e', clientMessageId: 'clear-queued', text: 'clear me', now: 500 });
    const cleared = store.reset('deck_e2e', 'user_clear', 501);
    expect(cleared.pendingMessageEntries).toEqual([]);
    expect(cleared.resetReason).toBe('user_clear');
    expectWireClean(cleared);

    store.enqueue({ sessionName: 'deck_e2e', clientMessageId: 'delete-queued', text: 'delete me', now: 600 });
    const deleted = store.dropAll('deck_e2e', 'session_removed', 601);
    expect(deleted.pendingMessageEntries).toEqual([]);
    expect(deleted.dropReason).toBe('session_removed');
    expectWireClean(deleted);
  });
});
