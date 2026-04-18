/**
 * E2E test: daemon-level restart resilience.
 * Verifies that sessions survive daemon restarts, the session store persists
 * correctly, pipe-pane streaming recovers after pane respawn, and concurrent
 * sessions are fully restored — without crashing.
 *
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import {
  newSession,
  killSession,
  sessionExists,
  capturePane,
  sendKeys,
  isPaneAlive,
  respawnPane,
  listSessions,
  getPaneId,
  startPipePaneStream,
  stopPipePaneStream,
  checkPipePaneCapability,
} from '../../src/agent/tmux.js';
import {
  loadStore,
  flushStore,
  upsertSession,
  getSession,
  removeSession,
  listSessions as storeSessions,
} from '../../src/store/session-store.js';
import { restoreFromStore, respawnSession } from '../../src/agent/session-manager.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE;
const FIXTURES = new URL('../fixtures', import.meta.url).pathname;

// Unique prefix per run to avoid collisions with other tests
const RUN_ID = Math.random().toString(36).slice(2, 8);
const PREFIX = `deck_storecheck${RUN_ID}`;

function sessionName(role: string): string {
  return `${PREFIX}_${role}`;
}

function makeRecord(role: string, overrides: Partial<import('../../src/store/session-store.js').SessionRecord> = {}): import('../../src/store/session-store.js').SessionRecord {
  return {
    name: sessionName(role),
    projectName: `storecheck${RUN_ID}`,
    role: role as 'brain' | `w${number}`,
    agentType: 'shell',
    projectDir: tmpdir(),
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Wait helper */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collect pipe-pane stream data for `ms` milliseconds. */
async function collectStream(stream: NodeJS.ReadableStream, ms: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  });
  await wait(ms);
  return Buffer.concat(chunks);
}

