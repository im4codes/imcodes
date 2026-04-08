/**
 * E2E for daemon-owned main-session shutdown.
 *
 * Uses:
 * - real tmux sessions
 * - real session store
 * - real stopProject()/restoreFromStore() flow
 *
 * Verifies:
 * - project stop closes the full session tree
 * - the daemon process remains usable after shutdown
 * - descendants are not resurrected after store reload + restore
 *
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { newSession, killSession, sessionExists, capturePane, listSessions } from '../../src/agent/tmux.js';
import { loadStore, flushStore, upsertSession, getSession, removeSession, listSessions as storeSessions } from '../../src/store/session-store.js';
import { stopProject, restoreFromStore } from '../../src/agent/session-manager.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT = `shutdown${RUN_ID}`;
const MAIN_SESSION = `deck_${PROJECT}_brain`;
const WORKER_SESSION = `deck_${PROJECT}_w1`;
const SUB_ROOT = `deck_sub_${RUN_ID}root`;
const SUB_CHILD = `deck_sub_${RUN_ID}child`;
const PROBE_SESSION = `deck_${PROJECT}_probe`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRecord(
  name: string,
  role: 'brain' | `w${number}`,
  overrides: Partial<import('../../src/store/session-store.js').SessionRecord> = {},
): import('../../src/store/session-store.js').SessionRecord {
  return {
    name,
    projectName: PROJECT,
    role,
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

async function createSleepSession(name: string): Promise<void> {
  await killSession(name).catch(() => {});
  await newSession(name, 'bash -lc "trap : TERM INT; sleep 999"', { cwd: tmpdir() });
  await wait(250);
  expect(await sessionExists(name)).toBe(true);
}

describe.skipIf(SKIP)('main-session shutdown e2e', () => {
  beforeAll(async () => {
    const testHome = join(tmpdir(), `imcodes-shutdown-${RUN_ID}`);
    mkdirSync(testHome, { recursive: true });
    process.env.HOME = testHome;
    await loadStore();
  });

  afterEach(async () => {
    for (const name of [MAIN_SESSION, WORKER_SESSION, SUB_ROOT, SUB_CHILD, PROBE_SESSION]) {
      await killSession(name).catch(() => {});
      removeSession(name);
    }
  });

  afterAll(async () => {
    const live = await listSessions();
    for (const name of live) {
      if (name === MAIN_SESSION || name === WORKER_SESSION || name === SUB_ROOT || name === SUB_CHILD || name === PROBE_SESSION) {
        await killSession(name).catch(() => {});
      }
    }
  });

  it('closes the full tree, remains usable, and does not resurrect descendants after restore', async () => {
    await createSleepSession(MAIN_SESSION);
    await createSleepSession(WORKER_SESSION);
    await createSleepSession(SUB_ROOT);
    await createSleepSession(SUB_CHILD);

    upsertSession(makeRecord(MAIN_SESSION, 'brain'));
    upsertSession(makeRecord(WORKER_SESSION, 'w1'));
    upsertSession(makeRecord(SUB_ROOT, 'w1', {
      projectName: SUB_ROOT,
      parentSession: WORKER_SESSION,
    }));
    upsertSession(makeRecord(SUB_CHILD, 'w1', {
      projectName: SUB_CHILD,
      parentSession: SUB_ROOT,
    }));

    const serverLink = { send: () => {} };
    const result = await stopProject(PROJECT, serverLink);

    expect(result).toEqual({
      ok: true,
      closed: [SUB_CHILD, SUB_ROOT, MAIN_SESSION, WORKER_SESSION],
      failed: [],
    });
    expect(await sessionExists(MAIN_SESSION)).toBe(false);
    expect(await sessionExists(WORKER_SESSION)).toBe(false);
    expect(await sessionExists(SUB_ROOT)).toBe(false);
    expect(await sessionExists(SUB_CHILD)).toBe(false);
    expect(getSession(MAIN_SESSION)).toBeUndefined();
    expect(getSession(SUB_ROOT)).toBeUndefined();
    expect(storeSessions().filter((session) => session.name.startsWith(`deck_sub_${RUN_ID}`))).toHaveLength(0);

    await killSession(PROBE_SESSION).catch(() => {});
    await newSession(PROBE_SESSION, 'bash -lc "echo PROBE_ALIVE; trap : TERM INT; sleep 999"', { cwd: tmpdir() });
    await wait(250);
    expect(await sessionExists(PROBE_SESSION)).toBe(true);
    const probePane = (await capturePane(PROBE_SESSION)).join('\n');
    expect(probePane).toContain('PROBE_ALIVE');

    await flushStore();
    await loadStore();
    await restoreFromStore();

    expect(getSession(SUB_ROOT)).toBeUndefined();
    expect(getSession(SUB_CHILD)).toBeUndefined();
    expect(storeSessions().filter((session) => session.name === SUB_ROOT || session.name === SUB_CHILD)).toHaveLength(0);
    expect(await sessionExists(SUB_ROOT)).toBe(false);
    expect(await sessionExists(SUB_CHILD)).toBe(false);
  }, 30_000);
});
