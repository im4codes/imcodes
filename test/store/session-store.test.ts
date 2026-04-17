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