describe.skipIf(SKIP)('Daemon reconnect resilience (e2e)', () => {
  const createdSessions: string[] = [];

  beforeAll(async () => {
    // Isolate HOME so we don't touch the real session store
    const testHome = join(tmpdir(), `imcodes-test-${RUN_ID}`);
    mkdirSync(testHome, { recursive: true });
    process.env.HOME = testHome;
    await loadStore();
  });

  afterEach(async () => {
    // Clean up all sessions created during the test
    for (const name of createdSessions) {
      await stopPipePaneStream(name).catch(() => {});
      await killSession(name).catch(() => {});
      removeSession(name);
    }
    createdSessions.length = 0;
  });

  afterAll(async () => {
    // Belt-and-suspenders cleanup — kill any leftover sessions matching our prefix
    const live = await listSessions();
    for (const name of live) {
      if (name.startsWith(PREFIX)) {
        await killSession(name).catch(() => {});
      }
    }
  });

  // ── 1. Session survives daemon restart (store→kill→restore) ──────────────

  it('session survives daemon restart via store persistence + restoreFromStore', async () => {
    const name = sessionName('brain');
    createdSessions.push(name);

    // Launch a real tmux session with mock-agent
    await newSession(name, `bash ${FIXTURES}/mock-agent.sh shell`, { cwd: tmpdir() });
    await wait(500);
    expect(await sessionExists(name)).toBe(true);

    // Persist to store
    upsertSession(makeRecord('brain'));

    // Send some data to confirm the session works
    await sendKeys(name, 'echo SESSION_ALIVE');
    await wait(500);
    const output = await capturePane(name);
    expect(output.join('\n')).toContain('SESSION_ALIVE');

    // Simulate daemon restart: session still exists in tmux, store has it.
    // restoreFromStore should detect it as live and NOT recreate it.
    await restoreFromStore();

    // Session should still be there with the same pane
    expect(await sessionExists(name)).toBe(true);
    expect(await isPaneAlive(name)).toBe(true);
  }, 45_000);

  // ── 2. Dead pane is detected and session marked on restore ───────────────

  it('dead session is detected on restoreFromStore (no crash)', async () => {
    const name = sessionName('w1');
    createdSessions.push(name);

    // Create a session, persist it, then kill it so the store has a record
    // but the tmux session is gone — simulating a crash while daemon was down.
    await newSession(name, 'bash', { cwd: tmpdir() });
    upsertSession(makeRecord('w1', { agentType: 'shell' }));
    await wait(300);
    await killSession(name);
    await wait(200);

    // restoreFromStore handles missing/dead sessions without crashing
    // The key assertion: this does NOT throw
    await expect(restoreFromStore()).resolves.not.toThrow();
  });

  // ── 3. Session store persists across daemon restart ──────────────────────

  it('session store persists and reloads correctly', async () => {
    const name = sessionName('w2');
    createdSessions.push(name);

    const record = makeRecord('w2', { state: 'idle' });
    upsertSession(record);

    // Verify it's in the store
    const stored = getSession(name);
    expect(stored).toBeDefined();
    expect(stored!.role).toBe('w2');
    expect(stored!.state).toBe('idle');

    // Force flush (not timing-dependent) and reload to simulate daemon restart
    await flushStore();
    await loadStore();

    const reloaded = getSession(name);
    expect(reloaded).toBeDefined();
    expect(reloaded!.name).toBe(name);
    expect(reloaded!.role).toBe('w2');
  });

  // ── 4. Pipe-pane stream recovers after pane respawn ──────────────────────

  it('pipe-pane stream recovers after pane death and respawn', async () => {
    const capable = await checkPipePaneCapability();
    if (!capable) return; // skip if tmux too old

    const name = sessionName('brain');
    createdSessions.push(name);

    // Create session
    await newSession(name, 'bash', { cwd: tmpdir() });
    await wait(300);

    // Start pipe-pane stream
    const paneId1 = await getPaneId(name);
    const { stream: stream1, cleanup: cleanup1 } = await startPipePaneStream(name, paneId1);

    // Verify stream works
    const collectPromise1 = collectStream(stream1, 1500);
    await wait(200);
    await sendKeys(name, 'echo BEFORE_RESPAWN');
    const before = (await collectPromise1).toString();
    expect(before).toContain('BEFORE_RESPAWN');
    await cleanup1();

    // Kill the pane process (simulate crash) and respawn
    await stopPipePaneStream(name).catch(() => {});
    await respawnPane(name, 'bash');
    await wait(500);
    expect(await isPaneAlive(name)).toBe(true);

    // Re-establish pipe-pane stream on the respawned pane
    const paneId2 = await getPaneId(name);
    const { stream: stream2, cleanup: cleanup2 } = await startPipePaneStream(name, paneId2);

    const collectPromise2 = collectStream(stream2, 1500);
    await wait(200);
    await sendKeys(name, 'echo AFTER_RESPAWN');
    const after = (await collectPromise2).toString();
    expect(after).toContain('AFTER_RESPAWN');
    await cleanup2();
  }, 15_000);

  // ── 5. Concurrent sessions survive restart ───────────────────────────────

  it('multiple concurrent sessions all survive daemon restart', async () => {
    const roles = ['brain', 'w1', 'w2'] as const;
    const names = roles.map((r) => sessionName(r));
    createdSessions.push(...names);

    // Launch all sessions in parallel
    await Promise.all(
      roles.map((role) =>
        newSession(sessionName(role), `bash ${FIXTURES}/mock-agent.sh shell`, { cwd: tmpdir() }),
      ),
    );
    await wait(500);

    // Persist all to store
    for (const role of roles) {
      upsertSession(makeRecord(role));
    }

    // Verify all are alive
    for (const name of names) {
      expect(await sessionExists(name)).toBe(true);
      expect(await isPaneAlive(name)).toBe(true);
    }

    // Simulate daemon restart — restoreFromStore should detect all as live
    await restoreFromStore();

    // All sessions still alive
    for (const name of names) {
      expect(await sessionExists(name)).toBe(true);
    }

    // Verify each session is independently functional
    for (let i = 0; i < names.length; i++) {
      const marker = `CONCURRENT_${i}_${RUN_ID}`;
      await sendKeys(names[i], `echo ${marker}`);
    }
    await wait(1000);

    for (let i = 0; i < names.length; i++) {
      const marker = `CONCURRENT_${i}_${RUN_ID}`;
      const output = await capturePane(names[i]);
      expect(output.join('\n')).toContain(marker);
    }
  });

  // ── 6. Restart loop prevention caps at 3 ─────────────────────────────────

  it('respawnSession prevents restart loop after 3 restarts in 5 minutes', async () => {
    const name = sessionName('w3');
    createdSessions.push(name);

    // Create session with remain-on-exit so respawnPane works
    await newSession(name, 'bash -c "sleep 999"', { cwd: tmpdir() });
    await wait(300);

    const now = Date.now();
    const record = makeRecord('w3', {
      restarts: 3,
      restartTimestamps: [now - 60_000, now - 120_000, now - 180_000],
    });
    upsertSession(record);

    const stored = getSession(name);
    expect(stored).toBeDefined();

    // respawnSession should detect the loop and return false
    const result = await respawnSession(stored!);
    expect(result).toBe(false);

    // Verify session is marked as error
    const updated = getSession(name);
    expect(updated!.state).toBe('error');
  });

  // ── 7. Rapid session create/kill does not crash ──────────────────────────

  it('rapid session create/kill cycles do not crash or leak', async () => {
    const name = sessionName('rapid');
    createdSessions.push(name);

    for (let i = 0; i < 5; i++) {
      await newSession(name, 'bash', { cwd: tmpdir() });
      await wait(100);
      expect(await sessionExists(name)).toBe(true);
      await killSession(name);
      await wait(100);
      expect(await sessionExists(name)).toBe(false);
    }

    // Verify no orphan sessions with our prefix leaked
    const live = await listSessions();
    const orphans = live.filter((s) => s === name);
    expect(orphans).toHaveLength(0);
  });

  // ── 8. Store handles concurrent upsert/remove without crash ──────────────

  it('session store handles rapid upsert/remove without corruption', async () => {
    const names: string[] = [];
    for (let i = 0; i < 10; i++) {
      const role = `w${i + 10}` as `w${number}`;
      const name = sessionName(role);
      names.push(name);
      createdSessions.push(name);
      upsertSession(makeRecord(role));
    }

    // All 10 should be in store
    for (const name of names) {
      expect(getSession(name)).toBeDefined();
    }

    // Remove odd-indexed ones
    for (let i = 0; i < names.length; i++) {
      if (i % 2 === 1) removeSession(names[i]);
    }

    // Verify even ones remain, odd ones gone
    for (let i = 0; i < names.length; i++) {
      if (i % 2 === 0) {
        expect(getSession(names[i])).toBeDefined();
      } else {
        expect(getSession(names[i])).toBeUndefined();
      }
    }

    // Flush and reload
    await wait(600);
    await loadStore();

    for (let i = 0; i < names.length; i++) {
      if (i % 2 === 0) {
        expect(getSession(names[i])).toBeDefined();
      } else {
        expect(getSession(names[i])).toBeUndefined();
      }
    }
  });
});
