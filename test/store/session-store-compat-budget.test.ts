/**
 * The sessions.json compatibility export is write-only for older builds. Past its size budget the main thread is
 * worth more than a fresher copy of that file: the export is skipped (the file is left as it was) and says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../shared/session-store-compat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/session-store-compat.js')>()),
  SESSIONS_JSON_COMPAT_EXPORT_MAX_BYTES: 30_000,
}));

import {
  configureSessionStoreWriteAuthority, flushStore, loadStore, resetSessionStoreAuthorityForTests,
  upsertSession, waitForCompatExportForTests, waitForSessionStoreSnapshotForTests, type SessionRecord,
} from '../../src/store/session-store.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import logger from '../../src/util/logger.js';

let home = '';
let dir = '';
const record = (name: string, extra: Record<string, unknown> = {}) => ({
  name, projectName: 'p', role: 'w1', agentType: 'codex-sdk', projectDir: '/tmp/p', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
}) as SessionRecord;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-store-budget-'));
  dir = join(home, '.imcodes');
  await mkdir(dir, { recursive: true });
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('IMCODES_HOME', dir);
  resetSessionStoreAuthorityForTests();
  configureSessionStoreWriteAuthority(currentDaemonProcessIdentity());
  await loadStore({ probe: false });
});
afterEach(async () => {
  await waitForSessionStoreSnapshotForTests().catch(() => undefined);
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('sessions.json compatibility export budget', () => {
  it('writes the export while it is within budget', async () => {
    upsertSession(record('deck_small_brain'));
    await flushStore();
    await waitForCompatExportForTests();
    expect(existsSync(join(dir, 'sessions.json'))).toBe(true);
  });

  it('skips the export and warns once when it would exceed the budget; the database is unaffected', async () => {
    const warn = vi.spyOn(logger, 'warn');
    upsertSession(record('deck_huge_brain', { transportConfig: { filler: Array.from({ length: 4_000 }, (_, index) => `entry-${index}-xxxxxxxx`) } }));
    await flushStore();
    await waitForCompatExportForTests();
    expect(existsSync(join(dir, 'sessions.json'))).toBe(false);
    expect(warn.mock.calls.filter(([, message]) => String(message).includes('compatibility export skipped: over its size budget'))).toHaveLength(1);
    expect(existsSync(join(dir, 'sessions.sqlite'))).toBe(true);
  });
});
