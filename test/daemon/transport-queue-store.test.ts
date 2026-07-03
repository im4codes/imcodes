import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TransportQueueStore } from '../../src/daemon/transport-queue-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

let dir: string;
let store: TransportQueueStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imcodes-transport-queue-'));
  store = new TransportQueueStore({ dbPath: join(dir, 'queue.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TransportQueueStore', () => {
  it('persists live entries in SQLite snapshots with transaction-generated versions', () => {
    const first = store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      commandId: 'cmd-1',
      text: 'hello\n\nworld',
      now: 100,
    });
    expect(first.pendingMessageVersion).toBe(1);
    expect(first.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-1']);
    expect(first.pendingMessageEntries[0]?.text).toBe('hello\n\nworld');
    expect(first.pendingMessageEntries[0]?.commandId).toBe('cmd-1');

    const second = store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-2',
      text: 'second',
      now: 200,
    });
    expect(second.queueEpoch).toBe(first.queueEpoch);
    expect(second.queueAuthorityId).toBe(first.queueAuthorityId);
    expect(second.pendingMessageVersion).toBe(2);
  });

  it('preserves duplicate, multiline, blank-line, and leading/trailing-space text losslessly by id', () => {
    const firstText = '  same text\n\nwith blank line  ';
    const secondText = '  same text\n\nwith blank line  ';
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: firstText, now: 100 });
    const snapshot = store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-2', text: secondText, now: 101 });

    expect(snapshot.pendingMessageEntries.map((entry) => [entry.clientMessageId, entry.text])).toEqual([
      ['msg-1', firstText],
      ['msg-2', secondText],
    ]);

    const edited = store.edit('deck', 'msg-1', '\n edited text with trailing space \n', 200);
    expect(edited.pendingMessageEntries.find((entry) => entry.clientMessageId === 'msg-1')?.text)
      .toBe('\n edited text with trailing space \n');
    expect(edited.pendingMessageEntries.find((entry) => entry.clientMessageId === 'msg-2')?.text)
      .toBe(secondText);
  });

  it('sorts front placement before normal entries by persisted ordering', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'normal', text: 'normal', now: 100 });
    const snapshot = store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'front',
      text: 'front',
      placement: 'front',
      now: 200,
    });
    expect(snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['front', 'normal']);
  });

  it('marks handoff in-flight without deleting the entry and exposes private material only to handoff callers', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'secret dispatch',
      privateMaterialJson: JSON.stringify({ messagePreamble: 'private', daemonPath: '/tmp/secret' }),
      now: 100,
    });

    const handoff = store.markHandoffInFlight('deck', ['msg-1'], 60_000, 200);
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.entry.status).toBe('handoff_inflight');
    expect(handoff[0]?.privateMaterialJson).toContain('private');

    const snapshot = store.readSnapshot('deck');
    expect(snapshot.pendingMessageEntries[0]?.clientMessageId).toBe('msg-1');
    expect(JSON.stringify(snapshot)).not.toContain('daemonPath');
    expect(JSON.stringify(snapshot)).not.toContain('messagePreamble');
  });

  it('recovers private dispatch material from SQLite and fails closed when it is missing', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-private',
      text: 'recoverable text',
      privateMaterialJson: JSON.stringify({
        text: 'recoverable text',
        messagePreamble: 'private preamble',
        attachmentRefs: [{ daemonPath: '/tmp/private-path' }],
      }),
      now: 100,
    });

    expect(store.readPrivateDispatchMaterial('deck', 'msg-private')).toContain('private preamble');

    const failed = store.markMissingPrivateMaterialFailed('deck', 'msg-private', 200);
    expect(failed.pendingMessageEntries).toEqual([]);
    expect(failed.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-private']);
    expect(failed.failedMessageEntries[0]?.failureReason).toBe('private_material_missing');
    expect(failed.dropReason).toBe('private_material_missing');
    expect(store.readPrivateDispatchMaterial('deck', 'msg-private')).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain('private preamble');
    expect(JSON.stringify(failed)).not.toContain('/tmp/private-path');
  });

  it('finalizes sent entries with a delivery tombstone and removes private material', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'sent',
      privateMaterialJson: JSON.stringify({ messagePreamble: 'private' }),
      now: 100,
    });

    const snapshot = store.finalizeSent('deck', 'msg-1', 'frame-1', 200);
    expect(snapshot.pendingMessageEntries).toEqual([]);
    expect(snapshot.failedMessageEntries).toEqual([]);
    expect(snapshot.pendingMessageVersion).toBe(2);
  });

  it('finalizes a sent batch with one shared delivery frame and one fact per message', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'one', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-2', text: 'two', now: 101 });

    const result = store.finalizeSentBatch('deck', ['msg-1', 'msg-2', 'msg-1'], 'frame-merged', 200);

    expect(result.snapshot.pendingMessageEntries).toEqual([]);
    expect(result.deliveryFacts.map((fact) => fact.clientMessageId)).toEqual(['msg-1', 'msg-2']);
    expect(new Set(result.deliveryFacts.map((fact) => fact.deliveryFrameId))).toEqual(new Set(['frame-merged']));
    expect(new Set(result.deliveryFacts.map((fact) => fact.deliveryFrameVersion))).toEqual(new Set([3]));
    expect(result.deliveryFacts.every((fact) => fact.queueEpoch === result.snapshot.queueEpoch)).toBe(true);
    expect(result.deliveryFacts.every((fact) => fact.queueAuthorityId === result.snapshot.queueAuthorityId)).toBe(true);
    expect(store.hasDeliveryTombstone('deck', 'msg-1')).toBe(true);
    expect(store.hasDeliveryTombstone('deck', 'msg-2')).toBe(true);
  });

  it('keeps failed entries separate from pending entries', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'will fail', now: 100 });
    const snapshot = store.markFailed('deck', 'msg-1', 'dispatch_failed', 200);
    expect(snapshot.pendingMessageEntries).toEqual([]);
    expect(snapshot.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-1']);
    expect(snapshot.failedMessageEntries[0]?.failureReason).toBe('dispatch_failed');
  });

  it('restores expired handoff leases back to queued', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'lease', now: 100 });
    store.markHandoffInFlight('deck', ['msg-1'], 10, 200);
    const snapshot = store.restoreExpiredHandoffs('deck', 211);
    expect(snapshot.pendingMessageEntries[0]?.status).toBe('queued');
  });

  it('reset creates a new epoch and clears live entries', () => {
    const before = store.enqueue({ sessionName: 'deck', clientMessageId: 'msg-1', text: 'queued', now: 100 });
    const after = store.reset('deck', 'user_clear', 200);
    expect(after.queueEpoch).not.toBe(before.queueEpoch);
    expect(after.queueAuthorityId).not.toBe(before.queueAuthorityId);
    expect(after.resetReason).toBe('user_clear');
    expect(after.pendingMessageEntries).toEqual([]);
  });

  it('edits and deletes by stable clientMessageId without normalizing text', () => {
    store.enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'original',
      now: 100,
    });
    const edited = store.edit('deck', 'msg-1', '  edited\n\nwith spaces  ', 200);
    expect(edited.pendingMessageEntries[0]?.clientMessageId).toBe('msg-1');
    expect(edited.pendingMessageEntries[0]?.text).toBe('  edited\n\nwith spaces  ');

    const deleted = store.markDeleted('deck', 'msg-1', 300);
    expect(deleted.pendingMessageEntries).toEqual([]);
    expect(deleted.failedMessageEntries).toEqual([]);
  });

  it('retries failed entries with a new clientMessageId and replacement relation', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'failed-original', text: 'original', now: 100 });
    store.markFailed('deck', 'failed-original', 'dispatch_failed', 200);

    const retried = store.retry('deck', 'failed-original', {
      clientMessageId: 'retry-new',
      commandId: 'cmd-retry',
      text: 'retry text',
      now: 300,
    });

    expect(retried.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['retry-new']);
    expect(retried.pendingMessageEntries[0]?.replacesClientMessageId).toBe('failed-original');
    expect(retried.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['failed-original']);
  });

  it('dismisses failed entries without affecting live pending entries', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'live', text: 'live', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'failed', text: 'failed', now: 101 });
    store.markFailed('deck', 'failed', 'dispatch_failed', 200);

    const dismissed = store.dismissFailed('deck', 'failed', 300);
    expect(dismissed.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['live']);
    expect(dismissed.failedMessageEntries).toEqual([]);
  });

  it('cleanup removes terminal rows after projection-safe terminalization', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'failed', text: 'failed', now: 100 });
    store.markFailed('deck', 'failed', 'dispatch_failed', 200);
    store.dismissFailed('deck', 'failed', 300);

    const cleaned = store.cleanup('deck', 400);
    expect(cleaned.pendingMessageEntries).toEqual([]);
    expect(cleaned.failedMessageEntries).toEqual([]);
    expect(cleaned.pendingMessageVersion).toBe(4);
  });

  it('records explicit drop/reset reasons for recognized removals', () => {
    for (const [index, reason] of (['expired', 'capacity_evicted', 'user_cleared', 'user_stopped', 'session_removed'] as const).entries()) {
      const id = `drop-${reason}`;
      store.enqueue({ sessionName: 'deck', clientMessageId: id, text: `drop ${reason}`, now: 100 + index });
      const dropped = store.drop('deck', id, reason, 200 + index);
      expect(dropped.dropReason).toBe(reason);
      expect(dropped.pendingMessageEntries.find((entry) => entry.clientMessageId === id)).toBeUndefined();
    }

    for (const [index, reason] of (['sqlite_restore', 'runtime_recreated', 'user_clear', 'authority_corrupt_reinitialized'] as const).entries()) {
      store.enqueue({ sessionName: 'deck', clientMessageId: `reset-${reason}`, text: `reset ${reason}`, now: 300 + index });
      const reset = store.reset('deck', reason, 400 + index);
      expect(reset.resetReason).toBe(reason);
      expect(reset.pendingMessageEntries).toEqual([]);
      expect(reset.failedMessageEntries).toEqual([]);
    }
  });

  it('runtime recreation emits a new authority baseline and does not resurrect old entries', () => {
    const before = store.enqueue({ sessionName: 'deck', clientMessageId: 'old', text: 'old queue', now: 100 });
    const reset = store.reset('deck', 'runtime_recreated', 200, { activityGeneration: 42 });
    expect(reset.queueEpoch).not.toBe(before.queueEpoch);
    expect(reset.queueAuthorityId).not.toBe(before.queueAuthorityId);
    expect(reset.resetReason).toBe('runtime_recreated');
    expect(reset.activityGeneration).toBe(42);
    expect(reset.pendingMessageEntries).toEqual([]);

    const after = store.enqueue({ sessionName: 'deck', clientMessageId: 'new', text: 'new queue', now: 300 });
    expect(after.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['new']);
    expect(after.pendingMessageEntries.find((entry) => entry.clientMessageId === 'old')).toBeUndefined();
  });

  it('reinitializes corrupt authority with explicit reset metadata', () => {
    const before = store.enqueue({ sessionName: 'deck', clientMessageId: 'old', text: 'old queue', now: 100 });
    const reset = store.reinitializeAfterCorruption('deck', 200, { activityGeneration: 'gen-corrupt' });
    expect(reset.resetReason).toBe('authority_corrupt_reinitialized');
    expect(reset.activityGeneration).toBe('gen-corrupt');
    expect(reset.queueEpoch).not.toBe(before.queueEpoch);
    expect(reset.queueAuthorityId).not.toBe(before.queueAuthorityId);
    expect(reset.pendingMessageEntries).toEqual([]);
  });

  it('delivery facts and following snapshots reflect only committed state', () => {
    store.enqueue({ sessionName: 'deck', clientMessageId: 'sent', text: 'sent text', now: 100 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'kept', text: 'kept text', now: 101 });

    const result = store.finalizeSentBatch('deck', ['sent'], 'frame-commit', 200);
    expect(result.deliveryFacts).toHaveLength(1);
    expect(result.deliveryFacts[0]?.pendingMessageVersion).toBe(result.snapshot.pendingMessageVersion);
    expect(result.deliveryFacts[0]?.deliveryFrameVersion).toBe(result.snapshot.pendingMessageVersion);
    expect(result.snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['kept']);
    expect(store.readSnapshot('deck').pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['kept']);
  });

  it('returns privacy-safe degraded diagnostics for busy mutations without speculative writes', () => {
    store.close();
    const dbPath = join(dir, 'busy.sqlite');
    store = new TransportQueueStore({ dbPath, busyTimeoutMs: 1 });
    store.enqueue({ sessionName: 'deck', clientMessageId: 'committed', text: 'already committed', now: 100 });

    const locker = new DatabaseSync(dbPath);
    try {
      locker.exec('PRAGMA busy_timeout = 1; BEGIN IMMEDIATE;');
      const result = store.mutateSafely('deck', 'busy_enqueue', () => store.enqueue({
        sessionName: 'deck',
        clientMessageId: 'speculative',
        text: 'must not appear',
        now: 200,
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic).toMatchObject({
          degraded: true,
          degradedReason: 'sqlite_busy_or_locked',
        });
        expect(result.snapshot.type).toBe('transport.queue.snapshot');
        if (result.snapshot.degraded) {
          expect(result.snapshot.degradedReason).toBe('sqlite_busy_or_locked');
        } else {
          expect(result.snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['committed']);
        }
        expect(JSON.stringify(result)).not.toContain('must not appear');
      }
    } finally {
      locker.exec('ROLLBACK;');
      locker.close();
    }

    const committed = store.readSnapshot('deck', 'after_busy');
    expect(committed.pendingMessageEntries.map((entry) => [entry.clientMessageId, entry.text])).toEqual([
      ['committed', 'already committed'],
    ]);
  });
});
