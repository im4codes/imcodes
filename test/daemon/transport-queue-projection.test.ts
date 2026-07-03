import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLegacyTransportPendingQueueSnapshot, buildTransportQueueSnapshot } from '../../src/daemon/transport-queue-projection.js';
import { buildTransportPendingQueueSnapshot } from '../../src/daemon/transport-pending-snapshot.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imcodes-transport-queue-projection-'));
  dbPath = join(dir, 'queue.sqlite');
  vi.stubEnv('IMCODES_TRANSPORT_QUEUE_DB_PATH', dbPath);
  resetTransportQueueStoreForTests();
});

afterEach(() => {
  resetTransportQueueStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('transport queue projection builder', () => {
  it('builds SQLite-backed queue snapshots and legacy wrappers from one source', async () => {
    const { getTransportQueueStore } = await import('../../src/daemon/transport-queue-store.js');
    getTransportQueueStore().enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-1',
      text: 'queued\nwith newline',
      now: 100,
    });
    getTransportQueueStore().enqueue({
      sessionName: 'deck',
      clientMessageId: 'msg-2',
      text: 'failed',
      now: 200,
    });
    getTransportQueueStore().markFailed('deck', 'msg-2', 'dispatch_failed', 300);

    const snapshot = buildTransportQueueSnapshot('deck', 'test');
    expect(snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-1']);
    expect(snapshot.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-2']);
    expect(snapshot.pendingMessageEntries[0]?.text).toBe('queued\nwith newline');

    const legacy = buildLegacyTransportPendingQueueSnapshot('deck', 'test');
    expect(legacy.pendingMessages).toEqual(['queued\nwith newline']);
    expect(legacy.failedEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-2']);
    expect(legacy.queueEpoch).toBe(snapshot.queueEpoch);
    expect(legacy.queueAuthorityId).toBe(snapshot.queueAuthorityId);
  });

  it('returns an empty committed SQLite baseline instead of synthesizing runtime fallback', () => {
    const legacy = buildLegacyTransportPendingQueueSnapshot('deck-empty', 'test');
    expect(legacy.pendingMessages).toEqual([]);
    expect(legacy.pendingEntries).toEqual([]);
    expect(legacy.pendingVersion).toBe(0);
    expect(legacy.queueEpoch).toEqual(expect.any(String));
    expect(legacy.queueAuthorityId).toEqual(expect.any(String));
  });

  it('does not use runtime, JSON, or JSONL replay pending arrays as queue authority', () => {
    const snapshot = buildTransportPendingQueueSnapshot('deck-runtime-only', {
      pendingMessages: ['runtime stale\ntext'],
      pendingEntries: [{ clientMessageId: 'runtime-stale', text: 'runtime stale\ntext' } as any],
      pendingVersion: 99,
    });

    expect(snapshot.source).toBe('sqlite');
    expect(snapshot.pendingMessages).toEqual([]);
    expect(snapshot.pendingEntries).toEqual([]);
    expect(snapshot.pendingVersion).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('runtime stale');
  });

  it('projects SQLite rows, failed entries, and diagnostics through privacy allowlists', async () => {
    const { getTransportQueueStore } = await import('../../src/daemon/transport-queue-store.js');
    getTransportQueueStore().enqueue({
      sessionName: 'deck-private',
      clientMessageId: 'msg-private',
      text: 'safe text',
      privateMaterialJson: JSON.stringify({
        messagePreamble: 'SECRET_PREAMBLE',
        attachmentRefs: [{ daemonPath: '/tmp/raw-local-attachment' }],
        sharedActorEnvelope: { token: 'SECRET_ACTOR_TOKEN' },
        timelineCommitted: true,
        historyCommitted: true,
      }),
      now: 100,
    });
    getTransportQueueStore().enqueue({
      sessionName: 'deck-private',
      clientMessageId: 'msg-failed',
      text: 'failed safe text',
      privateMaterialJson: JSON.stringify({
        rawProviderPayload: 'SECRET_PROVIDER_PAYLOAD',
        toolInput: 'SECRET_TOOL_INPUT',
        toolOutput: 'SECRET_TOOL_OUTPUT',
        env: { API_KEY: 'SECRET_ENV' },
      }),
      now: 101,
    });
    getTransportQueueStore().markFailed('deck-private', 'msg-failed', 'dispatch_failed', 200);

    const snapshot = buildTransportQueueSnapshot('deck-private', 'test');
    expect(snapshot.pendingMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-private']);
    expect(snapshot.failedMessageEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-failed']);
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of [
      'SECRET_PREAMBLE',
      '/tmp/raw-local-attachment',
      'SECRET_ACTOR_TOKEN',
      'SECRET_PROVIDER_PAYLOAD',
      'SECRET_TOOL_INPUT',
      'SECRET_TOOL_OUTPUT',
      'SECRET_ENV',
      'timelineCommitted',
      'historyCommitted',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('emits degraded non-authoritative projection instead of speculative snapshots when SQLite reads fail', async () => {
    const { getTransportQueueStore } = await import('../../src/daemon/transport-queue-store.js');
    getTransportQueueStore().close();

    const snapshot = buildTransportQueueSnapshot('deck-degraded', 'test');

    expect(snapshot).toMatchObject({
      sessionName: 'deck-degraded',
      queueEpoch: 'unavailable',
      queueAuthorityId: 'unavailable',
      pendingMessageVersion: 0,
      pendingMessageEntries: [],
      failedMessageEntries: [],
      degraded: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('queued text');
  });
});
