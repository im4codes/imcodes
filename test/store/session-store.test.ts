import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { vi } from 'vitest';

// This suite exercises the real persistence module. `vi.unmock` is hoisted by
// Vitest, so it clears any worker-inherited session-store mock BEFORE module
// resolution starts. A runtime-only `vi.doUnmock` was too late under Node 22's
// full-suite worker reuse and could yield another test's partial mock object.
vi.unmock('../../src/store/session-store.js');

// We need to test with a temp path — patch the store path
let tempDir: string;
const execFileAsync = promisify(execFile);

async function loadStoreInFreshProcess(sessionName: string): Promise<{
  sessionInstanceId?: string;
  runtimeEpoch?: string;
}> {
  const resultMarker = '__IMCODES_SESSION_STORE_RESULT__';
  const moduleUrl = new URL('../../src/store/session-store.ts', import.meta.url).href;
  const script = `
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const childHome = homedir();
    const childStorePath = join(childHome, '.imcodes', 'sessions.json');
    const readStoreSnapshot = () => {
      try {
        return { content: readFileSync(childStorePath, 'utf8') };
      } catch (error) {
        return { error: { code: error?.code, message: error?.message } };
      }
    };
    const beforeLoad = readStoreSnapshot();
    const store = await import(process.env.IMCODES_TEST_SESSION_STORE_MODULE_URL);
    await store.loadStore();
    await store.flushStore();
    console.log(${JSON.stringify(resultMarker)} + JSON.stringify({
      session: store.getSession(${JSON.stringify(sessionName)}) ?? null,
      diagnostics: {
        envHome: process.env.HOME,
        homedir: childHome,
        storePath: childStorePath,
        beforeLoad,
        afterFlush: readStoreSnapshot(),
      },
    }));
  `;
  let stdout = '';
  let stderr = '';
  let exit: string | number = 0;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempDir,
        IMCODES_TEST_SESSION_STORE_MODULE_URL: moduleUrl,
      },
    }));
  } catch (error) {
    const childError = error as {
      code?: string | number;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    stdout = childError.stdout ?? stdout;
    stderr = childError.stderr ?? stderr;
    exit = childError.code ?? childError.signal ?? 'unknown';
    const actualStore = await readFile(join(tempDir, '.imcodes', 'sessions.json'), 'utf8')
      .catch((readError: unknown) => `[unreadable: ${String(readError)}]`);
    throw new Error(
      `fresh session-store process failed; exit=${String(exit)}; stdout=${JSON.stringify(stdout)}; `
      + `stderr=${JSON.stringify(stderr)}; actual sessions.json=${JSON.stringify(actualStore)}`,
    );
  }
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(resultMarker));
  if (!resultLine) {
    const actualStore = await readFile(join(tempDir, '.imcodes', 'sessions.json'), 'utf8')
      .catch((error: unknown) => `[unreadable: ${String(error)}]`);
    throw new Error(
      `fresh session-store process did not emit its result; exit=${String(exit)}; stdout=${JSON.stringify(stdout)}; `
      + `stderr=${JSON.stringify(stderr)}; actual sessions.json=${JSON.stringify(actualStore)}`,
    );
  }
  const payload = JSON.parse(resultLine.slice(resultMarker.length)) as {
    session: {
      sessionInstanceId?: string;
      runtimeEpoch?: string;
    } | null;
    diagnostics: object;
  };
  if (!payload.session) {
    const actualStore = await readFile(join(tempDir, '.imcodes', 'sessions.json'), 'utf8')
      .catch((error: unknown) => `[unreadable: ${String(error)}]`);
    throw new Error(
      `fresh session-store process lost ${JSON.stringify(sessionName)}; exit=${String(exit)}; `
      + `stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}; `
      + `child=${JSON.stringify(payload.diagnostics)}; `
      + `actual sessions.json=${JSON.stringify(actualStore)}`,
    );
  }
  return payload.session as {
    sessionInstanceId?: string;
    runtimeEpoch?: string;
  };
}

async function importSessionStore() {
  // Full-suite workers can inherit partial session-store mocks from other test
  // files. `doUnmock` followed by a dynamic import is still order-sensitive in
  // Node 22 worker reuse: a concurrently registered mock can win before module
  // resolution and return only that mock's partial exports. `importActual`
  // bypasses the mock registry for this import by contract, while resetModules
  // below still gives each test a fresh real store instance.
  // Clear any runtime registration before every import as well as bypassing
  // the mock registry: some Vitest worker-reuse schedules can otherwise retain
  // a partial factory after resetModules() and hand it to importActual().
  vi.doUnmock('../../src/store/session-store.js');
  return vi.importActual<typeof import('../../src/store/session-store.js')>(
    '../../src/store/session-store.js',
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deck-test-'));
  vi.stubEnv('HOME', tempDir);
});

afterEach(() => {
  // A fresh-process persistence test can finish while the filesystem is still
  // settling its final sessions.json write. Let Node retry the recursive
  // removal if that brief race recreates an entry during directory traversal.
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.unstubAllEnvs();
  vi.doUnmock('../../src/store/session-store.js');
  vi.resetModules();
});

