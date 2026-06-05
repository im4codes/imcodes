import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT,
  WORKER_SESSION_SNAPSHOT_VERSION,
  WORKER_SESSION_SYNC_STATUS,
} from '../../shared/worker-session-snapshot.js';

let tempDir: string;
const LIFECYCLE_SYNC_TEST_TIMEOUT_MS = 10_000;

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_existing_brain',
    projectName: 'existing',
    role: 'brain',
    agentType: 'claude-code',
    projectDir: '/tmp/existing-project',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'imcodes-sync-test-'));
  vi.stubEnv('HOME', tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('lifecycle worker session sync', () => {
  it('treats legacy list responses as degraded and does not destructively prune local sessions', async () => {
    const store = await import('../../src/store/session-store.js');
    await store.loadStore({ probe: false });
    store.upsertSession(makeSession({ name: 'deck_existing_brain' }));
    store.upsertSession(makeSession({
      name: 'deck_sub_child',
      projectName: 'child',
      role: 'w1',
      projectDir: '/tmp/existing-project/sub',
      parentSession: 'deck_existing_brain',
    }));

    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(`/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`)) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      if (url.endsWith('/sessions')) {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }
      if (url.endsWith('/sub-sessions')) {
        return new Response(JSON.stringify({ subSessions: [{ id: 'child', type: 'claude-code', cwd: '/tmp/existing-project/sub', parent_session: 'deck_existing_brain' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }));

    const { syncSessionsFromWorker } = await import('../../src/daemon/lifecycle.js');
    const outcome = await syncSessionsFromWorker('https://worker.example', 'server-1', 'token-1');

    expect(outcome).toMatchObject({
      ok: false,
      retryable: true,
      status: WORKER_SESSION_SYNC_STATUS.DEGRADED,
      skippedMainPrune: true,
    });
    expect(store.getSession('deck_existing_brain')).toBeDefined();
    expect(store.getSession('deck_sub_child')).toBeDefined();
  }, LIFECYCLE_SYNC_TEST_TIMEOUT_MS);

  it('does not drop local sessions missing from a complete snapshot without an explicit tombstone', async () => {
    const store = await import('../../src/store/session-store.js');
    await store.loadStore({ probe: false });
    store.upsertSession(makeSession({ name: 'deck_existing_brain' }));

    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(`/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`)) {
        return new Response(JSON.stringify({
          version: WORKER_SESSION_SNAPSHOT_VERSION,
          complete: true,
          serverId: 'server-1',
          generatedAt: 100,
          snapshotId: 'server-1:100',
          counts: { sessions: 1, subSessions: 0 },
          sessions: [{
            name: 'deck_other_brain',
            project_name: 'other',
            role: 'brain',
            agent_type: 'claude-code',
            project_dir: '/tmp/other-project',
            state: 'idle',
          }],
          subSessions: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }));

    const { syncSessionsFromWorker } = await import('../../src/daemon/lifecycle.js');
    const outcome = await syncSessionsFromWorker('https://worker.example', 'server-1', 'token-1');

    expect(outcome).toMatchObject({
      ok: true,
      status: WORKER_SESSION_SYNC_STATUS.APPLIED,
      prunedCount: 0,
      pendingMissingCount: 1,
    });
    expect(store.getSession('deck_existing_brain')).toBeDefined();
    expect(store.getSession('deck_other_brain')).toBeDefined();
  }, LIFECYCLE_SYNC_TEST_TIMEOUT_MS);

  it('treats remote stopped sessions as existing instead of deleting a local running session', async () => {
    const store = await import('../../src/store/session-store.js');
    await store.loadStore({ probe: false });
    store.upsertSession(makeSession({ name: 'deck_existing_brain', state: 'running' }));

    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(`/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`)) {
        return new Response(JSON.stringify({
          version: WORKER_SESSION_SNAPSHOT_VERSION,
          complete: true,
          serverId: 'server-1',
          generatedAt: 100,
          snapshotId: 'server-1:100',
          counts: { sessions: 1, subSessions: 0 },
          sessions: [{
            name: 'deck_existing_brain',
            project_name: 'existing',
            role: 'brain',
            agent_type: 'claude-code',
            project_dir: '/tmp/existing-project',
            state: 'stopped',
          }],
          subSessions: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }));

    const { syncSessionsFromWorker } = await import('../../src/daemon/lifecycle.js');
    const outcome = await syncSessionsFromWorker('https://worker.example', 'server-1', 'token-1');

    expect(outcome).toMatchObject({
      ok: true,
      status: WORKER_SESSION_SYNC_STATUS.APPLIED,
      pendingMissingCount: 0,
      syncedCount: 0,
    });
    expect(store.getSession('deck_existing_brain')?.state).toBe('running');
  }, LIFECYCLE_SYNC_TEST_TIMEOUT_MS);

  it('marks a bad complete snapshot as degraded before applying destructive side effects', async () => {
    const store = await import('../../src/store/session-store.js');
    await store.loadStore({ probe: false });
    store.upsertSession(makeSession({ name: 'deck_existing_brain' }));

    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(`/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`)) {
        return new Response(JSON.stringify({
          version: WORKER_SESSION_SNAPSHOT_VERSION,
          complete: true,
          serverId: 'server-1',
          generatedAt: 100,
          snapshotId: 'server-1:100',
          counts: { sessions: 1, subSessions: 0 },
          sessions: [{
            name: 'deck_bad_brain',
            project_name: 'bad',
            role: 'brain',
            agent_type: 'claude-code',
            project_dir: '/tmp/bad-project',
            state: 'idle',
            transport_config: '{not json',
          }],
          subSessions: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }));

    const { syncSessionsFromWorker } = await import('../../src/daemon/lifecycle.js');
    const outcome = await syncSessionsFromWorker('https://worker.example', 'server-1', 'token-1');

    expect(outcome).toMatchObject({
      ok: false,
      retryable: true,
      status: WORKER_SESSION_SYNC_STATUS.DEGRADED,
      syncedCount: 0,
    });
    expect(store.getSession('deck_existing_brain')).toBeDefined();
    expect(store.getSession('deck_bad_brain')).toBeUndefined();
  }, LIFECYCLE_SYNC_TEST_TIMEOUT_MS);
});
