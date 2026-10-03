import { beforeEach, describe, expect, it } from 'vitest';

import { buildSubSessionSyncPayload } from '../../src/daemon/subsession-sync.js';
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
});
