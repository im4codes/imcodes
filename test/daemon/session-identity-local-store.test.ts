import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getLocalSessionIdentityProfile,
  listLocalSessionIdentityProfiles,
  localSessionIdentityDbPath,
  localSessionIdentityStorePath,
  pruneOrphanedSessionIdentityProfiles,
  putLocalSessionIdentityProfile,
  removeLocalSessionIdentityProfile,
  removeSessionIdentitiesForSession,
  resetIdentityStoreCacheForTests,
} from '../../src/daemon/session-identity-local-store.js';

const home = join(process.cwd(), '.tmp-identity-local-store');

beforeEach(async () => {
  resetIdentityStoreCacheForTests();
  await rm(home, { recursive: true, force: true });
});

afterEach(async () => {
  resetIdentityStoreCacheForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('daemon-local session identity store', () => {
  it('writes content only below the configured scoped home and reopens atomically', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const saved = await putLocalSessionIdentityProfile({
      scope: 'user', scopeKey: '', content: '  local identity  ', source: 'web',
    });
    expect(saved.content).toBe('local identity');
    expect(saved.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(localSessionIdentityStorePath()).toBe(join(home, 'session-identities.json'));
    expect(localSessionIdentityDbPath()).toBe(join(home, 'session-identities.sqlite'));
    expect(existsSync(localSessionIdentityDbPath())).toBe(true);

    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'local identity', revision: 1 });
    expect(JSON.parse(await readFile(localSessionIdentityStorePath(), 'utf8')).profiles['user\0'].content)
      .toBe('local identity');
  });

  it('preserves independent scopes and removes only the requested key', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'user', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo', content: 'project', source: 'mcp' });
    expect((await listLocalSessionIdentityProfiles()).map((profile) => profile.scope)).toEqual(['user', 'project']);
    await expect(removeLocalSessionIdentityProfile('user', '')).resolves.toBe(true);
    expect(await getLocalSessionIdentityProfile('project', 'repo')).toMatchObject({ content: 'project' });
    expect(await getLocalSessionIdentityProfile('user', '')).toBeNull();
  });

  /**
   * Regression for the P0 the auditor found in round 1: every mutator did
   * readStore() -> mutate -> writeStore() on the WHOLE shared file with no
   * serialization. Firing two writes for DIFFERENT keys concurrently (no
   * await between them) used to interleave so the second writeStore() call
   * clobbered the file with a snapshot that never saw the first call's
   * change -- exactly the concurrency this feature exists to serve (an MCP
   * write racing a browser-triggered save, or two agent sessions writing
   * PROJECT vs SESSION scope on the same daemon). Fails on the pre-fix code
   * nondeterministically (one of the two entries goes missing); passes now
   * that every mutation is queued.
   */
  it('never loses a concurrent write for a different scope/scopeKey', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await Promise.all([
      putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-a', content: 'a', source: 'mcp' }),
      putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-b', content: 'b', source: 'mcp' }),
      putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:deck_proj_brain', content: 'c', source: 'mcp' }),
    ]);
    const profiles = await listLocalSessionIdentityProfiles();
    expect(profiles.map((profile) => profile.content).sort()).toEqual(['a', 'b', 'c']);
  });

  it('prunes session-scoped profiles when sessions are not active, preserving user/project/pair', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-a', content: 'project', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'user', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:active_session', content: 'keep-me', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:dead_session', content: 'delete-me', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'dead_no_prefix', content: 'delete-me-too', source: 'mcp' });

    const removed = await pruneOrphanedSessionIdentityProfiles(new Set(['active_session']));
    expect(removed).toBe(2);

    const remaining = await listLocalSessionIdentityProfiles();
    expect(remaining.map((p) => p.content).sort()).toEqual(['keep-me', 'project', 'user']);
  });

  it('immediately purges session-scoped identity profiles when removeSessionIdentitiesForSession is called', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:deck_sub_123', content: 'sub-identity', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'deck_sub_456', content: 'sub-identity-bare', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo', content: 'keep-project', source: 'mcp' });

    expect(await getLocalSessionIdentityProfile('session', 'srv-1:deck_sub_123')).not.toBeNull();
    const deleted = await removeSessionIdentitiesForSession('deck_sub_123');
    expect(deleted).toBe(1);
    expect(await getLocalSessionIdentityProfile('session', 'srv-1:deck_sub_123')).toBeNull();

    const deletedBare = await removeSessionIdentitiesForSession('deck_sub_456');
    expect(deletedBare).toBe(1);
    expect(await getLocalSessionIdentityProfile('session', 'deck_sub_456')).toBeNull();

    expect(await getLocalSessionIdentityProfile('project', 'repo')).toMatchObject({ content: 'keep-project' });
  });

  it('automatically migrates existing legacy session-identities.json into SQLite on first access', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await mkdir(home, { recursive: true });
    const legacy = {
      version: 1,
      profiles: {
        'user\0': { scope: 'user', scopeKey: '', content: 'legacy-user', contentHash: 'h1', revision: 3, updatedAt: 100, source: 'web' },
        'project\0my-repo': { scope: 'project', scopeKey: 'my-repo', content: 'legacy-project', contentHash: 'h2', revision: 2, updatedAt: 200, source: 'mcp' },
      },
      migratedAt: 12345678,
    };
    await writeFile(join(home, 'session-identities.json'), JSON.stringify(legacy));

    // Access store -- should auto-migrate into SQLite
    const profiles = await listLocalSessionIdentityProfiles();
    expect(profiles).toHaveLength(2);
    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'legacy-user', revision: 3 });
    expect(await getLocalSessionIdentityProfile('project', 'my-repo')).toMatchObject({ content: 'legacy-project', revision: 2 });
    expect(existsSync(localSessionIdentityDbPath())).toBe(true);
  });
});
