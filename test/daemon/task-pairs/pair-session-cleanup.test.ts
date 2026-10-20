/**
 * A half-made pair session is discarded through the daemon's live server link, so the server and browsers hear `subsession.closed`
 * (and drop the row) instead of keeping a ghost until the next reconnect sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stop = vi.hoisted(() => vi.fn(async () => ({ ok: true, closed: [], failed: [] })));
vi.mock('../../../src/daemon/subsession-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/daemon/subsession-manager.js')>('../../../src/daemon/subsession-manager.js');
  return { ...actual, stopSubSession: stop };
});

import { createPairSubSession } from '../../../src/daemon/supervision-auto-provision.js';
import { getActiveServerLink, setActiveServerLink } from '../../../src/daemon/active-server-link.js';
import { resolveCreationConfig } from '../../../src/daemon/task-pairs/session-creation.js';
import { TASK_PAIR_CREATED_SESSION_REASONS } from '../../../shared/task-pair.js';
import type { SessionRecord } from '../../../src/store/session-store.js';

const BRAIN = 'deck_cleanup_brain';
const brain = { name: BRAIN, projectName: 'cleanupproj', role: 'brain', agentType: 'claude-code-sdk', projectDir: '/tmp/c', state: 'idle', sessionInstanceId: 'i', runtimeEpoch: 'e', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 } as SessionRecord;

describe('pair session cleanup goes through the server link', () => {
  const link = { send: vi.fn() };
  beforeEach(() => { stop.mockClear(); setActiveServerLink(link); });
  afterEach(() => setActiveServerLink(null));

  it('a launch failure stops the half-made session with the active server link (not without it)', async () => {
    const resolved = resolveCreationConfig(brain, undefined);
    if (!resolved.ok) throw new Error(resolved.error);
    const result = await createPairSubSession({
      parentSessionName: BRAIN, config: resolved.config, label: 'Pair t executor', idempotencyKey: 't:executor',
      metadata: { createdBy: BRAIN, pairTaskId: 't', role: 'executor', reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT },
    }, {
      getSession: (name) => (name === BRAIN ? brain : undefined),
      listSessions: () => [brain],
      startSubSession: async () => { throw new Error('boom'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'launch_failed' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect((stop.mock.calls[0] as unknown[])[1]).toBe(getActiveServerLink());
    expect((stop.mock.calls[0] as unknown[])[1]).toBe(link);
  });
});
