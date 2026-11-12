import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSubSessionSyncPayload } from '../../src/daemon/subsession-sync.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import type { ServerLink } from '../../src/daemon/server-link.js';
import { SUBSESSION_SYNC_BATCH_MAX_ITEMS, SUBSESSION_SYNC_BATCH_MSG } from '../../shared/scale-limits.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { recipientFromSessionRecord } from '../../src/daemon/transport-resend-queue.js';
import {
  clearSupervisionHeartbeatProjectionsForTests,
  setSupervisionHeartbeatProjection,
} from '../../src/daemon/supervision-heartbeat-projection.js';
import { getSession, listSessions, removeSession, upsertSession } from '../../src/store/session-store.js';

describe('subsession-sync transport queue projection', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    clearSupervisionHeartbeatProjectionsForTests();
    for (const session of listSessions()) removeSession(session.name);
  });

  it('emits committed SQLite queue snapshot fields instead of legacy queue options', async () => {
    upsertSession({
      name: 'deck_sub_queue',
      projectName: 'demo',
      role: 'w1',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'provider-sub',
      parentSession: 'deck_demo_brain',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const committed = getTransportQueueStore().enqueue({
      sessionName: 'deck_sub_queue',
      clientMessageId: 'sqlite-msg',
      commandId: 'sqlite-cmd',
      text: 'from sqlite authority',
      now: Date.now(),
      recipient: recipientFromSessionRecord(getSession('deck_sub_queue')),
    });

    const payload = await buildSubSessionSyncPayload('queue', undefined, {
      transportQueue: {
        pendingMessages: ['legacy text'],
        pendingEntries: [{ clientMessageId: 'legacy-msg', text: 'legacy text' }],
        pendingVersion: 99,
      },
    });

    expect(payload).toEqual(expect.objectContaining({
      type: 'subsession.sync',
      id: 'queue',
      queueEpoch: committed.queueEpoch,
      queueAuthorityId: committed.queueAuthorityId,
      pendingMessageVersion: committed.pendingMessageVersion,
      pendingMessageEntries: [
        expect.objectContaining({ clientMessageId: 'sqlite-msg', text: 'from sqlite authority' }),
      ],
      failedMessageEntries: [],
      queueSnapshot: expect.objectContaining({
        type: 'transport.queue.snapshot',
        source: 'subsession_sync',
        pendingMessageVersion: committed.pendingMessageVersion,
      }),
    }));
    expect(payload?.transportPendingMessages).toBeUndefined();
    expect(payload?.transportPendingMessageEntries).toBeUndefined();
    expect(payload?.pendingCount).toBe(1);
  });

  it('replays the current heartbeat schedule with a fresh daemon timestamp', async () => {
    upsertSession({
      name: 'deck_sub_countdown', projectName: 'demo', role: 'w1', agentType: 'codex-sdk',
      runtimeType: 'transport', providerId: 'codex-sdk', providerSessionId: 'provider-sub',
      parentSession: 'deck_demo_brain', state: 'idle', restarts: 0, restartTimestamps: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    setSupervisionHeartbeatProjection('deck_sub_countdown', {
      state: 'armed', kind: 'implementation', nextHeartbeatAt: 20_000, updatedAt: 1_000,
    });
    const before = Date.now();
    const payload = await buildSubSessionSyncPayload('countdown');
    expect(payload?.supervisionHeartbeat).toMatchObject({
      state: 'armed', kind: 'implementation', nextHeartbeatAt: 20_000,
      updatedAt: expect.any(Number),
    });
    expect((payload?.supervisionHeartbeat as { updatedAt: number }).updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('hydrates quotaLabel and quotaMeta for grok-sdk sub-sessions', async () => {
    upsertSession({
      name: 'deck_sub_groktest',
      projectName: 'demo',
      role: 'w1',
      agentType: 'grok-sdk',
      runtimeType: 'transport',
      providerId: 'grok-sdk',
      providerSessionId: 'provider-sub-grok',
      parentSession: 'deck_demo_brain',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      quotaLabel: '31d 0% 18d16h',
      quotaMeta: {
        primary: { windowDurationMins: 44640, usedPercent: 0, resetsAt: 1730000000 },
      },
    });

    const payload = await buildSubSessionSyncPayload('groktest');
    expect(payload?.sessionType).toBe('grok-sdk');
    expect(payload?.quotaLabel).toBe('31d 0% 18d16h');
    expect(payload?.quotaMeta).toEqual({
      primary: { windowDurationMins: 44640, usedPercent: 0, resetsAt: 1730000000 },
    });
  });

  it('batches handleWebCommand subsession.rebuild_all when supportsSyncBatch is true and falls back cleanly when omitted', async () => {
    const subs = Array.from({ length: SUBSESSION_SYNC_BATCH_MAX_ITEMS + 12 }, (_, i) => ({
      id: `batch_sub_${i}`,
      type: 'qwen',
      runtimeType: 'transport' as const,
      providerId: 'qwen',
      providerSessionId: `prov-${i}`,
      cwd: '/tmp/batch-demo',
      label: `worker-${i}`,
      parentSession: 'deck_demo_brain',
    }));

    const batchFrames: Array<Record<string, unknown>> = [];
    handleWebCommand(
      { type: 'subsession.rebuild_all', subSessions: subs, supportsSyncBatch: true },
      { send: (m: Record<string, unknown>) => batchFrames.push(m) } as unknown as ServerLink,
    );
    await vi.waitFor(() => {
      const total = batchFrames
        .filter((f) => f.type === SUBSESSION_SYNC_BATCH_MSG)
        .reduce((n, f) => n + ((f.items as unknown[])?.length ?? 0), 0);
      expect(total).toBe(subs.length);
    });
    const batchOnly = batchFrames.filter((f) => f.type === SUBSESSION_SYNC_BATCH_MSG);
    expect(batchOnly).toHaveLength(2);
    expect((batchOnly[0]!.items as unknown[]).length).toBe(SUBSESSION_SYNC_BATCH_MAX_ITEMS);
    expect((batchOnly[1]!.items as unknown[]).length).toBe(12);

    // Legacy servers that omit supportsSyncBatch must continue receiving individual `subsession.sync` frames.
    const legacyFrames: Array<Record<string, unknown>> = [];
    const legacySubs = subs.slice(0, 4);
    handleWebCommand(
      { type: 'subsession.rebuild_all', subSessions: legacySubs },
      { send: (m: Record<string, unknown>) => legacyFrames.push(m) } as unknown as ServerLink,
    );
    await vi.waitFor(() => {
      expect(legacyFrames.filter((f) => f.type === 'subsession.sync')).toHaveLength(4);
    });
    expect(legacyFrames.some((f) => f.type === SUBSESSION_SYNC_BATCH_MSG)).toBe(false);
  });
});
