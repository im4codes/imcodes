import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';

// We need to test with a temp path — patch the store path
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deck-test-'));
  vi.stubEnv('HOME', tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('session-store', () => {
  it('starts with empty store', async () => {
    const { listSessions } = await import('../../src/store/session-store.js');
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it('upsert and retrieve a session', async () => {
    const { upsertSession, getSession } = await import('../../src/store/session-store.js');
    upsertSession({
      name: 'deck_test_brain',
      project: 'test',
      role: 'brain',
      agentType: 'claude-code',
      state: 'idle',
      pid: 1234,
      startedAt: Date.now(),
    });
    const s = getSession('deck_test_brain');
    expect(s).not.toBeNull();
    expect(s?.project).toBe('test');
    expect(s?.role).toBe('brain');
  });

  it('update session state', async () => {
    const { upsertSession, updateSessionState, getSession } = await import('../../src/store/session-store.js');
    upsertSession({
      name: 'deck_p2_w1',
      project: 'p2',
      role: 'w1',
      agentType: 'codex',
      state: 'idle',
      pid: 5678,
      startedAt: Date.now(),
    });
    updateSessionState('deck_p2_w1', 'running');
    expect(getSession('deck_p2_w1')?.state).toBe('running');
  });

  it('remove session', async () => {
    const { upsertSession, removeSession, getSession } = await import('../../src/store/session-store.js');
    upsertSession({
      name: 'deck_del_brain',
      project: 'del',
      role: 'brain',
      agentType: 'claude-code',
      state: 'idle',
      pid: 9999,
      startedAt: Date.now(),
    });
    removeSession('deck_del_brain');
    expect(getSession('deck_del_brain')).toBeUndefined();
  });

  it('list returns all sessions', async () => {
    const { upsertSession, listSessions } = await import('../../src/store/session-store.js');
    upsertSession({ name: 's1', project: 'proj', role: 'brain', agentType: 'claude-code', state: 'idle', pid: 1, startedAt: 0 });
    upsertSession({ name: 's2', project: 'proj', role: 'w1', agentType: 'codex', state: 'running', pid: 2, startedAt: 0 });
    const sessions = listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.name === 's1')).toBe(true);
    expect(sessions.some((s) => s.name === 's2')).toBe(true);
  });

  describe('loadStore reconcile (runtimeType backfill + error recovery)', () => {
    async function writeSessionsFixture(content: object): Promise<void> {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dir = join(tempDir, '.imcodes');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'sessions.json'), JSON.stringify(content), 'utf8');
    }

    it('backfills runtimeType=transport for SDK sessions persisted before the field existed', async () => {
      // Mirror the on-disk shape we observed on the 211 deployment: brain
      // records persisted by an older daemon with no `runtimeType` field.
      // Without backfill, lifecycle health-poller treats them as tmux and
      // restartSession cycles them into state=error.
      await writeSessionsFixture({
        sessions: {
          deck_cc_brain: {
            name: 'deck_cc_brain', projectName: 'cc', role: 'brain',
            agentType: 'claude-code-sdk', projectDir: '/tmp/p1',
            state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
          },
          deck_codex_brain: {
            name: 'deck_codex_brain', projectName: 'cx', role: 'brain',
            agentType: 'codex-sdk', projectDir: '/tmp/p2',
            state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
          },
          deck_tmux_brain: {
            name: 'deck_tmux_brain', projectName: 'tm', role: 'brain',
            agentType: 'claude-code', projectDir: '/tmp/p3',
            state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
          },
        },
      });
      const { loadStore, getSession } = await import('../../src/store/session-store.js');
      await loadStore();
      expect(getSession('deck_cc_brain')?.runtimeType).toBe('transport');
      expect(getSession('deck_codex_brain')?.runtimeType).toBe('transport');
      expect(getSession('deck_tmux_brain')?.runtimeType).toBe('process');
    });

    it('preserves runtimeType when already set on disk', async () => {
      await writeSessionsFixture({
        sessions: {
          deck_explicit_brain: {
            name: 'deck_explicit_brain', projectName: 'x', role: 'brain',
            agentType: 'claude-code-sdk', projectDir: '/tmp/x',
            // Pretend an older buggy write left runtimeType: 'process' on a
            // transport agent. Reconcile MUST NOT overwrite an explicit value.
            runtimeType: 'process',
            state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
          },
        },
      });
      const { loadStore, getSession } = await import('../../src/store/session-store.js');
      await loadStore();
      expect(getSession('deck_explicit_brain')?.runtimeType).toBe('process');
    });

    it('auto-recovers state=error to stopped on daemon load (clears restart counter)', async () => {
      // Sessions stuck in error after a previous daemon's circuit breaker
      // tripped. On a fresh daemon process the rate window has long elapsed
      // and the underlying cause (e.g. tmux pane killed by daemon OOM) no
      // longer applies. Force-reset to give them a chance to restart instead
      // of requiring manual intervention via web UI.
      await writeSessionsFixture({
        sessions: {
          deck_stuck_brain: {
            name: 'deck_stuck_brain', projectName: 'stuck', role: 'brain',
            agentType: 'claude-code-sdk', projectDir: '/tmp/stuck',
            state: 'error',
            restarts: 3,
            restartTimestamps: [Date.now() - 1000, Date.now() - 500, Date.now() - 100],
            createdAt: 1, updatedAt: 1,
          },
        },
      });
      const { loadStore, getSession } = await import('../../src/store/session-store.js');
      await loadStore();
      const s = getSession('deck_stuck_brain');
      expect(s?.state).toBe('stopped');
      expect(s?.restarts).toBe(0);
      expect(s?.restartTimestamps).toEqual([]);
    });

    it('does not touch sessions in healthy states (idle / running / stopped)', async () => {
      await writeSessionsFixture({
        sessions: {
          a: { name: 'a', projectName: 'a', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/a', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
          b: { name: 'b', projectName: 'b', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/b', state: 'running', restarts: 1, restartTimestamps: [42], createdAt: 1, updatedAt: 1 },
          c: { name: 'c', projectName: 'c', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/c', state: 'stopped', restarts: 2, restartTimestamps: [10, 20], createdAt: 1, updatedAt: 1 },
        },
      });
      const { loadStore, getSession } = await import('../../src/store/session-store.js');
      await loadStore();
      expect(getSession('a')?.state).toBe('idle');
      expect(getSession('b')?.state).toBe('running');
      expect(getSession('b')?.restarts).toBe(1);
      expect(getSession('c')?.state).toBe('stopped');
      expect(getSession('c')?.restarts).toBe(2);
    });
  });

  it('does not persist known leaked e2e sessions to sessions.json', async () => {
    const { upsertSession, flushStore } = await import('../../src/store/session-store.js');
    upsertSession({
      name: 'deck_bootmainabc123_brain',
      projectName: 'bootmainabc123',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/bootmain-e2e',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });
    upsertSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/Users/me/cd',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });

    await flushStore();
    const raw = await readFile(join(tempDir, '.imcodes', 'sessions.json'), 'utf8');
    expect(raw).not.toContain('deck_bootmainabc123_brain');
    expect(raw).toContain('deck_cd_brain');
  });
});