describe('session-store', () => {
  it('starts with empty store', async () => {
    const { listSessions } = await importSessionStore();
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it('upsert and retrieve a session', async () => {
    const { upsertSession, getSession } = await importSessionStore();
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
    const { upsertSession, updateSessionState, getSession } = await importSessionStore();
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

  it('persists error reason on error state and clears it on recovery', async () => {
    const { upsertSession, updateSessionState, getSession } = await importSessionStore();
    upsertSession({
      name: 'deck_error_reason_brain',
      projectName: 'p2',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });
    updateSessionState('deck_error_reason_brain', 'error', 'Restart loop detected: more than 3 restarts within 5 minutes');
    expect(getSession('deck_error_reason_brain')).toMatchObject({
      state: 'error',
      error: 'Restart loop detected: more than 3 restarts within 5 minutes',
    });

    updateSessionState('deck_error_reason_brain', 'idle');
    expect(getSession('deck_error_reason_brain')).toMatchObject({ state: 'idle' });
    expect(getSession('deck_error_reason_brain')?.error).toBeUndefined();
  });

  it('remove session', async () => {
    const { upsertSession, removeSession, getSession } = await importSessionStore();
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
    const { upsertSession, listSessions } = await importSessionStore();
    upsertSession({ name: 's1', project: 'proj', role: 'brain', agentType: 'claude-code', state: 'idle', pid: 1, startedAt: 0 });
    upsertSession({ name: 's2', project: 'proj', role: 'w1', agentType: 'codex', state: 'running', pid: 2, startedAt: 0 });
    const sessions = listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.name === 's1')).toBe(true);
    expect(sessions.some((s) => s.name === 's2')).toBe(true);
  });

  describe('loadStore reconcile (runtimeType backfill + error recovery)', () => {
    async function writeSessionsFixture(content: object, root = tempDir): Promise<void> {
      // Full-suite workers can be reused after files that register partial
      // `node:fs/promises` mocks. A normal dynamic import can inherit that
      // worker-local mock, turning this fixture write into a no-op while the
      // fresh child process below correctly uses the real filesystem. Bypass
      // Vitest's mock registry so the parent and child always observe the same
      // on-disk sessions.json.
      const { mkdir, writeFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const dir = join(root, '.imcodes');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'sessions.json'), JSON.stringify(content), 'utf8');
    }

    it('writes fixtures through the real filesystem when a worker-local fs mock is registered', async () => {
      vi.doMock('node:fs/promises', () => ({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      }));
      try {
        await writeSessionsFixture({ sessions: { persisted: { name: 'persisted' } } });
        const raw = await readFile(join(tempDir, '.imcodes', 'sessions.json'), 'utf8');
        expect(JSON.parse(raw)).toEqual({ sessions: { persisted: { name: 'persisted' } } });
      } finally {
        vi.doUnmock('node:fs/promises');
      }
    });

    it('reports child and disk evidence when a fresh process cannot find the requested session', async () => {
      await writeSessionsFixture({
        sessions: {
          deck_present_brain: {
            name: 'deck_present_brain', projectName: 'present', role: 'brain',
            agentType: 'codex-sdk', projectDir: '/tmp/present',
            state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
          },
        },
      });
      await expect(loadStoreInFreshProcess('deck_missing_brain')).rejects.toThrow(
        /lost "deck_missing_brain"; exit=0; stdout=.*stderr=.*child=.*actual sessions\.json=.*deck_present_brain/,
      );
    });

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
      const { loadStore, getSession } = await importSessionStore();
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
      const { loadStore, getSession } = await importSessionStore();
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
            error: 'Restart loop detected: more than 3 restarts within 5 minutes',
            restarts: 3,
            restartTimestamps: [Date.now() - 1000, Date.now() - 500, Date.now() - 100],
            createdAt: 1, updatedAt: 1,
          },
        },
      });
      const { loadStore, getSession } = await importSessionStore();
      await loadStore();
      const s = getSession('deck_stuck_brain');
      expect(s?.state).toBe('stopped');
      expect(s?.error).toBeUndefined();
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
      const { loadStore, getSession } = await importSessionStore();
      await loadStore();
      expect(getSession('a')?.state).toBe('idle');
      expect(getSession('b')?.state).toBe('running');
      expect(getSession('b')?.restarts).toBe(1);
      expect(getSession('c')?.state).toBe('stopped');
      expect(getSession('c')?.restarts).toBe(2);
    });

    it('keeps a delayed startup probe write bound to the store path it loaded', async () => {
      const firstHome = tempDir;
      const secondHome = mkdtempSync(join(tmpdir(), 'deck-test-next-'));
      let releaseDetection!: (state: 'idle' | 'running') => void;
      const detection = new Promise<'idle' | 'running'>((resolve) => {
        releaseDetection = resolve;
      });
      let observeEmit!: () => void;
      const emitted = new Promise<void>((resolve) => {
        observeEmit = resolve;
      });
      vi.doMock('../../src/agent/detect.js', () => ({
        detectStatusAsync: vi.fn(() => detection),
      }));
      vi.doMock('../../src/daemon/timeline-emitter.js', () => ({
        timelineEmitter: { emit: vi.fn(() => observeEmit()) },
      }));
      try {
        await writeSessionsFixture({
          sessions: {
            deck_probe_brain: {
              name: 'deck_probe_brain', projectName: 'probe', role: 'brain',
              agentType: 'claude-code', projectDir: '/tmp/probe',
              state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
            },
          },
        });
        const store = await importSessionStore();
        await store.loadStore();

        vi.stubEnv('HOME', secondHome);
        await writeSessionsFixture({
          sessions: {
            deck_next_brain: {
              name: 'deck_next_brain', projectName: 'next', role: 'brain',
              agentType: 'claude-code', projectDir: '/tmp/next',
              state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 2, updatedAt: 2,
            },
          },
        }, secondHome);

        releaseDetection('idle');
        await emitted;
        await store.flushStore();

        const secondStore = JSON.parse(
          await readFile(join(secondHome, '.imcodes', 'sessions.json'), 'utf8'),
        ) as { sessions: Record<string, unknown> };
        expect(Object.keys(secondStore.sessions)).toEqual(['deck_next_brain']);
        const firstStore = JSON.parse(
          await readFile(join(firstHome, '.imcodes', 'sessions.json'), 'utf8'),
        ) as { sessions: Record<string, { state?: string }> };
        expect(firstStore.sessions.deck_probe_brain?.state).toBe('idle');
      } finally {
        vi.doUnmock('../../src/agent/detect.js');
        vi.doUnmock('../../src/daemon/timeline-emitter.js');
        vi.stubEnv('HOME', firstHome);
        rmSync(secondHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    });

    it('migrates missing identities once and preserves them across daemon reload', async () => {
      await writeSessionsFixture({
        sessions: {
          deck_legacy_brain: {
            name: 'deck_legacy_brain', projectName: 'legacy', role: 'brain',
            agentType: 'codex-sdk', projectDir: '/tmp/legacy',
            state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
          },
        },
      });

      // A daemon reload is a process boundary. Exercise it with two actual
      // Node processes so this persistence assertion cannot inherit Vitest's
      // worker-level session-store mocks or module cache.
      const first = await loadStoreInFreshProcess('deck_legacy_brain');
      expect(first?.sessionInstanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first?.runtimeEpoch).toMatch(/^[0-9a-f-]{36}$/);
      const reloaded = await loadStoreInFreshProcess('deck_legacy_brain');
      expect(reloaded).toMatchObject({
        sessionInstanceId: first?.sessionInstanceId,
        runtimeEpoch: first?.runtimeEpoch,
      });
    });
  });

  it('preserves logical identity on updates and changes it after true delete/recreate', async () => {
    const { upsertSession, removeSession, getSession } = await importSessionStore();
    const base = {
      name: 'deck_identity_brain', projectName: 'identity', projectDir: '/tmp/identity',
      role: 'brain' as const, agentType: 'codex-sdk', state: 'idle' as const,
      restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    };
    upsertSession(base);
    const firstId = getSession(base.name)?.sessionInstanceId;

    upsertSession({ ...base, activeModel: 'gpt-5', state: 'running' });
    expect(getSession(base.name)?.sessionInstanceId).toBe(firstId);

    removeSession(base.name);
    upsertSession({ ...base, sessionInstanceId: firstId });
    expect(getSession(base.name)?.sessionInstanceId).not.toBe(firstId);
  });

  it('rotates runtimeEpoch only when runtime authority is replaced', async () => {
    const { upsertSession, getSession } = await importSessionStore();
    const base = {
      name: 'deck_runtime_brain', projectName: 'runtime', projectDir: '/tmp/runtime',
      role: 'brain' as const, agentType: 'codex-sdk', runtimeType: 'transport' as const,
      providerSessionId: 'provider-1', state: 'idle' as const,
      restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    };
    upsertSession(base);
    const firstEpoch = getSession(base.name)?.runtimeEpoch;

    upsertSession({ ...getSession(base.name)!, activeModel: 'gpt-5', state: 'running' });
    expect(getSession(base.name)?.runtimeEpoch).toBe(firstEpoch);

    upsertSession({ ...getSession(base.name)!, providerSessionId: 'provider-2', state: 'idle' });
    const replacedEpoch = getSession(base.name)?.runtimeEpoch;
    expect(replacedEpoch).not.toBe(firstEpoch);

    upsertSession({ ...getSession(base.name)!, state: 'running' });
    expect(getSession(base.name)?.runtimeEpoch).toBe(replacedEpoch);
  });

  it('does not persist known leaked e2e sessions to sessions.json', async () => {
    const { upsertSession, flushStore } = await importSessionStore();
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
